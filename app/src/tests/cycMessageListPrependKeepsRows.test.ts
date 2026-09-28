import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {renderMessages, clearMessages} from '../features/chat/surface/messageList';

// 2026-09-28, the owner: loading older chat history drops the reader's text
// selection. The cause was the store PREPEND repainting the visible window at
// the pre-re-seat scroll offset, which landed on the newly-prepended older rows
// and rebuilt (or re-parented) the rows the reader was looking at -- detaching
// their DOM nodes and collapsing the selection range. The fix HOLDS the current
// window while a selection is live in the list: no mounted row is rebuilt, moved
// or re-parented, so a range anchored in one of them survives the prepend (and a
// live append, and a measurement settle). These pin that at the messageList seam
// jsdom can express -- node identity is what a live Selection hangs off. With no
// selection the list windows exactly as before (covered by the window/reuse
// suites); the hold is scoped to an active selection.

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  (globalThis as unknown as {IntersectionObserver: unknown}).IntersectionObserver = FakeIO;
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

const DAY_MS = 86_400_000;
const D0 = 1_700_000_000_000;
type Chat = CycSession & {events?: CycSessionEvent[]};

let msgCtr = 0;
let evCtr = 0;
const msg = (ts: number, role: CycMessage['role']): CycMessage =>
  ({id: 'm' + msgCtr++, role, kind: 'text', text: 'a message with enough words to select from ' + msgCtr, ts}) as CycMessage;
const ev = (ts: number): CycSessionEvent =>
  ({uuid: 'e' + evCtr++, ts, kind: 'tool', text: 'ev', tool: 'Read'}) as CycSessionEvent;

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

function mount(w = 1440, h = 900) {
  const scroll = document.createElement('div');
  scroll.className = 'cyc-message-list-scroll';
  const inner = document.createElement('div');
  scroll.append(inner);
  document.body.append(scroll);
  let top = 0;
  Object.defineProperty(scroll, 'clientHeight', {value: h, configurable: true});
  Object.defineProperty(scroll, 'offsetHeight', {value: h, configurable: true});
  Object.defineProperty(scroll, 'clientWidth', {value: w, configurable: true});
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
const rowOf = (inner: HTMLElement, id: string) =>
  inner.querySelector<HTMLElement>(`.cyc-message[data-mid="${id}"]`);
const olderTurns = (n: number): CycMessage[] => {
  const out: CycMessage[] = [];
  for (let i = 0; i < n; i++) out.push(msg(D0 - (n - i) * 3_600_000, i % 2 ? 'claude' : 'user'));
  return out;
};

// Select some text inside `row` (the reader's highlight), returning the text
// node the range is anchored in.
function selectIn(row: HTMLElement): Text {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let t: Node | null = null;
  while ((t = walker.nextNode())) if ((t.textContent ?? '').trim().length > 8) break;
  const textNode = t as Text;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 8);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return textNode;
}

describe('an older-history prepend never touches the row holding the selection', () => {
  test('the selected row is the SAME element after the prepend, and its text node survives', () => {
    const s = bigChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 30_000;
    paint(inner, s);
    const mounted = Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]'));
    expect(mounted.length).toBeGreaterThan(5);
    const picked = mounted[Math.floor(mounted.length / 2)];
    const pickedId = picked.dataset.mid!;
    const textNode = selectIn(picked);
    expect(window.getSelection()!.toString().length).toBeGreaterThan(0);

    // Older history arrives (a loadOlder prepend): 40 older turns unshifted.
    s.messages.unshift(...olderTurns(40));
    paint(inner, s);

    // The selected row was neither rebuilt nor re-parented: identical element,
    // still connected, its text node (the range's container) still in the tree.
    expect(rowOf(inner, pickedId)).toBe(picked);
    expect(picked.isConnected).toBe(true);
    expect(document.contains(textNode)).toBe(true);
  });

  test('every mounted row is kept (the window is held) while a selection is live', () => {
    const s = bigChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 30_000;
    paint(inner, s);
    const mounted = Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]'));
    const byId = new Map(mounted.map((el) => [el.dataset.mid!, el]));
    selectIn(mounted[Math.floor(mounted.length / 2)]);

    s.messages.unshift(...olderTurns(40));
    paint(inner, s);

    // No mounted row was rebuilt, moved out, or duplicated.
    for (const [id, el] of byId) {
      const now = rowOf(inner, id);
      expect(now).toBe(el);
      expect(el.isConnected).toBe(true);
    }
    const afterIds = Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]')).map(
      (e) => e.dataset.mid!
    );
    expect(new Set(afterIds).size).toBe(afterIds.length);
    clearMessages(inner);
  });

  test('a live message arrival does not collapse a selection either', () => {
    const s = bigChat();
    const {scroll, inner} = mount();
    scroll.scrollTop = 30_000;
    paint(inner, s);
    const mounted = Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]'));
    const picked = mounted[Math.floor(mounted.length / 2)];
    const pickedId = picked.dataset.mid!;
    const textNode = selectIn(picked);

    // A new message lands at the tail (a live append) while the reader selects.
    s.messages.push(msg(D0 + 999 * DAY_MS, 'claude'));
    paint(inner, s);

    expect(rowOf(inner, pickedId)).toBe(picked);
    expect(document.contains(textNode)).toBe(true);
    clearMessages(inner);
  });
});
