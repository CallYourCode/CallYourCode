/* STOP ON A pi PANE WITH QUEUED MESSAGES.
 *
 * Messages he sends while pi works are typed in and pi queues them. pi's
 * interrupt (Escape) aborts the turn and puts that queue back into its input
 * box UNSENT (interactive-mode restoreQueuedMessagesToEditor), so after Stop
 * they sat there until somebody pressed Enter in the TUI. The adapter's
 * interrupt now waits for pi to go idle and presses Enter once, but only when
 * the box holds nothing but the engine's own deliveries.
 *
 * The fake pane below models exactly the pi behaviour that matters: Enter while
 * working queues the box, Escape while working restores queue + draft into the
 * box and stays busy for a few reads, Enter while idle submits. The two reader
 * tests run on screens captured from a real pi 2026-10-07 (scratch tmux pane).
 *
 *   bun test agent-engine/src/adapters/pi-stop.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { piReader } from "../readers/pi.ts";
import type { Multiplexer, MuxAgent } from "../terminal/mux.ts";

const { MuxAdapter } = await import("./mux-adapter.ts");

const RULE = "─".repeat(60);
const BEFORE_ESCAPE = [
  " $ sleep 40 (timeout 60s)",
  "",
  " Steering: QUEUED-ONE: what is 2+2?",
  " Steering: QUEUED-TWO: and 3+3?",
  " ↳ Alt+Up to edit all queued messages",
  "",
  "── ⠇ Working " + RULE,
  "",
  RULE,
  "/tmp/pistop/cwd",
  "↑2 ↓92 W14k CH0.0% 1.4%/1.0M (auto)            (claude-bridge) claude-opus-4-8 • medium",
].join("\n");
const AFTER_ESCAPE = [
  " Command aborted",
  "",
  " Error: This operation was aborted",
  "",
  RULE,
  "QUEUED-ONE: what is 2+2?",
  "",
  "QUEUED-TWO: and 3+3?",
  RULE,
  "/tmp/pistop/cwd",
  "↑2 ↓92 W14k 1.4%/1.0M (auto)                   (claude-bridge) claude-opus-4-8 • medium",
].join("\n");

test("pi reader: a working top rule is busy; an idle box reads back its text", () => {
  expect(piReader.restoredInput!(BEFORE_ESCAPE)).toBeNull();
  expect(piReader.restoredInput!(AFTER_ESCAPE)).toEqual({
    text: "QUEUED-ONE: what is 2+2?\n\nQUEUED-TWO: and 3+3?", clipped: false,
  });
});

test("pi reader: a scrolled box is idle and clipped", () => {
  const screen = ["─── ↑ 3 more " + RULE, "tail of a long message", RULE, "/tmp/x"].join("\n");
  expect(piReader.restoredInput!(screen)).toEqual({ text: "tail of a long message", clipped: true });
});

/* ----------------------------------------------------------- the fake pi pane */

const WIDTH = 40;
const MAX_LINES = 5;

function fakePi(paneId: string) {
  const pi = { working: true, busyReads: 0, queue: [] as string[], box: "", submitted: [] as string[], keys: [] as string[] };
  const render = () => {
    const wrapped = pi.box.split("\n").flatMap((l) => {
      const out: string[] = [];
      for (let s = l; ; s = s.slice(WIDTH)) { out.push(s.slice(0, WIDTH)); if (s.length <= WIDTH) break; }
      return out;
    });
    const hidden = Math.max(0, wrapped.length - MAX_LINES);
    const top = pi.working ? "── ⠋ Working " + RULE : hidden ? `─── ↑ ${hidden} more ${RULE}` : RULE;
    return [
      " some earlier reply",
      ...pi.queue.map((q) => ` Steering: ${q}`),
      top, ...wrapped.slice(hidden), RULE,
      "/tmp/proj", "0.1%/1.0M (auto)  (claude-bridge) claude-opus-4-8",
    ].join("\n");
  };
  const mux = {
    onAgents(cb: (a: MuxAgent[]) => void) {
      cb([{
        paneId, name: "proj", cwd: "/tmp/proj", status: "working", agent: "pi",
        agentSession: { id: "b1000000-0000-4000-8000-00000000abcd", kind: "id", source: "herdr:pi" },
        workspace: "w1", tab: null, displayAgent: null, stateChangeSeq: 0,
      } as MuxAgent]);
    },
    start() {},
    async readPane() {
      if (pi.busyReads > 0 && --pi.busyReads === 0) pi.working = false;
      return { text: render(), truncated: false };
    },
    async sendText(_: string, text: string) { pi.box += text; },
    async sendKeys(_: string, ...keys: string[]) {
      for (const k of keys) {
        pi.keys.push(k);
        if (k === "enter") {
          if (!pi.box.trim()) continue;
          (pi.working ? pi.queue : pi.submitted).push(pi.box);
          pi.box = "";
        } else if (k === "escape" && pi.working) {
          // restoreQueuedMessagesToEditor({abort:true}): queue first, draft after
          pi.box = [pi.queue.join("\n\n"), pi.box].filter((t) => t.trim()).join("\n\n");
          pi.queue = [];
          pi.busyReads = 2; // the abort settles a couple of reads later
        }
      }
    },
    async renamePane() {}, async closePane() {},
    workspaceOf() { return null; }, knownCwds() { return []; },
    async newTab() { return "w9:p1"; },
  } as unknown as Multiplexer;
  return { pi, mux };
}

