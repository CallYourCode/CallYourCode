// The conversation store, pure. This module holds the row model and every
// decision the store makes about it, over plain in-memory structures and with
// no IndexedDB, no wire, and no clock of its own. rowStore.ts wraps it with the
// durable backing; the replicator drives it from the wire. Splitting the logic
// out this way is the same discipline shared/blobStore.ts keeps: the rules get
// exhaustive unit tests without a browser database.
//
// THE ONE RULE the model exists to serve: a row's identity is its `mid`, never
// its seq. seq is a rewritable ordering attribute (engine restarts renumber it;
// real logs carry colliding seqs). Every write is an idempotent upsert by mid,
// so re-syncing a page after a renumber or a crash converges instead of
// twinning.

import type {CycSessionEvent} from '../../../types';
import type {CycEngineMessage} from '../types';

export type RowKind = 'msg' | 'event';

// The event kinds the chat surface paints as pills (the canonical set the chat's
// VISIBLE_EVENT_KINDS re-exports, so the two can never drift). A stored event row
// of ANY OTHER kind is a session RECORD: real agent-log history held on the seq
// axis beside the messages, but never given a chat pill.
//
// These pills paint ONLY under the agent-activity overlay (renderHub passes the
// events to the surface only when overlayOn). The cold open does not require that
// overlay, so an event kind being in this set does NOT make it safe to anchor the
// open window on: see anchorsOpenWindow, which anchors on messages alone.
export const RENDERABLE_EVENT_KINDS: ReadonlySet<string> = new Set([
  'prompt',
  'reply',
  'tool',
  'compact',
  'interrupt'
]);

// One stored row. `id` is the durable, restart- and renumber-invariant key the
// row is upserted on. `seq` is the ordering axis the replicator may rewrite in
// place. `msg`/`event` carry the kind's payload; exactly one is set.
export type StoreRow = {
  id: string;
  sessionId: string;
  seq: number;
  kind: RowKind;
  ts: number;
  msg?: CycEngineMessage;
  event?: CycSessionEvent;
};

// The lightweight seq-index tuple: enough to order the whole session and find
// what is below a window floor, without holding a single payload in memory. The
// full tuple array is the authoritative ordering; payloads are loaded only for
// the visible window.
// `ek` is an event row's own kind (prompt/reply/tool/record/...), carried on the
// tuple so the surface's pill kind is decidable from the index alone, without
// loading the payload. It is set only for event tuples. It does NOT drive the
// open-window floor (see anchorsOpenWindow: only messages anchor the window); it
// stays on the tuple as the durable pill-kind hint the surface reads.
export type RowTuple = {id: string; seq: number; ts: number; kind: RowKind; ek?: string};

// THE ONE NAME of a message row: its durable string identity, computed here and
// nowhere else (fix-oneid). One row, one name, used by the store AND by every
// feature (data-mid, reply targets, retry/cancel, the read marker). The
// spelling is chosen so the name is INVARIANT across the row's whole lifetime
// on a device -- dispatch, engine echo, re-serve, reload -- so no consumer ever
// holds a dangling id and no reload can twin two bubbles:
//   - a `cid` (this app's own send correlation, minted at dispatch and persisted
//     by the engine on the row) keys `m:c:<cid>`. The cid survives the echo (it
//     rides back on it), a delivery ts-restamp (ts moves, cid does not) and
//     every re-serve, so an own send keeps ONE name from its optimistic bubble
//     through delivery and past a reload. cid is preferred over mid for exactly
//     this: it exists BEFORE the mid does.
//   - else the engine's `mid` (minted and persisted at write time, identical on
//     every re-serve) keys `m:<mid>`: claude/agent rows, and any user row that
//     carries no cid.
//   - else a legacy fallback over ts|role|text, stable because ts is strictly
//     increasing within a session. Only rows from an engine that predates mid
//     minting reach it.
// Namespaced `m:`/`m@` so a message id can never collide with an event id.
export function rowIdOfMessage(m: {
  cid?: string;
  mid?: string;
  ts: number;
  role: string;
  text: string;
}): string {
  if (m.cid) return `m:c:${m.cid}`;
  if (m.mid) return `m:${m.mid}`;
  return `m@${m.ts}|${m.role}|${m.text}`;
}

// Stamp a message with its one durable id (rowIdOfMessage). Every builder calls
// this at construction, so a message object carries its own name from birth and
// the store never has to mint one. Because the spelling is lifetime-invariant
// for the normal paths, re-stamping a mutated row is a no-op there; the store
// re-stamps through messageRow so a row's payload id can never disagree with its
// durable key.
export function stampRowId(m: CycEngineMessage): CycEngineMessage {
  m.id = rowIdOfMessage(m);
  return m;
}

// The durable id of a session-record row: the engine's `se-...` uuid, namespaced
// `e:` so a message id and an event id are always distinct even keyed together.
export function rowIdOfEvent(ev: {uuid: string}): string {
  return `e:${ev.uuid}`;
}

export function messageRow(sessionId: string, m: CycEngineMessage): StoreRow {
  const id = rowIdOfMessage(m);
  // The payload carries the same one name as its durable key, always: a row
  // whose fields gained a cid or mid since it was built (a settled echo) is
  // re-stamped here so msg.id can never lag the key it is stored under.
  m.id = id;
  return {id, sessionId, seq: m.seq ?? -1, kind: 'msg', ts: m.ts, msg: m};
}

