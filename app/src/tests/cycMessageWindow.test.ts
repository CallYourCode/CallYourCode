import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {
  renderMessages,
  messageWindowFrom,
  extendMessageWindow,
  COLLAPSE_MIN
} from '../features/chat/surface/messageList';

// fix-msgwindow REPRODUCTION RIG. The owner's heaviest chats crossed the 300-row
// render window (WINDOW_ITEMS) for the first time and the window path misbehaves.
// This rig builds a store shaped like his: 800+ rows, mostly collapsible status
// events (a long autonomous run at the tail) with sparse user/claude bubbles
// across several days, and drives the REAL messageList seam. Each `describe`
// below pins one field-reported shape; the fixtures ARE the fail-before tests.

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
const D0 = 1_700_000_000_000; // an arbitrary midnight-ish base

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

// The owner's shape: several earlier days of REAL conversation (bubbles with a
// short status burst between turns), then a latest day that is one long
// autonomous status run (hundreds of tool events) with just a bubble or two at
// its head. The session splits the merged item list back into messages[] and
// events[], exactly as the store projection would.
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
    const burst = COLLAPSE_MIN - 2; // stays below the fold threshold
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
  return {
    id: 's1',
    name: 'BZ Builder',
    cwd: '/x',
    unread: 0,
    muted: false,
    messages,
    events
  } as unknown as Chat;
}

// A dense chat whose RENDER-VISIBLE row count exceeds the window budget, so the
// floor stays > 0 even after visible-row counting: many real bubbles across
// several days, with a lone status pill between turns.
function denseChat(turns = 350): Chat {
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
  return {
    id: 's1',
    name: 'BZ Builder',
    cwd: '/x',
    unread: 0,
    muted: false,
    messages,
    events
  } as unknown as Chat;
}

// Mount `inner` inside a `.cyc-message-list-scroll` so the sameChat rebase
// blocks (which read `inner.closest('.cyc-message-list-scroll')`) see a real
// scroller. Geometry is stubbed so "near bottom" is decidable.
function mount(scrollGeom?: {scrollHeight?: number; clientHeight?: number; scrollTop?: number}) {
  const scroll = document.createElement('div');
  scroll.className = 'cyc-message-list-scroll';
  const inner = document.createElement('div');
  scroll.append(inner);
  document.body.append(scroll);
  const g = scrollGeom ?? {};
  Object.defineProperty(scroll, 'scrollHeight', {value: g.scrollHeight ?? 8000, configurable: true});
  Object.defineProperty(scroll, 'clientHeight', {value: g.clientHeight ?? 800, configurable: true});
  Object.defineProperty(scroll, 'scrollTop', {
    value: g.scrollTop ?? 7200,
    writable: true,
    configurable: true
  });
  return {scroll, inner};
}

function paint(inner: HTMLElement, s: Chat, firstUnreadId?: string) {
  renderMessages(inner, s, () => {}, firstUnreadId, undefined, undefined, s.events);
}

const bubbles = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]'));
const foldHeads = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-se-run-head'));
const unreadDivider = (inner: HTMLElement) =>
  inner.querySelector<HTMLElement>('.cyc-msg-unread');

describe('DIAGNOSTIC: the owner shape as the rig sees it', () => {
  test('the store is 800+ items, mostly a tail status run', () => {
    const s = ownerShape();
    const total = s.messages.length + (s.events?.length ?? 0);
    expect(total).toBeGreaterThan(800);
  });
});

describe('SHAPE 2: window counting (fresh open of a status-heavy chat)', () => {
  test('a fresh open paints a full screen of real content, not one chip', () => {
    const s = ownerShape();
    const {inner} = mount();
    paint(inner, s);
    // The field failure: the newest 300 ITEMS are the tail status run, which
    // collapses to a single chip, so a fresh open showed a chip and a bubble or
    // two. Counting a collapsed run as ONE row reaches back through the real
    // conversation and paints many bubbles.
    expect(bubbles(inner).length).toBeGreaterThanOrEqual(20);
    expect(foldHeads(inner).length).toBeGreaterThanOrEqual(1);
  });
});

describe('SHAPE 3 (fresh open): a landing anchor outside the tail window', () => {
  test('a fresh open whose unread anchor is old still renders its divider', () => {
    const s = denseChat();
    const oldClaude = s.messages.find((m) => m.role === 'claude')!;
    const {inner} = mount();
    paint(inner, s, oldClaude.id);
    expect(unreadDivider(inner)).not.toBeNull();
  });
});

describe('SHAPE 3 (sameChat repaint): tab-return landing on an old anchor', () => {
  test('a sameChat repaint keeps an out-of-window anchor landable', () => {
    const s = denseChat();
    const oldClaude = s.messages.find((m) => m.role === 'claude')!;
    // First paint with NO anchor lands on the tail (from>0), the state a
    // reader-at-bottom tab-return repaints from.
    const {inner} = mount({scrollHeight: 8000, clientHeight: 800, scrollTop: 7200});
    paint(inner, s);
    expect(messageWindowFrom(inner)).toBeGreaterThan(0);
    // The landing now runs on the SAME chat and wants the old unread anchor. The
    // anchor extension must run on a sameChat repaint too, so the divider is in
    // the painted window (landable) instead of the landing skipping to the edge
    // on weeks-old rows.
    paint(inner, s, oldClaude.id);
    expect(unreadDivider(inner)).not.toBeNull();
  });
});

const earlierPill = (inner: HTMLElement) =>
  inner.querySelector<HTMLElement>(':scope > .cyc-earlier');

describe('SHAPE 1: reaching the top of the rendered window', () => {
  test('no manual "Earlier messages" pill; auto-extend is the path (WhatsApp behavior)', () => {
    const s = denseChat();
    const {inner} = mount();
    paint(inner, s);
    // The floor is above the start (more visible rows than the budget), the exact
    // state the old code painted a click-to-load pill in. WhatsApp just loads on
    // scroll: no pill, ever.
    expect(messageWindowFrom(inner)).toBeGreaterThan(0);
    expect(earlierPill(inner)).toBeNull();
  });

  test('reaching the top auto-extends the window toward older history', () => {
    const s = denseChat();
    const {inner} = mount();
    paint(inner, s);
    const before = messageWindowFrom(inner);
    expect(before).toBeGreaterThan(0);
    // extendMessageWindow is what the history pager calls on scroll-to-top; it
    // must move the floor up (toward 0) by whole visible rows.
    const moved = extendMessageWindow(inner);
    expect(moved).toBe(true);
    paint(inner, s);
    expect(messageWindowFrom(inner)).toBeLessThan(before);
  });
});
