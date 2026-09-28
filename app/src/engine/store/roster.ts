import * as history from '../history';
import type {StoredSession} from '../history';
import {connOf, lastSettledTabs, markedUnread, sessions} from './registry';
import type {CycEngineSession} from './types';

/* EVERY list-visible field of a session: what the list row, the host chip and
 * the badge read. The roster row persists exactly these, and a cold open
 * copies exactly these back, so the list paints as it was. One list, both
 * directions; cycRosterFields.test.ts diff-checks it against the list-visible
 * keys of CycEngineSession. */
export const ROSTER_FIELDS = [
  'id',
  'paneId',
  'tabKey',
  'name',
  'cwd',
  'unread',
  'order',
  'alive',
  'lastActivity',
  'heardTs',
  'title',
  'avatarUrl',
  'status',
  'thinking',
  'contextPct',
  'subagentsRunning',
  'agentName',
  'agentId',
  'sessionAgentId',
  'agentLabel',
  'model',
  'turnSince',
  'replyLevel',
  'claudeSessionId',
  'settings',
  'muted',
  'ask',
  'askUnknown'
] as const satisfies readonly (keyof CycEngineSession)[];

export type RosterField = (typeof ROSTER_FIELDS)[number];

// When the engine last served each roster (its sessions frame), kept across
// local re-persists (a rename, a mark-unread) so the row's syncedAt stays true.
const rosterSyncedAt = new Map<string, number>();

// The last-persisted content of each engine's roster: a fingerprint over EXACTLY
// the persisted fields (every toStoredSession row + tabs + hostname), so a
// sessions frame that changed no list-visible fact skips the whole-roster IDB
// put (V2b). syncedAt/savedAt are excluded on purpose: they are per-frame
// timestamps that would defeat the guard, and a stale syncedAt only ages the
// cold-open freshness stamp, it never changes what the list paints.
const rosterFingerprint = new Map<string, string>();

export function noteRosterSynced(engineKey: string, at: number): void {
  rosterSyncedAt.set(engineKey, at);
}

// Test-only: drop the persisted-content fingerprints so each test starts with a
// cold guard (module state outlives a test's sessions.clear()).
export function __resetRosterFingerprintForTest(): void {
  rosterFingerprint.clear();
}

export function toStoredSession(s: CycEngineSession): StoredSession {
  const out = {} as Record<string, unknown>;
  for (const f of ROSTER_FIELDS) {
    const v = s[f];
    if (v !== undefined) out[f] = v;
  }
  out.markedUnread = markedUnread.has(s.id);
  return out as unknown as StoredSession;
}

// Copy every roster field onto a live session (a cold open). `id` and `paneId`
// are the session's identity and are already set by ensureSession.
export function applyStoredSession(s: CycEngineSession, rs: StoredSession): void {
  for (const f of ROSTER_FIELDS) {
    if (f === 'id' || f === 'paneId') continue;
    const v = rs[f];
    if (v !== undefined) (s as unknown as Record<string, unknown>)[f] = v;
  }
  if (rs.markedUnread) markedUnread.add(s.id);
  else markedUnread.delete(s.id);
}

/* Persist the roster for one engine: the list-painting, cold-open snapshot in
 * the offline store (history.ts). Built in ONE place so the sessions frame and
 * a deliberate local mutation (mark-unread, rename, reorder) write exactly the
 * same shape. */
export function persistRoster(engineKey: string): void {
  const rows = [...sessions.values()]
    .filter((s) => s.engineKey === engineKey)
    .map(toStoredSession);
  const conn = connOf(engineKey);
  const tabs = lastSettledTabs.get(engineKey) ?? [];
  // Skip the put when nothing the row store persists actually changed: a
  // status-only churn, a re-broadcast, or a runtime-only field (churnGrey) all
  // leave this identical. A real change to any persisted field still writes.
  const fp = JSON.stringify({sessions: rows, tabs, hostname: conn?.host ?? null});
  if (rosterFingerprint.get(engineKey) === fp) return;
  rosterFingerprint.set(engineKey, fp);
  history.writeRoster({
    engineKey,
    syncedAt: rosterSyncedAt.get(engineKey) ?? 0,
    ...(conn?.host ? {hostname: conn.host} : {}),
    tabs,
    sessions: rows
  });
}