export function eventRow(sessionId: string, ev: CycSessionEvent): StoreRow {
  return {id: rowIdOfEvent(ev), sessionId, seq: ev.seq ?? -1, kind: 'event', ts: ev.ts, event: ev};
}

export function tupleOf(r: StoreRow): RowTuple {
  const t: RowTuple = {id: r.id, seq: r.seq, ts: r.ts, kind: r.kind};
  if (r.kind === 'event' && r.event) t.ek = r.event.kind;
  return t;
}

// Whether a tuple anchors the open window: ONLY a message does. The chat's
// default view (the one a cold open lands on) paints messages and nothing else;
// session events -- even the kinds the surface CAN paint as pills
// (prompt/reply/tool/compact/interrupt) -- render only under the agent-activity
// overlay, a toggle the cold open neither sets nor requires. So an event, however
// paintable-under-overlay, cannot guarantee a non-blank open, and must not COUNT
// toward the newest-window span.
//
// A busy agent runs long after its last chat message: it stamps hundreds of
// prompt/reply/tool events on the seq axis ABOVE the newest message, so the
// newest rows BY SEQ (and by the old renderable-event anchor) are all events and
// the real messages sit far below the tail. Anchoring on those events floored the
// window on an all-event span; with the overlay off the window then held zero
// messages and the chat opened blank (the field's cold-open blank chat), and even
// with the overlay on the conversation's own bubbles never entered the window.
// Anchoring on messages alone drops the floor below the event tail to the newest
// real messages, so the bubbles are in the window whether or not the overlay is
// on; the events between and above them stay HELD in the contiguous span (loaded
// for the overlay to paint) but never define the floor.
export function anchorsOpenWindow(t: RowTuple): boolean {
  return t.kind === 'msg';
}

// A total order over rows/tuples: TS first (the engine's stamped clock, which
// stampTs keeps strictly increasing per session), seq to break a colliding ts,
// id last so the order is total and stable across upserts.
//
// ts leads, not seq, because seq is NOT a reliable chronological axis: a legacy
// log can carry a seq that disagrees with ts. Two shapes seen in the field, both
// in one Hunter chat file: a harness session-resume that RESTARTED the message
// seq at 1 (so a 28-Aug row reuses a seq the 27-Aug run already spent), and
// session-record rows appended under a SEPARATE, higher seq band than the
// co-temporal messages (a record stamped 25-Aug carrying a seq that sorts it
// beside 02-Sep messages). Ordering by seq rendered those rows far from their
// true time (an old-dated row sandwiched among newer ones); ordering by ts puts
// every row back where its clock says it belongs. ts survives an engine seq
// renumber untouched, so it is the axis a re-serve cannot scramble. A ts tie (a
// burst that shares a millisecond) still falls back to seq, so the engine's
// intended order within one instant is preserved.
//
// A row with no committed seq yet (seq < 0: a just-sent pending bubble before its
// echo) sorts AFTER every committed row of the SAME ts, at the tail, ordered
// among its peers by ts. A fresh pending send carries a client `now` ts, the
// newest in the session, so it lands at the bottom of the transcript (where the
// user typed it) anyway; the seq < 0 tail rule only decides a same-ts collision.
function orderSeq(seq: number): number {
  return seq < 0 ? Infinity : seq;
}
export function cmpTuple(a: RowTuple, b: RowTuple): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const as = orderSeq(a.seq);
  const bs = orderSeq(b.seq);
  if (as !== bs) return as < bs ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// The window floor is a BOUNDARY in the ts total order (the same axis cmpTuple
// and the index are on), NOT a seq threshold. The loaded window is the contiguous
// tail slice { t in idx : cmpTuple(t, floor) >= 0 } -- every row at or newer than
// the floor tuple -- plus any pending send (seq < 0), which always rides the tail.
//
// A seq threshold cannot express this window on a reset-bearing log. seq is not
// monotonic in ts there (a post-reset band carries LOWER seqs than an older
// pre-reset band that is still in the window), so `seq >= floorSeq` is not a
// contiguous ts-tail: a live append that rides the floor up by seq would EVICT
// rows that are NEWER by ts but carry a lower (reused) seq, opening a hole in the
// newest of the transcript. Cutting by ts-position keeps eviction to rows
// strictly BELOW the window in true time order, so a newer-by-ts low-seq row is
// always kept.
//
// WINDOW_FLOOR_ALL sorts below every real row (ts -Infinity), so a window floored
// on it holds everything: the state a cold open on an empty store, or an admit
// that beats openWindow, starts from before the bound rides up to windowSize.
export const WINDOW_FLOOR_ALL: RowTuple = {
  id: '',
  seq: 0,
  ts: Number.NEGATIVE_INFINITY,
  kind: 'msg'
};

// Whether a tuple is IN a window cut at `floor`: at or newer than the floor in the
// ts order, or a pending send (seq < 0) riding the tail. false when there is no
// floor (the window is not open yet).
function tupleInWindow(t: RowTuple, floor: RowTuple | null): boolean {
  if (!floor) return false;
  if (t.seq < 0) return true;
  return cmpTuple(t, floor) >= 0;
}

