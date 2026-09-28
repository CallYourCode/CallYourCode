import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {renderMessages} from '../features/chat/surface/messageList';

// LANE 2, the owner's laptop (2026-09-28): ONE arriving chat message must draw
// ONE row. On the live build one arriving message drew 47 rows, removed 16, and
// rebuilt the window ~3 times. One cause was syncGeom forcing the virtualizer to
// rebuild its offset cache from index 0 on ANY count change -- even a pure tail
// append, which reindexes nothing. These pin the WINDOWED budget jsdom can
// express: an appended tail row adds exactly one node and rebuilds none of the
// rows already mounted, and a tail append below a reader scrolled into history
// touches the mounted window not at all. The scroll-event / main-thread half of
// the budget is a real-browser probe (scratchpad/arrive-budget.mjs); jsdom has
// no layout so it cannot see scrolls or task time.

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
  vi.restoreAllMocks();
});

const DAY_MS = 86_400_000;
const D0 = 1_700_000_000_000;
let msgCtr = 0;
const msg = (ts: number, role: CycMessage['role'] = 'claude'): CycMessage =>
  ({id: 'm' + msgCtr++, role, kind: 'text', text: 'msg ' + msgCtr, ts}) as CycMessage;

type Chat = CycSession & {events?: CycSessionEvent[]};

// A dense chat spanning several days, enough merged rows that the window is a
// bounded slice, not the whole list.
function denseChat(turns = 400): Chat {
  msgCtr = 0;
  const messages: CycMessage[] = [];
  for (let i = 0; i < turns; i++) {
    const day = D0 + Math.floor(i / 6) * DAY_MS;
    const t = day + (i % 6) * 3_600_000;
    messages.push(msg(t, 'user'));
    messages.push(msg(t + 60_000, 'claude'));
  }
  return {id: 's1', name: 'p', cwd: '/x', unread: 0, muted: false, messages} as unknown as Chat;
}

// Mount in a real scroll box whose viewport and offset are stubbed so the
// virtualizer computes a live window (the messageList.computeWindow seam).
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

const paint = (inner: HTMLElement, s: Chat) =>
  renderMessages(inner, s, () => {}, undefined, undefined, undefined, s.events);

const bubbles = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]'));

// Fold the childList mutations under `inner` into added/removed row ids.
function watch(inner: HTMLElement) {
  const id = (n: Node) => (n.nodeType === 1 ? ((n as HTMLElement).dataset.mid ?? '') : '');
  const added: string[] = [];
  const removed: string[] = [];
  const isRow = (n: Node) =>
    n.nodeType === 1 && (n as HTMLElement).matches?.('.cyc-message[data-mid]');
  const fold = (recs: MutationRecord[]) => {
    for (const r of recs) {
      for (const n of Array.from(r.addedNodes)) if (isRow(n)) added.push(id(n));
      for (const n of Array.from(r.removedNodes)) if (isRow(n)) removed.push(id(n));
    }
  };
  const obs = new MutationObserver(fold);
  obs.observe(inner, {childList: true, subtree: true});
  return () => {
    fold(obs.takeRecords());
    return {added, removed};
  };
}

