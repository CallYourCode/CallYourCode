// One background replicator per session, wired to the real wire. The replicator
// itself is pure of the app (replicator.ts); this is the thin registry that
// gives it the live dependencies: the engine's page fetch, the store door, the
// cursor persistence, and the reachability signal. store.ts starts a session's
// replicator on attach and the chat handler feeds it each attach-ok; the
// replicator NEVER paints (it only appends rows to the store, which decides on
// its own whether the open window changed).

import {cyclog} from '@/shared/logging';
import {printTerm} from '@shared/pages';
import {connOf} from '../registry';
import * as sync from '../../sync';
import * as rowStore from './rowStore';
import {forgetProjection, reproject, resnapOpenWindow, setGapSource, WINDOW} from './door';
import {
  createReplicator,
  rowsFromPage,
  tailVersionOf,
  DEFAULT_PAGES_PER_SEC,
  type AttachOkLite,
  type Replicator
} from './replicator';
import {cursorSeq, resetCoverage, resetCursor, type CursorState} from './cursor';
import type {StoreRow} from './core';
import type {EnginePage, EnginePagePrints} from '../../contract';
import type {CycSessionEvent} from '../../../types';

const repls = new Map<string, Replicator>();
// The engine and pane each session's replicator talks to, for the shown-page
// check outside an attach (verifyShown).
const wires = new Map<string, {engineKey: string; paneId: string}>();

// The OPEN chat backfills at the full rate; every other session fills its whole
// offline history at a slow background trickle, so a dozen live sessions never
// share the wire and CPU at the open chat's pace. A demand hint (scroll-back,
// jump) still jumps the queue within a replicator; only the steady cadence of
// the ordered backfill is throttled.
const OPEN_GAP_MS = 1000 / DEFAULT_PAGES_PER_SEC; // 2 pages/sec for the open chat
const TRICKLE_GAP_MS = 5000; // ~1 page / 5s for background chats

// The whole background backfill pauses while the page is hidden: a backgrounded
// tab shows nothing, so it should spend no CPU or wire pulling history. The
// live tail (attach-ok deltas, live frames) still lands through the store door;
// only the ordered backfill of older pages waits for the page to be visible.
function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function wakeAllReplicators(): void {
  for (const r of repls.values()) r.wake();
}

// Resume every replicator the moment the page becomes visible again (guarded for
// the non-browser test environment; tests drive wake()/pump() directly).
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wakeAllReplicators();
  });
}

function persist(sessionId: string, st: CursorState): void {
  const prev = rowStore.metaSnapshot(sessionId);
  rowStore.writeMeta({
    sessionId,
    cursor: cursorSeq(st),
    tailVersion: st.tailVersion,
    tailPage: st.tailPage,
    coveredFrom: Number.isFinite(st.coveredFrom) ? st.coveredFrom : -1,
    pageSize: st.pageSize,
    total: prev?.total ?? 0,
    syncedAt: Date.now(),
    ...(st.holes.size ? {holes: [...st.holes]} : {}),
    ...(prev?.axis ? {axis: prev.axis} : {})
  });
}

export function replicatorFor(sessionId: string, engineKey: string, paneId: string): Replicator {
  wires.set(sessionId, {engineKey, paneId});
  let r = repls.get(sessionId);
  if (!r) {
    r = createReplicator(sessionId, {
      fetchPage: (page) => {
        const owner = connOf(engineKey);
        return owner ? owner.client.fetchPage(paneId, page) : Promise.resolve(null);
      },
      upsert: (rows, pg) => {
        // A fetched page names the axis it was cut from: one of another epoch
        // is never filed among this session's rows by seq (fix-log-epoch).
        const held = rowStore.metaSnapshot(sessionId)?.axis;
        if (pg.axis && held && pg.axis !== held) {
          void settleAxis(sessionId, pg.axis, 'page');
          return Promise.reject(
            new Error(`page ${pg.page} is on axis ${pg.axis}, rows held on ${held}`)
          );
        }
        return pg.sealed && wantOf(sessionId).has(pg.page)
          ? replaceShownPage(sessionId, pg, rows)
          : rowStore
              .upsert(sessionId, rows, 'replicator')
              .then((res) => ({loSeq: res.loSeq, hiSeq: res.hiSeq}));
      },
      pageCommitted: (page, pg, wasHole) => onPageCommitted(sessionId, page, pg, wasHole),
      persistCursor: (st) => persist(sessionId, st),
      reachable: () => sync.engineReachable(engineKey),
      paused: () => pageHidden(),
      gapMs: () => (rowStore.isOpen(sessionId) ? OPEN_GAP_MS : TRICKLE_GAP_MS)
    });
    repls.set(sessionId, r);
  }
  return r;
}

// Re-seat a freshly created replicator's cursor from the persisted meta, so a
// reload resumes the backfill where it left off instead of re-pulling covered
// pages (upserts by mid are idempotent, so this is an optimization, not a
// correctness requirement).
export function seedCursor(r: Replicator, meta: rowStore.SessionMeta | null): void {
  if (!meta) return;
  r.cursor.pageSize = meta.pageSize || r.cursor.pageSize;
  r.cursor.tailPage = meta.tailPage;
  r.cursor.tailVersion = meta.tailVersion;
  r.cursor.coveredFrom = meta.coveredFrom >= 0 ? meta.coveredFrom : Infinity;
  for (const p of meta.holes ?? []) if (Number.isFinite(p) && p >= 0) r.cursor.holes.add(p);
}

