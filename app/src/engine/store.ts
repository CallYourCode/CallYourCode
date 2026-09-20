import type {EngineAgentRun, EngineSessionSettings} from './contract';
import {agentPollDelay} from './agentPollCadence';
import * as history from './history';
import * as intents from './intents';
import type {HeardPayload, Intent, ProgressPayload, SessionSettingsPayload} from './intents';
import {reportSighting, forgetSighting} from './store/readState';
export {
  reportSighting,
  forgetSighting,
  effectiveMarkerOf,
  applyBroadcastReadThrough
} from './store/readState';
export type {Alongside} from './intents';
import * as drain from './sync/drain';
import type {DrainOutcome} from './sync/drain';
import {postIntent} from './store/intentHttp';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {cyclog} from '@/shared/logging';
import {PAGE_SIZE} from '@shared/pages';
import {effectiveActivity, effectiveMuted, onGlobalSettings} from './settings';

import {
  conns,
  connOf,
  sessions,
  seen,
  lastSettledTabs,
  engineThinking,
  markedUnread,
  sid,
  tid,
  storedTabOrder,
  renderSubs,
  notify,
  notifyNow,
  type Conn
} from './store/registry';
import {wantsLook} from './store/activity';
import {wireSessionOps} from './store/sessionOps';
import {applyStoredSession} from './store/roster';
import {noteRosterSynced} from './store/roster';
import {wirePlugins} from './store/plugins';
import {hydrateSends, isLocalOnly, paintPendingSends, settleSend} from './store/sends';
import {stripInstruction} from './store/admit';
import {noteClip, wireVoiceNotes} from './store/voiceNotes';
import * as rowStore from './store/rows/rowStore';
import {
  extendChatWindow,
  initDoor,
  isUnsettledOwnSend,
  openChatWindow,
  patchMessage
} from './store/rows/door';
import {
  attachFrontier,
  demand as replDemand,
  replicatorFor,
  running as replBackfilling,
  seedCursor,
  stopAllReplicators
} from './store/rows/repl';
import {migrateLegacyHistory, rekeyRowsToOneId} from './store/rows/migrate';
import * as transfers from './transfers/worker';
import * as clipVault from '../audio/clipVault';
import {termWatchers} from './store/terminal';
import {syncReplyDials} from './store/dials';
import {wireConnHandlers, type HandlerCtx} from './store/handlers';
import {armNotifAvatarPrune} from '@/features/media/notifAvatars';
import {onSyncPoke} from './pushNotify';
import * as sync from './sync';
export type {SyncStatus} from './sync';
export {httpBases, reorderTabs, get} from './store/registry';

export {
  globalSettings,
  setGlobalSettings,
  onGlobalSettings,
  refreshGlobalSettings,
  startSettingsSync,
  effectiveSpeed,
  effectiveMuted,
  effectiveNotify,
  effectiveActivity,
  serverHasReplyDials,
  keymapKnown,
  mergedListOrder,
  setMergedListOrder
} from './settings';

import type {CycEngineSession, CycEngineMessage} from './store/types';
export type {CycEngineSession, CycEngineMessage};

export type CycTabInfo = {
  id: string;
  engineKey: string;
  tabKey: string;
  label: string;

  detail: string | null;
  state: 'connecting' | 'connected' | 'disconnected';

  unread: number;

  activity: boolean;
};

let attachedId: string;

const saySubs = new Set<
  (sessionId: string, msgId: string, text: string, origin?: string, growing?: boolean) => void
>();

const sayGrowSubs = new Set<
  (sessionId: string, msgId: string, durS?: number, chars?: number) => void
>();

const sayDoneSubs = new Set<(sessionId: string, msgId: string, durationS?: number) => void>();

const sayLiveSubs = new Set<(sessionId: string, msgId: string) => void>();
const sayLiveFailSubs = new Set<(sessionId: string, msgId: string) => void>();

const idChangeSubs = new Set<(oldId: string, newId: string) => void>();

const replayedSubs = new Set<(sessionId: string) => void>();
function fireReplayed(sessionId: string) {
  for (const fn of replayedSubs) fn(sessionId);
}

function firstPaint(sessionId: string, source: 'cache' | 'replay') {
  const s = sessions.get(sessionId);
  if (!s) return;
  const first = !s.replayed;
  s.replayed = true;
  if (!s.paintSource) s.paintSource = source;
  // A cache, including an empty local window, releases an awaited open. The
  // later engine replay must still notify the surface so it can upgrade that
  // empty landing to its unread anchor.
  if (first || source === 'replay') fireReplayed(sessionId);
}

const REPLAY_SETTLE_MS = 400;

const HISTORY_WAIT_MAX_MS = 12_000;
const replayHold = new Map<string, number>();

function notifyReplaying(id: string) {
  const t = replayHold.get(id);
  if (t !== undefined) clearTimeout(t);
  replayHold.set(
    id,
    window.setTimeout(() => {
      replayHold.delete(id);
      const s = sessions.get(id);

      if (
        s?.awaitingChatStart &&
        s.historyPending &&
        Date.now() - (s.historyAskedAt ?? 0) < HISTORY_WAIT_MAX_MS &&
        sync.engineReachable(s.engineKey)
      ) {
        notifyReplaying(id);
        return;
      }

      if (s) s.historyPending = false;
      notify();
    }, REPLAY_SETTLE_MS)
  );
}

function endReplayHold(id: string) {
  const t = replayHold.get(id);
  if (t === undefined) return;
  clearTimeout(t);
  replayHold.delete(id);
}

function ensureSession(engineKey: string, paneId: string): CycEngineSession {
  const id = sid(engineKey, paneId);
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      engineKey,
      paneId,
      tabKey: '',
      name: paneId,
      cwd: '',
      unread: 0,
      muted: false,
      thinking: false,
      alive: true,
      messages: [],
      claudeSessionId: null,
      events: [],
      agentRuns: []
    };
    sessions.set(id, s);

    paintPendingSends(id);
  }
  return s;
}

