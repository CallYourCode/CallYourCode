import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {renderMessages, clearMessages, messageDomEpoch} from '../features/chat/surface/messageList';

// 2026-09-02, the owner's phone: "the whole conversation rerenders on every
// chunk of the message". The list paints from the store on every notify and
// reuses the rows whose signature did not change; these pin down that a paint
// for an arriving or closing-out reply touches only that reply's row. Every
// other row keeps its element, its group and its day section, and the row
// above a new same-role neighbour has its group-end state flipped in place.

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

const DAY = 1_700_000_000_000;
const msg = (over: Omit<Partial<CycMessage>, 'id'> & {id: number}): CycMessage =>
  ({
    role: 'claude',
    kind: 'text',
    text: `row ${over.id}`,
    ts: DAY + over.id * 60_000,
    ...over,
    id: String(over.id)
  }) as CycMessage;

type Chat = CycSession & {events?: CycSessionEvent[]};

function session(messages: CycMessage[], events?: CycSessionEvent[]): Chat {
  return {
    id: 's1',
    name: 'p',
    cwd: '/x',
    unread: 0,
    muted: false,
    messages,
    events
  } as unknown as Chat;
}

function paint(inner: HTMLElement, s: Chat) {
  renderMessages(inner, s, () => {}, undefined, undefined, undefined, s.events);
}

// A list container attached to the document, so row.isConnected reads true
// while the row is in the tree and false the moment a paint detaches it.
const mount = (): HTMLElement => {
  const inner = document.createElement('div');
  document.body.append(inner);
  return inner;
};

const rows = (inner: HTMLElement) =>
  Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]'));
const rowOf = (inner: HTMLElement, id: number) =>
  inner.querySelector<HTMLElement>(`.cyc-message[data-mid="${id}"]`)!;

// Twelve rows of alternating user/claude turns, the last two claude in a row.
function history(): CycMessage[] {
  const out: CycMessage[] = [];
  for (let i = 1; i <= 12; i++) out.push(msg({id: i, role: i % 2 ? 'user' : 'claude'}));
  out.push(msg({id: 13, role: 'claude', text: 'and one more'}));
  return out;
}

// Records every mutation under `inner` so a paint can be judged by what it
// touched, not by what it ended up with. A node is named by its row id
// (data-mid) or its first class.
function watch(inner: HTMLElement) {
  const own = (n: Node) =>
    n.nodeType === 1
      ? ((n as HTMLElement).dataset.mid ?? (n as HTMLElement).className.split(' ')[0])
      : '#text';
  const seen: string[] = [];
  const fold = (records: MutationRecord[]) => {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) seen.push(`add ${own(n)}`);
      for (const n of Array.from(r.removedNodes)) seen.push(`remove ${own(n)}`);
      if (r.type === 'attributes') seen.push(`attr ${own(r.target)} ${r.attributeName}`);
      if (r.type === 'characterData') seen.push('text');
    }
  };
  const obs = new MutationObserver(fold);
  obs.observe(inner, {childList: true, attributes: true, characterData: true, subtree: true});
  return () => {
    fold(obs.takeRecords());
    return seen.splice(0);
  };
}

