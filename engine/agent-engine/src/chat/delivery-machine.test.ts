/* THE DELIVERY MACHINE, UNIT-TESTED IN ISOLATION.
 *
 * delivery-guard.test.ts drives the WHOLE seam (real MuxAdapter over real herdr
 * framing on a fake terminal) and is the equivalence proof that this restructure
 * kept behaviour. This file is its complement: it drives runDeliveryMachine
 * directly with an injected `io` (no mux, no herdr, no queue) and pins every one
 * of the eight terminal outcomes by name, including the three the guard suite
 * does not pin today -- the unconfirmed (post-enter read failed) path, the
 * enter-retry-once path, and the deadline path.
 *
 * The timings are read from the environment on every use, so these tests set
 * them to ~1ms and run in milliseconds. The deadline default (45s) is left alone
 * except in the deadline tests, which set it explicitly and restore it.
 *
 *   bun test agent-engine/src/chat/delivery-machine.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { runDeliveryMachine, type DeliveryIo } from "./delivery-machine.ts";
import type { PaneBox } from "../terminal/blocked.ts";
import type { DeliverSession } from "../adapters/mux-adapter.ts";

type Screen = { box: PaneBox | { kind: "unreadable" }; text: string };

const PANE = "w1:p1";
const BODY = "hello there, agent";
/* The delivery id (the send's cid) the note is keyed on now, in place of the
 * delivered string. */
const DID = "c-machine-1";

/* A screen the tail of BODY is visible in (echo gate / non-claude "still
 * there"), and one it is not. */
const withTail = (): Screen => ({ box: { kind: "unknown" }, text: `> ${BODY}\n` });
const noTail = (): Screen => ({ box: { kind: "unknown" }, text: "a menu with no body on it\n" });

type IoOpts = {
  screens: Screen[];
  canParse?: boolean;
  session?: DeliverSession;
  note?: { deliveryId: string; at: number };
  sendKeysThrows?: number; // fail the first N sendKeys calls, then succeed
};

type Rig = {
  io: DeliveryIo;
  unsubmitted: Map<string, { deliveryId: string; at: number }>;
  sendText: string[];
  sendKeys: string[];
  reads: number;
};

function rig(opts: IoOpts): Rig {
  const unsubmitted = new Map<string, { deliveryId: string; at: number }>();
  if (opts.note) unsubmitted.set(PANE, opts.note);
  const screens = [...opts.screens];
  const sendText: string[] = [];
  const sendKeys: string[] = [];
  let keyFails = opts.sendKeysThrows ?? 0;
  const r: Rig = {
    unsubmitted,
    sendText,
    sendKeys,
    reads: 0,
    io: {
      mux: {
        async sendText(_h, t) { sendText.push(t); },
        async sendKeys(_h, k) {
          if (keyFails > 0) { keyFails--; throw new Error("flaky rpc"); }
          sendKeys.push(k);
        },
      },
      unsubmitted,
      sessionFor: () => opts.session,
      canParseScreen: () => opts.canParse ?? true,
      async readScreen() {
        r.reads++;
        const s = screens.shift();
        if (!s) throw new Error("readScreen called more times than the test staged");
        return s;
      },
    },
  };
  return r;
}

beforeAll(() => {
  process.env.DELIVER_SETTLE_MS = "1";
  process.env.CONFIRM_SETTLE_MS = "1";
  process.env.RESTRAND_SETTLE_MS = "1";
  process.env.REECHO_SETTLE_MS = "1";
});
afterAll(() => {
  delete process.env.DELIVER_SETTLE_MS;
  delete process.env.CONFIRM_SETTLE_MS;
  delete process.env.RESTRAND_SETTLE_MS;
  delete process.env.REECHO_SETTLE_MS;
  delete process.env.DELIVER_DEADLINE_MS;
});

const input = (hasContent: boolean): Screen => ({ box: { kind: "input", hasContent }, text: "" });

/* ------------------------------------------------------------ the outcomes */

test("refusedTimeout: the deadline at the queue front refuses with nothing typed", async () => {
  const r = rig({ screens: [] });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now() - 100_000);
  expect(out.kind).toBe("refusedTimeout");
  if (out.kind !== "refusedTimeout") throw new Error("narrow");
  expect(out.why).toContain("never reached the front of the pane queue");
  expect(out.why).toContain("nothing was typed at the pane");
  expect(r.sendText.length).toBe(0);
  expect(r.reads).toBe(0);
});

test("refusedTimeout: the second gate (past the read, before typing) has its own reason", async () => {
  process.env.DELIVER_DEADLINE_MS = "20";
  // gate1 passes (elapsed ~0), the read burns >20ms, gate2 then fires.
  const r = rig({ screens: [input(false)] });
  // A readScreen that sleeps past the deadline before returning.
  const base = r.io.readScreen;
  r.io.readScreen = async (h) => { await new Promise((x) => setTimeout(x, 40)); return base(h); };
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("refusedTimeout");
  if (out.kind !== "refusedTimeout") throw new Error("narrow");
  expect(out.why).toContain("still not answering when its turn came");
  expect(r.sendText.length).toBe(0);
  delete process.env.DELIVER_DEADLINE_MS;
});

