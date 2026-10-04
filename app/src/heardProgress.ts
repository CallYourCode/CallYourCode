import type {CycMessage, CycSession} from './types';
import type {ReadMarker} from './engine/store/readState';

/* READ REPORTING (app UI side): the device REPORTS SIGHTINGS and RENDERS engine
 * state. It never computes a read position from row timestamps and keeps no
 * second persisted clock (fix-unread; the old localStorage marker and the
 * max()-of-timestamps reconcile are gone). The engine broadcasts the marker
 * IDENTITY; readState.ts overlays this device's own pending sightings; this
 * module is where the surface reads that marker and where the sighting
 * triggers (open, a new row while open, a scroll, a return to the page, a clip
 * heard to the end, leaving the chat) fire.
 *
 * ONE RULE FOR EVERY ONE OF THEM (owner, 2026-10-03): a row is READ only when it
 * has actually been on screen (or, for a voice reply, heard to the end).
 *
 * AND THE MARKER ONLY MOVES THROUGH A CONTIGUOUS SEEN RUN. The marker is one
 * forward position, so sighting "the newest row in view" reads every row above
 * it too -- and the app itself moves the view past rows nobody saw (a landing
 * that ends at the bottom, a re-open, a deep landing). So no single view move is
 * trusted: every row that comes into the viewport (sampled on each sighting and
 * while the reader scrolls) or is heard to the end goes into this chat's SEEN
 * set, and the marker advances from where it is now to the newest message such
 * that every agent row between them is in that set. Rows a jump skipped stay
 * unread, however the view got to the bottom. Only the agent's rows have to be
 * seen: his own rows and the activity records are not unread (unreadOf on the
 * engine counts claude rows alone), so they ride along. */

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
  /* The surface's answer to "what is on screen now": the row ids (data-mid) of
   * the message rows in the chat viewport, or undefined when the viewport is not
   * showing this chat (another chat painted, the page hidden, nothing laid out). */
  onScreenRows(sessionId: string): string[] | undefined;
  /* Whether this chat has history older than its loaded window. A marker that
   * sits below the window then has unloaded rows after it that cannot have been
   * seen here, so the marker may not jump them. */
  historyBelowWindow(sessionId: string): boolean;
  /* Hearing a clip through advances where the divider sits in the OPEN chat, so
   * the surface pins the new read-through. Given the row identity, never a ts. */
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

  /* Per chat: the row ids that have been on screen (or heard), and the marker
   * instant they were collected against. A marker that moves BACK (marked
   * unread, here or on another device) drops the set: he asked to come back to
   * those rows, so they have to be seen again. */
  const seen = new Map<string, Set<string>>();
  const seenFrom = new Map<string, number>();
  const seenOf = (id: string): Set<string> => {
    const s = deps.store.get(id);
    const from = (s && readMarkerOf(s)?.ts) || 0;
    if (from < (seenFrom.get(id) ?? 0)) seen.delete(id);
    seenFrom.set(id, from);
    let set = seen.get(id);
    if (!set) seen.set(id, (set = new Set()));
    return set;
  };

  /* Where the marker sits in the loaded rows: its index, -1 when every loaded
   * row is after it and nothing older exists, null when that cannot be known
   * (it sits below the window with older history unloaded in between). */
  const markerAt = (id: string, rows: (CycMessage & EngineFields)[], marker?: ReadMarker) => {
    if (marker?.mid) {
      const i = rows.findIndex((m) => m.mid === marker.mid);
      if (i >= 0) return i;
    }
    const firstTs = rows[0]?.ts;
    if (marker && firstTs !== undefined && marker.ts >= firstTs) {
      let i = -1;
      for (let k = 0; k < rows.length && rows[k].ts <= marker.ts; k++) i = k;
      return i;
    }
    return deps.historyBelowWindow(id) ? null : -1;
  };

  /* THE ONE ADVANCE: from the marker, through every row whose agent rows have
   * all been seen, to the newest message with an identity in that run. */
  function advance(id: string): ReadMarker | undefined {
    const s = deps.store.get(id);
    if (!s) return undefined;
    const rows = s.messages as (CycMessage & EngineFields)[];
    const marker = readMarkerOf(s);
    const set = seenOf(id);
    if (!set.size) return undefined;
    const at = markerAt(id, rows, marker);
    if (at === null) return undefined;
    let target = -1;
    for (let i = at + 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.role === 'claude' && !set.has(row.id)) break;
      // a message with an identity to sight: its mid, or (a legacy agent row
      // with none) its instant; never a record or an unsent bubble of his
      if (row.mid || row.role === 'claude') target = i;
    }
    if (target < 0) return undefined;
    const row = rows[target];
    for (let i = 0; i <= target; i++) set.delete(rows[i].id); // read now: no longer needed
    deps.store.reportSighting(id, {mid: row.mid, msgId: row.msgId, ts: row.ts});
    return {mid: row.mid, ts: row.ts};
  }

  /* Record what is on screen now, without reporting (the reader's scroll
   * samples this as it moves; the pause after it reports). */
  function noteOnScreen(id: string) {
    const rows = deps.onScreenRows(id);
    if (!rows?.length) return;
    const set = seenOf(id);
    for (const r of rows) set.add(r);
  }

  /* THE ONE SIGHTING: note what is on screen, then advance under the rule. No
   * liveness gate -- reportSighting queues a durable intent the drain delivers
   * on reconnect. */
  function sightOnScreen(id: string) {
    noteOnScreen(id);
    advance(id);
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

  /* A clip HEARD TO THE END is seen, and goes through the same advance: speech
   * plays the unheard run in order, so each clip ending carries the marker one
   * row on. A clip stopped part way is not heard. The divider follows. */
  function markHeard(sessionId: string, msgId: string) {
    const s = deps.store.get(sessionId);
    const played = s?.messages.find((m) => (m as CycMessage & EngineFields).msgId === msgId);
    if (!played) return;
    seenOf(sessionId).add(played.id);
    const moved = advance(sessionId);
    if (moved) deps.onHeardMarked(sessionId, moved.mid ? moved : {ts: moved.ts});
  }

  return {heardTsOf, readMarkerOf, markSeen, reportViewedThrough, markHeard, noteOnScreen};
}
