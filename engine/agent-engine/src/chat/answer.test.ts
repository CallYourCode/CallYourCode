/* ANSWERING A BLOCKED SESSION FROM THE APP.
 *
 * The dialog parser has its own file (blocked.test.ts). This one is about the
 * thing that PRESSES KEYS, and every test here is a way it could press the wrong
 * one:
 *
 *   - the app notices a blocked pane without being told twice, and is handed the
 *     question, its choices and what it is about;
 *   - a real answer reaches the terminal, as the digit and nothing else;
 *   - an answer to a question that is GONE presses nothing at all (measured on a
 *     live pane: a stray digit lands as literal text in claude's input box,
 *     where it sits unsubmitted and prefixes his next message);
 *   - an answer to a question that CHANGED presses nothing, and "changed"
 *     includes the same words about a DIFFERENT FILE;
 *   - a screen we cannot read is reported as not-known, never as not-blocked,
 *     and the app is told WHICH not-known it is;
 *   - an after-check that could not be made is not an after-check that passed.
 *
 * THE ONE RULE ALL OF IT SERVES: a key is never pressed on a screen nobody just
 * looked at. The last look happens with the pane keyboard already held,
 * microseconds before the key goes out, so nothing can slip between them.
 *
 * No engine here: wireCore performs server.ts's boot in process over a FakeHerdr
 * on a unix socket, and the keystrokes go through the real MuxAdapter.
 *
 *   bun test agent-engine/src/chat/answer.test.ts
 */

import { test, expect, beforeAll, afterAll, afterEach, setDefaultTimeout } from "bun:test";
import { join } from "node:path";

import { onAnswer } from "../sessions/session-verbs.ts";
import { ASK_POLL_MS } from "./asks.ts";
import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";

/* A BOUND THAT MEASURES THE LOADED MACHINE, NOT THE BEHAVIOR. until()'s default
 * is 2s; the reconcile polls in the helpers below wait on the same publish that
 * line 506's note already had to widen -- under `bun test --parallel`, with a
 * worker per core, it competes for the CPU that publishes the condition. The
 * "becomes blocked" case times out about one full run in ten that way, never in
 * isolation. Nothing about the claims changes: the condition still has to become
 * true, and a real regression still fails here with the caller's own sentence;
 * the wider bound only buys the loaded box the time to schedule the work. */
const LOADED_MS = 10_000;

/* AND THE TEST'S OWN BUDGET HAS TO OUTLIVE THAT BOUND. bun's default is 5s per
 * test, so a blockedOn() allowed LOADED_MS was being killed by the runner at
 * [5000ms] before its own until() could use the width (measured under a full
 * parallel sweep: "already gone" and "becomes blocked" died at exactly 5001ms,
 * never in isolation). Same generous-raise as the LOADED_MS note above. */
setDefaultTimeout(3 * LOADED_MS);

/* THE /model PICKER, off a live Claude Code 2.1.222 (fixtures/README.md). Kept
 * as the file it was captured to, colour and all, because the engine reads ansi
 * off the pane and the strip is its own job. */
const MODEL_PICKER_SCREEN = await Bun.file(join(import.meta.dir, "..", "fixtures",
  "pane-model-picker-2.1.222-100col.txt")).text();

/* A permission prompt, from a live pane (the full captures are in
 * blocked.test.ts; these are the trimmed forms this file needs to move between). */
