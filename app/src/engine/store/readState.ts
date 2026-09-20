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
function pendingOf(sessionId: string): ReadMarker | undefined {
  const i = intents.all().find((x) => x.kind === 'heard' && x.sessionId === sessionId);
  if (!i) return undefined;
  const p = i.payload as HeardPayload;
  if (!Number.isFinite(p.ts)) return undefined;
  return p.mid ? {mid: p.mid, ts: p.ts} : {ts: p.ts};
}

/* A PRESS-TIME optimistic mark for this device's OWN row, held in memory only.
 * A just-sent row has no engine identity yet and its durable sighting is queued
 * on delivery (admit.ts); until then this keeps the unread divider from
 * stranding above his own message without putting a heard intent in the drain
 * to compete with the send it belongs to (reads drain ahead of sends). It is
 * forward-only and superseded the moment the durable sighting or the broadcast
 * reaches the same row (effectiveMarkerOf takes the furthest). */
const localMarks = new Map<string, ReadMarker>();

export function sightLocalRow(sessionId: string, marker: ReadMarker): void {
  const s = sessions.get(sessionId);
  const msgs = (s?.messages ?? []) as CycEngineMessage[];
  const cur = localMarks.get(sessionId);
  localMarks.set(sessionId, furthest(msgs, cur, marker) ?? marker);
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
  const broadcastPlusDurable = furthest(msgs, s.readThrough ?? undefined, pendingOf(s.id));
  return furthest(msgs, broadcastPlusDurable, localMarks.get(s.id));
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
  const i = intents.all().find((x) => x.kind === 'heard' && x.sessionId === sessionId);
  if (i) intents.remove(i.id);
  localMarks.delete(sessionId);
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
  return owner.client.heard(p.paneId, {mid: p.mid, msgId: p.msgId, ts: p.ts})
    ? 'done'
    : 'transient';
});