// The durable write is the door's job now: every row persists as it is upserted
// (rowStore.upsert/upsertSync), keyed by its durable id. This shim stays only
// for the one caller that still mutates a loaded message in place and wants it
// persisted (a voice note settling); it patches that session's window rows back
// through the door. Engine-written rows already persisted, so it is idempotent.
//
// It NEVER persists a user send the engine has not confirmed. An unsettled
// optimistic send is an s.messages overlay only (it settles into the store via
// adoptEngineRow/settleEcho, keyed by the engine's durable id): it carries no
// mid, and no dedupeKey, and its status is still sending/failed. Persisting one
// here wrote it under the VOLATILE fallback id m@<clientTs>|user|<text>, whose
// client ts (and absent dedupeKey and client-only cid) never bridged the later
// authoritative re-serve that carries the engine mid and a server ts: the two
// rows never merged and the owner saw his own message twice. An engine-confirmed
// row has a durable id (a mid) or the dedupeKey its echo settle stamped; only
// those are patched.
function cacheTail(s: CycEngineSession): void {
  for (const m of s.messages) {
    const em = m as CycEngineMessage;
    if (isUnsettledOwnSend(em)) continue;
    patchMessage(s, em);
  }
}

export {
  onPairNeeded,
  onDowngraded,
  onIdentityChanged,
  pairEngine,
  type PairNeed,
  type IdentityChanged
} from './store/handlers/security';

let unSyncPoke: (() => void) | null = null;

export function start() {
  document.addEventListener('visibilitychange', onSyncVisibility);
  window.addEventListener('pageshow', onSyncPageShow);
  window.addEventListener('online', onSyncOnline);
  window.addEventListener('offline', onSyncOffline);
  unSyncPoke = onSyncPoke(onPushPoke);
  if (document.hidden) sync.setHidden(true);
  else armResync();
  if (navigator.onLine === false) sync.setOnline(false);
  sync.start();
  for (const c of conns) c.client.connect();
}

export function stop() {
  stopAgentPoll();
  stopResync();
  stopAllReplicators();
  unSyncPoke?.();
  unSyncPoke = null;
  document.removeEventListener('visibilitychange', onSyncVisibility);
  window.removeEventListener('pageshow', onSyncPageShow);
  window.removeEventListener('online', onSyncOnline);
  window.removeEventListener('offline', onSyncOffline);
  for (const c of conns) c.client.close();
}

export function subscribe(fn: () => void): () => void {
  renderSubs.add(fn);
  return () => renderSubs.delete(fn);
}

function statusCode(st: CycMessage['status']): number {
  switch (st) {
    case 'sending':
      return 1;
    case 'sent':
      return 2;
    case 'delivered':
      return 3;
    case 'failed':
      return 4;
    default:
      return 0;
  }
}
const EMPTY_EVENTS: CycSessionEvent[] = [];
const EMPTY_RUNS: EngineAgentRun[] = [];
export function contentVersion(s: CycSession): string {
  const es = s as Partial<CycEngineSession>;
  const msgs = s.messages;
  const n = msgs.length;

  let fold = 0;
  for (let i = 0; i < n; i++) {
    const m = msgs[i];
    fold = (Math.imul(fold, 31) + (m.ts | 0)) | 0;
    fold = (Math.imul(fold, 31) + (m.text ? m.text.length : 0)) | 0;
    fold = (Math.imul(fold, 31) + statusCode(m.status) + (m.queued ? 8 : 0)) | 0;

    fold = (Math.imul(fold, 31) + (m.draftCommitted === undefined ? -1 : m.draftCommitted)) | 0;

    fold =
      (Math.imul(fold, 31) +
        ((m as Partial<CycEngineMessage> & {growing?: boolean}).growing ? 7 : 0)) |
      0;
    fold = (Math.imul(fold, 31) + (m.durationS ? m.durationS | 0 : 0)) | 0;
    // in-flight transfer progress: repaint the pending bubble as chunks land
    fold =
      (Math.imul(fold, 31) +
        (typeof (m as Partial<CycMessage>).sendPct === 'number'
          ? Math.round((m as Partial<CycMessage>).sendPct! * 100) + 1
          : 0)) |
      0;
  }
  const last = n ? msgs[n - 1] : null;
  const first = n ? msgs[0] : null;
  const ev = es.events ?? EMPTY_EVENTS;
  const evLast = ev.length ? ev[ev.length - 1] : null;
  const runs = es.agentRuns ?? EMPTY_RUNS;
  let runFold = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    runFold = (Math.imul(runFold, 31) + (r.endedTs ?? 0) + (r.tokens ? r.tokens.length : 0)) | 0;
  }
  return [
    n,
    fold,
    last ? last.ts : 0,
    last ? ((last as Partial<CycEngineMessage>).msgId ?? last.id) : 0,
    first ? first.ts : 0,
    ev.length,
    evLast ? evLast.ts : 0,
    runs.length,
    runFold,
    s.unread | 0,
    s.muted ? 1 : 0,
    s.thinking ? 1 : 0,
    s.status ?? '',
    s.title?.text ?? '',
    s.title?.detail ?? '',
    s.agentLabel ?? '',
    s.agentName ?? '',
    s.name,

    es.model ?? '',

    s.avatarUrl ?? '',
    s.contextPct ?? -1,
    s.turnSince ?? 0,
    s.lastActivity ?? 0,
    s.order ?? -1,
    (s as Partial<CycEngineSession>).alive === false ? 0 : 1,
    es.churnGrey ? 1 : 0,
    s.ask ? s.ask.question : '',
    s.askUnknown ? 1 : 0,
    es.heardTs ?? 0,
    es.historyPending ? 1 : 0,
    es.notOnEngine ? 1 : 0
  ].join('\x1f');
}

export function onReplayed(fn: (sessionId: string) => void): () => void {
  replayedSubs.add(fn);
  return () => replayedSubs.delete(fn);
}

export function onSay(
  fn: (sessionId: string, msgId: string, text: string, origin?: string, growing?: boolean) => void
): () => void {
  saySubs.add(fn);
  return () => saySubs.delete(fn);
}

export function onSayGrow(
  fn: (sessionId: string, msgId: string, durS?: number, chars?: number) => void
): () => void {
  sayGrowSubs.add(fn);
  return () => sayGrowSubs.delete(fn);
}

export function onSayDone(
  fn: (sessionId: string, msgId: string, durationS?: number) => void
): () => void {
  sayDoneSubs.add(fn);
  return () => sayDoneSubs.delete(fn);
}

export function onSayLive(fn: (sessionId: string, msgId: string) => void): () => void {
  sayLiveSubs.add(fn);
  return () => sayLiveSubs.delete(fn);
}

