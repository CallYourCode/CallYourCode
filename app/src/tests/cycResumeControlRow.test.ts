import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import type {CycMessage, CycSession} from '../types';
import {renderMessages} from '../features/chat/surface/messageList';
import {chatRow} from '../features/chat/navigation/chatRow';
import {fmtTime, isResumeControlRow} from '../features/chat/content';
import {setPresentationTheme} from '../components/presentation';

// TASK B: a control-answer row (the transcript line the engine records when the
// owner answers a terminal prompt from the app, formatted `↩ <label>`) is real
// history and stays in the store, but it is a control INPUT, not a message: it
// paints no bubble, never becomes the roster preview, and never sets the
// last-activity clock. A normal user row still does all three.

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const NOW = 1_700_000_000_000;
const MIN = 60_000;

beforeEach(() => {
  (globalThis as unknown as {IntersectionObserver: unknown}).IntersectionObserver = FakeIO;
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document.body.innerHTML = '';
});

const m = (over: Omit<Partial<CycMessage>, 'id'> & {id: number}): CycMessage =>
  ({
    role: 'claude',
    kind: 'text',
    text: 'row ' + over.id,
    ts: NOW,
    ...over,
    id: String(over.id)
  }) as CycMessage;

const RESUME = '↩ Resume full session as-is';

function session(messages: CycMessage[], over: Partial<CycSession> = {}): CycSession {
  return {
    id: 's1',
    name: 'Relay',
    cwd: '/srv',
    unread: 0,
    muted: false,
    thinking: false,
    lastActivity: 0,
    messages,
    ...over
  } as unknown as CycSession;
}

const bubbles = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]'));

describe('the predicate matches only the engine control-answer shape', () => {
  test('a user row with the ↩ prefix matches; arbitrary user text does not', () => {
    expect(isResumeControlRow({role: 'user', text: RESUME})).toBe(true);
    expect(isResumeControlRow({role: 'user', text: '↩ Yes'})).toBe(true);
    // a real message that merely mentions resume is NOT a control row
    expect(isResumeControlRow({role: 'user', text: 'can you resume full session as-is?'})).toBe(
      false
    );
    // a claude row is never a control answer
    expect(isResumeControlRow({role: 'claude', text: RESUME})).toBe(false);
  });
});

describe('a control-answer row paints no bubble while normal rows do', () => {
  test('the ↩ row is absent from the transcript; the user and claude rows render', () => {
    const s = session([
      m({id: 1, role: 'user', text: 'hello there', ts: NOW - 3 * MIN}),
      m({id: 2, role: 'user', text: RESUME, ts: NOW - 2 * MIN}),
      m({id: 3, role: 'claude', text: 'welcome back', ts: NOW - MIN})
    ]);
    const inner = document.createElement('div');
    document.body.append(inner);
    renderMessages(inner, s, () => {});

    // Two bubbles, not three: the control-answer row is filtered out.
    expect(bubbles(inner)).toHaveLength(2);
    expect(inner.textContent).toContain('hello there');
    expect(inner.textContent).toContain('welcome back');
    expect(inner.textContent).not.toContain('Resume full session as-is');
    // The row was never removed from the session's own array (kept in history).
    expect(s.messages).toHaveLength(3);
    expect(s.messages.some((x) => x.text === RESUME)).toBe(true);
  });
});

describe('a control-answer row drives neither the preview nor the clock', () => {
  const timeText = (row: HTMLElement) =>
    row.querySelector<HTMLElement>('.cyc-list-row-time')?.textContent ?? '';
  const subText = (row: HTMLElement) =>
    row.querySelector<HTMLElement>('.cyc-list-row-subtitle')?.textContent ?? '';

  test('the newest row being a ↩ answer: preview and clock read the real row before it', () => {
    const s = session([
      m({id: 1, role: 'user', text: 'ship it', ts: NOW - 5 * MIN}),
      m({id: 2, role: 'user', text: RESUME, ts: NOW - MIN})
    ]);
    const row = chatRow(s, {now: NOW});
    // The clock is the real user row's time, not the control answer's.
    expect(timeText(row)).toBe(fmtTime(NOW - 5 * MIN));
    expect(timeText(row)).not.toBe(fmtTime(NOW - MIN));
    // The preview is the real user row, not "↩ ...".
    expect(subText(row)).toContain('ship it');
    expect(subText(row)).not.toContain('Resume full session as-is');
  });

  test('a normal user row as the newest still drives the preview and clock', () => {
    const s = session([
      m({id: 1, role: 'claude', text: 'earlier', ts: NOW - 5 * MIN}),
      m({id: 2, role: 'user', text: 'do the thing', ts: NOW - MIN})
    ]);
    const row = chatRow(s, {now: NOW});
    expect(timeText(row)).toBe(fmtTime(NOW - MIN));
    expect(subText(row)).toContain('do the thing');
  });
});
