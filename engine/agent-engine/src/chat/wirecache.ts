/* WIRE-ROWS CACHE INVALIDATION (the pages-without-rebuild fix).
 *
 * `wireRows` (attach.ts) merges a session's messages and its session records
 * onto one seq axis and maps every row to its wire shape. That merge is the
 * same for every page of one conversation and changes only when the log does,
 * yet it was rebuilt on EVERY attach and EVERY page fetch: a device pulling a
 * long chat's pages redid the whole 100k-row merge once per 100-row page.
 *
 * This is the invalidation half of the cache. One generation counter rides on
 * the session; it is bumped at every place that mutates `s.chat`, `s.log`, or
 * a row's fields (append, edit, status change, delete, seq repair by a reload,
 * trim, absorb, backfill). attach.ts caches the merged rows against this
 * counter and reuses them until it moves, so a page fetch is a binary search
 * over a merge it already has rather than a fresh scan of the whole log.
 *
 * WHY A COUNTER, not an identity or length check: an edit patches a row in
 * place (a dequeue, a grown clip finalising) without adding, removing or
 * reordering anything, so neither the array identity nor its length moves.
 * The counter is bumped at the mutation itself, so it catches every change a
 * length check would miss. Every writer to s.chat / s.log is listed in the
 * fix's report; each calls through here.
 *
 * The counter's absolute value is meaningless; only that it differs from the
 * value the cache was built at. A session rebuilt with a fresh object (a
 * reconcile tick) starts at 0 with no cache, reads the (carried) arrays once
 * and caches again, which is correct because the object is new. */

/** A session, seen only as the thing that carries the wire-rows generation. */
export type RowsGenerational = { rowsGen?: number };

/** Record that this session's rows changed: attach.ts's cache is now stale. */
export function bumpRowsGen(s: RowsGenerational): void {
  s.rowsGen = (s.rowsGen ?? 0) + 1;
}
