// Semantics of the shared gesture wrapper (features/gestures.ts), driven through
// the real @use-gesture recogniser with synthetic pointer sequences. These pin
// the behaviour the old hand-rolled detection got wrong on the live rig:
//   - a partial (below-threshold) edge back-swipe must SNAP BACK, not commit;
//   - a full swipe commits; a fast flick commits early;
//   - a vertical-first drag is NEVER captured (native scroll proceeds);
//   - a mostly-vertical drag with slight horizontal drift stays a scroll.
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {onHorizontalSwipe, type HorizontalSwipeOptions} from '@/features/gestures';

const WIDTH = 400;

function stubRect(el: HTMLElement, left: number, right: number) {
  el.getBoundingClientRect = () =>
    ({
      left,
      right,
      top: 0,
      bottom: 800,
      width: right - left,
      height: 800,
      x: left,
      y: 0,
      toJSON() {}
    }) as DOMRect;
}

interface Step {
  x: number;
  y: number;
  t: number;
}

// jsdom advertises touch but not pointer support, so @use-gesture binds touch
// events here (it binds pointer events in a real browser through the same
// wrapper). jsdom has TouchEvent but no Touch constructor, so we hand it plain
// touch-shaped objects, plus a controlled timeStamp for deterministic velocity.
function tev(type: string, target: HTMLElement, s: Step): TouchEvent {
  const touch = {identifier: 1, target, clientX: s.x, clientY: s.y} as unknown as Touch;
  const ending = type === 'touchend' || type === 'touchcancel';
  const live = ending ? [] : [touch];
  const e = new TouchEvent(type, {
    touches: live,
    targetTouches: live,
    changedTouches: [touch],
    bubbles: true,
    cancelable: true
  });
  Object.defineProperty(e, 'timeStamp', {value: s.t, configurable: true});
  return e;
}

// Drive a whole gesture: start on the target, moves + end on the window (the
// wrapper delegates move/end tracking to the window). Returns whether any move
// had its default prevented (i.e. the wrapper captured the drag).
function drive(target: HTMLElement, down: Step, moves: Step[], up: Step): boolean {
  target.dispatchEvent(tev('touchstart', target, down));
  let prevented = false;
  for (const m of moves) {
    const e = tev('touchmove', target, m);
    window.dispatchEvent(e);
    if (e.defaultPrevented) prevented = true;
  }
  window.dispatchEvent(tev('touchend', target, up));
  return prevented;
}

interface Recorder {
  progress: number;
  commit: {dir: -1 | 1; flick: boolean} | null;
  cancelled: number;
  opts: HorizontalSwipeOptions;
}

function recorder(over: Partial<HorizontalSwipeOptions> = {}): Recorder {
  const rec: Recorder = {
    progress: 0,
    commit: null,
    cancelled: 0,
    opts: {} as HorizontalSwipeOptions
  };
  rec.opts = {
    thresholdPct: 0.5,
    velocityCommit: 0.5,
    travelWidth: () => WIDTH,
    onProgress: () => {
      rec.progress++;
    },
    onCommit: (c) => {
      rec.commit = {dir: c.dir, flick: c.flick};
    },
    onCancel: () => {
      rec.cancelled++;
    },
    ...over
  };
  return rec;
}

let target: HTMLElement;
let dispose: (() => void) | null = null;

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  stubRect(target, 0, WIDTH);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  target.remove();
});

