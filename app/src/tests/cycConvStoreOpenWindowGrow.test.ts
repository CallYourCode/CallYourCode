import {afterEach, describe, expect, test} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {
  emptyMirror,
  eventRow,
  GROW_CAP,
  messageRow,
  upsertMirror,
  WINDOW_FLOOR_ALL,
  floorSeqOf,
  type StoreRow
} from '../engine/store/rows/core';
import {WINDOW} from '../engine/store/rows/door';
import type {CycEngineMessage} from '../engine/store/types';
import type {CycSessionEvent} from '../types';
import {memTx} from './rowStoreFake';

// LANE 2 part 2: while a chat is OPEN, a live tail arrival must GROW the window
// instead of sliding it (evicting the oldest row and reindexing the front). A
// reader pinned at the bottom of a chat longer than WINDOW would otherwise get
// ~WINDOW rows churned and two scrolls per message. The window is reset to the
// normal size the next time the chat opens; a background chat stays bounded; and
// a generous cap (GROW_CAP) still guards against unbounded growth.
//
//   bunx vitest run src/tests/cycConvStoreOpenWindowGrow.test.ts

const SID = 'eng|p1';
const OTHER = 'eng|p2';

const msg = (over: Partial<CycEngineMessage>): CycEngineMessage =>
  ({
    id: 0,
    role: 'claude',
    kind: 'text',
    text: 't',
    ts: over.seq ?? 0,
    ...over
  }) as CycEngineMessage;

const mrow = (sid: string, seq: number): StoreRow =>
  messageRow(sid, msg({mid: sid + '-mr-' + seq, seq, text: 'r' + seq}));

// A session event (tool pill) stamped ABOVE the newest chat message, exactly the
// busy-agent tail the live wire serves: a tool run keeps stamping events after
// the last reply, so the newest tuples by ts are events, not messages.
const evrow = (sid: string, seq: number, ts: number): StoreRow =>
  eventRow(sid, {uuid: sid + '-e-' + seq, ts, seq, kind: 'tool', text: 'Bash ' + seq} as CycSessionEvent);

afterEach(() => {
  rowStore.setOpen(null);
  rowStore.__setBackingForTest(null);
});

describe('a live tail arrival into the OPEN chat grows the window, evicts nothing', () => {
  test('50 arrivals into an open 400-message chat: floor stays put, front is kept', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    // 400 messages: longer than WINDOW (300), so the old bound would slide the
    // window one row per arrival for a pinned reader.
    const rows: StoreRow[] = [];
    for (let seq = 0; seq < 400; seq++) rows.push(mrow(SID, seq));
    await rowStore.upsert(SID, rows);
    rowStore.close(SID);

    rowStore.setOpen(SID);
    const opened = await rowStore.openWindow(SID, WINDOW);
    // The open floors on the newest WINDOW messages: seq 100..399.
    expect(opened.messages).toHaveLength(WINDOW);
    expect(rowStore.windowFloorSeq(SID)).toBe(100);
    const frontId = 'm:' + SID + '-mr-100';
    expect(rowStore.__mirror(SID)!.loaded.has(frontId)).toBe(true);

    // 50 live tail arrivals into the open chat, one message each.
    for (let seq = 400; seq < 450; seq++) await rowStore.upsert(SID, [mrow(SID, seq)]);

    // The floor did NOT ride up: nothing was evicted from the front, the window
    // simply GREW by the 50 arrivals.
    expect(rowStore.windowFloorSeq(SID)).toBe(100);
    expect(rowStore.__mirror(SID)!.loaded.has(frontId)).toBe(true);
    const {messages} = rowStore.projection(SID);
    expect(messages).toHaveLength(WINDOW + 50);
    expect(messages[0].text).toBe('r100');
    expect(messages[messages.length - 1].text).toBe('r449');
  });

  test('reopening the chat resets the grown window back to WINDOW', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    const rows: StoreRow[] = [];
    for (let seq = 0; seq < 400; seq++) rows.push(mrow(SID, seq));
    await rowStore.upsert(SID, rows);
    rowStore.close(SID);

    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);
    for (let seq = 400; seq < 450; seq++) await rowStore.upsert(SID, [mrow(SID, seq)]);
    expect(rowStore.projection(SID).messages).toHaveLength(WINDOW + 50);

    // Reopening re-anchors on the tail: the window is the newest WINDOW again.
    const reopened = await rowStore.openWindow(SID, WINDOW);
    expect(reopened.messages).toHaveLength(WINDOW);
    expect(rowStore.windowFloorSeq(SID)).toBe(150); // newest 300 of seq 0..449
    expect(reopened.messages[reopened.messages.length - 1].text).toBe('r449');
  });
});

