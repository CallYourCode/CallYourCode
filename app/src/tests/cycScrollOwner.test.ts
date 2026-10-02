import {afterEach, describe, expect, test, vi} from 'vitest';
import {createScrollOwner} from '../features/chat/surface/scrollOwner';

// The ScrollOwner's hands: a finger down on the list owns the offset until it
// lifts, and the lift must be heard however the browser delivers it. A
// finger's touchend goes to the node it landed on, even once that node has left
// the DOM, and a detached node's touchend never reaches the window (the
// phase-3 verifier's stuck reader-driving: a pinned reader stopped following
// replies). The e2e twin is e2e/offline/scroll-owner-release.spec.ts.

const teardowns: (() => void)[] = [];
afterEach(() => {
  for (const d of teardowns.splice(0)) d();
  document.body.innerHTML = '';
});

function mount() {
  const scroll = document.createElement('div');
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
    listScrolling: () => false,
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