const PERMISSION_SCREEN = [
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

/* The same pane a moment later, having been answered at the keyboard. */
const IDLE_SCREEN = [
  "⏺ Write(note.txt)",
  "  ⎿  User rejected write to note.txt",
  "",
  "✻ Baked for 27s",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────",
  "  O5 · high · ctx 3%",
].join("\n");

/* TWO READ PROMPTS, CAPTURED LIVE, SECONDS APART. Same question, same three
 * choices (choice 2 names the DIRECTORY), and the only line that says which file
 * is being read is in the context. This is the pair that pressed "Yes" on the
 * wrong file. */
const READ_ALPHA = [
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
const READ_BETA = READ_ALPHA.replaceAll("alpha.txt", "beta.txt");

/* A plan approval, whose fourth choice opens a text field. Captured live; the
 * full version is in blocked.test.ts. */
const PLAN_SCREEN = [
  "  ────────────────────────────────────────────────────────────────────────────",
  "   Ready to code?",
  "",
  "   Here is Claude's plan:",
  "  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  "   Add a hello world Python script",
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
  "   ctrl+g to edit in Micro · ~/.claude/plans/plan.md",
].join("\n");

/* A DIFFERENT question, on the same pane, without the status ever leaving
 * blocked: answer one permission prompt and the tool asks for the next file. */
const SECOND_SCREEN = PERMISSION_SCREEN
  .replace("Do you want to create note.txt?", "Do you want to create other.txt?")
  .replace(" note.txt", " other.txt");

/* HOW LONG THE TERMINAL GETS TO REDRAW before the after-check looks. Real time
 * by nature: it is a TUI repainting, not a timer this engine owns. Shortened at
 * file scope (session-verbs.ts reads it on every use for exactly that reason)
 * because this file makes a dozen of these and the shipped 900ms is nine seconds
 * of nothing happening. Long enough that the screen-flip hooks below always win
 * the race, which is what makes each test deterministic. */
const priorVerify = process.env.CYC_ANSWER_VERIFY_MS;
beforeAll(() => { process.env.CYC_ANSWER_VERIFY_MS = "200"; });
afterAll(() => {
  if (priorVerify === undefined) delete process.env.CYC_ANSWER_VERIFY_MS;
  else process.env.CYC_ANSWER_VERIFY_MS = priorVerify;
});

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

type Frame = Record<string, any>;

/** A wiring whose one pane is BLOCKED on `screen`, with a client watching, and
 *  the question already on the wire. */
async function blockedOn(screen: string): Promise<{
  c: WireCore; cl: ReturnType<WireCore["client"]>; ask: Frame;
}> {
  const c = await wireCore({ with: ["frames"] });
  core = c;
  await until(() => c.sessions.size === 1,
    { timeoutMs: LOADED_MS, what: "the pane to reconcile" });
  const cl = c.client();
  c.hooks.setScreen!(PANE, screen);
  c.herdr.setStatus(PANE, "blocked");
  await until(() => row(cl)?.ask != null,
    { timeoutMs: LOADED_MS, what: "the question to reach the app" });
  return { c, cl, ask: row(cl)!.ask };
}

/** A wiring blocked on a screen the app cannot be shown a question for. */
async function blockedUnknown(prepare: (c: WireCore) => void): Promise<{
  c: WireCore; cl: ReturnType<WireCore["client"]>;
}> {
  const c = await wireCore({ with: ["frames"] });
  core = c;
  await until(() => c.sessions.size === 1,
    { timeoutMs: LOADED_MS, what: "the pane to reconcile" });
  const cl = c.client();
  prepare(c);
  c.herdr.setStatus(PANE, "blocked");
  await until(() => row(cl)?.askUnknown === true,
    { timeoutMs: LOADED_MS, what: "the app to be told it cannot say" });
  return { c, cl };
}

/** The most recent view of our one session, off the frames the client received. */
function row(cl: { frames: Frame[] }): Frame | undefined {
  for (let i = cl.frames.length - 1; i >= 0; i--) {
    const f = cl.frames[i]!;
    if (f.t === "sessions") {
      const r = (f.list ?? []).find((s: any) => s.id === wireId(PANE));
      if (r) return r;
    }
  }
  return undefined;
}

/** The answer-result frame this client was sent. */
const result = (cl: { frames: Frame[] }) =>
  [...cl.frames].reverse().find((f) => f.t === "answer-result");

/* MOVE THE PANE THE INSTANT THE DIGIT IS PRESSED, which is what a real one does.
 * Armed off the KEYSTROKE rather than off a timer, so a test cannot pass by
 * having the fake move at the wrong moment: every read before the press sees the
 * old screen and every read after it sees the new one. */
function onKeyPress(c: WireCore, fn: () => void): () => void {
  const before = c.herdr.keys.length;
  const t = setInterval(() => {
    if (c.herdr.keys.length > before) { clearInterval(t); fn(); }
  }, 2);
  return () => clearInterval(t);
}

// --------------------------------------------------------------- noticing it

test("a session that becomes blocked arrives with the question and its choices", async () => {
  const { cl } = await blockedOn(PERMISSION_SCREEN);
  const r = row(cl)!;
  expect(r.status).toBe("blocked");
  expect(r.ask.question).toBe("Do you want to create note.txt?");
  expect(r.ask.choices.map((c: any) => c.label)).toEqual([
    "Yes",
    "Yes, allow all edits during this session (shift+tab)",
    "No",
  ]);
  // what it is asking ABOUT travels too, or he is answering blind
  expect(r.ask.context.join("\n")).toContain("note.txt");
  expect(r.askUnknown).toBeFalsy();
});

test("a blocked pane whose screen says nothing is reported as not-known, not as not-blocked", async () => {
  /* THE RULE THIS FILE EXISTS FOR. An unreadable screen must never render as a
   * quiet session; the app has to be able to say "it is waiting and I cannot
   * tell you what for". */
  const { cl } = await blockedUnknown((c) => c.hooks.setScreen!(PANE, "")); // blocked, screen says nothing
  const r = row(cl)!;
  expect(r.status).toBe("blocked");
  expect(r.ask).toBeNull();
  /* AND WHICH KIND OF NOT-KNOWN, because the app says a different sentence for
   * each. The screen ARRIVED; there is no dialog on it this parser can see.
   * Saying "could not read" of a screen we hold is the app naming a reason it
   * does not have. */
  expect(r.askWhy).toBe("unrecognised");
});

/* THE SCREEN THAT MADE THE DIFFERENCE WORTH SENDING.
 *
 * The /model picker is not exotic and it is not a failure: it is a numbered list
 * of six models with a caret on one of them, and until this round the engine
 * said `unknown` about it and the app told him the terminal was showing
 * something it could not read. It goes end to end here -- the real capture on the
 * fake pane, through the same read the app is fed by -- because the parser's own
 * file cannot prove that what it parsed is what reaches the phone. */
test("the /model picker reaches the app as a question with its models, not as not-known", async () => {
  const { cl } = await blockedOn(MODEL_PICKER_SCREEN);
  const r = row(cl)!;
  expect(r.ask.question).toContain("Select model");
  expect(r.ask.choices.map((c: any) => c.n)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(r.ask.choices[2].label).toContain("Fable");
  expect(r.askUnknown).toBeFalsy();
  expect(r.askWhy).toBeUndefined();
});

test("a pane that stops being blocked loses its question in the same beat", async () => {
  const { c, cl } = await blockedOn(PERMISSION_SCREEN);
  c.hooks.setScreen!(PANE, IDLE_SCREEN);
  c.herdr.setStatus(PANE, "working");
  await until(() => row(cl)?.ask == null, { what: "the question to be dropped" });
  const r = row(cl)!;
  expect(r.ask).toBeNull();
  expect(r.askUnknown).toBe(false); // not blocked at all, so nothing is unknown
});

test("a truncated read is treated as a screen we could not see", async () => {
  /* herdr says it did not hand over the whole thing. Half a choice list still
   * parses, and a dialog whose top was cut off has lost the context line that
   * says which file it is about -- the very thing the fingerprint needs. */
  const { c, cl } = await blockedUnknown((k) => {
    k.hooks.setScreen!(PANE, PERMISSION_SCREEN);
    k.herdr.truncated.add(PANE);
  });
  expect(row(cl)!.ask).toBeNull();
  /* THIS one really is a screen we do not hold, and it is the only kind that
   * earns the sentence about the terminal being unreadable. The pane whose screen
   * we read and did not recognise says `unrecognised` instead. */
  expect(row(cl)!.askWhy).toBe("unread");

  // ...and it recovers the moment a whole screen arrives
  c.herdr.truncated.delete(PANE);
  await c.clock.advance(ASK_POLL_MS);
  await until(() => row(cl)?.ask != null, { what: "the question after a whole read" });
});

// ------------------------------------------------------------- answering it

test("answering presses the digit, and only the digit", async () => {
  const { c, cl } = await blockedOn(PERMISSION_SCREEN);
  const before = c.herdr.keys.length;
  const disarm = onKeyPress(c, () => {
    c.hooks.setScreen!(PANE, IDLE_SCREEN);
    c.herdr.setStatus(PANE, "working");
  });

  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: row(cl)!.ask.fingerprint, choice: 3 });
  disarm();

  expect(result(cl)!.ok).toBe(true);
  expect(c.herdr.keys.slice(before)).toEqual([{ paneId: PANE, keys: ["3"] }]);
  expect(c.herdr.texts, "something was TYPED at a chooser").toHaveLength(0);
  expect(c.submitted, "an enter was pressed at a chooser, which answers it").toEqual([]);
});

test("a successful answer is written into the transcript, so the chat says what was chosen", async () => {
  /* Without it the chat shows a question that stopped being there and no sign of
   * who answered it or how, which is the same "the app knows something it will
   * not say" failure the whole idea is about. */
  const { c, cl } = await blockedOn(PERMISSION_SCREEN);
  const disarm = onKeyPress(c, () => {
    c.hooks.setScreen!(PANE, IDLE_SCREEN);
    c.herdr.setStatus(PANE, "working");
  });

  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: row(cl)!.ask.fingerprint, choice: 3 });
  disarm();

  const chat = cl.of("chat");
  expect(chat).toHaveLength(1);
  expect(chat[0].role).toBe("user");
  expect(chat[0].text).toBe("↩ No");
  // and it is in the session's own log, not only on the wire
  expect(c.byHandle(PANE)!.chat.at(-1)!.text).toBe("↩ No");
});

