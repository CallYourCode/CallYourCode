/* READ STATE (app side): the engine is the ONE authority and this renders it.
 *
 * The engine broadcasts, per session, the IDENTITY of the newest row read
 * (readThrough = {mid, ts}) and the unread count. This device never computes a
 * read position from row timestamps: it reports SIGHTINGS ("I saw row R") and
 * overlays its own not-yet-acknowledged sightings on the broadcast until the
 * next frame collapses the two. There is no second persisted clock and no
 * max()-of-timestamps reconcile: those were the two authorities on two clocks
 * that produced ghost unread. See readstate.ts on the engine.
 */
import * as intents from '../intents';
import type {HeardPayload, Intent} from '../intents';
import * as drain from '../sync/drain';
import type {DrainOutcome} from '../sync/drain';
import type {EngineReadThrough} from '../contract';
import type {CycEngineMessage, CycEngineSession} from './types';
import {connOf, sessions} from './registry';

export type ReadMarker = {mid?: string; ts: number};

/* This device's OWN pending sighting for a session: the live, durable, coalesced
 * `heard` intent it has queued but the engine has not yet reflected back. It
 * survives a reload because the intent does, and it drains on reconnect. There
 * is at most one (heard intents coalesce per session, keeping the furthest ts),
 * so the overlay is read straight off the intent rather than mirrored in a
 * second store that could drift from it. */
const isSpoken = (i: Intent) => (i.payload as HeardPayload).spoken === true;

function pendingOf(sessionId: string): ReadMarker | undefined {
  const i = intents
    .all()
    .find((x) => x.kind === 'heard' && x.sessionId === sessionId && !isSpoken(x));
  if (!i) return undefined;
  const p = i.payload as HeardPayload;
  if (!Number.isFinite(p.ts)) return undefined;
  return p.mid ? {mid: p.mid, ts: p.ts} : {ts: p.ts};
}

/* The store index of a marker's row, resolved by durable IDENTITY ALONE: the
 * mid. -1 when the marker has no mid, or its row is not in the loaded window
 * (aged out, or never loaded). Time is never identity here: there is no
 * ts-equality fallback that could land the marker on a DIFFERENT row that merely
 * shares its instant. A marker that does not resolve is -1, and `furthest` then
 * orders it by ts (an ordering of unloaded rows, not an identity claim). */
export function markerIndexIn(
  messages: readonly CycEngineMessage[],
  marker: ReadMarker | undefined
): number {
  if (!marker?.mid) return -1;
  return messages.findIndex((m) => m.mid === marker.mid);
}

/* Which of two markers sits FURTHER FORWARD in the store order. Both resolve to
 * a row index and the higher wins; when a row is not loaded, its instant breaks
 * the tie so a sighting for a row past the loaded tail still wins. `a` wins a
 * tie, so passing the broadcast as `a` keeps the overlay from re-winning once
 * the frame has caught up. */
function furthest(
  messages: readonly CycEngineMessage[],
  a: ReadMarker | undefined,
  b: ReadMarker | undefined
): ReadMarker | undefined {
  if (!a) return b;
  if (!b) return a;
  const ia = markerIndexIn(messages, a);
  const ib = markerIndexIn(messages, b);
  if (ia >= 0 && ib >= 0) return ib > ia ? b : a;
  return b.ts > a.ts ? b : a;
}

/* The DISPLAYED marker: the engine broadcast overlaid with this device's own
 * pending sighting, whichever sits further forward. Undefined when nothing is
 * read here. The divider, landing and speech all anchor on THIS. */
export function effectiveMarkerOf(s: CycEngineSession): ReadMarker | undefined {
  const msgs = s.messages as CycEngineMessage[];
  return furthest(msgs, s.readThrough ?? undefined, pendingOf(s.id));
}

/* MAY A CLIP AUTOPLAY AS A LIVE ARRIVAL? The SAME truth the unread count and the
 * divider use: a say only autoplays when its row sits AT OR AFTER this device's
 * read-through (readState). speakUnheard was already taught this (fix-heard-sync);
 * the say-frame ARRIVAL path (storeBindings.handleSay) was NOT, so a say that
 * names a row already far behind the read-through -- a stranded growing clip whose
 * frame reaches an open chat, ~200 read rows past it -- autoplayed as though it
 * had just landed (the owner's "it played a very old audio"). Gated here, once,
 * so both paths speak the same rows.
 *
 *   - readStateFreshOnConn: never decide from the CACHED roster read state. Until
 *     the engine refreshes this session's marker on THIS connection, the marker
 *     is stale (the owner read the chat elsewhere while this device slept) and a
 *     decision would replay an already-heard clip. Wait, exactly as speakUnheard.
 *   - the row must be LOADED: a live arrival's row is written by the `chat` frame
 *     before its `say`, so it is always in the window; a row that is not loaded is
 *     an old backfilled one, never a live arrival.
 *   - AT OR AFTER the marker: a live reply, once auto-sighted on arrival, sits
 *     exactly AT the read-through, so the boundary is inclusive -- a genuine live
 *     arrival still speaks; a row strictly BEFORE the marker (heard, read past)
 *     never does. The marker's LOADED row anchors this by identity (its index),
 *     like the divider; when the marker's row has aged out of the window its own
 *     engine instant anchors it instead (never a client clock), so a stale cached
 *     window whose tail sits behind the read-through no longer autoplays an old
 *     clip as an arrival (fix-old-clip-attach). */
