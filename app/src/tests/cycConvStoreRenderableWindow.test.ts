import {afterEach, describe, expect, test} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {
  eventRow,
  messageRow,
  newestWindowStart,
  anchorsOpenWindow,
  emptyMirror,
  upsertMirror,
  type StoreRow
} from '../engine/store/rows/core';
import {WINDOW} from '../engine/store/rows/door';
import type {CycEngineMessage} from '../engine/store/types';
import type {CycSessionEvent} from '../types';
import {memTx} from './rowStoreFake';

// THE BLANK-CHAT-ON-OPEN DEFECT, root-caused. A working agent runs long after its
// last chat MESSAGE: it stamps hundreds of session events on the seq axis ABOVE
// the newest message -- session RECORDS the chat has no pill for AND the
// pill-paintable prompt/reply/tool kinds alike. On a busy session the newest rows
// BY SEQ are therefore all events and the real chat MESSAGES sit far below the
// tail. An earlier fix anchored the open window on the newest WINDOW RENDERABLE
// rows, but it counted the pill-paintable events as renderable, so on the LIVE
// wire (whose tail is prompt/reply/tool events, not the bare records the first
// repro used) the floor STILL landed on an all-event span and the messages were
// still walled out: with the overlay off the chat opened blank, and with it on
// the conversation's own bubbles never entered the window. The fix anchors the
// window on the newest WINDOW MESSAGE rows alone, since the default (overlay-off)
// view paints messages and nothing else; the floor then drops below the whole
// event tail to the newest real messages.
//
//   bunx vitest run src/tests/cycConvStoreRenderableWindow.test.ts

const SID = 'eng|p1';

const msg = (over: Partial<CycEngineMessage>): CycEngineMessage =>
  ({
    id: 0,
    role: 'claude',
    kind: 'text',
    text: 't',
    ts: over.seq ?? 0,
    ...over
  }) as CycEngineMessage;

const mrow = (seq: number): StoreRow =>
  messageRow(SID, msg({mid: 'mr-' + seq, seq, text: 'r' + seq}));

// A session RECORD: an event row whose kind is NOT one the chat paints a pill
// for, exactly the transcript-ingest rows a working agent stamps on the axis.
const record = (seq: number): StoreRow =>
  eventRow(SID, {
    uuid: 'rec-' + seq,
    ts: seq,
    seq,
    kind: 'record',
    text: 'ingest ' + seq
  } as CycSessionEvent);

afterEach(() => rowStore.__setBackingForTest(null));

describe('test 1: a record-dense tail no longer opens the chat blank', () => {
  test('newest 1200 records over 20 messages: open projects the 20 messages (count>0)', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    // 20 real messages at the bottom of the axis...
    const rows: StoreRow[] = [];
    for (let seq = 0; seq < 20; seq++) rows.push(mrow(seq));
    // ...buried under 1200 session records at the tail.
    for (let seq = 20; seq < 1220; seq++) rows.push(record(seq));
    await rowStore.upsert(SID, rows);
    rowStore.close(SID);

    // Control: the newest WINDOW rows BY SEQ are ALL records, so the old
    // by-seq anchoring floored on a desert and projected zero messages.
    const m = rowStore.__mirror(SID);
    const start = m ? Math.max(0, m.idx.length - WINDOW) : 0;
    const newestRaw = m ? m.idx.slice(start) : [];
    expect(newestRaw.every((t) => t.kind === 'event')).toBe(true);

    rowStore.setOpen(SID);
    const {messages, events} = await rowStore.openWindow(SID, WINDOW);
    // The 20 buried messages paint (was 0 on the by-seq anchoring).
    expect(messages).toHaveLength(20);
    expect(messages.map((mm) => mm.text)).toEqual(Array.from({length: 20}, (_, i) => 'r' + i));
    // The records are still HELD in the window (they render nowhere, but the
    // window stays a contiguous seq range), not dropped.
    expect(events.length).toBeGreaterThan(0);
  });
});

// A pill-paintable session event (reply/tool/prompt), exactly the busy-agent
// activity the wire stamps ABOVE the newest chat message. Unlike `record`, its
// kind IS in RENDERABLE_EVENT_KINDS, so the earlier renderable-event anchor
// COUNTED it and floored the window above the messages -- the live-wire shape the
// first repro (bare records) missed.
const pill = (seq: number, kind: 'reply' | 'tool' | 'prompt'): StoreRow =>
  eventRow(SID, {
    uuid: 'pill-' + seq,
    ts: seq,
    seq,
    kind,
    text: kind + ' ' + seq
  } as CycSessionEvent);

