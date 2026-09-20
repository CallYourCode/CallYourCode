import {beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('../shared/capabilities', () => ({touchCapable: false, prefersMotion: () => false}));
vi.mock('../audio/speaker', () => ({
  speaker: {pending: (): Set<string> => new Set(), stopAll() {}}
}));
vi.mock('../speechGate', () => ({mayStartSpeech: () => false}));
vi.mock('../engine/store', () => ({get: (): undefined => undefined}));

import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {renderMessages} from '../features/chat/surface/messageList';
import {createReaderLanding} from '../features/chat/surface/readerLanding';
import type {ReadMarker} from '../engine/store/readState';

const CLIENT_HEIGHT = 300;

beforeEach(() => {
  (globalThis as unknown as {IntersectionObserver: unknown}).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// A row's one durable id is derived from its mid (claude) or cid (own send) by
// the store's rowIdOfMessage; the fixtures below mirror that so the marker
// resolves by IDENTITY, never by the row's instant.
function claude(n: number, text: string, ts: number): CycMessage {
  return {id: `m:mr-${n}`, role: 'claude', kind: 'text', text, ts, mid: `mr-${n}`} as CycMessage;
}
function userRow(n: number, text: string, ts: number, cid?: string): CycMessage {
  return {
    id: cid ? `m:c:${cid}` : `m:mr-${n}`,
    role: 'user',
    kind: 'text',
    text,
    ts,
    ...(cid ? {cid} : {mid: `mr-${n}`})
  } as CycMessage;
}

function installLayout(inner: HTMLElement, scroll: HTMLElement) {
  const rows = Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message'));
  let contentHeight = 0;
  const topOf = new Map<HTMLElement, number>();
  for (const row of rows) {
    topOf.set(row, contentHeight);
    contentHeight += row.classList.contains('cyc-session-event') ? 20 : 60;
  }
  let scrollTop = 0;
  Object.defineProperties(scroll, {
    clientHeight: {configurable: true, get: () => CLIENT_HEIGHT},
    scrollHeight: {configurable: true, get: () => contentHeight},
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, contentHeight - CLIENT_HEIGHT));
      }
    }
  });
  scroll.getBoundingClientRect = () => ({top: 0}) as DOMRect;
  for (const row of rows) {
    row.getBoundingClientRect = () => ({top: topOf.get(row)! - scrollTop}) as DOMRect;
  }
  return {distanceToBottom: () => contentHeight - CLIENT_HEIGHT - scrollTop};
}

// The marker is resolved by IDENTITY: the read row's own mid, exactly as the
// engine broadcasts it (readThrough.mid). A test may override the marker to
// model one whose row is NOT in the loaded window.
function landing(
  session: CycSession,
  heard: number,
  events: CycSessionEvent[],
  markerOverride?: (s: CycSession) => ReadMarker | undefined
) {
  const inner = document.createElement('div');
  const scroll = document.createElement('div');
  scroll.append(inner);
  const markerFor =
    markerOverride ??
    ((s: CycSession) => {
      let best: CycMessage | undefined;
      for (const m of s.messages) if (m.ts <= heard && (!best || m.ts > best.ts)) best = m;
      return best ? {mid: (best as {mid?: string}).mid, ts: best.ts} : undefined;
    });
  const reader = createReaderLanding({
    deps: {
      heardTsOf: () => heard,
      readMarkerOf: markerFor,
      play: () => {},
      suppressAutoSpeak: () => false,
      isChatViewOpen: () => true
    },
    messages: inner,
    scroll,
    silentScrollTo: (position) => {
      scroll.scrollTop = position;
    },
    openMarker: () => (heard ? {ts: heard} : undefined),
    setOpenMarker: () => {}
  });
  const firstUnreadId = reader.firstUnheardId(session);
  renderMessages(inner, session, () => {}, firstUnreadId, undefined, undefined, events);
  const geometry = installLayout(inner, scroll);
  return {inner, scroll, reader, firstUnreadId, geometry};
}