export function mayAutoplayArrival(sessionId: string, msgId: string): boolean {
  if (!readStateFreshOnConn(sessionId)) return false;
  const s = sessions.get(sessionId);
  if (!s) return false;
  const msgs = s.messages as CycEngineMessage[];
  const rowIdx = msgs.findIndex((m) => m.msgId === msgId);
  if (rowIdx < 0) return false;
  const marker = effectiveMarkerOf(s);
  if (!marker) return true; // the engine reports nothing read here: genuinely unheard
  const markerIdx = markerIndexIn(msgs, marker);
  if (markerIdx >= 0) return rowIdx >= markerIdx;
  /* The read-through row is NOT in the loaded window, so its page is not loaded.
   * The old code returned true here -- "marker on an older page, every loaded row
   * is past it" -- but that is only ONE of the two reasons a marker aged out, and
   * it is the wrong one for the field defect (fix-old-clip-attach). A device that
   * slept while the owner read on another device opens onto a STALE cached window
   * whose NEWEST loaded row is BEHIND the engine's read-through: the genuinely
   * unheard reply is on a page NEWER than everything loaded, not older. Returning
   * true then autoplayed the newest OLD clip still in the stale window as a fresh
   * arrival (the owner's "it played a very old audio", clip.play reason=
   * autoplay-arrival on a 2-day-old finalised speak clip). PROVEN in the logs: the
   * cache paint range top sat below the engine heardTs at every one of the four
   * replays, so the marker row was never loaded.
   *
   * Decide by the marker's OWN engine instant instead. Both the row ts and the
   * read-through ts are the engine's, never a client clock, so this is NOT the ts
   * reconcile that identity was chosen over (that was a CLIENT clock vs the
   * engine): it is the same AT-OR-AFTER test the index gives, extended to a marker
   * whose row aged out of the window. A row strictly before the read-through
   * instant is read and must not autoplay; a genuine live arrival (ts at or after
   * the marker, and its row is always loaded by its own `chat` frame) still does. */
  return msgs[rowIdx].ts >= marker.ts;
}

/* Adopt the engine's broadcast onto the session. The overlay is left to the
 * intent: it drains and is removed once delivered, and effectiveMarkerOf then
 * reads the broadcast alone. */
export function applyBroadcastReadThrough(
  s: CycEngineSession,
  rt: EngineReadThrough | null | undefined
): void {
  s.readThrough = rt ?? undefined;
}

/* HAS THE ENGINE REFRESHED THIS SESSION'S READ STATE ON THE CURRENT LIVE
 * CONNECTION? At a cold boot / reconnect / notification-tap open the marker and
 * the unread count on the session are the CACHED roster values (persisted in
 * roster.ts), and those can be STALE: the owner read the chat on the laptop
 * while the phone slept, so the phone's persisted unread is 0 and its marker is
 * behind the truth. Speech-on-open must not select the to-play set from that --
 * a `ts` scan replays already-heard clips (the owner's "back on the phone it
 * plays some old audio message") and a stale marker misses a genuine new reply.
 * speakUnheard waits for this flag; the sessions/catchup frame sets it when the
 * engine serves this session's live row, and its arrival re-invokes speakUnheard
 * (onReadStateFresh -> renderHub) so speech runs once, on the engine's truth.
 * Cleared on disconnect so "on this connection" holds again after a reconnect. */
const readStateFresh = new Set<string>();
const readStateFreshSubs = new Set<(sessionId: string) => void>();

export function noteReadStateFresh(sessionId: string): void {
  if (readStateFresh.has(sessionId)) return;
  readStateFresh.add(sessionId);
  for (const cb of [...readStateFreshSubs]) cb(sessionId);
}

export function readStateFreshOnConn(sessionId: string): boolean {
  return readStateFresh.has(sessionId);
}

export function forgetReadStateFresh(sessionId: string): void {
  readStateFresh.delete(sessionId);
}