describe('a live message below a tail event run still grows the open window', () => {
  test('events newer-by-ts than every message do not make a live reply look like backfill', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    // 400 messages (seq 0..399, ts 0..399), then 50 session events stamped ABOVE
    // them (ts far in the future): the newest tuples by ts are events.
    const rows: StoreRow[] = [];
    for (let seq = 0; seq < 400; seq++) rows.push(mrow(SID, seq));
    for (let i = 0; i < 50; i++) rows.push(evrow(SID, 400 + i, 100_000 + i));
    await rowStore.upsert(SID, rows);
    rowStore.close(SID);

    rowStore.setOpen(SID);
    const opened = await rowStore.openWindow(SID, WINDOW);
    // The window anchors on the newest 300 MESSAGES (seq 100..399), the events
    // ride along in the span.
    expect(opened.messages).toHaveLength(WINDOW);
    expect(rowStore.windowFloorSeq(SID)).toBe(100);
    const frontId = 'm:' + SID + '-mr-100';
    expect(rowStore.__mirror(SID)!.loaded.has(frontId)).toBe(true);

    // A live reply: newer by ts than every message (ts 400), but OLDER than the
    // event tail (ts 100_000+), so it lands BELOW the events. It must still GROW
    // the window, not slide it: the newest MESSAGE advanced.
    await rowStore.upsert(SID, [mrow(SID, 450)]);

    expect(rowStore.windowFloorSeq(SID)).toBe(100); // floor did not ride up
    expect(rowStore.__mirror(SID)!.loaded.has(frontId)).toBe(true); // front kept
    const {messages} = rowStore.projection(SID);
    expect(messages).toHaveLength(WINDOW + 1); // grew by the one reply
    expect(messages[0].text).toBe('r100');
    expect(messages[messages.length - 1].text).toBe('r450');
  });
});

describe('a background chat stays bounded (the grow relaxation is open-only)', () => {
  test('a tail arrival into a NON-open 400-message chat slides the floor, does not grow', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    const rows: StoreRow[] = [];
    for (let seq = 0; seq < 400; seq++) rows.push(mrow(OTHER, seq));
    await rowStore.upsert(OTHER, rows);
    rowStore.close(OTHER);

    // Establish the window (floor + size) by opening once, then leave it in the
    // background by opening a DIFFERENT chat.
    rowStore.setOpen(OTHER);
    await rowStore.openWindow(OTHER, WINDOW);
    expect(rowStore.windowFloorSeq(OTHER)).toBe(100);
    rowStore.setOpen(SID);

    // A tail arrival to the background chat: the window rides up one row and
    // stays bounded at WINDOW (the pre-fix bound, unchanged for background).
    await rowStore.upsert(OTHER, [mrow(OTHER, 400)]);
    expect(rowStore.windowFloorSeq(OTHER)).toBe(101);
    expect(rowStore.__mirror(OTHER)!.loaded.has('m:' + OTHER + '-mr-100')).toBe(false);
    // The loaded window never exceeded WINDOW.
    const loadedMsgs = [...rowStore.__mirror(OTHER)!.loaded.values()].filter(
      (r) => r.kind === 'msg'
    );
    expect(loadedMsgs).toHaveLength(WINDOW);
  });
});

describe('GROW_CAP guards the open window against unbounded growth', () => {
  test('past the cap the floor rides up: a single trim, then one row per arrival', () => {
    // A mirror already holding GROW_CAP + 100 message rows, floored on ALL
    // (windowOpen) with the open windowSize, standing in for a chat that has
    // grown past the cap while open.
    const m = emptyMirror();
    m.floor = WINDOW_FLOOR_ALL;
    m.windowSize = WINDOW;
    const rows: StoreRow[] = [];
    for (let seq = 0; seq < GROW_CAP + 100; seq++) rows.push(mrow(SID, seq));
    upsertMirror(m, rows, {openLive: true});

    // The window is trimmed once to the newest GROW_CAP: the oldest 100 are
    // evicted, the newest GROW_CAP are loaded.
    expect(floorSeqOf(m)).toBe(100);
    const loadedMsgs = () => [...m.loaded.values()].filter((r) => r.kind === 'msg').length;
    expect(loadedMsgs()).toBe(GROW_CAP);
    expect(m.loaded.has('m:' + SID + '-mr-99')).toBe(false);
    expect(m.loaded.has('m:' + SID + '-mr-100')).toBe(true);

    // At the cap, each further arrival trims exactly one (the pre-fix bounded
    // behaviour), so the loaded window never exceeds GROW_CAP.
    upsertMirror(m, [mrow(SID, GROW_CAP + 100)], {openLive: true});
    expect(floorSeqOf(m)).toBe(101);
    expect(loadedMsgs()).toBe(GROW_CAP);
  });
});
