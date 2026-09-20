/* Reading a blocked session's question off its screen.
 *
 * EVERY FIXTURE HERE WAS CAPTURED FROM A LIVE PANE, not written by hand:
 * `herdr pane read <pane> --source visible` against Claude Code v2.1.220 under
 * herdr 0.7.4 on 2026-08-04, for each of the four shapes herdr's manifest
 * actually calls `blocked`. That matters more than usual: this parser exists
 * because there is no structured source for the question, so a fixture somebody
 * imagined would test the imagination rather than the terminal.
 *
 *   bun test agent-engine/src/terminal/blocked.test.ts
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import { parseAsk, stripPaneControls, flat, tailVisible } from "./blocked.ts";
import { SGR } from "./herdr.ts";

/* THE /model PICKER, off a live Claude Code 2.1.222 at three widths.
 *
 * Captured on a throwaway tmux server in its own directory (`tmux -L
 * cyc254probe`, `tmux capture-pane -p -e`), never one of his panes -- see
 * fixtures/README.md. The engine strips the colour before parsing (readAskNow),
 * so these do too, and from the same regex rather than a second copy of it. */
const picker = async (name: string) =>
  (await Bun.file(join(import.meta.dir, "..", "fixtures", name)).text()).replace(SGR, "");
const MODEL_PICKER_100 = await picker("pane-model-picker-2.1.222-100col.txt");
const MODEL_PICKER_60 = await picker("pane-model-picker-2.1.222-60col.txt");
const MODEL_PICKER_AFTER_TURN = await picker("pane-model-picker-2.1.222-after-turn.txt");

// ------------------------------------------------------------ the four shapes

/* A tool permission prompt (herdr rule: legacy_no_prompt_blocker).
 * Note the file preview fenced in DASHED rules, whose "  1 banana" line is a
 * numbered diff row and must never be read as a choice. */
