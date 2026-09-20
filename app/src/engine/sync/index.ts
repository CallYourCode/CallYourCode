// The sync module's seam. The UI sees one word (`status()`); the workers that
// move bytes only while an engine answers (transfers, intents) subscribe to
// the settled edge (`onConnected`) and poll nothing: offline is silence, then
// one edge. The state machine lives in ./connection; this file is the surface.

export type {EngineSyncState, SyncStatus, PokeReason, Dialer} from './connection';
export {
  HIDDEN_STOP_MS,
  CONNECTING_SHOW_MS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffMs,
  status,
  engineState,
  engineKeys,
  onStatus,
  onConnected,
  onDisconnected,
  setSettledEdge,
  register,
  start,
  poke,
  noteDialing,
  noteDown,
  schedule,
  noteSealed,
  noteHost,
  noteSessions,
  noteQueued,
  noteTransfers,
  setHidden,
  setOnline,
  noteSynced,
  syncedAt,
  activeTimers,
  __resetLiveForTest,
  __resetForTest
} from './connection';

import {engineState} from './connection';

export type ConnectedCb = (engineKey: string) => void;

// An engine is reachable once it has settled: bytes written to it go somewhere.
export function isLive(c: {key: string}): boolean {
  const st = engineState(c.key);
  return st === 'settled' || st === 'draining' || st === 'live';
}

export function engineReachable(engineKey: string): boolean {
  return isLive({key: engineKey});
}
