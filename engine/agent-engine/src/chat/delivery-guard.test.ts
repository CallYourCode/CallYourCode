/* THE DELIVERY GUARD: the code that decides whether to type into a live
 * terminal somebody is working in.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS THE MOST IMPORTANT ONE IN THE SUITE
 *
 * Three versions of the delivery fix shipped and failed, and every one of them
 * failed on a TERMINAL BEHAVIOUR a test file had merely asserted. So the rule
 * here is that nothing is asserted about a pane that was not measured on one:
 * typing appends, enter submits only a NONEMPTY box, ctrl+c is eaten by a
 * running turn and empties an idle box, ctrl+u clears nothing, and pane.read
 * honours `format`. All of that lives in test-utils/fake-herdr.ts, and this file
 * drives the REAL MuxAdapter over the REAL herdr JSON-RPC framing on top of it.
 *
 * TWO HALVES, and the seam between them is deliberate:
 *
 *   1. CLASSIFICATION. classifyPaneBox over screens CAPTURED off live claude
 *      panes, byte for byte (fixtures/README.md). Every delivery-guard defect on
 *      this branch was agreed with by a harness that drew its own screens, so
 *      these are the real ones. Pure, no wiring, no engine.
 *   2. THE DECISION. What the engine actually does with a message when the pane
 *      is showing one of those screens: what is typed, what is submitted, what
 *      is written to the chat, and what the sender is told. Over wireCore, which
 *      is server.ts's own boot in process.
 *
 * `submitted` is what the AGENT RECEIVED; `herdr.texts` is what the engine ASKED
 * herdr to type. They are different questions and only the first one answers
 * "did the message arrive": an enter pressed at an empty box returns success and
 * submits nothing at all.
 *
 * The attachment half of the old multipart.test.ts is in multipart.test.ts.
 *
 *   bun test agent-engine/src/chat/delivery-guard.test.ts
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";

import { classifyPaneBox, refusesDelivery, SGR, type PaneBox } from "../terminal/herdr.ts";
import { unsubmitted } from "./pane-deliver.ts";
import { onUtterance } from "./deliver.ts";
import { wireCore, type WireCore, type WireCoreOpts, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { fakeHerdr, PANE } from "../test-utils/fake-herdr.ts";
import { tmpDir, sockPath } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

type PaneBoxKind = PaneBox["kind"];

/* ---------------------------------------------------------------- the screens
 *
 * Captured off live claude panes with herdr's `ansi` format and stored
 * unchanged. A comment on each says which CONDITION of classifyPaneBox it is
 * kept for, because that function's branches interact: a screen answered by an
 * early branch never reaches a later one, and twice now a reorder silently moved
 * the screen that covered a condition under a different branch. */
const fixture = (name: string) => Bun.file(join(import.meta.dir, "..", "fixtures", name)).text();

const ORDINARY_TURN = await fixture("pane-ordinary-turn.txt");
const PERMISSION_PROMPT = await fixture("pane-permission-prompt.txt");
/* The same prompt with one unrelated rule earlier on screen: a markdown `---`
 * renders as a full-width one, so two rules is not rare. */
const PROMPT_PLUS_RULE = "earlier output\n" + "─".repeat(80) + "\nmore\n" + PERMISSION_PROMPT;
/* The same prompt with its question and footer scrolled off, plus a stray rule
 * above, so the only thing left to tell it from an input box is that what
 * follows the last rule does not start with a prompt marker. */
const PROMPT_SCROLLED = await fixture("assembled-prompt-scrolled.txt");
/* A turn actually RUNNING, and mid tool-use. Claude paints the prompt marker
 * grey while it works, and these are the screens a parser reading the `2` of a
 * truecolor introducer as SGR 2 (dim) refuses. */
const TURN_RUNNING = await fixture("pane-turn-running.txt");
const TOOL_USE = await fixture("pane-tool-use.txt");
const PERMISSION_AFTER_TURN = await fixture("pane-permission-after-turn.txt");
/* THE ADVERSARIAL ONE. A literal U+2500 line inside an assistant reply renders
 * as a bare full-width rule; it pairs with the permission panel's own rule into
 * something shaped exactly like an input box, whose interior even opens with
 * "> quoted". */
const PROMPT_AFTER_RULE_IN_PROSE = await fixture("pane-prompt-after-rule-in-prose.txt");
/* A healthy idle pane holding a typed body that itself contains a full-width
 * rule: relaying another agent's reply. Captured live. */
const BODY_WITH_RULE = await fixture("pane-body-with-rule.txt");
/* A typed body whose LAST row is a rule. This is the one that discriminates:
 * with a positional opening rule the interior collapses to nothing and the box
 * disappears entirely. A rule in the MIDDLE of a body does not discriminate. */
const BODY_ENDING_IN_RULE = await fixture("pane-body-ending-in-rule.txt");
/* The /model picker: a chooser that draws no rules at all, so the box search
 * cannot see it and the whole screen goes to parseAsk. Captured live off 2.1.222
 * at 100 and 60 columns. It classified `unknown`, and `unknown` DELIVERS, so the
 * body was typed at it and swallowed and the enter behind it set the highlighted
 * model as the default. */
const MODEL_PICKER = await fixture("pane-model-picker-2.1.222-100col.txt");
const MODEL_PICKER_60 = await fixture("pane-model-picker-2.1.222-60col.txt");
/* AND THE ONE THAT STAYS `unknown`: the same picker on 2.1.221 with one more
 * model than fits, so the last visible choice carries a `↓` in the caret column
 * and the run is short by one. Four buttons for five models is the app claiming
 * a list it does not have, and `unknown` is the honest verdict for it. */
const MODEL_PICKER_SCROLLED = await fixture("pane-model-picker.txt");
/* HIS PANE, captured live from w9:p4 on 2026-08-04 while the app was refusing
 * every message he sent. An idle healthy box, `❯` and all. At 59 columns the
 * box's closing rule (68 wide) wraps onto TWO rows and the promo banner renders
 * on the same line as the opening rule, so the opening-rule search found
 * nothing. It is `input` now, because the box is found from its BOTTOM edge and
 * the marker above it. */
