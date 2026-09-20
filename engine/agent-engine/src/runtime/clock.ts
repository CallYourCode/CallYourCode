/* THE ONE PATTERN FOR TIME.
 *
 * Every time-driven module in the engine takes an optional `clock` in its deps
 * bag, defaulting to `realClock`. Production is byte-identical to what it was
 * before the seam existed: Date.now and the global timers. Only tests pass a
 * `manualClock()`, and then NOTHING in the module reaches the wall clock, so a
 * ten second push window or a fifteen minute lateness ladder costs a test
 * exactly one `await clock.advance(ms)` and no sleeping at all.
 *
 * The rule that goes with it: no unit or seam test calls Bun.sleep. Waiting on
 * LOGICAL time is advance(); waiting on real async I/O (a unix socket round
 * trip, a port-0 fetch) is `until()` from ./wait.ts, which is the only file
 * allowed to sleep.
 */

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
};

export type ManualClock = Clock & {
  /** Move logical time forward, firing every timer that falls due IN ORDER and
   *  draining microtasks between each, so a callback that schedules another
   *  timer inside the same window still fires inside the same window. */
  advance(ms: number): Promise<void>;
  /** Let pending promises settle without moving time at all. */
  tick(): Promise<void>;
  /** Jump the clock without firing anything: a machine that slept, or an NTP
   *  step. What a lease's staleness rule has to survive. */
  setNow(ms: number): void;
  /** How many timers are still armed. A leak check for resetForTest(). */
  readonly pending: number;
};

type Armed = {
  id: number;
  at: number;
  every: number | null; // interval period, or null for a one-shot
  fn: () => void;
  seq: number; // arm order, the tiebreak for two timers due at the same ms
};

/* A DETERMINISTIC CLOCK, not an approximate one. Timers fire in (dueTime, arm
 * order) order, which is the order the real event loop fires them in, and
 * advance() walks to each due timer's own timestamp before running it, so a
 * callback that reads now() sees the time it was scheduled for rather than the
 * end of the window. That is what makes "the batch window closed at the
 * boundary" assertable. */
export function manualClock(startMs = 1_700_000_000_000): ManualClock {
  let now = startMs;
  let nextId = 1;
  let seq = 0;
  const armed = new Map<number, Armed>();

  const arm = (fn: () => void, ms: number, every: number | null): number => {
    const id = nextId++;
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    armed.set(id, { id, at: now + delay, every, fn, seq: seq++ });
    return id;
  };

  const drain = async () => {
    // four turns is enough for a chain of awaits inside one callback; cheap
    // enough to do unconditionally
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };

  return {
    now: () => now,
    setTimeout: (fn, ms) => arm(fn, ms, null),
    clearTimeout: (t) => { armed.delete(Number(t)); },
    setInterval: (fn, ms) => arm(fn, ms, Number.isFinite(ms) && ms > 0 ? ms : 1),
    clearInterval: (t) => { armed.delete(Number(t)); },

    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let due: Armed | null = null;
        for (const t of armed.values()) {
          if (t.at > target) continue;
          if (!due || t.at < due.at || (t.at === due.at && t.seq < due.seq)) due = t;
        }
        if (!due) break;
        now = Math.max(now, due.at);
        if (due.every == null) armed.delete(due.id);
        else { due.at = now + due.every; due.seq = seq++; }
        try { due.fn(); } catch (e) { console.error("[manualClock] timer threw:", e); }
        await drain();
      }
      now = target;
      await drain();
    },

    async tick() { await drain(); },

    setNow(ms: number) { now = ms; },

    get pending() { return armed.size; },
  };
}