describe('one arriving message draws one row (windowed)', () => {
  test('a tail append with the tail in view adds one node and rebuilds none of the mounted rows', () => {
    // A chat whose rows all fit inside the viewport + overscan band, so the tail
    // is mounted and the append lands inside the window (a reader at the bottom).
    // This still runs the windowed code path (a scroll box drives computeWindow /
    // syncGeom), just without the tail-edge estimation jsdom cannot resolve.
    const s = denseChat(9); // 18 messages
    const {inner} = mount();
    paint(inner, s);
    const before = bubbles(inner);
    expect(before.length).toBe(s.messages.length);
    const lastId = s.messages[s.messages.length - 1].id;
    expect(before.some((el) => el.dataset.mid === lastId)).toBe(true);

    const take = watch(inner);
    const newId = 'm' + (msgCtr++);
    s.messages.push({
      id: newId,
      role: 'claude',
      kind: 'text',
      text: 'arrived',
      ts: s.messages[s.messages.length - 1].ts + 60_000
    } as CycMessage);
    paint(inner, s);
    const {added, removed} = take();

    // Exactly one row added (the arriving message), zero removed.
    expect(added).toEqual([newId]);
    expect(removed).toEqual([]);
    // Every row mounted before is the SAME element (not a rebuild).
    const after = bubbles(inner);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    expect(after.length).toBe(before.length + 1);
  });

  test('a tail append below a reader scrolled into history leaves the mounted window untouched', () => {
    const s = denseChat();
    const {scroll, inner} = mount();
    // Deep in history: the tail is far below the window.
    scroll.scrollTop = 20_000;
    paint(inner, s);
    const before = bubbles(inner);
    expect(before.length).toBeGreaterThan(0);

    const take = watch(inner);
    s.messages.push(msg(s.messages[s.messages.length - 1].ts + 60_000, 'claude'));
    paint(inner, s);
    const {added, removed} = take();

    // The arriving row is outside the window, so nothing is added or removed.
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    const after = bubbles(inner);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    expect(after.length).toBe(before.length);
  });

  test('a front prepend is NOT treated as a tail append: the reindexed window re-seats correctly', () => {
    const s = denseChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 20_000;
    paint(inner, s);
    const beforeIds = new Set(bubbles(inner).map((b) => b.dataset.mid));

    // Prepend a whole earlier day at the FRONT (older history loaded): every
    // index shifts up. This must still rebuild the offset cache (grewAtTail is
    // false), so the window stays bounded and lands on real rows.
    const older: CycMessage[] = [];
    for (let i = 0; i < 20; i++) older.push(msg(D0 - DAY_MS + i * 60_000, i % 2 ? 'user' : 'claude'));
    s.messages = [...older, ...s.messages];
    paint(inner, s);

    const after = bubbles(inner);
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(80); // still bounded, not the whole chat
    // The window did not collapse to the prepended head (a stale-offset symptom).
    expect(after.some((b) => beforeIds.has(b.dataset.mid))).toBe(true);
  });
});

// The store's open window is the newest page (a fixed row cap), so a message
// arriving at the tail EVICTS the oldest row at the FRONT: every kept row's
// index shifts down by one. Before the front-trim shift the reuse walk matched
// the mounted frames by their now-stale POSITION, mismatched at the head, and
// rebuilt the whole window from scratch -- re-attaching (remounting) every
// visible bubble on every arrival (measured 68-93 rows redrawn per message, the
// bottom-of-chat jitter). These pin that a front eviction re-attaches only the
// edge rows the window genuinely slid over, never the whole window.
describe('a front eviction does not remount the mounted window', () => {
  test('drop-front + append-tail while scrolled in history reuses the kept rows', () => {
    const s = denseChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 20_000;
    paint(inner, s);
    const before = bubbles(inner);
    const beforeById = new Map(before.map((b) => [b.dataset.mid, b] as const));

    const take = watch(inner);
    // The store dropped its oldest row and appended the arrival at the tail.
    const arrival = msg(s.messages[s.messages.length - 1].ts + 60_000, 'claude');
    s.messages = [...s.messages.slice(1), arrival];
    paint(inner, s);
    const {added} = take();

    // The window slid by at most the one row the height change carried; the whole
    // window is NOT re-attached (that was 40+ before the fix).
    expect(added.length).toBeLessThanOrEqual(2);
    // Every mid mounted both before and after is the SAME element (not remounted).
    const after = bubbles(inner);
    for (const b of after) {
      const prev = beforeById.get(b.dataset.mid);
      if (prev) expect(prev).toBe(b);
    }
    // The rendered rows are a clean slice of the store: no duplicate or lost mid.
    const mids = after.map((b) => b.dataset.mid);
    expect(new Set(mids).size).toBe(mids.length);
  });

  test('a session-event row arriving at the tail with a front eviction reuses the window', () => {
    const s = denseChat();
    s.events = [];
    const {scroll, inner} = mount();
    scroll.scrollTop = 20_000;
    paint(inner, s);
    const before = bubbles(inner);
    const beforeById = new Map(before.map((b) => [b.dataset.mid, b] as const));

    const take = watch(inner);
    // A session pill arrives at the tail; the store evicts its oldest message.
    s.events = [
      {uuid: 'ev1', kind: 'reply', text: 'agent update', ts: s.messages[s.messages.length - 1].ts + 60_000} as CycSessionEvent
    ];
    s.messages = s.messages.slice(1);
    paint(inner, s);
    const {added} = take();

    expect(added.length).toBeLessThanOrEqual(2);
    const after = bubbles(inner);
    for (const b of after) {
      const prev = beforeById.get(b.dataset.mid);
      if (prev) expect(prev).toBe(b);
    }
  });
});