// Whether boundary `a` sits strictly ABOVE `b` in the ts order (raising the floor
// to `a` would shrink the window). A null `b` is the unfloored state, below
// everything, so any real boundary is above it.
function aboveFloor(a: RowTuple, b: RowTuple | null): boolean {
  if (!b) return true;
  return cmpTuple(a, b) > 0;
}

// Whether a tuple is in the mirror's current loaded window.
export function inWindow(m: Mirror, t: RowTuple): boolean {
  return tupleInWindow(t, m.floor);
}

// The in-memory shape rowStore keeps for a session it is holding. `idx` is the
// full, ts-ordered tuple list: cheap, so the whole session's ordering is known.
// `loaded` holds the payloads of the visible window only, keyed by durable id.
// `floor` is the window floor TUPLE (a boundary in the ts order); rows below it
// live only in the durable backing until the window extends; null before any
// open. `windowSize` is the row count the open bound the window to (0 before any
// open), so a backfill write can ride the floor up to the newest-`windowSize`
// boundary and keep the projection bounded. `extended` is set once the user
// scrolled up (extendWindow deliberately lowered the floor): while extended the
// bound is suspended so a live/backfill write never trims the older reach the
// user asked for.
export type Mirror = {
  idx: RowTuple[];
  loaded: Map<string, StoreRow>;
  floor: RowTuple | null;
  windowSize: number;
  extended: boolean;
};

export function emptyMirror(): Mirror {
  return {idx: [], loaded: new Map(), floor: null, windowSize: 0, extended: false};
}

function insertTuple(idx: RowTuple[], t: RowTuple): void {
  // binary search for the insertion point in the total order
  let lo = 0;
  let hi = idx.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmpTuple(idx[mid], t) < 0) lo = mid + 1;
    else hi = mid;
  }
  idx.splice(lo, 0, t);
}

export type UpsertResult = {
  loSeq: number;
  hiSeq: number;
  changed: boolean;
  // true when the batch touched the currently loaded window (at or above the
  // floor, or a pending/no-seq row): the only case the open chat must repaint.
  touchesWindow: boolean;
  inserted: string[];
  // durable ids of incumbent rows the twin-rekey folded into an arriving mid
  // row (see rekeyMidlessTwins): the caller deletes these from the backing so
  // the merged-away row leaves no orphan record.
  rekeyedFrom: string[];
  // arriving mid-LESS rows the reverse fold merged INTO a mid-bearing incumbent
  // (see foldMidlessArrivals): `from` never inserted, so the caller must not
  // persist it (and deletes any stale record), and re-persists `into` because
  // the incumbent's payload was enriched from the folded-away row.
  foldedInto: Array<{from: string; into: string}>;
  // durable ids of poison rows the door REFUSED to admit (see isPoisonTuple):
  // a message row that would land an off-axis id (seq < 0: an unseqed wall or a
  // client-ts optimistic bubble) once the session already holds engine-axis rows.
  // A mid-less row carrying a valid seq is real engine history and is NOT here.
  // The caller logs each so a future writer names itself in the field, and never
  // persists it (it was never inserted).
  refused: string[];
};

// A mid-keyed durable id (rowIdOfMessage with a mid): `m:<mid>`. The provisional
// pending id `m:pending:<cid>` also begins `m:` but is NOT mid-keyed, and the
// fallback id begins `m@`. Anything else that begins `m:` carries a real mid.
function isMidKeyedId(id: string): boolean {
  return id.startsWith('m:') && !id.startsWith('m:pending:');
}

// A tuple that makes the local seq axis stale. A message row with NO committed
// seq (seq < 0) sorts at the tail axis (Infinity), walls the newest window, and
// is never sound engine history (a client-ts optimistic bubble never becomes a
// store row through the door, and a legacy unseqed row cannot be ordered), so it
// is always poison. A mid-LESS message row (its durable id fell back to
// `m@ts|role|text`) is subtler: the engine's own real chat files predate mid
// minting and re-serve genuine history with valid, on-axis seqs but no mid, so a
// mid-less row is LEGITIMATE engine history when it sits ON the axis
// (0 <= seq <= the tail known at the attach) and must be kept; it is poison only
// when it sorts ABOVE that tail (a migrated older/longer axis twinning the real
// tail). `axisBound` is that tail. Callers with no axis in hand (the door, a read
// sanitise) pass none, so only the seq < 0 shape is refused and an on-axis
// mid-less engine row always passes. An event never falls back on a mid, so only
// msg tuples are ever poison.
export function isPoisonTuple(t: RowTuple, axisBound = Infinity): boolean {
  if (t.kind !== 'msg') return false;
  if (t.seq < 0) return true;
  return t.id.startsWith('m@') && t.seq > axisBound;
}

// True once the mirror holds at least one genuine engine-axis message row (a
// mid-keyed id on a committed seq). While this is false the whole session may
// be legacy rows the engine has not re-served yet, and refusing or dropping
// them would blank the chat before the heal can serve a tail; once it is true a
// poison row can only be a stale twin/wall, so the door refuses it and a read
// sanitises it away.
export function hasEngineAxis(m: Mirror): boolean {
  for (const t of m.idx) if (t.kind === 'msg' && t.seq >= 0 && isMidKeyedId(t.id)) return true;
  return false;
}

