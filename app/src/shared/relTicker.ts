// One shared ticker for every relative-time label on screen (the list row
// ages, the usage "Nm ago", the agents-bar "Ns"/"Nm" elapsed). Instead of each
// surface owning its own setInterval, they register a consumer here. The ticker
// runs at the coarsest period any consumer needs -- 1 s only while a sub-minute
// ("Ns") label is showing, otherwise 60 s -- and pauses entirely while the tab
// is hidden, catching every label up on the way back to visible. A consumer is
// painted only when its own value() changes, so an unchanged minute costs no
// DOM write.

export interface TickConsumer {
  // A token describing what this consumer would render now. The ticker paints
  // only when it changes, so a steady label writes nothing.
  value(now: number): string;
  // Update the text node(s) for the new value. Called only on a real change.
  paint(now: number): void;
  // True while this consumer is showing a sub-minute label and so wants the
  // 1 s cadence. Absent means it is always minute-scale.
  needsSeconds?(now: number): boolean;
}

export interface RelTickerOptions {
  now?: () => number;
  isHidden?: () => boolean;
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
  onVisibilityChange?: (cb: () => void) => () => void;
  minuteMs?: number;
  secondMs?: number;
}

export interface RelTicker {
  register(consumer: TickConsumer): () => void;
  // The live interval in ms: 0 when paused (hidden) or with nothing to tick.
  period(): number;
  // Run one tick immediately (the ticker uses this internally; tests call it).
  tick(): void;
  stop(): void;
  size(): number;
}

const defaultVisibility = (cb: () => void): (() => void) => {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
};

export function createRelTicker(opts: RelTickerOptions = {}): RelTicker {
  const now = opts.now ?? (() => Date.now());
  const isHidden = opts.isHidden ?? (() => (typeof document !== 'undefined' ? document.hidden : false));
  const schedule = opts.setInterval ?? ((fn, ms) => window.setInterval(fn, ms) as unknown as number);
  const cancel = opts.clearInterval ?? ((id) => window.clearInterval(id));
  const onVisibility = opts.onVisibilityChange ?? defaultVisibility;
  const MINUTE = opts.minuteMs ?? 60_000;
  const SECOND = opts.secondMs ?? 1_000;

  const consumers = new Set<TickConsumer>();
  const last = new Map<TickConsumer, string>();
  let timer: number | null = null;
  let currentPeriod = 0;

  function desiredPeriod(t: number): number {
    if (!consumers.size || isHidden()) return 0;
    for (const c of consumers) {
      if (c.needsSeconds?.(t)) return SECOND;
    }
    return MINUTE;
  }

  function reschedule(): void {
    const p = desiredPeriod(now());
    if (p === currentPeriod) return;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    currentPeriod = p;
    if (p > 0) timer = schedule(tick, p);
  }

  function tick(): void {
    const t = now();
    for (const c of consumers) {
      const v = c.value(t);
      if (last.get(c) !== v) {
        last.set(c, v);
        c.paint(t);
      }
    }
    // A value change can flip a consumer between the 1 s and 60 s cadence.
    reschedule();
  }

  const offVisibility = onVisibility(() => {
    // Coming back visible, labels may have advanced while paused: catch them up
    // before restarting the cadence.
    if (!isHidden()) tick();
    else reschedule();
  });

  return {
    register(consumer: TickConsumer) {
      consumers.add(consumer);
      // Seed the last value without painting: the surface was just rendered
      // with the right label, so registration itself must not repaint it.
      last.set(consumer, consumer.value(now()));
      reschedule();
      return () => {
        consumers.delete(consumer);
        last.delete(consumer);
        reschedule();
      };
    },
    period: () => currentPeriod,
    tick,
    stop() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      currentPeriod = 0;
      offVisibility();
      consumers.clear();
      last.clear();
    },
    size: () => consumers.size
  };
}

// The app's single shared ticker. Created lazily so a non-browser import (a
// unit test that only wants createRelTicker) never touches document.
let shared: RelTicker | null = null;
export function relTicker(): RelTicker {
  if (!shared) shared = createRelTicker();
  return shared;
}
