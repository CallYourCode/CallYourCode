import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {
  renderMessages,
  scrollMessageIntoView,
  messageVisibleRangeKey,
  COLLAPSE_MIN
} from '../features/chat/surface/messageList';

// The virtual message list (TanStack virtual-core). These drive the REAL
// messageList seam over a 1,000+ item store and pin the window contract: only
// rows in and near the viewport exist in the DOM, the window slides on scroll,
// and a jump to a row outside the window mounts it. Replaces the old
// visible-row-budget rig; the item model (fold runs, date separators) is
// unchanged, only HOW MANY rows the DOM holds.

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

type Chat = CycSession & {events?: CycSessionEvent[]};
type Item = {m?: CycMessage; ev?: CycSessionEvent};

let evCtr = 0;
let msgCtr = 0;
const ev = (ts: number, kind = 'tool'): CycSessionEvent =>
  ({
    uuid: 'e' + evCtr++,
    ts,
    kind,
    text: 'ev ' + evCtr,
    ...(kind === 'tool' ? {tool: 'Read'} : {})
  }) as CycSessionEvent;
const msg = (ts: number, role: CycMessage['role'] = 'claude'): CycMessage =>
  ({id: 'm' + msgCtr++, role, kind: 'text', text: 'msg ' + msgCtr, ts}) as CycMessage;

// A latest day that is one long autonomous status run (a fold) behind a few
// conversation turns across earlier days, mirroring the owner's heaviest chat.
function ownerShape(opts?: {tailRun?: number; convBubbles?: number}): Chat {
  evCtr = 0;
  msgCtr = 0;
  const tailRun = opts?.tailRun ?? 700;
  const convBubbles = opts?.convBubbles ?? 60;
  const items: Item[] = [];
  for (let i = 0; i < convBubbles; i += 2) {
    const day = D0 + Math.floor(i / 8) * DAY_MS;
    const t = day + (i % 8) * 3_600_000;
    items.push({m: msg(t, 'user')});
    items.push({m: msg(t + 60_000, 'claude')});
    const burst = COLLAPSE_MIN - 2;
    for (let k = 0; k < burst; k++) items.push({ev: ev(t + 120_000 + k * 1000)});
  }
  const lastDay = D0 + 20 * DAY_MS;
  items.push({m: msg(lastDay, 'user')});
  items.push({m: msg(lastDay + 60_000, 'claude')});
  for (let k = 0; k < tailRun; k++) items.push({ev: ev(lastDay + 120_000 + k * 1000)});

  const messages: CycMessage[] = [];
  const events: CycSessionEvent[] = [];
  for (const it of items) {
    if (it.m) messages.push(it.m);
    else if (it.ev) events.push(it.ev);
  }
  return {id: 's1', name: 'BZ Builder', cwd: '/x', unread: 0, muted: false, messages, events} as unknown as Chat;
}

// A dense chat of real bubbles across several days, a lone pill between turns.
function denseChat(turns = 400): Chat {
  evCtr = 0;
  msgCtr = 0;
  const messages: CycMessage[] = [];
  const events: CycSessionEvent[] = [];
  for (let i = 0; i < turns; i++) {
    const day = D0 + Math.floor(i / 6) * DAY_MS;
    const t = day + (i % 6) * 3_600_000;
    messages.push(msg(t, 'user'));
    messages.push(msg(t + 60_000, 'claude'));
    events.push(ev(t + 120_000));
  }
  return {id: 's1', name: 'BZ Builder', cwd: '/x', unread: 0, muted: false, messages, events} as unknown as Chat;
}

// Mount `inner` in a real `.cyc-message-list-scroll` whose viewport and scroll
// offset are stubbed so the virtualizer computes a live window. scrollTop is a
// plain writable value (no clamp) so a test can position the window anywhere;
// each paint reads it directly (see messageList.computeWindow).
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
  // Stand in a large scrollHeight for the padded virtual content (jsdom has no
  // layout); the virtualizer clamps jump offsets against it.
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

function paint(inner: HTMLElement, s: Chat, firstUnreadId?: string) {
  renderMessages(inner, s, () => {}, firstUnreadId, undefined, undefined, s.events);
}

const allRows = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message'));
const bubbles = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]'));
const midsIn = (inner: HTMLElement) => new Set(bubbles(inner).map((b) => b.dataset.mid!));

describe('the store the rig drives', () => {
  test('a dense chat is 1,000+ merged items', () => {
    const s = denseChat();
    const total = s.messages.length + (s.events?.length ?? 0);
    expect(total).toBeGreaterThan(1000);
  });
});

