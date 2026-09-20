/* A PANE THAT STOPS ANSWERING, AND THE MESSAGES BEHIND IT.
 *
 * Every message he sends is typed by deliverToPane, and deliverToPane runs on
 * ONE queue shared by every pane. So the question this file exists for is not
 * "what happens to the message at a wedged pane" -- herdr's own rpc timeout has
 * always answered that one -- it is "what happens to the ones waiting".
 *
 * Measured on the boot harness before any of this was written, with a herdr that
 * accepts the request and never answers, three messages sent at once:
 *
 *     +5,012ms  (not sent: that session's screen could not be read...)
 *     +10,019ms (not sent: ...)
 *     +15,020ms (not sent: ...)
 *
 * Nothing was hanging. Every message simply paid the full timeout again, in
 * turn, and was told nothing at all while it waited. Twelve messages is a minute
 * of a bubble sitting there.
 *
 * THE TWO DIRECTIONS THE DEADLINE CAN BE WRONG IN, and this file pins it from
 * both sides:
 *
 *   - too generous, and the queue keeps charging every message for the wedge;
 *   - too tight, and it refuses a pane that is SLOW and completely fine, which
 *     is task #256, the four hours in which the delivery guard refused
 *     everything he sent.
 *
 * FakeHerdr has both panes, and they are different failures on purpose.
 * `stalled` takes the request and answers nothing, and applies no keystroke
 * either: the agent genuinely never got it, so "the message survived" is not a
 * bookkeeping question. `slow` does the work and answers LATE, which is the
 * shape a timeout must never refuse.
 *
 * THE NUMBERS ARE SCALED, NOT INVENTED. The engine ships a 5,000ms herdr rpc
 * ceiling, a 250ms settle and a 45,000ms delivery deadline; this file runs the
 * same model at 1/50, and the RATIOS are what the assertions are about. All
 * three are read from the environment on every use (adapters/mux-adapter.ts,
 * herdr.ts) for exactly this reason: a module const would have been frozen by
 * the import at the top of this file, before a line of it ran.
 *
 *   bun test agent-engine/src/chat/wedged.test.ts
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";

import { handleUtterance, onUtterance } from "./deliver.ts";
import { wireCore, type WireCore, type WireCoreOpts, wireId } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";

/** herdr's own rpc ceiling, at 1/50 of the shipped 5,000ms. A pane that has not
 *  answered within it is a pane something is wrong with. */
const RPC_MS = 100;
/** The settle between a delivery's text and its enter, at 1/50 of 250ms. */
const SETTLE_MS = 5;
/** One healthy delivery by a pane answering in `rpc` ms: read + send_text +
 *  settle + enter. Three round trips and one pause, which is the shape the
 *  deadline has to clear however fast the pane is. */
const oneDelivery = (rpcMs: number) => rpcMs * 3 + SETTLE_MS;

/* THE BUDGET AND THE CEILING ARE THE SUBJECT, so each test names its own.
 *
 * The three tests want opposite things from them -- one needs the budget to
 * expire at the front of the queue, one needs it to hold across two slow
 * deliveries, one needs it to expire DURING a read -- so there is no single pair
 * the file can set once. Both are read on every use by design (adapters/
 * mux-adapter.ts, herdr.ts), and this is the caller that design is for. Restored
 * after every test, so no two of them inherit each other's numbers. */
const TUNED = ["DELIVER_DEADLINE_MS", "HERDR_RPC_TIMEOUT_MS", "DELIVER_SETTLE_MS",
  "CONFIRM_SETTLE_MS"] as const;
const priorEnv: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of TUNED) priorEnv[k] = process.env[k]; });
const restore = () => {
  for (const k of TUNED) {
    if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k]!;
  }
};
afterAll(restore);

function tune(o: { deadlineMs: number; rpcMs?: number }): void {
  process.env.DELIVER_DEADLINE_MS = String(o.deadlineMs);
  process.env.HERDR_RPC_TIMEOUT_MS = String(o.rpcMs ?? RPC_MS);
  process.env.DELIVER_SETTLE_MS = String(SETTLE_MS);
  process.env.CONFIRM_SETTLE_MS = String(SETTLE_MS);
}

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
  restore();
});

async function rig(o: WireCoreOpts = {}): Promise<WireCore> {
  core = await wireCore({ with: ["delivery"], ...o });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  return core;
}

/** The reason on every `send-failed` frame the engine put on the sender's row.
 *  A delivery that could not go now fails the row on its cid (F2), rather than a
 *  grey claude-role notice bubble. */
