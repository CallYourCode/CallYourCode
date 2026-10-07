// The field log for the iPhone "image tap opened nothing / swipes broke" report:
// the swipe.* lines from the gesture wrapper (one start, one end per gesture; the
// reason a drag was left alone) and the tap.media.* lines from the chat's media
// tap trace. Logging only: the callbacks the wrapper fires are pinned unchanged.
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

const logged: {event: string; fields: Record<string, unknown>}[] = [];
vi.mock('@/shared/logging', async (orig) => ({
  ...(await orig<typeof import('@/shared/logging')>()),
  cyclog: (event: string, fields: Record<string, unknown> = {}) => {
    logged.push({event, fields});
  }
}));

import {onHorizontalSwipe, type HorizontalSwipeOptions} from '@/features/gestures';
import {installMediaTapTrace} from '@/features/chat/surface/mediaTapTrace';

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

// jsdom has no pointer events, so the recogniser binds touch here (as in
// cycGestureSwipe.test.ts); plain touch-shaped objects and a fixed timeStamp.
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

function drive(target: HTMLElement, down: Step, moves: Step[], up: Step | null, end = 'touchend') {
  target.dispatchEvent(tev('touchstart', target, down));
  for (const m of moves) window.dispatchEvent(tev('touchmove', target, m));
  if (up) window.dispatchEvent(tev(end, target, up));
}

// jsdom has no PointerEvent: a MouseEvent carrying the pointer's type.
function pev(type: string, x: number, y: number, pointerType = 'touch'): MouseEvent {
  const e = new MouseEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y});
  Object.defineProperty(e, 'pointerType', {value: pointerType});
  return e;
}

const lines = (event: string) => logged.filter((l) => l.event === event).map((l) => l.fields);
const names = () => logged.map((l) => l.event);
// The formatted payload (`k=v ...`), as cyclog would write it, stays short.
const payload = (fields: Record<string, unknown>) =>
  Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');

function opts(over: Partial<HorizontalSwipeOptions> = {}) {
  const calls = {progress: 0, commit: 0, cancel: 0};
  const o: HorizontalSwipeOptions = {
    name: 'test-surface',
    thresholdPct: 0.5,
    velocityCommit: 0.5,
    travelWidth: () => WIDTH,
    onProgress: () => {
      calls.progress++;
    },
    onCommit: () => {
      calls.commit++;
    },
    onCancel: () => {
      calls.cancel++;
    },
    ...over
  };
  return {o, calls};
}

let target: HTMLElement;
let dispose: (() => void) | null = null;

beforeEach(() => {
  logged.length = 0;
  target = document.createElement('div');
  document.body.appendChild(target);
  stubRect(target, 0, WIDTH);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  target.remove();
  vi.useRealTimers();
});

