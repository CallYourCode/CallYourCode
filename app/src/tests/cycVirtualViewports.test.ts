import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {
  renderMessages,
  scrollMessageIntoView,
  messageVisibleRangeKey,
  clearMessages
} from '../features/chat/surface/messageList';

// The virtualized list exercised at three device viewports (the parent's
// added acceptance). Playwright was not run: the app boots against a live
// engine/websocket backend it has no standalone harness for here, so this is
// the vitest + jsdom equivalent, driving the REAL messageList seam. Row heights
// are 0 under jsdom, so the virtualizer falls back to its per-row estimate; the
// window is therefore estimate-bounded, which is exactly what these assert.

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
let evCtr = 0;
const msg = (ts: number, role: CycMessage['role']): CycMessage =>
  ({id: 'm' + msgCtr++, role, kind: 'text', text: 'msg ' + msgCtr, ts}) as CycMessage;
const ev = (ts: number): CycSessionEvent =>
  ({uuid: 'e' + evCtr++, ts, kind: 'tool', text: 'ev', tool: 'Read'}) as CycSessionEvent;

// 1,200+ merged items: alternating turns across several days with a lone status
// pill between turns, matching a heavy real chat.
function bigChat(turns = 420): Chat {
  msgCtr = 0;
  evCtr = 0;
  const messages: CycMessage[] = [];
  const events: CycSessionEvent[] = [];
  for (let i = 0; i < turns; i++) {
    const day = D0 + Math.floor(i / 6) * DAY_MS;
    const t = day + (i % 6) * 3_600_000;
    messages.push(msg(t, 'user'));
    messages.push(msg(t + 60_000, 'claude'));
    events.push(ev(t + 120_000));
  }
  return {id: 's1', name: 'BZ', cwd: '/x', unread: 0, muted: false, messages, events} as unknown as Chat;
}

function mount(w: number, h: number) {
  const scroll = document.createElement('div');
  scroll.className = 'cyc-message-list-scroll';
  const inner = document.createElement('div');
  scroll.append(inner);
  document.body.append(scroll);
  let top = 0;
  Object.defineProperty(scroll, 'clientHeight', {value: h, configurable: true});
  Object.defineProperty(scroll, 'offsetHeight', {value: h, configurable: true});
  Object.defineProperty(scroll, 'clientWidth', {value: w, configurable: true});
  // jsdom computes no layout, so stand in a large scrollHeight for the padded
  // virtual content (the browser derives this from the inner spacers). The
  // virtualizer clamps jump offsets against it (getMaxScrollOffset).
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
const allRows = (inner: HTMLElement) => inner.querySelectorAll<HTMLElement>('.cyc-message').length;
const mids = (inner: HTMLElement) =>
  new Set(
    Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]')).map(
      (b) => b.dataset.mid!
    )
  );
const hasMid = (inner: HTMLElement, id: string) =>
  !!inner.querySelector(`.cyc-message[data-mid="${id}"]`);

const VIEWPORTS = [
  {name: 'phone 390x844', w: 390, h: 844},
  {name: 'tablet 820x1180', w: 820, h: 1180},
  {name: 'laptop 1440x900', w: 1440, h: 900}
];