// A per-session serializer for attach-ok handling. The chat handler fires
// `void feedAttachOk(...)` on EVERY attach-ok, and the client re-attaches many
// times a second (the catchup-tick flood), so without this two runs would
// overlap: while run A sits between its awaited purge and its admit, run B's
// openWindow reloads the warm mirror FROM a durable backing whose delete
// transaction from run A has not committed yet, resurrecting the stale axis, and
// the served tail one run admits is clobbered by the other. Net on the live rig:
// heldTail stays stale and the window projects empty. The heal is idempotent
// (after one heal completes the axis is sound and the next attach-ok no-ops), so
// serializing each run to completion is both correct and cheap.
//
// The chain is bounded: one run in flight plus at most ONE pending run coalesced
// onto the NEWEST attach-ok. If three attach-oks arrive while one runs, only one
// more run happens, with the latest `a`, not three. Every caller's promise
// resolves when the run its call folded into completes, so the chat handler's
// reconcile-queued still runs after the attach-ok work.
type PendingAttach = {
  engineKey: string;
  paneId: string;
  a: AttachOkLite;
  resolvers: Array<() => void>;
};

const attachInFlight = new Set<string>();
const attachPending = new Map<string, PendingAttach>();

// Test-only: how many times runAttachOk actually executed, so the coalescing
// test can prove N concurrent attach-oks run the heal at most twice (once plus
// one coalesced), never N times.
let attachRuns = 0;
export function __attachOkRunsForTest(): number {
  return attachRuns;
}

// The chat handler's attach-ok routes here: it queues onto the session's chain
// (coalescing onto the newest `a` while a run is in flight) and resolves when the
// run it folded into has fully completed (purge -> admit -> resnap).
export function feedAttachOk(
  sessionId: string,
  engineKey: string,
  paneId: string,
  a: AttachOkLite
): Promise<void> {
  return new Promise<void>((resolve) => {
    const existing = attachPending.get(sessionId);
    if (existing) {
      // A run is in flight (or a run is queued): coalesce onto the newest attach-
      // ok and ride its completion, so N concurrent attach-oks run at most once
      // more, not N times.
      existing.engineKey = engineKey;
      existing.paneId = paneId;
      existing.a = a;
      existing.resolvers.push(resolve);
      return;
    }
    attachPending.set(sessionId, {engineKey, paneId, a, resolvers: [resolve]});
    if (!attachInFlight.has(sessionId)) void drainAttachOk(sessionId);
  });
}

async function drainAttachOk(sessionId: string): Promise<void> {
  attachInFlight.add(sessionId);
  try {
    for (;;) {
      const job = attachPending.get(sessionId);
      if (!job) break;
      attachPending.delete(sessionId);
      try {
        await runAttachOk(sessionId, job.engineKey, job.paneId, job.a);
      } catch (e) {
        cyclog('rowstore.attach-ok.failed', {session: sessionId, err: String(e)});
      }
      for (const resolve of job.resolvers) resolve();
    }
  } finally {
    attachInFlight.delete(sessionId);
  }
}

// One attach-ok, run to completion with no other run for this session overlapping
// it: feed the delta's tail bookkeeping and pages to the replicator (a renumber
// or a stale axis is healed first), snap the open window onto the served tail,
// then let the background trickle run.
async function runAttachOk(
  sessionId: string,
  engineKey: string,
  paneId: string,
  a: AttachOkLite
): Promise<void> {
  attachRuns++;
  const r = replicatorFor(sessionId, engineKey, paneId);
  // An engine that names no epoch gets the heuristics alone; one that does is
  // settled in turn with any roster-driven drop of the same session.
  if (a.axis) await withAxisLock(sessionId, () => settleAttachAxis(sessionId, r, a));
  else await resetIfStaleAxis(sessionId, r, a);
  await r.attachOk(a);
  // Snap the open window onto the tail the delta just delivered BEFORE the
  // background backfill runs, so every older page the replicator pulls falls
  // below the window and paints nothing.
  await resnapOpenWindow(sessionId);
  if (a.fp) {
    // Checked now: the fingerprinted pages and the ones served inline above them.
    const done = new Set<number>();
    const top = Math.max(a.tailPage ?? -1, a.fp.from + a.fp.n.length - 1);
    for (let p = a.fp.from; p <= top; p++) done.add(p);
    verified.set(sessionId, done);
    await verifyPages(sessionId, r, a.fp, a.tailPage ?? -1);
  }
  r.start();
}