describe('open landing uses message rows, not projected event rows', () => {
  test('a field-shaped event span lands at the first unread CLAUDE message', () => {
    // The count (readstate.unreadOf) only counts claude-role rows after the
    // marker, so the anchor is the first claude row after it -- the intervening
    // remote user MESSAGE, like the event span, is not the anchor.
    const messages = [
      claude(1, 'read', 10),
      userRow(
        2,
        'a remote user message the count does not count',
        20,
        'engine-supplied-remote-cid'
      ),
      claude(3, 'first unread remote CLAUDE message', 500),
      claude(4, 'later unread remote message', 600),
      claude(5, 'later unread remote message', 700),
      claude(6, 'later unread remote message', 800),
      claude(7, 'later unread remote message', 900)
    ];
    const events = Array.from({length: 300}, (_, i) => ({
      uuid: 'event-' + i,
      kind: 'tool',
      text: 'event ' + i,
      ts: 21 + i,
      seq: 21 + i
    })) as CycSessionEvent[];
    const session = {id: 's1', name: 's1', messages, unread: 5} as CycSession;
    const result = landing(session, 10, events);

    expect(result.firstUnreadId).toBe('m:mr-3');
    expect(result.inner.querySelector('[data-cyc-unread]')?.getAttribute('data-mid')).toBe(
      'm:mr-3'
    );
    expect(
      result.inner.querySelector('[data-cyc-unread]')?.classList.contains('cyc-session-event')
    ).toBe(false);

    result.scroll.scrollTop = result.scroll.scrollHeight;
    expect(result.reader.scrollToFirstUnread()).toBe(true);
    expect(result.geometry.distanceToBottom()).toBeGreaterThan(0);
  });

  test('a post-send reopen lands at bottom because the sent row is read through', () => {
    const messages = [
      claude(1, 'read', 5),
      claude(2, 'read', 6),
      claude(3, 'read', 7),
      claude(4, 'read', 8),
      claude(5, 'read', 10),
      userRow(6, 'just sent', 20, 'this-device-send')
    ];
    const session = {id: 's1', name: 's1', messages, unread: 1} as CycSession;
    const result = landing(session, 20, []);

    expect(result.firstUnreadId).toBeUndefined();
    expect(result.reader.scrollToFirstUnread()).toBe(false);
    result.scroll.scrollTop = result.scroll.scrollHeight;
    expect(result.geometry.distanceToBottom()).toBe(0);
  });

  test('a remote unread claude MESSAGE remains the anchor', () => {
    const messages = [claude(1, 'read', 10), claude(2, 'remote unread reply', 20)];
    const session = {id: 's1', name: 's1', messages, unread: 1} as CycSession;

    expect(landing(session, 10, []).firstUnreadId).toBe('m:mr-2');
  });

  test('no unread MESSAGE lands at bottom even with a trailing event span', () => {
    const messages = [claude(1, 'read', 10), userRow(2, 'also read', 20)];
    const events = Array.from({length: 300}, (_, i) => ({
      uuid: 'event-' + i,
      kind: 'tool',
      text: 'event ' + i,
      ts: 21 + i,
      seq: 21 + i
    })) as CycSessionEvent[];
    const session = {id: 's1', name: 's1', messages, unread: 0} as CycSession;
    const result = landing(session, 20, events);

    expect(result.firstUnreadId).toBeUndefined();
    expect(result.reader.scrollToFirstUnread()).toBe(false);
    result.scroll.scrollTop = result.scroll.scrollHeight;
    expect(result.geometry.distanceToBottom()).toBe(0);
  });
});

/* THE COUNT IS THE SOLE AUTHORITY FOR WHETHER ANYTHING IS UNREAD (fix-landing),
 * and identity -- never time -- is the sole authority for WHERE (fix-oneid).
 *
 * Live example, build 1789733079 (2026-09-18): the sessions frame reported
 * unread=0 for a chat the owner was caught up on, but the client landing
 * computed read-state on its OWN from the marker's position. When the marker
 * resolved to a MID-LIST row (its true row aged out and a ts-equality fallback
 * landed on a middle row) `firstUnheardId` returned the row AFTER it -- a
 * divider ~mid-history up -- and the landing corrected to it 200ms after
 * touching bottom, tripping the pager and ballooning the window. */