const NARROW_BANNER_WRAPPED_RULE = await fixture("pane-narrow-banner-wrapped-rule.txt");
/* A FRESHLY STARTED CLAUDE, 2.1.222, on a throwaway tmux server. It prints a
 * highlighted tip INSIDE the top edge of its input box, so there is no pair of
 * rules to find; at 60 columns the tip displaces the leading run entirely. Every
 * pane on his machines read `unknown` because of it. */
const FRESH_CLAUDE_60 = await fixture("pane-fresh-claude-60col.txt");
const FRESH_CLAUDE_100 = await fixture("pane-fresh-claude-100col.txt");
/* THE GHOST TEXT, Claude Code 2.1.228. An empty composer paints a grey
 * suggestion the user never typed (`❯ \x1b[2mTry "fix lint errors"\x1b[0m`), and
 * 2.1.22x drew the misread that filed #495. It is the WHOLE reason the box is
 * read as ANSI: the `\x1b[2m` dim is the only thing separating that ghost from a
 * draft, and on the ansi wire it survives. */
const GHOST_SUGGESTION_228 = await fixture("pane-ghost-suggestion-2.1.228.txt");
/* And reworded, so none of the phrases the chooser test knows appear. */
const PROMPT_REWORDED = PROMPT_PLUS_RULE
  .replace("Do you want to proceed?", "Shall I go ahead with this one?")
  .replace("Esc to cancel · Tab to amend", "esc quits");

/* ------------------------------------------------------------- 1. CLASSIFYING
 *
 * No wiring below this line until section 2. */

/** The old boolean question, for the box cases: an input box with something in
 *  it. Anything that is not an input box answers false here and is asserted
 *  separately, because the delivery path treats it as a third thing entirely. */
const hasContent = (screen: string) => {
  const b = classifyPaneBox(screen);
  return b.kind === "input" && b.hasContent;
};

const box = (row: string) =>
  ["(transcript)", "", "─".repeat(60), row, "─".repeat(60), "  model · ctx 1%"].join("\n");

/* ONE SCREEN PER CONDITION, AND EACH SAYS WHICH CONDITION IT IS FOR.
 *
 * Four rounds running, a condition on this function turned out to have no test
 * behind it, twice because a reorder silently moved the screen that used to
 * cover it under a different branch. So the table names the condition each row
 * exists for. Every screen is a capture unless its name says assembled. */
const CLASSIFIER_CASES: Array<{ screen: string; expect: PaneBoxKind; forCondition: string }> = [
  // -- branch one: what sits BELOW the last rule
  { screen: PERMISSION_PROMPT, expect: "chooser", forCondition: "below-the-rule chooser" },
  { screen: PROMPT_AFTER_RULE_IN_PROSE, expect: "chooser", forCondition: "below-the-rule chooser" },
  { screen: PERMISSION_AFTER_TURN, expect: "chooser", forCondition: "below-the-rule chooser" },
  { screen: PROMPT_PLUS_RULE, expect: "chooser", forCondition: "below-the-rule chooser" },

  // -- branch two: the box, found from its bottom edge and the marker above it
  { screen: ORDINARY_TURN, expect: "input", forCondition: "the marker above the closing edge" },
  { screen: BODY_WITH_RULE, expect: "input", forCondition: "a rule in the body is indented" },
  { screen: BODY_ENDING_IN_RULE, expect: "input", forCondition: "a rule in the body is indented" },
  { screen: TURN_RUNNING, expect: "input", forCondition: "truecolor is not dim" },
  { screen: TOOL_USE, expect: "input", forCondition: "truecolor is not dim" },
  { screen: NARROW_BANNER_WRAPPED_RULE, expect: "input", forCondition: "an edge that is not a rule" },
  { screen: FRESH_CLAUDE_60, expect: "input", forCondition: "an edge that is not a rule" },
  { screen: FRESH_CLAUDE_100, expect: "input", forCondition: "an edge that is not a rule" },

  // -- a chooser with no rules at all: the region scanned is the whole screen
  { screen: MODEL_PICKER, expect: "chooser", forCondition: "a chooser that draws no rules" },
  { screen: MODEL_PICKER_60, expect: "chooser", forCondition: "a chooser that draws no rules" },

  // -- nothing matched, and that is a verdict rather than a failure
  { screen: MODEL_PICKER_SCROLLED, expect: "unknown", forCondition: "refuse when unsure" },
  { screen: PROMPT_SCROLLED, expect: "unknown", forCondition: "refuse when unsure" },
  { screen: PROMPT_REWORDED, expect: "unknown", forCondition: "refuse when unsure" },
  { screen: "a plain shell, no box anywhere", expect: "unknown", forCondition: "refuse when unsure" },
];

test("every pane screen classifies as what it is, and every branch is reached", () => {
  for (const c of CLASSIFIER_CASES) {
    expect(
      classifyPaneBox(c.screen).kind,
      `wrong for the screen kept for "${c.forCondition}"`,
    ).toBe(c.expect);
  }
  // all three outcomes this table can produce are exercised, or a branch has
  // nothing behind it
  expect(new Set(CLASSIFIER_CASES.map((c) => c.expect)).size,
    "a branch of classifyPaneBox has no screen in this table").toBe(3);
});

/* AND `unknown` IS NOT A REASON TO REFUSE.
 *
 * This is the assertion that would have caught the four hours on 2026-08-04 when
 * the app refused every message he sent and told him the session was not ready.
 * Nothing tested the DECISION: the table above tests what the classifier says,
 * and every screen it could not recognise was assumed to be worth refusing. It
 * is not. The guard exists for ONE failure, typing into a chooser where the
 * message is swallowed and the enter answers Yes, and that failure is `chooser`. */
test("a screen with no chooser on it is delivered to, even when the box is not recognised", () => {
  const shell = classifyPaneBox("$ ls\nREADME.md  src\n$ ");
  expect(shell.kind, "a plain shell is not a shape this classifier knows").toBe("unknown");
  expect(refusesDelivery(shell.kind),
    "an unrecognised shape is not a chooser, and refusing it cost him four hours of messages",
  ).toBe(false);
  expect(refusesDelivery("chooser"), "the one failure this guard exists for").toBe(true);
  expect(refusesDelivery("unreadable"), "blind is different from unrecognised").toBe(true);
  expect(refusesDelivery("input")).toBe(false);
});

