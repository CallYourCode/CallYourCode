/* The one page size, shared by the engine that seals pages and the app that
 * asks for them. The app used to keep its own copy of this
 * literal; a drift between the two would put the app's page arithmetic on a
 * different grid than the engine's sealed pages.
 *
 * THE ONE RULE (runtime/pages.ts owns the arithmetic): a page below the tail is
 * SEALED and immutable forever. Page N holds the messages whose seq is in
 * [N*PAGE_SIZE, N*PAGE_SIZE + PAGE_SIZE - 1]. */
export const PAGE_SIZE = 100;

/* One row's term in a page fingerprint (fix-sync-gap). The engine's attach-ok
 * (chat/attach.ts pagePrints) and the app's store (rowStore.pagePrints) each sum
 * it over the rows of a page, so both weight a row by its offset on the page and
 * its edit count (rev) the same way: a missing, extra, moved or stale row moves
 * the sum. */
export function printTerm(offset: number, rev: number): number {
  return (offset + 1) * 1009 + rev;
}
