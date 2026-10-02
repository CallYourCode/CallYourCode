import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {renderMessages, COLLAPSE_MIN} from '../features/chat/surface/messageList';

// THE GAP ROW (fix-sync-gap). While the store knows rows are missing inside the
// open window it hands the list a `gap` row at that point (door.ts s.gaps); the
// list paints it as a service chip between the rows on either side, so a hole is
// never shown as two adjacent messages, and drops it when the page lands. It is
// never folded into a run of session events, whatever surrounds it.

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

const session = (messages: CycMessage[]): CycSession =>
  ({id: 's1', name: 'p', cwd: '/x', unread: 0, muted: false, messages}) as unknown as CycSession;
const msg = (id: number, ts: number): CycMessage =>
  ({id: 'm:' + id, role: 'claude', kind: 'text', text: 'm' + id, ts}) as CycMessage;
const gap = (ts: number, text: string): CycSessionEvent =>
  ({uuid: 'gap:' + ts, ts, kind: 'gap', text, seq: 0}) as CycSessionEvent;
const tool = (n: number, ts: number): CycSessionEvent =>
  ({uuid: 'e' + n, ts, kind: 'tool', text: 'ev ' + n, tool: 'Read'}) as CycSessionEvent;

const mount = (): HTMLElement => {
  const inner = document.createElement('div');
  document.body.append(inner);
  return inner;
};

const order = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message')).map((el) =>
    el.classList.contains('cyc-gap-marker')
      ? 'GAP'
      : el.classList.contains('cyc-session-event')
        ? 'EV'
        : el.classList.contains('cyc-msg-system')
          ? 'DATE'
          : (el.textContent ?? '').trim()
  );

describe('the gap row', () => {
  test('stands between the rows on either side of the hole, and leaves when the hole fills', () => {
    const inner = mount();
    const before = msg(1, DAY + 1000);
    const after = msg(2, DAY + 5000);
    const s = session([before, after]);
    renderMessages(inner, s, () => {}, undefined, undefined, undefined, [
      gap(DAY + 1000, 'Loading 65 missing messages...')
    ]);
    const shown = order(inner).filter((x) => x !== 'DATE');
    expect(shown[0]).toContain('m1');
    expect(shown[1]).toBe('GAP');
    expect(shown[2]).toContain('m2');
    expect(inner.querySelector('.cyc-gap-marker')!.textContent).toBe(
      'Loading 65 missing messages...'
    );

    const keptNode = inner.querySelector('[data-mid="m:1"]') ?? null;
    // the page landed: the missing message is in, the gap row is gone
    const filled = msg(3, DAY + 3000);
    s.messages = [before, filled, after];
    renderMessages(inner, s, () => {}, undefined, undefined, undefined, undefined);
    expect(inner.querySelector('.cyc-gap-marker')).toBeNull();
    const now = order(inner).filter((x) => x !== 'DATE');
    const at = (t: string) => now.findIndex((x) => x.includes(t));
    expect(at('m1')).toBeLessThan(at('m3'));
    expect(at('m3')).toBeLessThan(at('m2'));
    if (keptNode) expect(inner.querySelector('[data-mid="m:1"]')).toBe(keptNode);
  });

  test('a run of session events around it never folds it away', () => {
    const inner = mount();
    const evs: CycSessionEvent[] = [];
    for (let i = 0; i < COLLAPSE_MIN; i++) evs.push(tool(i, DAY + 100 + i));
    evs.push(gap(DAY + 200, 'Loading missing messages...'));
    for (let i = 0; i < COLLAPSE_MIN; i++) evs.push(tool(100 + i, DAY + 300 + i));
    const s = session([msg(1, DAY), msg(2, DAY + 1000)]);
    renderMessages(inner, s, () => {}, undefined, undefined, undefined, evs);
    const marker = inner.querySelector<HTMLElement>('.cyc-gap-marker');
    expect(marker).not.toBeNull();
    expect(marker!.closest('.cyc-se-run-items')).toBeNull();
    expect(marker!.textContent).toBe('Loading missing messages...');
  });
});