// -------------------------------------------------- refusing to answer

test("an answer to a question that is already gone presses nothing", async () => {
  /* MEASURED, on a live pane: a digit sent to a claude that is no longer asking
   * lands as literal text in the input box and sits there unsubmitted, so the
   * next thing he types goes out as "3 have a look at...". The engine's job is to
   * look before it presses. */
  const { c, cl, ask } = await blockedOn(PERMISSION_SCREEN);
  // it was answered at the keyboard while the phone was still showing buttons
  c.hooks.setScreen!(PANE, IDLE_SCREEN);
  const before = c.herdr.keys.length;

  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: ask.fingerprint, choice: 1 });

  expect(result(cl)!.ok).toBe(false);
  expect(result(cl)!.reason).toBe("vanished");
  expect(c.herdr.keys.slice(before)).toEqual([]);
  expect(cl.of("chat"), "a choice was written into his transcript for a question that was gone")
    .toEqual([]);
});

test("an answer to a question that has been replaced presses nothing", async () => {
  // The dangerous one: the pane is STILL blocked, so a naive engine would press
  // "1. Yes" -- against a different file from the one he was looking at.
  const { c, cl, ask } = await blockedOn(PERMISSION_SCREEN);
  c.hooks.setScreen!(PANE, SECOND_SCREEN);
  const before = c.herdr.keys.length;

  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: ask.fingerprint, choice: 1 });

  expect(result(cl)!.ok).toBe(false);
  expect(result(cl)!.reason).toBe("changed");
  expect(c.herdr.keys.slice(before)).toEqual([]);
  // and the app is handed the new question rather than left on the old one
  await until(() => row(cl)?.ask?.question === "Do you want to create other.txt?",
    { what: "the replacement question to reach the app" });
});

