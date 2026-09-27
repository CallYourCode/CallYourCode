import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {
  renderMessages,
  clearMessages,
  messageRowCacheSize
} from '../features/chat/surface/messageList';

// The scroll jank fix (2026-09-27): a fast fling used to rebuild every row in
// the window from scratch (markdown parse, syntax paint) on every scroll event,
// because a slid window shares no reuse anchor with the last paint. A bounded
// LRU of detached row nodes lets a row leaving the window re-attach its decoded
// bubble when it returns, instead of being rebuilt. These pin the cache: a row
// re-entering unchanged is the SAME element; a content or status change misses
// the cache and rebuilds; and the detached set stays bounded.

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

const DAY_MS = 86_400_000;
const D0 = 1_700_000_000_000;

type Chat = CycSession & {events?: CycSessionEvent[]};

let msgCtr = 0;
const msg = (ts: number, role: CycMessage['role'] = 'claude'): CycMessage =>
  ({id: 'm' + msgCtr++, role, kind: 'text', text: 'msg ' + msgCtr, ts}) as CycMessage;

// A dense chat of real bubbles across several days: enough rows that a window
// slide drops many and the cache is exercised.
function denseChat(turns = 400): Chat {
  msgCtr = 0;
  const messages: CycMessage[] = [];
  for (let i = 0; i < turns; i++) {
    const day = D0 + Math.floor(i / 6) * DAY_MS;
    const t = day + (i % 6) * 3_600_000;
    messages.push(msg(t, 'user'));
    messages.push(msg(t + 60_000, 'claude'));
  }
  return {id: 's1', name: 'BZ Builder', cwd: '/x', unread: 0, muted: false, messages} as unknown as Chat;
}

// Mount `inner` in a real scroll box whose geometry is stubbed so the
// virtualizer computes a live window; scrollTop is a plain writable value.
function mount(clientHeight = 800) {
  const scroll = document.createElement('div');
  scroll.className = 'cyc-message-list-scroll';
  const inner = document.createElement('div');
  scroll.append(inner);
  document.body.append(scroll);
  let top = 0;
  Object.defineProperty(scroll, 'clientHeight', {value: clientHeight, configurable: true});
  Object.defineProperty(scroll, 'clientWidth', {value: 390, configurable: true});
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

function paint(inner: HTMLElement, s: Chat) {
  renderMessages(inner, s, () => {}, undefined, undefined, undefined, s.events);
}

const rowOf = (inner: HTMLElement, id: string) =>
  inner.querySelector<HTMLElement>(`.cyc-message[data-mid="${id}"]`);
const midsIn = (inner: HTMLElement) =>
  new Set(
    Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]')).map((b) => b.dataset.mid!)
  );

// The tests keep a single session in flight at a time.
let CURRENT: Chat;

describe('a row leaving and re-entering the window re-attaches its node', () => {
  test('an interior row scrolled away and back is the SAME element', () => {
    CURRENT = denseChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 40_000;
    paint(inner, CURRENT);
    const mids = Array.from(midsIn(inner));
    // A row solidly inside the window (its first/last edges do not flip as the
    // window moves), and confirm it leaves at the far position.
    const id = mids[Math.floor(mids.length / 2)];
    const node = rowOf(inner, id)!;
    expect(node).not.toBeNull();

    scroll.scrollTop = 200_000; // far away: the row drops out of the window
    paint(inner, CURRENT);
    expect(rowOf(inner, id)).toBeNull();

    scroll.scrollTop = 40_000; // back: the row re-enters
    paint(inner, CURRENT);
    const again = rowOf(inner, id);
    expect(again).not.toBeNull();
    // Re-attached, not rebuilt: the exact same element object.
    expect(again).toBe(node);
    clearMessages(inner);
  });
});

