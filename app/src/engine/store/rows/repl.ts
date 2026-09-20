// One background replicator per session, wired to the real wire. The replicator
// itself is pure of the app (replicator.ts); this is the thin registry that
// gives it the live dependencies: the engine's page fetch, the store door, the
// cursor persistence, and the reachability signal. store.ts starts a session's
// replicator on attach and the chat handler feeds it each attach-ok; the
// replicator NEVER paints (it only appends rows to the store, which decides on
// its own whether the open window changed).

import {cyclog} from '@/shared/logging';
import {connOf} from '../registry';
import * as sync from '../../sync';
import * as rowStore from './rowStore';
import {forgetProjection, resnapOpenWindow, WINDOW} from './door';
import {
  createReplicator,
  rowsFromPage,
  tailVersionOf,
  type AttachOkLite,
  type Replicator
} from './replicator';
import {cursorSeq, resetCoverage, type CursorState} from './cursor';
import type {StoreRow} from './core';

const repls = new Map<string, Replicator>();

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
    syncedAt: Date.now()
  });
}

export function replicatorFor(sessionId: string, engineKey: string, paneId: string): Replicator {
  let r = repls.get(sessionId);
  if (!r) {
    r = createReplicator(sessionId, {
      fetchPage: (page) => {
        const owner = connOf(engineKey);
        return owner ? owner.client.fetchPage(paneId, page) : Promise.resolve(null);
      },
      upsert: (rows) =>
        rowStore
          .upsert(sessionId, rows, 'replicator')
          .then((res) => ({loSeq: res.loSeq, hiSeq: res.hiSeq})),
      persistCursor: (st) => persist(sessionId, st),
      reachable: () => sync.engineReachable(engineKey)
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
  await resetIfStaleAxis(sessionId, r, a);
  await r.attachOk(a);
  // Snap the open window onto the tail the delta just delivered BEFORE the
  // background backfill runs, so every older page the replicator pulls falls
  // below the window and paints nothing.
  await resnapOpenWindow(sessionId);
  r.start();
}

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
async function resetIfStaleAxis(sessionId: string, r: Replicator, a: AttachOkLite): Promise<void> {
  const version = tailVersionOf(a);
  if (version <= 0) return;
  const reason = staleReason(sessionId, version);
  if (!reason) return;
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
    return;
  }
  cyclog('rowstore.stale-axis', {
    session: sessionId,
    heldTail: rowStore.highestHeldSeq(sessionId),
    engineTailVersion: version,
    reason,
    why: 'cached rows do not match the engine axis; drop the stale axis and re-sync at the served tail'
  });
  const wasOpen = rowStore.isOpen(sessionId);
  const purged = await rowStore.purge(sessionId);
  if (!purged) {
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
    return;
  }
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
  await rowStore.upsert(sessionId, served, 'heal');
  resetCoverage(r.cursor, a.tailPage ?? -1, version);
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

// The frontier the app may HONESTLY state to the engine on attach: the highest
// seq it can PROVE it holds as a contiguous run from the START of the axis.
//
// The engine reads `frontier` as "the highest seq this device holds
// contiguously" and re-serves only pages above it (chat/attach.ts). The bug this
// replaces reported `rowStore.highestHeldSeq` -- the MAX seq over every held row
// -- unconditionally. On a busy chat the newest rows by seq are session-event
// records a running agent stamps in the thousands ABOVE the newest chat message,
// and the cache can be only a SUFFIX of the axis (the replicator fills
// newest-first, so older history sits unpulled below a covered run
// [coveredFrom, tail] whose floor is far above page 0). Stating the max held seq
// then told the engine the device was caught up to a seq whose whole history it
// did not hold, so the engine's re-serve collapsed to the single newest page and
// the truncated suffix stood as the whole conversation (the false, foreshortened
// chat the owner saw until wiping the cache).
//
// The honest rule: downgrade to a COLD attach (-1) exactly when the replicator's
// covered run is a PROVEN non-anchored suffix -- its floor sits above the axis
// start (cursorSeq > 0: coveredFrom finite AND > 0). Then the device cannot prove
// any contiguous prefix, so the engine re-serves and the cache heals, exactly as
// a wiped device does. When coverage is unknown (never page-filled: cursorSeq -1)
// or reaches the start (fully synced: cursorSeq 0), the held tail is a truthful
// frontier and is kept, so a small or complete chat still catches up with what it
// holds and cold-open speed is untouched. A session with no replicator has no
// suffix to prove, so it keeps the held tail (the prior behavior).
export function attachFrontier(sessionId: string, heldTail: number): number {
  const r = repls.get(sessionId);
  if (!r) return heldTail;
  return cursorSeq(r.cursor) > 0 ? -1 : heldTail;
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
}