test("an answer for one file is not pressed against another in the same directory", async () => {
  /* THE REGRESSION, END TO END. The screen moves from alpha.txt to beta.txt and
   * the status never leaves `blocked`, so nothing else in the system notices. The
   * question and every choice label are byte-identical; only the CONTEXT differs.
   * Before the fingerprint covered the context this pressed "1. Yes" against
   * beta.txt and reported ok:true, because the dialog then dismissed and the
   * after-check was satisfied. */
  const { c, cl, ask: alpha } = await blockedOn(READ_ALPHA);
  expect(alpha.context.join("\n")).toContain("alpha.txt");

  // the terminal moves on to the next file, still blocked, still the same words
  c.hooks.setScreen!(PANE, READ_BETA);
  await c.clock.advance(ASK_POLL_MS);
  await until(() => row(cl)?.ask?.context.join("\n").includes("beta.txt") === true,
    { what: "the second file's prompt to reach the app" });
  const beta = row(cl)!.ask;
  expect(beta.question).toBe(alpha.question);
  expect(beta.choices.map((c: any) => c.label)).toEqual(alpha.choices.map((c: any) => c.label));

  const before = c.herdr.keys.length;
  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: alpha.fingerprint, choice: 1 });

  expect(result(cl)!.ok).toBe(false);
  expect(result(cl)!.reason).toBe("changed");
  expect(c.herdr.keys.slice(before)).toEqual([]);
  // and no "↩ Yes" was written into his transcript for a file he never saw
  expect(cl.of("chat")).toEqual([]);
});