export function onSayLiveFail(fn: (sessionId: string, msgId: string) => void): () => void {
  sayLiveFailSubs.add(fn);
  return () => sayLiveFailSubs.delete(fn);
}

export function onIdChange(fn: (oldId: string, newId: string) => void): () => void {
  idChangeSubs.add(fn);
  return () => idChangeSubs.delete(fn);
}

const TESTHOOKS = !!new URLSearchParams(location.search).get('testhooks');

if (TESTHOOKS) {
  (
    globalThis as unknown as {
      __cycWire: {
        attach(id: string): void;
        heard(id: string, msgId: string): void;
        sendText(id: string, text: string): void;
      };
    }
  ).__cycWire = {
    attach: (id) => {
      const s = sessions.get(sid(conns[0]?.key ?? '', id));
      conns[0]?.client.attach(id, s ? (s.frontier ?? -1) : -1);
    },
    heard: (id, msgId) => {
      conns[0]?.client.heard(id, {msgId});
    },
    sendText: (id, text) => {
      conns[0]?.client.sendText(id, text);
    }
  };
}

export function injectFrame(sessionId: string, frame: Record<string, unknown>): boolean {
  if (!TESTHOOKS) return false;
  const s = sessions.get(sessionId);
  const conn = s && connOf(s.engineKey);
  if (!s || !conn) return false;
  (conn.client as unknown as {handle(f: unknown): void}).handle({...frame, id: s.paneId});
  return true;
}

function declaredTabs(c: Conn, hostCounts: Map<string, number>): CycTabInfo[] {
  const base = {engineKey: c.key, state: c.state, unread: 0, activity: false};

  const held = c.tabs.length
    ? c.tabs
    : c.state !== 'connected'
      ? lastSettledTabs.get(c.key)
      : undefined;
  if (held && held.length) {
    return held.map((t) => ({
      ...base,
      id: tid(c.key, t.key),
      tabKey: t.key,
      label: t.title.text,
      detail: t.title.detail
    }));
  }

  let label = c.hostname;
  if (c.host) {
    label = hostCounts.get(c.host)! > 1 && c.user ? c.user : c.host;
  }
  return [{...base, id: tid(c.key, ''), tabKey: '', label, detail: null}];
}

let strayTabWarned = false;
function tabIdOf(s: CycEngineSession, declared: CycTabInfo[]): string {
  const own = declared.find((t) => t.engineKey === s.engineKey && t.tabKey === s.tabKey);
  if (own) return own.id;
  const first = declared.find((t) => t.engineKey === s.engineKey);
  if (!first) return tid(s.engineKey, s.tabKey);
  if (!strayTabWarned) {
    strayTabWarned = true;
    cyclog('tabs.stray', {
      why:
        'a session named a tab its own engine did not declare, so it is drawn in that ' +
        "engine's first tab rather than nowhere",
      tab: s.tabKey,
      into: first.tabKey
    });
  }
  return first.id;
}

export function tabs(): CycTabInfo[] {
  const hostCounts = new Map<string, number>();
  for (const c of conns) {
    if (c.host) hostCounts.set(c.host, (hostCounts.get(c.host) ?? 0) + 1);
  }
  const declared = conns.flatMap((c) => declaredTabs(c, hostCounts));

  const byId = new Map(declared.map((t) => [t.id, t]));
  for (const s of sessions.values()) {
    const t = byId.get(tabIdOf(s, declared));
    if (!t) continue;
    t.unread += s.unread;
    if (wantsLook(s)) t.activity = true;
  }
  const order = storedTabOrder();
  if (!order.length) return declared;
  const rank = (t: CycTabInfo) => {
    const i = order.indexOf(t.id);
    return i === -1 ? order.length + declared.indexOf(t) : i;
  };
  return [...declared].sort((a, b) => rank(a) - rank(b));
}

export function engineKeyOfTab(tabId: string | null | undefined): string | null {
  if (!tabId) return null;
  return tabs().find((t) => t.id === tabId)?.engineKey ?? null;
}

export function tabForHost(host: string): string | null {
  const c = conns.find((x) => x.host === host);
  return c ? (tabs().find((t) => t.engineKey === c.key)?.id ?? null) : null;
}

export function tabOfSession(sessionId: string): string | null {
  const s = sessions.get(sessionId);
  return s ? tabIdOf(s, tabs()) : null;
}

export function list(tabId?: string): CycEngineSession[] {
  let all = [...sessions.values()];
  if (tabId) {
    const declared = tabs();
    all = all.filter((s) => tabIdOf(s, declared) === tabId);
  }
  return all.sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
  );
}

const HOT_SESSIONS = 3;
const hot: string[] = [];

void history.loadIndex();

// Register the ONE paint path (a store write that touched the open chat's window
// re-projects it) before anything can write a row.
initDoor();

// The one-boot conversion: read every legacy history page once, fold its rows
// into the row store by mid, then drop the pages. Gated behind a flag so a warm
// device never re-reads. The first attach waits on this so it never opens onto a
// store the migration is still filling.
const migrationDone: Promise<unknown> = migrateLegacyHistory({
  readLegacyPages: () => history.readLegacyPages(),
  importRows: (sessionId, rows) => rowStore.importLegacyRows(sessionId, rows),
  dropLegacyPages: () => history.dropLegacyPages()
})
  // Then the one-time durable rekey: a device that already migrated under master
  // keeps its own-send rows keyed the OLD way (`m:<mid>`), which the new build
  // keys `m:c:<cid>`. This rewrites them to the one id BEFORE the first attach
  // re-serves the tail, so the crossing does not twin every delivered own send.
  .then(() => rekeyRowsToOneId({rekeyDurable: () => rowStore.rekeyDurableRowsToOneId()}))
  .catch((e) => {
    cyclog('rowstore.migrate.failed', {err: String(e)});
  });

// Spare a recording an in-flight transfer still needs from the clipVault sweep,
// and from any release() that is not the transfer worker's own.
clipVault.holding(() => transfers.heldKeys(), 'transfer');

// Restore transfer rows BEFORE the intents, so a voice intent's executor can
// see its transfer and never replays an empty wire (Lane A, defect #1).
void transfers.hydrateTransfers().then(() => hydrateSends());

