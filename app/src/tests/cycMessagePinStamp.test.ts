import {afterEach, beforeEach, expect, test} from 'vitest';
import type {CycMessage} from '../types';
import type {CycEngineSession} from '../engine/store';
import {renderMessages, clearMessages} from '../features/chat/surface/messageList';
import {makeIcon} from '../components/iconGlyphs';

let inner: HTMLElement;
const message = (id: string, text = id): CycMessage => ({
  id, text, ts: 1_700_000_000_000, role: 'user', kind: 'text'
});
const chat = (messages = [message('m:pinned'), message('m:plain')]): CycEngineSession => ({
  id: 'chat', name: 'test', cwd: '/scratch', unread: 0, muted: false,
  messages, settings: {pins: []}
}) as CycEngineSession;
const pin = (s: CycEngineSession, id = 'm:pinned') => {
  s.settings!.pins = [{id, ts: s.messages[0].ts, role: 'user', snippet: 'pinned', pinnedAt: 1}];
};
const paint = (s: CycEngineSession) => renderMessages(inner, s, () => {});
const row = (id = 'm:pinned') => inner.querySelector<HTMLElement>(`[data-mid="${id}"]`)!;

beforeEach(() => {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  inner = document.createElement('div');
  document.body.append(inner);
});
afterEach(() => {
  clearMessages(inner);
  inner.remove();
});

test('pinned indicator is the existing pin glyph immediately before Copy, not an action', () => {
  const s = chat();
  pin(s);
  paint(s);
  const copy = row().querySelector('[data-act="copy"]')!;
  const indicator = copy.previousElementSibling!;
  expect(indicator?.getAttribute('aria-label')).toBe('Pinned');
  expect(indicator.tagName).toBe('SPAN');
  expect(indicator.getAttribute('role')).toBe('img');
  expect(indicator.hasAttribute('data-act')).toBe(false);
  expect(indicator.hasAttribute('tabindex')).toBe(false);
  expect(indicator.querySelector('svg')?.outerHTML).toBe(makeIcon('pin').querySelector('svg')!.outerHTML);
  expect(indicator.classList.contains('opacity-70')).toBe(true);
  expect(row('m:plain').querySelector('[aria-label="Pinned"]')).toBeNull();
});

test('unpinned stamps retain Copy, Quote, time and delivery status with no placeholder', () => {
  paint(chat());
  const stamp = row().querySelector('.cyc-stamp')!;
  expect(stamp.querySelector('[aria-label="Pinned"]')).toBeNull();
  expect(stamp.firstElementChild?.getAttribute('data-act')).toBe('copy');
  expect(stamp.children).toHaveLength(3);
});

test('settings-only toggles patch the mounted bubble in place and remain chat-local', () => {
  const s = chat();
  paint(s);
  const original = row();
  const copy = original.querySelector('[data-act="copy"]');
  inner.scrollTop = 42;
  pin(s);
  paint(s);
  expect(row()).toBe(original);
  expect(row().querySelector('[data-act="copy"]')).toBe(copy);
  expect(row().querySelectorAll('[aria-label="Pinned"]')).toHaveLength(1);
  expect(inner.scrollTop).toBe(42);
  paint(s);
  expect(row().querySelectorAll('[aria-label="Pinned"]')).toHaveLength(1);
  s.settings!.pins = [];
  paint(s);
  expect(row()).toBe(original);
  expect(row().querySelector('[aria-label="Pinned"]')).toBeNull();
  pin(s);
  paint(s);
  expect(row().querySelector('[aria-label="Pinned"]')).not.toBeNull();
  const other = {...chat(), id: 'other'};
  paint(other);
  expect(row().querySelector('[aria-label="Pinned"]')).toBeNull();
});

test('media-only stamps keep the existing hidden-actions rule', () => {
  const s = chat([{...message('m:pinned', ''), file: {
    docId: 'image', name: 'image.png', fileKind: 'image'
  }} as CycMessage]);
  pin(s);
  paint(s);
  expect(row().classList.contains('cyc-msg-media-only')).toBe(true);
  expect(row().querySelector('[aria-label="Pinned"]')).toBeNull();
});