// The non-mid incumbent that is the SAME message as an arriving mid-bearing row,
// or null when the session holds none. "Same message", scoped to this session
// and to non-mid message rows only (a row that already carries a mid is never a
// candidate, so two rows that both carry mids are never merged): same cid, else
// same dedupeKey, else the (ts, role, text) bridge rowIdOfMessage derives from
// the arriving row. This is what lets the door fold a live echo that settled
// under the fallback id into the later re-serve that carries the mid.
//
// THE FALSE-MERGE GUARD (VERIFY4): a cid names the exact send, so two rows whose
// cids DISAGREE are never the same message, whatever their (ts, role, text). A
// disagreeing cid disqualifies the incumbent outright, before the weaker
// (ts, role, text) bridge can override it, so two genuinely different messages
// that merely share (ts, role, text) but carry different cids stay two rows
// instead of silently collapsing (one message discarded). Without the guard the
// bridge fired on (ts, role, text) alone.
export function findMidlessTwin(m: Mirror, arriving: StoreRow): string | null {
  const a = arriving.msg;
  if (arriving.kind !== 'msg' || !a?.mid) return null;
  const fallbackId = rowIdOfMessage({ts: a.ts, role: a.role, text: a.text});
  let byCid: string | null = null;
  let byDedupe: string | null = null;
  let byBridge: string | null = null;
  for (const t of m.idx) {
    if (t.kind !== 'msg' || t.id === arriving.id) continue;
    const row = m.loaded.get(t.id);
    const incMid = row?.msg?.mid;
    // Never merge two rows that both carry a mid: an incumbent that carries one
    // (by its loaded payload or by its mid-keyed id) is off-limits.
    if (incMid || isMidKeyedId(t.id)) continue;
    const inc = row?.msg;
    // Disagreeing cids: not the same message, no bridge may override it.
    if (inc && a.cid && inc.cid && inc.cid !== a.cid) continue;
    if (inc) {
      if (a.cid && inc.cid && inc.cid === a.cid) byCid = t.id;
      else if (a.dedupeKey && inc.dedupeKey && inc.dedupeKey === a.dedupeKey) byDedupe = t.id;
    }
    if (t.id === fallbackId) byBridge = t.id;
  }
  return byCid ?? byDedupe ?? byBridge;
}

// The MID-BEARING incumbent that is the SAME message as an arriving MID-LESS row,
// or null. The reverse of findMidlessTwin: it lets the door fold a settle or an
// echo that lands under the fallback id AFTER the mid copy was already stored
// (the mid re-serve arrived first) into that mid row, instead of twinning it.
// Matched by cid, then dedupeKey, and NOTHING weaker: a bare (ts, role, text)
// bridge here would be the same false merge the forward guard removes, so it is
// absent. Only loaded, mid-bearing message rows are candidates.
function findMidBearingTwin(m: Mirror, arriving: StoreRow): string | null {
  const a = arriving.msg;
  if (arriving.kind !== 'msg' || !a || a.mid) return null;
  let byCid: string | null = null;
  let byDedupe: string | null = null;
  for (const t of m.idx) {
    if (t.kind !== 'msg' || t.id === arriving.id) continue;
    const inc = m.loaded.get(t.id)?.msg;
    if (!inc?.mid) continue; // only a mid-bearing incumbent is a target
    if (a.cid && inc.cid && inc.cid !== a.cid) continue; // disagreeing cids: not the same
    if (a.cid && inc.cid && inc.cid === a.cid) byCid = t.id;
    else if (a.dedupeKey && inc.dedupeKey && inc.dedupeKey === a.dedupeKey) byDedupe = t.id;
  }
  return byCid ?? byDedupe;
}

// Carry the incumbent's client-local facts onto the arriving mid row before it
// takes the incumbent's place: the fields an engine page copy does not carry but
// the live settle established (a delivered/sent status, the cid, the upload
// payload, the msgId). The id is NOT carried: it is derived from these very
// fields (rowIdOfMessage), so once the cid moves over, messageRow re-stamps the
// arriving row to the SAME name it would resolve to anywhere -- carrying the
// incumbent's stale name forward is what the old numeric render id needed and
// what fix-oneid deletes. Content the engine owns (text, growing, seq) is left
// to the arriving row, so a growing claude reply still advances when its later
// frame carries the mid.
// A re-serve of a row already held under the same id: fill the fields the
// arrival lacks from the incumbent, so an update never erases identity a live
// settle established. Carries the client-local facts AND the engine mid /
// dedupeKey (a mid-less echo of an already-mid'd row must not drop the mid).
function mergeReserve(inc: CycEngineMessage, next: CycEngineMessage): void {
  carryClientFields(inc, next);
  if (!next.mid && inc.mid) next.mid = inc.mid;
  if (!next.dedupeKey && inc.dedupeKey) next.dedupeKey = inc.dedupeKey;
}

function carryClientFields(inc: CycEngineMessage, next: CycEngineMessage): void {
  if (!next.cid && inc.cid) next.cid = inc.cid;
  if (!next.msgId && inc.msgId) next.msgId = inc.msgId;
  if (!next.upload && inc.upload) next.upload = inc.upload;
  if (!next.uploads && inc.uploads) next.uploads = inc.uploads;
  if (!next.status && inc.status) next.status = inc.status;
}