// A cold open: every engine's last roster, with every list-visible field,
// its tabs and the deliberate mark-unread set, painted before any pipe seals.
async function hydrateRosters(): Promise<void> {
  let any = false;
  for (const c of conns) {
    const roster = await history.readRoster(c.key);
    if (!roster) continue;
    if (roster.syncedAt) noteRosterSynced(c.key, roster.syncedAt);
    if (roster.tabs?.length && !lastSettledTabs.has(c.key)) lastSettledTabs.set(c.key, roster.tabs);
    if (roster.hostname && !c.host) c.host = roster.hostname;
    for (const rs of roster.sessions) {
      if (sessions.has(rs.id)) continue;
      const s = ensureSession(c.key, rs.paneId);
      applyStoredSession(s, rs);
      if (!s.name) s.name = rs.paneId;
      any = true;
    }
  }
  if (any) notify();
}
// Only a fully hydrated map may drive the icon-store prune: before this
// resolves, a fast engine's settled frame would see other engines' sessions
// missing and delete rows it should keep (notifAvatars.ts states the rule).
void hydrateRosters().then(() => armNotifAvatarPrune());

// A cold chat drops its warm store mirror and its rendered arrays; the next
// open reloads the newest window from the durable row store. Only the OPEN chat
// is windowed and painted, so a background chat holds nothing in memory but its
// own unsettled pending sends (sends.ts keeps those in s.messages so the list
// row can show "Sending…").
function evictCold(keepId: string) {
  hot.splice(0, hot.length, keepId, ...hot.filter((x) => x !== keepId).slice(0, HOT_SESSIONS - 1));
  for (const s of sessions.values()) {
    if (hot.includes(s.id)) continue;
    rowStore.close(s.id);
    if (s.events.length) s.events = [];
    const pending = s.messages.filter((m) => isLocalOnly(m)) as CycEngineMessage[];
    if (pending.length !== s.messages.length) s.messages = pending;
  }
}

// The one way in: the open chat renders from the local row store alone (offline
// first, cold or warm), one window read and one paint. The replicator then
// backfills the rest in the background; the engine is asked (with the store's
// held tail as the frontier) only when reachable, and the settled edge asks it
// otherwise. Nothing on the wire paints s.messages directly.
export function attach(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  attachedId = sessionId;
  // The store's open session tracks the UI's open chat the INSTANT we attach,
  // before anything network-dependent. On a fresh device whose owner connection
  // is not up yet (or an open that races ahead of it) the chat is visibly open
  // (composer mounted); if the store did not know that, a live row that lands
  // once the wire connects persisted durably and NEVER painted (open=false), so
  // the user watched an open chat silently drop incoming messages. setOpen here,
  // unconditionally, is what keeps the store's open session equal to the UI's.
  rowStore.setOpen(sessionId);
  evictCold(sessionId);
  s.olderFloor = undefined; // a fresh open re-probes the axis from the tail
  /* Opening the chat is coming back to it: drop any deliberate mark-unread
   * intent so the row's badge lifts and the engine's read (reported as he
   * scrolls the tail into view) is honoured from here on. */
  markedUnread.delete(sessionId);
  if (s.unread) {
    s.unread = 0;
    notify();
  }
  const owner = connOf(s.engineKey);
  for (const c of conns) {
    if (c !== owner) c.client.detach();
  }

  s.replayed = false;
  s.paintSource = undefined;
  const openSeq = ++attachSeq;

  // Open the chat onto the store even before (or without) a live connection: one
  // indexed read of the newest window, projected offline-first through
  // door.openChatWindow, so an open that finds rows already stored projects them
  // immediately whether or not an owner is present. Only the wire-facing work
  // (attach, agent poll, askEngine) below is gated on the owner.
  void (async () => {
    // The row store must have finished the one-boot migration before the first
    // open reads it.
    await migrationDone;
    // The local projection is NOT cancellable by the re-attach flood. A fresh
    // device re-attaches many times a second (the catchup flood), each bump
    // raising attachSeq; gating this deferred open on openSeq === attachSeq let
    // that flood supersede it before it ever called openChatWindow, so the
    // window was never opened and the chat rendered EMPTY even as rows arrived
    // (setOpen alone does not project). Opening the chat onto the store is one
    // indexed read, offline-first, no network: it can only ever project rows
    // this device already holds, so a stale open cannot paint anything wrong.
    // Guard it ONLY by "is this still the open chat" (attachedId), never by the
    // attach epoch. The openSeq guard stays on the wire-facing replay below,
    // where a stale network replay must not paint over a newer open.
    if (attachedId !== sessionId) return;
    // Open the chat onto the store: one indexed read of the newest window,
    // projected into s.messages/s.events. The network is not consulted here, so
    // this is offline-first by construction, cold or warm.
    await openChatWindow(sessionId);
    if (attachedId !== sessionId) return;
    const reachable = sync.engineReachable(s.engineKey);
    // The local window is the first placement, even when it is empty. An empty
    // view can safely upgrade to an unread anchor when replay arrives, while a
    // populated local window is held below to avoid a visible bottom-then-jump.
    firstPaint(sessionId, 'cache');
    notify();

    // Prime the session's replicator from its persisted cursor so the
    // background backfill resumes where it left off, then let it run. Still
    // local (a cached cursor read), so it too is guarded only by the open chat.
    const meta = await rowStore.readMeta(sessionId);
    if (attachedId !== sessionId) return;
    if (meta?.syncedAt) sync.noteSynced(sessionId, meta.syncedAt);
    const rep = replicatorFor(sessionId, s.engineKey, s.paneId);
    seedCursor(rep, meta);
    rep.start();

    // The wire-facing replay is the ONE step the flood must still supersede: an
    // older attach's askEngine landing after a newer one would replay a stale
    // tail over the newer open. Keep the openSeq === attachSeq guard here.
    if (!reachable || !owner || openSeq !== attachSeq) return;
    askEngine(s, owner, openSeq);
  })();

  if (!owner) return;
  // Hold only a populated local window. Its rendered rows can plausibly gain an
  // unread anchor from replay, so defer its first placement to avoid a visible
  // bottom-then-jump. An empty view places promptly and may safely upgrade when
  // replay supplies content.
  s.historyPending = sync.engineReachable(s.engineKey) && s.messages.length > 0;
  s.awaitingChatStart = false;
  s.notOnEngine = false;
  owner.client.setSessionTail(s.paneId, overlayOn(sessionId));
  startAgentPoll(sessionId);
}

