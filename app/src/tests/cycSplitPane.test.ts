import {afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';
import {
  createSplitPane,
  clampSplit,
  readSplit,
  writeSplit,
  SPLIT_MIN,
  SPLIT_MAX,
  PHONE_MAX,
  LAPTOP_MIN,
  RAIL_PHONE,
  RAIL_WIDE,
  type SplitPane
} from '../plugins/files/splitPane';
import {SWIPE_FLICK_MIN_PX} from '../plugins/files/splitPane';
import {
  createSplitPane as createGitSplitPane,
  SWIPE_FLICK_MIN_PX as GIT_SWIPE_FLICK_MIN_PX
} from '../plugins/git/splitPane';

beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  (globalThis as any).DOMMatrixReadOnly = class {
    m41: number;
    constructor(transform: string) {
      const m = /translateX\((-?[\d.]+)px\)/.exec(transform || '');
      this.m41 = m ? parseFloat(m[1]) : 0;
    }
  };

  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    (el: Element) => ({transform: (el as HTMLElement).style.transform}) as CSSStyleDeclaration
  );
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks?.();

  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    (el: Element) => ({transform: (el as HTMLElement).style.transform}) as CSSStyleDeclaration
  );
});
function overlayOfWidth(w: number): HTMLElement {
  const overlay = document.createElement('div');
  Object.defineProperty(overlay, 'clientWidth', {get: () => w, configurable: true});
  overlay.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: w,
      bottom: 100,
      width: w,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }) as DOMRect;
  document.body.append(overlay);
  return overlay;
}
function build(
  w: number,
  opts: Partial<Parameters<typeof createSplitPane>[1]> = {}
): {overlay: HTMLElement; pane: SplitPane} {
  const overlay = overlayOfWidth(w);
  const pane = createSplitPane(overlay, {
    storageKey: 'cyc-test-split',
    splitTablet: 0.4,
    splitLaptop: 0.3,
    railLabelA: 'Session',
    railLabelB: 'No thing',
    ...opts
  });
  return {overlay, pane};
}
const touchEvent = (type: string, x: number, y: number) => {
  const e = new Event(type, {bubbles: true, cancelable: true}) as any;
  e.touches = [{clientX: x, clientY: y}];
  return e as TouchEvent;
};
const pointerEvent = (type: string, x: number, id = 1) => {
  const e = new Event(type, {bubbles: true, cancelable: true}) as any;
  e.pointerId = id;
  e.clientX = x;
  e.clientY = 50;
  return e as PointerEvent;
};

describe('clampSplit', () => {
  test('passes an in-range value through', () => {
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(SPLIT_MIN)).toBe(SPLIT_MIN);
    expect(clampSplit(SPLIT_MAX)).toBe(SPLIT_MAX);
  });
  test('clamps both ends', () => {
    expect(clampSplit(-2)).toBe(SPLIT_MIN);
    expect(clampSplit(0.01)).toBe(SPLIT_MIN);
    expect(clampSplit(0.99)).toBe(SPLIT_MAX);
    expect(clampSplit(7)).toBe(SPLIT_MAX);
  });
});
describe('split persistence', () => {
  test('round-trips per layout slot under one key', () => {
    writeSplit('k1', false, 0.33);
    writeSplit('k1', true, 0.22);
    expect(readSplit('k1', false)).toBe(0.33);
    expect(readSplit('k1', true)).toBe(0.22);

    writeSplit('k1', false, 0.44);
    expect(readSplit('k1', false)).toBe(0.44);
    expect(readSplit('k1', true)).toBe(0.22);
  });
  test('two keys never read each other', () => {
    writeSplit('cyc-fx-split', false, 0.27);
    writeSplit('cyc-gt-split', false, 0.42);
    expect(readSplit('cyc-fx-split', false)).toBe(0.27);
    expect(readSplit('cyc-gt-split', false)).toBe(0.42);
    expect(readSplit('cyc-cx-split', false)).toBeNull();
  });
  test('refuses an out-of-range or malformed stored value', () => {
    localStorage.setItem('k2', JSON.stringify({tablet: 0.05, laptop: '0.5'}));
    expect(readSplit('k2', false)).toBeNull();
    expect(readSplit('k2', true)).toBeNull();
    localStorage.setItem('k3', 'not json at all');
    expect(readSplit('k3', false)).toBeNull();
  });
});

