// The conversation store's durable layer and warm mirrors. The one door every
// row enters by: live incoming messages, history backfill, and the user's own
// sends all reach the screen ONLY after they land here, keyed by durable id.
// Nothing on the wire paints; a wire event upserts a row, and the store, if the
// write touched the open chat's visible window, tells the UI to re-query and
// repaint. A write below the window updates the durable index and the payload
// backing and paints nothing.
//
// The physical layout stays on the exact IndexedDB surface the test fakes
// emulate (get/getAll/put/delete/clear/getAllKeys), so the rules are unit-tested
// without a browser database, the same way history.ts and blobStore.ts are:
//   - one row payload per record, key `<sid>|r|<id>`
//   - one seq-index record per session, key `<sid>|idx` (lightweight tuples)
//   - one meta record per session, key `<sid>|meta` (the replicator's cursor)

import {cyclog} from '@/shared/logging';
import type {CycEngineMessage} from '../types';
import type {CycSessionEvent} from '../../../types';
import {
  cmpTuple,
  emptyMirror,
  floorSeqOf,
  hasEngineAxis,
  hasMoreBelow,
  highestSeq,
  inWindow,
  isPoisonTuple,
  newestWindowFloor,
  newestWindowIds,
  olderWindowIds,
  project,
  rowIdOfMessage,
  upsertMirror,
  WINDOW_FLOOR_ALL,
  type Mirror,
  type RowTuple,
  type StoreRow,
  type UpsertResult
} from './core';

export type SessionMeta = {
  sessionId: string;
  cursor: number;
  tailVersion: number;
  tailPage: number;
  coveredFrom: number;
  pageSize: number;
  total: number;
  syncedAt: number;
};

// The transaction runner over the single `rows` store, resolving the request
// result once the transaction completes (null when it did not). The default is
// the real cyc-rows database; a test injects an in-memory runner.
export type Tx = <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
) => Promise<T | null>;

const DB_NAME = 'cyc-rows';
const DB_VERSION = 1;
const STORE = 'rows';