test("refusedBlocked: a foreign pane whose session is blocked types nothing", async () => {
  const r = rig({
    screens: [],
    canParse: false,
    session: { agent: { id: "ag1", name: "Codey" }, status: "blocked" },
  });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("refusedBlocked");
  if (out.kind !== "refusedBlocked") throw new Error("narrow");
  expect(out.why).toContain("Codey is waiting for an answer in the terminal");
  expect(r.reads).toBe(0);
  expect(r.sendText.length).toBe(0);
});

test("refusedUnreadable: a foreign pane whose screen will not read refuses", async () => {
  const r = rig({ screens: [{ box: { kind: "unreadable" }, text: "" }], canParse: false });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("refusedUnreadable");
  if (out.kind !== "refusedUnreadable") throw new Error("narrow");
  expect(out.why).toBe("the pane's screen could not be read, so nothing was typed");
  expect(r.sendText.length).toBe(0);
});

test("refusedUnreadable: a canParse pane whose verdict is unreadable has the other reason", async () => {
  const r = rig({ screens: [{ box: { kind: "unreadable" }, text: "" }], canParse: true });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("refusedUnreadable");
  if (out.kind !== "refusedUnreadable") throw new Error("narrow");
  expect(out.why).toBe("the pane's screen could not be read at all, so nothing was sent");
  expect(r.sendText.length).toBe(0);
});

test("refusedChooser: a chooser is never typed at, and the tell names the question", async () => {
  const r = rig({
    screens: [{ box: { kind: "chooser", ask: { question: "Allow write?" } as any }, text: "" }],
    canParse: true,
  });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("refusedChooser");
  if (out.kind !== "refusedChooser") throw new Error("narrow");
  expect(out.tell).toBe('(not sent: that session is waiting on "Allow write?")');
  expect(r.sendText.length).toBe(0);
});

test("refusedSwallowed: BOTH echo reads lack the tail -> refuse WITHOUT an enter, drop the note", async () => {
  /* Foreign pane: pre reads, body typed, then the echo gate reads TWICE (the
   * first miss buys one re-read after the longer settle) and neither shows the
   * tail -> a real swallow. No enter is ever pressed, so a modal's default is
   * never activated; the note is dropped because nothing is in any box. */
  const r = rig({ screens: [noTail(), noTail(), noTail()], canParse: false });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("refusedSwallowed");
  expect(r.reads).toBe(3); // pre + two echo reads (the second is the new re-read)
  expect(r.sendText).toEqual([BODY]);
  expect(r.sendKeys.length).toBe(0); // no enter pressed
  expect(r.unsubmitted.has(PANE)).toBe(false); // note dropped
});

/* THE TESTBOX LATE-PAINT (fail-before): the composer repaints the typed body
 * slower than the type-settle, so the FIRST echo read misses an echo that IS
 * coming. Pre-fix the gate read once and refused (refusedSwallowed) with no
 * enter; the body then sat forever in the composer, one read, permanent refusal.
 * Post-fix the gate reads a SECOND time after the longer re-echo settle, sees
 * the now-painted echo, and delivers with exactly one enter. The safety
 * property is untouched: the enter is pressed only AFTER an echo is seen. */
test("late-paint: first echo read misses, second read sees the echo -> delivered, one enter", async () => {
  // Foreign pane: pre (no echo), echo read #1 (no echo, still painting), echo
  // read #2 (echo painted), post-enter read (foreign: not inspected).
  const r = rig({ screens: [noTail(), noTail(), withTail(), withTail()], canParse: false });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.reads).toBe(4); // pre + two echo reads + post-enter read
  expect(r.sendText).toEqual([BODY]);
  expect(r.sendKeys).toEqual(["enter"]); // exactly one enter, pressed only after the echo appeared
  expect(r.unsubmitted.has(PANE)).toBe(false);
});

test("foreign wrap: a body echoed across composer border glyphs is delivered, enter pressed", async () => {
  /* THE TESTBOX FIELD FAILURE, at the machine seam. opencode's composer
   * (tmux mux, opencode 1.18.29, wide pane) showed the typed body fully but
   * wrapped it across rows drawn with a left border glyph "┃", so the tail
   * straddled the wrap. Before the chrome strip in flat(), the echo gate ruled
   * this refusedSwallowed and pressed no enter; now the gate sees the tail, so
   * the enter is pressed and the send is delivered. The wrap is placed inside
   * the last-24-char tail window, between "there," and "agent". */
  const wrapped: Screen = {
    box: { kind: "unknown" },
    text: ["opencode", "┃ hello", "┃ there,", "┃ agent", "  send"].join("\n"),
  };
  const r = rig({ screens: [noTail(), wrapped, wrapped], canParse: false });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.sendText).toEqual([BODY]);
  expect(r.sendKeys).toEqual(["enter"]); // the enter the field failure never reached
  expect(r.unsubmitted.has(PANE)).toBe(false);
});