// The one place the twin dies: for each arriving mid row not already held under
// its mid id, fold any non-mid incumbent for the same message into it. The
// incumbent's client-local fields move onto the arriving row, the incumbent's
// index tuple and loaded payload are dropped, and its durable id is returned so
// the caller deletes the orphan record. The arriving row then inserts normally
// under its mid id (one row, the incumbent's render id and delivered mark kept).
// Fill the fields a surviving mid incumbent lacks from a mid-less row folding
// INTO it (the reverse fold). The incumbent is the row already projected and
// painted, so its render id and its engine-owned content (text, seq, mid) are
// left untouched; only the local-only facts a settle established and the mid
// copy did not carry (a delivered/sent status, the cid, the upload payload, the
// msgId) move over. Returns whether anything actually changed, so a fold that
// enriches a loaded row can repaint.
function enrichFromMidless(inc: CycEngineMessage, from: CycEngineMessage): boolean {
  let changed = false;
  if (!inc.cid && from.cid) {
    inc.cid = from.cid;
    changed = true;
  }
  if (!inc.msgId && from.msgId) {
    inc.msgId = from.msgId;
    changed = true;
  }
  if (!inc.upload && from.upload) {
    inc.upload = from.upload;
    changed = true;
  }
  if (!inc.uploads && from.uploads) {
    inc.uploads = from.uploads;
    changed = true;
  }
  if (!inc.status && from.status) {
    inc.status = from.status;
    changed = true;
  }
  return changed;
}

// The reverse of rekeyMidlessTwins, killing the twin the OTHER way round: when
// the mid copy of a message landed first (a page admit, or a live echo that
// already carried the mid) and a mid-LESS arrival for the same message follows
// (settleEcho re-settling its send under the fallback id after its pending row
// was already folded, or a second mid-less echo), the arrival folds INTO the
// mid incumbent and inserts NOTHING. This is the idempotent settle the door
// needs: settleEcho whose m:pending:cid row is gone no longer creates a mid-less
// fallback row beside the mid row. Returns the {from,into} pairs (from = the
// arriving id that must never be inserted or persisted) and whether a loaded
// incumbent was enriched (a repaint).
function foldMidlessArrivals(
  m: Mirror,
  rows: StoreRow[]
): {folded: Array<{from: string; into: string}>; changed: boolean; touched: boolean} {
  const folded: Array<{from: string; into: string}> = [];
  let changed = false;
  let touched = false;
  for (const row of rows) {
    const a = row.msg;
    if (row.kind !== 'msg' || !a || a.mid) continue; // only a mid-LESS arrival folds this way
    if (m.idx.some((t) => t.id === row.id)) continue; // an already-held id updates in place
    const intoId = findMidBearingTwin(m, row);
    if (!intoId) continue;
    const inc = m.loaded.get(intoId)?.msg;
    if (inc && enrichFromMidless(inc, a)) {
      changed = true;
      touched = true; // the incumbent is loaded, so its window repaints
    }
    folded.push({from: row.id, into: intoId});
  }
  return {folded, changed, touched};
}

// The DEPLOY-CROSSING fold (fix-oneid, defect 3). The deployed master build
// keyed an own send by its engine mid `m:<mid>`; fix-oneid keys the SAME send by
// its cid `m:c:<cid>`. After the upgrade the restored incumbent sits under the
// old mid key while the first re-serve on attach arrives under the new cid key
// (the re-serve carries BOTH cid and mid), and neither midless fold reconciles
// them (both incumbent and arrival carry a mid), so the arrival would insert a
// twin. Here an arriving cid-keyed row whose mid matches a mid-keyed incumbent is
// recognised as the SAME message under the two spellings: fold the incumbent into
// the arriving row (the new spelling wins the id), carry the incumbent's
// local-only facts per mergeReserve, drop the incumbent, and return its durable
// id so the caller deletes the orphan record. This is belt-and-braces to the
// one-time durable rekey (rekeyDurableRowsToOneId): a row that reaches the store
// by a path that bypassed the migration, or a crash mid-migration, still
// converges to ONE row. Only fires when the incumbent is loaded, so its delivered
// status and cid are preserved rather than lost to a status-less page re-serve.
function foldMidKeyedTwins(m: Mirror, rows: StoreRow[]): string[] {
  const rekeyedFrom: string[] = [];
  for (const row of rows) {
    const a = row.msg;
    if (row.kind !== 'msg' || !a?.cid || !a.mid) continue;
    if (row.id !== `m:c:${a.cid}`) continue; // only a cid-keyed arrival (the new spelling)
    if (m.idx.some((t) => t.id === row.id)) continue; // already held under the cid id
    const oldId = `m:${a.mid}`;
    const at = m.idx.findIndex((t) => t.id === oldId);
    if (at < 0) continue; // no mid-keyed incumbent for this send: nothing to fold
    const inc = m.loaded.get(oldId);
    if (!inc?.msg) continue; // incumbent not loaded: leave it to the durable rekey
    mergeReserve(inc.msg, a);
    if (row.seq < 0 && inc.seq >= 0) {
      row.seq = inc.seq;
      a.seq = inc.seq;
    }
    m.idx.splice(at, 1);
    m.loaded.delete(oldId);
    rekeyedFrom.push(oldId);
  }
  return rekeyedFrom;
}

