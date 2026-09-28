/* The dedup-and-cancel hub in isolation (#stt-busy).
 *
 *   bun test src/stt/inflight.test.ts
 *
 * The integration proof (a real engine collapsing two identical POSTs into one
 * decode, and freeing its slot when a caller gives up) is inflight-decode.test.ts;
 * this file pins the hub's own decisions with a `work` the test controls, so
 * "the second caller joins the first" and "the last caller to leave cancels the
 * decode" are facts about the mechanism rather than a timing race.
 */
import { test, expect } from "bun:test";
import { DecodeHub, isAbortError, abortError } from "./inflight";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("two identical concurrent requests decode ONCE and share the one result", async () => {
  const hub = new DecodeHub();
  let calls = 0;
  const d = deferred<string>();
  const work = (_s: AbortSignal) => { calls++; return d.p; };

  const a = hub.run("k", new AbortController().signal, work);
  const b = hub.run("k", new AbortController().signal, work);
  expect(hub.size, "the two identical requests did not share one entry").toBe(1);

  d.resolve("the transcript");
  const [ra, rb] = await Promise.all([a, b]);
  expect(calls, "the same clip was decoded twice instead of joined once").toBe(1);
  expect(ra.result).toBe("the transcript");
  expect(rb.result).toBe("the transcript");
  // Exactly one started the decode and exactly one joined it.
  expect([ra.joined, rb.joined].filter(Boolean).length,
    "the join bookkeeping is wrong: not exactly one caller joined").toBe(1);
  await tick();
  expect(hub.size, "the settled decode was not dropped, so the next request would join a corpse")
    .toBe(0);
});

test("different keys each get their own decode", async () => {
  const hub = new DecodeHub();
  let calls = 0;
  const d1 = deferred<string>(); const d2 = deferred<string>();
  const p1 = hub.run("a", new AbortController().signal, () => { calls++; return d1.p; });
  const p2 = hub.run("b", new AbortController().signal, () => { calls++; return d2.p; });
  expect(hub.size).toBe(2);
  d1.resolve("one"); d2.resolve("two");
  expect((await p1).result).toBe("one");
  expect((await p2).result).toBe("two");
  expect(calls, "distinct clips were collapsed into one decode").toBe(2);
});

test("the LAST caller to give up cancels the decode", async () => {
  const hub = new DecodeHub();
  let workSignal: AbortSignal | null = null;
  const d = deferred<string>();
  const ac = new AbortController();
  const run = hub.run("k", ac.signal, (s) => { workSignal = s; return d.p; });

  await tick();
  expect(workSignal, "the decode never started").not.toBeNull();
  expect(workSignal!.aborted, "the decode was cancelled before its only caller gave up").toBe(false);

  ac.abort();
  await expect(run).rejects.toThrow(); // the caller returns at once
  expect(workSignal!.aborted, "the sole caller gave up and the decode kept burning the decoder")
    .toBe(true);
  d.reject(new Error("cancelled")); // a real `work` would reject on its aborted signal
});

test("a decode is NOT cancelled while another caller still needs it", async () => {
  const hub = new DecodeHub();
  let workSignal!: AbortSignal;
  const d = deferred<string>();
  const acA = new AbortController();
  const acB = new AbortController();

  const a = hub.run("k", acA.signal, (s) => { workSignal = s; return d.p; });
  const b = hub.run("k", acB.signal, () => d.p);
  await tick();

  acA.abort();
  await expect(a, "the caller that gave up did not return promptly").rejects.toThrow();
  expect(workSignal.aborted,
    "one caller gave up and the decode was cancelled out from under the caller still waiting")
    .toBe(false);

  d.resolve("shared");
  expect((await b).result, "the surviving caller lost the transcript it was still waiting for")
    .toBe("shared");
});

test("a caller whose signal is ALREADY aborted still cancels a lone decode", async () => {
  const hub = new DecodeHub();
  let workSignal!: AbortSignal;
  const d = deferred<string>();
  const ac = new AbortController();
  ac.abort();
  const run = hub.run("k", ac.signal, (s) => { workSignal = s; return d.p; });
  await expect(run).rejects.toThrow();
  await tick();
  expect(workSignal.aborted).toBe(true);
  d.reject(new Error("cancelled"));
});

test("abortError/isAbortError round-trip", () => {
  expect(isAbortError(abortError("gone"))).toBe(true);
  expect(isAbortError(new DOMException("x", "TimeoutError"))).toBe(true);
  expect(isAbortError(new Error("boom"))).toBe(false);
  const keep = new Error("keep me");
  expect(abortError(keep), "an Error reason should pass through unchanged").toBe(keep);
});