/* The attach itself, with what the app holds; the replay hold and the wait
 * cap are the engine's answer's, not the store's. The frontier is the highest
 * seq the store holds as a CONTIGUOUS run from the start of the axis, so the
 * engine re-serves whatever the cache cannot prove it holds; the replicator
 * backfills the rest. A cache that is only a sparse suffix (older history not
 * yet pulled) attaches cold, so the engine wins and the truncated cache heals
 * instead of standing as the whole conversation (attachFrontier). */
function askEngine(s: CycEngineSession, owner: Conn, openSeq: number) {
  const sessionId = s.id;
  // Do not hold an empty local view while waiting for replay, or an awaited
  // message jump can time out before the watchdog releases its landing.
  s.historyPending = s.messages.length > 0;
  s.awaitingChatStart = true;
  s.historyAskedAt = Date.now();
  owner.client.attach(s.paneId, attachFrontier(sessionId, rowStore.highestHeldSeq(sessionId)));
  window.setTimeout(() => {
    if (openSeq !== attachSeq || attachedId !== sessionId) return;
    const st = sessions.get(sessionId);
    if (st) {
      st.historyPending = false;
      firstPaint(sessionId, 'replay');
      notify();
    }
  }, HISTORY_WAIT_MAX_MS);
}

let attachSeq = 0;

export function canOlder(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s || s.loadingOlder) return false;
  // more is available if the store holds rows below the loaded floor, or the
  // replicator is still backfilling older pages that will land in the store.
  return rowStore.windowHasMoreBelow(sessionId) || replBackfilling(sessionId);
}

export function loadOlder(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s || s.loadingOlder) return Promise.resolve();
  s.loadingOlder = true;
  cyclog('history.older', {session: sessionId});
  return (async () => {
    try {
      // Extend the window upward from the store alone. When the store runs dry
      // below the floor, hint the replicator to prioritize that range; the hint
      // moves the replicator, never the screen.
      const dry = await extendChatWindow(sessionId);
      if (dry) {
        const floor = rowStore.windowFloorSeq(sessionId);
        if (floor > 0) replDemand(sessionId, floor - 1);
      }
      notify();
    } catch (e) {
      cyclog('history.older.failed', {session: sessionId, err: e});
    } finally {
      const st = sessions.get(sessionId);
      if (st) st.loadingOlder = false;
    }
  })();
}

const heldFast = (s: CycEngineSession, ref: {ts: number; role: 'user' | 'claude'}) =>
  s.messages.some((m) => m.ts === ref.ts && m.role === ref.role);

const ensureHeldFills = new Map<string, Promise<boolean>>();