function rekeyMidlessTwins(m: Mirror, rows: StoreRow[]): string[] {
  // Cheap gate: a twin can only exist when the session already holds a non-mid
  // message row. In the common case (a backfill of rows that all carry mids)
  // this scan finds none and returns at once, so the fold stays linear instead
  // of scanning the whole index once per arriving row.
  let hasMidless = false;
  for (const t of m.idx) {
    if (t.kind === 'msg' && !isMidKeyedId(t.id)) {
      hasMidless = true;
      break;
    }
  }
  if (!hasMidless) return [];
  const rekeyedFrom: string[] = [];
  for (const row of rows) {
    if (row.kind !== 'msg' || !row.msg?.mid) continue;
    if (m.idx.some((t) => t.id === row.id)) continue;
    const twinId = findMidlessTwin(m, row);
    if (!twinId) continue;
    const inc = m.loaded.get(twinId);
    if (inc?.msg && row.msg) carryClientFields(inc.msg, row.msg);
    const at = m.idx.findIndex((t) => t.id === twinId);
    if (at >= 0) m.idx.splice(at, 1);
    m.loaded.delete(twinId);
    rekeyedFrom.push(twinId);
  }
  return rekeyedFrom;
}

// Fold a batch of rows into a mirror, idempotently by durable id. An already
// held tuple is re-seated when its seq moved (a renumber). A loaded payload is
// replaced when the batch touches the window; a below-floor row updates only the
// index and is left for the durable backing (the extend-window read brings its
// payload in later). This is the store's whole dedupe: there is no seen-set,
// because the id IS the identity.
export function upsertMirror(m: Mirror, rows: StoreRow[]): UpsertResult {
  let loSeq = Infinity;
  let hiSeq = -Infinity;
  let changed = false;
  let touchesWindow = false;
  const inserted: string[] = [];
  // Fold a mid row into any non-mid incumbent for the same message FIRST, so the
  // rest of the fold sees the incumbent already retired under the mid id and the
  // arriving row inserts once. This is the twin fix in the mid-arrives-last
  // direction, at the one seam every arrival path funnels through.
  const rekeyedFrom = rekeyMidlessTwins(m, rows);
  // The deploy crossing: an own send restored under the old `m:<mid>` key folds
  // into the arriving `m:c:<cid>` re-serve of the same message (the new spelling
  // wins the id), so the upgrade does not twin every delivered own send.
  for (const oldId of foldMidKeyedTwins(m, rows)) rekeyedFrom.push(oldId);
  // And the reverse: a mid-LESS arrival for a message whose mid copy is already
  // held folds INTO that mid row and inserts nothing (the idempotent settle).
  const rev = foldMidlessArrivals(m, rows);
  const foldedAway = new Set(rev.folded.map((f) => f.from));
  if (rev.changed) changed = true;
  if (rev.touched) touchesWindow = true;
  // THE ONE DOOR REFUSES OFF-AXIS POISON. Once the session already holds
  // engine-axis rows, a message row with NO committed seq (seq < 0) is a stale
  // legacy WALL or a client-ts optimistic bubble that never belongs in the store
  // (the store never holds a user's own pending send). Admitting one is what let
  // a second page's warm mirror, or an overlay writer, seed a seqless id back
  // into the axis and refire the stale-axis heal forever. Refuse it here, at the
  // single seam every write funnels through, and report it so a future writer
  // names itself in the field. A mid-LESS row carrying a valid seq is NOT refused:
  // the engine's own pre-mid chat files re-serve real on-axis history without a
  // mid, and that history must paint. The door has no axis bound in hand, so
  // isPoisonTuple defaults to Infinity and only the seq < 0 shape bites. An
  // already-held id (an in-place update of a row the store legitimately kept
  // before this guard shipped) is left to update.
  const gated = hasEngineAxis(m);
  const refused: string[] = [];
  const refuse = gated
    ? new Set(
        rows
          .filter((row) => isPoisonTuple(tupleOf(row)) && !m.idx.some((t) => t.id === row.id))
          .map((row) => row.id)
      )
    : null;
  if (refuse) for (const id of refuse) refused.push(id);
  const byId = new Map<string, RowTuple>();
  for (const t of m.idx) byId.set(t.id, t);
  // A window is "open" once a floor has been set (openWindow). Before that there
  // is no visible window, so a pre-open backfill write touches nothing and paints
  // nothing; the open reads the tail fresh from the backing.
  const windowOpen = m.floor !== null;
  const oldFloor = m.floor;
  // Per-row bookkeeping, so touchesWindow can be decided against the FINAL window
  // (after the floor rides up), not the window at admit time: a backfill page
  // that lands and is then evicted below the risen boundary must not paint.
  const seenRows: Array<{
    row: StoreRow;
    isNew: boolean;
    payloadChanged: boolean;
    reseated: boolean;
  }> = [];
  for (const row of rows) {
    if (foldedAway.has(row.id)) continue; // folded into a mid incumbent: never inserted
    if (refuse?.has(row.id)) continue; // poison: refused at the door, never inserted
    let t: RowTuple = tupleOf(row);
    const prev = byId.get(row.id);
    let isNew = false;
    let payloadChanged = false;
    let reseated = false;
    if (!prev) {
      insertTuple(m.idx, t);
      byId.set(row.id, t);
      inserted.push(row.id);
      isNew = true;
      changed = true;
    } else {
      // A re-serve of a held row is found by its one durable id, so the arriving
      // row already carries the same name the incumbent does (rowIdOfMessage is
      // lifetime-invariant); the incremental renderer reuses the painted node by
      // that shared data-mid with no scroll jump or photo re-decode. No id is
      // copied across -- the id IS the identity now, not a per-load render number.
      const hadRow = m.loaded.get(row.id);
      // Merge the incumbent's facts into an arriving re-serve of the SAME id,
      // never a wholesale replace. With cid-keyed own sends a live echo, a page
      // re-serve and a second mid-less echo all land under the one `m:c:<cid>`
      // id, so the update must not let a payload that happens to lack a field
      // erase it: the incumbent's client-local facts (a delivered/sent status,
      // the cid, the upload, the msgId), its engine mid, and its committed seq
      // are all kept when the arrival does not carry them. Engine-owned CONTENT
      // the arrival DOES carry (text, a real mid, a real seq, growing) wins, so a
      // renumber still re-seats and a growing reply still advances.
      if (row.kind === 'msg' && row.msg && hadRow?.msg) {
        mergeReserve(hadRow.msg, row.msg);
        if (row.seq < 0 && prev.seq >= 0) {
          row.seq = prev.seq;
          row.msg.seq = prev.seq;
        }
        t = tupleOf(row);
      }
      if (prev.seq !== row.seq || prev.ts !== row.ts) {
        // re-seat in the ordered index
        const at = m.idx.findIndex((x) => x.id === row.id);
        if (at >= 0) m.idx.splice(at, 1);
        insertTuple(m.idx, t);
        byId.set(row.id, t);
        reseated = true;
        changed = true;
      }
      if (hadRow && !samePayload(hadRow, row)) {
        payloadChanged = true;
        changed = true;
      }
    }
    seenRows.push({row, isNew, payloadChanged, reseated});
    if (row.seq >= 0) {
      if (row.seq < loSeq) loSeq = row.seq;
      if (row.seq > hiSeq) hiSeq = row.seq;
    }
  }
  // THE WINDOW BOUND (defect 3): once the index would carry more than windowSize
  // rows, the floor rides up to the newest-windowSize boundary, so the projected
  // window stays bounded and a below-boundary backfill page neither paints nor
  // grows the projection, no matter that the open began on an empty store with a
  // floor of 0. Suspended while the chat is scrolled up (extended): the user's
  // older reach is deliberate and a live/backfill write must not trim it.
  let floor = oldFloor;
  if (windowOpen && !m.extended && m.windowSize > 0 && m.idx.length > m.windowSize) {
    const boundary = newestWindowFloor(m, m.windowSize);
    if (aboveFloor(boundary, floor)) floor = boundary;
  }
  m.floor = floor;
  // Load the payloads of the rows that ended up IN the final window and decide
  // touchesWindow from that window alone.
  for (const {row, isNew, payloadChanged, reseated} of seenRows) {
    const rowInWindow = windowOpen && tupleInWindow(tupleOf(row), floor);
    if (!rowInWindow) continue;
    const had = m.loaded.has(row.id);
    m.loaded.set(row.id, row);
    if (isNew || payloadChanged || reseated || !had) {
      touchesWindow = true;
      changed = true;
    }
  }
  // Evict any loaded row (from this batch or an earlier one) that now sits below
  // the risen boundary IN THE TS ORDER, so the loaded window never exceeds
  // windowSize. A row that is newer by ts but carries a lower (reused) seq is at
  // or above the floor tuple and is kept: eviction removes only rows strictly
  // below the window in true time.
  if (windowOpen && floor && aboveFloor(floor, oldFloor)) {
    for (const t of m.idx) if (t.seq >= 0 && cmpTuple(t, floor) < 0) m.loaded.delete(t.id);
  }
  return {
    loSeq: loSeq === Infinity ? -1 : loSeq,
    hiSeq: hiSeq === -Infinity ? -1 : hiSeq,
    changed,
    touchesWindow,
    inserted,
    rekeyedFrom,
    foldedInto: rev.folded,
    refused
  };
}

