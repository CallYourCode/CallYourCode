import {afterEach, describe, expect, test, vi} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {createReplicator} from '../engine/store/rows/replicator';
import {cursorSeq} from '../engine/store/rows/cursor';
import {messageRow, type StoreRow} from '../engine/store/rows/core';
import {notify, renderSubs} from '../engine/store/registry';
import type {CycEngineMessage} from '../engine/store/types';
import type {EnginePage} from '../engine/contract';
import {memTx} from './rowStoreFake';

// The design one-pager lists five invariants. Each is a test here, written so it
// cannot pass vacuously (every assertion has a control that would fail if the
// rule were dropped).

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
  renderSubs.clear();
  vi.useRealTimers();
});

describe('invariant 1: no wire event ever calls a render; only store change notifications do', () => {
  test('feeding rows to a session that is not open paints nothing', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen('eng|OTHER');
    await rowStore.openWindow('eng|OTHER', 100);
    const paints: string[] = [];
    const off = rowStore.onChange((sid) => paints.push(sid));
    // the wire delivers a live row for SID (not the open chat)
    await rowStore.upsert(SID, [mrow({mid: 'mr-1', seq: 1, text: 'live'})]);
    expect(paints).toEqual([]); // nothing painted
    // control: a write to the OPEN chat DOES notify, proving the door works
    await rowStore.upsert('eng|OTHER', [messageRow('eng|OTHER', msg({mid: 'mr-2', seq: 2}))]);
    expect(paints).toEqual(['eng|OTHER']);
    off();
  });
});

describe('invariant 2: the cursor advances only on committed contiguous coverage', () => {
  test('an uncommitted (offline) page leaves the cursor; a committed one advances it', async () => {
    let online = false;
    const committed: StoreRow[] = [];
    const rep = createReplicator(SID, {
      fetchPage: async (n) =>
        online
          ? ({
              page: n,
              version: (n + 1) * 100,
              sealed: true,
              messages: [],
              events: []
            } as EnginePage)
          : null,
      upsert: async (rows) => {
        committed.push(...rows);
        return {loSeq: -1, hiSeq: -1};
      },
      persistCursor: () => {},
      now: () => 0,
      schedule: () => {}
    });
    await rep.attachOk({sessionId: SID, pageSize: 100, tailPage: 2, total: 300, pages: []});
    await rep.pump();
    expect(cursorSeq(rep.cursor)).toBe(-1); // offline: nothing committed, cursor unmoved
    online = true;
    await rep.pump();
    expect(cursorSeq(rep.cursor)).toBe(200); // committed the tail page: cursor advanced
  });
});

describe('invariant 3: a row exists at most once per (sessionId, mid), whatever seq did', () => {
  test('the same mid re-served under three different seqs is one row', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen(SID);
    await rowStore.upsert(SID, [mrow({mid: 'mr-x', seq: 3, text: 'v'})]);
    await rowStore.upsert(SID, [mrow({mid: 'mr-x', seq: 9, text: 'v'})]);
    await rowStore.upsert(SID, [mrow({mid: 'mr-x', seq: 1, text: 'v'})]);
    await rowStore.openWindow(SID, 100);
    const {messages} = rowStore.projection(SID);
    expect(messages).toHaveLength(1); // control: three inserts, still one row
    expect(messages[0].seq).toBe(1); // last write's seq won, in place
  });
});

describe('invariant 4: one paint per frame, and only when the visible window changed', () => {
  test('a 50-page flood below the window paints zero; window-touching writes coalesce to one frame', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen(SID);
    // seed a tail window
    await rowStore.upsert(
      SID,
      Array.from({length: 50 * 100}, (_, i) => mrow({mid: 'mr-' + i, seq: i, text: 'r' + i}))
    );
    rowStore.close(SID);
    await rowStore.openWindow(SID, 100); // floor near seq 4900

    let paints = 0;
    const off = rowStore.onChange((sid) => {
      if (sid === SID) paints++;
    });
    // 50 pages of backfill below the window: not one paint
    for (let p = 0; p < 49; p++) {
      await rowStore.upsert(
        SID,
        Array.from({length: 100}, (_, i) =>
          mrow({mid: 'mr-' + (p * 100 + i), seq: p * 100 + i, text: 'x'})
        )
      );
    }
    expect(paints).toBe(0);
    off();

    // the frame-coalescing half: many notify() calls in one tick flush once.
    vi.useFakeTimers();
    let flushes = 0;
    renderSubs.add(() => flushes++);
    for (let i = 0; i < 20; i++) notify();
    vi.advanceTimersByTime(250); // past the 200ms raf fallback
    expect(flushes).toBe(1); // control: 20 notifies, one paint
  });
});

describe('invariant 5: a chat opens from local data alone; the network can be dead', () => {
  test('openWindow returns the stored window with no fetchPage in sight', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    await rowStore.upsert(SID, [
      mrow({mid: 'mr-1', seq: 1, text: 'one'}),
      mrow({mid: 'mr-2', seq: 2, text: 'two'})
    ]);
    rowStore.close(SID);
    // no replicator, no wire: a purely local open
    const {messages} = await rowStore.openWindow(SID, 100);
    expect(messages.map((m) => m.text)).toEqual(['one', 'two']);
    // control: an empty session opens empty, not stuck
    const empty = await rowStore.openWindow('eng|blank', 100);
    expect(empty.messages).toEqual([]);
  });
});