// ---- The chat log's axis epoch (fix-log-epoch) ----
//
// A session's seq axis is not forever: the engine re-sequences a log when it
// folds a provisional agent into the agent it turned out to be (carry.ts
// absorb) or trims it, and writes it as a new chat file under the same session
// id. Hunter, 2026-10-03: one absorbed status line renumbered all 2494 rows
// (old axis 0..2645, new 0..2493). The phone held the old axis; nothing on the
// wire said so. It painted the 9-day-old cached window, stated frontier 2600,
// and was healed only because the new tail (2579) still sat below 2600 (the
// held-tail heuristic below). A few hours of growth later the same frontier
// would have read as plausible: a delta filed onto a dead axis.
//
// The engine now names every log's axis with an epoch (its chat file id),
// minted in the same step as any re-sequence, and states it on the roster row,
// the attach-ok and every fetched page. The device stamps the epoch its rows
// were served under in the session meta. A different epoch is PROOF that every
// seq, the cursor, the holes and the fingerprints this device holds for the
// session describe pages that no longer exist: the rows are dropped and the
// session syncs afresh, never merged with the new axis by seq. The heuristics
// below stay for what the epoch cannot speak to: an engine older than it, and
// rows stored before this device ever saw one (checked once, then stamped).

// Called by the store when the open chat's stamped rows turn out to belong to
// a dead axis while they are on screen: it re-attaches, and the attach-ok (cold,
// it carries the new tail) replaces them in one turn (settleAttachAxis).
let axisResync: (sessionId: string) => void = () => {};
export function setAxisResync(fn: (sessionId: string) => void): void {
  axisResync = fn;
}

// One axis decision at a time per session: a roster-driven drop must not
// interleave with an attach-ok's purge and admit for the same session.
const axisLocks = new Map<string, Promise<unknown>>();
function withAxisLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const prev = axisLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(run, run);
  axisLocks.set(
    sessionId,
    next.catch(() => {})
  );
  return next;
}

function stampAxis(sessionId: string, axis: string): void {
  const prev = rowStore.metaSnapshot(sessionId);
  if (prev?.axis === axis) return;
  const r = repls.get(sessionId);
  rowStore.writeMeta({
    sessionId,
    cursor: r ? cursorSeq(r.cursor) : (prev?.cursor ?? -1),
    tailVersion: r ? r.cursor.tailVersion : (prev?.tailVersion ?? 0),
    tailPage: r ? r.cursor.tailPage : (prev?.tailPage ?? -1),
    coveredFrom: r
      ? Number.isFinite(r.cursor.coveredFrom)
        ? r.cursor.coveredFrom
        : -1
      : (prev?.coveredFrom ?? -1),
    pageSize: r ? r.cursor.pageSize : (prev?.pageSize ?? 100),
    total: prev?.total ?? 0,
    syncedAt: prev?.syncedAt ?? 0,
    ...(r && r.cursor.holes.size ? {holes: [...r.cursor.holes]} : {}),
    axis
  });
}

// Everything this device derived from the old axis, besides the rows: the
// fingerprint bookkeeping and the pages asked for out of order, and (`whole`,
// when no served tail re-seeds them) the replicator's coverage and holes and
// the projection signature of what was on screen.
function forgetAxisState(sessionId: string, whole: boolean): void {
  const r = repls.get(sessionId);
  if (r) r.cursor.demand.length = 0;
  if (r && whole) resetCursor(r.cursor);
  if (whole) forgetProjection(sessionId);
  wanted.delete(sessionId);
  unreconciled.delete(sessionId);
  verified.delete(sessionId);
}

// The engine stated `axis` for this session (its roster row, a fetched page, or
// the open path's persisted roster). Rows stamped with another epoch are dropped
// here, before anything paints them, unless the session is on screen right now:
// then the dead rows stay until a tail replaces them (an empty chat is worse
// than one about to be swapped), and the store re-attaches for that tail.
// Unstamped rows are left to the attach-ok, which checks them once and stamps
// them. Resolves true when it dropped rows.
export function settleAxis(
  sessionId: string,
  axis: string | undefined,
  why: 'roster' | 'page' | 'open'
): Promise<boolean> {
  if (!axis) return Promise.resolve(false);
  return withAxisLock(sessionId, async () => {
    const meta = await rowStore.readMeta(sessionId);
    const held = meta?.axis;
    if (!held || held === axis) return false;
    if (why !== 'open' && rowStore.isOpen(sessionId)) {
      cyclog('rowstore.axis-epoch.resync', {
        session: sessionId,
        held,
        axis,
        why: 'the open chat shows rows of a re-sequenced log; re-attach for the new tail'
      });
      axisResync(sessionId);
      return false;
    }
    // a closed chat's rows are not warm: its meta knows where they reached
    const heldTail = Math.max(rowStore.highestHeldSeq(sessionId), (meta?.tailVersion ?? 0) - 1);
    if (!(await rowStore.purge(sessionId))) {
      cyclog('rowstore.axis-epoch.purge-aborted', {
        session: sessionId,
        held,
        axis,
        why: 'the purge transaction aborted; the next roster, open or attach retries'
      });
      return false;
    }
    forgetAxisState(sessionId, true);
    stampAxis(sessionId, axis);
    cyclog('rowstore.axis-epoch', {
      session: sessionId,
      held,
      axis,
      heldTail,
      trigger: why,
      why: 'the engine re-sequenced this chat log since these rows were served; dropped them before they paint'
    });
    return true;
  });
}

