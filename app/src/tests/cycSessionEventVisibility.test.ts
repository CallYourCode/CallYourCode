/* WHICH SESSION EVENTS THE CHAT STRIP SHOWS (owner, 2026-09-06: "keep it
 * simple. even the echos and whatever can show. nothing needs to be hidden.
 * the behaviour earlier was right").
 *
 * The rule: the full pre-2026-09-05 pill set is back, unconditionally.
 * prompt, reply, tool, compact and interrupt all paint as plain grey session
 * pills, echoes included; there is no pairing or hiding logic. What machine
 * input never gets is a chat BUBBLE: a cron fire or an agent-to-agent message
 * renders as a session pill (the SCHEDULED special card is gone with the
 * reverted chat-row feature), and chat role stays truthful.
 *
 *   bunx vitest run src/tests/cycSessionEventVisibility.test.ts
 */

import {beforeEach, afterEach, describe, expect, test} from 'vitest';

import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {
  renderMessages,
  clearMessages,
  VISIBLE_EVENT_KINDS,
  COLLAPSE_MIN
} from '../features/chat/surface/messageList';

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

let nextId = 1;
const msg = (over: Partial<CycMessage>): CycMessage =>
  ({id: nextId++, role: 'claude', kind: 'text', text: 'hi', ts: 0, ...over}) as CycMessage;

const ev = (over: Partial<CycSessionEvent> & {ts: number; kind: string}): CycSessionEvent =>
  ({uuid: `u${nextId++}`, text: 'x', ...over}) as CycSessionEvent;

const sessionOf = (messages: CycMessage[]): CycSession =>
  ({id: 's', name: 'x', messages, unread: 0}) as unknown as CycSession;

const render = (messages: CycMessage[], events: CycSessionEvent[]) => {
  const inner = document.createElement('div');
  renderMessages(inner, sessionOf(messages), () => {}, undefined, undefined, undefined, events);
  return inner;
};

test('the pill set is the whole pre-2026-09-05 one: prompt and reply are back, unconditionally', () => {
  expect([...VISIBLE_EVENT_KINDS].sort()).toEqual([
    'compact',
    'interrupt',
    'prompt',
    'reply',
    'tool'
  ]);
});

describe('machine-delivered input is ONE thing: a grey session pill, never a bubble or card', () => {
  test('a cron-delivered input renders as a session pill with its cron chip, not a card, not a bubble', () => {
    const inner = render(
      [],
      [ev({ts: 1000, kind: 'prompt', source: 'cron', text: '> SCHEDULED (visibility-test): ping'})]
    );
    const pill = inner.querySelector('.cyc-message.cyc-session-event.cyc-se-prompt')!;
    expect(pill, 'the cron input must paint as a session pill').not.toBeNull();
    expect(pill.classList.contains('cyc-msg-system')).toBe(true);
    expect(pill.querySelector('.cyc-se-source')!.textContent).toBe('cron');
    expect(pill.querySelector('.cyc-se-body')!.textContent).toContain('visibility-test');
    // and it is the ONLY rendering: no chat bubble, own-side or incoming
    expect(inner.querySelector('.cyc-text-message')).toBeNull();
    expect(inner.querySelector('.cyc-msg-sent')).toBeNull();
    expect(inner.querySelector('.cyc-msg-received')).toBeNull();
    clearMessages(inner);
  });

  test('an agent-to-agent input renders as a session pill the same way', () => {
    const inner = render(
      [],
      [ev({ts: 1000, kind: 'prompt', source: 'agent', sender: 'ag-x', text: '> ag-x: tick'})]
    );
    expect(inner.querySelector('.cyc-session-event.cyc-se-prompt')).not.toBeNull();
    expect(inner.querySelector('.cyc-msg-sent')).toBeNull();
    clearMessages(inner);
  });
});

describe('nothing is hidden: reply pills paint even beside a real agent bubble', () => {
  test('a terminal-only reply paints (the cron turn that skipped the chat tool)', () => {
    const inner = render(
      [],
      [
        ev({ts: 1000, kind: 'prompt', source: 'cron', text: '> SCHEDULED (weigh-in): prompt'}),
        ev({ts: 2000, kind: 'reply', text: 'Skipping the weight prompt silently'})
      ]
    );
    const pill = inner.querySelector('.cyc-session-event.cyc-se-reply')!;
    expect(pill).not.toBeNull();
    expect(pill.querySelector('.cyc-se-body')!.textContent).toContain('Skipping');
    clearMessages(inner);
  });

  test('a reply beside an agent bubble in the same turn STILL paints (echoes are fine)', () => {
    const inner = render(
      [msg({role: 'claude', text: 'Done', ts: 1500})],
      [
        ev({ts: 1000, kind: 'prompt', source: 'cron', text: '> SCHEDULED (weigh-in): prompt'}),
        ev({ts: 2000, kind: 'reply', text: 'Done, said in chat too'})
      ]
    );
    expect(inner.querySelector('.cyc-session-event.cyc-se-reply')).not.toBeNull();
    expect(inner.querySelector('.cyc-session-event.cyc-se-prompt')).not.toBeNull();
    clearMessages(inner);
  });
});