test("stranded: body typed, enter pressed, box still holds it after the re-read", async () => {
  // canParse: pre empty -> type; post input+content; recheck input+content -> stranded.
  const r = rig({ screens: [input(false), input(true), input(true)], canParse: true });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("stranded");
  if (out.kind !== "stranded") throw new Error("narrow");
  expect(out.why).toBe(
    "the body was typed but the enter did not submit it; it is still in the input box");
  expect(r.sendText).toEqual([BODY]);
  expect(r.sendKeys).toEqual(["enter"]);
  expect(r.unsubmitted.get(PANE)?.deliveryId).toBe(DID); // note KEPT for enter-only retry
});

test("unconfirmed: a post-enter read that fails is success, and keeps the note", async () => {
  const r = rig({ screens: [input(false), { box: { kind: "unreadable" }, text: "" }], canParse: true });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("unconfirmed");
  expect(r.sendText).toEqual([BODY]);
  expect(r.sendKeys).toEqual(["enter"]);
  expect(r.unsubmitted.get(PANE)?.deliveryId).toBe(DID); // note KEPT (guards the retry)
});

test("delivered: a canParse pane whose box repaints empty is consumed, note dropped", async () => {
  const r = rig({ screens: [input(false), input(false)], canParse: true });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.sendKeys).toEqual(["enter"]);
  expect(r.unsubmitted.has(PANE)).toBe(false);
});

test("delivered: a slow box clear resolves on the re-read, not stranded", async () => {
  // post holds content, recheck has cleared -> delivered (not doubled).
  const r = rig({ screens: [input(false), input(true), input(false)], canParse: true });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.unsubmitted.has(PANE)).toBe(false);
});

test("delivered: a foreign pane whose transcript echoes the body is not false-stranded", async () => {
  // Foreign: pre, echo gate sees the tail, post is whatever (no strand check).
  const r = rig({ screens: [withTail(), withTail(), withTail()], canParse: false });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.sendText).toEqual([BODY]);
  expect(r.sendKeys).toEqual(["enter"]);
  expect(r.unsubmitted.has(PANE)).toBe(false);
});

test("enter-retry-once: a throwing sendKeys is retried once and the send still lands", async () => {
  const r = rig({ screens: [input(false), input(false)], canParse: true, sendKeysThrows: 1 });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.sendKeys).toEqual(["enter"]); // one recorded success, after one swallowed throw
});

test("skip-type: a believable note with the body still in the box submits without retyping", async () => {
  // canParse pane, note matches, box still has content -> stillThere -> enter only.
  const r = rig({
    screens: [input(true), input(false)],
    canParse: true,
    note: { deliveryId: DID, at: Date.now() },
  });
  const out = await runDeliveryMachine(r.io, PANE, BODY, DID, Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.sendText.length).toBe(0); // never retyped
  expect(r.sendKeys).toEqual(["enter"]);
});

/* THE INTENDED IMPROVEMENT (fail-before): a reply-slider change between a
 * stranded attempt and its retry no longer breaks the enter-only dedupe.
 *
 * Attempt 1 typed the body under reply level A and stranded it; the note is
 * keyed by the delivery id. The reply slider then moved, so attempt 2's
 * DELIVERED STRING differs (BODY_A vs BODY_B) even though it is the SAME message
 * (same delivery id). Under the retired keying the note was matched by
 * `note.text === text`; BODY_A !== BODY_B failed that, so the machine RETYPED the
 * body onto the stranded one and the agent read it doubled. Keyed by the
 * delivery id -- unchanged across the slider move -- the note is still believed,
 * so the retry presses enter only and submits the one stranded copy. */
test("slider-move dedupe: a reply-slider change between attempts keeps the enter-only retry", async () => {
  const BODY_A: string = "hi (reply in a voice note)"; // attempt 1, reply level A
  const BODY_B: string = "hi (reply as text)";         // retry, slider moved: same message
  // fail-before REFERENCE: the retired `note.text === text` identity would have
  // missed here, because the two attempts' delivered strings are not equal.
  expect(BODY_A === BODY_B,
    "the slider move must change the delivered string for this to prove anything").toBe(false);
  const r = rig({
    screens: [input(true), input(false)],           // box still holds the stranded body, then clears
    canParse: true,
    note: { deliveryId: DID, at: Date.now() },       // attempt 1's stranded note
  });
  const out = await runDeliveryMachine(r.io, PANE, BODY_B, DID, Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.sendText.length,
    "the retry retyped the body, doubling the stranded one (the slider-move miss)").toBe(0);
  expect(r.sendKeys).toEqual(["enter"]);
});
