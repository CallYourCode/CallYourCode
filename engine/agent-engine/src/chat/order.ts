/* The order you dragged the chats into.
 *
 * Its own module for the same reason title.ts is: this is a SEAM. Until now the
 * only order a session had was `order: i` out of herdr's "spaces" sort, which
 * is a fact about how a terminal multiplexer numbers its panes and not about
 * how you want your conversations stacked. herdr renumbers on its own schedule,
 * so the list moved under you and you could not put it back.
 *
 * THE ORDER LIVES ON THE ENGINE, ONE PER HOST, exactly like the read marker:
 * there is one piece of state and every device is a view of it.
 * Arrange the list on the phone and the tablet is arranged a moment later.
 * Three devices each keeping their own arrangement is the bug class this
 * project keeps re-learning.
 *
 * What is stored is a list of session ids and nothing else. Not indices, which
 * go wrong the instant a pane is created or closed; not a number per session,
 * which needs renumbering and can collide. A list is also the only shape where
 * "remove one" is obviously non-destructive to the rest, which is the property
 * that matters most here.
 */

/** How many ids we are willing to remember. Panes come and go all day and the
 *  list is kept lossy on purpose: a name you dragged two months ago is not
 *  worth a file that grows forever. Far more than any host has open at once. */
export const MAX_REMEMBERED = 500;

/** Read the file back into a list, refusing anything that is not a list of
 *  non-empty strings. A corrupt or half-written file must degrade to "no manual
 *  order" (herdr's order, the old behaviour) rather than to a crash at boot. */
export function parseOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string" || !v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_REMEMBERED) break;
  }
  return out;
}

/**
 * The list to persist after a drop.
 *
 * The app sends the WHOLE order it is now showing, not a diff, so `asked` is
 * authoritative for every id it names. Ids we remember but that the app did not
 * mention are kept, appended after: they are panes that have gone away since
 * you arranged them, and dropping them would mean a pane that comes back lands
 * at the bottom having already been placed once. Keeping them costs one string.
 *
 * @param remembered what is on disk now
 * @param asked      the order the app just dropped into place
 */
export function nextOrder(remembered: string[], asked: string[]): string[] {
  const wanted = parseOrder(asked);
  const seen = new Set(wanted);
  const out = [...wanted];
  for (const id of remembered) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_REMEMBERED) break;
  }
  return out;
}

/**
 * Sort sessions the way the list should read.
 *
 * Two rules, and the second one is the one that keeps this liveable:
 *
 *   1. a session you have placed sorts where you placed it;
 *   2. a session you have NOT placed goes after all of them, keeping herdr's
 *      relative order among itself and the others like it.
 *
 * Rule 2 is why a pane herdr made a second ago appears at the bottom instead of
 * teleporting into the middle of an arrangement you are looking at. It also
 * means the very first time you ever drag anything, everything below the rows
 * you touched stays exactly where it was.
 *
 * Removing a session cannot disturb the rest, because no other session's key
 * mentions it: the placed ones keep their own index and the unplaced ones keep
 * herdr's number. That is the whole reason the stored thing is a list of ids.
 */
export function sortSessions<T extends { id: string; order: number }>(
  items: readonly T[],
  manual: readonly string[],
): T[] {
  const placed = new Map<string, number>();
  manual.forEach((id, i) => { if (!placed.has(id)) placed.set(id, i); });
  return [...items].sort((a, b) => {
    const pa = placed.get(a.id);
    const pb = placed.get(b.id);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    // placed beats unplaced: a new pane goes below the arrangement, never into it
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return a.order - b.order; // both unplaced: herdr's order, as before
  });
}
