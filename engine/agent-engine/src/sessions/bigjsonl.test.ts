/* #413: THE ENGINE MUST SURVIVE A HUGE SESSION FILE.
 *
 * A 387 MB transcript blocked the event loop: attach read the whole file to
 * gather an event count it never reached, parsing it synchronously, so /health
 * timed out and the engine looked gone until a manual restart. readEventsTail is
 * now bounded two ways and yields the loop mid-walk. These tests pin both:
 *
 *  1. CORRECTNESS: a byte-bounded (windowed) read returns exactly the newest
 *     window a full parse would give for that window -- a contiguous newest run,
 *     nothing invented, `more` set so the older events are known to exist.
 *  2. RESPONSIVENESS: while a large tail parses, a concurrent timer keeps firing
 *     on time (the event loop is serviced throughout), so a /health-style
 *     request would be answered rather than stalled.
 *
 * ON THE TIMER BOUNDS BELOW. The responsiveness tests measure REAL event-loop
 * drift, so they are the only thing in this file that a loaded box can make
 * noisy. The bounds are deliberately generous (a 20 ms timer allowed a quarter
 * second of drift) because the failure they exist to catch is not a slow tick,
 * it is a tick that does not happen AT ALL for the whole length of the read:
 * the #413 hang blocked the loop for the entire parse of a 387 MB file, which
 * is seconds, not milliseconds. A generous bound still fails on that and does
 * not fail because somebody else's build was running.
 */

import { test, expect, beforeAll } from "bun:test";
import { readEventsTail } from "./session-events";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";

// Keep in step with server.ts ATTACH_EVENT_BYTES; the read is byte-bounded to a
// newest window, and the file below is deliberately larger so the window bites.
const WINDOW_BYTES = 16 * 1024 * 1024;
const FILE_BYTES = 48 * 1024 * 1024; // > WINDOW_BYTES, so the byte budget triggers

let PATH = "";
let TOTAL_EVENTS = 0;

/* At module scope: tmp.ts registers its cleanup with afterAll on first use, and
 * bun runs a hook registered from inside a running hook the moment that hook
 * returns, which would delete the fixture before the first test read it. */
const scratch = tmpDir("cyc-bigjsonl-");

// One assistant text record per line, ts strictly increasing, each ~1 KB so the
// file reaches FILE_BYTES in a bounded number of lines. Every line parses to a
// reply event, which makes the newest-window comparison exact.
beforeAll(async () => {
  PATH = join(await scratch, "session.jsonl");
  const base = Date.UTC(2026, 0, 1);
  const pad = "x".repeat(900); // body kept whole (< BODY_CAP 20000); makes the line ~1 KB
  const sink = Bun.file(PATH).writer();
  let bytes = 0;
  let i = 0;
  while (bytes < FILE_BYTES) {
    const rec = {
      type: "assistant",
      uuid: `u${i.toString().padStart(9, "0")}`,
      timestamp: new Date(base + i).toISOString(),
      message: { content: [{ type: "text", text: `line ${i} ${pad}` }] },
    };
    const line = JSON.stringify(rec) + "\n";
    sink.write(line);
    bytes += Buffer.byteLength(line, "utf8");
    i++;
  }
  await sink.end();
  TOTAL_EVENTS = i;
});

test("a byte-bounded read returns exactly the newest window a full parse gives", async () => {
  // full parse of the whole file: every line is one reply event, ascending ts
  const full = await readEventsTail(PATH, { limit: 1_000_000_000 });
  expect(full.more).toBe(false); // reached the head
  expect(full.events.length).toBe(TOTAL_EVENTS);

  // the same read, byte-bounded to the newest window
  const win = await readEventsTail(PATH, { limit: 1_000_000_000, maxBytes: WINDOW_BYTES });
  expect(win.more).toBe(true); // older events exist beyond the window
  expect(win.bytesRead).toBeLessThanOrEqual(WINDOW_BYTES + (1 << 20)); // budget + at most one block
  expect(win.events.length).toBeGreaterThan(0);
  expect(win.events.length).toBeLessThan(full.events.length); // genuinely a window

  // it IS the newest run of the full parse: same events, same order, no invention
  const tail = full.events.slice(full.events.length - win.events.length);
  expect(win.events.map((e) => e.uuid)).toEqual(tail.map((e) => e.uuid));
  expect(win.events.map((e) => e.ts)).toEqual(tail.map((e) => e.ts));
  expect(win.events.map((e) => e.text)).toEqual(tail.map((e) => e.text));

  // and it is contiguous newest-first-in-file -> ascending: strictly increasing ts
  for (let k = 1; k < win.events.length; k++) {
    expect(win.events[k].ts).toBeGreaterThan(win.events[k - 1].ts);
  }
});