for (const vp of VIEWPORTS) {
  describe(`virtual list @ ${vp.name}`, () => {
    test('opens a 1,000+ item chat with a bounded DOM', () => {
      const s = bigChat();
      expect(s.messages.length + s.events!.length).toBeGreaterThan(1000);
      const {inner} = mount(vp.w, vp.h);
      paint(inner, s);
      const rows = allRows(inner);
      // A screenful plus overscan, scaled to the viewport, never the ~1,260 rows
      // the chat holds. The estimate is ~76px/row, so a bound of vh/40 + 40 is
      // generous headroom while still far below the total.
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThan(Math.ceil(vp.h / 40) + 40);
      expect(rows).toBeLessThan(s.messages.length);
      clearMessages(inner);
    });

    test('scroll toward the top keeps older rows loadable without disturbing the anchor', () => {
      const s = bigChat();
      const {scroll, inner} = mount(vp.w, vp.h);
      // Seat the reader on a mid-history message (the anchor) and note the rows
      // around it.
      const anchor = s.messages[200];
      scroll.scrollTop = 30_000;
      paint(inner, s);
      expect(scrollMessageIntoView(inner, anchor.id, 'center')).toBe(true);
      expect(hasMid(inner, anchor.id)).toBe(true);
      const around = mids(inner);

      // Older history arrives (a loadOlder prepend): unshift 40 older turns and
      // repaint, exactly as the store notify -> render does.
      const older: CycMessage[] = [];
      for (let i = 0; i < 40; i++) older.push(msg(D0 - (40 - i) * 3_600_000, i % 2 ? 'claude' : 'user'));
      s.messages.unshift(...older);
      paint(inner, s);
      // The anchor stays reachable across the prepend (its durable key survives
      // the index shift): re-seating on it brings back the SAME rows around it
      // (no disturbance to what the reader was looking at), and the DOM stays
      // bounded. Pixel-exact scroll preservation is the chat surface's render
      // bracket, covered by its own tests.
      expect(scrollMessageIntoView(inner, anchor.id, 'center')).toBe(true);
      expect(hasMid(inner, anchor.id)).toBe(true);
      for (const id of around) expect(hasMid(inner, id)).toBe(true);
      expect(allRows(inner)).toBeLessThan(Math.ceil(vp.h / 40) + 60);
      clearMessages(inner);
    });

    test('jump to an old message outside the window renders and seats it', () => {
      const s = bigChat();
      const {scroll, inner} = mount(vp.w, vp.h);
      scroll.scrollTop = 60_000;
      paint(inner, s);
      const old = s.messages[4];
      expect(hasMid(inner, old.id)).toBe(false);
      expect(scrollMessageIntoView(inner, old.id, 'center')).toBe(true);
      expect(hasMid(inner, old.id)).toBe(true);
      expect(allRows(inner)).toBeLessThan(Math.ceil(vp.h / 40) + 60);
      clearMessages(inner);
    });

    test('a new message while at the bottom stays in the window', () => {
      const s = bigChat();
      const {scroll, inner} = mount(vp.w, vp.h);
      // Pinned to the bottom (scrolled past the end; the window clamps to the
      // last rows).
      scroll.scrollTop = 5_000_000;
      paint(inner, s);
      const rangeBefore = messageVisibleRangeKey(inner);
      const fresh = msg(s.messages[s.messages.length - 1].ts + 60_000, 'claude');
      s.messages.push(fresh);
      // Still pinned to the bottom after the append.
      scroll.scrollTop = 5_000_000;
      paint(inner, s);
      expect(hasMid(inner, fresh.id)).toBe(true);
      expect(messageVisibleRangeKey(inner)).not.toBe(rangeBefore);
      expect(allRows(inner)).toBeLessThan(Math.ceil(vp.h / 40) + 60);
      clearMessages(inner);
    });

    // The unread landing far back in a heavy chat (50+ unread): the anchor sits
    // ~60 turns (well over 50 claude rows) above a window pinned to the end. The
    // bounded convergence walk in scrollMessageIntoView must land on it while the
    // DOM stays bounded -- no runaway passes, no blank. The measured height is
    // stubbed above the 96px estimate to sharpen offsets across passes the way a
    // real narrow-layout bubble does; jsdom lays out nothing, so this guards the
    // mount and the DOM bound rather than the on-screen seat (the probes cover
    // the seat at each viewport).
    test('walks onto a far off-window anchor while the DOM stays bounded', () => {
      const s = bigChat();
      const {scroll, inner} = mount(vp.w, vp.h);
      const orig = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const c = this.classList;
        const height = c.contains('cyc-session-event')
          ? 30
          : c.contains('cyc-message')
            ? 150 // well over EST_MSG (96)
            : c.contains('cyc-msg-date')
              ? 40
              : 0;
        return {top: 0, left: 0, right: 0, bottom: height, width: vp.w, height, x: 0, y: 0, toJSON() {}} as DOMRect;
      };
      try {
        // Seed the window at the bottom (a cold open pins to the end first), then
        // land on an anchor ~60 turns (well over 50 claude rows) above it.
        scroll.scrollTop = 5_000_000;
        paint(inner, s);
        const anchor = s.messages[s.messages.length - 120];
        expect(hasMid(inner, anchor.id)).toBe(false);
        expect(scrollMessageIntoView(inner, anchor.id, 'start')).toBe(true);
        expect(hasMid(inner, anchor.id)).toBe(true);
        expect(allRows(inner)).toBeLessThan(Math.ceil(vp.h / 40) + 60);
      } finally {
        HTMLElement.prototype.getBoundingClientRect = orig;
      }
      clearMessages(inner);
    });
  });
}