// The attach-ok's half. With an epoch on the answer:
//   - the same epoch as the stamp: the rows are on this axis, nothing to guess;
//   - another epoch: replace the rows with the served tail in one turn (the
//     engine served cold, since the attach named the stamp), forget the old
//     cursor and fingerprints, stamp the new epoch;
//   - no stamp yet (rows stored before this device met an epoch, or none): the
//     stale-axis heuristics check them this once, then the epoch is stamped.
// With none (an older engine) runAttachOk runs the heuristics alone.
async function settleAttachAxis(sessionId: string, r: Replicator, a: AttachOkLite): Promise<void> {
  if (!a.axis) return;
  const meta = await rowStore.readMeta(sessionId);
  const held = meta?.axis;
  if (held === a.axis) return;
  if (!held) {
    if ((await resetIfStaleAxis(sessionId, r, a)) !== 'kept') stampAxis(sessionId, a.axis);
    return;
  }
  const served = servedRows(sessionId, a);
  if (!served.length && tailVersionOf(a) > 0) {
    // the engine did not serve cold (this attach named no epoch): keep the rows
    // on screen; the next attach states the stamp and gets the tail
    cyclog('rowstore.axis-epoch.kept', {
      session: sessionId,
      held,
      axis: a.axis,
      why: 'a re-sequenced log, but this attach-ok carries no tail to replace the rows with'
    });
    return;
  }
  const heldTail = rowStore.highestHeldSeq(sessionId);
  if (!(await replaceWithServedTail(sessionId, r, a, served))) {
    cyclog('rowstore.axis-epoch.purge-aborted', {
      session: sessionId,
      held,
      axis: a.axis,
      why: 'the purge transaction aborted; the next attach retries'
    });
    return;
  }
  // the cursor was re-seeded at the served tail; the rest of the old axis goes
  forgetAxisState(sessionId, false);
  stampAxis(sessionId, a.axis);
  cyclog('rowstore.axis-epoch', {
    session: sessionId,
    held,
    axis: a.axis,
    heldTail,
    engineTailVersion: tailVersionOf(a),
    trigger: 'attach',
    why: 'the engine re-sequenced this chat log since these rows were served; replaced them with the served tail'
  });
}

// THE FALLBACK HEURISTICS (no epoch to compare: an engine older than it, or
// rows stored before this device met one).
//
// A device that ran the pre-rebuild build cached history rows the one-boot
// migration imported verbatim, and those rows make the local axis stale in one
// of three ways, each detected here at attach-ok:
//
//   - a HELD TAIL ABOVE THE ENGINE AXIS: the owner's phone held seqs far above
//     this engine's current tail (an older, longer axis). Those rows sort ABOVE
//     every genuine row (seq is the primary sort key), so the open window shows
//     old mid-history and the real live tail is invisible. The cursor's own
//     renumber check never catches this: it compares the engine tail against the
//     freshly seeded CURSOR version, never the STORE's max seq.
//   - UNSEQED legacy rows (seq < 0): they sort at the tail (Infinity) and wall
//     the newest window and the pending zone, so the chat renders EMPTY.
//   - MID-LESS legacy rows that sort ABOVE the engine tail: their durable id
//     fell back to `m@ts|role|text` and they outrank and TWIN the real tail (a
//     migrated older/longer axis). A mid-less row AT or BELOW the tail is left
//     alone: the engine's own pre-mid chat files re-serve real on-axis history
//     without a mid, so purging it would drop real data and refire forever.
//
// Any of the three: drop this session's durable rows AND its warm mirror (purge,
// awaited, so it sticks), reset the cursor so the replicator re-pulls the real
// axis, and ADMIT the attach-ok's served tail in the SAME turn so the fresh tail
// projects at once. The user's own isLocalOnly pending sends are untouched: they
// are an in-memory overlay on s.messages, never store rows, so purging the store
// preserves them and the reprojection lays them back over the fresh tail. When
// the session is open we re-establish an empty window BEFORE the admit so the
// admitted tail lands in the loaded window and projects at once (a cold, empty
// mirror would file the pages below an unset floor and paint nothing). After one
// heal the store holds only rows with a real seq and a mid at or below the
// engine tail, so the next attach reports a sane frontier and never re-fires.
// Already-migrated devices are in the field, so migration alone cannot heal
// them; the purge here covers them.
//
// TWO guards keep the heal from ever leaving the open chat with FEWER messages
// than it already showed (the slow-link data loss a real phone hit on 4G: the
// heal purged the 16 visible rows, then the refetch timed out and the chat
// stayed on 'No messages here yet'):
//
//   1. The heal purges ONLY when this attach-ok carries an admittable tail to put
//      back (servedRows non-empty). A stale-high frontier can make the engine
//      serve an empty delta (deltaBase bookkeeping, no pages) because the device
//      claimed to be ahead; purging on that would blank the chat with nothing to
//      replace the rows with, and on a dead link the background refetch may never
//      complete. A stale ordering is less bad than an empty chat, so we KEEP the
//      rows and let a later attach-ok that DOES carry the tail heal.
//   2. When it does purge, the served tail is admitted and projected in the same
//      turn as the purge, so the open chat goes from the stale axis STRAIGHT to
//      the real tail with no count=0 paint in between. The replicator's own
//      attachOk re-commits the same pages (idempotent by mid) and advances the
//      cursor; the background backfill of OLDER pages is best-effort and never
//      blanks the window, so a refetch that never completes cannot lose the tail.
async function resetIfStaleAxis(
  sessionId: string,
  r: Replicator,
  a: AttachOkLite
): Promise<'sound' | 'healed' | 'kept'> {
  const version = tailVersionOf(a);
  if (version <= 0) return 'sound';
  const reason = staleReason(sessionId, version);
  if (!reason) return 'sound';
  const served = servedRows(sessionId, a);
  if (!served.length) {
    // Guard 1: a stale axis, but this attach served no tail to replace it with.
    // Purging now would blank the chat and, on a slow or dead link, leave it
    // empty (the phone's 4G data loss). Keep the rows; a later tail-carrying
    // attach-ok heals.
    cyclog('rowstore.stale-axis.kept', {
      session: sessionId,
      heldTail: rowStore.highestHeldSeq(sessionId),
      engineTailVersion: version,
      reason,
      why: 'stale axis detected but the attach-ok served no tail to replace it with; keep the existing rows visible and wait for an attach that carries the tail'
    });
    return 'kept';
  }
  cyclog('rowstore.stale-axis', {
    session: sessionId,
    heldTail: rowStore.highestHeldSeq(sessionId),
    engineTailVersion: version,
    reason,
    why: 'cached rows do not match the engine axis; drop the stale axis and re-sync at the served tail'
  });
  if (await replaceWithServedTail(sessionId, r, a, served)) return 'healed';
  // Guard 3: the purge transaction ABORTED (an iOS page-freeze rolled back the
  // deletes), so the stale axis is still durable AND still warm. Treat the
  // session as NOT healed: leave the existing rows on screen, do NOT reset the
  // cursor coverage, and let the detector re-fire on the next attach and redo
  // the purge once a transaction commits. The heal is idempotent, so a redo is
  // safe; claiming coverage here would tell the replicator the axis is sound
  // when the poison never left.
  cyclog('rowstore.stale-axis.purge-aborted', {
    session: sessionId,
    heldTail: rowStore.highestHeldSeq(sessionId),
    engineTailVersion: version,
    reason,
    why: 'the purge transaction aborted (a frozen page rolled back the deletes); keep the rows and let the next attach redo the heal'
  });
  return 'kept';
}