describe('swipe.* log lines', () => {
  it('logs one swipe.start and one swipe.commit for a full edge swipe', () => {
    const {o, calls} = opts({edge: 'left'});
    dispose = onHorizontalSwipe(target, o);
    drive(
      target,
      {x: 10, y: 100, t: 0},
      [
        {x: 140, y: 100, t: 120},
        {x: 200, y: 100, t: 180},
        {x: 260, y: 100, t: 240}
      ],
      {x: 260, y: 100, t: 400}
    );
    expect(names()).toEqual(['swipe.start', 'swipe.commit']);
    expect(lines('swipe.start')[0]).toMatchObject({s: 'test-surface', dir: 1, x0: 10, pt: 'touch'});
    expect(lines('swipe.commit')[0]).toMatchObject({
      s: 'test-surface',
      dir: 1,
      flick: 0,
      ev: 'touchend'
    });
    expect(calls).toMatchObject({commit: 1, cancel: 0});
  });

  it('names a release below the threshold reason=short', () => {
    const {o, calls} = opts({edge: 'left'});
    dispose = onHorizontalSwipe(target, o);
    drive(
      target,
      {x: 10, y: 100, t: 0},
      [
        {x: 60, y: 100, t: 120},
        {x: 110, y: 100, t: 240}
      ],
      {x: 110, y: 100, t: 360}
    );
    expect(names()).toEqual(['swipe.start', 'swipe.cancel']);
    expect(lines('swipe.cancel')[0]).toMatchObject({reason: 'short', pct: 0.22});
    expect(calls.cancel).toBe(1);
  });

  it('names a drag the browser cancelled by its cancel event', () => {
    const {o, calls} = opts({edge: 'left'});
    dispose = onHorizontalSwipe(target, o);
    // Slow enough (past the flick window) that the cancel cannot read as a flick.
    drive(
      target,
      {x: 10, y: 100, t: 0},
      [{x: 80, y: 100, t: 400}],
      {x: 80, y: 100, t: 500},
      'touchcancel'
    );
    expect(lines('swipe.cancel')[0]).toMatchObject({reason: 'touchcancel', ev: 'touchcancel'});
    expect(calls.cancel).toBe(1);
  });

  it('logs a taken drag that came back past its origin as reversed (no callback, as before)', () => {
    const {o, calls} = opts({edge: 'left', direction: 1});
    dispose = onHorizontalSwipe(target, o);
    drive(
      target,
      {x: 20, y: 100, t: 0},
      [
        {x: 80, y: 100, t: 100},
        {x: 5, y: 100, t: 200}
      ],
      {x: 5, y: 100, t: 300}
    );
    expect(names()).toEqual(['swipe.start', 'swipe.cancel']);
    expect(lines('swipe.cancel')[0]).toMatchObject({reason: 'reversed'});
    expect(calls).toMatchObject({commit: 0, cancel: 0});
    expect(calls.progress).toBeGreaterThan(0);
  });

  it('names an off-edge start, a veto and a vertical drag, folding repeats into sup', () => {
    const {o} = opts({edge: 'left'});
    dispose = onHorizontalSwipe(target, o);
    const mid = () =>
      drive(target, {x: 200, y: 100, t: 0}, [{x: 330, y: 100, t: 120}], {x: 330, y: 100, t: 300});
    mid();
    mid();
    expect(lines('swipe.cancel')).toEqual([
      {s: 'test-surface', reason: 'off-edge', x0: 200, sup: undefined}
    ]);
    dispose();

    logged.length = 0;
    let veto = true;
    dispose = onHorizontalSwipe(target, opts({canStart: () => !veto}).o);
    drive(target, {x: 200, y: 100, t: 0}, [{x: 330, y: 100, t: 120}], {x: 330, y: 100, t: 300});
    expect(lines('swipe.cancel')[0]).toMatchObject({reason: 'veto', x0: 200});
    veto = false;
    const vertical = () =>
      drive(target, {x: 200, y: 100, t: 0}, [{x: 204, y: 260, t: 120}], {x: 204, y: 260, t: 300});
    vertical();
    vertical();
    vertical();
    expect(lines('swipe.cancel').map((f) => f.reason)).toEqual(['veto', 'vertical']);
    // The two suppressed verticals ride on the next quiet line.
    veto = true;
    drive(target, {x: 200, y: 100, t: 0}, [{x: 330, y: 100, t: 120}], {x: 330, y: 100, t: 300});
    expect(lines('swipe.cancel').at(-1)).toMatchObject({reason: 'veto', sup: 2});
  });

  it('logs swipe.stuck once when a new press finds the previous one still held', () => {
    const {o} = opts();
    dispose = onHorizontalSwipe(target, o);
    drive(target, {x: 100, y: 100, t: 0}, [{x: 200, y: 100, t: 120}], null);
    expect(names()).toEqual(['swipe.start']);
    target.dispatchEvent(new Event('pointerdown'));
    target.dispatchEvent(new Event('pointerdown'));
    // The probe reads the held press once per episode.
    expect(lines('swipe.stuck')).toEqual([{s: 'test-surface', ids: 0}]);
    drive(target, {x: 100, y: 100, t: 1000}, [{x: 300, y: 100, t: 1100}], {
      x: 300,
      y: 100,
      t: 1200
    });
    // The held drag carries on and ends with its own line.
    expect(names()).toEqual(['swipe.start', 'swipe.stuck', 'swipe.commit']);
  });

  it('keeps every swipe payload under 200 chars', () => {
    const {o} = opts({name: 'chat-back', edge: 'left'});
    dispose = onHorizontalSwipe(target, o);
    drive(target, {x: 10, y: 100, t: 0}, [{x: 90, y: 100, t: 120}], {x: 90, y: 100, t: 300});
    drive(target, {x: 200, y: 100, t: 0}, [{x: 330, y: 100, t: 120}], {x: 330, y: 100, t: 300});
    expect(logged.length).toBeGreaterThan(2);
    for (const l of logged) expect(payload(l.fields).length).toBeLessThan(200);
  });
});