/* THE OPENING RULE IS NOT THE SECOND-TO-LAST ONE.
 *
 * A body containing a full-width U+2500 line puts a rule inside the box, and
 * counting backwards two rules lands on THAT instead of the box's own top. The
 * interior then starts mid-message with no prompt marker, the box is not
 * recognised, and delivery is refused with a sentence saying the session is
 * waiting on a prompt in the terminal, which is untrue. Nothing on screen
 * changes, so every later message refuses again: permanently unsendable-to. */
test("a typed body containing a rule is still a typed body", () => {
  expect(
    classifyPaneBox(BODY_WITH_RULE),
    "a rule inside the typed body was mistaken for the top of the input box, so a healthy " +
    "pane with a message waiting in it was refused -- and the refusal changes nothing on " +
    "screen, so it refuses for ever",
  ).toEqual({ kind: "input", hasContent: true });

  /* AND THE ONE THAT ACTUALLY DISCRIMINATES. The screen above does not: with a
   * positional opening rule its interior becomes the body's tail, which is
   * still non-empty content, so the verdict is unchanged and the assertion
   * passes against the bug. Measured, after writing it. */
  expect(
    classifyPaneBox(BODY_ENDING_IN_RULE),
    "a body whose last row is a rule was not recognised as a box at all, so the pane is " +
    "refused and stays refused",
  ).toEqual({ kind: "input", hasContent: true });
});

/* A CHOOSER WITH NO RULE AT ALL.
 *
 * While the picker classified `unknown` the engine typed his message at it --
 * swallowed -- and then pressed enter, which is the key that sets the
 * highlighted model as the default. The assertion is refusesDelivery over the
 * real screen, and it is only satisfied by the picker being recognised. */
test("a message is never typed at the /model picker", () => {
  const picker = classifyPaneBox(MODEL_PICKER);
  expect(picker.kind,
    "the /model picker was not recognised as a chooser, and `unknown` is delivered to: the " +
    "body is typed at it and swallowed, and the enter behind it sets the highlighted model",
  ).toBe("chooser");
  expect(refusesDelivery(picker.kind)).toBe(true);
  expect(refusesDelivery(classifyPaneBox(MODEL_PICKER_60).kind)).toBe(true);

  /* THE CLASSIFIER STILL DELIVERS TO `unknown` -- refusesDelivery is unchanged,
   * and refusing on `unknown` is the named four-hour regression. What used to be
   * the standing trade (the scrolled picker gets the body typed at it and
   * swallowed) is now caught end to end by the ECHO GATE, not by the classifier:
   * the pane is typed at, the tail does not appear, no enter is pressed, and the
   * send fails on its cid. That is the "scrolled picker gets nothing submitted"
   * test below, which supersedes the old assertion here. */
  expect(refusesDelivery(classifyPaneBox(MODEL_PICKER_SCROLLED).kind)).toBe(false);
});

/* THE DIM SUGGESTION, which is about hasContent rather than kind. */
test("the input-box parser tells a dim suggestion from something typed", () => {
  expect(
    hasContent(box("❯ \x1b[0m\x1b[2mnow echo goodbye\x1b[0m\r")),
    "a dim suggestion in an EMPTY box was read as content, so the engine presses enter at an " +
    "empty box and the message is gone",
  ).toBe(false);
  expect(hasContent(box("❯ \r")), "a blank box was read as content").toBe(false);
  expect(
    hasContent(box("❯ SHORTBODY " + "a".repeat(108) + "\r")),
    "a typed body was read as empty, so a stranded message gets typed twice",
  ).toBe(true);
  expect(
    hasContent(box("❯ [Pasted text #1][Pasted text #2]\r")),
    "a placeholder-collapsed body was read as empty",
  ).toBe(true);
  expect(
    hasContent(box("❯\xa0\x1b[0m\x1b[2mRun this in bash and wait for it: sleep 50\x1b[0m")),
    "the same ghost with an NBSP after the prompt was read as content",
  ).toBe(false);
  expect(hasContent(""), "an empty read authorised a blind enter").toBe(false);
  expect(hasContent("no box here at all"), "a screen with no box authorised one").toBe(false);
  expect(
    hasContent(box("❯ \x1b[2mdim\x1b[22m\x1b[2m and more dim\x1b[0m\r")),
    "a box that is entirely dim in several runs was read as content",
  ).toBe(false);
});

/* THE SAME THING ON A REAL 2.1.228 SCREEN, not a hand-built row (#495). The CLI
 * that draws this ghost is the one the operator misread as a stuck draft, and
 * the question was whether the guard misreads it too. It does not, and this pins
 * WHY on the actual bytes so a herdr or CLI change that erases the distinction
 * fails here rather than on his phone. */
test("a real 2.1.228 ghost-suggestion capture reads as an empty box, and the dim byte is why", () => {
  expect(
    GHOST_SUGGESTION_228.includes("\x1b[2m"),
    "the fixture lost its dim SGR, so this no longer tests what separates a ghost from a draft",
  ).toBe(true);
  expect(
    classifyPaneBox(GHOST_SUGGESTION_228),
    "a real empty composer carrying claude 2.1.228's grey suggestion was read as an input box " +
    "holding content: the engine would press enter at a ghost and lose the stranded body",
  ).toEqual({ kind: "input", hasContent: false });
  // and prove the dim is the load-bearing byte: strip it, as a plain-text read
  // would, and the very same screen flips to occupied.
  expect(
    hasContent(GHOST_SUGGESTION_228.replace(SGR, "")),
    "stripped of ANSI the ghost reads as content -- which is exactly why readPane must ask for ansi",
  ).toBe(true);
});

/* A PANE THAT IS ACTUALLY DOING SOMETHING, which is his main path. The engine
 * types into BUSY panes on purpose (that is what the queued divider is), so a
 * classifier that cannot read a running pane refuses most of every turn. It did:
 * claude paints the prompt marker grey while it works, and the `2` in the
 * truecolor introducer `38;2;153;153;153` was being read as SGR 2, dim, which
 * discarded the rest of the row and left the box looking like no box at all. */