// A shallow identity of a row's payload, enough to tell an idempotent re-serve
// (same facts) from a real edit (new text, a delivery tick, a duration).
function samePayload(a: StoreRow, b: StoreRow): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'event') {
    const x = a.event!;
    const y = b.event!;
    return x.text === y.text && x.kind === y.kind && x.ts === y.ts;
  }
  const x = a.msg!;
  const y = b.msg!;
  return (
    x.text === y.text &&
    x.ts === y.ts &&
    x.status === y.status &&
    x.queued === y.queued &&
    (x as {growing?: boolean}).growing === (y as {growing?: boolean}).growing &&
    x.durationS === y.durationS &&
    x.transcriptPending === y.transcriptPending
  );
}

// The highest / lowest committed seq the store holds. The index is ordered by ts
// (cmpTuple), NOT by seq, so the last tuple in the index is the newest row, not
// the largest seq: the replicator asks the engine for rows newer than heldTail,
// so this must be the true MAX seq, scanned in full. A legacy log whose newest
// row carries a reused low seq would otherwise under-report the tail and re-pull
// rows already held (idempotent, but wasteful); the scan keeps the contract exact.
export function highestSeq(m: Mirror): number {
  let hi = -1;
  for (const t of m.idx) if (t.seq > hi) hi = t.seq;
  return hi;
}