describe('a reply arriving touches only its own row', () => {
  test('appending a same-role row keeps every element; the row above flips its group end in place', () => {
    const inner = mount();
    const s = session(history());
    paint(inner, s);
    const before = rows(inner);
    expect(before).toHaveLength(13);
    const tail = rowOf(inner, 13);
    expect(tail.classList.contains('mb-2')).toBe(true);
    expect(tail.hasAttribute('data-cyc-last')).toBe(true);
    const group = tail.parentElement!;

    const take = watch(inner);
    s.messages.push(
      msg({
        id: 14,
        role: 'claude',
        text: 'the reply',
        msgId: 'r1',
        growing: true
      } as Omit<Partial<CycMessage>, 'id'> & {id: number})
    );
    paint(inner, s);
    const touched = take();

    // Nothing was removed; the only added row is the reply.
    expect(touched.filter((t) => t.startsWith('remove'))).toEqual([]);
    expect(touched.filter((t) => t.startsWith('add ') && /^add \d+$/.test(t))).toEqual(['add 14']);
    // Every earlier row is the same element, still in the same group.
    for (const el of before) expect(el.isConnected).toBe(true);
    expect(rowOf(inner, 13)).toBe(tail);
    expect(rowOf(inner, 14).parentElement).toBe(group);
    // The row above lost its group-end state in place.
    expect(tail.classList.contains('mb-2')).toBe(false);
    expect(tail.classList.contains('mb-1')).toBe(true);
    expect(tail.hasAttribute('data-cyc-last')).toBe(false);
    expect(rowOf(inner, 14).hasAttribute('data-cyc-last')).toBe(true);
    clearMessages(inner);
  });

  test('a reply closing out (growing cleared, duration set) rebuilds its row alone, in the same group', () => {
    const inner = mount();
    const s = session(history());
    const reply = msg({
      id: 14,
      role: 'user',
      text: 'the reply',
      msgId: 'r1',
      growing: true
    } as Omit<Partial<CycMessage>, 'id'> & {id: number});
    s.messages.push(reply);
    paint(inner, s);
    const before = rows(inner).slice(0, 13);
    const growingRow = rowOf(inner, 14);
    const group = growingRow.parentElement!;
    const section = group.parentElement!;

    const take = watch(inner);
    delete (reply as {growing?: boolean}).growing;
    (reply as {durationS?: number}).durationS = 24;
    paint(inner, s);
    const touched = take();

    // Only the reply's row came and went; its group and day section stayed.
    expect(touched.filter((t) => t.startsWith('remove'))).toEqual(['remove 14']);
    expect(touched.filter((t) => /^add \d+$/.test(t))).toEqual(['add 14']);
    expect(touched.some((t) => t.startsWith('remove cyc-message-group'))).toBe(false);
    expect(touched.some((t) => t.startsWith('remove cyc-date-group'))).toBe(false);
    for (const el of before) expect(el.isConnected).toBe(true);
    expect(rowOf(inner, 14)).not.toBe(growingRow);
    expect(rowOf(inner, 14).parentElement).toBe(group);
    expect(group.parentElement).toBe(section);
    expect(rowOf(inner, 13).hasAttribute('data-cyc-last')).toBe(true);
    clearMessages(inner);
  });

  test('a paint with nothing changed writes nothing', () => {
    const inner = mount();
    const s = session(history());
    paint(inner, s);
    const take = watch(inner);
    paint(inner, s);
    paint(inner, s);
    expect(take()).toEqual([]);
    clearMessages(inner);
  });

  test('a session event landing between rows keeps the rows before it', () => {
    const inner = mount();
    const s = session(history(), []);
    paint(inner, s);
    const before = rows(inner);
    const take = watch(inner);
    (s.events as CycSessionEvent[]).push({
      uuid: 'e1',
      ts: DAY + 13 * 60_000 + 1,
      kind: 'tool',
      text: 'Read x'
    } as CycSessionEvent);
    paint(inner, s);
    const touched = take();
    expect(touched.filter((t) => t.startsWith('remove'))).toEqual([]);
    for (const el of before) expect(el.isConnected).toBe(true);
    clearMessages(inner);
  });

  test('a trailing row leaving hands the group end back to the row above', () => {
    const inner = mount();
    const s = session(history());
    paint(inner, s);
    const row12 = rowOf(inner, 12);
    expect(row12.hasAttribute('data-cyc-last')).toBe(false);
    const take = watch(inner);
    s.messages.pop();
    paint(inner, s);
    const touched = take();
    expect(touched.filter((t) => t.startsWith('remove'))).toEqual(['remove 13']);
    expect(touched.filter((t) => /^add \d+$/.test(t))).toEqual([]);
    expect(rowOf(inner, 12)).toBe(row12);
    expect(row12.hasAttribute('data-cyc-last')).toBe(true);
    expect(row12.classList.contains('mb-2')).toBe(true);
    clearMessages(inner);
  });

  test('a day section emptied by a rebuild is pruned; a new day still opens its own', () => {
    const inner = mount();
    const s = session(history());
    const nextDay = msg({id: 20, role: 'user', ts: DAY + 2 * 86_400_000});
    s.messages.push(nextDay);
    paint(inner, s);
    expect(inner.querySelectorAll('.cyc-date-group')).toHaveLength(2);
    const take = watch(inner);
    s.messages.pop();
    paint(inner, s);
    const touched = take();
    expect(inner.querySelectorAll('.cyc-date-group')).toHaveLength(1);
    expect(touched.filter((t) => /^remove \d+$/.test(t))).toEqual(['remove 20']);
    expect(rowOf(inner, 13).hasAttribute('data-cyc-last')).toBe(true);
    clearMessages(inner);
  });
});

