/* TWO KINDS OF MESSAGE THROUGH THE SAME SESSION, and the one thing that has to
 * stay true of each (#515).
 *
 * A message he TYPED is a message FROM a person: it goes through
 * injectUserMessage, which writes a role:"user" chat row, appends the reply-level
 * instruction the dials ask for, and RECORDS the delivery so the Stop hook has
 * something to enforce at the end of the turn.
 *
 * A message fed INTO the session -- a fired schedule, the agent-message route --
 * is not. It goes through deliverToAgent: the line lands in the pane so the agent
 * acts on it, and that is ALL. No chat row, so a firing leaves the conversation
 * untouched. No instruction appended and no delivery recorded, so
 * enforce-voice-reply.py finds nothing outstanding for that turn and a silent
 * cron is FREE TO STOP.
 *
 * Both halves are proven on the SAME wiring and the SAME pane, because the split
 * is a claim about one engine doing two different things, and a file that proved
 * each on its own could pass while the two paths had quietly become one.
 *
 * WHAT IS DELIBERATELY NOT HERE: the crons plugin's own machinery (the schedule
 * store, the tick, guardCwd, the lateness ladder) lives in plugins/crons, and the
 * whole vertical over the sealed wire is an e2e spec. deliverToAgent IS the seam
 * they arrive through, and it is the seam this file holds down.
 *
 *   bun test agent-engine/src/security/injection.test.ts
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";

import { onUtterance, deliverToAgent } from "../chat/deliver.ts";
import { applyInputTransform, type OutgoingInput } from "../plugins/platform/core.ts";
import { replyDialsStore } from "../plugins/reply-dials/index.ts";
import { stateFile } from "../storage/datadir.ts";
import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";

/* The settle between a delivery's text and its enter, shortened at file scope
 * (adapters/mux-adapter.ts reads it on every use). Real time by nature: it is a
 * pause a real TUI needs, not a timer this engine owns. */
const priorSettle = process.env.DELIVER_SETTLE_MS;
beforeAll(() => { process.env.DELIVER_SETTLE_MS = "5"; });
afterAll(() => {
  if (priorSettle === undefined) delete process.env.DELIVER_SETTLE_MS;
  else process.env.DELIVER_SETTLE_MS = priorSettle;
});

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

/** The deliveries the Stop hook has on record for a session, OFF DISK.
 *
 *  Read from the file rather than from the module, because the file is the whole
 *  interface: the hook runs inside the agent's own process tree with no socket to
 *  the engine, so a delivery the engine remembers and did not write down is a
 *  delivery the hook cannot enforce. */
async function hookDeliveries(pane: string): Promise<Array<{ how?: string }>> {
  const f = Bun.file(stateFile("reply-state.json"));
  if (!(await f.exists())) return [];
  const st = await f.json().catch(() => null) as any;
  // the state file is keyed by the wire id (the agent id), like everything else
  return (st?.sessions?.[wireId(pane)]?.deliveries ?? []) as Array<{ how?: string }>;
}

/** The reply-level instruction a delivered line ends with. Built by
 *  injectUserMessage from the session's level and its live channels; a message
 *  fed in through deliverToAgent does not go through that function, so its line
 *  has none. */
function askOf(delivered: string): string {
  const at = delivered.indexOf(" (Reply");
  return at < 0 ? "" : delivered.slice(at);
}