let db: IDBDatabase | null = null;
let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (db) return Promise.resolve(db);
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, {keyPath: 'key'});
      }
    };
    req.onsuccess = () => {
      db = req.result;
      db.onversionchange = () => {
        db?.close();
        db = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return opening;
}

// A readonly read resolves as soon as its request result is ready (onsuccess):
// a read cannot be rolled back, so waiting for the transaction to complete only
// adds latency to the hot open-window path. A readwrite transaction resolves
// ONLY when the transaction COMMITS (oncomplete), never when the last request
// merely succeeds (onsuccess), and REJECTS when it aborts. On iOS Safari a page
// frozen on a swipe-out ABORTS an uncommitted readwrite transaction, and every
// write in it rolls back; resolving on onsuccess reported the writes durable
// microseconds before they vanished, which is exactly how the stale-axis purge
// deleted the poisoned rows on the phone and then had them resurrected on the
// next attach (the heal that never stuck). oncomplete is what makes an awaited
// write TRUE. Every fire-and-forget write (via fireWrite) still fires; only the
// awaited multi-write transactions (purge) act on the commit/abort answer.
const realTx: Tx = <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> =>
  openDb().then((d) => {
    if (!d) return null;
    return new Promise<T | null>((resolve, reject) => {
      let tx: IDBTransaction;
      let req: IDBRequest<T>;
      try {
        tx = d.transaction(STORE, mode);
        req = run(tx.objectStore(STORE));
      } catch {
        resolve(null);
        return;
      }
      if (mode === 'readonly') {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        return;
      }
      let result: T | null = null;
      req.onsuccess = () => {
        result = req.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(new Error('tx-abort'));
      tx.onerror = () => reject(new Error('tx-error'));
    });
  });

let backing: Tx = realTx;

// A fire-and-forget durable write, like history.writePage: a lost write is
// re-served on the next attach, so the caller never awaits it. A readwrite
// transaction now REJECTS on abort (an iOS page-freeze rollback), so swallow
// that rejection here rather than let a `void backing(...)` surface an
// unhandled rejection; the write is simply lost and re-served, exactly the
// pre-existing contract. Only the awaited multi-write paths (purge) act on the
// abort.
function fireWrite(run: (store: IDBObjectStore) => IDBRequest): void {
  backing('readwrite', run).catch(() => {});
}

// Test seam: swap the durable backing for an in-memory runner and drop every
// warm mirror, so each test starts from an empty store.
export function __setBackingForTest(tx: Tx | null): void {
  backing = tx ?? realTx;
  mirrors.clear();
  metaCache.clear();
  idxLoaded.clear();
  openSid = null;
}

// Close the durable cyc-rows connection and drop every warm mirror, for a full
// cache clear. deleteDatabase resolves on onblocked, so a delete of cyc-rows
// silently no-ops while this store's persistent connection stays open; the
// caller (clearCachedData) must call this BEFORE the delete or it blocks on the
// very page that pressed the button. The open chat also stops painting from the
// now-dead warm mirror. The store is left able to lazily reopen: openDb rebuilds
// the connection on the next access.
export function closeForClear(): void {
  try {
    db?.close();
  } catch {}
  db = null;
  opening = null;
  mirrors.clear();
  metaCache.clear();
  idxLoaded.clear();
  openSid = null;
}

const rowKey = (sid: string, id: string) => `${sid}|r|${id}`;
const idxKey = (sid: string) => `${sid}|idx`;
const metaKey = (sid: string) => `${sid}|meta`;

type IdxRecord = {key: string; sessionId: string; tuples: RowTuple[]};
type RowRecord = StoreRow & {key: string};

// Warm mirrors, one per session the store is actively holding (the open chat and
// any session the replicator is filling). A cold session keeps nothing here.
const mirrors = new Map<string, Mirror>();
const metaCache = new Map<string, SessionMeta>();
const idxLoaded = new Set<string>();

let openSid: string | null = null;

type ChangeCb = (sessionId: string, loSeq: number, hiSeq: number) => void;
const changeSubs = new Set<ChangeCb>();

// The UI's one subscription seam: called when an upsert touches the OPEN chat's
// visible window. store.ts re-queries the window and repaints; a below-window
// backfill never reaches here, so it never paints (invariant 1 and 4).
export function onChange(cb: ChangeCb): () => void {
  changeSubs.add(cb);
  return () => changeSubs.delete(cb);
}

function fireChange(sessionId: string, loSeq: number, hiSeq: number): void {
  for (const cb of changeSubs) {
    try {
      cb(sessionId, loSeq, hiSeq);
    } catch {}
  }
}

// The open chat: only this session's window-touching writes paint.
export function setOpen(sessionId: string | null): void {
  openSid = sessionId;
}

export function isOpen(sessionId: string): boolean {
  return openSid === sessionId;
}

// The newest-window size a cold open floors on when an admit beats openWindow.
// Matches door.WINDOW; kept local so rowStore stays free of the door import.
const OPEN_WINDOW = 300;

// A window is "open" the instant a chat attaches (setOpen), but its FLOOR is not
// established until openWindow reads the tail. On a cold open the engine's served
// tail can be admitted in the gap between setOpen and openWindow: the settled
// edge asks the engine independently of the open's deferred window read, so the
// attach-ok's admit can land while the mirror is still unfloored (floorSeq
// Infinity). upsertMirror then treats that admit as PRE-open (windowOpen false):
// the rows enter the index but never the loaded window, and the later window
// read races the not-yet-committed fire-and-forget durable writes and projects
// EMPTY, with nothing left to recover it (the cold-open blank chat). So an admit
// to the OPEN session floors an empty window HERE first, exactly what openWindow
// does for an empty store, so the served tail lands in the loaded window and its
// onChange repaint reaches the fresh window at once. A write to a session that is
// NOT open is untouched: it stays pre-open and paints nothing.
function floorOpenWindow(sessionId: string, m: Mirror): void {
  if (openSid !== sessionId || m.floor) return;
  m.floor = WINDOW_FLOOR_ALL;
  if (m.windowSize <= 0) m.windowSize = OPEN_WINDOW;
}

async function ensureIdx(sessionId: string): Promise<Mirror> {
  let m = mirrors.get(sessionId);
  if (m && idxLoaded.has(sessionId)) return m;
  if (!m) {
    m = emptyMirror();
    mirrors.set(sessionId, m);
  }
  const rec = await backing<IdxRecord>('readonly', (s) => s.get(idxKey(sessionId)) as IDBRequest);
  if (rec && Array.isArray(rec.tuples)) m.idx = rec.tuples;
  idxLoaded.add(sessionId);
  sanitizeOnRead(sessionId, m);
  return m;
}

// A durable idx this page just loaded can carry a POISONED axis another page
// wrote back: a second tab on the same profile never purged its warm mirror, so
// its fire-and-forget idx write clobbered the durable record with its stale
// legacy rows, and this page reads them straight back after its own heal (the
// resurrect loop the field hit, refiring on every re-open). When the loaded axis
// holds genuine engine-axis rows AND OFF-AXIS poison tuples, the poison can only
// be that stale write-back, so drop it here on the read and rewrite the durable
// idx clean, so the heal converges instead of refiring. isPoisonTuple is called
// with no axis bound here (a read has none in hand), so it drops only the seqless
// shape (seq < 0) and never an on-axis mid-less row, which is real engine history
// the sanitise must keep. When the whole session is still legacy (no engine-axis
// row yet) the rows are left untouched: dropping them would blank the chat before
// the heal serves a tail (staleRowReason then drives the purge-and-resync).
function sanitizeOnRead(sessionId: string, m: Mirror): void {
  if (!hasEngineAxis(m)) return;
  const clean = m.idx.filter((t) => !isPoisonTuple(t));
  if (clean.length === m.idx.length) return;
  const dropped = m.idx.length - clean.length;
  for (const t of m.idx) if (isPoisonTuple(t)) m.loaded.delete(t.id);
  m.idx = clean;
  cyclog('rowstore.axis.sanitized', {session: sessionId, dropped});
  fireWrite((s) => s.put({key: idxKey(sessionId), sessionId, tuples: m.idx} satisfies IdxRecord));
}

async function loadPayloads(sessionId: string, m: Mirror, ids: string[]): Promise<void> {
  const want = ids.filter((id) => !m.loaded.has(id));
  if (!want.length) return;
  // The window's payloads are read in one parallel batch, not one blocking round
  // trip per row, so opening a chat is a single burst of indexed gets.
  const recs = await Promise.all(
    want.map((id) =>
      backing<RowRecord>('readonly', (s) => s.get(rowKey(sessionId, id)) as IDBRequest)
    )
  );
  recs.forEach((rec, i) => {
    if (rec) m.loaded.set(want[i], stripKey(rec));
  });
}

function stripKey(rec: RowRecord): StoreRow {
  const {key: _key, ...row} = rec;
  void _key;
  return row;
}

// Open a chat: load the newest `size` rows into the mirror and return the
// messages/events the renderer paints. One indexed read of the tail, offline or
// online, cold or warm. The network is not consulted.
export async function openWindow(
  sessionId: string,
  size: number
): Promise<{messages: CycEngineMessage[]; events: CycSessionEvent[]}> {
  const m = await ensureIdx(sessionId);
  // A warm mirror ensureIdx returned without re-reading (the migration that just
  // imported this session, or a live hold) can still carry a poisoned axis; the
  // first paint after open must show the engine tail, never the walled Aug
  // tail. Sanitising here (a no-op once the axis is clean) keeps the open-window
  // invariant independent of whether the read was cold or warm.
  sanitizeOnRead(sessionId, m);
  const ids = newestWindowIds(m, size);
  // Keep the payloads already in memory for rows still in the window, and drop
  // only the ones that fell out of it. Clearing the whole set and re-reading it
  // from the durable backing loses any row that was just upserted in memory but
  // whose fire-and-forget durable write has not committed yet (a heal's freshly
  // admitted tail): that read raced and the window projected empty. loadPayloads
  // then only fetches the ids not already held.
  const keep = new Set(ids);
  for (const id of [...m.loaded.keys()]) if (!keep.has(id)) m.loaded.delete(id);
  await loadPayloads(sessionId, m, ids);
  m.floor = newestWindowFloor(m, size);
  // Anchor the window at the tail: remember the bound so a later backfill write
  // rides the floor up to the newest-`size` boundary (never grows past it), and
  // clear the scrolled-up flag a previous extendWindow set (a fresh open, or a
  // resnap, re-anchors on the tail).
  m.windowSize = size;
  m.extended = false;
  return projectChecked(sessionId, m);
}

// Extend the window upward from the store: load the next `size` older rows.
// `dry` is true when the index holds nothing more below the floor, so the caller
// hints the replicator to pull that range; the hint moves the replicator, never
// the screen.
export async function extendWindow(
  sessionId: string,
  size: number
): Promise<{messages: CycEngineMessage[]; events: CycSessionEvent[]; dry: boolean}> {
  const m = await ensureIdx(sessionId);
  const ids = olderWindowIds(m, size);
  if (!ids.length) {
    return {...projectChecked(sessionId, m), dry: true};
  }
  await loadPayloads(sessionId, m, ids);
  // The new floor is the OLDEST row just loaded (olderWindowIds returns ascending
  // ts order, and every id it returned is strictly below the old floor), so drop
  // the floor tuple to it.
  const oldestId = ids[0];
  const at = m.idx.findIndex((t) => t.id === oldestId);
  const newFloor = at >= 0 ? m.idx[at] : null;
  if (newFloor && (!m.floor || cmpTuple(newFloor, m.floor) < 0)) {
    m.floor = newFloor;
    // The user reached below the tail-anchored boundary on purpose: suspend the
    // window bound so a live or backfill write does not trim the older rows now
    // on screen back to the newest windowSize.
    m.extended = true;
  }
  return {...projectChecked(sessionId, m), dry: !hasMoreBelow(m)};
}

// The display is always put in time order (core inTimeOrder); when the index
// disagreed, say so once per session per page so the cause can be traced.
const orderReported = new Set<string>();
function projectChecked(sessionId: string, m: Mirror) {
  return project(m, ({at, before, after}) => {
    if (orderReported.has(sessionId)) return;
    orderReported.add(sessionId);
    const brief = (t: RowTuple) => {
      const r = m.loaded.get(t.id);
      return JSON.stringify({id: t.id.slice(0, 40), tupleTs: t.ts, rowTs: r?.ts ?? null, seq: t.seq, kind: t.kind});
    };
    cyclog('rows.order.repaired', {session: sessionId, at, idx: m.idx.length, before: brief(before), after: brief(after)});
  });
}

export function projection(sessionId: string): {
  messages: CycEngineMessage[];
  events: CycSessionEvent[];
} {
  const m = mirrors.get(sessionId);
  return m ? projectChecked(sessionId, m) : {messages: [], events: []};
}

export function windowHasMoreBelow(sessionId: string): boolean {
  const m = mirrors.get(sessionId);
  return m ? hasMoreBelow(m) : false;
}

// The lowest seq currently loaded in the open window (its floor), so loadOlder
// can hint the replicator for the page just below it. Infinity when nothing is
// loaded.
export function windowFloorSeq(sessionId: string): number {
  const m = mirrors.get(sessionId);
  return m ? floorSeqOf(m) : Infinity;
}

// The highest committed seq the store holds for a session (its warm tail), so a
// re-attach can ask the engine only for rows newer than what is already stored.
// -1 when nothing committed is held (a cold session asks for the whole tail).
export function highestHeldSeq(sessionId: string): number {
  const m = mirrors.get(sessionId);
  if (!m) return -1;
  return highestSeq(m);
}

// Inspect the warm mirror for rows that make the local seq axis stale and demand
// a purge-and-resync from the engine (see repl.resetIfStaleAxis). Two shapes, on
// top of a held tail sitting above the engine's axis:
//   - a row with seq < 0: a migrated legacy row that never carried a seq. seq
//     < 0 sorts at the tail (Infinity), so these rows WALL the newest window and
//     the pending zone, and the chat renders EMPTY.
//   - a mid-less message row (its durable id fell back to `m@ts|role|text`) that
//     sorts ABOVE the engine tail: a migrated older/longer axis whose rows TWIN
//     and outrank the real tail. A mid-less row AT or BELOW the tail is NOT
//     stale: the engine's own pre-mid chat files re-serve genuine on-axis history
//     without a mid, and healing it would purge real data and refire forever.
// `axisBound` is the engine tail version known at the attach (resetIfStaleAxis
// has it in hand); a caller with no axis passes none (Infinity), so only the
// unseqed shape trips. Store rows are never the user's own local pending sends
// (those live only on the s.messages overlay, never here). null means clean.
// Reads the warm index only, no IDB.
export function staleRowReason(sessionId: string, axisBound = Infinity): string | null {
  const m = mirrors.get(sessionId);
  if (!m) return null;
  for (const t of m.idx) {
    if (t.seq < 0) return 'unseqed-legacy-row';
    if (t.kind === 'msg' && t.id.startsWith('m@') && t.seq > axisBound) return 'midless-legacy-row';
  }
  return null;
}

// Drop a single row (a withdrawn pending send) from the warm mirror and the
// durable backing. Repaints the open chat if the row was in its window.
export function dropRow(sessionId: string, id: string): void {
  const m = mirrors.get(sessionId);
  if (m) {
    const at = m.idx.findIndex((t) => t.id === id);
    const had = m.loaded.has(id);
    if (at >= 0) m.idx.splice(at, 1);
    m.loaded.delete(id);
    fireWrite((s) => s.put({key: idxKey(sessionId), sessionId, tuples: m.idx} satisfies IdxRecord));
    if (openSid === sessionId && had) fireChange(sessionId, -1, -1);
  }
  fireWrite((s) => s.delete(rowKey(sessionId, id)));
}

// Persist the durable side of an upsert, shared by the async and sync doors:
// the payloads (fire-and-forget like history.writePage, a lost write is
// re-served on the next attach), then the seq index. Any twin the door folded
// into an arriving mid row leaves a stale record under its old id, and any
// mid-less arrival the reverse fold merged INTO a mid incumbent must never be
// persisted (it was never inserted); both are deleted so a merged-away row
// cannot re-load later, and the enriched incumbent is re-persisted.
function persistUpsert(sessionId: string, m: Mirror, rows: StoreRow[], res: UpsertResult): void {
  const foldedAway = new Set(res.foldedInto.map((f) => f.from));
  const refused = new Set(res.refused);
  for (const row of rows) {
    if (foldedAway.has(row.id)) continue;
    if (refused.has(row.id)) continue; // poison the door refused: never persisted
    fireWrite((s) => s.put({...row, key: rowKey(sessionId, row.id)}));
  }
  for (const oldId of res.rekeyedFrom) {
    fireWrite((s) => s.delete(rowKey(sessionId, oldId)));
  }
  for (const {from, into} of res.foldedInto) {
    fireWrite((s) => s.delete(rowKey(sessionId, from)));
    const inc = m.loaded.get(into);
    if (inc) fireWrite((s) => s.put({...inc, key: rowKey(sessionId, into)}));
  }
  fireWrite((s) => s.put({key: idxKey(sessionId), sessionId, tuples: m.idx} satisfies IdxRecord));
}

// One cyclog line per row the door refused (isPoisonTuple, once the session
// holds engine-axis rows), tagged with the caller so a future writer that tries
// to seed a poisoned id names itself in the field instead of hiding behind the
// store.
function logRefused(sessionId: string, res: UpsertResult, tag: string): void {
  for (const id of res.refused) {
    cyclog('rowstore.write.refused', {session: sessionId, id, caller: tag});
  }
}

// The one write. Fold the rows into the mirror (idempotent by durable id),
// persist the payloads and the seq-index, and, when the write touched the open
// chat's window, tell the UI. Returns the seq range touched and whether the
// open window changed, for the replicator's cursor and the flood tests.
export async function upsert(
  sessionId: string,
  rows: StoreRow[],
  tag = 'wire'
): Promise<{loSeq: number; hiSeq: number; changed: boolean; touchesWindow: boolean}> {
  if (!rows.length) return {loSeq: -1, hiSeq: -1, changed: false, touchesWindow: false};
  const m = await ensureIdx(sessionId);
  floorOpenWindow(sessionId, m);
  const res = upsertMirror(m, rows);
  persistUpsert(sessionId, m, rows, res);
  logRefused(sessionId, res, tag);
  const paints = openSid === sessionId && res.touchesWindow && res.changed;
  if (paints) fireChange(sessionId, res.loSeq, res.hiSeq);
  return {
    loSeq: res.loSeq,
    hiSeq: res.hiSeq,
    changed: res.changed,
    touchesWindow: res.touchesWindow
  };
}

// Rewrite a single row's payload in place (a delivery tick, a transcript fill on
// an already loaded bubble) without changing its seq. Goes through upsert so the
// window/paint rule is one path.
export async function patchRow(sessionId: string, row: StoreRow): Promise<void> {
  await upsert(sessionId, [row]);
}

// True when the session's mirror is loaded (the open chat, or a session the
// replicator is filling): the synchronous door can run without an IDB read.
export function isWarm(sessionId: string): boolean {
  return idxLoaded.has(sessionId);
}

// The synchronous door for a warm session (the open chat's live path and the
// user's own sends): fold the rows into the mirror now, persist and paint the
// same way upsert does, but without awaiting the index load. Returns null when
// the session is not warm, so the caller falls back to the async door.
export function upsertSync(
  sessionId: string,
  rows: StoreRow[],
  tag = 'wire'
): {loSeq: number; hiSeq: number; changed: boolean; touchesWindow: boolean} | null {
  const m = mirrors.get(sessionId);
  if (!m || !idxLoaded.has(sessionId)) return null;
  floorOpenWindow(sessionId, m);
  const res = upsertMirror(m, rows);
  persistUpsert(sessionId, m, rows, res);
  logRefused(sessionId, res, tag);
  if (openSid === sessionId && res.touchesWindow && res.changed) {
    fireChange(sessionId, res.loSeq, res.hiSeq);
  }
  return {
    loSeq: res.loSeq,
    hiSeq: res.hiSeq,
    changed: res.changed,
    touchesWindow: res.touchesWindow
  };
}

// A message row held in the warm window by its cid (one of this app's own
// pending sends). Used by the door to settle an echo into the pending bubble.
export function findMsgByCid(sessionId: string, cid: string): StoreRow | undefined {
  const m = mirrors.get(sessionId);
  if (!m) return undefined;
  for (const row of m.loaded.values()) {
    if (row.kind === 'msg' && row.msg && (row.msg as {cid?: string}).cid === cid) return row;
  }
  return undefined;
}

// Rekey a row from a provisional id to its durable engine id, dropping any
// provisional record and folding into an already-held row when the echo also
// arrived by page. With cid-keyed own sends the provisional and durable names
// are the same string (`m:c:<cid>`), so this is usually a plain upsert; it stays
// as the one seam that retires a stale provisional record. No id is carried
// across: next already carries its one durable name from messageRow.
export function rekey(sessionId: string, oldId: string, next: StoreRow): void {
  const m = mirrors.get(sessionId);
  if (m) {
    // drop the provisional row from index and loaded set
    const at = m.idx.findIndex((t) => t.id === oldId);
    if (at >= 0) m.idx.splice(at, 1);
    m.loaded.delete(oldId);
  }
  fireWrite((s) => s.delete(rowKey(sessionId, oldId)));
  if (isWarm(sessionId)) upsertSync(sessionId, [next]);
  else void upsert(sessionId, [next]);
}

export async function readMeta(sessionId: string): Promise<SessionMeta | null> {
  const cached = metaCache.get(sessionId);
  if (cached) return cached;
  const rec = await backing<SessionMeta & {key: string}>(
    'readonly',
    (s) => s.get(metaKey(sessionId)) as IDBRequest
  );
  if (!rec || typeof rec.cursor !== 'number') return null;
  const {key: _k, ...meta} = rec;
  void _k;
  metaCache.set(sessionId, meta);
  return meta;
}

export function writeMeta(meta: SessionMeta): void {
  metaCache.set(meta.sessionId, meta);
  fireWrite((s) => s.put({...meta, key: metaKey(meta.sessionId)}));
}

// The cached meta without an IDB read (whatever readMeta last loaded or writeMeta
// last set), for a persist that wants to keep a field it does not itself own.
export function metaSnapshot(sessionId: string): SessionMeta | undefined {
  return metaCache.get(sessionId);
}

// Evict a cold session's warm mirror. The durable rows and index stay; the next
// open reloads the window from them.
export function close(sessionId: string): void {
  if (openSid === sessionId) return;
  mirrors.delete(sessionId);
  idxLoaded.delete(sessionId);
}

// Test/inspection: the loaded projection and index size without going through a
// window open.
export function __mirror(sessionId: string): Mirror | undefined {
  return mirrors.get(sessionId);
}

// How many message rows the session holds ABOVE and BELOW the open window's
// floor, read from the warm index alone (no payload load, no IDB). The open
// chat's projection paints the messages at or above the floor; a non-zero
// belowFloor while the window projects none is the signature of the cold-open
// blank chat (the conversation is held but the window floored above it), which
// door.ts logs once so the field names it instead of showing a silent blank.
export function messageWindowSplit(sessionId: string): {inWindow: number; belowFloor: number} {
  const m = mirrors.get(sessionId);
  if (!m) return {inWindow: 0, belowFloor: 0};
  let inWin = 0;
  let belowFloor = 0;
  for (const t of m.idx) {
    if (t.kind !== 'msg') continue;
    if (inWindow(m, t)) inWin++;
    else belowFloor++;
  }
  return {inWindow: inWin, belowFloor};
}

// Drop everything for a session: the warm mirror, the cursor/meta cache, and
// every durable record (row payloads, the seq index, and the meta) keyed under
// the session. The durable deletes run in ONE transaction that this awaits AND
// resolves on transaction.oncomplete, so when purge returns true the backing
// truly COMMITTED the deletes and a caller can admit a fresh tail without the
// old axis racing back.
//
// The first version deleted each key in its OWN fire-and-forget transaction and
// returned before any committed; the next re-loaded the mirror from an index
// that had not been deleted yet and the stale axis came right back. Awaiting one
// transaction is what made the heal STICK on a well-behaved device. But on iOS
// Safari the page is FROZEN the instant the owner swipes the app away, and an
// uncommitted readwrite transaction then ABORTS: every delete rolls back and the
// poisoned axis is resurrected on the next attach (the phone's non-sticking
// purge). Now the deletes resolve on commit, and an abort REJECTS: on an abort
// this returns false with the warm state INTACT (the mirror is evicted only
// AFTER the commit), so the heal treats the session as NOT purged, leaves the
// existing rows on screen, and lets the detector re-fire and redo the purge once
// a transaction commits (the heal is idempotent).
export async function purge(sessionId: string): Promise<boolean> {
  const keys = await backing<IDBValidKey[]>('readonly', (s) => s.getAllKeys() as IDBRequest);
  const prefix = `${sessionId}|`;
  const mine = Array.isArray(keys)
    ? keys.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix))
    : [];
  if (mine.length) {
    try {
      await backing('readwrite', (s) => {
        let last: IDBRequest = s.delete(mine[0]);
        for (let i = 1; i < mine.length; i++) last = s.delete(mine[i]);
        return last;
      });
    } catch {
      // The delete transaction ABORTED (an iOS page-freeze rolled it back): the
      // durable rows are fully intact, so leave the warm mirror in place too and
      // report the purge as not done.
      return false;
    }
  }
  // Committed (or nothing durable to delete): now it is safe to drop the warm
  // state, so the next open reloads the truly-empty durable side.
  mirrors.delete(sessionId);
  idxLoaded.delete(sessionId);
  metaCache.delete(sessionId);
  return true;
}