// 2026-09-05, the owner's phone: "the image just flickers a lot on sending".
// The pending photo bubble's row signature folded the per-chunk send
// percentage, so every acked chunk tore the row down and rebuilt it with a
// fresh <img> (blank until load); completion and adoption rebuilt it twice
// more, the first with a newly minted object URL. These pin the fixed shape:
// the percentage repaints in place, and any legitimate rebuild of the row
// carries the same <img> element (same src) instead of a fresh decode.
describe("an image send's bubble", () => {
  const urls: Record<string, string> = {'tk-1': 'blob:pic-1', 'up-9': 'blob:pic-1'};
  const srcOf = (m: CycMessage) => (m.upload ? (urls[m.upload.uploadId] ?? '') : '');
  const paintImg = (inner: HTMLElement, s: Chat) =>
    renderMessages(inner, s, () => {}, undefined, undefined, undefined, undefined, srcOf);
  const imageMsg = (over?: Partial<CycMessage>): CycMessage =>
    msg({
      id: 40,
      role: 'user',
      text: '',
      status: 'sending',
      sendPct: 0,
      upload: {
        uploadId: 'tk-1',
        name: 'p.jpg',
        mime: 'image/jpeg',
        size: 5,
        path: '',
        image: true,
        width: 100,
        height: 80
      },
      ...over
    } as Omit<Partial<CycMessage>, 'id'> & {id: number});
  const imgOf = (root: HTMLElement) => root.querySelector<HTMLImageElement>('img.cyc-still')!;

  test('a transfer chunk landing patches the percentage in place; the row and its <img> are untouched', () => {
    const inner = mount();
    const m = imageMsg();
    const s = session([...history(), m]);
    paintImg(inner, s);
    const row = rowOf(inner, 40);
    const img = imgOf(row);
    expect(img.dataset.cycSrc).toBe('blob:pic-1');
    const prog = row.querySelector('.cyc-send-progress')!;
    expect(prog.textContent).toBe('sending 0%');

    const take = watch(inner);
    m.sendPct = 0.37;
    paintImg(inner, s);
    const touched = take();

    // No element came or went; the one write is the counter's text node.
    expect(touched.filter((t) => /^(add|remove) (?!#text)/.test(t))).toEqual([]);
    expect(rowOf(inner, 40)).toBe(row);
    expect(imgOf(rowOf(inner, 40))).toBe(img);
    expect(row.querySelector('.cyc-send-progress')!.textContent).toBe('sending 37%');
    clearMessages(inner);
  });

  test('the progress line is the cancel button, and its X survives the per-chunk patch', () => {
    const inner = mount();
    const m = imageMsg();
    const s = session([...history(), m]);
    paintImg(inner, s);
    const row = rowOf(inner, 40);
    const btn = row.querySelector<HTMLElement>('.cyc-send-progress')!;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.classList.contains('cyc-send-cancel')).toBe(true);
    expect((btn as HTMLButtonElement).title).toBe('Cancel upload');
    const icon = btn.querySelector('svg')!;
    expect(icon).not.toBeNull();

    m.sendPct = 0.62;
    paintImg(inner, s);
    // The same button and the same X: only the label's text moved.
    expect(rowOf(inner, 40).querySelector('.cyc-send-progress')).toBe(btn);
    expect(btn.querySelector('.cyc-send-progress-text')!.textContent).toBe('sending 62%');
    expect(btn.querySelector('svg')).toBe(icon);
    clearMessages(inner);
  });

  test('an unrelated append keeps every prior row and the <img> element; exactly one row is added', () => {
    const inner = mount();
    const s = session([...history(), imageMsg({status: 'delivered', sendPct: undefined})]);
    paintImg(inner, s);
    const before = rows(inner);
    const img = imgOf(rowOf(inner, 40));

    const take = watch(inner);
    s.messages.push(msg({id: 41, role: 'claude', text: 'done'}));
    paintImg(inner, s);
    const touched = take();

    expect(touched.filter((t) => t.startsWith('remove'))).toEqual([]);
    expect(touched.filter((t) => /^add \d+$/.test(t))).toEqual(['add 41']);
    const after = rows(inner);
    expect(after).toHaveLength(before.length + 1);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    expect(imgOf(rowOf(inner, 40))).toBe(img);
    clearMessages(inner);
  });

  test('send completion (uploadId swap) and adoption (ts, status) rebuild the row but carry the same <img>', () => {
    const inner = mount();
    const m = imageMsg();
    const s = session([...history(), m]);
    paintImg(inner, s);
    const row = rowOf(inner, 40);
    const img = imgOf(row);
    expect(img.src).toBe('blob:pic-1');

    // Completion: the transfer key becomes the engine uploadId, the progress
    // line leaves. The aliased object URL keeps the src string identical.
    m.upload = {...m.upload!, uploadId: 'up-9'};
    delete m.sendPct;
    paintImg(inner, s);
    const rebuilt = rowOf(inner, 40);
    expect(rebuilt).not.toBe(row); // the rebuild really happened
    expect(imgOf(rebuilt)).toBe(img); // the element was carried
    expect(rebuilt.querySelector('.cyc-send-progress')).toBeNull();

    // Adoption: the engine's echo folds in its timestamp and delivery.
    m.status = 'delivered';
    m.ts += 5_000;
    (m as CycMessage & {msgId?: string}).msgId = 'm-9';
    paintImg(inner, s);
    const adopted = rowOf(inner, 40);
    expect(adopted).not.toBe(rebuilt);
    expect(imgOf(adopted)).toBe(img);
    expect(imgOf(adopted).src).toBe('blob:pic-1');
    expect(imgOf(adopted).dataset.cycSrc).toBe('blob:pic-1');
    clearMessages(inner);
  });
});

describe('the DOM epoch (render-heat scan guard input)', () => {
  test('clearMessages bumps messageDomEpoch, so the scan key re-keys after a teardown', () => {
    const inner = mount();
    paint(inner, session(history()));
    const before = messageDomEpoch();
    clearMessages(inner);
    expect(messageDomEpoch()).toBe(before + 1);
  });

  test('the empty-items wipe bumps messageDomEpoch', () => {
    const inner = mount();
    const s = session(history());
    paint(inner, s);
    const before = messageDomEpoch();
    s.messages.length = 0;
    paint(inner, s);
    expect(messageDomEpoch()).toBe(before + 1);
    clearMessages(inner);
  });
});
