import {beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('../shared/capabilities', () => ({touchCapable: false, prefersMotion: () => false}));
vi.mock('../audio/speaker', () => ({
  speaker: {pending: (): Set<string> => new Set(), stopAll() {}}
}));
vi.mock('../speechGate', () => ({mayStartSpeech: () => false}));
vi.mock('../engine/store', () => ({get: (): undefined => undefined}));

import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {renderMessages, clearMessages, rewindowMessages} from '../features/chat/surface/messageList';
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

/* THE UNREAD LANDING FAR BACK IN A HEAVY CHAT, through the VIRTUALIZED seam.
 *
 * On a narrow layout the rendered bubble measures well over the per-row
 * estimate. A cold open pins the window to the end first, so the divider anchor
 * sits far above the window on only its ESTIMATE. The first placement seats the
 * divider from that estimate; re-windowing then measures the rows it exposed and
 * the divider's true top drifts away, and without a re-settle the open comes to
 * rest mid-history with no divider in view (the reported regression). Driven
 * here through a virtual mount whose rows carry a stubbed layout (jsdom lays out
 * nothing) so the seat can be asserted: the divider mounts, the view leaves the
 * bottom, and the divider comes to rest inside the viewport with lead-in above.
 */
describe('the landing settles the divider far back in a virtualized heavy chat', () => {
  const VH = 800;
  const H_MSG = 150; // over EST_MSG (96)
  const H_EVENT = 30;

  const rowH = (el: HTMLElement): number =>
    el.classList.contains('cyc-session-event')
      ? H_EVENT
      : el.classList.contains('cyc-msg-date')
        ? 40
        : el.classList.contains('cyc-message')
          ? H_MSG
          : 0;

  function virtualMount() {
    const scroll = document.createElement('div');
    scroll.className = 'cyc-message-list-scroll';
    const inner = document.createElement('div');
    scroll.append(inner);
    document.body.append(scroll);
    let top = 0;
    Object.defineProperty(scroll, 'clientHeight', {value: VH, configurable: true});
    Object.defineProperty(scroll, 'clientWidth', {value: 390, configurable: true});
    // scrollHeight tracks the padded virtual content: the top/bottom spacers plus
    // the mounted rows' own heights, the same total the browser would derive.
    Object.defineProperty(scroll, 'scrollHeight', {
      configurable: true,
      get: () => {
        const pt = parseFloat(inner.style.paddingTop) || 0;
        const pb = parseFloat(inner.style.paddingBottom) || 0;
        let sum = 0;
        for (const r of inner.querySelectorAll<HTMLElement>('[data-index]')) sum += rowH(r);
        return pt + pb + sum;
      }
    });
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, v);
      }
    });
    return {scroll, inner};
  }

  // Stand in a layout for the mounted rows: each row's on-screen top is the top
  // spacer plus the heights of the mounted rows before it, minus the live
  // scroll. This is the REAL (measured) geometry, deliberately at odds with the
  // virtualizer's estimate-built spacer until the exposed rows are measured --
  // exactly the divergence the re-settle must converge.
  function installRects(inner: HTMLElement, scroll: HTMLElement) {
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this === scroll) {
        return {top: 0, left: 0, right: 390, bottom: VH, width: 390, height: VH, x: 0, y: 0, toJSON() {}} as DOMRect;
      }
      if (this.dataset.index === undefined) {
        return {top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {}} as DOMRect;
      }
      let t = parseFloat(inner.style.paddingTop) || 0;
      for (const r of inner.querySelectorAll<HTMLElement>('[data-index]')) {
        if (r === this) break;
        t += rowH(r);
      }
      t -= scroll.scrollTop;
      const h = rowH(this);
      return {top: t, left: 0, right: 390, bottom: t + h, width: 390, height: h, x: 0, y: t, toJSON() {}} as DOMRect;
    };
    return () => {
      HTMLElement.prototype.getBoundingClientRect = orig;
    };
  }

  test('a 60+ claude-row-back anchor lands with the divider seated in the viewport', () => {
    // A read run, then 70 unread claude replies interleaved with status pills:
    // the anchor is the first of the 70, ~140 rows above a bottom-pinned window.
    const messages: CycMessage[] = [];
    for (let i = 1; i <= 40; i++) messages.push(claude(i, 'read ' + i, i * 10));
    const marker = messages[messages.length - 1]; // last read row (identity)
    let ts = marker.ts;
    for (let i = 41; i <= 110; i++) {
      ts += 10;
      messages.push(userRow(i, 'context ' + i, ts));
      ts += 10;
      messages.push(claude(i + 1000, 'unread reply ' + i, ts));
    }
    const unread = messages.filter((m) => m.role === 'claude' && m.ts > marker.ts).length;
    expect(unread).toBeGreaterThan(50);
    const session = {id: 's1', name: 's1', messages, unread} as CycSession;

    const {scroll, inner} = virtualMount();
    const restore = installRects(inner, scroll);
    try {
      const reader = createReaderLanding({
        deps: {
          heardTsOf: () => marker.ts,
          readMarkerOf: () => ({mid: (marker as {mid?: string}).mid, ts: marker.ts}),
          play: () => {},
          suppressAutoSpeak: () => false,
          isChatViewOpen: () => true
        },
        messages: inner,
        scroll,
        silentScrollTo: (position) => {
          scroll.scrollTop = position;
        },
        openMarker: () => ({ts: marker.ts}),
        setOpenMarker: () => {}
      });
      const firstUnreadId = reader.firstUnheardId(session);
      expect(firstUnreadId).toBeDefined();

      renderMessages(inner, session, () => {}, firstUnreadId, undefined, undefined, []);
      // A cold open pins to the end first.
      scroll.scrollTop = scroll.scrollHeight;
      renderMessages(inner, session, () => {}, firstUnreadId, undefined, undefined, []);

      // The scrollToFirstUnread pass mounts and settles the divider.
      expect(reader.scrollToFirstUnread(firstUnreadId)).toBe(true);

      let divider = inner.querySelector<HTMLElement>('[data-cyc-unread]');
      expect(divider).not.toBeNull();
      // It left the bottom (walked up to the far anchor)...
      const toEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
      expect(toEnd).toBeGreaterThan(VH);
      // ...and the divider came to rest inside the viewport with lead-in above,
      // held there through the measurement settle (not stuck at the top, not
      // off-screen).
      let top = divider!.getBoundingClientRect().top;
      expect(top).toBeGreaterThan(0);
      expect(top).toBeLessThan(VH);
      // The follow-up re-windows the app runs after a scroll (measurement
      // settle, scroll-end) must not shift the divider back off its seat: the
      // landing has to leave NO pending measurement drift behind it.
      rewindowMessages(inner);
      rewindowMessages(inner);
      divider = inner.querySelector<HTMLElement>('[data-cyc-unread]');
      expect(divider).not.toBeNull();
      top = divider!.getBoundingClientRect().top;
      expect(top).toBeGreaterThan(0);
      expect(top).toBeLessThan(VH);
    } finally {
      restore();
      clearMessages(inner);
    }
  });
});