describe('only rows in and near the viewport exist in the DOM', () => {
  test('a 1,000+ item chat paints a bounded window, not every row', () => {
    const s = denseChat();
    const {inner} = mount();
    paint(inner, s);
    const rowCount = allRows(inner).length;
    // Viewport 800 over ~76px rows plus overscan: a few dozen rows, never the
    // ~1,200 the chat holds (the field failure: 1,175 nodes, iOS killed the tab).
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThan(80);
    expect(rowCount).toBeLessThan(s.messages.length);
  });

  test('the owner shape (huge tail fold) is bounded too', () => {
    const s = ownerShape();
    const {inner} = mount();
    paint(inner, s);
    expect(allRows(inner).length).toBeLessThan(80);
  });

  test('a taller viewport paints more rows, still bounded', () => {
    const s = denseChat();
    const small = mount(400);
    paint(small.inner, s);
    const big = mount(1200);
    paint(big.inner, s);
    expect(allRows(big.inner).length).toBeGreaterThan(allRows(small.inner).length);
    expect(allRows(big.inner).length).toBeLessThan(120);
  });
});

describe('the window slides with the scroll offset', () => {
  test('scrolling down mounts later rows and drops earlier ones', () => {
    const s = denseChat();
    const {scroll, inner} = mount();
    paint(inner, s);
    const top = midsIn(inner);
    const keyTop = messageVisibleRangeKey(inner);

    scroll.scrollTop = 12_000;
    paint(inner, s);
    const lower = midsIn(inner);
    const keyLower = messageVisibleRangeKey(inner);

    expect(keyLower).not.toBe(keyTop);
    // The two windows are disjoint (or nearly so): the top rows are gone.
    const overlap = [...lower].filter((id) => top.has(id));
    expect(overlap.length).toBeLessThan(top.size);
    expect(allRows(inner).length).toBeLessThan(80);
  });
});

describe('the window keeps a pixel overscan band for fast flings', () => {
  // The blank-frame fix: the DOM window extends two viewport-heights beyond the
  // visible range on each side, so a fast fling meets painted rows instead of
  // unmounted space. jsdom has no layout, but the window is placed from the
  // virtualizer's measurement offsets (estimates here), so the band is visible
  // as how much a one-viewport scroll still overlaps the prior window.
  test('scrolling one viewport still overlaps most of the previous window', () => {
    const s = denseChat();
    const {scroll, inner} = mount(800);
    // Land mid-history so there is room for the band on both sides.
    scroll.scrollTop = 40_000;
    paint(inner, s);
    const before = midsIn(inner);
    scroll.scrollTop = 40_800; // one viewport further down
    paint(inner, s);
    const after = midsIn(inner);
    const overlap = [...after].filter((id) => before.has(id)).length;
    // A two-viewport overscan each side keeps a viewport-plus band mounted, so a
    // one-viewport scroll re-uses most of the prior rows rather than swapping in
    // a fresh window (which is what blanked the viewport mid-fling).
    expect(before.size).toBeGreaterThan(0);
    expect(overlap).toBeGreaterThan(before.size / 2);
  });

  test('the mounted window spans well beyond the visible viewport, still bounded', () => {
    // A single 800px viewport of ~76px rows holds ~10 rows; the pixel overscan
    // band (two viewports each side) mounts several times that, never the chat.
    const s = denseChat();
    const {scroll, inner} = mount(800);
    scroll.scrollTop = 40_000;
    paint(inner, s);
    const rows = allRows(inner).length;
    expect(rows).toBeGreaterThan(20);
    expect(rows).toBeLessThan(80);
  });
});

describe('jump to a row outside the window mounts it', () => {
  test('scrollMessageIntoView renders and seats an unrendered old message', () => {
    const s = denseChat();
    const {scroll, inner} = mount();
    // Land deep in the chat so an early message is well outside the window.
    scroll.scrollTop = 20_000;
    paint(inner, s);
    const early = s.messages[2];
    expect(midsIn(inner).has(early.id)).toBe(false);

    expect(scrollMessageIntoView(inner, early.id, 'center')).toBe(true);
    expect(inner.querySelector(`.cyc-message[data-mid="${early.id}"]`)).not.toBeNull();
    expect(allRows(inner).length).toBeLessThan(80);
  });

  test('scrollMessageIntoView returns false for an unknown id', () => {
    const s = denseChat();
    const {inner} = mount();
    paint(inner, s);
    expect(scrollMessageIntoView(inner, 'nope-nope')).toBe(false);
  });
});

describe('the item model is unchanged inside the window', () => {
  test('a collapsed run still paints a single fold head', () => {
    const s = ownerShape();
    const {scroll, inner} = mount();
    // The tail is one long same-day run; land near the very bottom of the model.
    scroll.scrollTop = 200_000;
    paint(inner, s);
    expect(inner.querySelectorAll('.cyc-se-run-head').length).toBeGreaterThanOrEqual(1);
  });

  test('a fresh open with an in-window unread id paints its divider', () => {
    const s = denseChat();
    const firstClaude = s.messages.find((m) => m.role === 'claude')!;
    const {inner} = mount();
    // At the top the first claude row is within the window; its divider paints.
    paint(inner, s, firstClaude.id);
    expect(inner.querySelector('.cyc-msg-unread')).not.toBeNull();
  });
});
