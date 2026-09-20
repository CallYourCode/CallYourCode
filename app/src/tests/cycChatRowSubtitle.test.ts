import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {chatRow} from '../features/chat/navigation/chatRow';
import {setPresentationTheme} from '../components/presentation';
import type {CycSession} from '../types';

const NOW = 1_700_000_000_000;

const sess = (over: Partial<CycSession> = {}): CycSession =>
  ({
    id: 's1',
    name: 'Relay Server',
    messages: [],
    unread: 0,
    muted: false,
    thinking: false,
    cwd: '/srv/relay',
    lastActivity: 0,
    ...over
  }) as unknown as CycSession;

const mirror = (over: Partial<CycSession> = {}): CycSession =>
  sess({title: {text: 'claude', detail: null}, turnSince: NOW - 3 * 60000, ...over});

const subtitleOf = (s: CycSession, opts = {}) => {
  const el = chatRow(s, {now: NOW, ...opts}).querySelector('.cyc-list-row-subtitle') as HTMLElement;
  const dots = el.querySelector('.cyc-busy-dots');
  const suffix = el.querySelector('.cyc-typing-suffix');
  return {
    text: dots ? null : el.textContent,
    dots: !!dots,
    suffix: suffix ? suffix.textContent : null,
    ariaLabel: dots ? el.querySelector('.cyc-typing-status')?.getAttribute('aria-label') : null,
    working: el.classList.contains('cyc-list-row-working')
  };
};

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('chat row subtitle shows the dots glyph, not the word, when busy', () => {
  test('working mirror row: dots + a space then the age suffix, in the accent', () => {
    expect(subtitleOf(mirror({status: 'working'}))).toEqual({
      text: null,
      dots: true,
      suffix: ' 3m',
      ariaLabel: 'working, 3m',
      working: true
    });
  });

  test('working mirror row without a turn falls back to the agent name', () => {
    expect(subtitleOf(mirror({status: 'working', turnSince: undefined}))).toEqual({
      text: null,
      dots: true,
      suffix: ' Claude',
      ariaLabel: 'working, Claude',
      working: true
    });
  });

  test('thinking mirror row carries the elapsed time as a suffix past the dots', () => {
    expect(subtitleOf(mirror({status: 'working', thinking: true}))).toEqual({
      text: null,
      dots: true,
      suffix: ' 3m',
      ariaLabel: 'thinking, 3m',
      working: true
    });
  });

  test('thinking mirror row without a turn: bare dots, no suffix', () => {
    expect(subtitleOf(mirror({status: 'working', thinking: true, turnSince: undefined}))).toEqual({
      text: null,
      dots: true,
      suffix: '',
      ariaLabel: 'thinking',
      working: true
    });
  });

  test('thinking non-mirror row: bare dots in the accent too', () => {
    expect(subtitleOf(sess({thinking: true}))).toEqual({
      text: null,
      dots: true,
      suffix: '',
      ariaLabel: 'thinking',
      working: true
    });
  });

  test('sending wins over working, and stays a plain word (not dots)', () => {
    const s = mirror({
      status: 'working',
      messages: [{id: 'm1', role: 'user', text: 'hi', ts: NOW, status: 'sending'}] as any
    });
    expect(subtitleOf(s)).toEqual({
      text: 'Sending…',
      dots: false,
      suffix: null,
      ariaLabel: null,
      working: true
    });
  });

  test('idle mirror row: bare age, no working class, no dots', () => {
    expect(subtitleOf(mirror({status: 'done'}))).toEqual({
      text: '3m',
      dots: false,
      suffix: null,
      ariaLabel: null,
      working: false
    });
  });

  // The stuck-send defect: a send from days ago whose intent the engine already
  // took resurrects a 'sending' bubble on boot. It must NOT stamp the row
  // "Sending…" when a delivered row is newer -- the chat has moved on.
  test('a resurrected old send behind a newer delivered row does not say Sending', () => {
    // The delivered reply sits EARLIER in the array but its ts is newer: the
    // resurrected send was pushed to the tail by the old paint, so the naive
    // last-row read would call the whole row "Sending…".
    const s = mirror({
      status: 'done',
      messages: [
        {id: 'new', role: 'claude', text: 'a later reply', ts: NOW - 60000, dedupeKey: 'k'},
        {
          id: 'old',
          role: 'user',
          text: 'Resume full session as-is',
          ts: NOW - 3 * 86400000,
          status: 'sending'
        }
      ] as any
    });
    expect(subtitleOf(s).text).not.toBe('Sending…');
  });

  // A genuine pending send that IS the newest word still shows Sending.
  test('a fresh pending send that is the newest row still says Sending', () => {
    const s = mirror({
      status: 'done',
      messages: [
        {id: 'old', role: 'claude', text: 'earlier reply', ts: NOW - 60000, dedupeKey: 'k'},
        {id: 'new', role: 'user', text: 'send me now', ts: NOW, status: 'sending'}
      ] as any
    });
    expect(subtitleOf(s).text).toBe('Sending…');
  });
});

// 2026-09-02: the owner saw "thinking · 3m" (0.8rem via chat.css) and "19m" (inline
// 1rem) at two sizes on the list and asked for one size a step under the title.
// The subtitle is now 0.875rem (14px) inline !important in every state; busy and
// idle differ by colour only, and the line-height stays so the row height holds.
describe('subtitle is one size, 0.875rem, in every state', () => {
  const subEl = (s: CycSession) =>
    chatRow(s, {now: NOW}).querySelector('.cyc-list-row-subtitle') as HTMLElement;

  const expectOneSize = (el: HTMLElement) => {
    expect(el.style.getPropertyValue('font-size')).toBe('0.875rem');
    expect(el.style.getPropertyPriority('font-size')).toBe('important');
    expect(el.style.getPropertyValue('line-height')).toBe('1.375rem');
    expect(el.style.getPropertyPriority('line-height')).toBe('important');
  };

  test('busy row: 0.875rem!important, line-height 1.375rem', () => {
    expectOneSize(subEl(mirror({status: 'working', thinking: true})));
  });

  test('idle row: the same 0.875rem!important', () => {
    expectOneSize(subEl(mirror({status: 'done'})));
  });

  test('sync busy -> idle -> busy never changes the size', () => {
    const row = chatRow(mirror({status: 'working', thinking: true}), {now: NOW}) as any;
    const el = row.querySelector('.cyc-list-row-subtitle') as HTMLElement;
    expectOneSize(el);
    row._cycSync(mirror({status: 'done'}), {now: NOW});
    expectOneSize(el);
    expect(el.classList.contains('cyc-list-row-working')).toBe(false);
    row._cycSync(mirror({status: 'working'}), {now: NOW});
    expectOneSize(el);
    expect(el.classList.contains('cyc-list-row-working')).toBe(true);
    expect(el.querySelector('.cyc-busy-dots')).not.toBeNull();
    expect(el.querySelector('.cyc-typing-suffix')?.textContent).toBe(' 3m');
  });
});
