/* THE REPLY WORDING, ENGINE-OWNED WITH SPARSE OVERRIDES (#585).
 *
 * WHAT THIS FILE IS ABOUT is one string: the one the engine appends to the end
 * of every message it types into a pane. That string is how the agent is told
 * how much to say and which tools to answer with, so getting it wrong is not a
 * cosmetic bug -- it is the difference between an answer he hears and silence.
 *
 * THE PROPERTY, in his words: a fresh engine appends its compiled DEFAULT (the
 * cold-engine silence, where an unpushed rung appended nothing);
 * an edited string REPLACES that default rather than joining it; `null` clears
 * the edit and the default comes back; and an edit survives a restart, because
 * it is on the engine's own disk and not in the app that typed it.
 *
 * PROVEN AT THE PANE, not at the store. reply-dials.test.ts already asserts what
 * the store returns; the only honest place to ask what was APPENDED is what the
 * fake terminal actually received, because the append happens inside
 * injectUserMessage between the store read and the keystrokes. So every test
 * here delivers a real message through the real delivery path and reads the line
 * out of the pane.
 *
 * "A RESTART" is wireCore's reset(): every module reset, the SAME data dir, a
 * fresh fake herdr. That is what a rebooted engine sees.
 *
 *   bun test agent-engine/src/chat/strings.test.ts
 */

import { test, expect, afterAll, afterEach, beforeAll, beforeEach } from "bun:test";