describe('scrolling up keeps the overlap in place and prepends the entering rows', () => {
  test('an overlapping row is the SAME element after scrolling up; no duplicate rows', () => {
    CURRENT = denseChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 40_000;
    paint(inner, CURRENT);
    const midsMid = Array.from(midsIn(inner));
    // A row in the lower part of this window is likely to still be in the window
    // after scrolling up a little (the overlap that stays mounted in place).
    const keepId = midsMid[midsMid.length - 2];
    const keepNode = rowOf(inner, keepId)!;
    expect(keepNode).not.toBeNull();

    scroll.scrollTop = 38_000; // a small scroll up: the window slides up, overlap stays
    paint(inner, CURRENT);

    const again = rowOf(inner, keepId);
    if (again) expect(again).toBe(keepNode); // kept in place, not rebuilt
    // No row is mounted twice (the prepend must not duplicate the overlap).
    const idxs = Array.from(inner.querySelectorAll<HTMLElement>('[data-index]')).map(
      (n) => n.dataset.index
    );
    expect(idxs.length).toBe(new Set(idxs).size);
    expect(inner.querySelectorAll('.cyc-message').length).toBeLessThan(160);
    clearMessages(inner);
  });

  test('scrolling up keeps ONE date chip per day (no duplicate chips)', () => {
    CURRENT = denseChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 40_000;
    paint(inner, CURRENT);
    for (let top = 40_000; top >= 8_000; top -= 1_200) {
      scroll.scrollTop = top;
      paint(inner, CURRENT);
    }
    const days = Array.from(inner.querySelectorAll<HTMLElement>('.cyc-date-chip')).map(
      (c) => c.textContent
    );
    expect(days.length).toBe(new Set(days).size); // no day appears twice
    clearMessages(inner);
  });
});

describe('a changed row misses the cache and rebuilds', () => {
  test('a content edit while scrolled away yields a fresh node with the new text', () => {
    CURRENT = denseChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 40_000;
    paint(inner, CURRENT);
    const id = Array.from(midsIn(inner))[Math.floor(midsIn(inner).size / 2)];
    const node = rowOf(inner, id)!;
    const edited = CURRENT.messages.find((m) => m.id === id)!;

    scroll.scrollTop = 200_000;
    paint(inner, CURRENT);
    edited.text = 'edited body after scroll away';

    scroll.scrollTop = 40_000;
    paint(inner, CURRENT);
    const again = rowOf(inner, id)!;
    expect(again).not.toBeNull();
    expect(again).not.toBe(node); // the stale cached node was not re-used
    expect(again.textContent).toContain('edited body after scroll away');
    clearMessages(inner);
  });

  test('a status change while scrolled away yields a fresh node', () => {
    CURRENT = denseChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 40_000;
    paint(inner, CURRENT);
    const id = Array.from(midsIn(inner))[Math.floor(midsIn(inner).size / 2)];
    const node = rowOf(inner, id)!;
    const edited = CURRENT.messages.find((m) => m.id === id)!;

    scroll.scrollTop = 200_000;
    paint(inner, CURRENT);
    (edited as CycMessage).status = 'failed';

    scroll.scrollTop = 40_000;
    paint(inner, CURRENT);
    const again = rowOf(inner, id)!;
    expect(again).not.toBe(node);
    clearMessages(inner);
  });
});

describe('the detached cache is bounded', () => {
  test('scrolling through a large chat never grows the cache past its bound', () => {
    CURRENT = denseChat(600); // ~1,200 rows, far more than the 400 bound
    const {scroll, inner} = mount();
    // Walk the whole model in one direction so rows keep dropping behind.
    let maxSeen = 0;
    for (let top = 0; top <= 120_000; top += 2_000) {
      scroll.scrollTop = top;
      paint(inner, CURRENT);
      maxSeen = Math.max(maxSeen, messageRowCacheSize(inner));
    }
    // Enough rows dropped to fill the cache, and it held at the bound.
    expect(maxSeen).toBeGreaterThan(0);
    expect(messageRowCacheSize(inner)).toBeLessThanOrEqual(400);
    expect(maxSeen).toBeLessThanOrEqual(400);
    clearMessages(inner);
  });

  test('switching chats clears the cache so no other chat bubble re-attaches', () => {
    CURRENT = denseChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 40_000;
    paint(inner, CURRENT);
    scroll.scrollTop = 200_000;
    paint(inner, CURRENT); // drops rows into the cache
    expect(messageRowCacheSize(inner)).toBeGreaterThan(0);

    const other = denseChat();
    other.id = 's2';
    scroll.scrollTop = 0;
    paint(inner, other);
    expect(messageRowCacheSize(inner)).toBe(0);
    clearMessages(inner);
  });
});
