/* THE SEALED WRITER'S TWO LANES (download-lane, 2026-10-03).
 *
 * A 13.5 MB download used to ride the one sealed write chain ahead of every
 * chat frame, attach page and upload ack the engine owed the same device, and
 * pour itself into the DataChannel stack faster than the pipe could drain (the
 * engine's event loop starved for the whole download, sends hung until a
 * reload). EngineSecConn now writes through one pump with two lanes: control
 * first, and a bulk frame only when no control frame waits and the pipe has
 * drained. These pin that, hermetically: a fake channel that seals to itself
 * and a drain the test opens by hand.
 *
 *   bun test agent-engine/src/security/sealwriter.test.ts
 */

import { expect, test } from "bun:test";
import { EngineSecConn } from "./sec.ts";

/** A pipe whose drain the test controls: `full` until open() is called. */
function pipe() {
  let waiters: Array<() => void> = [];
  let full = true;
  return {
    drain: () => (full ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
    open() {
      full = false;
      for (const w of waiters.splice(0)) w();
    },
    fill() {
      full = true;
    },
  };
}

function conn(drain: () => Promise<void>) {
  const out: string[] = [];
  const c = new EngineSecConn({} as never, "u", "h", "rtc",
    (f) => out.push((f as { k: string }).k), () => {}, () => {}, () => {}, drain);
  // The channel exists once the handshake ran; here it seals to itself.
  (c as unknown as { chan: unknown }).chan = { seal: async (inner: unknown) => inner };
  return { c, out };
}

const turn = () => new Promise((r) => setTimeout(r, 0));

test("a control frame never waits behind queued bulk frames", async () => {
  const p = pipe();
  const { c, out } = conn(p.drain);
  void c.sealSend({ k: "b1" }, "bulk");
  void c.sealSend({ k: "b2" }, "bulk");
  void c.sealSend({ k: "c1" });
  await turn();
  // the pipe is full: the bulk frames wait, the chat frame goes now
  expect(out).toEqual(["c1"]);

  p.open();
  await turn();
  expect(out).toEqual(["c1", "b1", "b2"]);

  // the pipe fills again: a new control frame still overtakes the next bulk one
  p.fill();
  void c.sealSend({ k: "b3" }, "bulk");
  await turn();
  void c.sealSend({ k: "c2" });
  await turn();
  expect(out).toEqual(["c1", "b1", "b2", "c2"]);
  p.open();
  await turn();
  expect(out).toEqual(["c1", "b1", "b2", "c2", "b3"]);
});

test("control frames keep their order, and bulk frames keep theirs", async () => {
  const p = pipe();
  p.open();
  const { c, out } = conn(p.drain);
  const all = [
    c.sealSend({ k: "c1" }),
    c.sealSend({ k: "b1" }, "bulk"),
    c.sealSend({ k: "c2" }),
    c.sealSend({ k: "b2" }, "bulk"),
    c.sealSend({ k: "c3" }),
  ];
  await Promise.all(all);
  expect(out.filter((k) => k.startsWith("c"))).toEqual(["c1", "c2", "c3"]);
  expect(out.filter((k) => k.startsWith("b"))).toEqual(["b1", "b2"]);
});

test("sealSend resolves only once its frame is on the pipe", async () => {
  const p = pipe();
  const { c, out } = conn(p.drain);
  let sent = false;
  const done = c.sealSend({ k: "b1" }, "bulk").then(() => {
    sent = true;
  });
  await turn();
  // a caller awaiting this before reading the pipe's drain reads a buffer that
  // HOLDS its frame; before, it read an empty one and raced ahead
  expect(sent).toBe(false);
  expect(out).toEqual([]);
  p.open();
  await done;
  expect(out).toEqual(["b1"]);
});
