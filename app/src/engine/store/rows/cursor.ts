// The replicator's cursor, pure. The cursor is the replicator's private
// bookkeeping of how far its background backfill has reached; it is NOT a UI
// concept. The UI reads whatever rows the store holds in a seq window, cursor
// or no cursor (that decoupling is the one rule: the screen renders from the
// store, never from sync progress).
//
// Fill is newest-first: the replicator pulls the tail page, then each page
// below it, so the covered region is a contiguous run of pages ending at the
// tail. The cursor is the floor of that run. A demand hint (the UI scrolled to
// a range the store lacks) fetches an out-of-band page early; that page is
// stored and readable at once, but it becomes part of the contiguous run only
// when the ordered backfill reaches it. The cursor advances only over committed
// pages, so an interruption resumes exactly where it left off.

export type CursorState = {
  // page arithmetic
  pageSize: number;
  // highest page the engine has (from attach-ok tail/pointer). -1 = unknown.
  tailPage: number;
  // the engine's tail version, watched for a seq-axis renumber across restarts.
  tailVersion: number;
  // the lowest page of the contiguous covered run ending at tailPage. When it
  // reaches 0 the history is fully backfilled. Infinity = nothing covered yet.
  coveredFrom: number;
  // pages fetched out of the contiguous order (demand hints), waiting for the
  // backfill to connect them into the covered run.
  islands: Set<number>;
  // pages the UI has asked for out of order, highest priority first.
  demand: number[];
};

export function emptyCursor(pageSize: number): CursorState {
  return {
    pageSize,
    tailPage: -1,
    tailVersion: 0,
    coveredFrom: Infinity,
    islands: new Set(),
    demand: []
  };
}

// The cursor as a seq: the floor of the contiguous covered run. -1 when nothing
// is covered yet; 0 (meaning "every page down to the first is stored") once the
// backfill completes. Persisted in meta and re-validated on the next attach.
export function cursorSeq(st: CursorState): number {
  if (!Number.isFinite(st.coveredFrom)) return -1;
  return st.coveredFrom * st.pageSize;
}

export function isComplete(st: CursorState): boolean {
  return st.tailPage >= 0 && st.coveredFrom <= 0;
}

// A page committed to the store. Fold it into the covered run: if it extends the
// run downward (or is the very first covered page at the tail), move the floor
// down and absorb any islands that now connect. A page above the current run
// (a live tail growing) also extends it upward implicitly through tailPage.
// Returns the state (mutated) for chaining.
export function notePageCommitted(st: CursorState, page: number): CursorState {
  if (page < 0) return st;
  if (!Number.isFinite(st.coveredFrom)) {
    // first covered page: it seeds the run only if it is the tail page (the
    // newest-first fill always starts at the tail). A demand-first page becomes
    // an island until the tail is covered.
    if (st.tailPage < 0 || page === st.tailPage) {
      st.coveredFrom = page;
      absorbIslands(st);
    } else {
      st.islands.add(page);
    }
    return st;
  }
  if (page >= st.coveredFrom && page <= st.tailPage) {
    // already inside the covered run (an idempotent re-fetch): nothing moves.
    return st;
  }
  if (page === st.coveredFrom - 1) {
    st.coveredFrom = page;
    absorbIslands(st);
    return st;
  }
  if (page > st.tailPage) {
    // the tail grew past what we thought; extend the ceiling and keep the floor.
    st.tailPage = page;
    return st;
  }
  // a non-adjacent older page (a demand hint): hold it as an island.
  st.islands.add(page);
  return st;
}

function absorbIslands(st: CursorState): void {
  for (;;) {
    const next = st.coveredFrom - 1;
    if (next >= 0 && st.islands.has(next)) {
      st.islands.delete(next);
      st.coveredFrom = next;
      continue;
    }
    break;
  }
}

// The next page the ordered backfill should pull: a pending demand hint first
// (the UI is waiting on it), else the page just below the covered run, else the
// tail page when nothing is covered yet. null when there is nothing left to do.
export function nextPage(st: CursorState): number | null {
  while (st.demand.length) {
    const d = st.demand[0];
    if (isPageStored(st, d)) {
      st.demand.shift();
      continue;
    }
    return d;
  }
  if (st.tailPage < 0) return null;
  if (!Number.isFinite(st.coveredFrom)) return st.tailPage;
  if (st.coveredFrom <= 0) return null;
  return st.coveredFrom - 1;
}

function isPageStored(st: CursorState, page: number): boolean {
  if (Number.isFinite(st.coveredFrom) && page >= st.coveredFrom && page <= st.tailPage) return true;
  return st.islands.has(page);
}

// The UI asked for a range the store did not have: prioritize the pages that
// cover it. Deduped, kept in ascending demand order (oldest UI request first).
export function addDemand(st: CursorState, page: number): void {
  if (page < 0) return;
  if (isPageStored(st, page)) return;
  if (!st.demand.includes(page)) st.demand.push(page);
}

// The engine's tail moved to a new version (a restart renumbered the seq axis,
// or new rows landed). When the VERSION regressed or the tail page shifted under
// a covered run, the covered region can no longer be trusted by seq: mark it
// dirty so the replicator re-pulls. Upserts by mid make the re-pull convergent.
// A pure decision so it gets exhaustive tests around real renumber cases.
export function renumberDirty(st: CursorState, engineTailVersion: number): boolean {
  if (!Number.isFinite(st.coveredFrom)) return false;
  return engineTailVersion < st.tailVersion;
}

// Re-seat the cursor after a renumber: keep the tail bookkeeping the attach just
// gave, drop the covered run and islands (they will be re-pulled and re-upserted
// by mid, converging without twins).
export function resetCoverage(st: CursorState, tailPage: number, tailVersion: number): void {
  st.tailPage = tailPage;
  st.tailVersion = tailVersion;
  st.coveredFrom = Infinity;
  st.islands.clear();
}