export function lowestSeq(m: Mirror): number {
  let lo = Infinity;
  for (const t of m.idx) if (t.seq >= 0 && t.seq < lo) lo = t.seq;
  return lo;
}

// True when the index holds rows below the loaded floor IN THE TS ORDER: the
// window can be extended from the durable backing before the replicator is
// needed.
export function hasMoreBelow(m: Mirror): boolean {
  if (!m.floor) return false;
  return m.idx.some((t) => t.seq >= 0 && cmpTuple(t, m.floor!) < 0);
}

// The seq at the window floor (the oldest in-window row's committed seq), for the
// callers that still speak seq: the replicator's older-page demand hint and the
// blank-window field log. Infinity when unfloored; 0 when the window covers
// everything (floored on WINDOW_FLOOR_ALL). On a reset-bearing log the axis is
// ts, so this is only a hint, not a membership test.
export function floorSeqOf(m: Mirror): number {
  if (!m.floor) return Infinity;
  if (m.floor.seq >= 0 && Number.isFinite(m.floor.ts)) return m.floor.seq;
  return 0;
}

// The index position where a window holding the newest `size` MESSAGE rows
// begins. Walks the ordered index from the tail toward the front, counting only
// message tuples (anchorsOpenWindow), and stops once `size` of them are in the
// span. Session events interleaved among or above them (records AND the
// pill-paintable prompt/reply/tool kinds alike) are KEPT in the span (the window
// stays a contiguous seq range, so paging and the projection see no gaps) but
// never count toward `size`, so an event-dense tail can no longer wall the
// window off the messages. When the session holds fewer than `size` messages the
// span is the whole index (a short session shows everything). When it holds NO
// messages, the span falls back to the newest `size` raw rows, so an events-only
// session (a cron, a pure agent log) still opens on its tail instead of on
// nothing.
export function newestWindowStart(m: Mirror, size: number): number {
  let count = 0;
  let start = -1;
  for (let i = m.idx.length - 1; i >= 0; i--) {
    if (!anchorsOpenWindow(m.idx[i])) continue;
    count++;
    start = i;
    if (count >= size) break;
  }
  return start < 0 ? Math.max(0, m.idx.length - size) : start;
}

// The durable ids of the newest window: the payloads a chat opens on. The span
// is anchored on the newest `size` MESSAGE rows (newestWindowStart), so the open
// window always carries the conversation's own bubbles even when the newest raw
// seqs are session events.
export function newestWindowIds(m: Mirror, size: number): string[] {
  return m.idx.slice(newestWindowStart(m, size)).map((t) => t.id);
}

// The floor TUPLE for a window holding the newest `size` MESSAGE rows: the oldest
// tuple (by ts) that window includes (the exact slice boundary, so window ==
// idx.slice(from)), so a caller can set it as the floor once the payloads are
// loaded. Anchored on the newest `size` MESSAGE rows, so the floor drops below an
// event tail to the newest real messages. WINDOW_FLOOR_ALL only when the index is
// EMPTY (a cold open on an empty store), so that floor still admits the tail an
// admit brings in before the bound rides up.
export function newestWindowFloor(m: Mirror, size: number): RowTuple {
  const from = newestWindowStart(m, size);
  return m.idx[from] ?? WINDOW_FLOOR_ALL;
}

// The ids of up to `size` rows strictly below the current floor: what a window
// extension loads. Ascending order.
export function olderWindowIds(m: Mirror, size: number): string[] {
  const out: string[] = [];
  if (!m.floor) return out;
  for (let i = m.idx.length - 1; i >= 0; i--) {
    const t = m.idx[i];
    if (t.seq < 0 || cmpTuple(t, m.floor) >= 0) continue;
    out.push(t.id);
    if (out.length >= size) break;
  }
  out.reverse();
  return out;
}

// Build the messages and events arrays the renderer reads from the loaded
// payloads, each in ascending seq/ts order.
export function project(
  m: Mirror,
  onRepair?: (info: {at: number; before: RowTuple; after: RowTuple}) => void
): {messages: CycEngineMessage[]; events: CycSessionEvent[]} {
  const messages: CycEngineMessage[] = [];
  const events: CycSessionEvent[] = [];
  for (const t of m.idx) {
    const row = m.loaded.get(t.id);
    if (!row) continue;
    if (row.kind === 'msg' && row.msg) messages.push(row.msg);
    else if (row.kind === 'event' && row.event) events.push(row.event);
  }
  if (onRepair) {
    const tuples = m.idx.filter((t) => m.loaded.has(t.id));
    const at = tuples.findIndex((t, i) => i > 0 && m.loaded.get(t.id)!.ts < m.loaded.get(tuples[i - 1].id)!.ts);
    if (at > 0) onRepair({at, before: tuples[at - 1], after: tuples[at]});
  }
  return {messages: inTimeOrder(messages), events: inTimeOrder(events)};
}

// The chat reads oldest to newest by the time each row carries, whatever order
// the index holds them in: two devices painted August rows after today's
// (2026-09-24). A stable sort, so equal times keep the index's order; a no-op
// (same array) when already in order.
export function inTimeOrder<T extends {ts: number}>(rows: T[]): T[] {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].ts < rows[i - 1].ts) {
      return rows
        .map((r, j) => ({r, j}))
        .sort((a, b) => a.r.ts - b.r.ts || a.j - b.j)
        .map((x) => x.r);
    }
  }
  return rows;
}