describe('layout geometry', () => {
  test('phone: full-width panels either side of the thick rail', () => {
    const {overlay, pane} = build(500);
    pane.applyLayout();
    expect(overlay.classList.contains('cyc-fx-phone')).toBe(true);
    expect(pane.isWide()).toBe(false);
    const panelW = 500 - RAIL_PHONE;
    expect(pane.paneA.style.width).toBe(`${panelW}px`);
    expect(pane.paneB.style.width).toBe(`${panelW}px`);
    expect(pane.track.style.width).toBe(`${panelW * 2 + RAIL_PHONE}px`);
    expect(pane.rail.style.width).toBe(`${RAIL_PHONE}px`);
  });
  test('wide: the tablet default split decides the two widths', () => {
    const {overlay, pane} = build(1000);
    pane.restoreSplit();
    expect(overlay.classList.contains('cyc-fx-wide')).toBe(true);
    expect(pane.isWide()).toBe(true);
    const aW = Math.round((1000 - RAIL_WIDE) * 0.4);
    expect(pane.paneA.style.width).toBe(`${aW}px`);
    expect(pane.paneB.style.width).toBe(`${1000 - RAIL_WIDE - aW}px`);
    expect(pane.rail.style.width).toBe(`${RAIL_WIDE}px`);
  });
  test('restoreSplit prefers the remembered split for the layout it is in', () => {
    writeSplit('cyc-test-split', true, 0.5);
    expect(1200 >= LAPTOP_MIN).toBe(true);
    const {pane} = build(1200);
    pane.restoreSplit();
    const aW = Math.round((1200 - RAIL_WIDE) * 0.5);
    expect(pane.paneA.style.width).toBe(`${aW}px`);

    expect(pane.railA.classList.contains('cyc-fx-rail-on')).toBe(true);
    expect(pane.track.style.transform).toBe('translateX(0)');
  });
  test('the boundary is PHONE_MAX exactly', () => {
    const {overlay, pane} = build(PHONE_MAX);
    pane.applyLayout();
    expect(overlay.classList.contains('cyc-fx-wide')).toBe(true);
  });
});
describe('showSide', () => {
  test('marks the overlay and the rail halves, and slides on the phone', () => {
    const {overlay, pane} = build(500);
    pane.restoreSplit();
    const panelW = 500 - RAIL_PHONE;
    pane.showSide('b');
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(true);
    expect(pane.railB.classList.contains('cyc-fx-rail-on')).toBe(true);
    expect(pane.railA.classList.contains('cyc-fx-rail-on')).toBe(false);
    expect(pane.track.style.transform).toBe(`translateX(${-panelW}px)`);
    pane.showSide('a');
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(false);
    expect(pane.track.style.transform).toBe('translateX(0px)');
  });
  test('rail halves are tap targets on the phone', () => {
    const {overlay, pane} = build(500);
    pane.restoreSplit();
    pane.railB.dispatchEvent(new Event('click', {bubbles: true}));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(true);
    pane.railA.dispatchEvent(new Event('click', {bubbles: true}));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(false);
  });
});

