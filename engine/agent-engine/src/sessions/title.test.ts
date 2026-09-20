/* What a chat is CALLED: ONE title, and where the string is allowed to come from.
 *
 * His call, 2026-08-06: "each session has just the title and that's it. On the
 * agent engine side have it use Claude's session title and allow renaming. The
 * rename then is our agent-engine-side override for that session."
 *
 * So the two rules this file keeps are the resolution ORDER (override > Claude's
 * own title > pane name) and the fact that there is no second `detail` part any
 * more. The extraction of Claude's title out of the transcript lives in
 * session-events.ts and is exercised here against a fixture jsonl, because a
 * resolver that picks the Claude title is only correct if the Claude title it is
 * handed is the right one.
 *
 *   bun test agent-engine/src/sessions/title.test.ts
 */

import { test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveTitleText, titleOf } from "./title.ts";
import { aiTitleFromLine, readSessionTitle } from "./session-events.ts";
import { tmpDir } from "../test-utils/tmp.ts";

// ------------------------------------------------------------- resolution order

test("your rename wins over everything, including Claude's own title", () => {
  expect(
    resolveTitleText("my name", "Claude's generated title", "herdr-pane"),
    "the override is the word you typed; it must beat both the Claude title and " +
    "the pane name, or a rename would not stick",
  ).toBe("my name");
});

test("with no rename, Claude's own session title is the title", () => {
  expect(
    resolveTitleText(null, "Set up local voice conversations", "herdr-pane"),
    "the sensible default the user never has to set: Claude Code's ai-title, " +
    "used whenever there is no override",
  ).toBe("Set up local voice conversations");
});

test("with neither a rename nor a Claude title, the pane name is the last resort", () => {
  expect(
    resolveTitleText(null, null, "demo-agent"),
    "a brand-new session has no Claude title yet; the pane name is the last-ditch " +
    "fallback so the row shows something, never blank",
  ).toBe("demo-agent");
});

test("a blank or whitespace override falls through, it does not blank the row", () => {
  expect(
    resolveTitleText("   ", "Claude title", "pane"),
    "an empty override is 'no override', not 'a blank title'; it must fall through " +
    "to the Claude title rather than painting an empty row",
  ).toBe("Claude title");
  expect(
    resolveTitleText("", null, "pane"),
    "and with nothing behind it either, all the way down to the pane name",
  ).toBe("pane");
});

test("a blank Claude title falls through to the pane name", () => {
  expect(
    resolveTitleText(null, "   ", "pane"),
    "a whitespace-only ai-title is no title; it must not win over the pane name",
  ).toBe("pane");
});

test("undefined is the same as null at every level", () => {
  /* The three sources come from three different places (a map lookup, a file
   * read, a mux field) and two of them can hand back `undefined` rather than
   * `null`. Treating those differently would make the order depend on which
   * caller asked. */
  expect(resolveTitleText(undefined, "Claude title", "pane")).toBe("Claude title");
  expect(resolveTitleText(undefined, undefined, "pane")).toBe("pane");
  expect(resolveTitleText(null, undefined, "pane")).toBe("pane");
});

test("the winning string is trimmed, but the pane name is passed through as given", () => {
  /* The two chosen sources are trimmed because a rename typed on a phone picks
   * up a trailing space and an ai-title arrives padded. The pane name is the
   * provider's own word and the last resort: it is returned whatever it is, so
   * a provider that hands back an empty pane name gets an empty row rather than
   * this function inventing a title of its own. */
  expect(resolveTitleText("  my name  ", null, "pane")).toBe("my name");
  expect(resolveTitleText(null, "\tClaude title\n", "pane")).toBe("Claude title");
  expect(resolveTitleText(null, null, "  padded pane  ")).toBe("  padded pane  ");
  expect(resolveTitleText(null, null, "")).toBe("");
});

// ------------------------------------------------------------- one part, not three

test("the title has NO detail: it is one string, not workspace · tab · name", () => {
  const t = titleOf("my name", "Claude title", "pane");
  expect(t.text).toBe("my name");
  expect(
    t.detail,
    "his call: 'each session has just the title and that's it.' The dim second " +
    "part is gone; the app draws the single string it is given (title.ts header)",
  ).toBeNull();
});

test("titleOf carries the resolved text and always a null detail", () => {
  expect(titleOf(null, "Claude title", "pane")).toEqual({ text: "Claude title", detail: null });
  expect(titleOf(null, null, "pane")).toEqual({ text: "pane", detail: null });
});

// ------------------------------------------------------------- one record

test("aiTitleFromLine reads the aiTitle field off an ai-title record", () => {
  const line = JSON.stringify({ type: "ai-title", aiTitle: "Count lines in hosts file", sessionId: "s" });
  expect(aiTitleFromLine(line)).toBe("Count lines in hosts file");
});

test("a record that is not an ai-title is not a title", () => {
  expect(aiTitleFromLine(JSON.stringify({ type: "mode", mode: "normal" }))).toBeNull();
  expect(
    aiTitleFromLine(JSON.stringify({ type: "assistant", aiTitle: "not this" })),
    "the word aiTitle on a non-ai-title record must not be mistaken for a title",
  ).toBeNull();
});

test("a half-written ai-title line is skipped rather than thrown", () => {
  const line = JSON.stringify({ type: "ai-title", aiTitle: "Say the word banana", sessionId: "s" });
  expect(aiTitleFromLine(line.slice(0, 30))).toBeNull();
});

