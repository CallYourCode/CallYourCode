import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import type {CycMessage, CycSession} from '../types';
import {renderMessages, clearMessages} from '../features/chat/surface/messageList';

// THE WINDOW MUST NEVER PRUNE A DAY SECTION THAT STILL HOLDS ROWS (BZ
// Distributor, laptop, 2026-10-03 09:40: "scroll DOWN just doesn't happen").
// A window that opens mid-day draws its first day as a section WITHOUT a date
// chip. Scrolling down trims the rows leaving the top and prunes the sections
// they emptied; the prune took "one child or fewer" for "only the chip left", so
// a chip-less section left holding ONE group (a run of one role) was removed with
// every kept and new row inside it. The list was empty for the rest of the paint,
// the paint's layout read let the browser clamp scrollTop to the spacers alone
// (~2.7k px up, no write of ours), and the history pager read the blank as the
// top and loaded older history, again and again. grep token: `mid-day section`.

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as unknown as {IntersectionObserver: unknown}).IntersectionObserver = FakeIO;
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

const D0 = 1_700_000_000_000;

// One day of agent lines only: the whole day is ONE message group, so a window
// opened mid-day is a chip-less section with a single child.
function oneDayOneRole(n = 400): CycSession {
  const messages: CycMessage[] = [];
  for (let i = 0; i < n; i++)
    messages.push({
      id: 'm' + i,
      role: 'claude',
      kind: 'text',
      text: 'line ' + i,
      ts: D0 + i * 1000
    } as CycMessage);
  return {
    id: 's1',
    name: 'BZ Distributor',
    cwd: '/x',
    unread: 0,
    muted: false,
    messages
  } as unknown as CycSession;
}

function mount(clientHeight = 900) {
  const scroll = document.createElement('div');
  scroll.className = 'cyc-message-list-scroll';
  const inner = document.createElement('div');
  scroll.append(inner);
  document.body.append(scroll);
  let top = 0;
  Object.defineProperty(scroll, 'clientHeight', {value: clientHeight, configurable: true});
  Object.defineProperty(scroll, 'clientWidth', {value: 1440, configurable: true});
  Object.defineProperty(scroll, 'offsetHeight', {value: clientHeight, configurable: true});
  Object.defineProperty(scroll, 'scrollHeight', {value: 10_000_000, configurable: true});
  Object.defineProperty(scroll, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, v);
    },
    configurable: true
  });
  return {scroll, inner};
}

const mounted = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]')).map(
    (n) => n.dataset.mid!
  );

describe('a mid-day window keeps its rows while the reader scrolls down', () => {
  test('trimming the top of a chip-less one-group section leaves the window mounted', () => {
    const s = oneDayOneRole();
    const {scroll, inner} = mount();
    scroll.scrollTop = 20_000; // mid-day: the window opens without the day's chip
    renderMessages(inner, s, () => {});
    expect(inner.querySelector('.cyc-date-chip')).toBeNull();
    const before = mounted(inner);
    expect(before.length).toBeGreaterThan(0);

    // Scroll down step by step: each re-window trims rows off the top.
    for (let i = 0; i < 12; i++) {
      scroll.scrollTop += 300;
      renderMessages(inner, s, () => {});
      const now = mounted(inner);
      expect(now.length, `step ${i}: the window was emptied`).toBeGreaterThan(0);
      for (const id of now)
        expect(
          inner.querySelector(`[data-mid="${id}"]`)!.isConnected,
          `step ${i}: row ${id} detached`
        ).toBe(true);
    }
    expect(mounted(inner)[0]).not.toBe(before[0]);
    clearMessages(inner);
  });
});