// Drop this session's rows and put the attach-ok's served tail in their place,
// in ONE turn, so the open chat goes from the old axis straight to the served
// tail with no empty paint between (guard 2 above). False when the purge
// transaction aborted: nothing changed, the caller keeps its state.
async function replaceWithServedTail(
  sessionId: string,
  r: Replicator,
  a: AttachOkLite,
  served: StoreRow[]
): Promise<boolean> {
  const wasOpen = rowStore.isOpen(sessionId);
  if (!(await rowStore.purge(sessionId))) return false;
  // Re-open an empty window so the served tail admitted next lands in the loaded
  // window (floor 0) and projects immediately, instead of below an unset floor
  // where it would paint nothing.
  if (wasOpen) await rowStore.openWindow(sessionId, WINDOW);
  // The purge tore down the projection this session was showing, so the door's
  // cached projection signature no longer describes anything real. Forget it, so
  // the served tail admitted next always repaints -- even onto content whose one
  // durable ids make its signature identical to a projection painted before the
  // purge (the signatures are content-derived now, so a re-heal to the same tail
  // would otherwise be suppressed and leave a warm-but-unprojected chat blank).
  forgetProjection(sessionId);
  // Guard 2: admit and project the served tail NOW, in the same turn as the
  // purge, so the open chat never passes through an empty paint on the way from
  // the stale axis to the real tail.
  if (served.length) await rowStore.upsert(sessionId, served, 'heal');
  resetCoverage(r.cursor, a.tailPage ?? -1, tailVersionOf(a));
  return true;
}

// The rows the engine served INLINE on this attach-ok (its newest pages), minted
// as store rows exactly as the replicator mints them. Empty when the delta
// carried no pages: the signal that this attach has no tail to heal onto.
function servedRows(sessionId: string, a: AttachOkLite): StoreRow[] {
  const rows: StoreRow[] = [];
  for (const p of a.pages) rows.push(...rowsFromPage(sessionId, p));
  return rows;
}

// The reason this session's stored axis is stale, or null when it is sound: the
// held tail sitting above the engine's confirmed tail version, or a migrated
// legacy row that never carried a seq or that is mid-less and sorts above the
// engine tail (rowStore.staleRowReason, given the tail as its axis bound so an
// on-axis mid-less engine row is not mistaken for stale legacy).
function staleReason(sessionId: string, version: number): string | null {
  const held = rowStore.highestHeldSeq(sessionId);
  if (held >= 0 && version < held) return 'held-tail-above-engine-axis';
  return rowStore.staleRowReason(sessionId, version);
}

