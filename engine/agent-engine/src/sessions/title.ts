/* What a chat is CALLED: exactly ONE title, resolved on the engine.
 *
 * Its own module because it is a SEAM, not a helper. Everything else about a
 * title is provider vocabulary (a herdr pane name, a directory a headless
 * harness was pointed at, Claude Code's own generated title) and the app is not
 * allowed to know any of it: the whole test for this boundary is "could you swap
 * herdr for tmux, and claude for something else, without editing the app". A
 * title composed in the app failed that test, so it is composed here.
 *
 * His call, 2026-08-06: "why does the title have 3 parts. lets keep it simple,
 * each session has just the title and that's it. On the agent engine side have
 * it use Claude's session title and allow renaming. The rename then is our
 * agent-engine-side override for that session."
 *
 * So the title is ONE string, and three sources answer for it in a FIXED order:
 *
 *   1. the RENAME OVERRIDE you typed (nameOverrides) -- your word wins over
 *      everything; clearing it falls through to the next source;
 *   2. CLAUDE CODE'S OWN session title -- the `ai-title` record it writes into
 *      the transcript (session-events.ts reads it), the sensible default the
 *      user never has to set;
 *   3. the PANE NAME the provider gave us (herdr's), the last-ditch fallback so
 *      a brand-new session with no Claude title yet still shows something, never
 *      blank.
 *
 * There is NO second `detail` part any more. The title used to carry a dim
 * `workspace · tab` suffix and drew "demo · admin · demo-agent", three
 * facts where he wanted one. `detail` stays on the wire as a nullable field --
 * the app still reads it, and a MODIFIER of this engine (his #325: the engine is
 * the public, modifiable layer) could group by git root or anything else and
 * send a two-part title -- but the default policy here never fills it: the app
 * draws the single string it is given.
 *
 *   bun test agent-engine/src/sessions/title.test.ts
 */

export type SessionTitle = {
  text: string;
  detail: string | null;
};

/** The single display title for a session, resolved in priority order.
 *
 * @param override    the name you typed (nameOverrides), or null/empty for none.
 * @param claudeTitle Claude Code's own session title, or null when it has not
 *                    written one yet (a fresh session) or it cannot be read.
 * @param paneName    the provider's pane name, always present, the last resort.
 *
 * Empty and whitespace-only strings count as "no answer" at each level, so a
 * blank override does not blank the row -- it falls through to the next source.
 */
export function resolveTitleText(
  override: string | null | undefined,
  claudeTitle: string | null | undefined,
  paneName: string,
): string {
  const pick = (s: string | null | undefined) =>
    typeof s === "string" && s.trim() ? s.trim() : null;
  return pick(override) ?? pick(claudeTitle) ?? paneName;
}

/** The wire shape the app renders: one `text`, and `detail` always null under
 * the default policy (see the file header for why the field survives). */
export function titleOf(
  override: string | null | undefined,
  claudeTitle: string | null | undefined,
  paneName: string,
): SessionTitle {
  return { text: resolveTitleText(override, claudeTitle, paneName), detail: null };
}
