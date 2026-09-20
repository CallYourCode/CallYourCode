/* The one page size, shared by the engine that seals pages and the app that
 * asks for them. The app used to keep its own copy of this
 * literal; a drift between the two would put the app's page arithmetic on a
 * different grid than the engine's sealed pages.
 *
 * THE ONE RULE (runtime/pages.ts owns the arithmetic): a page below the tail is
 * SEALED and immutable forever. Page N holds the messages whose seq is in
 * [N*PAGE_SIZE, N*PAGE_SIZE + PAGE_SIZE - 1]. */
export const PAGE_SIZE = 100;