test("the newest window is bounded even when limit would ask for the whole file", async () => {
  // EVENT_LOG_MAX-shaped limit (50k) that the file cannot satisfy inside the
  // window: the byte budget, not the count, is what stops the walk.
  const win = await readEventsTail(PATH, { limit: 50_000, maxBytes: WINDOW_BYTES });
  expect(win.more).toBe(true);
  expect(win.bytesRead).toBeLessThanOrEqual(WINDOW_BYTES + (1 << 20));
});

test("the COUNT bound stops the walk too, and it stops it near the end of the file", async () => {
  /* The other bound, and the one an ordinary attach uses. Cost has to be
   * bounded by events WANTED as well as bytes walked: a limit of 10 over a
   * 48 MB file must not read 48 MB to answer. */
  const full = await readEventsTail(PATH, { limit: 1_000_000_000 });
  const few = await readEventsTail(PATH, { limit: 10 });
  expect(few.events.length).toBe(10);
  expect(few.more, "older events exist below a limit-stopped window").toBe(true);
  expect(few.bytesRead, "a ten-event read walked more than a couple of blocks")
    .toBeLessThanOrEqual(4 << 20);
  // and they are the NEWEST ten, in ascending order, exactly as the full parse has them
  expect(few.events.map((e) => e.uuid)).toEqual(full.events.slice(-10).map((e) => e.uuid));
});

test("a budget bigger than the file reads the whole file and leaves no cursor", async () => {
  const all = await readEventsTail(PATH, { limit: 1_000_000_000, maxBytes: FILE_BYTES * 2 });
  expect(all.more, "reaching the start of the file is not 'more exists'").toBe(false);
  expect(all.events.length).toBe(TOTAL_EVENTS);
  expect(all.resumeAt, "a walk that reached the head has nothing to resume from").toBe(0);
});

test("a file that is not there is an empty read, not a throw", async () => {
  /* A session whose transcript has not been written yet. The attach path calls
   * this before the first turn exists. */
  const r = await readEventsTail(join(PATH, "..", "no-such-session.jsonl"), { limit: 100 });
  expect(r).toEqual({ events: [], more: false, bytesRead: 0, resumeAt: 0 });
});

test("a large tail read keeps the event loop responsive (timer drift stays small)", async () => {
  const ticks: number[] = [];
  let stop = false;
  const tick = () => {
    if (stop) return;
    ticks.push(Date.now());
    setTimeout(tick, 20);
  };
  setTimeout(tick, 20);

  // walk a large slice of the file (crosses many yield boundaries); the read
  // must not starve the timer while it parses
  const t0 = Date.now();
  const { events } = await readEventsTail(PATH, { limit: 50_000 });
  const readMs = Date.now() - t0;
  stop = true;

  expect(events.length).toBeGreaterThan(0);
  // the read took real wall time and the timer got to run during it
  expect(readMs).toBeGreaterThan(30);
  expect(ticks.length).toBeGreaterThan(2);

  let maxGap = 0;
  for (let k = 1; k < ticks.length; k++) maxGap = Math.max(maxGap, ticks[k] - ticks[k - 1]);
  /* Without the mid-walk yield a whole-window parse blocks the loop for the
   * full readMs; with it, the loop is serviced every few MB. The bound is
   * deliberately loose against a 20 ms timer (see the file header): what it
   * catches is a loop that stopped entirely, not one that ticked late. */
  expect(maxGap).toBeLessThan(250);
});
