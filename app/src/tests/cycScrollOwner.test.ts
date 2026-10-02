import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createScrollOwner} from '../features/chat/surface/scrollOwner';

// The ScrollOwner's hands: a finger down on the list owns the offset until it
// lifts, and the lift must be heard however the browser delivers it. A
// finger's touchend goes to the node it landed on, even once that node has left
// the DOM, and a detached node's touchend never reaches the window (the
// phase-3 verifier's stuck reader-driving: a pinned reader stopped following
// replies). And the reader's own scroll (momentum after the lift) is timed on
// the owner's own clock from the current scroll event, held through a
// main-thread stall until the browser's scrollend. The e2e twin is
// e2e/offline/scroll-owner-release.spec.ts.

const teardowns: (() => void)[] = [];
afterEach(() => {
  for (const d of teardowns.splice(0)) d();
  document.body.innerHTML = '';
  vi.useRealTimers();
  delete (window as {onscrollend?: unknown}).onscrollend;
});

function mount(over: {isPinned?: () => boolean; distToEnd?: () => number} = {}) {
  const scroll = document.createElement('div');
  let top = 0;
  Object.defineProperty(scroll, 'scrollTop', {get: () => top, set: (v: number) => (top = v)});
  const row = document.createElement('div');
  const text = document.createElement('p');
  row.appendChild(text);
  scroll.appendChild(row);
  document.body.appendChild(scroll);
  const rewindow = vi.fn();
  const scrollToBottom = vi.fn();
  const owner = createScrollOwner({
    scroll,
    silentScrollTo: vi.fn(),
    scrollToBottom,
    rewindowWrite: vi.fn(),
    rewindow,
    listBanked: () => true,
    isMachineScroll: () => false,
    nearBottomPx: () => 100,
    isPinned: over.isPinned ?? (() => false),
    distToEnd: over.distToEnd ?? (() => 0),
    isLanding: () => false,
    isDividerHeld: () => false,
    reseatDivider: () => false,
    bankShift: vi.fn(),
    onTeardown: (d) => teardowns.push(d)
  });
  return {scroll, row, text, owner, rewindow, scrollToBottom};
}

const touch = (type: string, touches?: unknown[]) => {
  const e = new Event(type, {bubbles: true});
  if (touches) Object.defineProperty(e, 'touches', {value: touches});
  return e;
};

describe('ScrollOwner touch release', () => {
  test('a lift heard on the window releases the finger', () => {
    const {text, owner, rewindow} = mount();
    text.dispatchEvent(touch('touchstart'));
    expect(owner.driving()).toBe(true);
    window.dispatchEvent(touch('touchend'));
    expect(owner.driving()).toBe(false);
    expect(rewindow).toHaveBeenCalledTimes(1);
  });

  test('a lift on a target that left the DOM still releases the finger', () => {
    const {row, text, owner, rewindow} = mount();
    text.dispatchEvent(touch('touchstart'));
    row.remove();
    const lift = touch('touchend');
    const heardByWindow = vi.fn();
    window.addEventListener('touchend', heardByWindow);
    text.dispatchEvent(lift);
    window.removeEventListener('touchend', heardByWindow);
    expect(heardByWindow).not.toHaveBeenCalled();
    expect(owner.driving()).toBe(false);
    expect(owner.state()).not.toBe('reader-driving');
    expect(rewindow).toHaveBeenCalledTimes(1);
  });

  test('a touchcancel on a detached target releases the finger', () => {
    const {row, text, owner} = mount();
    text.dispatchEvent(touch('touchstart'));
    row.remove();
    text.dispatchEvent(touch('touchcancel'));
    expect(owner.driving()).toBe(false);
  });

  test('a lift on an attached target is handled once, not again on the window', () => {
    const {text, owner, rewindow} = mount();
    text.dispatchEvent(touch('touchstart'));
    text.dispatchEvent(touch('touchend'));
    expect(owner.driving()).toBe(false);
    expect(rewindow).toHaveBeenCalledTimes(1);
  });

  test('one of two fingers lifting keeps the hold; the last lift releases', () => {
    const {text, owner} = mount();
    text.dispatchEvent(touch('touchstart'));
    text.dispatchEvent(touch('touchend', [{}]));
    expect(owner.driving()).toBe(true);
    text.dispatchEvent(touch('touchend', []));
    expect(owner.driving()).toBe(false);
  });

  test('a lost lift is undone by the next touch sequence starting anywhere', () => {
    const {row, text, owner} = mount();
    text.dispatchEvent(touch('touchstart'));
    row.remove();
    // The lift went nowhere the owner hears (no event at all).
    expect(owner.driving()).toBe(true);
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.dispatchEvent(touch('touchstart', [{}]));
    expect(owner.driving()).toBe(false);
  });

  test('a second finger landing elsewhere keeps the first finger held', () => {
    const {text, owner} = mount();
    text.dispatchEvent(touch('touchstart', [{}]));
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.dispatchEvent(touch('touchstart', [{}, {}]));
    expect(owner.driving()).toBe(true);
  });
});