test("a choice the dialog does not offer presses nothing", async () => {
  const { c, cl, ask } = await blockedOn(PERMISSION_SCREEN);
  const before = c.herdr.keys.length;
  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: ask.fingerprint, choice: 7 });
  expect(result(cl)!.ok).toBe(false);
  expect(c.herdr.keys.slice(before)).toEqual([]);
});

test("a choice past the ninth is refused rather than guessed at", async () => {
  /* Choices are answered by pressing their digit; past nine there is no digit to
   * press and arrowing there is untested, so it is refused by name. */
  const { c, cl, ask } = await blockedOn(PERMISSION_SCREEN);
  const before = c.herdr.keys.length;
  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: ask.fingerprint, choice: 12 });
  expect(result(cl)!.ok).toBe(false);
  expect(result(cl)!.reason).toBe("unreachable");
  expect(c.herdr.keys.slice(before)).toEqual([]);
});

test("a written answer to a choice that is not a text field presses nothing", async () => {
  const { c, cl, ask } = await blockedOn(PERMISSION_SCREEN);
  const before = c.herdr.keys.length;
  await onAnswer(cl.sock, {
    id: wireId(PANE), fingerprint: ask.fingerprint, choice: 1, text: "do it but rename the file",
  });
  expect(result(cl)!.ok).toBe(false);
  expect(result(cl)!.reason).toBe("not-free-text");
  expect(c.herdr.keys.slice(before)).toEqual([]);
  expect(c.herdr.texts).toHaveLength(0);
});

test("a choice that opens a text field is refused before anything is pressed", async () => {
  /* THE LIMIT, stated as a test so it cannot be quietly widened later.
   *
   * Selecting such a choice would put the terminal into an open text field, and
   * this build cannot reliably submit one (three runs of select-type-submit
   * against a live plan dialog disagreed with each other; see blocked.ts). So the
   * digit is not sent AT ALL: leaving the pane sitting in a half-entered field is
   * worse than where it started, and pressing nothing is the only outcome that is
   * honest AND harmless. */
  const { c, cl, ask } = await blockedOn(PLAN_SCREEN);
  expect(ask.choices[3].freeText).toBe(true);

  const before = c.herdr.keys.length;
  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: ask.fingerprint, choice: 4 });
  expect(result(cl)!.ok).toBe(false);
  expect(result(cl)!.reason).toBe("needs-terminal");
  expect(c.herdr.keys.slice(before)).toEqual([]);
  expect(c.herdr.texts).toHaveLength(0);

  // and the choices BESIDE it are still answerable: the limit is one option, not
  // the dialog
  const disarm = onKeyPress(c, () => {
    c.hooks.setScreen!(PANE, IDLE_SCREEN);
    c.herdr.setStatus(PANE, "working");
  });
  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: ask.fingerprint, choice: 2 });
  disarm();
  expect(result(cl)!.ok).toBe(true);
  expect(c.herdr.keys.at(-1)).toEqual({ paneId: PANE, keys: ["2"] });
});