/* Fired ONCE on the not-fresh -> fresh edge for a session (the first live read
 * state of this connection). speakUnheard, deferred at open, is re-invoked here
 * so it decides on the engine's truth instead of the cache. */
export function onReadStateFresh(cb: (sessionId: string) => void): () => void {
  readStateFreshSubs.add(cb);
  return () => readStateFreshSubs.delete(cb);
}

// Test seam: module state (the fresh set) outlives a test's sessions.clear().
export function __resetReadStateFreshForTest(): void {
  readStateFresh.clear();
  readStateFreshSubs.clear();
}

/* REPORT A SIGHTING: "this device saw row R". Overlays it optimistically (the
 * durable heard intent IS the overlay) and queues that intent for the drain to
 * deliver on the next sealed pipe. Coalesces per session, keeping the furthest
 * ts, so a burst of sightings collapses to one frame. Never marks read from a
 * timestamp alone: the row's identity (`mid`) rides the wire, `ts` is the
 * fallback for a legacy row and the coalesce key. */
/* MARK AS UNREAD undoes this device's optimism: drop the pending sighting so it
 * cannot immediately re-mark the chat read while the engine moves its marker
 * back. The engine stays the authority; this only clears the local overlay. */
export function forgetSighting(sessionId: string): void {
  // the engine moves speech back with the marker, so a queued spoken mark goes too
  for (const i of intents.all()) {
    if (i.kind === 'heard' && i.sessionId === sessionId) intents.remove(i.id);
  }
}

/* HOW FAR SPEECH HAS GOT for a session: the engine's broadcast, or this
 * device's own queued report if that is further (it survives a reload with the
 * intent). 0 when nothing is known spoken. */
export function spokenTsOf(s: CycEngineSession): number {
  const i = intents.all().find((x) => x.kind === 'heard' && x.sessionId === s.id && isSpoken(x));
  const queued = i ? (i.payload as HeardPayload).ts : 0;
  return Math.max(s.spokenTs ?? 0, Number.isFinite(queued) ? queued : 0);
}

/* REPORT HOW FAR SPEECH HAS GOT: a clip played to the end, with every clip
 * before it (heardProgress decides the run). The same durable heard intent as a
 * sighting, under its own coalesce key and flagged `spoken`, so the engine
 * records it on its second fact and never on the read marker. Forward only. */
export function reportSpoken(
  sessionId: string,
  row: {mid?: string; msgId?: string; ts: number}
): void {
  const s = sessions.get(sessionId);
  if (!s || !Number.isFinite(row.ts) || row.ts <= spokenTsOf(s)) return;
  intents.put({
    id: 'spoken:' + sessionId + ':' + (crypto.randomUUID?.() ?? Date.now().toString(36)),
    engineKey: s.engineKey,
    sessionId,
    kind: 'heard',
    coalesceKey: 'spoken:' + sessionId,
    payload: {
      paneId: s.paneId,
      mid: row.mid,
      msgId: row.msgId,
      ts: row.ts,
      spoken: true
    } satisfies HeardPayload
  });
  drain.kick(s.engineKey);
}

export function reportSighting(
  sessionId: string,
  row: {mid?: string; msgId?: string; ts: number}
): void {
  const s = sessions.get(sessionId);
  if (!s || !Number.isFinite(row.ts)) return;
  const cur = pendingOf(sessionId);
  // Forward-only: a sighting behind what we already queued adds nothing.
  const marker: ReadMarker = row.mid ? {mid: row.mid, ts: row.ts} : {ts: row.ts};
  if (furthest(s.messages as CycEngineMessage[], cur, marker) === cur && cur) return;
  intents.put({
    id: 'heard:' + sessionId + ':' + (crypto.randomUUID?.() ?? Date.now().toString(36)),
    engineKey: s.engineKey,
    sessionId,
    kind: 'heard',
    coalesceKey: 'heard:' + sessionId,
    payload: {paneId: s.paneId, mid: row.mid, msgId: row.msgId, ts: row.ts} satisfies HeardPayload
  });
  drain.kick(s.engineKey);
}

/* THE SIGHTING WRITER (fix-unread): a queued heard intent hands the engine the
 * row identity a device saw. Registered here, beside reportSighting, so it is
 * loaded wherever a sighting can be queued (sends.ts, admit.ts) rather than
 * only when the whole store module is imported -- a heard intent with no
 * executor would stall the drain behind it (F1: reads never wait on sends). */
drain.registerExecutor('heard', (intent: Intent): DrainOutcome => {
  const p = intent.payload as HeardPayload;
  const owner = connOf(intent.engineKey);
  if (!owner) return 'transient';
  return owner.client.heard(p.paneId, {mid: p.mid, msgId: p.msgId, ts: p.ts}, p.spoken === true)
    ? 'done'
    : 'transient';
});
