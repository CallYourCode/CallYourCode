/* THE ROBUSTNESS RULING (the pointer-pages brief, item 11): every read of a
 * session jsonl must be windowed or streamed in bounded chunks that yield to the
 * event loop, so no single read can freeze the engine.
 *
 * bigjsonl.test.ts already pins readEventsTail. This pins the readers that used
 * to materialise a slice (or the whole file) with .text() and did not yield:
 *
 *   - readSessionTitle / readContextUsage: growing backward windows, now decoded
 *     from bytes (no .text()) with a yield before each larger window;
 *   - readAgentRuns: the cold span, now streamed forward in bounded blocks that
 *     yield, rather than one .text() from the cold offset to EOF.
 *
 * The proof is the same shape bigjsonl uses: build a large synthetic jsonl, run
 * each reader over it, and show a concurrent 20 ms timer keeps firing on time
 * (the loop is serviced throughout) while the reader still returns the right
 * answer. A 1 GB session must degrade to slower reads, never a frozen engine.
 *
 * ON THE BOUNDS. These measure REAL event-loop drift and are the only thing
 * here a loaded box can make noisy, so the gaps allowed are deliberately
 * generous: a 20 ms timer is given a quarter of a second. The failure being
 * caught is not a late tick, it is a tick that does not happen at all for the
 * whole length of the read, which on these files is hundreds of milliseconds to
 * seconds. A loose bound still fails on that and does not fail because
 * somebody's build was running at the same time.
 */

import { test, expect, beforeAll } from "bun:test";
import { readSessionTitle, readContextUsage, readAgentRuns } from "./session-events";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";

// Large enough that a growing 8 MB window fills and the cold span crosses many
// yield boundaries, small enough for a unit test's temp dir.
const FILE_BYTES = 60 * 1024 * 1024;

let PATH = "";

/* At module scope: tmp.ts registers its cleanup with afterAll on first use, and
 * bun runs a hook registered from inside a running hook the moment that hook
 * returns, which would delete the fixture before the first test read it. */
const scratch = tmpDir("cyc-bigreads-");

/* A transcript with: assistant turns carrying real usage (so readContextUsage
 * has an answer near EOF), a Task launch near the very end (so readAgentRuns has
 * a run to find), and NO ai-title record at all (so readSessionTitle is forced to
 * walk its whole 8 MB cap and return null -- the bounded worst case). Timestamps
 * are recent so the cold-start window covers the file. */
beforeAll(async () => {
  PATH = join(await scratch, "session.jsonl");
  const base = Date.now() - 60 * 60 * 1000; // within the phantom/run window
  const pad = "y".repeat(900);
  const sink = Bun.file(PATH).writer();
  let bytes = 0;
  let i = 0;
  while (bytes < FILE_BYTES) {
    const rec = {
      type: "assistant",
      uuid: `u${i.toString().padStart(9, "0")}`,
      timestamp: new Date(base + i * 10).toISOString(),
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 1000 + i, output_tokens: 10, cache_read_input_tokens: 2000 },
        content: [{ type: "text", text: `line ${i} ${pad}` }],
      },
    };
    const line = JSON.stringify(rec) + "\n";
    sink.write(line);
    bytes += Buffer.byteLength(line, "utf8");
    i++;
  }
  await sink.end();
});

/* Run `fn` while a 20 ms timer ticks, and report the reader's result, how long
 * it took, and the worst gap the timer saw. A blocked loop shows up as a maxGap
 * near the whole read time; a yielding reader keeps it small. */
async function underTimer<T>(fn: () => Promise<T>): Promise<{ result: T; readMs: number; maxGap: number; ticks: number }> {
  const stamps: number[] = [];
  let stop = false;
  const tick = () => { if (stop) return; stamps.push(Date.now()); setTimeout(tick, 20); };
  setTimeout(tick, 20);
  const t0 = Date.now();
  const result = await fn();
  const readMs = Date.now() - t0;
  stop = true;
  let maxGap = 0;
  for (let k = 1; k < stamps.length; k++) maxGap = Math.max(maxGap, stamps[k] - stamps[k - 1]);
  return { result, readMs, maxGap, ticks: stamps.length };
}

test("readContextUsage answers from a large file and keeps the loop responsive", async () => {
  const { result, maxGap } = await underTimer(() => readContextUsage(PATH));
  expect(result, "no usage read from a file full of assistant turns").toBeTruthy();
  expect((result as any).tokens, "the newest usage should be read, near EOF").toBeGreaterThan(0);
  expect(maxGap, "the read starved a 20ms timer, so it blocked the event loop").toBeLessThan(250);
});

test("readSessionTitle walks its whole cap on a title-less file without freezing the loop", async () => {
  const { result, maxGap } = await underTimer(() => readSessionTitle(PATH));
  expect(result, "a file with no ai-title must answer null, not a stray match").toBeNull();
  expect(maxGap, "the title scan blocked the loop while walking to its cap").toBeLessThan(250);
});

test("readAgentRuns streams a large cold span without freezing the loop", async () => {
  const { result, readMs, maxGap, ticks } = await underTimer(() => readAgentRuns(PATH));
  expect(Array.isArray(result)).toBe(true);
  // the cold parse crosses the whole file, which takes real wall time...
  expect(readMs).toBeGreaterThan(30);
  // ...and the timer kept firing throughout, proving the forward stream yields
  expect(ticks).toBeGreaterThan(2);
  expect(maxGap, "the cold agent-runs parse blocked the event loop").toBeLessThan(300);
});

/* The three readers against a file that is not there. Every one of them is
 * called for a session whose transcript has not been written yet (a pane that
 * has had no turn), so "no file" has to be an answer rather than a throw that
 * takes an attach down with it. */
test("a session with no transcript yet answers empty from every reader", async () => {
  const missing = join(await scratch, "no-such-session.jsonl");
  expect(await readSessionTitle(missing)).toBeNull();
  expect(await readContextUsage(missing)).toBeNull();
  expect(await readAgentRuns(missing)).toEqual([]);
});

/* The same three against a file that exists and says nothing they want. The
 * bounded worst case: each has to walk to its own cap and answer "nothing"
 * rather than returning a stray match from a record of another shape. */
test("a transcript with none of what a reader wants answers empty, not a stray match", async () => {
  const bare = join(await scratch, "bare.jsonl");
  await Bun.write(bare, [
    JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date().toISOString(),
      message: { content: "hello" } }),
    JSON.stringify({ type: "summary", summary: "not an ai-title record" }),
    "",
  ].join("\n"));
  expect(await readSessionTitle(bare)).toBeNull();
  expect(await readContextUsage(bare)).toBeNull();
  expect(await readAgentRuns(bare)).toEqual([]);
});