const told = (cl: { of(t: string): Record<string, any>[] }) =>
  cl.of("send-failed").map((f) => String(f.reason));

test("a wedged pane is given up on, and the messages behind it stop paying for it", async () => {
  /* SIX MESSAGES SENT AT ONCE, which is the only way to ask this question: they
   * are all stamped with the moment the socket handed them over, and then they
   * queue. Awaiting each in turn would restart every message's clock after the
   * one in front of it had already finished, and the whole subject here is what
   * happens to a message while it WAITS. */
  const DEADLINE = RPC_MS * 3;
  tune({ deadlineMs: DEADLINE });
  const c = await rig();
  const cl = c.client();

  /* herdr takes the request and never answers it. NOT a refusal: a refusal comes
   * back and the engine learns something within a round trip. This is the pane
   * mid-redraw, the agent that stopped reading its tty, the shape that can hold
   * a queue. */
  c.herdr.stalled.add(PANE);

  /* TWELVE, not six, and the number is doing work. Without the deadline every
   * message pays the wedge in turn, so the queue takes `sent * RPC_MS`; with it,
   * the ones whose clock has already run out are refused without touching herdr
   * at all. At six the two totals are close enough to be the same measurement on
   * a loaded box; at twelve the regression is 1,200ms and the fix is ~300, with
   * the ceiling below sitting between them. */
  const sent = 12;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: sent }, (_, i) =>
    onUtterance(cl.sock, { id: wireId(PANE), text: `wedged ${i + 1}` })));
  const elapsed = Date.now() - t0;

  const answers = told(cl);
  expect(answers.length,
    `only ${answers.length} of ${sent} messages were ever answered: ${JSON.stringify(answers)}`,
  ).toBe(sent);

  /* EVERY ONE OF THEM WAS TOLD, AND WITHIN THE DEADLINE PLUS ONE ROUND TRIP.
   *
   * The last one is the assertion. Before the deadline existed it waited for
   * five wedged round trips ahead of it and was told at six times the ceiling.
   * Now its slot comes up after its own clock has run out and it is refused
   * without touching herdr at all, so the whole queue is answered inside the
   * deadline plus however long the one read already in flight takes. */
  // the deadline, plus the read already in flight, plus slack for a loaded box.
  // Comfortably under `sent * RPC_MS`, which is what the queue costs without it.
  const ceiling = DEADLINE + RPC_MS * 3;
  expect(elapsed < ceiling,
    `the last of ${sent} messages was answered ${elapsed}ms after it was sent, past the ` +
    `${ceiling}ms this deadline allows: the queue is still charging each message for the ` +
    `wedge ahead of it`).toBe(true);

  /* AT LEAST ONE OF THEM WAS GIVEN UP ON RATHER THAN TRIED. The early ones get
   * herdr's own answer (the screen could not be read); the ones whose turn came
   * too late get this, and it is a different sentence because it is a different
   * fact -- nothing was even attempted for them. */
  expect(answers.filter((t) => t.includes("is not answering")).length > 0,
    `no message was given up on; every one of them paid the wedge: ${JSON.stringify(answers)}`,
  ).toBe(true);
  // ...and the ones that DID reach herdr were told the honest other thing
  expect(answers.some((t) => t.includes("could not be read")),
    `nothing ever reached the wedged pane, so the queue was never charged at all: ` +
    JSON.stringify(answers)).toBe(true);

  /* AND NOT ONE KEYSTROKE LEFT, which is what makes the sentence he is shown
   * true and what makes sending it again safe. `submitted` is what the agent
   * actually received; `texts` is what herdr was asked to type. Both empty. */
  expect(c.submitted, "a wedged pane received a message anyway").toEqual([]);
  expect(c.herdr.texts, "a message was typed at a pane the user was told nothing was typed at")
    .toEqual([]);
  // no chat row either: a message that did not land is one the app sends again
  expect(cl.of("chat").filter((f) => f.role === "user")).toEqual([]);

  /* The log says the same thing in the engine's own words, so a real one of
   * these is findable afterwards. */
  const dropped = c.logs.filter((l) => l.event === "utterance.dropped")
    .map((l) => String(l.fields.why));
  expect(dropped.some((l) => l.includes("nothing was typed at the pane")),
    `no give-up was recorded:\n${dropped.join("\n")}`).toBe(true);
});