test("an ai-title record with nothing in it is not a title", () => {
  /* A blank title must read as "no title" all the way down, or the row shows an
   * empty string where the pane name belongs. Three ways to be blank: missing,
   * empty, whitespace -- plus the wrong TYPE for the field, which a record from
   * a future harness could carry. */
  const rec = (aiTitle: unknown) => JSON.stringify({ type: "ai-title", aiTitle, sessionId: "s" });
  expect(aiTitleFromLine(rec(""))).toBeNull();
  expect(aiTitleFromLine(rec("   "))).toBeNull();
  expect(aiTitleFromLine(rec(null))).toBeNull();
  expect(aiTitleFromLine(rec(42))).toBeNull();
  expect(aiTitleFromLine(JSON.stringify({ type: "ai-title", sessionId: "s" }))).toBeNull();
});

test("the title is trimmed, so a padded record does not pad the row", () => {
  expect(aiTitleFromLine(JSON.stringify({ type: "ai-title", aiTitle: "  Set up voice  " })))
    .toBe("Set up voice");
});

test("a line that merely mentions ai-title is not a title", () => {
  // the cheap substring test is a FILTER, not the decision: a prompt about the
  // record itself must not name the session after its own words
  const line = JSON.stringify({
    type: "user", promptId: "p", uuid: "u",
    message: { content: 'what writes the "ai-title" record?' },
  });
  expect(aiTitleFromLine(line)).toBeNull();
  expect(aiTitleFromLine("")).toBeNull();
  expect(aiTitleFromLine("not json at all")).toBeNull();
});

// --------------------------------------------------------------- the file

const aiTitle = (t: string): string =>
  JSON.stringify({ type: "ai-title", aiTitle: t, sessionId: "s" });

const filler = (): string =>
  JSON.stringify({
    type: "user", uuid: `f${Math.random()}`, promptId: "p",
    timestamp: new Date().toISOString(), message: { content: "x".repeat(4000) },
  });

async function transcript(lines: string[]): Promise<string> {
  const dir = await tmpDir("titleprobe-");
  const path = join(dir, "session.jsonl");
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

test("the title is extracted from a real session file", async () => {
  const path = await transcript([
    JSON.stringify({ type: "mode", mode: "normal" }),
    aiTitle("Set up local voice conversations with Claude Code over Tailscale"),
    filler(),
  ]);
  expect(await readSessionTitle(path)).toBe(
    "Set up local voice conversations with Claude Code over Tailscale",
  );
});

test("the NEWEST ai-title wins, because Claude re-writes it as the session grows", async () => {
  /* Measured on this machine: a busy transcript re-emits ai-title up to ~2,900
   * times, and the newest copy is the one that names the session now. */
  const path = await transcript([
    aiTitle("first guess at the title"),
    filler(),
    aiTitle("the title after Claude thought again"),
  ]);
  expect(await readSessionTitle(path)).toBe("the title after Claude thought again");
});

test("a session with no ai-title yet answers null, so the caller falls back to the pane name", async () => {
  const path = await transcript([
    JSON.stringify({ type: "mode", mode: "normal" }),
    filler(),
  ]);
  expect(await readSessionTitle(path)).toBeNull();
});

test("a missing session file answers null", async () => {
  const dir = await tmpDir("titleprobe-");
  expect(await readSessionTitle(join(dir, "no-such-session-file.jsonl"))).toBeNull();
});

test("an empty session file answers null rather than an empty title", async () => {
  // a transcript that exists but has nothing in it yet is the first instant of
  // a brand-new pane; the row falls through to the pane name, never to ""
  const path = await transcript([]);
  expect(await readSessionTitle(path)).toBeNull();
  expect(resolveTitleText(null, await readSessionTitle(path), "pane")).toBe("pane");
});

test("a BLANK newest ai-title falls back to the newest real one", async () => {
  /* Claude has been seen writing an ai-title record with an empty value. The
   * line-level reader answers null for it, and the backward scan therefore
   * keeps walking rather than stopping -- otherwise one blank record would
   * un-name a session that has had a perfectly good title for an hour. */
  const path = await transcript([
    aiTitle("Wire up the git pane"),
    filler(),
    JSON.stringify({ type: "ai-title", aiTitle: "   ", sessionId: "s" }),
  ]);
  expect(await readSessionTitle(path)).toBe("Wire up the git pane");
});

test("an ai-title far from the end is still found once the window grows", async () => {
  /* The 256 KB first window is not the guarantee. An ai-title near the head
   * followed by a long silent stretch with no re-emit must still be found by the
   * grown window, or a long session would read as untitled and drop to its pane
   * name. */
  const path = await transcript([
    aiTitle("titled early, then a long quiet tail"),
    ...Array(400).fill(filler()),
  ]);
  expect(await readSessionTitle(path)).toBe("titled early, then a long quiet tail");
});

// -------------------------------------------------------- resolver over the file

test("the file title flows through the resolver: no override means Claude's title shows", async () => {
  const path = await transcript([aiTitle("Process voice clips and phone interaction")]);
  const claudeTitle = await readSessionTitle(path);
  expect(resolveTitleText(null, claudeTitle, "demo-agent")).toBe(
    "Process voice clips and phone interaction",
  );
  expect(
    resolveTitleText("Voice pipeline", claudeTitle, "demo-agent"),
    "and a rename on top of a real Claude title still wins",
  ).toBe("Voice pipeline");
});
