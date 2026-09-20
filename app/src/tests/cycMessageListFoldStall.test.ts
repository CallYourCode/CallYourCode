import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {renderMessages, clearMessages, COLLAPSE_MIN} from '../features/chat/surface/messageList';

// 2026-09-08, the owner's phone: BZ Builder's chat froze after 14:55 local --
// the thread ended with a "N background updates" fold while the engine held
// hundreds of newer rows the surface never showed. The chat is ~87% autonomous
// session pills, so the tail is a long run of session events that folds into
// one head. The stall was not in sync (the phone provably held the newest
// rows): the incremental reuse walk kept the tail fold's frame verbatim as its
// run grew, so the head's count froze and every newly arrived same-day event
// accreted as an individual pill below the stale fold -- unbounded, and each
// extra pill kept alive by its presentation painter until the tab's heap and
// repaint loop gave out. These pin the fixed shape: a tail fold whose run grows
// stays ONE fold whose count tracks the run, with nothing loose below it; a
// sub-threshold run that grows past COLLAPSE_MIN folds like a fresh paint; and
// a reuse pass that ever throws falls back to a full rebuild instead of freezing.

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

const DAY = 1_700_000_000_000;

type Chat = CycSession & {events?: CycSessionEvent[]};
const session = (messages: CycMessage[], events: CycSessionEvent[]): Chat =>
  ({
    id: 's1',
    name: 'p',
    cwd: '/x',
    unread: 0,
    muted: false,
    messages,
    events
  }) as unknown as Chat;

const mount = (): HTMLElement => {
  const inner = document.createElement('div');
  document.body.append(inner);
  return inner;
};

let evCtr = 0;
const ev = (ts: number, kind = 'tool'): CycSessionEvent =>
  ({
    uuid: 'e' + evCtr++,
    ts,
    kind,
    text: 'ev ' + evCtr,
    ...(kind === 'tool' ? {tool: 'Read'} : {})
  }) as CycSessionEvent;
const msg = (id: number, ts: number, role: CycMessage['role'] = 'claude'): CycMessage =>
  ({id: String(id), role, kind: 'text', text: 'm' + id, ts}) as CycMessage;

function paint(inner: HTMLElement, s: Chat) {
  renderMessages(inner, s, () => {}, undefined, undefined, undefined, s.events);
}

const foldHeads = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-se-run-head .cyc-service-text'));
// Session-event pills that are NOT inside a fold's hidden items -- i.e. loose,
// individually rendered pills sitting directly in the thread.
const loosePills = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-session-event')).filter(
    (el) => !el.closest('.cyc-se-run-items') && !el.classList.contains('cyc-se-run-head')
  );

describe('a tail fold whose run keeps growing', () => {
  test('stays one fold; its count tracks the run; no loose pills accrete below it', () => {
    beforeEachSeed();
    const inner = mount();
    let t = DAY;
    const events: CycSessionEvent[] = [];
    const s = session([msg(1, t, 'user')], events);
    // Seed a fold: a run of COLLAPSE_MIN + 2 same-day session events.
    const seed = COLLAPSE_MIN + 2;
    for (let i = 0; i < seed; i++) events.push(ev((t += 1000)));
    paint(inner, s);
    expect(foldHeads(inner)).toHaveLength(1);
    expect(foldHeads(inner)[0].textContent).toBe(`${seed} background updates`);

    // The agent keeps working: same-day events arrive one render at a time.
    const extra = 40;
    for (let i = 0; i < extra; i++) {
      events.push(ev((t += 1000)));
      paint(inner, s);
    }

    // One fold, count == whole run, and nothing loose accreted below it.
    expect(foldHeads(inner)).toHaveLength(1);
    expect(foldHeads(inner)[0].textContent).toBe(`${seed + extra} background updates`);
    expect(loosePills(inner)).toHaveLength(0);
    clearMessages(inner);
  });

  test('a sub-threshold tail run that grows past COLLAPSE_MIN folds, as a fresh paint would', () => {
    beforeEachSeed();
    const inner = mount();
    let t = DAY;
    const events: CycSessionEvent[] = [];
    const s = session([msg(1, t, 'user')], events);
    // Below the threshold: individual pills, no fold (feature renders as before).
    for (let i = 0; i < COLLAPSE_MIN - 1; i++) {
      events.push(ev((t += 1000)));
      paint(inner, s);
    }
    expect(foldHeads(inner)).toHaveLength(0);
    expect(loosePills(inner).length).toBe(COLLAPSE_MIN - 1);

    // Cross the threshold: the run must now fold, matching a fresh rebuild.
    events.push(ev((t += 1000)));
    paint(inner, s);
    expect(foldHeads(inner)).toHaveLength(1);
    expect(foldHeads(inner)[0].textContent).toBe(`${COLLAPSE_MIN} background updates`);
    expect(loosePills(inner)).toHaveLength(0);

    // The incremental result matches a from-scratch paint of the same store.
    const fresh = mount();
    paint(fresh, s);
    expect(foldHeads(inner)[0].textContent).toBe(foldHeads(fresh)[0].textContent);
    clearMessages(inner);
    clearMessages(fresh);
  });

  test('a message arriving after a grown tail fold still paints below it', () => {
    beforeEachSeed();
    const inner = mount();
    let t = DAY;
    const events: CycSessionEvent[] = [];
    const s = session([msg(1, t, 'user')], events);
    for (let i = 0; i < COLLAPSE_MIN + 5; i++) events.push(ev((t += 1000)));
    paint(inner, s);
    for (let i = 0; i < 10; i++) {
      events.push(ev((t += 1000)));
      paint(inner, s);
    }
    s.messages.push(msg(2, (t += 1000), 'claude'));
    paint(inner, s);
    expect(inner.querySelector('.cyc-message[data-mid="2"]')).not.toBeNull();
    // The fold count did not swallow the message and is still the run length.
    expect(foldHeads(inner)).toHaveLength(1);
    expect(foldHeads(inner)[0].textContent).toBe(`${COLLAPSE_MIN + 15} background updates`);
    clearMessages(inner);
  });
});

describe('the incremental reuse never freezes the list', () => {
  test('a reuse pass that throws falls back to a full rebuild and logs render.rebuild-fallback', async () => {
    const logging = await import('../shared/logging');
    const spy = vi.spyOn(logging, 'cyclog');
    const inner = mount();
    const events: CycSessionEvent[] = [];
    const s = session([msg(1, DAY, 'user'), msg(2, DAY + 1000, 'claude')], events);
    paint(inner, s);
    expect(inner.querySelectorAll('.cyc-message[data-mid]')).toHaveLength(2);

    // Poison one message so the NEXT paint throws while walking the store, then
    // heal it the instant the fallback logs, so the from-scratch retry succeeds.
    const poison = s.messages[1] as CycMessage & {__boom?: boolean};
    let boom = true;
    Object.defineProperty(poison, 'text', {
      configurable: true,
      get() {
        if (boom) throw new Error('boom');
        return 'healed';
      }
    });
    spy.mockImplementation((event: string) => {
      if (event === 'render.rebuild-fallback') boom = false;
    });

    s.messages.push(msg(3, DAY + 2000, 'claude'));
    expect(() => paint(inner, s)).not.toThrow();
    expect(spy).toHaveBeenCalledWith('render.rebuild-fallback', expect.anything());
    // The list repainted from scratch rather than freezing.
    expect(inner.querySelectorAll('.cyc-message[data-mid]').length).toBeGreaterThanOrEqual(3);
    clearMessages(inner);
  });
});

function beforeEachSeed() {
  evCtr = 0;
}