describe('ScrollOwner reader-scroll clock', () => {
  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date', 'performance']});
  });

  // The reader's scroll, as the browser delivers it: the offset moves and a
  // scroll event fires (with a wheel: fresh reader input; without: momentum).
  const scrollBy = (scroll: HTMLElement, dy: number, input = false) => {
    if (input) scroll.dispatchEvent(new Event('wheel'));
    scroll.scrollTop += dy;
    scroll.dispatchEvent(new Event('scroll'));
  };

  test('momentum after the input is the reader while scroll events keep coming', () => {
    const {scroll, owner} = mount();
    scrollBy(scroll, -50, true);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(140);
      expect(owner.driving()).toBe(true);
      scrollBy(scroll, -20);
    }
    expect(owner.driving()).toBe(true);
    vi.advanceTimersByTime(150);
    expect(owner.driving()).toBe(false);
  });

  test('no scrollend: a quiet gap over 150 ms ends the reader scroll', () => {
    const {scroll, owner} = mount();
    scrollBy(scroll, -50, true);
    vi.advanceTimersByTime(200);
    expect(owner.driving()).toBe(false);
    scrollBy(scroll, -20);
    expect(owner.driving()).toBe(false);
  });

  test('with scrollend: momentum through 270 ms stalls stays the reader until scrollend', () => {
    (window as {onscrollend?: unknown}).onscrollend = null;
    const {scroll, owner, rewindow} = mount();
    scrollBy(scroll, -50, true);
    for (const gap of [90, 270, 180, 250, 270]) {
      vi.advanceTimersByTime(gap);
      expect(owner.driving()).toBe(true);
      scrollBy(scroll, -20);
    }
    // A stall long enough that the virtualizer's scroll-end tick came and went.
    vi.advanceTimersByTime(300);
    expect(owner.driving()).toBe(true);
    expect(rewindow).not.toHaveBeenCalled();
    scroll.dispatchEvent(new Event('scrollend'));
    expect(owner.driving()).toBe(false);
    expect(rewindow).toHaveBeenCalledTimes(1);
  });

  test('with scrollend: right after it, the plain quiet still runs out first', () => {
    (window as {onscrollend?: unknown}).onscrollend = null;
    const {scroll, owner, rewindow} = mount();
    scrollBy(scroll, -50, true);
    scroll.dispatchEvent(new Event('scrollend'));
    expect(owner.driving()).toBe(true);
    expect(rewindow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(owner.driving()).toBe(false);
  });

  test('with scrollend: a lost scrollend cannot hold the reader past 1 s', () => {
    (window as {onscrollend?: unknown}).onscrollend = null;
    const {scroll, owner} = mount();
    scrollBy(scroll, -50, true);
    vi.advanceTimersByTime(999);
    expect(owner.driving()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(owner.driving()).toBe(false);
  });

  test('with scrollend: a scroll event that did not move opens no stall allowance', () => {
    (window as {onscrollend?: unknown}).onscrollend = null;
    const {scroll, owner} = mount();
    scrollBy(scroll, 0, true);
    vi.advanceTimersByTime(150);
    expect(owner.driving()).toBe(false);
  });

  test('a finger that held still before lifting ends the reader scroll at the lift', () => {
    (window as {onscrollend?: unknown}).onscrollend = null;
    const {scroll, text, owner} = mount();
    text.dispatchEvent(touch('touchstart'));
    scrollBy(scroll, -50, true);
    vi.advanceTimersByTime(400);
    expect(owner.driving()).toBe(true);
    window.dispatchEvent(touch('touchend'));
    expect(owner.driving()).toBe(false);
  });

  test('a machine write is never the reader, even mid-momentum', () => {
    const {scroll, owner} = mount();
    scrollBy(scroll, -50, true);
    const isMachine = owner.isMachineScroll;
    expect(isMachine(scroll.scrollTop)).toBe(false);
    vi.advanceTimersByTime(100);
    owner.jump('to-bottom', () => scrollBy(scroll, 400));
    expect(owner.driving()).toBe(false);
  });
});