test("a chain that is slow and completely fine is not refused, however long the wait", async () => {
  /* THE DEADLINE'S OWN RATIO, and the test that fails if anyone tightens it.
   *
   * Production: herdr gives up on an rpc at 5,000ms, so 4,000ms per call is
   * about the slowest a pane can be while every call still lands. One delivery
   * is three calls plus a settle, ~12.25s, and it is a HEALTHY delivery. TWO
   * messages is the point: the second one's turn does not come until the first
   * has finished, so it waits a whole delivery before anything is even read for
   * it, and every millisecond of that is on the deadline's clock. 45,000ms
   * clears two of them with about 1.8x to spare, and that ratio is what is
   * reproduced here at 1/50.
   *
   * Both must arrive, in order. A guard that starts refusing here is task #256
   * happening again: the pane is fine, it is just slow.
   *
   * The numbers are larger than the rest of the file's on purpose: scheduling
   * drift on a box running the whole suite is roughly a fixed number of
   * milliseconds, so the smaller the model the bigger a share of it that is. */
  const RPC = 200;
  const SLOW_MS = 150; // slow, and still inside herdr's ceiling: every call lands
  const ONE_DELIVERY_MS = oneDelivery(SLOW_MS);
  tune({ deadlineMs: Math.round(ONE_DELIVERY_MS * 2 * 1.8), rpcMs: RPC });
  const c = await rig();
  const cl = c.client();
  c.herdr.slow.ms = SLOW_MS;

  const t0 = Date.now();
  await Promise.all([
    onUtterance(cl.sock, { id: wireId(PANE), text: "the slow one" }),
    onUtterance(cl.sock, { id: wireId(PANE), text: "and the one behind it" }),
  ]);
  const waited = Date.now() - t0;

  expect(told(cl), `a slow but working chain was refused: ${JSON.stringify(told(cl))}`).toEqual([]);
  expect(cl.of("chat").filter((f) => f.role === "user").map((f) => f.text),
    "a slow but working pane did not get both messages, in order")
    .toEqual(["the slow one", "and the one behind it"]);

  /* AND THE SECOND ONE REALLY DID WAIT. This is the number the deadline has to
   * clear: a delivery that was going to land, held for this long by nothing
   * worse than the message in front of it. */
  expect(waited >= ONE_DELIVERY_MS * 2,
    `the pair only took ${waited}ms, which is not a long enough wait to prove the deadline ` +
    `tolerates one`).toBe(true);

  /* Two messages reached the agent, whole and once each. A deadline that fired
   * mid-delivery and let the delivery finish anyway would show up here as a
   * refusal beside a delivered message: two answers to one question. */
  expect(c.submitted.length,
    `the slow pane received ${c.submitted.length} messages, not 2`).toBe(2);
  expect(c.submitted[0].text).toContain("the slow one");
  expect(c.submitted[1].text).toContain("and the one behind it");
});

test("a read that spends the whole budget is not followed by the message anyway", async () => {
  /* THE OTHER PLACE NOTHING HAS BEEN TYPED YET, and the only other place the
   * deadline may be consulted at all.
   *
   * The pane ANSWERS -- this is not the wedge -- but by the time its screen
   * comes back this message's budget is gone. What must NOT happen is the
   * send_text going out regardless, putting a message he is about to be told
   * failed into a pane that has only just started answering again.
   *
   * The first test in this file cannot reach this line: a WEDGED pane's read
   * never comes back at all, so it is refused as unreadable long before anything
   * asks the clock. It takes a pane that ANSWERS, later than the budget allows
   * but well inside herdr's own ceiling -- so the numbers here are the only ones
   * in the file that are not the 1/50 model: a 500ms read under a 400ms budget
   * and a 900ms rpc ceiling. Spelled that way so the branch is reached by
   * CONSTRUCTION rather than by winning a race: the front-of-queue check has
   * 400ms of room on an empty queue, and the read cannot come back inside it. */
  const DEADLINE = 400;
  const READ_MS = 500;
  tune({ deadlineMs: DEADLINE, rpcMs: 900 });
  const c = await rig();
  const cl = c.client();
  c.herdr.slow.ms = READ_MS;

  const t0 = Date.now();
  await onUtterance(cl.sock, { id: wireId(PANE), text: "read outlasted me" });
  const elapsed = Date.now() - t0;

  const said = told(cl);
  expect(said, "nothing was ever said about a message the read outlasted").toHaveLength(1);
  expect(said[0]).toContain("is not answering");
  /* AND IT GAVE UP AFTER THE READ, not before it: this is the second of the two
   * places the clock is consulted, and the one the first test cannot reach. */
  expect(
    c.logs.filter((l) => l.event === "utterance.dropped").map((l) => String(l.fields.why)),
    "the message was refused at the front of the queue instead of after its read, so the " +
    "post-read check has nothing behind it",
  ).toEqual([expect.stringContaining("still not answering when its turn came")]);

  /* Nothing typed, which is what the sentence promises him. The whole delivery
   * chain is awaited above, so a send_text that went out anyway would already be
   * in this list rather than still in flight. */
  expect(c.herdr.texts,
    "the message was typed at the pane after the user was told it was not").toEqual([]);
  expect(c.submitted, "the agent received a message that was given up on").toEqual([]);
  /* AND THE PANE REALLY DID ANSWER: this is a slow pane, not a wedged one. The
   * refusal cost a whole read, which is the difference between the two failures
   * and the reason this branch exists separately from the first test's. */
  expect(elapsed >= READ_MS,
    `the refusal took only ${elapsed}ms, so the screen was never actually read and the budget ` +
    `was not spent on a read at all`).toBe(true);
});