test("an answer that leaves the same question on screen is reported as not having worked", async () => {
  // The pane took the keystroke and did not move. Saying "sent" here is the
  // failure this codebase keeps making: an app that claims what it cannot see.
  const { c, cl, ask } = await blockedOn(PERMISSION_SCREEN);

  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: ask.fingerprint, choice: 3 }); // screen never changes

  expect(result(cl)!.ok).toBe(false);
  expect(result(cl)!.reason).toBe("no-effect");
  // it DID press, though: the refusal is about the outcome, not about the send
  expect(c.herdr.keys.at(-1)).toEqual({ paneId: PANE, keys: ["3"] });
  expect(cl.of("chat"), "a choice that had no effect was written into his transcript")
    .toEqual([]);
});

test("an answer whose after-check could not be read is not reported as a success", async () => {
  /* THE CHECK THAT COULD NOT BE MADE.
   *
   * The keystroke goes out, and then the read that would say whether it landed
   * fails -- a truncated screen here, an rpc error live. That is not evidence the
   * answer worked, and it used to be treated as such: the success path only asked
   * whether the SAME question was still there, so `ok:false` on the read fell
   * straight through it. `↩ No` went into his transcript and `ok:true` went to
   * the phone, while the same read left the session's `ask` state unreadable --
   * so the panel said it could not read the session directly over a chat line
   * saying the choice had been made.
   *
   * The truncation is armed off the KEYSTROKE, not off a timer, so this test
   * cannot pass by having the fake move at the wrong moment: the two reads before
   * the press are whole, and every read after it is not. */
  const { c, cl, ask } = await blockedOn(PERMISSION_SCREEN);
  const before = c.herdr.keys.length;
  const disarm = onKeyPress(c, () => c.herdr.truncated.add(PANE));

  await onAnswer(cl.sock, { id: wireId(PANE), fingerprint: ask.fingerprint, choice: 3 });
  disarm();

  const res = result(cl)!;
  expect(res.ok).toBe(false);
  expect(res.reason).toBe("unconfirmed");
  // and it says which half is known: the send happened, the outcome did not
  expect(String(res.detail)).toContain("was sent");
  // the press itself is real, and is the reason this is not "vanished"
  expect(c.herdr.keys.slice(before)).toEqual([{ paneId: PANE, keys: ["3"] }]);
  // NOTHING in the transcript claims a choice was made
  expect(cl.of("chat").filter((f) => String(f.text).startsWith("↩"))).toEqual([]);
  /* and the two statements agree: the session says it cannot read the screen.
   *
   * BOUNDED AT TEN SECONDS RATHER THAN until()'s DEFAULT TWO. This poll was
   * timing out about one full run in ten -- never on its own, only under
   * --parallel, where the reconcile that publishes askUnknown is competing with
   * a worker per core. Nothing about the claim changes: the condition still has
   * to become true, and a real regression still fails here with this sentence
   * rather than with a stack somewhere else. */
  await until(() => row(cl)?.askUnknown === true,
    { timeoutMs: 10_000, what: "the session row to admit it cannot read the screen" });
});

test("an answer for a session this engine does not have presses nothing", async () => {
  const c = await wireCore({ with: ["frames"] });
  core = c;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  const cl = c.client();
  const before = c.herdr.keys.length;

  await onAnswer(cl.sock, { id: wireId("w9:p99"), fingerprint: "whatever", choice: 1 });

  expect(result(cl)!.reason).toBe("gone");
  expect(c.herdr.keys.slice(before)).toEqual([]);
});