const WRITE_PERMISSION = [
  "",
  "",
  "⏺ hello-from-lane",
  "",
  "✻ Cooked for 4s",
  "",
  "❯ Create a file called note.txt containing the word banana",
  "",
  "⏺ Write(note.txt)",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  " Create file",
  " note.txt",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  "  1 banana",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " Do you want to create note.txt?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session (shift+tab)",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

/* A bash permission prompt (herdr rule: generic_permission_prompt). */
const BASH_PERMISSION = [
  "  The note.txt write was rejected earlier, let me know if you want me to retry",
  "  it or skip it.",
  "",
  "✻ Sautéed for 4s",
  "",
  "❯ Run this bash command with timeout 5000: touch /tmp/blocked-lane-outside.txt",
  "",
  "⏺ Running 1 shell command…",
  "  ⎿  $ touch /tmp/blocked-lane-outside.txt",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   touch /tmp/blocked-lane-outside.txt",
  "   Create empty file in /tmp",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to tmp/ from this project",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

/* An AskUserQuestion form (herdr rule: live_blocked_form).
 * The awkward one: the prompt box's own border is a SOLID rule sitting between
 * choice 4 and choice 5, so a run of choices cannot be ended by a rule. */
const ASK_USER_QUESTION = [
  "",
  "",
  "✻ Baked for 27s",
  "",
  "❯ Use the AskUserQuestion tool to ask me which colour I prefer, options red",
  "  green blue.",
  "────────────────────────────────────────────────────────────────────────────────",
  " ☐ Colour",
  "",
  "Which colour do you prefer?",
  "",
  "❯ 1. Red",
  "     Warm, high-contrast.",
  "  2. Green",
  "     Natural, easy on the eyes.",
  "  3. Blue",
  "     Cool, calm.",
  "  4. Type something.",
  "────────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

/* A plan approval (herdr rule: legacy_no_prompt_blocker).
 * The question wraps over two lines, and choice 4 opens a text field. */
const PLAN_APPROVAL = [
  "",
  "╭─── Claude Code v2.1.220 ─────────────────────────────────────────────────────╮",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "",
  "  ────────────────────────────────────────────────────────────────────────────",
  "   Ready to code?",
  "",
  "   Here is Claude's plan:",
  "  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  "   Add a hello world Python script",
  "                                                                              ↓",
  "  ────────────────────────────────────────────────────────────────────────────",
  "   Claude has written up a plan and is ready to execute. Would you like to",
  "   proceed?",
  "",
  "   ❯ 1. Yes, and use auto mode",
  "     2. Yes, manually approve edits",
  "     3. No, refine with Ultraplan on Claude Code on the web",
  "     4. Tell Claude what to change",
  "        shift+tab to approve with this feedback",
  "",
  "   ctrl+g to edit in Micro · ~/.claude/plans/plan-how-to-add-cached-valley.md",
].join("\n");

/* THE PAIR THAT PROVES THE FINGERPRINT HAS TO COVER THE CONTEXT.
 *
 * Two READ permission prompts for two files in one directory, captured live and
 * seconds apart. The question is identical, all three choices are identical
 * (choice 2 names the DIRECTORY, not the file), and the only line anywhere that
 * says which file is being read is in the context.
 *
 * A fingerprint over question + choices makes these the same decision. That was
 * shipped, and it pressed "1. Yes" against beta.txt using an answer he had
 * given for alpha.txt -- and since the status never left `blocked` and the
 * dialog dismissed, the after-check passed and it wrote "↩ Yes" into his
 * transcript for a file he never saw. */
const READ_ALPHA = [
  "❯ Read the file /tmp/ab-outside/alpha.txt",
  "",
  "⏺ I'll read that file.",
  "",
  "  Reading 1 file…",
  "  ⎿  /tmp/ab-outside/alpha.txt",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  " Read file",
  "",
  "  Read(/tmp/ab-outside/alpha.txt)",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, allow reading from ab-outside/ during this session",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

const READ_BETA = [
  "❯ Read the file /tmp/ab-outside/beta.txt",
  "",
  "  Reading 1 file…",
  "  ⎿  /tmp/ab-outside/beta.txt",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  " Read file",
  "",
  "  Read(/tmp/ab-outside/beta.txt)",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, allow reading from ab-outside/ during this session",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

/* A pane that finished its turn and asked a question IN PROSE. herdr calls this
 * idle/done, not blocked, and this file agrees: there is no dialog. */
const PROSE_QUESTION = [
  "⏺ Green it is.",
  "",
  "  The note.txt write was rejected earlier, let me know if you want me to retry",
  "  it or skip it.",
  "",
  "✻ Sautéed for 4s",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────",
  "  O5 · high · ctx 3% · example · 5h 4% · 7d 63% · $0                        /rc",
  "  ⏸ manual mode on",
].join("\n");

// ------------------------------------------------------------- what it reads

test("a tool permission prompt: the question, the file it is about, and three choices", () => {
  const ask = parseAsk(WRITE_PERMISSION)!;
  expect(ask).not.toBeNull();
  expect(ask.question).toBe("Do you want to create note.txt?");
  expect(ask.choices.map((c) => c.label)).toEqual([
    "Yes",
    "Yes, allow all edits during this session (shift+tab)",
    "No",
  ]);
  expect(ask.choices.map((c) => c.n)).toEqual([1, 2, 3]);
  // what it is asking about, so nobody has to answer blind
  expect(ask.context.join("\n")).toContain("Create file");
  expect(ask.context.join("\n")).toContain("note.txt");
  expect(ask.context.join("\n")).toContain("banana");
});

test("a numbered diff row inside the preview is not a choice", () => {
  // "  1 banana" has a number and no dot. If it were read as choice 1 the
  // dialog would be off by one and "Yes" would be reachable by pressing 2.
  const ask = parseAsk(WRITE_PERMISSION)!;
  expect(ask.choices).toHaveLength(3);
  expect(ask.choices[0]!.label).toBe("Yes");
});

test("a bash permission prompt carries the command itself", () => {
  const ask = parseAsk(BASH_PERMISSION)!;
  expect(ask.question).toBe("Do you want to proceed?");
  expect(ask.choices).toHaveLength(3);
  expect(ask.choices[2]!.label).toBe("No");
  expect(ask.context.join("\n")).toContain("touch /tmp/blocked-lane-outside.txt");
  expect(ask.context.join("\n")).toContain("Bash command");
});

test("an AskUserQuestion form: five choices across a rule, each with its blurb", () => {
  const ask = parseAsk(ASK_USER_QUESTION)!;
  expect(ask.question).toBe("Which colour do you prefer?");
  expect(ask.choices.map((c) => c.label)).toEqual([
    "Red",
    "Green",
    "Blue",
    "Type something.",
    "Chat about this",
  ]);
  expect(ask.choices[0]!.detail).toBe("Warm, high-contrast.");
  expect(ask.choices[2]!.detail).toBe("Cool, calm.");
});

test("the dialog's own footer is not the last choice's description", () => {
  // "Enter to select · ↑/↓ to navigate · Esc to cancel" sits a blank line under
  // choice 5. Read as its description it would put keyboard help in a button.
  const ask = parseAsk(ASK_USER_QUESTION)!;
  expect(ask.choices[4]!.detail).toBeUndefined();
});

test("a plan approval: the wrapped question is one sentence, the plan is the context", () => {
  const ask = parseAsk(PLAN_APPROVAL)!;
  expect(ask.question).toBe(
    "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  );
  expect(ask.choices).toHaveLength(4);
  expect(ask.context.join("\n")).toContain("Ready to code?");
  expect(ask.context.join("\n")).toContain("Add a hello world Python script");
});

// --------------------------------------------------------- the /model picker

/* THE SCREEN THIS FILE WAS WRONG ABOUT, and the shape of being wrong is the one
 * that keeps coming back: the app naming a reason it did not have.
 *
 * The picker draws no horizontal rule of its own, so classifyPaneBox has no box
 * to find and hands the whole screen to this parser. This parser answered null,
 * which made the verdict `unknown`, which made the app tell him "the terminal is
 * showing something this app could not read" -- about a screen it had read
 * perfectly, six models and all. It is on 2.1.222 that the picker gained a
 * sixth model and the app started saying it, but nothing here is version bait:
 * the three rows that broke it are drawn at every width and every version
 * captured.
 *
 * WHAT IT ACTUALLY SHOWS, 100 columns, byte for byte under the colour:
 *
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
 *      Select model
 *      Switch between Claude models. Your pick becomes the default for new …
 *
 *      ❯ 1. Default (recommended) ✔  Opus 5 with 1M context · Best for …
 *        2. Opus (1M context)        Opus 5 with 1M context · Best for …
 *        3. Fable                    Fable 5 · Most capable for your …
 *        4. Sonnet                   Sonnet 5 · Efficient for routine tasks
 *        5. Haiku                    Haiku 4.5 · Fastest for quick answers
 *        6. Opus 4.7 (1M)            Custom model (claude-opus-4-7[1m])
 *
 *      ● High effort (default) ←/→ to adjust
 *
 *      Enter to set as default · s to use this session only · Esc to cancel
 */

test("the /model picker is a dialog with one button per model", () => {
  const ask = parseAsk(MODEL_PICKER_100)!;
  expect(ask, "the picker parsed as nothing, so the app was told the screen was unreadable")
    .not.toBeNull();
  expect(ask.question).toStartWith("Select model");
  expect(ask.choices.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6]);
  // the model each digit picks, so nothing is answered blind
  expect(ask.choices[0]!.label).toStartWith("Default (recommended)");
  expect(ask.choices[2]!.label).toContain("Fable");
  expect(ask.choices[5]!.label).toContain("Opus 4.7");
  // and none of them opens a text field, so all six are answerable from the app
  expect(ask.choices.some((c) => c.freeText)).toBe(false);
});

test("the effort control between the choices and the footer is a key hint", () => {
  /* "● High effort (default) ←/→ to adjust" is the row that cost the verdict. A
   * content line below the last choice disqualifies the screen -- that is what
   * stops a numbered list in a reply being read as buttons -- and this is not
   * one: it names a key and what pressing it does, exactly like the "↑/↓ to
   * navigate" already in that list.
   *
   * Asserted against the same screen with that row turned into ordinary prose,
   * so what is being tested is the row and not the fixture. */
  expect(parseAsk(MODEL_PICKER_100)).not.toBeNull();
  const asProse = MODEL_PICKER_100.replace("←/→ to adjust", "and that is the effort");
  expect(asProse, "the fixture no longer contains the row this test is about")
    .not.toBe(MODEL_PICKER_100);
  expect(parseAsk(asProse),
    "a real content line under the last choice must still disqualify the screen",
  ).toBeNull();
});

test("at his own terminal width the last model's blurb wraps, and it is still a dialog", () => {
  /* 60 columns is not a smaller version of 100, it is a different screen: the
   * sixth model's description needs a second row, and that row is BELOW the last
   * choice. Read as a stray line of transcript it killed the whole parse, so the
   * picker was unreadable at the width his own panes run at (see
   * fixtures/pane-narrow-banner-wrapped-rule.txt, captured at 59). */
  const ask = parseAsk(MODEL_PICKER_60)!;
  expect(ask, "the picker is unparseable at 60 columns").not.toBeNull();
  expect(ask.choices).toHaveLength(6);
  expect(ask.choices[5]!.label).toContain("Opus 4.7");
  expect(ask.choices[5]!.detail).toContain("claude-opus-4-7");
});

test("the Claude Code welcome box is not what the picker is asking about", () => {
  /* The picker's question sits directly under the viewport rule, so a context
   * walk that steps over the rule it starts on carries on up into the
   * transcript. On a freshly started pane that is eleven rows of the welcome box
   * -- the ASCII logo, the tips panel, his email address -- delivered to the
   * phone as "what this question is about". */
  const fresh = parseAsk(MODEL_PICKER_100)!;
  expect(fresh.context, "the welcome banner was shown as the question's context").toEqual([]);
  expect(fresh.context.join("\n")).not.toContain("Welcome back");

  // and the same picker over a conversation takes no transcript either
  const afterTurn = parseAsk(MODEL_PICKER_AFTER_TURN)!;
  expect(afterTurn.context).toEqual([]);
  expect(afterTurn.choices).toHaveLength(6);
  /* Same six models, same question, whatever is scrolling above: one decision,
   * so one fingerprint. An answer drawn for it stays valid while the transcript
   * moves underneath. */
  expect(afterTurn.fingerprint).toBe(fresh.fingerprint);
});

// ------------------------------------------------------ free text, and its key

test("a choice that opens a text field is marked as one", () => {
  /* Marked so it can be SHOWN as out of reach rather than drawn as a button
   * that does nothing. Nothing answers these: three runs of select-type-submit
   * against a live plan dialog gave three different outcomes (blocked.ts). */
  const plan = parseAsk(PLAN_APPROVAL)!;
  expect(plan.choices[3]!.freeText).toBe(true);
  expect(plan.choices[0]!.freeText).toBeUndefined();
  expect(plan.choices[1]!.freeText).toBeUndefined();

  const q = parseAsk(ASK_USER_QUESTION)!;
  expect(q.choices[3]!.freeText).toBe(true);   // "Type something."
  expect(q.choices[0]!.freeText).toBeUndefined();
});

test("the hint under a free-text choice is kept as its description, not read as a key", () => {
  // "shift+tab to approve with this feedback" describes APPROVING THE PLAN with
  // the feedback attached, which is the permissive direction. It is text under a
  // button here and nothing else reads it.
  const plan = parseAsk(PLAN_APPROVAL)!;
  expect(plan.choices[3]!.detail).toBe("shift+tab to approve with this feedback");
});

// ----------------------------------------------- what it refuses to read

test("a finished turn that asked in prose is not a dialog", () => {
  // This is the honest half. There is no signal here and we invent none.
  expect(parseAsk(PROSE_QUESTION)).toBeNull();
});

test("an empty or blank screen is not a dialog", () => {
  expect(parseAsk("")).toBeNull();
  expect(parseAsk("\n\n   \n")).toBeNull();
});

test("a numbered list in ordinary output is not a dialog", () => {
  const prose = [
    "⏺ Here is what I would do:",
    "",
    "  1. Read the file",
    "  2. Change the line",
    "  3. Run the tests",
    "",
    "✻ Done",
    "────────────────────────────────────────────────────────────────────────────────",
    "❯",
    "────────────────────────────────────────────────────────────────────────────────",
  ].join("\n");
  // The run is followed by a real content line ("✻ Done"), so it is transcript,
  // not a live dialog. Reading it as one would put three buttons under a reply.
  expect(parseAsk(prose)).toBeNull();
});

test("a run that does not start at 1 is not a dialog", () => {
  const partial = [
    " Do you want to proceed?",
    "   2. Yes",
    "   3. No",
    "",
    " Esc to cancel",
  ].join("\n");
  expect(parseAsk(partial)).toBeNull();
});

test("a single numbered line is not a dialog", () => {
  expect(parseAsk([" Do you want to proceed?", " ❯ 1. Yes", "", " Esc to cancel"].join("\n"))).toBeNull();
});

test("choices with no question above them are not a dialog", () => {
  const noQuestion = ["", "   ❯ 1. Yes", "     2. No", "", " Esc to cancel"].join("\n");
  expect(parseAsk(noQuestion)).toBeNull();
});

test("a gap or a repeat in the numbering is not a dialog", () => {
  /* The digits are what the app draws as buttons and what the engine presses.
   * A run with 4 missing would put a button on the phone that presses a digit
   * the terminal has no option for; a repeated 2 would make two buttons do the
   * same thing while one option was unreachable. Either way, refuse. */
  const withRun = (...rows: string[]) =>
    [" Do you want to proceed?", ...rows, "", " Esc to cancel"].join("\n");
  expect(parseAsk(withRun("   1. Yes", "   2. Maybe", "   4. No")),
    "3 is missing: the run is not 1..k").toBeNull();
  expect(parseAsk(withRun("   1. Yes", "   2. Maybe", "   2. No")),
    "2 appears twice").toBeNull();
  expect(parseAsk(withRun("   2. Maybe", "   1. Yes")),
    "out of order: the walk up meets 1 before it has collected 2").toBeNull();
  // and the shape that IS a dialog, so the guard above is not just refusing
  // everything with a number in it
  expect(parseAsk(withRun("   1. Yes", "   2. No"))).not.toBeNull();
});

test("the parser only ever looks at the last rows of the screen", () => {
  /* SCAN_LINES is 40. A conversation that spends forty rows discussing a
   * numbered list, with a real dialog under it, must still read as the dialog
   * and take none of the transcript as choices. */
  const above = Array.from({ length: 60 }, (_, i) => `⏺ line ${i}: 1. not a button`);
  const ask = parseAsk([...above,
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No",
    "",
    " Esc to cancel",
  ].join("\n"))!;
  expect(ask.choices.map((c) => c.label)).toEqual(["Yes", "No"]);
  expect(ask.context, "the transcript above is not what the question is about").toEqual([]);
});

test("a two-digit choice is read as one number, not as a truncated one", () => {
  // the /model picker can list more than nine models; 10 must be the digit 10
  const rows = Array.from({ length: 10 }, (_, i) => `   ${i + 1}. Option ${i + 1}`);
  const ask = parseAsk([" Pick one", ...rows, "", " Esc to cancel"].join("\n"))!;
  expect(ask.choices.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(ask.choices[9]!.label).toBe("Option 10");
});

test("the question is at most the four lines directly above the run", () => {
  /* A question is one wrapped sentence, and the plan approval's is two lines.
   * Unbounded, a dialog with no rule above it would swallow the whole reply
   * that preceded it and read it aloud as the question. */
  const ask = parseAsk([
    "one", "two", "three", "four", "five", "six",
    " ❯ 1. Yes",
    "   2. No",
    "",
    " Esc to cancel",
  ].join("\n"))!;
  expect(ask.question).toBe("three four five six");
});

test("the context is capped, so a long plan does not arrive whole on a phone", () => {
  // CONTEXT_MAX is 12: the nearest twelve lines to the question, no more
  const body = Array.from({ length: 30 }, (_, i) => ` plan line ${i}`);
  const ask = parseAsk([
    "────────────────────────────────────────────────────────────────────────────────",
    ...body,
    "", // the blank that ends the question block, exactly as a real panel draws it
    " Ready to proceed?",
    " ❯ 1. Yes",
    "   2. No",
    "",
    " Esc to cancel",
  ].join("\n"))!;
  expect(ask.context).toHaveLength(12);
  expect(ask.context[11], "the twelve nearest the question, in reading order")
    .toBe(" plan line 29");
});

test("a free-text label is recognised by its wording, not by its position", () => {
  /* A whitelist of phrasings seen on real screens. Getting this wrong the other
   * way types a sentence into a dialog that wanted a keypress, so nothing is
   * inferred from the choice being last. */
  const dialog = (label: string) =>
    parseAsk([" Pick one", "   1. Yes", `   2. ${label}`, "", " Esc to cancel"].join("\n"))!;
  for (const label of ["Type something.", "Tell Claude what to change",
    "No, tell Claude what to do differently", "Other", "Custom"]) {
    expect(dialog(label).choices[1]!.freeText, `${label} should open a text field`).toBe(true);
  }
  for (const label of ["No", "Yes, and always allow", "Type checking is on"]) {
    expect(dialog(label).choices[1]!.freeText, `${label} is a button, not a field`).toBeUndefined();
  }
});

// -------------------------------------------------------------- fingerprints

test("the same screen fingerprints the same, a different question does not", () => {
  expect(parseAsk(BASH_PERMISSION)!.fingerprint).toBe(parseAsk(BASH_PERMISSION)!.fingerprint);
  expect(parseAsk(BASH_PERMISSION)!.fingerprint).not.toBe(parseAsk(WRITE_PERMISSION)!.fingerprint);
  expect(parseAsk(PLAN_APPROVAL)!.fingerprint).not.toBe(parseAsk(ASK_USER_QUESTION)!.fingerprint);
});

test("the selection caret moving does not change the fingerprint", () => {
  // Arrowing down in the terminal must not invalidate an answer in flight: the
  // question is the same question.
  const moved = WRITE_PERMISSION.replace(" ❯ 1. Yes", "   1. Yes").replace("   3. No", " ❯ 3. No");
  expect(parseAsk(moved)!.fingerprint).toBe(parseAsk(WRITE_PERMISSION)!.fingerprint);
});

test("two files in one directory are two decisions, not one", () => {
  /* THE REGRESSION. Question and choices are byte-identical between these two
   * live captures; only the context differs. A fingerprint that skips the
   * context calls them the same question and lets an answer for one be pressed
   * against the other. */
  const alpha = parseAsk(READ_ALPHA)!;
  const beta = parseAsk(READ_BETA)!;
  expect(alpha.question).toBe(beta.question);
  expect(alpha.choices.map((c) => c.label)).toEqual(beta.choices.map((c) => c.label));
  expect(alpha.context.join("\n")).toContain("alpha.txt");
  expect(beta.context.join("\n")).toContain("beta.txt");
  expect(alpha.fingerprint).not.toBe(beta.fingerprint);
});

test("a bash prompt is identified by its command, which is only in the context", () => {
  // The question is always "Do you want to proceed?" and choice 2 can name the
  // DIRECTORY ("don't ask again for rm commands in <cwd>"), so two different rm
  // invocations in one cwd differ nowhere else.
  const one = BASH_PERMISSION;
  // replaceAll: the command appears in the transcript above the dialog too, and
  // changing only that copy would leave the DIALOG identical -- which is a test
  // that passes for the wrong reason.
  const two = BASH_PERMISSION.replaceAll("blocked-lane-outside.txt", "blocked-lane-other.txt");
  const a = parseAsk(one)!;
  const b = parseAsk(two)!;
  expect(a.question).toBe(b.question);
  expect(a.choices.map((c) => c.label)).toEqual(b.choices.map((c) => c.label));
  expect(a.fingerprint).not.toBe(b.fingerprint);
});

test("a changed choice changes the fingerprint, so a stale answer cannot land", () => {
  const different = WRITE_PERMISSION.replace("   3. No", "   3. No, and stop");
  expect(parseAsk(different)!.fingerprint).not.toBe(parseAsk(WRITE_PERMISSION)!.fingerprint);
});

test("a choice's DESCRIPTION is deliberately not in the fingerprint", () => {
  /* The blurb under a button does not change what the button does, and the
   * terminal rewrites it as the panel re-wraps. Hashing it would invalidate an
   * answer in flight for a cosmetic redraw, which is the same class of harm as
   * the caret moving. */
  const reworded = ASK_USER_QUESTION.replace("     Warm, high-contrast.", "     Bold and warm.");
  expect(reworded).not.toBe(ASK_USER_QUESTION);
  expect(parseAsk(reworded)!.choices[0]!.detail).toBe("Bold and warm.");
  expect(parseAsk(reworded)!.fingerprint).toBe(parseAsk(ASK_USER_QUESTION)!.fingerprint);
});

test("the COUNT of choices is part of the fingerprint", () => {
  /* A dialog that gained an option between the read and the answer is a
   * different dialog, and pressing "3" at it could hit something new. The
   * fingerprint carries the count in plain sight (the suffix after the hash) so
   * two dialogs cannot collide on length. */
  const fourth = ASK_USER_QUESTION.replace(
    "  5. Chat about this",
    "  5. Chat about this\n  6. Something else",
  );
  const a = parseAsk(ASK_USER_QUESTION)!;
  const b = parseAsk(fourth)!;
  expect(b.choices).toHaveLength(6);
  expect(a.fingerprint).not.toBe(b.fingerprint);
  expect(a.fingerprint).toEndWith("-5");
  expect(b.fingerprint).toEndWith("-6");
});

test("trailing whitespace on a context line does not move the fingerprint", () => {
  /* Context lines are trimmed into the basis. A terminal that pads a row out to
   * the full width on one read and not the next must not invalidate an answer
   * the app is holding. */
  const padded = READ_ALPHA.replace(
    "  Read(/tmp/ab-outside/alpha.txt)",
    "  Read(/tmp/ab-outside/alpha.txt)      ",
  );
  expect(padded).not.toBe(READ_ALPHA);
  expect(parseAsk(padded)!.fingerprint).toBe(parseAsk(READ_ALPHA)!.fingerprint);
});

test("the question alone changing is enough to make it a different decision", () => {
  const other = WRITE_PERMISSION.replace(
    " Do you want to create note.txt?",
    " Do you want to create other.txt?",
  );
  expect(parseAsk(other)!.fingerprint).not.toBe(parseAsk(WRITE_PERMISSION)!.fingerprint);
});

// ------------------------------------------- OSC and stray control sequences

test("an OSC-8 hyperlink in a question keeps its link text and drops the escapes", () => {
  /* A claude trust prompt drew an OSC-8 hyperlink into its question. The old
   * SGR-only stripper left the OSC sequence behind, so the blocked-question
   * text the app rendered leaked "]8;id=zaxmda;https://...". The visible link
   * text sits BETWEEN the open and close sequences, so it must survive while
   * the sequences themselves go. */
  const raw = [
    " Do you trust the files in this folder?",
    " \x1b]8;id=zaxmda;https://code.claude.com/docs/en/security\x1b\\Security guide\x1b]8;;\x1b\\",
    " ❯ 1. Yes",
    "   2. No",
    "",
    " Esc to cancel",
  ].join("\n");
  const ask = parseAsk(raw)!;
  expect(ask.question).toBe("Do you trust the files in this folder? Security guide");
  expect(ask.question).not.toContain("]8;");
  expect(ask.question).not.toContain("https://");
  expect(ask.question).not.toContain("\x1b");
});

test("a bare OSC title sequence is stripped, not leaked into the question", () => {
  /* A window-title OSC (ESC ]0;... BEL) is neither SGR nor a hyperlink, so the
   * old stripper let it through as visible text. It must go entirely. */
  const raw = [
    "\x1b]0;Claude Code\x07",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No",
    "",
    " Esc to cancel",
  ].join("\n");
  const ask = parseAsk(raw)!;
  expect(ask.question).toBe("Do you want to proceed?");
  expect(ask.question).not.toContain("]0;");
  expect(ask.question).not.toContain("Claude Code");
});

test("stray CSI and C1 controls are stripped, not read as question text", () => {
  /* Cursor moves, clears and the like are CSI sequences SGR never matched, and
   * a bare C1 byte (here NEL, 0x85) is the same leak one step lower. All of
   * them must disappear rather than survive as question text. */
  const raw = [
    " Do you want to proceed?\x1b[2J\x1b[1;1H\x1b[K\x85",
    " ❯ 1. Yes",
    "   2. No",
    "",
    " Esc to cancel",
  ].join("\n");
  const ask = parseAsk(raw)!;
  expect(ask.question).toBe("Do you want to proceed?");
  expect(ask.question).not.toContain("\x1b");
  expect(ask.question).not.toContain("\x85");
});

test("a control sequence inside a CHOICE label does not reach the button", () => {
  /* The label is what the app draws on a button and what goes into the
   * fingerprint. An escape left in it would render as mojibake on the phone and
   * would make the same dialog fingerprint differently depending on how the
   * terminal happened to colour it that instant. */
  const raw = [
    " Do you want to proceed?",
    " ❯ 1. \x1b[1mYes\x1b[0m",
    "   2. \x1b]8;;https://example.invalid\x1b\\No\x1b]8;;\x1b\\",
    "",
    " Esc to cancel",
  ].join("\n");
  const ask = parseAsk(raw)!;
  expect(ask.choices.map((c) => c.label)).toEqual(["Yes", "No"]);
  // the same dialog without any colour fingerprints identically
  const plain = [" Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"].join("\n");
  expect(ask.fingerprint).toBe(parseAsk(plain)!.fingerprint);
});

// --------------------------------------------------- the stripper on its own

test("stripPaneControls removes every family it names, and only those", () => {
  /* The one stripper every pane reader shares. Each clause below is a family
   * the SGR-only version let through: an OSC-8 hyperlink whose LINK TEXT has to
   * survive between two sequences, a bare title OSC ended by BEL, the 8-bit
   * spellings of CSI and OSC, a two-byte ESC sequence, and a stray C1 byte. */
  expect(stripPaneControls("\x1b[1;31mred\x1b[0m")).toBe("red");
  expect(stripPaneControls("\x1b]8;id=x;https://a.invalid\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  expect(stripPaneControls("\x1b]0;window title\x07after")).toBe("after");
  expect(stripPaneControls("\x9b2Jkept"), "8-bit CSI").toBe("kept");
  expect(stripPaneControls("\x9dtitle\x9ckept"), "8-bit OSC ended by an 8-bit ST").toBe("kept");
  expect(stripPaneControls("\x1bckept"), "a two-byte ESC sequence (RIS)").toBe("kept");
  expect(stripPaneControls("a\x85b"), "a stray C1 byte").toBe("ab");
  // and ordinary text, including the box drawing the parser depends on, is untouched
  expect(stripPaneControls(" ❯ 1. Yes ─╌▔")).toBe(" ❯ 1. Yes ─╌▔");
  expect(stripPaneControls("")).toBe("");
});

test("an unterminated escape sequence eats the rest of the row, not the screen", () => {
  /* A capture can be cut mid-sequence. The walk runs to the end of the STRING
   * when it finds no terminator, so the damage is bounded by the read; nothing
   * carries a half-parsed state into the next call. */
  expect(stripPaneControls("before\x1b]8;never ended")).toBe("before");
  expect(stripPaneControls("before\x1b[38;2;1;2")).toBe("before");
});

// ------------------------------------------------ the echo gate's tail matcher

/* THE WRAP-BORDER FIELD FAILURE, reproduced. Captured live on the testbox
 * test box (tmux mux, opencode 1.18.29, wide pane), 2026-09-20, session
 * ag--7ts1_86LOwH1naw: the engine typed the body, opencode's composer showed it
 * fully but wrapped it across rows, each drawn with a left border glyph "┃"
 * (U+2503). The typed tail straddled the wrap, so the border glyph sat between
 * its two halves and the old flat() (control + whitespace only) left it there,
 * breaking containment. tailVisible ruled the text swallowed and no enter was
 * pressed, though one manual enter submitted the sitting body. */
const OPENCODE_WRAP_BODY =
  "TEXT: Hi (Reply with the chat tool AND the speak tool. Do not read this back; " +
  "just deliver the full text via chat tool.)";
const OPENCODE_WRAP_SCREEN = [
  "opencode  ~/work",
  "",
  "┃ TEXT: Hi (Reply with the chat tool AND the speak tool. Do not read this",
  "┃ back; just deliver the full text",
  "┃ via chat tool.)",
  "",
  "  send  ·  esc to clear",
].join("\n");

test("a body wrapped with composer border glyphs still shows its tail", () => {
  /* The tail is the last 24 chars, "ull text via chat tool.)": on screen the
   * composer wrapped it as "...full text\n┃ via chat tool.)", so a border glyph
   * sits BETWEEN "text" and "via", inside the tail window. Old flat() kept the
   * ┃ and broke containment; stripping U+2500-U+259F restores it. */
  expect(tailVisible(OPENCODE_WRAP_SCREEN, OPENCODE_WRAP_BODY)).toBe(true);
});

test("the modal that swallowed the body is still refused", () => {
  /* A permission modal on screen, and the body typed at it was swallowed: the
   * screen shows the modal's own question and choices, NOT the body. Stripping
   * chrome cannot add the body's letters, so containment stays false and the
   * gate still refuses (no enter reaches the modal's default). */
  const modal = [
    "────────────────────────────────────────────────────────────",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No",
    "",
    " Esc to cancel",
  ].join("\n");
  expect(tailVisible(modal, OPENCODE_WRAP_BODY)).toBe(false);
});

test("flat strips box-drawing and block-element chrome, then whitespace", () => {
  // The wrap border between two halves of a word is gone; the letters remain.
  expect(flat("full text\n┃ via chat")).toBe("fulltextviachat");
  // block elements too (U+2580-U+259F), and a horizontal rule
  expect(flat("a─────b")).toBe("ab");
  expect(flat("a▀▄█b")).toBe("ab");
  // ordinary text and punctuation are untouched
  expect(flat(" hello, world! (x) ")).toBe("hello,world!(x)");
});

test("chrome stripping cannot conjure a tail the screen never echoed", () => {
  /* A screen that is nothing but chrome and unrelated words has no body letters,
   * so no amount of stripping makes the tail appear. */
  const noEcho = "┃ waiting ┃\n──────────\n│ menu │";
  expect(tailVisible(noEcho, OPENCODE_WRAP_BODY)).toBe(false);
});
