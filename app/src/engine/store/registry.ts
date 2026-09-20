import type {EnginePluginDecl, EngineTab} from '../contract';
import {engineUrls, httpBaseOf} from '../contract';
import {WsEngineClient} from '../client';
import type {CycEngineMessage, CycEngineSession} from './types';
import {cyclog} from '@/shared/logging';
import {capDedupe} from '../dedupeCap';
import {cachedHostName, hostnameOf} from '../hostNames';
import * as sync from '../sync';

export type Conn = {
  key: string;
  client: WsEngineClient;
  state: 'connecting' | 'connected' | 'disconnected';
  user: string | null;
  host: string | null;
  hostname: string;

  tabs: EngineTab[];

  plugins: EnginePluginDecl[];

  voiceHealthy: boolean;

  helloSettled: boolean;
};

export const conns: Conn[] = engineUrls().map((url) => {
  const seed = cachedHostName(url);
  // The manager times every redial; the client asks it and gets called back.
  const client = new WsEngineClient(url, {schedule: () => sync.schedule(url)});
  sync.register(url, client);
  const conn: Conn = {
    key: url,
    client,
    state: 'disconnected',
    user: seed?.user ?? null,
    host: seed?.host ?? null,
    hostname: hostnameOf(url),
    tabs: [],
    plugins: [],
    voiceHealthy: true,
    helloSettled: false
  };
  return conn;
});

export const connOf = (engineKey: string): Conn | undefined =>
  conns.find((c) => c.key === engineKey);

export function httpBases(): string[] {
  return conns.map((c) => httpBaseOf(c.key));
}

const TAB_ORDER_KEY = 'cyc-seg-order';
export function storedTabOrder(): string[] {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY);
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export const tid = (engineKey: string, tabKey: string) => engineKey + '#' + tabKey;

export function reorderTabs(ids: string[]): void {
  localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(ids));
}

export const sid = (engineKey: string, paneId: string) => engineKey + '|' + paneId;

export const sessions = new Map<string, CycEngineSession>();

export function get(id: string): CycEngineSession | undefined {
  return sessions.get(id);
}
export const seen = new Map<string, Set<string>>();

export const lastSettledTabs = new Map<string, EngineTab[]>();

export function ownerOf(sessionId: string | undefined): Conn {
  const s = sessionId ? sessions.get(sessionId) : undefined;
  return (s && connOf(s.engineKey)) ?? conns[0];
}

export const paneIdOf = (session: string | null): string | null =>
  session ? (sessions.get(session)?.paneId ?? null) : null;

const SEEN_KEYS_MAX = 50000;
const SEEN_KEYS_TRIM_TO = 45000;
export function capSeen(sessionId: string, keys: Set<string>) {
  const dropped = capDedupe(keys, SEEN_KEYS_MAX, SEEN_KEYS_TRIM_TO);
  if (dropped)
    cyclog('store.seen.capped', {session: sessionId, cap: SEEN_KEYS_MAX, kept: keys.size, dropped});
}

export const engineThinking = new Set<string>();

/* DELIBERATELY MARKED UNREAD: the app-side intent that a chat is
 * unread even while it is the open/attached one. The engine owns the marker
 * (heardTs) and is the truth across devices and reloads; this set is only the
 * live signal that lets the attached row keep the badge the engine just gave
 * it, instead of the sessions frame zeroing it (handlers/sessions.ts) the way
 * it must for incidental live activity in a chat you are reading. Cleared when
 * the chat is opened (store.attach) or marked read. Never persisted: on reload
 * nothing is attached, so the engine's count stands on its own. */
export const markedUnread = new Set<string>();

// A message's identity is its durable string row id (engine/store/rows/core
// rowIdOfMessage), computed from the row's own durable facts (cid, else mid,
// else ts|role|text) and unique by construction. There is no per-load render-id
// counter to mint or re-seed, so the cross-load collision that twinned two
// bubbles under one number (the Reply/Copy-quotes-a-different-bubble defect)
// cannot exist: restored rows keep the id their content derives and a freshly
// admitted row derives the same id from the same content, never a colliding one.

export function findLocal(sessionId: string, localId: string): CycEngineMessage | undefined {
  return sessions.get(sessionId)?.messages.find((m) => m.id === localId) as
    CycEngineMessage | undefined;
}

export const renderSubs = new Set<() => void>();

let notifyScheduled = false;
let notifyRaf = 0;
let notifyTimer = 0;

function flushNotify() {
  if (!notifyScheduled) return;
  notifyScheduled = false;
  if (notifyRaf) {
    cancelAnimationFrame(notifyRaf);
    notifyRaf = 0;
  }
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = 0;
  }
  for (const fn of renderSubs) fn();
}

export function notify() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  notifyRaf = requestAnimationFrame(flushNotify);
  notifyTimer = window.setTimeout(flushNotify, 200);
}

export function notifyNow() {
  notifyScheduled = true;
  flushNotify();
}
