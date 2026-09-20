/* HOW THIS HOST'S CONVERSATIONS ARE GROUPED, and who gets to say so.
 *
 * Its own module for the same reason title.ts and order.ts are: this is a SEAM.
 * Until now the app decided the grouping and there was only one answer it could
 * give -- one engine is one tab -- because the tab strip was built out of the
 * app's own list of configured engines. That is a fact about how the app was
 * wired, not a fact about how anybody wants their work laid out, and it is not
 * something the app can be right about: the app cannot know that two of the
 * panes on this machine are a different piece of work from the other five.
 *
 * So the ENGINE declares its tabs and the app renders exactly what it is given.
 * The two shapes he asked for are both this module, with one setting between
 * them and no app change at all:
 *
 *   ENGINE_TABS unset (or "off")   one list, exactly as it has always been
 *   ENGINE_TABS=workspace          one tab per herdr workspace
 *
 * A TAB IS NAMED THE WAY A ROW IS NAMED. `title` here is title.ts's
 * SessionTitle, the same {text, detail} the app already renders on every row,
 * built by the same titleOf(). There is one naming scheme in this system and
 * this is it; a tab that invented a second one would be a second answer to the
 * question "what does the engine call things", and two answers to one question
 * drift apart.
 *
 * WHAT GOES ON THE WIRE, and why the "off" case sends nothing. Declaring
 * nothing is not a special case being kept alive by hand: it is the honest
 * answer, because the app already has a name for a host that has not grouped
 * itself (the machine, or the user when two engines share a machine) and this
 * module cannot compute it -- an engine cannot know that another engine on the
 * same host is also connected. So "off" says nothing and the app falls back to
 * the one thing it knows better than the engine does. Every engine that
 * predates this file is in exactly that state, which is what makes it a
 * compatibility rule rather than a branch.
 */

import { titleOf, type SessionTitle } from "./title.ts";

/** One tab, as the strip will draw it. */
export type TabDecl = {
  /** Stable within this engine. Never shown; the app namespaces it and keys
   *  its order and its remembered selection on the result. */
  key: string;
  title: SessionTitle;
};

/** What decides which tab a session belongs to. */
export type Grouping = "off" | "workspace";

/** Every grouping this engine knows how to do, for the error message. */
export const GROUPINGS: Grouping[] = ["off", "workspace"];

/**
 * Read the setting, refusing to guess.
 *
 * An unset value is "off", which is what every engine did before this existed.
 * A value that is not a grouping is a TYPO and it is loud: silently falling
 * back to "off" would mean ENGINE_TABS=workspaces (plural, the obvious slip)
 * looks exactly like not having asked for anything, and he would be looking at
 * one tab wondering why the engine ignored him.
 */
export function groupingFrom(raw: string | undefined | null): Grouping {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "off";
  if ((GROUPINGS as string[]).includes(v)) return v as Grouping;
  console.error(
    `[tabs] ENGINE_TABS=${JSON.stringify(raw)} is not a grouping this engine knows. ` +
      `Known: ${GROUPINGS.join(", ")}. Declaring no tabs, so the app shows this host as one list.`,
  );
  return "off";
}

/** What a session has to carry for this module to group it. */
export type Groupable = {
  /** The provider's grouping label; herdr's workspace. */
  workspace: string;
};

/**
 * Which tab a session sits in.
 *
 * "" means "this engine declared no tabs", and it is the same empty string for
 * every session, so a client that groups by this field gets one group without
 * having to know that "off" exists.
 *
 * The workspace LABEL is the key, not herdr's workspace id. The id would
 * survive a rename and the label does not -- but the id is herdr's vocabulary,
 * it is meaningless the moment the provider changes, and a renamed workspace
 * genuinely is a different tab to the person looking at the strip. What is lost
 * by a rename is the tab's place in the drag order and its remembered chat,
 * which is the same thing that is lost when a workspace is closed and remade.
 */
export function tabKeyOf(s: Groupable, grouping: Grouping): string {
  if (grouping === "off") return "";
  return s.workspace ?? "";
}

/**
 * The tabs this engine is declaring, left to right.
 *
 * Order is the order the sessions arrive in, which is already the order the
 * list is in (order.ts: what he dragged, then herdr's own). So the strip reads
 * in the same order as the rows underneath it, and a tab first appears where
 * its first session already was.
 *
 * EVERY SESSION'S TAB IS IN HERE. That is the property this function exists to
 * hold: a declaration that omits a tab some session claims would leave those
 * rows with nowhere to be drawn, and a row that exists and is not on any screen
 * is the worst of the two failures available here. Derived from the sessions
 * rather than from herdr's workspace list for exactly that reason -- a
 * workspace with no agent in it is not a conversation list, and a pane whose
 * workspace herdr has not told us about still has to be somewhere.
 */
export function declareTabs(items: readonly Groupable[], grouping: Grouping): TabDecl[] {
  if (grouping === "off") return [];
  const out: TabDecl[] = [];
  const seen = new Set<string>();
  for (const s of items) {
    const key = tabKeyOf(s, grouping);
    if (seen.has(key)) continue;
    seen.add(key);
    /* An unnamed group is still a group, and it needs something on the tab.
     * herdr gives every workspace a label or a number, so this is the case
     * where the snapshot has not told us yet rather than a routine one. A tab
     * has neither a rename override nor a Claude title: its one string is the
     * workspace label itself, so it is the pane-name (last-resort) argument. */
    out.push({ key, title: titleOf(null, null, key || "elsewhere") });
  }
  return out;
}