test("a pane in the middle of a turn is still a pane with an input box", () => {
  expect(
    classifyPaneBox(TURN_RUNNING),
    "a STREAMING pane was not recognised as having an input box, so delivery is refused for " +
    "most of every turn -- on the path the queued divider exists to support",
  ).toEqual({ kind: "input", hasContent: false });
  expect(
    classifyPaneBox(TOOL_USE),
    "a pane mid tool-use was not recognised as having an input box",
  ).toEqual({ kind: "input", hasContent: false });

  /* And the colour itself, isolated: a truecolor foreground is not dimness.
   * `38;5;N` is the 256-colour form and skips a different number of arguments;
   * `48;2;…` is a background. None of them may hide the row. */
  expect(classifyPaneBox(box("\x1b[38;2;153;153;153m❯\xa0\x1b[0m\r")).kind).toBe("input");
  expect(classifyPaneBox(box("\x1b[38;5;2m❯ typed in 256 colour\x1b[0m\r")))
    .toEqual({ kind: "input", hasContent: true });
  expect(classifyPaneBox(box("\x1b[48;2;55;55;55m❯ on a background\x1b[0m\r")))
    .toEqual({ kind: "input", hasContent: true });
  // and a genuinely dim body is still decoration, which is the whole point
  expect(classifyPaneBox(box("❯ \x1b[0m\x1b[2mnow echo goodbye\x1b[0m\r")))
    .toEqual({ kind: "input", hasContent: false });
});

/* AND THE FAKE ITSELF, because the ANSI tests below are only worth anything if
 * it can tell the two reads apart. herdr's `pane.read` returns stripped text by
 * default and escapes only for `format: "ansi"`; a fake that ignored the
 * parameter would agree with any reader, correct or not, and a `strip_ansi:
 * true` slipped back into readPane would stay green here while refusing delivery
 * on every live pane with a turn running. */
test("the fake terminal answers ansi and stripped text differently", async () => {
  const dir = await tmpDir("cyc-fakeread-");
  const sock = sockPath(dir);
  const fake = fakeHerdr(sock);
  const read = (params: Record<string, unknown>) =>
    new Promise<string>((resolve, reject) => {
      let buf = "";
      Bun.connect({
        unix: sock,
        socket: {
          open(s) {
            s.write(JSON.stringify({ id: "1", method: "pane.read",
              params: { pane_id: PANE, source: "visible", lines: 40, ...params } }) + "\n");
          },
          data(s, chunk) {
            buf += chunk.toString();
            if (!buf.includes("\n")) return;
            s.end();
            resolve(JSON.parse(buf.slice(0, buf.indexOf("\n"))).result.read.text);
          },
          error(_s, e) { reject(e); },
        },
      }).catch(reject);
    });
  try {
    const ansi = await read({ format: "ansi" });
    const plain = await read({ format: "text" });
    const stripped = await read({ format: "ansi", strip_ansi: true });
    expect(ansi, "the fake never draws the dim ghost, so nothing tests reading it").toContain("\x1b[2m");
    expect(plain, "the fake ignored `format` and answered escapes to a caller that asked for text")
      .not.toContain("\x1b");
    expect(stripped, "the fake ignored `strip_ansi`, so putting it back in readPane stays green")
      .not.toContain("\x1b");
    expect(plain, "the two forms differ by more than the escapes").toBe(ansi.replace(SGR, ""));
  } finally {
    fake.stop(true);
  }
});

/* ---------------------------------------------------------------- 2. DECIDING
 *
 * Everything below drives the real delivery path over wireCore: onUtterance ->
 * the per-session order chain -> the upload binder -> the dials instruction ->
 * the guard's screen read -> herdr send_text -> herdr enter. */

/* THE THREE DELIVERY TIMINGS, SHORTENED AT FILE SCOPE.
 *
 * They are wall-clock by nature -- the settle is a pause a real TUI needs, the
 * TTL is the age of a body sitting in a real input box -- so there is no logical
 * clock to advance, only a real one to make small. adapters/mux-adapter.ts reads
 * all three on every use for exactly this reason.
 *
 * The TTL is 500ms rather than 50: a retry issued microseconds after the failure
 * must still find the note BELIEVABLE, and the file has to survive a box running
 * thirty of these at once. The one test that needs the note to expire waits for
 * the note's own stamp to age rather than for a number of milliseconds. */
const STRANDED_TTL_MS = 500;
const ENV: Record<string, string> = {
  DELIVER_SETTLE_MS: "5",
  CONFIRM_SETTLE_MS: "5",
  RESTRAND_SETTLE_MS: "50",
  STRANDED_TTL_MS: String(STRANDED_TTL_MS),
};
const priorEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) { priorEnv[k] = process.env[k]; process.env[k] = v; }
});
afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

/** One wiring with the delivery layer up and its single pane reconciled. */
async function rig(o: WireCoreOpts = {}): Promise<WireCore> {
  core = await wireCore({ with: ["delivery"], ...o });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  return core;
}

/** The engine's own words about why a message did not go. */
const droppedWhy = (c: WireCore) =>
  c.logs.filter((l) => l.event === "utterance.dropped").map((l) => String(l.fields.why));

/** The `send-failed` frames the sender's socket received: the honest-checkmark
 *  half. A failure after the ack demotes the row from the single 'sent' tick to
 *  'failed' with this reason, rather than a grey notice bubble (F2). */
const failedFrames = (cl: FakeClient) =>
  cl.of("send-failed").map((f) => ({ cid: String(f.cid), reason: String(f.reason) }));

/* AND END TO END, ON BOTH SIDES OF THE LINE. The fake serves the CAPTURED bytes
 * here rather than a screen it drew for itself, which is the point: an earlier
 * version of this test used a synthesised prompt with no input box in it, so it
 * passed while the engine refused delivery to a healthy pane. */
test("a healthy pane whose turn ended in a numbered list is still delivered to", async () => {
  const c = await rig({ screens: { [PANE]: ORDINARY_TURN } });
  const cl = c.client();

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-ordinary", text: "start with alpha please" });

  expect(
    cl.of("chat").filter((f) => f.role === "user" && f.text === "start with alpha please"),
    "delivery was refused to a session sitting idle at a healthy input box, because its last " +
    "turn happened to end in a numbered list and a question. Retrying cannot clear it",
  ).toHaveLength(1);
  expect(c.herdr.texts.length, "the message was not typed into the pane").toBe(1);
  expect(c.submitted.length, "the agent never received it").toBe(1);
  expect(c.submitted[0].text).toContain("start with alpha please");
  /* The 'input' verdict skips the echo gate, and the post-enter confirm
   * reads the pinned ORDINARY_TURN as an empty box => consumed. A healthy
   * delivery must NOT fail on its cid. */
  expect(failedFrames(cl), "a healthy delivery reported a send-failure").toEqual([]);
});