// Migration counters, surfaced in a boot log line.
export const migrateStats = {sessions: 0, rows: 0};

// One boot conversion: the caller hands every legacy history page's rows; they
// are upserted by mid, so a page re-run is harmless. Called once, then the old
// pages store is cleared by the caller.
export async function importLegacyRows(sessionId: string, rows: StoreRow[]): Promise<void> {
  if (!rows.length) return;
  await upsert(sessionId, rows);
  migrateStats.sessions++;
  migrateStats.rows += rows.length;
  cyclog('rowstore.migrated', {session: sessionId, rows: rows.length});
}

// A one-time durable rekey over cyc-rows (fix-oneid, the deploy crossing).
//
// The deployed master build keyed an own-send row by its engine mid `m:<mid>`
// (its rowIdOfMessage ignored the cid); fix-oneid keys the SAME send by its cid
// `m:c:<cid>`. Records already on disk therefore still carry the OLD key, and the
// first re-serve after the upgrade arrives under the NEW key, so without this the
// two spellings twin every delivered own send, durably, on every device at the
// crossing.
//
// This walks every stored row once, re-derives its id with the ONE function
// (rowIdOfMessage on the stored payload; the payload carries the cid where one
// existed, and a legacy NUMERIC msg.id is re-stamped to the string), and where
// the derived id differs from the stored key it rewrites the record and the idx
// tuple under the new id and deletes the old. It is idempotent (a re-run derives
// the same id and changes nothing) and crash-safe (the caller sets the versioned
// flag only after the full pass; a crash mid-pass re-runs, and the runtime fold
// in foldMidKeyedTwins catches anything the pass had not reached). A session with
// nothing to rekey pays one cheap scan at most once. Returns the counts for a
// boot log line.
export async function rekeyDurableRowsToOneId(): Promise<{sessions: number; rekeyed: number}> {
  const all = await backing<Array<Partial<RowRecord> & IdxRecord>>(
    'readonly',
    (s) => s.getAll() as IDBRequest
  );
  if (!Array.isArray(all) || !all.length) return {sessions: 0, rekeyed: 0};
  const rowsBySession = new Map<string, RowRecord[]>();
  const idxBySession = new Map<string, IdxRecord>();
  for (const rec of all) {
    if (!rec || typeof rec.sessionId !== 'string') continue;
    if (Array.isArray(rec.tuples)) idxBySession.set(rec.sessionId, rec as IdxRecord);
    else if (rec.kind === 'msg' && rec.msg && typeof rec.id === 'string') {
      let list = rowsBySession.get(rec.sessionId);
      if (!list) rowsBySession.set(rec.sessionId, (list = []));
      list.push(rec as RowRecord);
    }
  }
  let sessions = 0;
  let rekeyed = 0;
  for (const [sid, records] of rowsBySession) {
    const remap = new Map<string, string>(); // oldId -> newId, only for a changed key
    const puts: RowRecord[] = [];
    for (const rec of records) {
      const msg = rec.msg!;
      const newId = rowIdOfMessage(msg);
      // A key change OR only a legacy numeric payload id both need a rewrite; a
      // row already keyed AND stamped with its one string id is left untouched.
      if (newId === rec.id && msg.id === newId) continue;
      msg.id = newId; // stamp (also converts a legacy numeric msg.id to the string)
      puts.push({...rec, id: newId, msg, key: rowKey(sid, newId)});
      if (newId !== rec.id) remap.set(rec.id, newId);
    }
    if (!puts.length) continue;
    sessions++;
    rekeyed += puts.length;
    const idxRec = idxBySession.get(sid);
    const newIds = new Set(puts.map((p) => p.id));
    // Delete each old key, except one that a rewrite is now writing to (never
    // delete the record we just wrote).
    const deletes = [...remap.keys()].filter((oldId) => !newIds.has(oldId));
    // One awaited readwrite per session, so the puts, the deletes and the idx
    // rewrite land together and the flag is set only after they commit.
    await backing('readwrite', (s) => {
      let last: IDBRequest = s.put(puts[0]);
      for (let i = 1; i < puts.length; i++) last = s.put(puts[i]);
      for (const oldId of deletes) last = s.delete(rowKey(sid, oldId));
      if (idxRec) {
        // Remap each old id to its new id, then DEDUPE by the final id: if the
        // idx already carried BOTH the old and the target new tuple for one
        // message (a crash-mid-migration survivor plus a raced admit), the remap
        // would otherwise leave two identical tuples and paint a durable twin.
        // The records converge, so keeping the first occurrence is enough.
        const byId = new Map<string, RowTuple>();
        for (const t of idxRec.tuples) {
          const id = remap.has(t.id) ? remap.get(t.id)! : t.id;
          if (!byId.has(id)) byId.set(id, {...t, id});
        }
        const tuples = [...byId.values()];
        last = s.put({key: idxKey(sid), sessionId: sid, tuples} satisfies IdxRecord);
      }
      return last;
    });
    cyclog('rowstore.rekey.session', {session: sid, rekeyed: puts.length});
  }
  return {sessions, rekeyed};
}