describe('the engine unread count decides whether a divider exists', () => {
  const claudeRun = () => [
    claude(1, 'read', 10),
    claude(2, 'read', 20),
    claude(3, 'read', 30),
    claude(4, 'read', 40),
    claude(5, 'read', 50),
    claude(6, 'read', 60),
    claude(7, 'read', 70)
  ];

  test('unread=0 never anchors a mid-list divider from a stale marker position', () => {
    // The engine counts unread=0. The device marker resolves MID-LIST (ts=40).
    // The count is authority: no divider, land at bottom.
    const session = {id: 's1', name: 's1', messages: claudeRun(), unread: 0} as CycSession;
    const result = landing(session, 40, []);

    expect(result.firstUnreadId).toBeUndefined();
    expect(result.inner.querySelector('[data-cyc-unread]')).toBeNull();
    expect(result.reader.scrollToFirstUnread()).toBe(false);
    result.scroll.scrollTop = result.scroll.scrollHeight;
    expect(result.geometry.distanceToBottom()).toBe(0);
  });

  test('unread>0 anchors at the first row after the marker IDENTITY, then lands there', () => {
    // A restamp/mis-sort gives two rows the same ts; the marker IDENTITY (its
    // mid) pins the read row and the divider is the NEXT row in store order,
    // never a ts twin.
    const messages = [
      claude(1, 'read', 100),
      {
        id: 'm:mr-2',
        role: 'claude',
        kind: 'text',
        text: 'genuinely unread reply',
        ts: 100,
        mid: 'mr-2'
      }
    ] as unknown as CycMessage[];
    const session = {id: 's1', name: 's1', messages, unread: 1} as CycSession;
    const result = landing(session, 100, []);

    expect(result.firstUnreadId).toBe('m:mr-2');
    expect(result.inner.querySelector('[data-cyc-unread]')?.getAttribute('data-mid')).toBe(
      'm:mr-2'
    );
    result.scroll.scrollTop = result.scroll.scrollHeight;
    expect(result.reader.scrollToFirstUnread()).toBe(true);
  });

  test('unread>0 but the marker row is not in the loaded window lands at bottom', () => {
    // The read-through row aged out (an older page). The divider belongs up
    // there; the landing lands at the newest loaded row and lets the owner
    // scroll up, rather than forcing an older-page fetch just to place it.
    const session = {id: 's1', name: 's1', messages: claudeRun(), unread: 3} as CycSession;
    const result = landing(session, 5, [], () => ({mid: 'aged-out-of-window', ts: 5}));

    expect(result.firstUnreadId).toBeUndefined();
    expect(result.reader.scrollToFirstUnread()).toBe(false);
  });

  /* THE OWNER'S SHALU CASE (app.log 19:54:13, build 1789734730): unread=1, the
   * one unread claude reply at the very TAIL, but the marker's row (mid=held)
   * was NOT in the loaded window while a DIFFERENT mid-history row shared the
   * marker's ts (target=held actual=6058 mid-history). The old code fell back to
   * ts equality, matched that twin mid-history, and anchored the divider on the
   * row after it -- a wrong anchor far up a chat the owner was reading. The new
   * code never ts-matches: an unresolvable marker lands at bottom per the count,
   * and the tail reply is reached by scrolling. FAILS before fix-oneid (the ts
   * twin steals the anchor), passes after. */
  test('marker mid absent from the window but a ts twin present never steals the anchor', () => {
    const messages = [
      claude(1, 'read long ago', 1000),
      claude(2, 'a mid-history row that happens to share the held marker instant', 5000),
      claude(3, 'more read history', 6000),
      claude(4, 'the one unread reply at the very tail', 9000)
    ];
    const session = {id: 's1', name: 's1', messages, unread: 1} as CycSession;
    // The engine's read-through names mid 'held', whose row is below the loaded
    // window; its ts (5000) coincides with row 2's instant.
    const result = landing(session, 5000, [], () => ({mid: 'held', ts: 5000}));

    // Never resolves to the ts twin (row 2) and never anchors the row after it
    // (row 3): unresolvable identity lands at bottom, no divider in this window.
    expect(result.firstUnreadId).toBeUndefined();
    expect(result.inner.querySelector('[data-cyc-unread]')).toBeNull();
    expect(result.reader.scrollToFirstUnread()).toBe(false);
  });
});

/* THE ANCHOR SELECTS THE FIRST ROW THE COUNT COUNTS (fix-anchor).
 *
 * Live owner, build 1789747439 (app.log 19:08:17): opening BZ Distributor with
 * unread=1 landed 19039px above the bottom instead of at the one unread claude
 * message near the tail. The count counts claude-role rows after the marker;
 * the anchor must sit on the first CLAUDE row after the marker identity.
 */
describe('the anchor sits at the first claude row the count counts', () => {
  test('unread=1: non-claude rows after the marker do not steal the tail claude anchor', () => {
    const messages = [
      claude(1, 'his last interaction, read', 100),
      userRow(2, 'non-claude row from another path', 200),
      userRow(3, 'non-claude row from another path', 300),
      userRow(4, 'non-claude row from another path', 400),
      claude(5, 'the one unread reply near the tail', 900)
    ];
    const session = {id: 's1', name: 's1', messages, unread: 1} as CycSession;
    const result = landing(session, 100, []);

    expect(result.firstUnreadId).toBe('m:mr-5');
    expect(result.inner.querySelector('[data-cyc-unread]')?.getAttribute('data-mid')).toBe(
      'm:mr-5'
    );

    result.scroll.scrollTop = result.scroll.scrollHeight;
    expect(result.reader.scrollToFirstUnread()).toBe(true);
    expect(result.geometry.distanceToBottom()).toBe(0);
  });

  test('unread=2: interleaved non-claude rows anchor at the FIRST unread claude row', () => {
    const messages = [
      claude(1, 'read', 100),
      userRow(2, 'non-claude', 200),
      claude(3, 'first unread claude reply', 300),
      userRow(4, 'non-claude', 400),
      claude(5, 'second unread claude reply', 500)
    ];
    const session = {id: 's1', name: 's1', messages, unread: 2} as CycSession;
    const result = landing(session, 100, []);

    expect(result.firstUnreadId).toBe('m:mr-3');
    expect(result.inner.querySelector('[data-cyc-unread]')?.getAttribute('data-mid')).toBe(
      'm:mr-3'
    );
  });

  test('no claude row after the marker: trailing non-claude rows land at bottom, no divider', () => {
    const messages = [
      claude(1, 'read', 100),
      ...Array.from({length: 8}, (_, i) => userRow(i + 2, 'trailing non-claude row', 200 + i * 100))
    ];
    const session = {id: 's1', name: 's1', messages, unread: 1} as CycSession;
    const result = landing(session, 100, []);

    expect(result.firstUnreadId).toBeUndefined();
    expect(result.inner.querySelector('[data-cyc-unread]')).toBeNull();
    expect(result.reader.scrollToFirstUnread()).toBe(false);
    result.scroll.scrollTop = result.scroll.scrollHeight;
    expect(result.geometry.distanceToBottom()).toBe(0);
  });
});