/* THE OTHER HALF: the default-draw pane, which ECHOES what is typed and
 * empties on the enter. The pre-send read is the empty ghost box ('input'), so
 * the gate is skipped; the post-enter read is the empty ghost box again =>
 * consumed. Delivered once, no send-failure. */
test("a healthy default-draw pane delivers once and never reports a failure", async () => {
  const c = await rig();
  const cl = c.client();

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-healthy", text: "hello there" });

  expect(cl.of("chat").filter((f) => f.role === "user" && f.text === "hello there"),
    "a healthy send did not commit its chat row").toHaveLength(1);
  expect(c.submitted.length, "the agent did not receive exactly one message").toBe(1);
  expect(c.submitted[0].text).toContain("hello there");
  expect(failedFrames(cl), "a healthy delivery reported a send-failure").toEqual([]);
});

test("a message arriving while the pane asks permission sends nothing at all", async () => {
  const c = await rig({ screens: { [PANE]: PERMISSION_PROMPT } });
  const cl = c.client();

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-perm", text: "are you nearly done?" });

  /* THE FALSE-CHECKMARK HALF (F2): the failure lands on the row via a
   * send-failed on the cid, not a grey notice bubble. The reason is the one
   * thing he needs to unstick it -- that the session is waiting on a prompt. */
  const failed = failedFrames(cl);
  expect(failed, "the row was never told the send failed").toHaveLength(1);
  expect(failed[0].cid, "the send-failed carried the wrong cid").toBe("c-perm");
  expect(
    failed[0].reason,
    "the reason does not say the session is waiting on a prompt, which is the one thing he " +
    "needs to know to unstick it",
  ).toMatch(/prompt|waiting/i);

  expect(
    c.herdr.texts,
    "the engine typed the message at a permission prompt, where typing is swallowed: the " +
    "message is gone with no trace",
  ).toEqual([]);
  expect(
    c.herdr.keys.filter((k) => k.keys.includes("enter")),
    "THE ENGINE PRESSED ENTER AT A PERMISSION PROMPT. That selects the highlighted option, " +
    "which is Yes: it approved something on his behalf",
  ).toEqual([]);
  expect(c.submitted, "the agent received a message nobody typed at it").toEqual([]);
  expect(
    cl.of("chat").filter((f) => f.role === "user" && f.text === "are you nearly done?"),
    "a message that was never delivered was written into the chat log as though it had been",
  ).toEqual([]);
});

/* THE TWO-RULE PROMPT, END TO END, which is the case the chooser branch exists
 * for. Without that branch this screen reads as an input box holding content, and
 * the engine presses enter at `❯ 1. Yes`. */
test("a prompt with a stray rule above it still gets nothing sent at it", async () => {
  const c = await rig({ screens: { [PANE]: PROMPT_PLUS_RULE } });
  const cl = c.client();

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-rule", text: "any news?" });

  expect(
    c.herdr.keys.filter((k) => k.keys.includes("enter")),
    "enter was pressed at a permission prompt that had one unrelated rule above it, which " +
    "selects Yes",
  ).toEqual([]);
  expect(c.herdr.texts, "the body was typed at a prompt that swallows it").toEqual([]);
  expect(c.submitted).toEqual([]);
  /* The false-checkmark half: the row is failed on its cid. */
  const failed = failedFrames(cl);
  expect(failed, "the row was never told the send failed").toHaveLength(1);
  expect(failed[0].cid).toBe("c-rule");
});

/* THE OTHER HALF: THE FAILURE MESSAGE TELLS THE TRUTH.
 *
 * Every delivery failure said "the session is offline", including the ones where
 * the pane is alive and simply would not take the keystrokes. That is the app
 * asserting something it does not know, and it sends whoever is debugging it to
 * look for a dead pane that is not dead. */
test("a live pane that refuses the keystrokes is not reported as an offline session", async () => {
  const c = await rig({ failKeys: () => true }); // every keystroke refused
  const cl = c.client();

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-refused", text: "this will not go in" });

  const failed = failedFrames(cl);
  expect(failed, "the row was told nothing at all about a message that never arrived")
    .toHaveLength(1);
  expect(failed[0].cid).toBe("c-refused");
  expect(failed[0].reason).toMatch(/not delivered/);
  expect(
    failed[0].reason,
    "a live pane that refused the keystrokes was reported to the user as an offline session",
  ).not.toContain("offline");

  const why = droppedWhy(c).join("\n");
  expect(why, `the log says the same untrue thing: ${why}`).not.toContain("the session is offline");
  expect(why).toContain("would not take the keystrokes");
  expect(c.submitted, "the agent received a message the engine said it had not delivered")
    .toEqual([]);
});

/* A RETRY MUST NOT DOUBLE-TYPE THE MESSAGE.
 *
 * Delivery is two RPCs, text then enter, and only the pair is a delivery. Fail
 * the enter: the engine rolls back, writes no chat entry and tells the app the
 * message was not delivered -- while the complete body sits in the pane's input.
 * The app's answer to a failure is to send it again, and the retry used to type
 * the same body onto the end of the stranded one, so the agent read it twice,
 * joined.
 *
 * The assertion is the one an earlier version of this test missed by asserting a
 * keystroke instead: across BOTH attempts the body is typed exactly ONCE, and
 * the agent receives exactly one message. Measured on a real pane (w9:p14): a
 * body typed and left unsubmitted is submitted whole by a single enter. */
