/* The bounded-concurrency gate that keeps one hung /stt from wedging the engine
 * (#551). Pure logic, no server, no audio:
 *
 *   bun test src/stt/batch-gate.test.ts
 *
 * The bug this closes: the batch path had NO bound, so hung decodes piled up
 * until a shared resource ran out and every later request wedged. The gate caps
 * concurrency, conserves the slot on release (a waiter cannot lose its turn),
 * and -- the property that matters most -- a request that cannot get a slot in
 * time fails LOUDLY (false) instead of waiting for ever.
 */
import { describe, expect, test } from "bun:test";
import { BatchGate } from "./batch-gate";

describe("BatchGate", () => {
  test("holds at most `max` slots at once", async () => {
    const g = new BatchGate(2);
    expect(await g.acquire(0)).toBe(true);
    expect(await g.acquire(0)).toBe(true);
    expect(g.inFlight).toBe(2);
    // Full: a zero wait fails immediately rather than blocking.
    expect(await g.acquire(0)).toBe(false);
    expect(g.inFlight).toBe(2);
  });

  test("a bounded wait FAILS loudly instead of blocking for ever", async () => {
    const g = new BatchGate(1);
    expect(await g.acquire(0)).toBe(true); // slot held, never released here
    const t0 = performance.now();
    const got = await g.acquire(80); // nobody releases, so this must time out
    const waited = performance.now() - t0;
    expect(got).toBe(false);
    expect(waited).toBeGreaterThanOrEqual(60);
    expect(waited).toBeLessThan(1000);
    expect(g.inFlight).toBe(1); // a timed-out waiter holds no slot
    expect(g.queued).toBe(0);
  });

  test("release hands the slot straight to a waiter (conserved, FIFO)", async () => {
    const g = new BatchGate(1);
    expect(await g.acquire(0)).toBe(true);
    const order: number[] = [];
    const a = g.acquire(5_000).then((ok) => { if (ok) order.push(1); return ok; });
    const b = g.acquire(5_000).then((ok) => { if (ok) order.push(2); return ok; });
    await Promise.resolve();
    expect(g.queued).toBe(2);
    expect(g.inFlight).toBe(1);

    g.release(); // -> waiter a; slot never drops to 0
    expect(await a).toBe(true);
    expect(g.inFlight).toBe(1);
    expect(g.queued).toBe(1);

    g.release(); // -> waiter b
    expect(await b).toBe(true);
    expect(order).toEqual([1, 2]);
    expect(g.inFlight).toBe(1);
    expect(g.queued).toBe(0);
  });

  test("release with no waiters frees the slot; over-release cannot go negative", async () => {
    const g = new BatchGate(2);
    expect(await g.acquire(0)).toBe(true);
    g.release();
    expect(g.inFlight).toBe(0);
    g.release(); // stray extra release
    g.release();
    expect(g.inFlight).toBe(0);
    // Still usable after over-release.
    expect(await g.acquire(0)).toBe(true);
    expect(g.inFlight).toBe(1);
  });

  test("a waiter that already timed out does not steal a later release's slot", async () => {
    const g = new BatchGate(1);
    expect(await g.acquire(0)).toBe(true);
    const late = g.acquire(40); // will time out before any release
    expect(await late).toBe(false);
    expect(g.queued).toBe(0);
    // The one holder releases: with no live waiter the slot simply frees.
    g.release();
    expect(g.inFlight).toBe(0);
  });

  test("stress: never exceeds max under interleaved acquire/release", async () => {
    const MAX = 3;
    const g = new BatchGate(MAX);
    let peak = 0;
    const worker = async () => {
      for (let i = 0; i < 50; i++) {
        const ok = await g.acquire(2_000);
        if (!ok) continue;
        peak = Math.max(peak, g.inFlight);
        expect(g.inFlight).toBeLessThanOrEqual(MAX);
        await Bun.sleep(1);
        g.release();
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    expect(peak).toBeGreaterThan(1); // real contention happened
    expect(peak).toBeLessThanOrEqual(MAX);
    expect(g.inFlight).toBe(0);
    expect(g.queued).toBe(0);
  });
});