describe('the phone swipe', () => {
  let now = 100_000;
  beforeEach(() => {
    now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  test('a long slow drag commits to the other side', () => {
    const {overlay, pane} = build(500);
    pane.restoreSplit();
    const panelW = 500 - RAIL_PHONE;
    pane.track.dispatchEvent(touchEvent('touchstart', 400, 100));
    pane.track.dispatchEvent(touchEvent('touchmove', 100, 100));
    expect(pane.track.style.transform).toBe('translateX(-300px)');
    now += 1000;
    pane.track.dispatchEvent(touchEvent('touchend', 100, 100));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(true);
    expect(pane.track.style.transform).toBe(`translateX(${-panelW}px)`);
  });
  test('a short slow drag springs back', () => {
    const {overlay, pane} = build(500);
    pane.restoreSplit();
    pane.track.dispatchEvent(touchEvent('touchstart', 400, 100));
    pane.track.dispatchEvent(touchEvent('touchmove', 350, 100));
    now += 1000;
    pane.track.dispatchEvent(touchEvent('touchend', 350, 100));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(false);
    expect(pane.track.style.transform).toBe('translateX(0px)');
  });
  test('a short FAST drag commits: the flick', () => {
    const {overlay, pane} = build(500);
    pane.restoreSplit();
    pane.track.dispatchEvent(touchEvent('touchstart', 400, 100));
    pane.track.dispatchEvent(touchEvent('touchmove', 340, 100));
    now += 40;
    pane.track.dispatchEvent(touchEvent('touchend', 340, 100));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(true);
  });
  test('a drag that starts vertical never moves the track', () => {
    const {pane} = build(500);
    pane.restoreSplit();
    pane.track.dispatchEvent(touchEvent('touchstart', 200, 100));
    pane.track.dispatchEvent(touchEvent('touchmove', 202, 180));
    pane.track.dispatchEvent(touchEvent('touchmove', 100, 180));
    expect(pane.track.style.transform).toBe('translateX(0px)');
    pane.track.dispatchEvent(touchEvent('touchend', 100, 180));
    expect(pane.track.style.transform).toBe('translateX(0px)');
  });
  test('a horizontal scroller with room takes the drag first: the handover', () => {
    const {pane} = build(500);
    pane.restoreSplit();
    const sc = document.createElement('div');
    sc.className = 'cyc-fx-scroll';
    Object.defineProperty(sc, 'scrollWidth', {get: () => 350});
    Object.defineProperty(sc, 'clientWidth', {get: () => 200});
    sc.scrollLeft = 0;
    pane.paneA.append(sc);
    sc.dispatchEvent(touchEvent('touchstart', 400, 100));

    sc.dispatchEvent(touchEvent('touchmove', 300, 100));
    expect(sc.scrollLeft).toBe(100);
    expect(pane.track.style.transform).toBe('translateX(0px)');

    sc.dispatchEvent(touchEvent('touchmove', 200, 100));
    expect(sc.scrollLeft).toBe(150);
    expect(pane.track.style.transform).toBe('translateX(-50px)');
    now += 1000;
    pane.track.dispatchEvent(touchEvent('touchend', 200, 100));
  });
  test('ignoreSwipeWithin: a touch starting in the excluded element never swipes', () => {
    const {overlay, pane} = build(500, {ignoreSwipeWithin: '.cyc-fx-tabs'});
    pane.restoreSplit();
    const tabs = document.createElement('div');
    tabs.className = 'cyc-fx-tabs';
    pane.paneB.append(tabs);
    tabs.dispatchEvent(touchEvent('touchstart', 400, 100));
    tabs.dispatchEvent(touchEvent('touchmove', 100, 100));
    expect(pane.track.style.transform).toBe('translateX(0px)');
    tabs.dispatchEvent(touchEvent('touchend', 100, 100));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(false);
  });
  test('the wide layouts never swipe', () => {
    const {overlay, pane} = build(1000);
    pane.restoreSplit();
    pane.track.dispatchEvent(touchEvent('touchstart', 900, 100));
    pane.track.dispatchEvent(touchEvent('touchmove', 100, 100));
    pane.track.dispatchEvent(touchEvent('touchend', 100, 100));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(false);
    expect(pane.track.style.transform).toBe('translateX(0)');
  });
});

// The activation/commit discipline, proven on BOTH split-pane copies (files, git):
// micro-jitters and taps never move the track, a mostly-vertical drag is a scroll,
// a fast twitch under the flick floor snaps back, a real flick still commits.
describe.each([
  ['files', createSplitPane],
  ['git', createGitSplitPane]
])('phone swipe thresholds (%s copy)', (_name, create) => {
  let now = 100_000;
  beforeEach(() => {
    now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  const buildWith = (w: number) => {
    const overlay = overlayOfWidth(w);
    const pane = create(overlay, {
      storageKey: 'cyc-test-split',
      splitTablet: 0.4,
      splitLaptop: 0.3,
      railLabelA: 'Session',
      railLabelB: 'No thing'
    });
    return {overlay, pane};
  };
  test('a 5px jiggle neither moves the track nor commits', () => {
    const {overlay, pane} = buildWith(500);
    pane.restoreSplit();
    pane.track.dispatchEvent(touchEvent('touchstart', 400, 100));
    pane.track.dispatchEvent(touchEvent('touchmove', 395, 100));
    expect(pane.track.style.transform).toBe('translateX(0px)');
    now += 10;
    pane.track.dispatchEvent(touchEvent('touchend', 395, 100));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(false);
    expect(pane.track.style.transform).toBe('translateX(0px)');
  });
  test('a fast micro twitch under the flick floor snaps back instead of committing', () => {
    const {overlay, pane} = buildWith(500);
    pane.restoreSplit();
    pane.track.dispatchEvent(touchEvent('touchstart', 400, 100));
    pane.track.dispatchEvent(touchEvent('touchmove', 380, 100)); // 20px: armed, tracks
    expect(pane.track.style.transform).toBe('translateX(-20px)');
    now += 10; // 2 px/ms, far past SWIPE_FLICK, but under the distance floor
    pane.track.dispatchEvent(touchEvent('touchend', 380, 100));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(false);
    expect(pane.track.style.transform).toBe('translateX(0px)');
  });
  test('a near-diagonal drag (horizontal lead under the ratio) is a scroll, never a swipe', () => {
    const {overlay, pane} = buildWith(500);
    pane.restoreSplit();
    pane.track.dispatchEvent(touchEvent('touchstart', 200, 100));
    // dx 10 vs dy 9: horizontal does not lead by the 1.25 ratio, so the axis
    // latches vertical and the track never moves, even on later big travel.
    pane.track.dispatchEvent(touchEvent('touchmove', 190, 109));
    expect(pane.track.style.transform).toBe('translateX(0px)');
    pane.track.dispatchEvent(touchEvent('touchmove', 100, 109));
    expect(pane.track.style.transform).toBe('translateX(0px)');
    now += 1000;
    pane.track.dispatchEvent(touchEvent('touchend', 100, 109));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(false);
  });
  test('a real flick (past the floor, fast) still commits', () => {
    const {overlay, pane} = buildWith(500);
    pane.restoreSplit();
    pane.track.dispatchEvent(touchEvent('touchstart', 400, 100));
    pane.track.dispatchEvent(touchEvent('touchmove', 360, 100)); // 40px > flick floor
    now += 40; // 1 px/ms
    pane.track.dispatchEvent(touchEvent('touchend', 360, 100));
    expect(overlay.classList.contains('cyc-fx-on-b')).toBe(true);
  });
});
describe('split-pane copies stay in step', () => {
  test('both copies carry the same flick floor', () => {
    expect(GIT_SWIPE_FLICK_MIN_PX).toBe(SWIPE_FLICK_MIN_PX);
    expect(SWIPE_FLICK_MIN_PX).toBeGreaterThanOrEqual(20);
  });
});

describe('the splitter drag', () => {
  function capturable(rail: HTMLElement) {
    const held = new Set<number>();
    (rail as any).setPointerCapture = (id: number) => held.add(id);
    (rail as any).hasPointerCapture = (id: number) => held.has(id);
    (rail as any).releasePointerCapture = (id: number) => held.delete(id);
  }
  test('dragging moves the split, clamped, and the release remembers it', () => {
    const {overlay, pane} = build(1000);
    pane.restoreSplit();
    capturable(pane.rail);
    pane.rail.dispatchEvent(pointerEvent('pointerdown', 400));
    expect(overlay.classList.contains('cyc-fx-dragging')).toBe(true);
    pane.rail.dispatchEvent(pointerEvent('pointermove', 700));
    let aW = Math.round((1000 - RAIL_WIDE) * 0.7);
    expect(pane.paneA.style.width).toBe(`${aW}px`);
    pane.rail.dispatchEvent(pointerEvent('pointermove', 990));
    aW = Math.round((1000 - RAIL_WIDE) * SPLIT_MAX);
    expect(pane.paneA.style.width).toBe(`${aW}px`);
    pane.rail.dispatchEvent(pointerEvent('pointerup', 990));
    expect(overlay.classList.contains('cyc-fx-dragging')).toBe(false);

    expect(readSplit('cyc-test-split', false)).toBe(SPLIT_MAX);
    expect(readSplit('cyc-test-split', true)).toBeNull();
  });
  test('a phone-width overlay refuses the drag', () => {
    const {overlay, pane} = build(500);
    pane.restoreSplit();
    capturable(pane.rail);
    pane.rail.dispatchEvent(pointerEvent('pointerdown', 100));
    expect(overlay.classList.contains('cyc-fx-dragging')).toBe(false);
    pane.rail.dispatchEvent(pointerEvent('pointermove', 400));
    expect(readSplit('cyc-test-split', false)).toBeNull();
  });
});