test("a retry after a failed enter submits the stranded body rather than typing it again", async () => {
  let refuseEnter = true;
  const c = await rig({ failKeys: (keys) => refuseEnter && keys.includes("enter") });
  const cl = c.client();

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-strand-1", text: "the first attempt" });
  expect(failedFrames(cl), "the failed enter was not reported on the row at all").toHaveLength(1);
  expect(failedFrames(cl)[0].cid, "the send-failed carried the wrong cid").toBe("c-strand-1");
  expect(
    cl.of("chat").filter((f) => f.role === "user" && f.text === "the first attempt"),
    "the engine wrote a chat entry for a message whose enter never landed",
  ).toEqual([]);
  // the engine remembers what it typed and could not submit, keyed by the cid
  expect(unsubmitted.get(PANE)?.deliveryId, "no note was kept about the stranded body").toBe(
    "c-strand-1");

  // the app's answer to a failure: send it again -- with the
  // SAME cid, which is how the app retries (offline design v2: a tap resends the
  // same cid). The note is keyed by that cid, so the enter-only dedupe holds.
  refuseEnter = false;
  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-strand-1", text: "the first attempt" });
  expect(
    cl.of("chat").filter((f) => f.role === "user" && f.text === "the first attempt"),
    "the retry did not land either",
  ).toHaveLength(1);

  expect(
    c.herdr.texts.map((t) => t.text),
    "the body was typed into the pane twice. The failed attempt left it in the input, so the " +
    "retry appended a second copy to it and the agent reads one doubled message",
  ).toEqual([c.herdr.texts[0].text]);
  /* AND THE AGENT ACTUALLY GOT IT. Counting what was typed cannot tell a
   * delivery from an enter pressed at an empty input; only this can. */
  expect(c.submitted.length,
    `the agent received ${c.submitted.length} messages, not one`).toBe(1);
  expect(c.submitted[0].text).toContain("the first attempt");
  // and the note is dropped the moment an enter lands
  expect(unsubmitted.has(PANE), "the note outlived the delivery it described").toBe(false);
});

/* F2: THE TTL BOUNDS THE AGE OF THE TYPED BODY, NOT THE GAP BETWEEN RETRIES.
 *
 * `unsubmitted.set(...)` used to run on both branches, so every retry that
 * merely pressed enter restamped the note and the clock started again. A chain
 * of retries could then keep a note alive indefinitely, which is exactly the
 * staleness the TTL exists to stop. */
test("a chain of retries does not keep the note alive past its lifetime", async () => {
  let refuseEnter = true;
  const c = await rig({ failKeys: (keys) => refuseEnter && keys.includes("enter") });
  const cl = c.client();
  const body = "the one that keeps failing";
  // The SAME cid across every retry, the way the app resends (offline design v2).
  const cid = "c-chain-1";

  await onUtterance(cl.sock, { id: wireId(PANE), cid, text: body });
  const stampedAt = unsubmitted.get(PANE)!.at;
  expect(c.herdr.texts.length, "the first attempt never typed anything").toBe(1);

  // still inside the TTL: this one must press enter, not type the body again
  await onUtterance(cl.sock, { id: wireId(PANE), cid, text: body });
  expect(c.herdr.texts.length, "a retry inside the TTL retyped the body").toBe(1);
  /* THE MUTATION TARGET. The note's stamp is the age of the BODY, so an
   * enter-only retry must not move it. Restamped, the third attempt below would
   * still find the note fresh and press enter at a box it has no claim on. */
  expect(unsubmitted.get(PANE)!.at,
    "the enter-only retry restamped the note, so the TTL now bounds the gap between retries " +
    "instead of the age of the body it describes").toBe(stampedAt);

  /* Now let it genuinely age out. Waited on the NOTE'S OWN STAMP rather than on
   * a number of milliseconds, so a loaded box cannot make this pass early. */
  await until(() => Date.now() - stampedAt >= STRANDED_TTL_MS,
    { timeoutMs: STRANDED_TTL_MS * 4, what: "the stranded note to age past its lifetime" });

  refuseEnter = false;
  await onUtterance(cl.sock, { id: wireId(PANE), cid, text: body });
  expect(
    c.herdr.texts.length,
    "the note was still believed past its lifetime: an expired claim about what is sitting in " +
    "a pane is exactly what the TTL exists to stop believing",
  ).toBe(2);
  expect(c.submitted.length, "nothing was ever delivered").toBe(1);
});

/* AND THE NOTE IS NOT BELIEVED FOR A DIFFERENT BODY.
 *
 * "The body is already in that pane" is a claim about one particular string.
 * Pressing enter at an input holding somebody else's text submits the wrong
 * thing while the engine reports success, which is worse than typing twice. */
test("a different body is always typed, never assumed to be in the pane already", async () => {
  let refuseEnter = true;
  const c = await rig({ failKeys: (keys) => refuseEnter && keys.includes("enter") });
  const cl = c.client();

  await onUtterance(cl.sock, { id: wireId(PANE), text: "the one that failed" });
  refuseEnter = false;
  await onUtterance(cl.sock, { id: wireId(PANE), text: "a completely different message" });

  const typed = c.herdr.texts.map((t) => t.text);
  expect(typed.length,
    `a different message was not typed into the pane: ${JSON.stringify(typed)}`).toBe(2);
  expect(typed[1]).toContain("a completely different message");
});

/* THE READ MUST BE ANSI, AND THIS IS THE TEST THAT DIES IF IT STOPS BEING.
 *
 * Two branches each grew their own `readPane`, and the other one asked herdr for
 * `format: "text", strip_ansi: true`, because it wanted words. Merged wrong,
 * that setting silently destroys the only byte this side has: claude paints a
 * DIM suggestion into an empty input box a few seconds after it empties, and
 * without the SGR that ghost and a real draft are the same characters.
 *
 * What that costs, exactly, is a lost message, so that is what is asserted here
 * rather than any property of the read itself:
 *
 *   1. a body is typed and the enter is refused, so a note is left saying the
 *      body is sitting in that pane unsubmitted;
 *   2. he presses ctrl+c at the keyboard, which the engine never hears about,
 *      and the box empties and grows its dim ghost;
 *   3. the same body is sent again.
 *
 * Reading ANSI, the box is empty, so the retry TYPES the body and the agent gets
 * it. Reading stripped text, the ghost reads as our body still being there, so
 * the retry presses enter at an empty box, which submits nothing at all while the
 * engine reports success. Typed twice is recoverable; this is not. */
