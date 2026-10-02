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

function mount() {
  const scroll = document.createElement('div');
  let top = 0;
  Object.defineProperty(scroll, 'scrollTop', {get: () => top, set: (v: number) => (top = v)});
  const row = document.createElement('div');
  const text = document.createElement('p');
  row.appendChild(text);
  scroll.appendChild(row);
  document.body.appendChild(scroll);
  const rewindow = vi.fn();
  const owner = createScrollOwner({
    scroll,
    silentScrollTo: vi.fn(),
    scrollToBottom: vi.fn(),
    rewindowWrite: vi.fn(),
    rewindow,
    listBanked: () => true,
    isMachineScroll: () => false,
    nearBottomPx: () => 100,
    isPinned: () => false,
    distToEnd: () => 0,
    isLanding: () => false,
    isDividerHeld: () => false,
    reseatDivider: () => false,
    bankShift: vi.fn(),
    onTeardown: (d) => teardowns.push(d)
  });
  return {scroll, row, text, owner, rewindow};
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
