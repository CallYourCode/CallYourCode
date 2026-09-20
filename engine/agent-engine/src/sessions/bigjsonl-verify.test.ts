/* #413 VERIFIER: the adversarial seams the builder's bigjsonl.test.ts does not
 * cover.
 *
 *   - the STRADDLE boundary: a byte budget that lands mid-line still returns an
 *     exact contiguous newest suffix, with no half-parsed record at its edge;
 *   - the EOF-anchored `before` walk. A bounded before-request stays bounded and
 *     never stalls, and it CANNOT reach past the newest window, which is exactly
 *     why #583 added the byte cursor. Backward history pages over
 *     `from`/`resumeAt` (invariant E9, events-history.test.ts);
 *   - the resumable walk itself: chained calls return every line exactly once;
 *   - the malformed-file seams: empty, one huge line over the budget, a
 *     truncated last line, CRLF.
 *
 * Every file here is built in the test's own temp dir and every bound is a
 * property of the read rather than a wall-clock measurement, so nothing in this
 * file is sensitive to how loaded the box is.
 */

import { test, expect, beforeAll } from "bun:test";
import { readEventsTail } from "./session-events";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";

const BLOCK = 1 << 20; // must match session-events.ts BLOCK

function recLine(i: number, base: number, pad: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u${i.toString().padStart(9, "0")}`,
    timestamp: new Date(base + i).toISOString(),
    message: { content: [{ type: "text", text: `line ${i} ${pad}` }] },
  }) + "\n";
}

/* At module scope: tmp.ts registers its cleanup with afterAll on first use, and
 * bun runs a hook registered from inside a running hook the moment that hook
 * returns, which would delete the fixtures before the first test read them. */
const scratch = tmpDir("cyc-verify-");
const at = async (name: string) => join(await scratch, name);

// A few-MB file of ~1 KB monotonic-ts lines. Small budget so several windows.
const PAGE_BYTES = 6 * 1024 * 1024;
const PAGE_BUDGET = 1 * 1024 * 1024; // one block per request
let PAGE_PATH = "";
let PAGE_TOTAL = 0;

beforeAll(async () => {
  PAGE_PATH = await at("page.jsonl");
  const base = Date.UTC(2026, 0, 1);
  const pad = "y".repeat(900);
  const sink = Bun.file(PAGE_PATH).writer();
  let bytes = 0, i = 0;
  while (bytes < PAGE_BYTES) {
    const line = recLine(i, base, pad);
    sink.write(line);
    bytes += Buffer.byteLength(line, "utf8");
    i++;
  }
  await sink.end();
  PAGE_TOTAL = i;
});

test("full parse baseline: strictly increasing ts, every line one event", async () => {
  const full = await readEventsTail(PAGE_PATH, { limit: 1e9 });
  expect(full.more).toBe(false);
  expect(full.events.length).toBe(PAGE_TOTAL);
  for (let k = 1; k < full.events.length; k++) {
    expect(full.events[k].ts).toBeGreaterThan(full.events[k - 1].ts);
  }
});

test("straddle boundary: windowed events are an exact contiguous newest suffix of the full parse", async () => {
  const full = await readEventsTail(PAGE_PATH, { limit: 1e9 });
  // budget that lands mid-line for sure (not a block multiple)
  const budget = 1_500_000;
  const win = await readEventsTail(PAGE_PATH, { limit: 1e9, maxBytes: budget });
  expect(win.more).toBe(true);
  expect(win.bytesRead).toBeLessThanOrEqual(budget + BLOCK);
  const tail = full.events.slice(full.events.length - win.events.length);
  expect(win.events.map((e) => e.uuid)).toEqual(tail.map((e) => e.uuid));
  // no partial / garbage event at the oldest edge: oldest windowed line is a
  // COMPLETE line that full-parse also holds intact
  expect(win.events[0].text).toBe(tail[0].text);
});

// The `before` filter is EOF-anchored: without a `from`, every walk starts at
// the end of the file, so a `before` older than the newest window can only ever
// re-walk (and re-skip) that window inside its byte budget. It returns a
// bounded, well-defined answer and NEVER stalls the loop, and it cannot reach
// older events, which is why `before` is NOT the backward pager. Backward
// history is the byte cursor (#583, `from`/`resumeAt`): see
// events-history.test.ts for the E9 coverage proof. This test pins that the
// legacy filter stays bounded and honest about what it cannot do.
test("a before-request older than the newest window stays bounded and never stalls", async () => {
  const full = await readEventsTail(PAGE_PATH, { limit: 1e9 });

  // page 1: the newest byte-bounded window. Bounded, and a strict subset.
  const win = await readEventsTail(PAGE_PATH, { limit: 1e9, maxBytes: PAGE_BUDGET });
  expect(win.bytesRead).toBeLessThanOrEqual(PAGE_BUDGET + BLOCK);
  expect(win.more).toBe(true); // older bytes remain
  expect(win.events.length).toBeGreaterThan(0);
  expect(win.events.length).toBeLessThan(full.events.length); // strict subset: older dropped

  // page 2: ask for events OLDER than page 1. Documented answer: a bounded,
  // well-defined result that does not stall. It returns quickly within budget;
  // it does NOT (and is not expected to) reach the older events.
  const before = win.events[0].ts;
  const older = await readEventsTail(PAGE_PATH, { before, limit: 1e9, maxBytes: PAGE_BUDGET });
  expect(older.bytesRead).toBeLessThanOrEqual(PAGE_BUDGET + BLOCK); // bounded, no whole-file walk
  expect(Array.isArray(older.events)).toBe(true); // a well-defined answer
  // the newest window's budget is fully spent re-skipping already-returned
  // newest events, so no older event is reached: `before` alone cannot page
  // backward. A caller that wants older overlay history passes a cursor
  // (`from`), which is what the route and the app do since #583.
  expect(older.events.length).toBe(0);

  // and the whole thing terminated fast (no event-loop stall): the two reads
  // above already returned, which they could not if the walk were unbounded.
});

/* THE RESUMABLE WALK (#583). This is the property `before` cannot give: chained
 * calls over `from`/`resumeAt` page strictly OLDER, and every line comes back
 * exactly once across the whole chain. A cursor that did not strictly decrease
 * would loop forever; one that skipped past its own line would drop history
 * silently, which is the worse of the two. */
test("paging over the byte cursor reads the whole file, every line exactly once", async () => {
  const full = await readEventsTail(PAGE_PATH, { limit: 1e9 });

  const seen: string[] = [];
  let from: number | undefined = undefined;
  let last = Infinity;
  for (let page = 0; page < 100; page++) {
    const r: Awaited<ReturnType<typeof readEventsTail>> =
      await readEventsTail(PAGE_PATH, { limit: 1e9, maxBytes: PAGE_BUDGET, from });
    expect(r.bytesRead, "a page walked past its own byte budget")
      .toBeLessThanOrEqual(PAGE_BUDGET + BLOCK);
    seen.unshift(...r.events.map((e) => e.uuid));
    if (!r.more) break;
    expect(r.resumeAt, "the cursor did not strictly decrease, so this would loop forever")
      .toBeLessThan(last);
    last = r.resumeAt;
    from = r.resumeAt;
  }
  expect(seen.length, "paging lost or repeated lines").toBe(full.events.length);
  expect(seen).toEqual(full.events.map((e) => e.uuid));
});

test("the cursor's own page boundary is not a line boundary, and no line is torn across it", async () => {
  /* The budget stops mid-line by construction. The line that straddles the stop
   * belongs to the NEXT page whole; if both pages parsed half of it, the join
   * above would still be the right length and the text would be wrong. */
  const full = await readEventsTail(PAGE_PATH, { limit: 1e9 });
  const first = await readEventsTail(PAGE_PATH, { limit: 1e9, maxBytes: 1_500_000 });
  expect(first.more).toBe(true);
  const second = await readEventsTail(PAGE_PATH, { limit: 1e9, maxBytes: 1_500_000, from: first.resumeAt });
  const joined = [...second.events, ...first.events];
  const want = full.events.slice(full.events.length - joined.length);
  expect(joined.map((e) => e.uuid)).toEqual(want.map((e) => e.uuid));
  expect(joined.map((e) => e.text)).toEqual(want.map((e) => e.text));
});

// SEAM: empty file -> empty read, no throw.
test("empty file returns empty, more:false", async () => {
  const p = await at("empty.jsonl");
  await Bun.write(p, "");
  const r = await readEventsTail(p, { limit: 1e9, maxBytes: PAGE_BUDGET });
  expect(r.events).toEqual([]);
  expect(r.more).toBe(false);
  expect(r.bytesRead).toBe(0);
  expect(r.resumeAt).toBe(0);
});

// SEAM: a file that is one long run of blank lines and junk parses to nothing
// without ever claiming there is more behind it.
test("a file with no parseable record is empty, not 'more exists'", async () => {
  const p = await at("junk.jsonl");
  await Bun.write(p, "\n\n{not json}\n[]\n\n" + "null\n".repeat(50));
  const r = await readEventsTail(p, { limit: 1e9 });
  expect(r.events).toEqual([]);
  expect(r.more, "the walk reached the head of the file").toBe(false);
});

// SEAM: one huge line bigger than the byte budget. The budget must still bound
// the walk / the loop must still yield. (Probes whether the carry-accumulation
// branch escapes the byte budget.)
test("a single line larger than the budget stays within the byte budget", async () => {
  const p = await at("hugeline.jsonl");
  const budget = 2 * 1024 * 1024;
  const bigText = "z".repeat(budget * 2); // one ~4MB record, > 2MB budget
  const line = JSON.stringify({
    type: "assistant", uuid: "uHUGE",
    timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    message: { content: [{ type: "text", text: bigText }] },
  }) + "\n";
  await Bun.write(p, line);
  const r = await readEventsTail(p, { limit: 1e9, maxBytes: budget });
  // The read must not walk unboundedly past the budget on one giant line.
  expect(r.bytesRead).toBeLessThanOrEqual(budget + BLOCK);
});

// SEAM: truncated / corrupt last line (kill-mid-write) is skipped, not fatal.
test("a truncated last line is skipped and earlier events survive", async () => {
  const p = await at("trunc.jsonl");
  const base = Date.UTC(2026, 0, 1);
  const good = recLine(0, base, "a") + recLine(1, base, "b");
  const partial = '{"type":"assistant","uuid":"uPART","timestamp":"2026'; // no newline, mid-write
  await Bun.write(p, good + partial);
  const r = await readEventsTail(p, { limit: 1e9 });
  const uuids = r.events.map((e) => e.uuid);
  expect(uuids).toEqual(["u000000000", "u000000001"]); // partial dropped
});

// SEAM: CRLF line endings parse (the \r is trimmed before JSON.parse).
test("CRLF line endings parse", async () => {
  const p = await at("crlf.jsonl");
  const base = Date.UTC(2026, 0, 1);
  const body = recLine(0, base, "a").replace(/\n$/, "\r\n") + recLine(1, base, "b").replace(/\n$/, "\r\n");
  await Bun.write(p, body);
  const r = await readEventsTail(p, { limit: 1e9 });
  expect(r.events.map((e) => e.uuid)).toEqual(["u000000000", "u000000001"]);
});