async function rig(): Promise<WireCore> {
  core = await wireCore({ with: ["delivery"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  /* WIRE THE APPEND THE WAY THE PLUGIN DOES. This delivery test does not load the
   * plugins layer that registers the reply-dials input transform in a real
   * engine, so it registers the same postfix hook itself, over the store, so a
   * typed message still ends with the reply-level instruction. */
  const store = await replyDialsStore();
  core.registerInputTransform("reply-dials",
    (input) => ({ postfix: store.askFor(input.channels).instruction }));
  return core;
}

test("a typed message writes its bubble and arms the hook; a fed-in one does neither", async () => {
  const c = await rig();
  const cl = c.client();

  // ------------------------------------------------------------- the typed one
  await onUtterance(cl.sock, { id: wireId(PANE), text: "have a look at the build" });

  const bubble = cl.of("chat").find((f) => f.role === "user" && f.text === "have a look at the build");
  expect(bubble, "the typed message never reached the chat").toBeDefined();
  expect(c.byHandle(PANE)!.chat.at(-1)!.text, "and it is not in the session's own log")
    .toBe("have a look at the build");

  const typedLine = c.submitted.at(-1)!.text;
  expect(typedLine.startsWith("TEXT: "), `a typed message is tagged TEXT: ${typedLine}`).toBe(true);
  /* IT ASKS FOR A REPLY. The instruction comes from the dials seam, and it is
   * what tells the agent which tool to answer with; without it a reply level is
   * a setting that changes nothing. */
  expect(askOf(typedLine), `a typed message asked for no reply: ${typedLine}`).not.toBe("");

  /* AND IT ARMS THE HOOK. injectUserMessage records a delivery whose `needs`
   * come from the reply level, so the Stop hook has something to enforce at the
   * end of the turn. */
  await until(async () => (await hookDeliveries(PANE)).some((d) => d.how === "TEXT"),
    { what: "the typed delivery to reach the hook state file" });

  // ------------------------------------------------------------- the fed-in one
  /* THE SAME SESSION, fed the way a fired schedule feeds it. deliverToAgent is
   * the shared path: the crons host calls it, and so does the agent-message
   * route. Nothing about the pane, the wiring or the client changes. */
  cl.clear();
  const res = await deliverToAgent(c.byHandle(PANE)!, {
    how: "SCHEDULED", note: "standup", text: "write the standup",
  });
  expect(res.ok, `the fed-in message was not delivered: ${JSON.stringify(res)}`).toBe(true);

  /* IT REACHES THE PANE, and the agent really receives it: same
   * "SCHEDULED (<note>): <body>" line it has always delivered. */
  const firedLine = c.submitted.at(-1)!.text;
  expect(firedLine.startsWith("SCHEDULED (standup): "),
    `the fed-in message did not reach the pane in its own shape: ${firedLine}`).toBe(true);
  expect(firedLine).toContain("write the standup");

  /* BUT IT ASKS FOR NOTHING. No reply-level instruction on the line, and no
   * delivery recorded for the hook: the Stop hook, finding nothing outstanding
   * for this turn, lets a silent cron stop. */
  expect(askOf(firedLine), `a fed-in message asked for a reply: ${firedLine}`).toBe("");
  expect((await hookDeliveries(PANE)).every((d) => d.how !== "SCHEDULED"),
    "a fed-in message recorded a delivery for the Stop hook, which would force a reply").toBe(true);

  /* AND IT WROTE NO BUBBLE. A firing must leave the conversation untouched:
   * nothing the app renders, on any device, ever. */
  expect(cl.of("chat"), "a fed-in message wrote a chat frame").toEqual([]);
  expect(c.byHandle(PANE)!.chat.map((m) => m.text),
    "a fed-in message wrote a row into the conversation").not.toContain("write the standup");
});

test("a fed-in message marks nothing read and raises no queued divider", async () => {
  /* The other two things injectUserMessage does that deliverToAgent must not. A
   * message he typed reads everything above it (#452) and, on a BUSY pane, draws
   * the queued divider. A cron is neither: it is not his, so it may not move his
   * read marker, and it has no chat row for a divider to hang off. */
  const c = await rig();
  const cl = c.client();
  const s = c.byHandle(PANE)!;
  s.busy = true; // the pane is mid-turn, which is what raises the divider

  const heardBefore = s.heardTs;
  await deliverToAgent(s, { how: "SCHEDULED", note: "nightly", text: "run the nightly" });

  expect(c.submitted.at(-1)!.text).toContain("run the nightly");
  expect(s.heardTs, "a fed-in message moved his read marker").toBe(heardBefore);
  expect(cl.of("chat"), "a fed-in message broadcast a chat frame on a busy pane").toEqual([]);
  expect(s.chat, "a fed-in message wrote a row that a divider could hang off").toEqual([]);
});

test("the input-transform fold wraps the body in registration order, first hook innermost", () => {
  /* The delivery site (injectUserMessage) folds every registered hook over the
   * outgoing body. A single postfix hook is exactly `body + postfix`, which is
   * what the reply-dials append was before it became a hook (byte-identical
   * delivery). Two hooks compose: the FIRST registered sits closest to the body,
   * the second wraps around it. */
  const input: OutgoingInput = { sessionId: PANE, text: "do it", channels: ["chat"] };
  // one postfix hook: the reply-dials shape
  expect(applyInputTransform([() => ({ postfix: " (reply)" })], input)).toBe("do it (reply)");
  // a hook that returns nothing leaves the text untouched
  expect(applyInputTransform([() => undefined], input)).toBe("do it");
  // two hooks, registration order: A first (innermost), B second (outermost)
  const A = () => ({ prefix: "A<", postfix: ">A" });
  const B = () => ({ prefix: "B<", postfix: ">B" });
  expect(applyInputTransform([A, B], input)).toBe("B<A<do it>A>B");
});

test("a delivery whose keystrokes are refused forgets its Stop-hook trace entry", async () => {
  /* Never enforce a reply to a message that never arrived: injectUserMessage
   * records the delivery for the Stop hook BEFORE typing, then forgets it if the
   * keystrokes are refused, so the hook is not left holding an outstanding
   * delivery for a turn the agent never saw. */
  core = await wireCore({ with: ["delivery"], failKeys: () => true });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  const cl = core.client();

  await onUtterance(cl.sock, { id: wireId(PANE), text: "this will be refused" });

  // nothing reached the pane, and no delivery is on record for the Stop hook
  expect(core.submitted.some((x) => x.text.includes("this will be refused")),
    "a refused delivery still reached the pane").toBe(false);
  expect((await hookDeliveries(PANE)).length,
    "a refused delivery left a Stop-hook trace entry it should have forgotten").toBe(0);
});

test("a fed-in message to a dead pane is refused as retriable, and nothing is typed", async () => {
  /* The schedule's own retry keys on this: `retriable` is a promise that NOTHING
   * was typed, never a wish. A session whose pane is gone is exactly that case,
   * and it is the one a firing hits when a machine has been asleep. */
  const c = await rig();
  const cl = c.client();
  /* One real message first, so the session has a conversation. A pane that goes
   * away with NOTHING in its log is purged outright (there is no row to keep);
   * one that has been talked to stays as a dead row, which is the shape a
   * schedule fires at after a machine has been asleep. */
  await onUtterance(cl.sock, { id: wireId(PANE), text: "still here?" });
  const id = wireId(PANE); // the row keeps this id once its pane is gone
  await c.herdr.setAgentGone(PANE, true);
  await until(() => c.sessions.get(id)?.alive === false, { what: "the pane to go away" });
  const s = c.sessions.get(id)!;
  const rowsBefore = s.chat.length;
  const typedBefore = c.herdr.texts.length;

  const res = await deliverToAgent(s, {
    how: "SCHEDULED", note: "nightly", text: "run the nightly",
  });
  expect(res.ok).toBe(false);
  expect(res.retriable, "a firing at a dead pane was not offered a retry").toBe(true);
  expect(String(res.tell)).toMatch(/offline/);
  expect(c.herdr.texts.length,
    "something was typed at a pane the engine had called offline").toBe(typedBefore);
  expect(c.submitted.some((x) => x.text.includes("run the nightly")),
    "a dead pane received the firing anyway").toBe(false);
  expect(s.chat.length, "a refused firing wrote a row anyway").toBe(rowsBefore);
});
