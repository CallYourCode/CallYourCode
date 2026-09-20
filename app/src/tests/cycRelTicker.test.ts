import {describe, expect, test} from 'vitest';
import {createRelTicker, type TickConsumer} from '../shared/relTicker';

// The one shared relative-time ticker: it runs at the coarsest period any
// consumer needs (1 s only while a sub-minute label shows, else 60 s), pauses
// entirely while hidden and catches labels up on the way back, and paints a
// consumer only when its own value changes.

type Harness = {
  ticker: ReturnType<typeof createRelTicker>;
  setNow(t: number): void;
  setHidden(h: boolean): void;
  visibility(): void;
  scheduled(): number; // the ms the live interval was scheduled at, or 0
};

function harness(): Harness {
  let now = 0;
  let hidden = false;
  let visCb: (() => void) | null = null;
  let interval: {ms: number} | null = null;
  const ticker = createRelTicker({
    now: () => now,
    isHidden: () => hidden,
    setInterval: (_fn, ms) => {
      interval = {ms};
      return 1;
    },
    clearInterval: () => {
      interval = null;
    },
    onVisibilityChange: (cb) => {
      visCb = cb;
      return () => {
        visCb = null;
      };
    }
  });
  return {
    ticker,
    setNow: (t) => {
      now = t;
    },
    setHidden: (h) => {
      hidden = h;
    },
    visibility: () => visCb?.(),
    scheduled: () => interval?.ms ?? 0
  };
}

function counter(value: (now: number) => string, needsSeconds?: (now: number) => boolean) {
  let paints = 0;
  const consumer: TickConsumer = {
    value,
    needsSeconds,
    paint: () => {
      paints++;
    }
  };
  return {consumer, paints: () => paints};
}

describe('relTicker', () => {
  test('idle with only minute-scale consumers runs at 60 s', () => {
    const h = harness();
    const c = counter((n) => String(Math.floor(n / 60_000)));
    h.ticker.register(c.consumer);
    expect(h.ticker.period()).toBe(60_000);
    expect(h.scheduled()).toBe(60_000);
  });

  test('a sub-minute label pulls the whole ticker to 1 s, then it relaxes back', () => {
    const h = harness();
    let secondsMode = true;
    const c = counter(
      (n) => (secondsMode ? String(Math.floor(n / 1000)) : String(Math.floor(n / 60_000))),
      () => secondsMode
    );
    h.ticker.register(c.consumer);
    expect(h.ticker.period()).toBe(1000);

    // The run crosses a minute: needsSeconds goes false, and the next tick
    // relaxes the cadence to 60 s.
    secondsMode = false;
    h.setNow(61_000);
    h.ticker.tick();
    expect(h.ticker.period()).toBe(60_000);
  });

  test('paints only when the value changes', () => {
    const h = harness();
    const c = counter((n) => String(Math.floor(n / 60_000)));
    h.ticker.register(c.consumer);
    expect(c.paints()).toBe(0); // registration seeds, never paints

    h.setNow(30_000); // same minute
    h.ticker.tick();
    expect(c.paints()).toBe(0);

    h.setNow(60_000); // new minute
    h.ticker.tick();
    expect(c.paints()).toBe(1);

    h.setNow(90_000); // same minute again
    h.ticker.tick();
    expect(c.paints()).toBe(1);
  });

  test('pauses while hidden and catches up on the way back', () => {
    const h = harness();
    const c = counter((n) => String(Math.floor(n / 60_000)));
    h.ticker.register(c.consumer);
    expect(h.ticker.period()).toBe(60_000);

    h.setHidden(true);
    h.visibility();
    expect(h.ticker.period()).toBe(0);
    expect(h.scheduled()).toBe(0);

    // Time passes while hidden; no tick fires (the interval is gone).
    h.setNow(120_000);
    // Back to visible: one catch-up paint, and the cadence restarts.
    h.setHidden(false);
    h.visibility();
    expect(c.paints()).toBe(1);
    expect(h.ticker.period()).toBe(60_000);
  });

  test('mixed consumers: the seconds one sets the period; unregister relaxes it', () => {
    const h = harness();
    const minutes = counter((n) => String(Math.floor(n / 60_000)));
    let running = true;
    const seconds = counter(
      (n) => (running ? String(Math.floor(n / 1000)) : 'done'),
      () => running
    );
    h.ticker.register(minutes.consumer);
    const offSeconds = h.ticker.register(seconds.consumer);
    expect(h.ticker.period()).toBe(1000);

    // The seconds consumer leaves; only minute-scale work remains.
    offSeconds();
    expect(h.ticker.period()).toBe(60_000);
    expect(h.ticker.size()).toBe(1);
    running = false;
  });

  test('empty ticker schedules nothing', () => {
    const h = harness();
    const c = counter((n) => String(n));
    const off = h.ticker.register(c.consumer);
    off();
    expect(h.ticker.period()).toBe(0);
    expect(h.ticker.size()).toBe(0);
  });
});
