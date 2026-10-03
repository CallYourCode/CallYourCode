import type {CycMessage, CycSession} from './types';
import type {ReadMarker} from './engine/store/readState';

/* READ REPORTING (app UI side): the device REPORTS SIGHTINGS and RENDERS engine
 * state. It never computes a read position from row timestamps and keeps no
 * second persisted clock (fix-unread; the old localStorage marker and the
 * max()-of-timestamps reconcile are gone). The engine broadcasts the marker
 * IDENTITY; readState.ts overlays this device's own pending sightings; this
 * module is where the surface reads that marker and where the sighting
 * triggers (open, a new row while open, a scroll, a return to the page, a clip
 * played through, the explicit paths) fire.
 *
 * ONE RULE FOR EVERY ONE OF THEM (owner, 2026-10-03): a row is READ only when it
 * has actually been on screen. "The chat is open and visible" is not read -- the
 * reader can be a screen up while a reply lands below him, and the old sighting
 * of the newest row in the window marked it read on every device while this one
 * showed "1 new below". So every trigger asks the surface for the newest row
 * that has come into the viewport (onScreenThrough) and sights that. A clip
 * played through is the one sighting of a row that need not be in view: he heard
 * it, which is the voice equivalent of seeing it. */

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
  /* The surface's answer to "what has been on screen": the row id (data-mid) of
   * the newest message row whose top has come into the chat viewport, or
   * undefined when the viewport is not showing this chat (another chat painted,
   * the page hidden, nothing laid out). */
  onScreenThrough(sessionId: string): string | undefined;
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

  /* The newest MESSAGE at or before the row `rowId` (the newest row on screen),
   * as a sighting: its durable identity plus instant. Undefined when that row is
   * not in this session's log, or nothing at or before it has an identity.
   *
   * NOT simply the row on screen. The rendered log interleaves messages with
   * SESSION RECORDS (the faint activity rows: status, tool, prompt), and a
   * record carries no `mid` and is not in the engine's message log, so a
   * sighting that names one resolves to nothing and is ignored ("heard
   * sighting names no row we hold") -- the chat then stays unread however
   * many times it is opened. A turn ends with status records AFTER its last
   * reply, so the newest row is routinely a record (live 2026-09-23: CC
   * Vision stuck at 1 unread, newest row `status: done`). The marker is a
   * position among MESSAGES (unreadOf counts only those), so sight the
   * newest message at or before the on-screen row, records riding along. */
  const sightingThrough = (
    s: CycSession & {messages: CycMessage[]},
    rowId: string
  ): {mid?: string; msgId?: string; ts: number} | undefined => {
    const rows = s.messages as (CycMessage & EngineFields)[];
    let at = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].id === rowId) {
        at = i;
        break;
      }
    }
    for (let i = at; i >= 0; i--) {
      const row = rows[i];
      if (!row.mid) continue; // a session record: no durable identity to sight
      return {mid: row.mid, msgId: row.msgId, ts: row.ts};
    }
    return undefined;
  };

  /* THE ONE SIGHTING: whatever of this chat has been on screen, and nothing
   * more. No liveness gate -- reportSighting queues a durable intent the drain
   * delivers on reconnect, so a sighting made while the pipe is reconnecting
   * still lands the moment the engine is reachable again. */
  function sightOnScreen(id: string) {
    const s = deps.store.get(id);
    if (!s) return;
    const through = deps.onScreenThrough(id);
    if (!through) return;
    const sighting = sightingThrough(s, through);
    if (sighting) deps.store.reportSighting(id, sighting);
  }

  /* The chat being left (back to the list, another chat, a send): sight what is
   * on screen as it goes, under the same rule. */
  function markSeen(id: string) {
    sightOnScreen(id);
  }

  /* CHAT OPEN, visible: the open landing, a live arrival, a scroll, a return to
   * the page. Only the open chat in the chat view. */
  function reportViewedThrough(id: string) {
    if (id !== deps.activeId() || !deps.isChatViewOpen()) return;
    sightOnScreen(id);
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