// The frontier the app may HONESTLY state to the engine on attach: a seq the
// ENGINE confirmed this device holds everything at or below (fix-sync-gap).
//
// The engine reads `frontier` as "this device holds every row at or below F"
// and re-serves only pages above it (chat/attach.ts). Two earlier rules broke
// that promise:
//   - the MAX seq over every held row. A chat this device was NOT attached to
//     still receives every broadcast chat message (the engine sends session
//     records only to attached clients), so one newer message landing alone set
//     the frontier past everything missed in between. The laptop's BZ Builder
//     (2026-10-02): offline overnight, two messages at 09:01 and 09:07 arrived
//     while it sat on the list, the open stated frontier 136559, the engine
//     served only page 1365, and 65 messages from 22:39 to 10:10 never came.
//   - a non-anchored SUFFIX (the replicator fills newest-first, so older history
//     sits unpulled below the covered run) attaches cold (-1), kept below: the
//     device cannot prove the older history, so the engine re-serves its tail
//     and the backfill heals the rest.
//
// The confirmed edge C is the replicator's tailVersion - 1: it moves only when an
// attach-ok's pages committed (to the engine's tail; a capped delta records the
// pages it skipped as holes the replicator fetches) or a live row arrives that
// is exactly C + 1 (replicator.ts noteLive). The frontier is min(held tail, C).
// With no confirmed edge (no replicator, or one never fed an attach-ok) the
// device attaches cold, so the engine re-serves its tail.
//
// Rows stamped with an epoch the engine no longer serves (`axis`, the roster's)
// prove nothing on the current axis: cold, whatever the cursor says.
export function attachFrontier(sessionId: string, heldTail: number, axis?: string): number {
  const r = repls.get(sessionId);
  if (!r) return -1;
  const held = rowStore.metaSnapshot(sessionId)?.axis;
  if (axis && held && held !== axis) return -1;
  if (cursorSeq(r.cursor) > 0) return -1;
  const confirmed = r.cursor.tailVersion - 1;
  if (confirmed < 0) return -1;
  return Math.min(heldTail, confirmed);
}

// ---- Shown-page verification and the gap markers (fix-sync-gap) ----
//
// Every attach names the lowest page the open window shows (verifyFrom) and the
// attach-ok answers a fingerprint per shown page (rowStore.pagePrints is the
// device's twin). A page that differs is missing rows, holds rows the engine
// does not, or holds a stale edit: it joins the cursor's holes, the replicator
// fetches it first, and a sealed one REPLACES the device's copy (replaceShownPage).
// While a hole sits inside the open window the list shows a gap row in its place
// (gapMarkers), never the rows on either side joined as if nothing were missing.

type Print = {n: number; m: number; h: number};
const samePrint = (a: Print, b: Print) => a.n === b.n && a.m === b.m && a.h === b.h;
const printKey = (p: Print) => `${p.n}/${p.m}/${p.h}`;

// Pages flagged by a fingerprint and not yet refetched: the engine's print and
// how many rows and messages the device lacked there (the gap row's count; a
// page that lacks no row is a stale edit, refetched without a gap row).
type Want = {print: Print; missingRows: number; missingMsgs: number};
const wanted = new Map<string, Map<number, Want>>();
// The loop guard: a page refetched once that STILL differs (a row the store
// refuses or folds) is remembered at the engine print it had, and not refetched
// again until that print changes or the app reloads.
const unreconciled = new Map<string, Map<number, string>>();
// The pages compared with the engine since the last attach-ok that carried
// fingerprints: its range, the pages it served inline, and every range a prints
// request answered since. Absent until an engine answered fingerprints at all
// (an older engine is never asked). A shown page outside it is asked for once
// (verifyShown), so the check never re-fires on pages already compared.
const verified = new Map<string, Set<number>>();
// One prints request in flight per session.
const printsInFlight = new Set<string>();
// The most pages one prints request names (the engine caps its answer the same).
const PRINTS_PAGES_MAX = 100;

function wantOf(sessionId: string): Map<number, Want> {
  let w = wanted.get(sessionId);
  if (!w) wanted.set(sessionId, (w = new Map()));
  return w;
}
function oddOf(sessionId: string): Map<number, string> {
  let o = unreconciled.get(sessionId);
  if (!o) unreconciled.set(sessionId, (o = new Map()));
  return o;
}

function ranges(pages: number[]): string {
  const out: string[] = [];
  const sorted = [...pages].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out.join(',');
}

async function verifyPages(
  sessionId: string,
  r: Replicator,
  fp: EnginePagePrints,
  tailPage: number
): Promise<void> {
  const ps = r.cursor.pageSize;
  const to = fp.from + fp.n.length - 1;
  if (to < fp.from || ps <= 0) return;
  const held = await rowStore.pagePrints(sessionId, fp.from, to, ps);
  const want = wantOf(sessionId);
  const odd = oddOf(sessionId);
  const flagged: number[] = [];
  let missingRows = 0;
  let missingMsgs = 0;
  for (let i = 0; i < fp.n.length; i++) {
    const page = fp.from + i;
    const eng: Print = {n: fp.n[i], m: fp.m[i], h: fp.h[i]};
    const dev = held[i];
    if (samePrint(eng, dev)) {
      want.delete(page);
      odd.delete(page);
      continue;
    }
    if (odd.get(page) === printKey(eng)) continue;
    // The engine's growing tail page: a live row that landed after the engine
    // took this print makes the device hold MORE, which is not a hole. Only a
    // shortfall there is chased; the next attach checks the page again.
    if (page === tailPage && dev.n > eng.n) continue;
    const lack = Math.max(0, eng.m - dev.m);
    const lackRows = Math.max(0, eng.n - dev.n);
    want.set(page, {print: eng, missingRows: lackRows, missingMsgs: lack});
    if (!r.cursor.holes.has(page)) flagged.push(page);
    r.cursor.holes.add(page);
    missingRows += lackRows;
    missingMsgs += lack;
  }
  if (!flagged.length) return;
  persist(sessionId, r.cursor);
  cyclog('gap.detected', {
    session: sessionId,
    pages: ranges(flagged),
    seqs: `${Math.min(...flagged) * ps}-${(Math.max(...flagged) + 1) * ps - 1}`,
    missingRows,
    missingMsgs,
    why: 'a shown page differs from the engine fingerprint; refetching it'
  });
  reproject(sessionId);
  r.wake();
}

