import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {renderMessages, clearMessages} from '../features/chat/surface/messageList';

// 2026-09-18, owner screenshots (build 1789734730): two "Unread Messages"
// banners in one transcript, hours apart, and the same shape on the "Queued
// for ..." banner. The divider and the queued banner are stamped INTO a
// message row at build time; the incremental walk keeps already-built rows
// verbatim. A row that is no longer the anchor (the divider moved, or a second
// copy of the anchor id rode in on an overlapping history page) or no longer
// the first queued row (a reply landed below it) kept a stamp it should have
// shed, so a later paint stamping the new row left the list showing two. These
// pin the invariant: at most one of each banner survives a repaint, on the
// current row.

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

const DAY = 1_700_000_000_000;
const msg = (over: Omit<Partial<CycMessage>, 'id'> & {id: number}): CycMessage =>
  ({
    role: 'claude',
    kind: 'text',
    text: `row ${over.id}`,
    ts: DAY + over.id * 60_000,
    ...over,
    // the fixtures speak in small numbers; the one durable id is a string
    id: String(over.id)
  }) as CycMessage;

type Chat = CycSession & {events?: CycSessionEvent[]};
function session(messages: CycMessage[], events?: CycSessionEvent[]): Chat {
  return {
    id: 's1',
    name: 'p',
    cwd: '/x',
    unread: 0,
    muted: false,
    messages,
    events,
    agentName: 'Ada'
  } as unknown as Chat;
}

const mount = (): HTMLElement => {
  const inner = document.createElement('div');
  document.body.append(inner);
  return inner;
};

const paint = (inner: HTMLElement, s: Chat, firstUnreadId?: number) =>
  renderMessages(
    inner,
    s,
    () => {},
    firstUnreadId === undefined ? undefined : String(firstUnreadId),
    undefined,
    undefined,
    s.events
  );

const unreadBanners = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-msg-unread'));
const unreadMarks = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('[data-cyc-unread]'));
const queuedBanners = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-msg-queued'));
const firstQueuedRows = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-first-queued'));
const rowOf = (inner: HTMLElement, id: number) =>
  inner.querySelector<HTMLElement>(`.cyc-message[data-mid="${id}"]`)!;

// A dozen alternating turns, all one day.
function history(): CycMessage[] {
  const out: CycMessage[] = [];
  for (let i = 1; i <= 12; i++) out.push(msg({id: i, role: i % 2 ? 'user' : 'claude'}));
  return out;
}

describe('the unread divider survives a repaint as exactly one banner', () => {
  test('the divider moving from row A to row B leaves one banner, on B', () => {
    const inner = mount();
    const s = session(history());
    paint(inner, s, 5);
    expect(unreadBanners(inner)).toHaveLength(1);
    expect(rowOf(inner, 5).querySelector('.cyc-msg-unread')).not.toBeNull();

    // A repaint that reuses the built rows and moves the divider down.
    paint(inner, s, 9);
    expect(unreadBanners(inner)).toHaveLength(1);
    expect(unreadMarks(inner)).toHaveLength(1);
    expect(rowOf(inner, 9).querySelector('.cyc-msg-unread')).not.toBeNull();
    expect(rowOf(inner, 5).querySelector('.cyc-msg-unread')).toBeNull();
    expect(rowOf(inner, 5).dataset.cycUnread).toBeUndefined();
    clearMessages(inner);
  });

  test('the divider clearing (firstUnreadId undefined) leaves no banner', () => {
    const inner = mount();
    const s = session(history());
    paint(inner, s, 5);
    expect(unreadBanners(inner)).toHaveLength(1);
    paint(inner, s, undefined);
    expect(unreadBanners(inner)).toHaveLength(0);
    expect(unreadMarks(inner)).toHaveLength(0);
    clearMessages(inner);
  });

  // The field symptom: a second copy of the anchor id rides in on an
  // overlapping history page, so two rows answer `id === firstUnreadId`. Before
  // the fix both were stamped and the transcript showed two "Unread Messages"
  // banners hours apart; after it, only the first (where unread truly begins).
  test('two rows sharing the anchor id yield one banner, on the first', () => {
    const inner = mount();
    const older = msg({id: 100, role: 'claude', ts: DAY + 1_000});
    const newer = msg({id: 100, role: 'claude', ts: DAY + 9_000});
    const s = session([
      msg({id: 1, role: 'user'}),
      older,
      msg({id: 2, role: 'user', ts: DAY + 5_000}),
      newer
    ]);
    paint(inner, s, 100);
    const banners = unreadBanners(inner);
    expect(banners).toHaveLength(1);
    // The kept banner sits on the earlier of the two copies.
    const rows = Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid="100"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.cyc-msg-unread')).not.toBeNull();
    expect(rows[1].querySelector('.cyc-msg-unread')).toBeNull();
    clearMessages(inner);
  });
});

describe('the "first queued" banner survives a repaint as exactly one banner', () => {
  // The queued banner opens the run of messages queued ahead of the agent
  // (past the last claude row). Its PRESENCE depends on the surrounding rows
  // (the row before is not queued; it sits past the last claude row), context
  // the row signature does not carry, so a reused row keeps a stale banner
  // when a reply lands below it. A newer queued run then stamps a second.
  test('a reply landing below a queued run moves the banner, it does not clone it', () => {
    const inner = mount();
    const s = session([
      msg({id: 1, role: 'user'}),
      msg({id: 2, role: 'claude'}),
      msg({id: 3, role: 'user', queued: true}),
      msg({id: 4, role: 'user', queued: true})
    ]);
    paint(inner, s);
    expect(queuedBanners(inner)).toHaveLength(1);
    expect(firstQueuedRows(inner)).toHaveLength(1);
    expect(rowOf(inner, 3).querySelector('.cyc-msg-queued')).not.toBeNull();

    // The agent replies (a new claude row past the old queued run) and a fresh
    // message is queued after it. Row 3 is now behind the agent, no longer the
    // first queued row; row 6 opens the new queued run.
    s.messages.push(msg({id: 5, role: 'claude'}));
    s.messages.push(msg({id: 6, role: 'user', queued: true}));
    paint(inner, s);

    expect(queuedBanners(inner)).toHaveLength(1);
    expect(firstQueuedRows(inner)).toHaveLength(1);
    expect(rowOf(inner, 6).querySelector('.cyc-msg-queued')).not.toBeNull();
    expect(rowOf(inner, 3).querySelector('.cyc-msg-queued')).toBeNull();
    expect(rowOf(inner, 3).classList.contains('cyc-first-queued')).toBe(false);
    clearMessages(inner);
  });
});