import { onUtterance } from "./deliver.ts";
import {
  defaultState,
  replyDialsStore,
  DEFAULT_COMPLEXITY,
  DEFAULT_COMPLEXITY_TEXT,
  DEFAULT_REPLY_LEVEL,
  DEFAULT_REPLY_TEXT,
  type ReplyDialsStore,
} from "../plugins/reply-dials/index.ts";
import { wireCore, type WireCore, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";

/* ONE WIRING FOR THE FILE, and the dials put back to their ship position before
 * each test. A wireCore per test would be ten boots for ten deliveries; the
 * state these tests actually differ in is the DIALS, and the store is the one
 * module they all move. `start()` asserts the reset really landed, so a test
 * cannot inherit the previous one's override in silence.
 *
 * "A fresh engine" below therefore means "the ship defaults, nothing pushed",
 * which is the claim here. That a genuinely EMPTY data dir produces those
 * defaults is reply-dials.test.ts's first test and dials.test.ts's second. */
let core: WireCore;
let client: FakeClient | null = null;

/* THE MEASURED PAUSE BETWEEN A TEXT AND ITS ENTER, shortened at file scope
 * through the knob the adapter already reads per call (mux-adapter settleMs).
 * It is 250ms in production because that is what a terminal needs to have
 * drawn the body before the enter lands; here the pane is a fake that answers
 * instantly, and thirteen deliveries at the real number is three wall seconds
 * spent waiting for a terminal that does not exist. */
const SAVED_SETTLE = process.env.DELIVER_SETTLE_MS;
process.env.DELIVER_SETTLE_MS = "5";

beforeAll(async () => {
  core = await wireCore({ with: ["delivery"] });
  await until(() => !!core.byHandle(PANE), { what: "the pane to become a session" });
});
afterAll(async () => {
  await core?.stop();
  if (SAVED_SETTLE === undefined) delete process.env.DELIVER_SETTLE_MS;
  else process.env.DELIVER_SETTLE_MS = SAVED_SETTLE;
});

beforeEach(async () => { client = core.client(); });
afterEach(() => { client?.close(); client = null; });

/** The dials as a fresh engine has them, and the store the delivery seam reads.
 *  The store is a module singleton, so this IS the instance behind
 *  injectUserMessage: an edit made here is an edit the next delivery sees,
 *  exactly as an app's `wording` rpc would be. */
/* WIRE THE APPEND THE WAY THE PLUGIN DOES. These delivery tests do not load the
 * plugins layer, which is what registers the reply-dials input transform in a
 * real engine (plugins/reply-dials/index.ts, via core.inputTransform). So they register
 * the same postfix hook themselves, over the store, into the wiring's live
 * registry -- explicit wiring rather than a boot-time freebie. A restart builds a
 * fresh registry, so this is re-run after core.reset(). */
function wireDialsAppend(store: ReplyDialsStore): void {
  core.registerInputTransform("reply-dials",
    (input) => ({ postfix: store.askFor(input.channels).instruction }));
}

async function start(): Promise<ReplyDialsStore> {
  const store = await replyDialsStore();
  wireDialsAppend(store);
  await store.resetWording("all");
  await store.resetBits();
  await store.setLevel(DEFAULT_REPLY_LEVEL);
  await store.setComplexity(DEFAULT_COMPLEXITY);
  await store.setToggles({ verbosityOn: true, complexityOn: false, promptBitsOn: true });
  expect(store.state(), "the dials did not go back to their ship position").toEqual(defaultState());
  return store;
}

/** Deliver one text message and hand back the line the PANE received. The
 *  appended instruction rides on the end of it. */
async function deliver(body: string): Promise<string> {
  const before = core.submitted.length;
  await onUtterance(client!.sock, { id: wireId(PANE), text: body });
  await until(() => core.submitted.length > before,
    { what: `the pane to submit ${JSON.stringify(body)}` });
  const line = core.submitted.at(-1)!.text;
  expect(line, "the message that came back is not the one that went in").toContain(body);
  return line;
}

/* A distinctive fragment of each compiled default. Asserting on a fragment
 * rather than the whole string is what makes "the default leaked in alongside
 * his edit" a failure this file can see. */
const V3_FRAGMENT = "short spoken summary of the reply";
const C3_FRAGMENT = "super short and simple";

test("a fresh engine appends the DEFAULT verbosity text; complexity ships OFF (#585)", async () => {
  await start();
  const bare = await deliver("nothing pushed yet");
  expect(bare, "a fresh engine no longer appends the default verbosity wording (#585 regressed)")
    .toContain(V3_FRAGMENT);
  expect(bare.endsWith(DEFAULT_REPLY_TEXT[3]),
    "the appended text is not the compiled rung-3 string, whole and last").toBe(true);
  // SHIP DEFAULT (his call): complexity ships OFF, so its default is NOT appended
  expect(bare, "complexity ships OFF, so its default string must not be appended")
    .not.toContain(C3_FRAGMENT);
});

test("the appended string is EXACTLY what the dials seam says it should be", async () => {
  /* Two readers of one decision: deliver.ts appends `ask.instruction`, and the
   * Stop hook is armed from the same ask. If the pane and the seam could
   * disagree, the hook would be enforcing a level the agent was never asked for. */
  const store = await start();
  await store.setToggles({ complexityOn: true });
  const s = core.byHandle(PANE)!;
  /* The store's askFor is what the reply-dials input-transform hook appends now
   * (the old `deliveryInstruction` seam retired); the pane line must still end
   * with exactly this instruction. */
  const ask = store.askFor(s.channels);
  const line = await deliver("what did the seam say");
  expect(line).toBe(`TEXT: what did the seam say${ask.instruction}`);
  expect(ask.instruction).toBe(DEFAULT_REPLY_TEXT[3] + DEFAULT_COMPLEXITY_TEXT[3]);
});

test("enabling complexity appends its default too; turning both dials off appends nothing", async () => {
  const store = await start();
  await store.setToggles({ complexityOn: true });
  const both = await deliver("complexity on now");
  expect(both.toLowerCase(), "enabling complexity did not append its default string")
    .toContain(C3_FRAGMENT);
  expect(both.endsWith(DEFAULT_REPLY_TEXT[3] + DEFAULT_COMPLEXITY_TEXT[3]),
    "the two halves are appended verbosity-then-complexity, in that order").toBe(true);

  await store.setToggles({ verbosityOn: false, complexityOn: false });
  const off = await deliver("dials off now");
  expect(off, "something was appended with both dials off").toBe("TEXT: dials off now");
});

test("an edited verbosity string is what gets appended, and it REPLACES the default", async () => {
  const store = await start();
  await store.setWording({ reply: { 3: { text: " <<VERB3 OVERRIDE>>" } } });
  const after = await deliver("now with an override");
  expect(after, "his edited verbosity string did not reach the message").toContain("<<VERB3 OVERRIDE>>");
  expect(after, "the compiled default leaked in alongside his edit").not.toContain(V3_FRAGMENT);
  expect(after.endsWith(" <<VERB3 OVERRIDE>>"), "the edit is the whole tail of the line").toBe(true);
});

test("an edited complexity string is what gets appended (complexity enabled)", async () => {
  const store = await start();
  await store.setToggles({ complexityOn: true });
  await store.setWording({ complexity: { 3: { text: " <<CPLX3 OVERRIDE>>" } } });
  const after = await deliver("complexity edited");
  expect(after, "his edited complexity string did not reach the message").toContain("<<CPLX3 OVERRIDE>>");
  expect(after.toLowerCase(), "the compiled complexity default leaked in").not.toContain(C3_FRAGMENT);
  // the verbosity half is untouched by a complexity edit
  expect(after).toContain(V3_FRAGMENT);
});

test("null clears an override, and the engine falls back to the default", async () => {
  const store = await start();
  await store.setWording({ reply: { 3: { text: " <<VERB3 OVERRIDE>>" } } });
  expect(await deliver("edited"), "the override never took").toContain("<<VERB3 OVERRIDE>>");

  await store.setWording({ reply: { 3: { text: null } } });
  const cleared = await deliver("after clear");
  expect(cleared, "the override survived a null reset").not.toContain("<<VERB3 OVERRIDE>>");
  expect(cleared, "the engine did not fall back to its default after the override cleared")
    .toContain(V3_FRAGMENT);
});

test("resetting an untouched rung keeps the delivered default and stores no override", async () => {
  /* Clearing something that was never set must be a no-op, not a write. An
   * override recorded here would be an entry saying "the default, again", and
   * the next default change would silently not reach him. */
  const store = await start();
  await store.setWording({ reply: { 3: { text: null } } });
  expect(await deliver("default reset")).toContain(V3_FRAGMENT);
  expect(store.state().overrides.reply, "the reset created an override").toBeUndefined();
  const onDisk = await Bun.file(`${core.dir}/plugins/reply-dials/reply-dials.json`).json() as any;
  expect(onDisk.overrides?.reply, "the reset wrote an override to disk").toBeUndefined();
});

test("a pushed override persists across a restart, because it is the engine's own file", async () => {
  const store = await start();
  await store.setWording({ reply: { 3: { text: " <<PERSISTED>>" } } });
  expect(await deliver("set it"), "the override did not take").toContain("<<PERSISTED>>");

  // ON DISK, in the engine-scoped plugin data dir (the design), before the restart
  const onDisk = await Bun.file(`${core.dir}/plugins/reply-dials/reply-dials.json`).json() as any;
  expect(onDisk.overrides?.reply?.[3]?.text, "the pushed wording was not persisted")
    .toBe(" <<PERSISTED>>");

  /* THE RESTART: every module reset, the same data dir, a fresh fake herdr. The
   * store singleton goes with it, so what comes back is a store that re-read
   * that file rather than one that remembered. */
  await core.reset();
  await until(() => !!core.byHandle(PANE), { what: "the restarted engine's session" });
  client = core.client();
  const reloaded = await replyDialsStore();
  expect(reloaded, "the restart kept the old store instance").not.toBe(store);
  // the restart built a fresh registry; wire the append over the reloaded store
  wireDialsAppend(reloaded);
  expect(await deliver("after a restart"),
    "the engine forgot the pushed wording across a restart").toContain("<<PERSISTED>>");
});

test("a dial set leaves an existing wording override intact", async () => {
  /* An unrelated rpc carries no wording patch, so it must leave overrides alone.
   * A set that rewrote the whole state from its own idea of it would wipe every
   * edit he ever made, one dial drag at a time. */
  const store = await start();
  await store.setWording({ reply: { 3: { text: " <<KEEP ME>>" } } });
  expect(await store.setComplexity(4)).toBe(true);
  expect(await deliver("still there?"), "a wording-free dial set wiped an override")
    .toContain("<<KEEP ME>>");
  // and the edit is still the only override on the record
  expect(store.state().overrides).toEqual({ reply: { 3: { text: " <<KEEP ME>>" } } });
});

test("an edit to a rung the engine is NOT on changes nothing about the delivered line", async () => {
  /* Sparse overrides mean an edit is stored per rung. Editing rung 1 while the
   * dial sits at 3 must not touch the message: the wrong answer here (a store
   * that keeps one current string instead of five) would look right in the
   * editor and be wrong in the pane. */
  const store = await start();
  await store.setWording({ reply: { 1: { text: " <<RUNG ONE>>" } } });
  const line = await deliver("still on three");
  expect(line).not.toContain("<<RUNG ONE>>");
  expect(line).toContain(V3_FRAGMENT);
  // move the dial to that rung and it is what gets appended
  expect(await store.setLevel(1)).toBe(true);
  expect(await deliver("now on one")).toContain("<<RUNG ONE>>");
});