test("a retry after the box was emptied by hand types the body again", async () => {
  let refuseEnter = true;
  const c = await rig({ failKeys: (keys) => refuseEnter && keys.includes("enter") });
  const cl = c.client();
  const body = "the body that was interrupted";
  // The SAME cid on both, the byte-identical retry the way the app resends: the
  // note is believed (same id, inside its TTL), so it is the PANE READ, not a
  // key miss, that must decide the box is empty and type the body again.
  const cid = "c-emptied-1";

  await onUtterance(cl.sock, { id: wireId(PANE), cid, text: body });
  expect(c.herdr.texts.length, "the first attempt never typed anything").toBe(1);

  refuseEnter = false;
  c.hooks.clearInput!(PANE); // ctrl+c at the keyboard: the engine is not told
  await onUtterance(cl.sock, { id: wireId(PANE), cid, text: body }); // byte-identical retry

  expect(
    c.herdr.texts.length,
    "the retry did not type the body again. The input had been emptied by hand and only the " +
    "dim suggestion was in it, so reading the pane as ANSI-stripped text called an empty box " +
    "occupied and the engine pressed enter at nothing",
  ).toBe(2);
  expect(
    c.submitted.length,
    "the agent received nothing: enter at an emptied box submits nothing while the engine " +
    "reports the message delivered",
  ).toBe(1);
  expect(c.submitted[0].text).toContain(body);
});

/* A LONG MESSAGE IS NOT A LOST MESSAGE.
 *
 * herdr's RPC frame was written with one `sock.write()` whose return value was
 * discarded. A unix socket takes 8192 bytes and reports it; the rest was never
 * sent, herdr waited for the end of a line that was not coming, and the RPC timed
 * out. The engine then dropped the message entirely: no bubble, no chat entry,
 * and the app's retry failed the same way for ever.
 *
 * Pre-existing, and it needed no attachments: ~8,000 characters of pasted text is
 * enough. The size here is well past the ceiling and in the range a real
 * composition reaches (60 attachments measured at ~7,800 characters). The whole
 * frame arriving IS the assertion: a truncated one does not parse, so the fake
 * would never answer it and the delivery would time out. */
test("a message far past the socket's write ceiling arrives whole", async () => {
  const c = await rig();
  const cl = c.client();
  // 40,000 characters: ~5x the 8192-byte ceiling, and past the 62KB frame that
  // was measured returning 8192 from a single write.
  const long = "x".repeat(40_000);

  await onUtterance(cl.sock, { id: wireId(PANE), text: long });

  expect(
    cl.of("chat").filter((f) => f.role === "user" && f.text?.length === long.length),
    "a 40,000-character message never reached the chat log. The engine wrote 8192 bytes of " +
    "its herdr frame and dropped the rest, so the RPC timed out and the message was discarded",
  ).toHaveLength(1);
  expect(c.herdr.texts.length, "the long message was not typed into the pane exactly once").toBe(1);
  expect(
    c.submitted.length,
    "the pane never SUBMITTED the long message, so the agent has it sitting in its input box",
  ).toBe(1);
  expect(c.submitted[0].text, "the body arrived corrupted rather than merely short").toContain(long);
});

/* ---------------------------------------------- 3. THE ECHO GATE + CONSUMPTION
 *
 * The harness-agnostic detector for a pane this engine has no parser for, plus
 * the post-enter confirm that makes commitDelivery a true receipt. A pinned
 * screen OVERRIDES the fake's input model, so a pinned screen never echoes the
 * typed text -- which is exactly the measured behaviour of a modal. That makes a
 * pinned screen the natural echo-gate rig with no fake changes. */

/* A NON-CLAUDE MODAL SWALLOWS THE TEXT. A codex pane has no parseScreen, so
 * the coarse gates cannot see its prompt; today the body is typed at it and the
 * enter behind it activates the modal's default. With the echo gate the body is
 * typed once, the screen does not echo it, so NO enter is pressed and the send
 * fails on its cid. */
test("T1: a non-claude pane showing a modal swallows the text and nothing is submitted", async () => {
  const c = await rig({ agents: { [PANE]: "codex" }, screens: { [PANE]: PERMISSION_PROMPT } });
  const cl = c.client();

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-codex-modal", text: "codex please run the xyzzy step now" });

  // one type (no parser to refuse before typing), and NO enter (the gate caught it)
  expect(c.herdr.texts.length, "the body was typed more than once at a modal").toBe(1);
  expect(c.herdr.keys.filter((k) => k.keys.includes("enter")),
    "an enter was pressed at a non-claude modal, activating its default").toEqual([]);
  expect(c.submitted, "the agent received a message the modal swallowed").toEqual([]);
  expect(cl.of("chat").filter((f) => f.role === "user"),
    "a swallowed message was written to the chat as though it had been delivered").toEqual([]);
  const failed = failedFrames(cl);
  expect(failed, "the row was never told the send failed").toHaveLength(1);
  expect(failed[0].cid).toBe("c-codex-modal");
  expect(failed[0].reason, "the reason does not say the terminal did not take the text")
    .toMatch(/did not take the text|prompt|menu/i);
});

/* THE SCROLLED MODEL PICKER, claude 'unknown'. The classifier still says
 * `unknown` (unchanged, and refusing on unknown is the four-hour regression),
 * but the echo gate now catches the swallow end to end: typed once, no enter, no
 * model set, and the send fails on its cid. Supersedes the standing-trade
 * assertion in section 1. */
test("T2: the scrolled model picker gets the body typed once, no enter, and fails on its cid", async () => {
  const c = await rig({ screens: { [PANE]: MODEL_PICKER_SCROLLED } });
  const cl = c.client();

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-picker", text: "switch me to the other model please" });

  expect(c.herdr.texts.length, "the body was typed more than once").toBe(1);
  expect(c.herdr.keys.filter((k) => k.keys.includes("enter")),
    "enter was pressed at the scrolled picker, which sets the highlighted model as the default")
    .toEqual([]);
  expect(c.submitted, "the picker swallowed the message but the agent was said to receive it").toEqual([]);
  const failed = failedFrames(cl);
  expect(failed, "the scrolled picker did not fail the send on its cid").toHaveLength(1);
  expect(failed[0].cid).toBe("c-picker");
});

/* A BODY TYPED BUT NOT SUBMITTED. The enter returns success but the box
 * still holds the body (an enter that became a newline). The post-enter confirm
 * reads the box, sees content, and fails honestly with DeliveryStranded -- note
 * KEPT, so a byte-identical retry presses enter only and finally submits it. */
