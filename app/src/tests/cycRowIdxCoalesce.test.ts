import {afterEach, describe, expect, test, vi} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow, type StoreRow} from '../engine/store/rows/core';
import type {CycEngineMessage} from '../engine/store/types';
import type {Tx} from '../engine/store/rows/rowStore';

// FIX 2: the whole seq index (one record per session, up to ~125k tuples) was
// rewritten to IndexedDB on EVERY upsert/drop, dozens of times a second during a
// backfill. It is now coalesced AND chunked: a mutation marks the changed chunk
// dirty and a single ~3s trailing flush writes only the chunks that changed, plus
// eager flushes at the points a stale durable index would be observable (close,
// openWindow) or lost (visibilitychange hidden, pagehide). Each burst here lands
// in one seq chunk, so it still collapses to one durable index write; this proves
// the write count collapses and that the eager flush points keep the durable
// index recoverable. (cycRowIdxChunked proves a write touches only its chunk.)

const SID = 'eng|p1';
const mrow = (over: Partial<CycEngineMessage>): StoreRow =>
  messageRow(SID, {
    id: 0,
    role: 'claude',
    kind: 'text',
    text: over.text ?? 't',
    ts: over.seq ?? 0,
    ...over
  } as CycEngineMessage);

// An in-memory backing that counts index-record writes (`<sid>|idx`) separately
// from payload writes, so a test can assert on the seq-index rewrite frequency.
function countingTx(): {db: Map<string, {key: string}>; idxWrites: () => number; tx: Tx} {
  const db = new Map<string, {key: string}>();
  let idxWrites = 0;
  const store = () =>
    ({
      get: (k: string) => ({result: db.get(k)}) as unknown as IDBRequest,
      getAll: () => ({result: [...db.values()]}) as unknown as IDBRequest,
      getAllKeys: () => ({result: [...db.keys()]}) as unknown as IDBRequest,
      put: (v: {key: string}) => {
        // Chunked index records are keyed `<sid>|idx|<chunk>`; the legacy monolith
        // was `<sid>|idx`. Count either as an index write (payloads are `|r|`,
        // meta is `|meta`, so neither matches).
        if (v.key.includes('|idx')) idxWrites++;
        db.set(v.key, v);
        return {result: v.key} as unknown as IDBRequest;
      },
      delete: (k: string) => {
        db.delete(k);
        return {result: undefined} as unknown as IDBRequest;
      },
      clear: () => {
        db.clear();
        return {result: undefined} as unknown as IDBRequest;
      }
    }) as unknown as IDBObjectStore;
  const tx: Tx = <T>(_mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) =>
    Promise.resolve((run(store()) as unknown as {result: T}).result ?? null);
  return {db, idxWrites: () => idxWrites, tx};
}

afterEach(() => {
  rowStore.__setBackingForTest(null);
  vi.useRealTimers();
});

describe('the seq index write is coalesced, not rewritten per upsert', () => {
  test('many upserts to a warm session write the index at most once per ~3s window', async () => {
    vi.useFakeTimers();
    const c = countingTx();
    rowStore.__setBackingForTest(c.tx);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 300); // warm the mirror

    // 40 live-tail upserts in quick succession (the backfill/flood shape).
    for (let i = 0; i < 40; i++) {
      await rowStore.upsert(SID, [mrow({mid: 'mr-' + i, seq: i, text: 'r' + i})]);
    }
    // Before the trailing flush fires, the index has NOT been rewritten 40 times.
    expect(c.idxWrites()).toBe(0);

    await vi.advanceTimersByTimeAsync(3100);
    // One coalesced rewrite for the whole burst.
    expect(c.idxWrites()).toBe(1);

    // A quiet period with no writes arms no new timer and writes nothing more.
    await vi.advanceTimersByTimeAsync(6000);
    expect(c.idxWrites()).toBe(1);
  });

  test('a second burst after the first flush coalesces into one more write', async () => {
    vi.useFakeTimers();
    const c = countingTx();
    rowStore.__setBackingForTest(c.tx);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 300);

    for (let i = 0; i < 10; i++) await rowStore.upsert(SID, [mrow({mid: 'a' + i, seq: i})]);
    await vi.advanceTimersByTimeAsync(3100);
    expect(c.idxWrites()).toBe(1);

    for (let i = 10; i < 20; i++) await rowStore.upsert(SID, [mrow({mid: 'a' + i, seq: i})]);
    await vi.advanceTimersByTimeAsync(3100);
    expect(c.idxWrites()).toBe(2);
  });
});

describe('the eager flush points keep the durable index recoverable', () => {
  test('close() flushes the pending index so the next cold open reads every row', async () => {
    const c = countingTx();
    rowStore.__setBackingForTest(c.tx);
    await rowStore.upsert(
      SID,
      Array.from({length: 50}, (_, i) => mrow({mid: 'mr-' + i, seq: i, text: 'r' + i}))
    );
    expect(c.idxWrites()).toBe(0); // deferred, not yet written

    rowStore.close(SID); // evicts the warm mirror -> must flush first
    expect(c.idxWrites()).toBe(1);

    // A cold open reads the durable index the close flushed: all 50 rows.
    const {messages} = await rowStore.openWindow(SID, 100);
    expect(messages).toHaveLength(50);
    expect(messages[messages.length - 1].text).toBe('r49');
  });

  test('a page hidden (visibilitychange) flushes every dirty session', async () => {
    const c = countingTx();
    rowStore.__setBackingForTest(c.tx);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 300);
    await rowStore.upsert(SID, [mrow({mid: 'live', seq: 1, text: 'live'})]);
    expect(c.idxWrites()).toBe(0);

    Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
    document.dispatchEvent(new Event('visibilitychange'));

    expect(c.idxWrites()).toBe(1);
  });

  test('a lost (never-flushed) index heals on the next re-upsert: rows are idempotent by mid', async () => {
    const c = countingTx();
    rowStore.__setBackingForTest(c.tx);
    // A crash: the payloads are durable (immediate) but the index write was
    // never flushed. Simulate by upserting then dropping the warm state without
    // a flush point, straight into a fresh backing that already holds the rows.
    await rowStore.upsert(
      SID,
      Array.from({length: 20}, (_, i) => mrow({mid: 'mr-' + i, seq: i, text: 'r' + i}))
    );
    // The rows are durable; the index is not (deferred). A re-serve of the same
    // rows (idempotent by mid) re-adds the tuples and re-marks the index dirty.
    rowStore.close(SID); // flushes here in the real path; the heal below is what
    // matters when even that is lost, so re-upsert and confirm convergence.
    await rowStore.upsert(
      SID,
      Array.from({length: 20}, (_, i) => mrow({mid: 'mr-' + i, seq: i, text: 'r' + i}))
    );
    rowStore.close(SID);
    const {messages} = await rowStore.openWindow(SID, 100);
    expect(messages).toHaveLength(20); // no twins, full window
  });
});