export function ensureMessageHeld(
  sessionId: string,
  ref: {ts: number; role: 'user' | 'claude'; seq?: number}
): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s) return Promise.resolve(false);

  if (heldFast(s, ref)) return Promise.resolve(true);

  const inFlight = ensureHeldFills.get(sessionId);
  if (inFlight) {
    return inFlight.then(() => {
      const st = sessions.get(sessionId);
      return !!st && heldFast(st, ref);
    });
  }

  const run = (async (): Promise<boolean> => {
    try {
      // Jump-to-message: pull the window down from the store until the target
      // row is loaded. When the store runs dry below the floor, hint the
      // replicator to prioritize the target's range and give the background
      // fill a beat to land it, bounded so an absent row cannot spin forever.
      for (let i = 0; i < 64; i++) {
        const st = sessions.get(sessionId);
        if (!st || heldFast(st, ref)) break;
        const dry = await extendChatWindow(sessionId);
        if (!dry) continue;
        if (ref.seq !== undefined && ref.seq >= 0) replDemand(sessionId, ref.seq);
        if (!sync.engineReachable(s.engineKey)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } catch (e) {
      cyclog('jump.ensureHeld.failed', {session: sessionId, seq: ref.seq, err: e});
      return false;
    }
    const st = sessions.get(sessionId);
    if (st) notify();

    return !!st && heldFast(st, ref);
  })();

  ensureHeldFills.set(sessionId, run);
  return run.finally(() => {
    if (ensureHeldFills.get(sessionId) === run) ensureHeldFills.delete(sessionId);
  });
}

export function detachChat() {
  attachedId = undefined;
  // Closing the chat closes the store's open session too, so the open-session
  // pointer never lags the UI: a background write to a now-closed chat must not
  // paint (it has no visible window), the mirror image of the open above.
  rowStore.setOpen(null);
  stopAgentPoll();
  for (const c of conns) c.client.detach();
}

/* Test seam: mark a session as the attached one (and bump the attach epoch)
 * without running attach()'s cache seed / askEngine / agent-poll machinery, so
 * a unit test can exercise the frontier walk's staleness guard directly. */
export function __setAttachedForTest(id: string | undefined): void {
  attachedId = id;
  attachSeq++;
}

for (let i = localStorage.length - 1; i >= 0; i--) {
  const k = localStorage.key(i);
  if (k && k.startsWith('cyc-session-overlay:')) localStorage.removeItem(k);
}
const seenEvents = new Map<string, Set<string>>();

type PerSessionMaps = {
  seen: Map<string, unknown>;
  seenEvents: Map<string, unknown>;
  engineThinking: Set<string>;
};
function reclaimDeadSession(id: string, maps: PerSessionMaps): boolean {
  maps.seenEvents.delete(id);
  maps.engineThinking.delete(id);
  return maps.seen.delete(id);
}

const perSessionMaps: PerSessionMaps = {seen, seenEvents, engineThinking};

export function overlayEnabled(): boolean {
  return effectiveActivity();
}

export function setOverlayEnabled(on: boolean): Promise<boolean> {
  try {
    localStorage.setItem('cyc-session-activity', on ? '1' : '0');
  } catch {}
  applyActivityTail();
  notify();
  return Promise.resolve(true);
}

function applyActivityTail() {
  const s = attachedId ? sessions.get(attachedId) : undefined;
  const owner = s && connOf(s.engineKey);
  if (s && owner && s.claudeSessionId) {
    owner.client.setSessionTail(s.paneId, overlayOn(s.id));
  }
}

onGlobalSettings(() => {
  for (const s of sessions.values()) s.muted = effectiveMuted(s);
  applyActivityTail();
  notify();
});

export function overlayOn(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  return effectiveActivity() && !!s?.claudeSessionId;
}

export {activityMark} from './store/activity';

export {
  transcribe,
  openSttStream,
  hasVoiceMedia,
  openMediaSttStream,
  uploadFile
} from './store/audioDocs';
export {
  uploadUrl,
  audioUrl,
  docUrl,
  notifyKey,
  sessionFromNotifyKey,
  setVisible
} from './store/urls';
export {
  reorderSessions,
  renameSession,
  setSessionUnread,
  exitSession,
  restartSession,
  newSessionPlaces,
  recentlyClosed,
  startSession,
  setSessionPhoto,
  type NewSessionPlaces,
  type RecentlyClosed,
  type StartedSession
} from './store/sessionOps';
export {
  pluginsOf,
  toolbarPluginIds,
  sessionScopedToolbarPluginIds,
  declaredToolbarDefaults,
  cardEngines,
  pluginCardOf,
  findPanelPlugin,
  pluginPanelHtml,
  pluginPanelHtmlCached,
  pluginRpc,
  pluginStateLoad,
  pluginStateSave
} from './store/plugins';
export {
  retrySend,
  sendText,
  sendCommitted,
  sendTaken,
  sendSettles,
  withdrawSend,
  engineCan,
  voiceEngineHealthy
} from './store/sends';
export {
  sendVoiceClip,
  retryVoiceClip,
  cancelVoiceUpload,
  type VoiceClipOpts
} from './store/voiceUpload';
export {
  sendAttachments,
  cancelAttachmentSend,
  wordsMarker,
  type AttachFile,
  type AttachSendOpts
} from './store/attachSend';
export {
  beginVoiceNote,
  updateVoiceNote,
  commitVoiceNote,
  markVoiceNoteSafe,
  failVoiceNote,
  discardVoiceNote
} from './store/voiceNotes';
export {
  watchTerminal,
  resizeTerminal,
  sendTerminalInput,
  scrollTerminal,
  TERMINAL_PANE_OVERRIDE,
  type TerminalWatcher
} from './store/terminal';
export {setReplyStrings, setReplyDial, pushReplyDials, syncReplyDials} from './store/dials';

function rekeySession(engineKey: string, from: string, to: string): string | null {
  const oldId = sid(engineKey, from);
  const newId = sid(engineKey, to);
  if (oldId === newId) return null;
  const s = sessions.get(oldId);
  if (!s) return null;

  sessions.delete(oldId);
  s.id = newId;
  s.paneId = to;
  sessions.set(newId, s);
  const move = <V>(m: Map<string, V>) => {
    if (m.has(oldId)) {
      m.set(newId, m.get(oldId)!);
      m.delete(oldId);
    }
  };
  move(seen);
  move(replayHold);
  move(seenEvents);
  move(termWatchers);
  if (engineThinking.has(oldId)) {
    engineThinking.delete(oldId);
    engineThinking.add(newId);
  }
  if (attachedId === oldId) attachedId = newId;
  for (const fn of idChangeSubs) {
    try {
      fn(oldId, newId);
    } catch {}
  }
  notify();
  return newId;
}

// Agent runs are pull-only today: nothing on the wire pushes them, so the open
// chat has to ask. Until the engine pushes them (engine follow-up), this is a
// poll -- but one whose cadence follows the attached session's busy state
// (agentPollDelay): quick (15 s) while it is thinking so the agents bar tracks
// the sub-agent runs it spawns right when they matter, slow (5 min) while it is
// idle so an untouched phone stays cool. It is gated to the foreground and
// paused entirely while hidden, with a fresh read the instant the tab comes
// back and an immediate read on each thinking edge (idle->thinking and
// thinking->idle). A user who wants it now taps the chat, which re-attaches.
let agentPollTimer = 0;
let agentPollId: string | undefined;
// The attached session's last-seen thinking bit, so the notify subscriber can
// tell a real thinking edge from any other repaint.
let agentPollThinking = false;
let agentPollUnsub: (() => void) | undefined;

async function refreshAgents(sessionId: string) {
  const s = sessions.get(sessionId);
  const owner = s && connOf(s.engineKey);
  if (!s || !owner) return;
  try {
    const runs = (await owner.client.fetchSessionAgents(s.paneId)) ?? [];
    if (JSON.stringify(runs) !== JSON.stringify(s.agentRuns)) {
      s.agentRuns = runs;
      notify();
    }
  } catch {}
}

function agentPollAttachedThinking(): boolean {
  const s = agentPollId ? sessions.get(agentPollId) : undefined;
  return !!s?.thinking;
}

function armAgentInterval() {
  if (agentPollTimer) clearInterval(agentPollTimer);
  agentPollTimer = 0;
  if (document.hidden || !agentPollId) return;
  agentPollTimer = window.setInterval(() => {
    if (agentPollId && !document.hidden) void refreshAgents(agentPollId);
  }, agentPollDelay(agentPollThinking));
}

// Observed on every store notify: the attached session's thinking bit funnels
// through here, so a flip either way is a thinking edge. On an edge we read once
// at once (foreground only) and re-arm at the new cadence.
function onAgentPollThinkingEdge() {
  const now = agentPollAttachedThinking();
  if (now === agentPollThinking) return;
  agentPollThinking = now;
  if (agentPollId && !document.hidden) void refreshAgents(agentPollId);
  armAgentInterval();
}

function startAgentPoll(sessionId: string) {
  stopAgentPoll();
  agentPollId = sessionId;
  agentPollThinking = agentPollAttachedThinking();
  if (!document.hidden) void refreshAgents(sessionId);
  armAgentInterval();
  agentPollUnsub = subscribe(onAgentPollThinkingEdge);
  document.addEventListener('visibilitychange', onAgentPollVisible);
}

function onAgentPollVisible() {
  if (document.hidden) {
    if (agentPollTimer) clearInterval(agentPollTimer);
    agentPollTimer = 0;
    return;
  }
  // Back in the foreground: re-sync the thinking bit (it may have flipped while
  // hidden), a fresh read now, then the busy-aware cadence resumes.
  agentPollThinking = agentPollAttachedThinking();
  if (agentPollId) void refreshAgents(agentPollId);
  armAgentInterval();
}

function stopAgentPoll() {
  if (agentPollTimer) clearInterval(agentPollTimer);
  agentPollTimer = 0;
  agentPollId = undefined;
  agentPollThinking = false;
  agentPollUnsub?.();
  agentPollUnsub = undefined;
  document.removeEventListener('visibilitychange', onAgentPollVisible);
}

function releaseQueued(s: CycEngineSession, m: CycEngineMessage): boolean {
  if (!m.queued) return false;
  delete m.queued;
  if (m.status === 'failed') m.status = 'sent';
  settleSend(m.cid);
  patchMessage(s, m);
  return true;
}

function releaseQueuedBefore(s: CycEngineSession, replyTs: number): boolean {
  let changed = false;
  for (const m of s.messages) {
    if (m.role === 'user' && m.ts < replyTs) {
      changed = releaseQueued(s, m as CycEngineMessage) || changed;
    }
  }
  return changed;
}

export function interrupt(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.thinking && !engineThinking.has(sessionId)) {
    s.thinking = false;
    notifyNow();
  }
  connOf(s.engineKey)?.client.interrupt(s.paneId);
}