describe('test 2: a RENDERABLE-event tail (reply/tool/prompt) no longer opens the chat blank', () => {
  test('20 messages under 400 pill-paintable events: open projects the 20 messages (count>0)', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    // 20 real chat messages at the bottom of the axis (seq 0..19)...
    const rows: StoreRow[] = [];
    for (let seq = 0; seq < 20; seq++) rows.push(mrow(seq));
    // ...buried under 400 pill-paintable session events at the tail (seq
    // 20..419): the busy-agent event tail the live wire serves, NOT the bare
    // records the first repro used.
    for (let seq = 20; seq < 420; seq++)
      rows.push(pill(seq, seq % 3 === 0 ? 'reply' : seq % 3 === 1 ? 'tool' : 'prompt'));
    await rowStore.upsert(SID, rows);
    rowStore.close(SID);

    // Control: the newest WINDOW rows BY SEQ are ALL events, so the renderable-
    // event anchor floored on an all-event span and projected zero messages.
    const m = rowStore.__mirror(SID);
    const start = m ? Math.max(0, m.idx.length - WINDOW) : 0;
    const newestRaw = m ? m.idx.slice(start) : [];
    expect(newestRaw.every((t) => t.kind === 'event')).toBe(true);

    rowStore.setOpen(SID);
    const {messages, events} = await rowStore.openWindow(SID, WINDOW);
    // The 20 buried messages paint (was 0 when the anchor counted the events).
    expect(messages).toHaveLength(20);
    expect(messages.map((mm) => mm.text)).toEqual(Array.from({length: 20}, (_, i) => 'r' + i));
    // The events are still HELD in the contiguous span (the overlay paints them).
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('test 3: a fully message-dense tail behaves exactly as before', () => {
  test('400 messages: the window is the newest WINDOW rows, floor at the WINDOW boundary', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    const rows = Array.from({length: 400}, (_, seq) => mrow(seq));
    await rowStore.upsert(SID, rows);
    rowStore.close(SID);

    rowStore.setOpen(SID);
    const {messages} = await rowStore.openWindow(SID, WINDOW);
    // The newest WINDOW messages, exactly as the by-seq anchoring gave (no
    // records to skip, so renderable == raw).
    expect(messages).toHaveLength(WINDOW);
    expect(messages[0].text).toBe('r' + (400 - WINDOW));
    expect(messages[messages.length - 1].text).toBe('r399');
    expect(rowStore.windowFloorSeq(SID)).toBe(400 - WINDOW);
    // Non-vacuity: on a pure-message store the renderable start IS the raw start.
    const m = rowStore.__mirror(SID)!;
    expect(newestWindowStart(m, WINDOW)).toBe(400 - WINDOW);
  });
});

describe('test 4: scrolling up from the renderable floor pages older rows without gaps or duplicates', () => {
  test('500 messages under a 200-record tail: open shows the newest 300 messages, extend loads the rest contiguously', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    const rows: StoreRow[] = [];
    for (let seq = 0; seq < 500; seq++) rows.push(mrow(seq)); // messages 0..499
    for (let seq = 500; seq < 700; seq++) rows.push(record(seq)); // records 500..699
    await rowStore.upsert(SID, rows);
    rowStore.close(SID);

    rowStore.setOpen(SID);
    const opened = await rowStore.openWindow(SID, WINDOW);
    // The 200 tail records never count, so the window holds the newest WINDOW
    // messages: seq 200..499.
    expect(opened.messages).toHaveLength(WINDOW);
    expect(opened.messages[0].text).toBe('r200');
    expect(opened.messages[opened.messages.length - 1].text).toBe('r499');
    expect(rowStore.windowFloorSeq(SID)).toBe(200);
    expect(rowStore.windowHasMoreBelow(SID)).toBe(true);

    // Scroll up: the next older page loads from the store, below the floor.
    const older = await rowStore.extendWindow(SID, WINDOW);
    // Now every message 0..499 is present, in order, once each: no gap, no dup.
    const seqs = older.messages.map((mm) => mm.seq);
    expect(seqs).toEqual(Array.from({length: 500}, (_, i) => i));
    expect(new Set(older.messages.map((mm) => mm.text)).size).toBe(500);
    expect(older.dry).toBe(true); // the store ran dry below the new floor
  });
});

describe('the open-window anchor is decidable from the index alone', () => {
  test('a message tuple anchors the window; NO event tuple does (a record OR a pill-paintable tool/reply)', () => {
    const m = emptyMirror();
    upsertMirror(m, [mrow(1), record(2)]);
    upsertMirror(m, [
      eventRow(SID, {uuid: 'e-3', ts: 3, seq: 3, kind: 'tool', text: 'Bash'} as CycSessionEvent)
    ]);
    const byId = new Map(m.idx.map((t) => [t.id, t]));
    expect(anchorsOpenWindow(byId.get('m:mr-1')!)).toBe(true);
    expect(anchorsOpenWindow(byId.get('e:rec-2')!)).toBe(false);
    // A pill-paintable event (tool) still does NOT anchor: it paints only under
    // the agent-activity overlay, so it cannot guarantee a non-blank cold open.
    expect(anchorsOpenWindow(byId.get('e:e-3')!)).toBe(false);
  });

  test('an events-only store falls back to the newest raw tail rather than an empty span', () => {
    const m = emptyMirror();
    upsertMirror(
      m,
      Array.from({length: 10}, (_, i) => record(i))
    );
    // No messages at all: the span is the newest `size` raw rows, so an
    // events-only session (a cron, a pure agent log) still opens on its tail
    // instead of on nothing.
    expect(newestWindowStart(m, 3)).toBe(7);
  });
});
