import type {CycMessage, CycSession} from './types';
import type {ReadMarker} from './engine/store/readState';

/* READ REPORTING (app UI side): the device REPORTS SIGHTINGS and RENDERS engine
 * state. It never computes a read position from row timestamps and keeps no
 * second persisted clock (fix-unread; the old localStorage marker and the
 * max()-of-timestamps reconcile are gone). The engine broadcasts the marker
 * IDENTITY; readState.ts overlays this device's own pending sightings; this
 * module is where the surface reads that marker and where the four sighting
 * triggers (open, a new row while open, a clip played through, the explicit
 * paths) fire. */

type EngineFields = {msgId?: string; mid?: string; seq?: number};

export interface HeardStore {
  get(id: string): (CycSession & {messages: CycMessage[]}) | undefined;
  reportSighting(sessionId: string, row: {mid?: string; msgId?: string; ts: number}): void;
  effectiveMarkerOf(s: CycSession): ReadMarker | undefined;
}

interface HeardProgressDeps {
  store: HeardStore;
  isLive(): boolean;
  activeId(): string | null;
  isChatViewOpen(): boolean;
  /* Playing a clip through advances where the divider sits in the OPEN chat, so
   * the surface pins the newly heard row. Given the row identity, never a ts. */
  onHeardMarked(sessionId: string, marker: ReadMarker): void;
}

export function createHeardProgress(deps: HeardProgressDeps) {
  /* THE DISPLAYED MARKER for a session: the engine broadcast overlaid with this
   * device's own pending sightings, resolved to a row identity. The divider,
   * the landing anchor and where speech resumes all read THIS. */
  const readMarkerOf = (s: CycSession): ReadMarker | undefined => deps.store.effectiveMarkerOf(s);

  /* The instant the marker sits on, for the ts consumers that remain (audio
   * "finished", the speech queue). Derived from the identity marker, never from
   * a client clock, so it cannot drift the way the old heardTs did. */
  const heardTsOf = (s: CycSession): number => readMarkerOf(s)?.ts ?? 0;

  /* The newest MESSAGE this device has rendered, as a sighting: its durable
   * identity plus instant. Undefined when the log holds no message.
   *
   * NOT simply the newest row. The rendered log interleaves messages with
   * SESSION RECORDS (the faint activity rows: status, tool, prompt), and a
   * record carries no `mid` and is not in the engine's message log, so a
   * sighting that names one resolves to nothing and is ignored ("heard
   * sighting names no row we hold") -- the chat then stays unread however
   * many times it is opened. A turn ends with status records AFTER its last
   * reply, so the newest row is routinely a record (live 2026-09-23: CC
   * Vision stuck at 1 unread, newest row `status: done`). The marker is a
   * position among MESSAGES (unreadOf counts only those), so sight the
   * newest message and let the records ride along behind it. */
  const newestSighting = (
    s: CycSession & {messages: CycMessage[]}
  ): {mid?: string; msgId?: string; ts: number} | undefined => {
    const rows = s.messages as (CycMessage & EngineFields)[];
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (!row.mid) continue; // a session record: no durable identity to sight
      return {mid: row.mid, msgId: row.msgId, ts: row.ts};
    }
    return undefined;
  };

  /* A new row rendered while the chat is open, or the chat being closed: sight
   * the newest row so the optimism holds without waiting for the round trip. */
  function markSeen(id: string) {
    const s = deps.store.get(id);
    if (!s) return;
    const sighting = newestSighting(s);
    if (sighting) deps.store.reportSighting(id, sighting);
  }

  /* CHAT OPEN, visible: sight the newest fully-rendered row. No liveness gate --
   * reportSighting queues a durable intent the drain delivers on reconnect, so
   * an open that lands from cache while the pipe is reconnecting still marks the
   * chat read the moment the engine is reachable again. */
  function reportViewedThrough(id: string) {
    if (id !== deps.activeId() || !deps.isChatViewOpen()) return;
    const s = deps.store.get(id);
    if (!s) return;
    const sighting = newestSighting(s);
    if (sighting) deps.store.reportSighting(id, sighting);
  }

  /* A clip played through to the end: sight its row, and pin it in the open
   * chat so the divider follows playback. */
  function markHeard(sessionId: string, msgId: string) {
    const s = deps.store.get(sessionId);
    const played = s?.messages.find((m) => (m as CycMessage & EngineFields).msgId === msgId) as
      (CycMessage & EngineFields) | undefined;
    if (!played) return;
    deps.store.reportSighting(sessionId, {mid: played.mid, msgId, ts: played.ts});
    deps.onHeardMarked(sessionId, played.mid ? {mid: played.mid, ts: played.ts} : {ts: played.ts});
  }

  return {heardTsOf, readMarkerOf, markSeen, reportViewedThrough, markHeard};
}