describe('onHorizontalSwipe: commit rule', () => {
  it('snaps back a partial (~25%) edge back-swipe below the threshold', () => {
    const rec = recorder({edge: 'left'});
    dispose = onHorizontalSwipe(target, rec.opts);
    // Start at the left edge, release after ~25% of the width, slowly.
    const captured = drive(
      target,
      {x: 10, y: 100, t: 0},
      [
        {x: 60, y: 100, t: 120},
        {x: 110, y: 100, t: 240}
      ],
      {x: 110, y: 100, t: 360}
    );
    expect(captured).toBe(true);
    expect(rec.commit).toBeNull();
    expect(rec.cancelled).toBe(1);
    expect(rec.progress).toBeGreaterThan(0);
  });

  it('commits a full swipe past the threshold', () => {
    const rec = recorder({edge: 'left'});
    dispose = onHorizontalSwipe(target, rec.opts);
    const captured = drive(
      target,
      {x: 10, y: 100, t: 0},
      [
        {x: 140, y: 100, t: 120},
        {x: 260, y: 100, t: 240}
      ],
      {x: 260, y: 100, t: 400}
    );
    expect(captured).toBe(true);
    expect(rec.commit).toEqual({dir: 1, flick: false});
    expect(rec.cancelled).toBe(0);
  });

  it('commits early on a fast flick even below the distance threshold', () => {
    const rec = recorder({edge: 'left'});
    dispose = onHorizontalSwipe(target, rec.opts);
    // Only ~20% of the width travelled, but the last move is fast (50px / 10ms)
    // and the release is immediate, so the recogniser flags a swipe.
    const captured = drive(
      target,
      {x: 10, y: 100, t: 0},
      [
        {x: 40, y: 100, t: 200},
        {x: 90, y: 100, t: 210}
      ],
      {x: 90, y: 100, t: 214}
    );
    expect(captured).toBe(true);
    expect(rec.commit).toEqual({dir: 1, flick: true});
    expect(rec.cancelled).toBe(0);
  });
});

describe('onHorizontalSwipe: axis intent', () => {
  it('never captures a vertical-first drag (native scroll proceeds)', () => {
    const rec = recorder();
    dispose = onHorizontalSwipe(target, rec.opts);
    const captured = drive(
      target,
      {x: 200, y: 100, t: 0},
      [
        {x: 205, y: 220, t: 100},
        {x: 208, y: 340, t: 200}
      ],
      {x: 208, y: 340, t: 300}
    );
    expect(captured).toBe(false);
    expect(rec.progress).toBe(0);
    expect(rec.commit).toBeNull();
    expect(rec.cancelled).toBe(0);
  });

  it('leaves a mostly-vertical drag with slight horizontal drift scrolling', () => {
    const rec = recorder();
    dispose = onHorizontalSwipe(target, rec.opts);
    const captured = drive(
      target,
      {x: 200, y: 100, t: 0},
      [
        {x: 214, y: 200, t: 100},
        {x: 226, y: 320, t: 200}
      ],
      {x: 226, y: 320, t: 300}
    );
    expect(captured).toBe(false);
    expect(rec.progress).toBe(0);
    expect(rec.commit).toBeNull();
    expect(rec.cancelled).toBe(0);
  });

  it('captures a predominantly horizontal drag', () => {
    const rec = recorder();
    dispose = onHorizontalSwipe(target, rec.opts);
    const captured = drive(
      target,
      {x: 200, y: 100, t: 0},
      [
        {x: 320, y: 110, t: 100},
        {x: 420, y: 118, t: 200}
      ],
      {x: 420, y: 118, t: 360}
    );
    expect(captured).toBe(true);
    expect(rec.commit).toEqual({dir: 1, flick: false});
  });
});

describe('onHorizontalSwipe: edge gating', () => {
  it('ignores a rightward drag that did not start near the left edge', () => {
    const rec = recorder({edge: 'left'});
    dispose = onHorizontalSwipe(target, rec.opts);
    const captured = drive(
      target,
      {x: 200, y: 100, t: 0},
      [
        {x: 330, y: 100, t: 120},
        {x: 440, y: 100, t: 240}
      ],
      {x: 440, y: 100, t: 400}
    );
    expect(captured).toBe(false);
    expect(rec.progress).toBe(0);
    expect(rec.commit).toBeNull();
    expect(rec.cancelled).toBe(0);
  });
});

describe('onHorizontalSwipe: direction filter', () => {
  it('leaves the opposite direction untouched for a sibling handler', () => {
    const rec = recorder({direction: 1});
    dispose = onHorizontalSwipe(target, rec.opts);
    // Drag left: a direction:1 handler must not touch it.
    const captured = drive(
      target,
      {x: 300, y: 100, t: 0},
      [
        {x: 180, y: 100, t: 120},
        {x: 60, y: 100, t: 240}
      ],
      {x: 60, y: 100, t: 400}
    );
    expect(captured).toBe(false);
    expect(rec.progress).toBe(0);
    expect(rec.commit).toBeNull();
    expect(rec.cancelled).toBe(0);
  });
});