// A mixed-kind run of consecutive session events collapses into one expandable
// head. HIDE NOTHING: the fold expands to the exact same pills that render
// today. The human's message bubbles are the anchors that break a run.
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', {bubbles: true}));

// A run of DISTINCT-kind events (a lone burst never accidentally hits the
// pure-tool short-burst grouping) at a given day, one per second.
const mixedRun = (n: number, day = 0): CycSessionEvent[] => {
  const kinds = ['prompt', 'tool', 'reply', 'compact', 'interrupt'];
  const out: CycSessionEvent[] = [];
  const base = day * 86_400_000;
  for (let i = 0; i < n; i++)
    out.push(ev({ts: base + 1000 * (i + 1), kind: kinds[i % kinds.length], text: `u${i}`}));
  return out;
};

describe('long autonomous session runs fold into one expandable "N background updates" row', () => {
  test(`a run of COLLAPSE_MIN (${COLLAPSE_MIN}) mixed events folds into ONE head, hidden pills expand on click`, () => {
    const events = mixedRun(COLLAPSE_MIN);
    const inner = render([], events);
    const heads = inner.querySelectorAll<HTMLElement>('.cyc-se-run-head');
    expect(heads.length).toBe(1);
    const head = heads[0];
    // Non-vacuity: the head count equals the run length.
    expect(head.textContent).toBe(`${COLLAPSE_MIN} background updates`);
    // No loose pills outside the fold; every pill is hidden inside the items.
    const items = inner.querySelector<HTMLElement>('.cyc-se-run-items')!;
    expect(items.querySelectorAll('.cyc-session-event').length).toBe(COLLAPSE_MIN);
    const wrap = inner.querySelector<HTMLElement>('.cyc-se-run')!;
    expect(wrap.classList.contains('cyc-se-expanded')).toBe(false);
    click(head);
    expect(wrap.classList.contains('cyc-se-expanded')).toBe(true);
    // Expanded shows the same N pills, same order, same content.
    const pills = items.querySelectorAll<HTMLElement>('.cyc-session-event .cyc-se-body');
    expect(pills.length).toBe(COLLAPSE_MIN);
    expect([...pills].map((p) => p.textContent)).toEqual(events.map((_, i) => `u${i}`));
    clearMessages(inner);
  });

  test(`a run of COLLAPSE_MIN-1 (${COLLAPSE_MIN - 1}) events renders individually, no fold head`, () => {
    const events = mixedRun(COLLAPSE_MIN - 1);
    const inner = render([], events);
    expect(inner.querySelector('.cyc-se-run-head')).toBeNull();
    expect(inner.querySelectorAll('.cyc-message.cyc-session-event').length).toBe(COLLAPSE_MIN - 1);
    clearMessages(inner);
  });

  test('a human message between two bursts breaks the run; each sub-threshold burst renders individually', () => {
    const before = mixedRun(COLLAPSE_MIN - 1);
    const after = mixedRun(COLLAPSE_MIN - 1).map((e, i) => ({
      ...e,
      ts: e.ts + 100_000,
      uuid: `after${i}`
    }));
    const human = msg({role: 'user', text: 'ping', ts: 50_000});
    const inner = render([human], [...before, ...after]);
    // The message split both bursts below threshold, so neither folds.
    expect(inner.querySelector('.cyc-se-run-head')).toBeNull();
    expect(inner.querySelectorAll('.cyc-message.cyc-session-event').length).toBe(
      (COLLAPSE_MIN - 1) * 2
    );
    clearMessages(inner);
  });

  test('a date divider between events splits the run: neither day folds below threshold', () => {
    const day0 = mixedRun(COLLAPSE_MIN - 1, 0);
    const day1 = mixedRun(COLLAPSE_MIN - 1, 1).map((e, i) => ({...e, uuid: `d1_${i}`}));
    const inner = render([], [...day0, ...day1]);
    expect(inner.querySelector('.cyc-se-run-head')).toBeNull();
    expect(inner.querySelectorAll('.cyc-message.cyc-session-event').length).toBe(
      (COLLAPSE_MIN - 1) * 2
    );
    clearMessages(inner);
  });
});
