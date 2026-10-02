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
import {cursorSeq, resetCoverage, type CursorState} from './cursor';
import type {StoreRow} from './core';
import type {EnginePage, EnginePagePrints} from '../../contract';
import type {CycSessionEvent} from '../../../types';

const repls = new Map<string, Replicator>();

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
    ...(st.holes.size ? {holes: [...st.holes]} : {})
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
      upsert: (rows, pg) =>
        pg.sealed && wantOf(sessionId).has(pg.page)
          ? replaceShownPage(sessionId, pg, rows)
          : rowStore
              .upsert(sessionId, rows, 'replicator')
              .then((res) => ({loSeq: res.loSeq, hiSeq: res.hiSeq})),
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
  await resetIfStaleAxis(sessionId, r, a);
  await r.attachOk(a);
  // Snap the open window onto the tail the delta just delivered BEFORE the
  // background backfill runs, so every older page the replicator pulls falls
  // below the window and paints nothing.
  await resnapOpenWindow(sessionId);
  if (a.fp) await verifyPages(sessionId, r, a.fp, a.tailPage ?? -1);
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
export function attachFrontier(sessionId: string, heldTail: number): number {
  const r = repls.get(sessionId);
  if (!r) return -1;
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
// how many messages the device lacked there (the gap row's count).
const wanted = new Map<string, Map<number, {print: Print; missingMsgs: number}>>();
// The loop guard: a page refetched once that STILL differs (a row the store
// refuses or folds) is remembered at the engine print it had, and not refetched
// again until that print changes or the app reloads.
const unreconciled = new Map<string, Map<number, string>>();
// The lowest page the last fingerprints covered, so a window that scrolls below
// it asks the engine again (needsVerify).
const verifiedFrom = new Map<string, number>();

function wantOf(sessionId: string): Map<number, {print: Print; missingMsgs: number}> {
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
  verifiedFrom.set(sessionId, fp.from);
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
    want.set(page, {print: eng, missingMsgs: lack});
    if (!r.cursor.holes.has(page)) flagged.push(page);
    r.cursor.holes.add(page);
    missingRows += Math.max(0, eng.n - dev.n);
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
// window reaches, placed right after the newest shown row at or below the run.
function gapMarkers(sessionId: string): CycSessionEvent[] {
  const r = repls.get(sessionId);
  if (!r || !r.cursor.holes.size) return [];
  const shown = rowStore.shownRows(sessionId);
  if (!shown.length) return [];
  const ps = r.cursor.pageSize;
  const pages = [...r.cursor.holes].sort((a, b) => a - b);
  const want = wanted.get(sessionId);
  const out: CycSessionEvent[] = [];
  for (let i = 0; i < pages.length;) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    const lo = pages[i] * ps;
    const hi = (pages[j] + 1) * ps - 1;
    let at: {seq: number; ts: number} | null = null;
    for (const x of shown) if (x.seq <= hi && (!at || x.seq > at.seq)) at = x;
    if (at) {
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
      out.push({uuid: `gap:${lo}`, kind: 'gap', ts: at.ts, seq: lo, text});
    }
    i = j + 1;
  }
  return out;
}

setGapSource(gapMarkers);

// A window that now reaches below the pages the last fingerprints covered: the
// store asks the engine again (one catch-up attach) so the newly shown pages are
// checked too.
export function needsVerify(sessionId: string, shownLowSeq: number): boolean {
  const r = repls.get(sessionId);
  const from = verifiedFrom.get(sessionId);
  if (!r || from === undefined || shownLowSeq < 0) return false;
  return Math.floor(shownLowSeq / r.cursor.pageSize) < from;
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
  verifiedFrom.clear();
}