// A sealed page whose fingerprint differed: put the engine's copy in place of
// the device's, dropping the rows the engine does not have there. A dropped row
// sharing a ts and kind with a served row is a second copy of it (dup.dropped);
// any other dropped row is one the engine no longer has on that page.
async function replaceShownPage(
  sessionId: string,
  pg: EnginePage,
  rows: StoreRow[]
): Promise<{loSeq: number; hiSeq: number}> {
  const ps = repls.get(sessionId)?.cursor.pageSize ?? 100;
  const lo = pg.page * ps;
  const res = await rowStore.replacePage(sessionId, lo, lo + ps - 1, rows);
  if (res.dropped.length) {
    const served = new Set(rows.map((x) => `${x.kind}@${x.ts}`));
    const dups = res.dropped.filter((d) => served.has(`${d.kind}@${d.ts}`));
    const stale = res.dropped.filter((d) => !served.has(`${d.kind}@${d.ts}`));
    if (dups.length)
      cyclog('dup.dropped', {
        session: sessionId,
        page: pg.page,
        ids: dups.map((d) => d.id).join(','),
        why: 'a second copy of a served row under another id'
      });
    if (stale.length)
      cyclog('page.replaced', {
        session: sessionId,
        page: pg.page,
        dropped: stale.length,
        ids: stale.map((d) => d.id).join(','),
        why: 'rows the engine does not hold on this page'
      });
  }
  return {loSeq: res.loSeq, hiSeq: res.hiSeq};
}

// A page committed: when it filled a known hole, say so; when a fingerprint had
// flagged it, re-check it against the page just served and stop chasing it if
// the store still cannot hold it the same way (the loop guard).
function onPageCommitted(sessionId: string, page: number, pg: EnginePage, wasHole: boolean): void {
  const w = wanted.get(sessionId);
  const flagged = w?.get(page);
  if (!wasHole && !flagged) return;
  w?.delete(page);
  const ps = repls.get(sessionId)?.cursor.pageSize ?? 100;
  const rows = rowsFromPage(sessionId, pg);
  cyclog('gap.filled', {
    session: sessionId,
    page,
    seqs: `${page * ps}-${page * ps + ps - 1}`,
    rows: rows.length
  });
  if (flagged) {
    const served: Print = {n: 0, m: 0, h: 0};
    for (const row of rows) {
      if (row.seq < 0) continue;
      served.n++;
      if (row.kind === 'msg') served.m++;
      served.h += printTerm(row.seq - page * ps, row.msg?.rev ?? 0);
    }
    void rowStore.pagePrints(sessionId, page, page, ps).then(([dev]) => {
      if (samePrint(served, dev)) return;
      oddOf(sessionId).set(page, printKey(flagged.print));
      cyclog('page.unreconciled', {
        session: sessionId,
        page,
        engine: printKey(flagged.print),
        held: printKey(dev),
        why: 'the refetched page still differs; it will not be refetched again at this fingerprint'
      });
    });
  }
  reproject(sessionId);
}