export async function stopAgent(
  sessionId: string,
  agentId: string
): Promise<{ok: boolean; error?: string}> {
  const s = sessions.get(sessionId);
  const owner = s && connOf(s.engineKey);
  if (!s || !owner) return {ok: false, error: 'not connected'};
  const r = await owner.client.stopSessionAgent(s.paneId, agentId);
  void refreshAgents(sessionId);
  return r;
}

export function compact(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  connOf(s.engineKey)?.client.compact(s.paneId);
}

export function answerAsk(sessionId: string, fingerprint: string, choice: number): boolean {
  const s = sessions.get(sessionId);
  if (!s || !s.alive) return false;
  const conn = connOf(s.engineKey);
  if (!conn) return false;
  conn.client.answer(s.paneId, fingerprint, choice);
  return true;
}

const answerListeners = new Set<
  (sessionId: string, ok: boolean, reason?: string, detail?: string) => void
>();
export function onAnswerResult(
  fn: (sessionId: string, ok: boolean, reason?: string, detail?: string) => void
): () => void {
  answerListeners.add(fn);
  return () => answerListeners.delete(fn);
}

const compactListeners = new Set<(sessionId: string, ok: boolean, tell: string) => void>();
export function onCompactResult(
  fn: (sessionId: string, ok: boolean, tell: string) => void
): () => void {
  compactListeners.add(fn);
  return () => compactListeners.delete(fn);
}

export function isMuted(sessionId: string): boolean {
  return !!sessions.get(sessionId)?.muted;
}

type SessionSettingsPatch = Partial<Record<'muted' | 'notify' | 'activity', boolean | null>>;

function patched(base: EngineSessionSettings, patch: SessionSettingsPatch): EngineSessionSettings {
  const next = {...base};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k as keyof EngineSessionSettings];
    else (next as Record<string, unknown>)[k] = v;
  }
  return next;
}

function showSessionSettings(
  s: CycEngineSession,
  v: EngineSessionSettings | undefined,
  patch: SessionSettingsPatch
) {
  s.settings = v;
  s.muted = effectiveMuted(s);
  if ('activity' in patch && s.id === attachedId && s.claudeSessionId) {
    connOf(s.engineKey)?.client.setSessionTail(s.paneId, overlayOn(s.id));
  }
  notify();
}

// A settings patch is an intent: shown at once, merged with any patch still
// queued for the same session, taken to the engine by the drain in order. A
// definitive refusal restores the last settings the engine confirmed.
export function setSessionSettings(
  sessionId: string,
  patch: SessionSettingsPatch
): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s) return Promise.resolve(false);
  if (s.settings) showSessionSettings(s, patched(s.settings, patch), patch);
  const row = intents.put({
    id: 'sset:' + sessionId + ':' + (crypto.randomUUID?.() ?? Date.now().toString(36)),
    engineKey: s.engineKey,
    sessionId,
    kind: 'session-settings',
    coalesceKey: 'sset:' + sessionId,
    payload: {paneId: s.paneId, patch} satisfies SessionSettingsPayload
  });
  drain.kick(s.engineKey);
  return drain.whenSettled(row.id);
}

drain.registerExecutor('session-settings', async (intent: Intent): Promise<DrainOutcome> => {
  const p = intent.payload as SessionSettingsPayload;
  const res = await postIntent(
    intent.engineKey,
    '/session/' + encodeURIComponent(p.paneId) + '/settings',
    p.patch
  );
  if (res.ok === true) return 'done';
  if (res.outcome !== 'transient') {
    const s = sessions.get(intent.engineKey + '|' + p.paneId);
    if (s) showSessionSettings(s, s.confirmedSettings, p.patch as SessionSettingsPatch);
  }
  return res.outcome;
});

if (conns.length) syncReplyDials();

wireSessionOps({list: () => list()});
wireVoiceNotes({cacheTail});

const handlerCtx: HandlerCtx = {
  ensureSession: (engineKey, paneId) => ensureSession(engineKey, paneId),
  stripInstruction: (text) => stripInstruction(text),
  releaseQueued: (s2, m) => releaseQueued(s2, m),
  releaseQueuedBefore: (s2, replyTs) => releaseQueuedBefore(s2, replyTs),
  endReplayHold: (id) => endReplayHold(id),
  firstPaint: (id, source) => firstPaint(id, source),
  overlayOn: (sessionId) => overlayOn(sessionId),
  rekeySession: (engineKey, from, to) => rekeySession(engineKey, from, to),
  reclaimDead: (sessionId) => reclaimDeadSession(sessionId, perSessionMaps),
  attachedId: () => attachedId,
  fireCompactResult: (sessionId, ok, tell) => {
    for (const fn of compactListeners) {
      try {
        fn(sessionId, ok, tell);
      } catch {}
    }
  },
  fireAnswerResult: (sessionId, ok, reason, detail) => {
    for (const fn of answerListeners) {
      try {
        fn(sessionId, ok, reason, detail);
      } catch {}
    }
  },
  fireSay: (sessionId, msgId, text, origin, growing) => {
    for (const fn of saySubs) fn(sessionId, msgId, text, origin, growing);
  },
  fireSayGrow: (sessionId, msgId, durS, chars) => {
    for (const fn of sayGrowSubs) fn(sessionId, msgId, durS, chars);
  },
  fireSayDone: (sessionId, msgId, durationS) => {
    for (const fn of sayDoneSubs) fn(sessionId, msgId, durationS);
  },
  fireSayLive: (sessionId, msgId) => {
    for (const fn of sayLiveSubs) fn(sessionId, msgId);
  },
  fireSayLiveFail: (sessionId, msgId) => {
    for (const fn of sayLiveFailSubs) fn(sessionId, msgId);
  }
};
for (const conn of conns) wireConnHandlers(conn, handlerCtx);
wirePlugins({liveEngineKeys: () => new Set(tabs().map((t) => t.engineKey))});