const PANE = "w1:pi";
let prevSettle: string | undefined;
beforeAll(() => { prevSettle = process.env.DELIVER_SETTLE_MS; process.env.DELIVER_SETTLE_MS = "5"; });
afterAll(() => {
  if (prevSettle === undefined) delete process.env.DELIVER_SETTLE_MS;
  else process.env.DELIVER_SETTLE_MS = prevSettle;
});

function adapterOn() {
  const { pi, mux } = fakePi(PANE);
  const adapter = new MuxAdapter(mux);
  adapter.onAgents(() => {});
  return { pi, adapter };
}

test("Stop on a working pi resubmits the messages the engine queued into it", async () => {
  const { pi, adapter } = adapterOn();
  await adapter.sendInput(PANE, "texted: first queued message", "d1");
  await adapter.sendInput(PANE, "texted: second queued message", "d2");
  expect(pi.queue).toEqual(["texted: first queued message", "texted: second queued message"]);

  await adapter.interrupt(PANE);

  expect(pi.keys.slice(-2)).toEqual(["escape", "enter"]);
  expect(pi.submitted).toEqual(["texted: first queued message\n\ntexted: second queued message"]);
  expect(pi.box).toBe("");
});

test("a long restored queue that scrolls the box is still resubmitted", async () => {
  const { pi, adapter } = adapterOn();
  const long = "texted: " + "a long message that wraps ".repeat(12);
  await adapter.sendInput(PANE, long, "d1");
  await adapter.interrupt(PANE);
  expect(pi.submitted).toEqual([long]);
});

test("a draft typed in the TUI is never submitted by the Stop", async () => {
  const { pi, adapter } = adapterOn();
  await adapter.sendInput(PANE, "texted: queued from the phone", "d1");
  pi.box = "half a thought he is typing"; // his own draft in the TUI

  await adapter.interrupt(PANE);

  expect(pi.keys.at(-1)).toBe("escape");
  expect(pi.submitted).toEqual([]);
  expect(pi.box).toBe("texted: queued from the phone\n\nhalf a thought he is typing");
});

test("a queue the engine did not deliver is left in the box", async () => {
  const { pi, adapter } = adapterOn();
  await adapter.sendInput(PANE, "texted: from the phone", "d1");
  pi.box = "typed in the TUI";
  queueAtKeyboard(pi); // he queued it himself at the keyboard

  await adapter.interrupt(PANE);

  expect(pi.submitted).toEqual([]);
  expect(pi.box).toBe("texted: from the phone\n\ntyped in the TUI");
});

test("nothing delivered: the Stop is the interrupt key alone, no screen read", async () => {
  const { pi, adapter } = adapterOn();
  await adapter.interrupt(PANE);
  expect(pi.keys).toEqual(["escape"]);
  expect(pi.busyReads).toBe(2); // never read: the abort countdown is untouched
});

function queueAtKeyboard(pi: ReturnType<typeof fakePi>["pi"]): void {
  pi.queue.push(pi.box);
  pi.box = "";
}