// The gap rows for the open chat: one per run of consecutive hole pages that the
// window reaches. A page flagged only for a stale edit lacks no row, so it is
// refetched without one. Within a run the row stands where the window shows the
// widest stretch of seqs with nothing in it: between the newest shown row below
// the run, the shown rows inside it, and the run's end (or the engine's newest
// seq when the run reaches the growing tail page, so a newer message already
// held there stays below the gap, not above it).
function gapMarkers(sessionId: string): CycSessionEvent[] {
  const r = repls.get(sessionId);
  if (!r || !r.cursor.holes.size) return [];
  const want = wanted.get(sessionId);
  const pages = [...r.cursor.holes]
    .filter((p) => (want?.get(p)?.missingRows ?? 1) > 0)
    .sort((a, b) => a - b);
  if (!pages.length) return [];
  const shown = rowStore.shownRows(sessionId);
  if (!shown.length) return [];
  const ps = r.cursor.pageSize;
  const newest = r.cursor.tailVersion > 0 ? r.cursor.tailVersion - 1 : Infinity;
  const out: CycSessionEvent[] = [];
  for (let i = 0; i < pages.length;) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    const lo = pages[i] * ps;
    const hi = (pages[j] + 1) * ps - 1;
    let below: {seq: number; ts: number} | null = null;
    const inside: Array<{seq: number; ts: number}> = [];
    for (const x of shown) {
      if (x.seq < lo) {
        if (!below || x.seq > below.seq) below = x;
      } else if (x.seq <= hi) inside.push(x);
    }
    if (below || inside.length) {
      inside.sort((a, b) => a.seq - b.seq);
      let after = below;
      let prev = below ? below.seq : lo - 1;
      let prevRow = below;
      let widest = -1;
      for (let k = 0; k <= inside.length; k++) {
        const next = k < inside.length ? inside[k].seq : Math.min(hi, newest) + 1;
        if (next - prev > widest) {
          widest = next - prev;
          after = prevRow;
        }
        if (k < inside.length) {
          prev = inside[k].seq;
          prevRow = inside[k];
        }
      }
      let n = 0;
      let known = false;
      for (let p = pages[i]; p <= pages[j]; p++) {
        const f = want?.get(p);
        if (f) {
          known = true;
          n += f.missingMsgs;
        }
      }
      const text =
        known && n > 0
          ? `Loading ${n} missing message${n === 1 ? '' : 's'}...`
          : 'Loading missing messages...';
      // the list puts a message of the same ts before the gap row, so "before
      // the lowest shown row" is one millisecond earlier
      const ts = after ? after.ts : inside[0].ts - 1;
      out.push({uuid: `gap:${lo}`, kind: 'gap', ts, seq: lo, text});
    }
    i = j + 1;
  }
  return out;
}

setGapSource(gapMarkers);

// THE SHOWN-PAGE CHECK OUTSIDE AN ATTACH. The window now shows pages no
// fingerprint has covered since the last attach (the reader loaded older history
// or jumped to an old message): ask the engine for those pages' prints alone
// (client.fetchPrints, at most PRINTS_PAGES_MAX per request, any depth) and
// compare them as the attach-ok's are compared. Unlike an attach, the answer
// never touches the window: a page that differs only joins the holes, and its
// refetch lands in place. Each page is asked for once until the next attach; a
// request that fails is retried by the next scroll, never by a loop.
export function verifyShown(sessionId: string): void {
  const r = repls.get(sessionId);
  const done = verified.get(sessionId);
  const wire = wires.get(sessionId);
  if (!r || !done || !wire || printsInFlight.has(sessionId)) return;
  const ps = r.cursor.pageSize;
  const low = rowStore.shownLowSeq(sessionId);
  const top = r.cursor.tailPage;
  if (low < 0 || ps <= 0 || top < 0) return;
  let from = -1;
  for (let p = Math.floor(low / ps); p <= top; p++)
    if (!done.has(p)) {
      from = p;
      break;
    }
  if (from < 0) return;
  let to = from;
  while (to < top && to + 1 - from < PRINTS_PAGES_MAX && !done.has(to + 1)) to++;
  const owner = connOf(wire.engineKey);
  const fetchPrints = owner?.client.fetchPrints?.bind(owner.client);
  if (!fetchPrints || !sync.engineReachable(wire.engineKey)) return;
  printsInFlight.add(sessionId);
  cyclog('verify.shown', {session: sessionId, pages: `${from}-${to}`});
  void fetchPrints(wire.paneId, from, to)
    .then(async (fp) => {
      // null: the engine cannot answer for this chat; these pages count as
      // asked, so the next scroll does not ask again
      const now = verified.get(sessionId);
      if (now) for (let p = from; p <= to; p++) now.add(p);
      if (fp && fp.n.length) await verifyPages(sessionId, r, fp, fp.tailPage);
      return true;
    })
    .catch((e) => {
      cyclog('verify.shown.failed', {session: sessionId, pages: `${from}-${to}`, err: String(e)});
      return false;
    })
    .then((more) => {
      printsInFlight.delete(sessionId);
      // the window may still show unchecked pages beyond this request's cap
      if (more) verifyShown(sessionId);
    });
}

export function noteLive(sessionId: string, seq: number | undefined): void {
  repls.get(sessionId)?.noteLive(seq);
}

export function demand(sessionId: string, seq: number): void {
  repls.get(sessionId)?.demand(seq);
}

export function stopReplicator(sessionId: string): void {
  repls.get(sessionId)?.stop();
}

// True while a session's replicator is still backfilling older pages: the UI
// can offer "load older" even though the store's window is at its current floor.
export function running(sessionId: string): boolean {
  return repls.get(sessionId)?.running() ?? false;
}

export function stopAllReplicators(): void {
  for (const r of repls.values()) r.stop();
}

// Test seam: drop every replicator and clear the attach-ok chains so a test
// starts clean.
export function __resetReplicatorsForTest(): void {
  for (const r of repls.values()) r.stop();
  repls.clear();
  attachInFlight.clear();
  attachPending.clear();
  attachRuns = 0;
  wanted.clear();
  unreconciled.clear();
  verified.clear();
  printsInFlight.clear();
  wires.clear();
  axisLocks.clear();
}

// The epoch this device's rows for the session are stamped with, if any.
export function heldAxis(sessionId: string): string | undefined {
  return rowStore.metaSnapshot(sessionId)?.axis;
}
