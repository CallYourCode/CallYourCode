/* HOW A DELIVERY RESUMES (reply-words verification round 4, probes P0-P9).
 *
 * A failed attempt leaves an in-memory note AND an on-disk stage. Inside the
 * running process the note decides, exactly as on main: the box holding
 * content (claude) or our tail (a pane the engine cannot parse, pi) gets Enter
 * only, whatever the body now is (a slider move, re-decoded words, a quote, a
 * collapsed paste). Only after a real restart (no note, a stage) does the
 * strict rule apply: exactly this body in the box, or the box positively
 * empty, else nothing pressed and a visible failure. The screens are built
 * from the real claude fixture, continuation rows indented as claude draws
 * them. */
import { test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPaneBox, inputBoxText, flat } from "../terminal/blocked.ts";
import { runDeliveryMachine, type DeliveryIo } from "./delivery-machine.ts";

beforeAll(() => {
  for (const k of ["DELIVER_SETTLE_MS", "CONFIRM_SETTLE_MS", "RESTRAND_SETTLE_MS", "REECHO_SETTLE_MS"]) process.env[k] = "1";
});

const FIX = readFileSync(join(import.meta.dir, "../fixtures/pane-body-with-rule.txt"), "utf8").split("\n");
// a real claude screen (fixture) with the box interior replaced by `rows` (first row carries the marker)
function claudeScreen(body: string): string {
  const open = FIX.findIndex((r) => r.includes("relaying what the other agent said"));
  let close = open + 1;
  while (!/^\x1b\[0m\x1b\[38;2;136;136;136m─/.test(FIX[close]) && !/^─/.test(FIX[close].replace(/\x1b\[[0-9;]*m/g, ""))) close++;
  const lines = body.split("\n");
  const inner = lines.map((l, i) => (i === 0 ? `❯\u00a0${l}` : l === "" ? "" : `  ${l}`));
  return [...FIX.slice(0, open), ...inner, ...FIX.slice(close)].join("\n");
}

const SINGLE = "TEXT: msg TB (probe) (Reply with the chat tool)";
const QUOTED = "VOICE: > the agent said one thing\n> and then a second line\n\nmy words about it (Reply with the chat tool)";
const PARA = "TEXT: first paragraph of mine\n\nsecond paragraph (Reply with the chat tool)";

test("P0 fixture sanity: the stock fixture is an input box with content", () => {
  expect(classifyPaneBox(FIX.join("\n")).kind).toBe("input");
});
for (const [name, body] of [["single", SINGLE], ["paragraphs", PARA], ["multi-line quote", QUOTED]] as const) {
  test(`P1 inputBoxText reads back exactly the typed body: ${name}`, () => {
    const scr = claudeScreen(body);
    const box = classifyPaneBox(scr);
    expect(box.kind).toBe("input");
    const got = inputBoxText(scr);
    expect(flat(got ?? "")).toBe(flat(body));
  });
}

type Screen = { box: any; text: string };
function rig(body: string, opts: { canParse: boolean; resumed?: "typing" | "entering"; note?: boolean }) {
  const scr = claudeScreen(body);
  const s: Screen = { box: classifyPaneBox(scr), text: scr };
  const empty = claudeScreen("");
  const e: Screen = { box: classifyPaneBox(empty), text: empty };
  const screens = [s, e, e, e];
  const unsubmitted = new Map<string, { deliveryId: string; at: number }>();
  if (opts.note) unsubmitted.set("w1:p1", { deliveryId: "cid-1", at: Date.now() });
  const typed: string[] = []; const keys: string[] = [];
  const io = {
    mux: { async sendText(_h: string, t: string) { typed.push(t); }, async sendKeys(_h: string, k: string) { keys.push(k); } },
    unsubmitted,
    sessionFor: () => undefined,
    canParseScreen: () => opts.canParse,
    async readScreen() { return screens.shift() ?? e; },
    ...(opts.resumed ? { resumed: opts.resumed } : {}),
  } as unknown as DeliveryIo;
  return { io, typed, keys };
}

for (const [name, body] of [["single", SINGLE], ["multi-line quote", QUOTED]] as const) {
  test(`P2 claude pane, box holds exactly this body, stage typing (stranded retry or restart): Enter only: ${name}`, async () => {
    const r = rig(body, { canParse: true, resumed: "typing", note: true });
    const out = await runDeliveryMachine(r.io, "w1:p1", body, "cid-1", Date.now());
    expect(out.kind).toBe("delivered");
    expect(r.typed.length).toBe(0);
    expect(r.keys).toEqual(["enter"]);
  });
}
test("P3 claude pane, same multi-line quote body, in-memory note only (main's in-process retry): Enter only", async () => {
  const r = rig(QUOTED, { canParse: true, note: true });
  const out = await runDeliveryMachine(r.io, "w1:p1", QUOTED, "cid-1", Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.typed.length).toBe(0);
});
test("P4 foreign (pi) pane, body visibly still typed, note + stage typing (in-process retry after an Enter RPC failure): Enter only", async () => {
  const r = rig(SINGLE, { canParse: false, resumed: "typing", note: true });
  const out = await runDeliveryMachine(r.io, "w1:p1", SINGLE, "cid-1", Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.typed.length).toBe(0);
  expect(r.keys).toEqual(["enter"]);
});
test("P5 foreign (pi) pane, note only (main): Enter only", async () => {
  const r = rig(SINGLE, { canParse: false, note: true });
  const out = await runDeliveryMachine(r.io, "w1:p1", SINGLE, "cid-1", Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.typed.length).toBe(0);
});
test("P6 claude pane, a long body claude collapsed to a paste placeholder, stranded in process (note + stage typing)", async () => {
  const long = "TEXT: " + "word ".repeat(220).trim();
  const r = rig("[Pasted text #1 +3 lines]", { canParse: true, resumed: "typing", note: true });
  const out = await runDeliveryMachine(r.io, "w1:p1", long, "cid-1", Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.typed.length).toBe(0);
});
test("P7 same, main's path (note only): Enter only", async () => {
  const long = "TEXT: " + "word ".repeat(220).trim();
  const r = rig("[Pasted text #1 +3 lines]", { canParse: true, note: true });
  const out = await runDeliveryMachine(r.io, "w1:p1", long, "cid-1", Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.typed.length).toBe(0);
});
test("P8 slider-move retry (delivery-machine.test 'slider-move dedupe') as production wires it: note + stage typing", async () => {
  const BODY_A = "TEXT: hi (reply in a voice note)"; // attempt 1, stranded in the box
  const BODY_B = "TEXT: hi (reply as text)";         // the retry, slider moved: same cid
  const r = rig(BODY_A, { canParse: true, resumed: "typing", note: true });
  const out = await runDeliveryMachine(r.io, "w1:p1", BODY_B, "cid-1", Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.typed.length).toBe(0);
});
test("P9 same slider-move retry without the stage (main's wiring): Enter only", async () => {
  const r = rig("TEXT: hi (reply in a voice note)", { canParse: true, note: true });
  const out = await runDeliveryMachine(r.io, "w1:p1", "TEXT: hi (reply as text)", "cid-1", Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.typed.length).toBe(0);
});

test("P10 after a real restart (stage, no note) a collapsed paste cannot be read: nothing pressed, says restarted", async () => {
  const long = "TEXT: " + "word ".repeat(220).trim();
  const r = rig("[Pasted text #1 +3 lines]", { canParse: true, resumed: "typing" });
  const out = await runDeliveryMachine(r.io, "w1:p1", long, "cid-1", Date.now());
  expect(out.kind).toBe("refusedUnreadable");
  expect((out as { tell: string }).tell).toContain("restarted");
  expect(r.typed.length + r.keys.length).toBe(0);
});

test("P11 after a real restart, a multi-line quote still in the box is entered once", async () => {
  const r = rig(QUOTED, { canParse: true, resumed: "entering" });
  const out = await runDeliveryMachine(r.io, "w1:p1", QUOTED, "cid-1", Date.now());
  expect(out.kind).toBe("delivered");
  expect(r.typed.length).toBe(0);
  expect(r.keys).toEqual(["enter"]);
});
