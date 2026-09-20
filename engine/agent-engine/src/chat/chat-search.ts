/* THE ONE NEUTRAL CHAT MATCHER, a CORE LEAF.
 *
 * Moved out of plugins/search/index.ts so CORE no longer imports a plugin for its own
 * matcher (server.ts's PluginCore.searchChat and routes/chat.ts's /chat-search
 * both read it here). ONE SCAN, EVERY CALLER: the HTTP route (the native bar's
 * data path, and older apps) and the search plugin's `query` rpc (via
 * PluginCore.searchChat) call the SAME scanChat/normalizeQuery, so the count and
 * the matches cannot drift into two subtly different answers. The route and the
 * rpc paginate differently, but they agree on WHAT matches.
 *
 * Nothing here imports the engine's ChatMsg shape: `textOf` is supplied by the
 * caller. Kept verbatim from the plugin so no answer changed by a byte.
 *
 *   bun test agent-engine/src/chat/search.test.ts
 */

/* THE CAPS, shared so the route and the rpc cannot disagree about them. */
export const Q_MAX = 200; // longer than this is a paste, not a search
export const EXCERPT = 120; // characters of the matched body shown

export type ScanRow = { seq: number; ts: number; role: "user" | "claude"; excerpt: string };

/* Trim, cap and lowercase a raw query, once, for every caller. An empty result
 * means "nothing typed": the route answers 400 and the rpc answers an empty set,
 * so "I have not typed anything" and "matched nothing" never look the same. */
export function normalizeQuery(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, Q_MAX).toLowerCase();
}

/* Scan the whole log for `q` (already normalized, non-empty) and return EVERY
 * match in LOG ORDER (oldest first), each carrying its `seq` (the page address a
 * jump travels by). Pagination is the caller's: the route keeps the newest
 * window, the rpc reverses and pages. `textOf` is the searchable text of a
 * message (its text, or an attachment's name) -- supplied by the caller so this
 * stays free of the engine's ChatMsg shape. */
export function scanChat<T extends { seq?: number; ts: number; role: "user" | "claude" }>(
  chat: readonly T[],
  textOf: (c: T) => string,
  q: string,
): { total: number; matches: ScanRow[]; scanned: number } {
  const matches: ScanRow[] = [];
  for (const c of chat) {
    const body = textOf(c);
    if (!body.toLowerCase().includes(q)) continue;
    matches.push({ seq: c.seq ?? 0, ts: c.ts, role: c.role, excerpt: body.slice(0, EXCERPT) });
  }
  return { total: matches.length, matches, scanned: chat.length };
}