describe('tap.media.* log lines', () => {
  let columns: HTMLElement;
  let root: HTMLElement;
  let scroller: HTMLElement;
  let media: HTMLElement;
  let img: HTMLImageElement;
  let opened = 0;
  let untrace: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    opened = 0;
    columns = document.createElement('div');
    columns.dataset.view = 'chat';
    root = document.createElement('div');
    root.className = 'cyc-message-list absolute z-[1]';
    scroller = document.createElement('div');
    scroller.className = 'cyc-message-list-scroll';
    const message = document.createElement('div');
    message.className = 'cyc-message';
    media = document.createElement('div');
    media.className = 'cyc-annex cyc-media-box block! relative bg-[#000]!';
    img = document.createElement('img');
    img.className = 'cyc-still static! block w-full';
    media.append(img);
    media.addEventListener('click', () => opened++);
    message.append(media);
    scroller.append(message);
    root.append(scroller);
    columns.append(root);
    document.body.append(columns);
    stubRect(scroller, 0, WIDTH);
    untrace = installMediaTapTrace(root);
  });

  afterEach(() => {
    untrace();
    columns.remove();
  });

  it('logs the press and the click that reached the media', () => {
    img.dispatchEvent(pev('pointerdown', 100, 100));
    img.dispatchEvent(pev('click', 100, 100));
    vi.advanceTimersByTime(1000);
    expect(opened).toBe(1);
    expect(names()).toEqual(['tap.media', 'tap.media']);
    expect(lines('tap.media')[0]).toMatchObject({
      ph: 'down',
      tgt: 'img.cyc-still',
      pt: 'touch',
      dp: 0,
      view: 'chat',
      open: 'img-wait'
    });
    expect(lines('tap.media')[1]).toMatchObject({
      ph: 'click',
      tgt: 'img.cyc-still',
      dp: 0,
      reached: 1,
      onmedia: 1,
      mv: 0
    });
    for (const l of logged) expect(payload(l.fields).length).toBeLessThan(200);
  });

  it('shows a click the swipe recogniser filtered (a tap that drifted 6px) as dp=1 reached=0', () => {
    dispose = onHorizontalSwipe(scroller, opts({name: 'chat-next', direction: -1}).o);
    img.dispatchEvent(pev('pointerdown', 100, 100));
    img.dispatchEvent(tev('touchstart', img, {x: 100, y: 100, t: 0}));
    window.dispatchEvent(pev('pointermove', 106, 100));
    window.dispatchEvent(tev('touchmove', img, {x: 106, y: 100, t: 60}));
    window.dispatchEvent(tev('touchend', img, {x: 106, y: 100, t: 120}));
    const click = new MouseEvent('click', {bubbles: true, cancelable: true, detail: 1});
    img.dispatchEvent(click);
    vi.advanceTimersByTime(1000);
    expect(opened).toBe(0);
    expect(lines('tap.media')[1]).toMatchObject({ph: 'click', dp: 1, reached: 0, mv: 6, det: 1});
    expect(lines('tap.media.noclick')).toEqual([]);
  });

  it('logs tap.media.noclick with pointercancel and travel when no click follows', () => {
    img.dispatchEvent(pev('pointerdown', 100, 100));
    window.dispatchEvent(pev('pointermove', 100, 124));
    window.dispatchEvent(pev('pointercancel', 100, 124));
    vi.advanceTimersByTime(699);
    expect(lines('tap.media.noclick')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(lines('tap.media.noclick')).toEqual([
      {tgt: 'img.cyc-still', pcancel: 1, mv: 24, tend: 'none', view: 'chat'}
    ]);
  });

  it('ignores presses and clicks off message media', () => {
    scroller.dispatchEvent(pev('pointerdown', 100, 100));
    scroller.dispatchEvent(pev('click', 100, 100));
    vi.advanceTimersByTime(1000);
    expect(logged).toEqual([]);
  });
});