/* ------------------------------------------ the number this file runs at 1/50
 *
 * EVERY TEST ABOVE OVERRIDES THE DEADLINE, which is what makes them cheap and
 * is also how the shipped number came to be unpinned: the file that exists to
 * hold the deadline from both sides never once ran on the deadline. Delete the
 * `|| 45_000` in adapters/mux-adapter.ts, or move it to five seconds, or to ten
 * minutes, and everything above stays green -- they each set their own.
 *
 * A 45 second default cannot be spent. But it does not have to be: `takenAt` is
 * a PARAMETER (deliverToPane's own comment says why -- there are two queues
 * between the frame and the keystroke, and a clock started inside would start
 * after the first has already been waited out), so a message can arrive already
 * old. That is a real shape, not a contrivance: it is exactly what a message
 * that has sat in the utterance queue behind a long decode looks like.
 *
 * So the boundary is probed from both sides, one second out on each, with the
 * override DELETED. One second is enormous slack for a fake pane doing three
 * round trips and a five millisecond settle, and it is tight enough that no
 * other number anybody would plausibly type -- 30s, 60s, five seconds -- sits
 * between the two probes.
 */

/** The rig, with the DEADLINE left to the shipped default and only the two
 *  numbers that are not the subject shrunk. */
function defaultDeadline(): void {
  delete process.env.DELIVER_DEADLINE_MS;
  process.env.HERDR_RPC_TIMEOUT_MS = String(RPC_MS);
  process.env.DELIVER_SETTLE_MS = String(SETTLE_MS);
  process.env.CONFIRM_SETTLE_MS = String(SETTLE_MS);
}

test("the shipped deadline is 45 seconds: a message 44s old still lands", async () => {
  defaultDeadline();
  const c = await rig();
  const cl = c.client();

  await handleUtterance(cl.sock, { id: wireId(PANE), text: "old but inside the budget" },
    Date.now() - 44_000);

  expect(told(cl), `a message inside the shipped budget was refused: ${JSON.stringify(told(cl))}`)
    .toEqual([]);
  expect(c.submitted.map((s) => s.text).join("\n"),
    "a message 44s old was not delivered, so the shipped deadline is under 44 seconds")
    .toContain("old but inside the budget");
});

test("...and a message 46s old is given up on, untyped", async () => {
  defaultDeadline();
  const c = await rig();
  const cl = c.client();

  await handleUtterance(cl.sock, { id: wireId(PANE), text: "older than the budget" },
    Date.now() - 46_000);

  const said = told(cl);
  expect(said,
    "a message past the shipped budget was delivered anyway, so the deadline is over 46 seconds")
    .toHaveLength(1);
  expect(said[0]).toContain("is not answering");
  /* AND IT NEVER REACHED THE FRONT OF THE QUEUE. The two places the clock is
   * consulted say different things, and this one is the front-of-queue check:
   * nothing was even attempted, which is what makes the sentence he is shown
   * true and sending it again safe. */
  expect(c.logs.filter((l) => l.event === "utterance.dropped").map((l) => String(l.fields.why)),
    "the refusal did not come from the front-of-queue deadline check")
    .toEqual([expect.stringContaining("never reached the front of the pane queue")]);
  expect(c.herdr.texts, "a message past the deadline was typed at the pane anyway").toEqual([]);
  expect(c.submitted, "the agent received a message that was given up on").toEqual([]);
});