// The connected-edge order, after step 1 (sessions frame
// applied, roster persisted) which fires this: (2) re-attach the active chat,
// then (4) onConnected fires from the manager, concurrently with (5) refresh
// events for the open chat if the overlay is on and (6) refreshGlobalSettings.
sync.setSettledEdge((engineKey) => {
  const s = attachedId ? sessions.get(attachedId) : undefined;
  const owner = connOf(engineKey);
  if (s && owner && s.engineKey === engineKey) askEngine(s, owner, attachSeq);
  syncReplyDials(engineKey);
});

// The UI's connectivity vocabulary: one word, its edge, and per-engine reach.
export const syncStatus = sync.status;
export const onSyncStatus = sync.onStatus;
export const engineReachable = sync.engineReachable;
export function sessionSyncedAt(sessionId: string): number | undefined {
  return sync.syncedAt(sessionId);
}
export const intentState = intents.intentState;

/* THE CATCH-UP (bg-refresh): the sealed channel delivers instantly while the
 * pipe is healthy; this covers the two ways the screen can go stale anyway.
 * Coming back to the foreground the pipe may be silently dead (a half-open
 * socket after a pocket nap), and while the app sits open a delta can slip
 * by unnoticed. One move covers both: re-attach the open chat with the
 * current frontier. A caught-up frontier comes back as ONE metadata-only
 * attach-ok, no pages, and the attach frame arms the client's inbound
 * deadline, so a pipe that answers nothing is presumed dead within its grace
 * and redialed by the manager. Runs only for the ACTIVE session, only in the
 * foreground, and only while the engine is reachable; an unreachable engine
 * is the poke's to dial, and the settled edge re-attaches with the same
 * frontier on its own. */
export const BG_RESYNC_MS = 75_000;
let resyncTimer = 0;

function catchUpOpenChat(why: 'visible' | 'resume' | 'tick' | 'push') {
  if (document.hidden) return;
  const s = attachedId ? sessions.get(attachedId) : undefined;
  if (!s) return;
  const owner = connOf(s.engineKey);
  if (!owner || !sync.engineReachable(s.engineKey)) return;
  cyclog('sync.catchup', {session: s.id, why});
  askEngine(s, owner, attachSeq);
}

// The safety net while the app sits open: modest, foreground-only, and paused
// entirely while hidden (the same battery discipline as the agents poll).
function armResync() {
  if (resyncTimer) clearInterval(resyncTimer);
  resyncTimer = window.setInterval(() => catchUpOpenChat('tick'), BG_RESYNC_MS);
}

function stopResync() {
  if (resyncTimer) clearInterval(resyncTimer);
  resyncTimer = 0;
}

/* The worker's push-poke: a sealed push landed while the app is OPEN (the
 * worker matched a window client, cyc-sw.js cycPokeClients). The push proves
 * the engine spoke, yet the page's pipe may be silently dead, so the poke says
 * only "sync now" (never content; at most the sessionId the push envelope
 * already carried in the clear). The discipline mirrors the rest of the
 * catch-up machinery:
 *   - hidden: no-op. The visible edge owes a full foregroundReturn anyway, so
 *     the deferral is inherent, and a hidden page attaches nothing.
 *   - visible: every pipe is challenged (verifyPipe: idempotent, a no-op
 *     unsealed, never re-arms an armed deadline), then ONE catch-up of the
 *     open chat: a frontier attach (empty pages when already caught up).
 *   - a poke naming some OTHER chat than the open one stops at the pipe
 *     challenge: a burst of pushes across many sessions must not churn
 *     re-attaches of the one open chat. That chat's own rows land by the
 *     ordinary roster/attach paths once the pipe is verified or redialed. */
function onPushPoke(sessionId: string) {
  if (document.hidden) return;
  for (const c of conns) c.client.verifyPipe();
  if (sessionId && attachedId && sessionId !== attachedId) return;
  catchUpOpenChat('push');
}

// Back in the foreground (a visibility flip, or a PWA restored from the
// back-forward cache): dial whatever is down, verify every pipe that only
// LOOKS alive, and catch the open chat up.
function foregroundReturn(why: 'visible' | 'resume') {
  sync.poke('visible');
  for (const c of conns) c.client.verifyPipe();
  catchUpOpenChat(why);
  armResync();
}

// Visibility and radio facts go to the manager as calls; the manager itself
// never reads the document.
function onSyncVisibility() {
  if (document.hidden) {
    stopResync();
    sync.setHidden(true);
    return;
  }
  sync.setHidden(false);
  foregroundReturn('visible');
}

function onSyncPageShow(e: PageTransitionEvent) {
  if (!e.persisted || document.hidden) return;
  foregroundReturn('resume');
}
function onSyncOnline() {
  sync.setOnline(true);
  sync.poke('online');
}
function onSyncOffline() {
  sync.setOnline(false);
}

// A clip played through to the end is a SIGHTING of its row: report it by the
// row's durable identity (mid), the audio id (msgId) as the older shape, and
// its instant. The engine is the authority; this never moves a local marker.
export function markHeard(sessionId: string, msgId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const at = s.messages.find((m) => (m as CycEngineMessage).msgId === msgId) as
    CycEngineMessage | undefined;
  if (!at) return;
  reportSighting(sessionId, {mid: at.mid, msgId, ts: at.ts});
}

// The 'heard' sighting executor is registered in store/readState.ts, beside
// reportSighting, so it loads wherever a sighting can be queued.

drain.registerExecutor('progress', (intent: Intent): DrainOutcome => {
  const p = intent.payload as ProgressPayload;
  const owner = connOf(intent.engineKey);
  if (!owner) return 'transient';
  return owner.client.progress(p.paneId, p.seq, p.explicit) ? 'done' : 'transient';
});