test("T5: a stranded body fails honestly and the retry presses enter only", async () => {
  const c = await rig();
  const cl = c.client();
  const strandedBox = ["(transcript)", "", "─".repeat(60),
    "❯ the stranded body is still sitting right here in the box",
    "─".repeat(60), "  model · ctx 1%"].join("\n");
  // the next enter succeeds but does NOT submit; pane.read then shows content
  c.hooks.strandNextEnter!(PANE, strandedBox);

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-stranded", text: "please do the thing" });

  const failed = failedFrames(cl);
  expect(failed, "the stranded body did not fail on its cid").toHaveLength(1);
  expect(failed[0].cid).toBe("c-stranded");
  expect(failed[0].reason, "the reason does not say the body is typed but not submitted")
    .toMatch(/not submitted|input box/i);
  expect(unsubmitted.has(PANE), "the stranded note was dropped, so a retry cannot press enter only")
    .toBe(true);
  expect(c.submitted, "the fake never submitted the stranded body").toEqual([]);
  const typedBefore = c.herdr.texts.length;

  // the retry, byte-identical and on the SAME cid (the way the app resends a
  // failed send). Clear the pinned box so the retry's enter can land on the
  // default draw (which still holds the body) and submit it.
  c.hooks.setScreen!(PANE, null);
  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-stranded", text: "please do the thing" });

  expect(c.herdr.texts.length, "the retry typed the body again instead of pressing enter only")
    .toBe(typedBefore);
  expect(c.submitted.length, "the retry did not finally submit the stranded body").toBe(1);
  expect(c.submitted[0].text).toContain("please do the thing");
  expect(unsubmitted.has(PANE), "the note outlived the delivery it described").toBe(false);
});

/* A SLOW CLEAR IS NOT A STRAND. The enter submits (the body leaves the
 * box, a user record lands), but the busy claude TUI has not repainted the box
 * empty by the first post-enter read: a single read would false-strand and the
 * app's retry would double the message (measured live 2026-09-07: BZ Builder,
 * two identical user records). The re-read after the longer settle finds the
 * box cleared, so the send SUCCEEDS: submitted once, committed once, no
 * send-failed, no note kept. */
test("T5b: a slow box clear is consumed, not stranded, so the message is not doubled", async () => {
  const c = await rig();
  const cl = c.client();
  const stillHolding = ["(transcript)", "", "─".repeat(60),
    "❯ the body is still painted here right after the enter",
    "─".repeat(60), "  model · ctx 1%"].join("\n");
  const cleared = ["(transcript)", "", "─".repeat(60),
    "❯ ", "─".repeat(60), "  model · ctx 1%"].join("\n");
  // enter submits; box shows the body on the first read (confirm settle 5ms),
  // clears at 15ms, so the re-strand read (5+50ms) sees it empty
  c.hooks.slowClearNextEnter!(PANE, stillHolding, cleared, 15);

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-slow", text: "did we get it done or not" });

  expect(failedFrames(cl), "a slow clear was reported as a failed delivery").toHaveLength(0);
  expect(c.submitted.length, "the body was not submitted exactly once").toBe(1);
  expect(c.submitted[0].text).toContain("did we get it done or not");
  expect(unsubmitted.has(PANE), "a note was kept for a delivery that actually landed").toBe(false);
});

/* A HEALTHY NON-CLAUDE SEND WHOSE POST-ENTER SCREEN HOLDS THE BODY.
 *
 * This is the case an earlier guard slipped through. A conversational TUI (codex, opencode)
 * SUBMITS the message -- the box empties, the agent receives it -- and ALSO
 * echoes the just-submitted user text into its on-screen transcript. A
 * !canParse reader has no box parser, so the post-enter read is the FULL screen
 * (BOX_READ_LINES lines) with that transcript included, and the body is on it
 * even though it was delivered. A post-enter tailVisible -> DeliveryStranded
 * check would therefore false-strand every healthy non-claude send: the row
 * goes red, commitDelivery is skipped, and the enter-only retry re-strands for
 * ever. There is no post-enter stranded check for !canParse (it is claude-only,
 * because only classifyPaneBox's box.hasContent is bounded to the input box and
 * excludes the transcript), so this send SUCCEEDS: typed once, submitted once,
 * the chat row committed, and NO send-failed. The pre-enter echo gate is the
 * modal protection, and it already vouched for the box before the enter. */
test("T7: a non-claude send is not false-stranded when the transcript echoes the submitted body", async () => {
  const c = await rig({ agents: { [PANE]: "codex" } });
  const cl = c.client();
  const body = "codex please run the zork step and report back";
  // codex echoes the submitted user message into its transcript after the enter
  c.hooks.echoSubmitIntoTranscript!(PANE);

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-codex-echo", text: body });

  // the pre-enter echo gate saw the body in the box, so it was typed once and
  // the enter landed and SUBMITTED it
  expect(c.herdr.texts.length, "the body was typed more than once").toBe(1);
  expect(c.submitted.length, "the agent did not receive exactly one message").toBe(1);
  expect(c.submitted[0].text, "the agent received the wrong body").toContain(body);
  // and the post-enter screen carrying the body in the transcript did NOT strand
  expect(
    cl.of("chat").filter((f) => f.role === "user" && f.text === body),
    "a transcript echo false-stranded a healthy non-claude send: commitDelivery was skipped",
  ).toHaveLength(1);
  expect(
    failedFrames(cl),
    "a transcript echo false-stranded a healthy non-claude send and reported a send-failure (C1)",
  ).toEqual([]);
  expect(unsubmitted.has(PANE), "the note outlived a message that was delivered").toBe(false);
});

/* AN UNREADABLE NON-CLAUDE PANE REFUSES. Today a non-claude pane is
 * never read at all; now that it is, a failed/truncated read is a refusal ("fail
 * closed where we are blind") rather than a blind type. */
test("T6: an unreadable non-claude pane refuses and nothing is typed", async () => {
  const c = await rig({ agents: { [PANE]: "codex" } });
  const cl = c.client();
  c.herdr.truncated.add(PANE); // the read comes back truncated => unreadable

  await onUtterance(cl.sock, { id: wireId(PANE), cid: "c-unreadable", text: "codex are you there" });

  expect(c.herdr.texts, "text was typed at a pane whose screen could not be read").toEqual([]);
  expect(c.submitted, "the agent received a message typed blind").toEqual([]);
  const failed = failedFrames(cl);
  expect(failed, "the unreadable pane did not fail the send on its cid").toHaveLength(1);
  expect(failed[0].cid).toBe("c-unreadable");
  expect(failed[0].reason, "the reason does not say the screen could not be read")
    .toMatch(/could not be read/i);
});