// After a wheel stops at the end the browser can clamp the offset (the content
// shrank) 14 ms after scrollend. That scroll was credited to the reader and
// reopened the 1 s allowance, and an arrival inside it was skipped for good (the
// final verifier: 25 of 35 missed after a wheel stop, Chromium laptop).
describe('ScrollOwner after the reader stops', () => {
  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout']});
    (window as {onscrollend?: unknown}).onscrollend = null;
  });

  const scrollBy = (scroll: HTMLElement, dy: number, input = false) => {
    if (input) scroll.dispatchEvent(new Event('wheel'));
    scroll.scrollTop += dy;
    scroll.dispatchEvent(new Event('scroll'));
  };

  test('a clamp after scrollend with no input since is not the reader', () => {
    const {scroll, owner} = mount();
    scrollBy(scroll, 300, true);
    scroll.dispatchEvent(new Event('scrollend'));
    vi.advanceTimersByTime(14);
    scrollBy(scroll, -8);
    vi.advanceTimersByTime(140);
    expect(owner.driving()).toBe(false);
  });

  test('a scrollend while the finger is still down does not end its gesture', () => {
    const {scroll, text, owner} = mount();
    text.dispatchEvent(touch('touchstart'));
    text.dispatchEvent(touch('touchmove'));
    scrollBy(scroll, -40);
    scroll.dispatchEvent(new Event('scrollend'));
    window.dispatchEvent(touch('touchend'));
    vi.advanceTimersByTime(100);
    // The fling after the lift: scroll events with no input of their own.
    scrollBy(scroll, -30);
    vi.advanceTimersByTime(100);
    expect(owner.driving()).toBe(true);
  });

  test('new input after scrollend is the reader again', () => {
    const {scroll, owner} = mount();
    scrollBy(scroll, 300, true);
    scroll.dispatchEvent(new Event('scrollend'));
    vi.advanceTimersByTime(200);
    scrollBy(scroll, -40, true);
    expect(owner.driving()).toBe(true);
  });

  test('an arrival skipped while the reader drives is followed once they stop at the end', () => {
    let dist = 0;
    const {scroll, owner, rewindow, scrollToBottom} = mount({
      isPinned: () => true,
      distToEnd: () => dist
    });
    scrollBy(scroll, 300, true);
    scroll.dispatchEvent(new Event('scrollend'));
    vi.advanceTimersByTime(50);
    dist = 120;
    owner.followArrival();
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(rewindow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(owner.driving()).toBe(false);
    expect(rewindow).toHaveBeenCalledTimes(1);
  });

  test('a lost scrollend: the owed follow is paid when the stall allowance runs out', () => {
    let dist = 0;
    const {scroll, owner, rewindow} = mount({isPinned: () => true, distToEnd: () => dist});
    scrollBy(scroll, 300, true);
    vi.advanceTimersByTime(300);
    dist = 120;
    owner.followArrival();
    vi.advanceTimersByTime(600);
    expect(rewindow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(101);
    expect(rewindow).toHaveBeenCalledTimes(1);
  });

  test('an owed follow is dropped if the reader ends away from the end', () => {
    let pinned = true;
    const {scroll, owner, rewindow} = mount({isPinned: () => pinned, distToEnd: () => 120});
    scrollBy(scroll, -300, true);
    owner.followArrival();
    pinned = false;
    vi.advanceTimersByTime(1100);
    // listBanked is true in this mount, so the settle still re-windows once.
    expect(rewindow).toHaveBeenCalledTimes(1);
    pinned = true;
    vi.advanceTimersByTime(2000);
    expect(rewindow).toHaveBeenCalledTimes(1);
  });
});
