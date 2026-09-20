import {afterEach, describe, expect, test, vi} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow, eventRow, type StoreRow} from '../engine/store/rows/core';
import type {CycEngineMessage} from '../engine/store/types';
import {memTx} from './rowStoreFake';

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
const mrow = (over: Partial<CycEngineMessage>): StoreRow => messageRow(SID, msg(over));

afterEach(() => {
  rowStore.__setBackingForTest(null);
});

describe('rowStore over a durable backing', () => {
  test('upsert then openWindow returns the newest rows, one read, no network', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    await rowStore.upsert(
      SID,
      Array.from({length: 250}, (_, i) => mrow({mid: 'mr-' + i, seq: i, text: 'r' + i}))
    );
    // a fresh reader (cold open): drop the warm mirror first
    rowStore.close(SID);
    const {messages} = await rowStore.openWindow(SID, 100);
    expect(messages).toHaveLength(100);
    expect(messages[0].text).toBe('r150');
    expect(messages[99].text).toBe('r249');
  });

  test('offline open: the window renders from the store with the backing standing in for a dead network', async () => {
    const {tx} = memTx();
    rowStore.__setBackingForTest(tx);
    await rowStore.upsert(SID, [mrow({mid: 'mr-1', seq: 1, text: 'held'})]);
    rowStore.close(SID);
    // no network is ever consulted here; openWindow only touches the backing
    const {messages} = await rowStore.openWindow(SID, 100);
    expect(messages.map((m) => m.text)).toEqual(['held']);
  });

  test('extendWindow pulls older rows from the store, then reports dry at the floor', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    await rowStore.upsert(
      SID,
      Array.from({length: 30}, (_, i) => mrow({mid: 'mr-' + i, seq: i, text: 'r' + i}))
    );
    rowStore.close(SID);
    const first = await rowStore.openWindow(SID, 10);
    expect(first.messages[0].text).toBe('r20');
    const mid = await rowStore.extendWindow(SID, 10);
    expect(mid.messages[0].text).toBe('r10');
    expect(mid.dry).toBe(false);
    const last = await rowStore.extendWindow(SID, 10);
    expect(last.messages[0].text).toBe('r0');
    expect(last.dry).toBe(true); // nothing more below in the store
  });
});

describe('the paint door: only the open window repaints', () => {
  test('a write intersecting the open window fires onChange; a below-window write does not', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    await rowStore.upsert(
      SID,
      Array.from({length: 200}, (_, i) => mrow({mid: 'mr-' + i, seq: i, text: 'r' + i}))
    );
    rowStore.close(SID);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 100); // floor at seq 100

    const paints: number[] = [];
    const off = rowStore.onChange((sid) => {
      if (sid === SID) paints.push(1);
    });

    // a live tail row (seq 200): intersects the window, paints
    await rowStore.upsert(SID, [mrow({mid: 'mr-200', seq: 200, text: 'live'})]);
    expect(paints).toHaveLength(1);

    // a backfill row below the floor (seq 50): stored, but paints nothing
    await rowStore.upsert(SID, [mrow({mid: 'mr-bf', seq: 50, text: 'backfill'})]);
    expect(paints).toHaveLength(1);

    off();
  });

  test('a write to a session that is not the open one never paints', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 100);
    const paints: string[] = [];
    const off = rowStore.onChange((sid) => paints.push(sid));
    await rowStore.upsert('eng|other', [messageRow('eng|other', msg({mid: 'mr-o', seq: 1}))]);
    expect(paints).toHaveLength(0);
    off();
  });
});

describe('meta cursor round-trip', () => {
  test('writeMeta then readMeta returns the cursor bookkeeping', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.writeMeta({
      sessionId: SID,
      cursor: 400,
      tailVersion: 900,
      tailPage: 9,
      coveredFrom: 4,
      pageSize: 100,
      total: 950,
      syncedAt: 123
    });
    const meta = await rowStore.readMeta(SID);
    expect(meta).toMatchObject({cursor: 400, tailVersion: 900, coveredFrom: 4});
  });
});

describe('events ride the same door and window', () => {
  test('a session-record upserts and projects alongside messages', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen(SID);
    await rowStore.upsert(SID, [
      mrow({mid: 'mr-1', seq: 1, text: 'm'}),
      eventRow(SID, {uuid: 'se-2', ts: 2, seq: 2, kind: 'tool', text: 'Bash'})
    ]);
    await rowStore.openWindow(SID, 100);
    const {messages, events} = rowStore.projection(SID);
    expect(messages.map((m) => m.text)).toEqual(['m']);
    expect(events.map((e) => e.uuid)).toEqual(['se-2']);
  });
});
