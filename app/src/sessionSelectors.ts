import type {CycSession} from './types';
import * as engine from './engine/store';
import type {CycEngineSession} from './engine/store';
import {mergeTabs, sortByLatest} from '@/features/settings/preferences';
import {hostnameOf} from './engine/hostNames';
import {sessionState, dataState} from './sessionState';

export const visibleTabs = () =>
  dataState.mode === 'live' ? engine.tabs() : dataState.mode === 'test' ? dataState.testTabs : [];

export const activeEngineKey = (): string | null => {
  if (dataState.mode === 'test') {
    return (
      dataState.testTabs.find((t) => t.id === sessionState.activeTabId)?.engineKey ??
      dataState.testTabs[0]?.engineKey ??
      null
    );
  }
  return engine.engineKeyOfTab(sessionState.activeTabId);
};

export const toolbarEngineOf = (
  sessionId: string
): {engineKey: string | null; plugins: ReadonlySet<string>} => {
  const es = dataState.mode === 'live' ? engine.get(sessionId) : undefined;
  const engineKey = es?.engineKey ?? null;
  return {engineKey, plugins: engineKey ? engine.toolbarPluginIds(engineKey) : new Set<string>()};
};

export const cardScope = (): string[] =>
  mergeTabs()
    ? [...new Set(engine.tabs().map((t) => t.engineKey))]
    : [activeEngineKey()].filter((k): k is string => !!k);

export const PLUGIN_USAGE_ID = 'usage-card';
export const isPluginCardEngine = (key: string): boolean =>
  engine.pluginsOf(key).some((p) => p.id === PLUGIN_USAGE_ID && !!p.card);

export const selectTabFor = (sessionId: string) => {
  const tabId = engine.tabOfSession(sessionId);
  if (tabId) sessionState.activeTabId = tabId;
  return tabId;
};

export const orderByLatest = (base: CycSession[]): CycSession[] => {
  if (!sortByLatest()) return base;
  return base
    .map((s, i) => [s, i] as const)
    .sort((a, b) => (b[0].lastActivity ?? 0) - (a[0].lastActivity ?? 0) || a[1] - b[1])
    .map(([s]) => s);
};

export const applyMergedOrder = (base: CycSession[]): CycSession[] => {
  const stored = engine.mergedListOrder();
  if (!stored.length) return base;
  const present = new Set(base.map((s) => s.id));
  const backbone = stored.filter((id) => present.has(id));
  const placed = new Set(backbone);
  const byId = new Map(base.map((s) => [s.id, s] as const));
  const result: CycSession[] = backbone.map((id) => byId.get(id)!);
  let anchor: string | null = null;
  for (const s of base) {
    if (placed.has(s.id)) {
      anchor = s.id;
      continue;
    }
    const at = anchor === null ? 0 : result.findIndex((r) => r.id === anchor) + 1;
    result.splice(at, 0, s);
    placed.add(s.id);
    anchor = s.id;
  }
  return result;
};

export const sortedLive = (): CycSession[] => {
  if (dataState.mode === 'test') {
    const key = activeEngineKey();
    const all = dataState.demoSessions;
    const base = key ? all.filter((s) => (s as CycEngineSession).engineKey === key) : all;
    return orderByLatest(base);
  }
  if (dataState.mode !== 'live') return orderByLatest(dataState.demoSessions);
  const merged = mergeTabs();
  const base = engine.list(merged ? undefined : (sessionState.activeTabId ?? undefined));

  if (sortByLatest()) return orderByLatest(base);
  return merged ? applyMergedOrder(base) : base;
};

export const tabLabelOf = (sessionId: string): string | null => {
  if (dataState.mode === 'test') {
    const key = (
      dataState.demoSessions.find((s) => s.id === sessionId) as CycEngineSession | undefined
    )?.engineKey;
    return dataState.testTabs.find((t) => t.engineKey === key)?.label ?? null;
  }
  if (dataState.mode !== 'live') return null;
  const tabId = engine.tabOfSession(sessionId);
  if (!tabId) return null;
  return engine.tabs().find((t) => t.id === tabId)?.label ?? null;
};

export const allSessions = (): CycSession[] =>
  dataState.mode === 'live' ? engine.list() : dataState.demoSessions;

export const active = (): CycSession | null => {
  if (!sessionState.activeId) return null;
  if (dataState.mode === 'live') return engine.get(sessionState.activeId) ?? null;
  return dataState.demoSessions.find((s) => s.id === sessionState.activeId) ?? null;
};

export const isDead = (s: CycSession | null) => !!s && (s as CycEngineSession).alive === false;

// Every row the engine last listed stays on screen whatever the pipe is doing
// (offline design v2, section 5): a cache-painted row is superseded in place
// by the next `sessions` frame, never hidden ahead of it.
export const projectMembership = (base: CycSession[]): CycSession[] =>
  base.filter(
    (s) => !isDead(s) || s.id === sessionState.activeId || (s as CycEngineSession).churnGrey
  );

/* The ARCHIVE projection (dead-session archive, WhatsApp-like ended threads):
 * every dead row, nothing else. A session in its death grace (churnGrey) is
 * dead too, so it can appear in both lenses for the few grace seconds; the
 * grace exists so the LIVE list does not yank a just-died row, not to hide it
 * from the archive. Nothing is ever deleted here: the engine keeps listing a
 * dead session with a conversation, its chat stays fetchable, and a restart
 * flips it back to alive (out of this projection, back into membership). */
export const projectArchive = (base: CycSession[]): CycSession[] => base.filter((s) => isDead(s));

/* The one row projector both the renderer and the list surface version key on:
 * the archive lens picks which membership the list paints. Renderer and
 * version MUST share this (the churnGrey-zombie lesson), or a row can be
 * painted but invisible to the repaint key. */
export const projectRows = (base: CycSession[]): CycSession[] =>
  sessionState.archiveOpen ? projectArchive(base) : projectMembership(base);

export const hostChipLabel = (engineKey: string): string =>
  visibleTabs().find((t) => t.engineKey === engineKey)?.label || hostnameOf(engineKey);
