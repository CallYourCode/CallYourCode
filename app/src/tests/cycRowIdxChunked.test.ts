import {afterEach, describe, expect, test, vi} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow, type StoreRow} from '../engine/store/rows/core';
import type {CycEngineMessage} from '../engine/store/types';
import type {Tx} from '../engine/store/rows/rowStore';

// FIX 2 (the durable side): the seq index was ONE record per session (78k-125k
// tuples). Rewriting the whole array -- even coalesced -- still structured-clones
// it to IndexedDB on the main thread every few seconds while rows arrive, the
// measured 120-700ms stall. The index is now stored in CHUNKS keyed by seq band
// (`<sid>|idx|<chunk>`, chunk = floor(seq / 2000)), so a write touches ONLY the
// chunk(s) whose tuples changed. These prove: a write touches one chunk; a
// cross-chunk re-seat rewrites both chunks and leaves no durable twin; a cold
// reload rebuilds the index exactly; and the old monolithic record migrates.

const SID = 'eng|p1';
const SPAN = 2000; // IDX_CHUNK_SPAN, mirrored here so the tests name their chunks

const mrow = (over: Partial<CycEngineMessage>): StoreRow =>
  messageRow(SID, {
    id: 0,
    role: 'claude',
    kind: 'text',
    text: over.text ?? 't',
    ts: over.ts ?? over.seq ?? 0,
    ...over
  } as CycEngineMessage);

// A synchronous in-memory backing that RECORDS the keys of every put and delete,
// so a test can assert exactly which durable index chunk a write touched.
function recordingTx(): {
  db: Map<string, {key: string}>;
  puts: string[];
  dels: string[];
  tx: Tx;
  clear: () => void;
} {
  const db = new Map<string, {key: string}>();
  const puts: string[] = [];
  const dels: string[] = [];
  const store = () =>
    ({
      get: (k: string) => ({result: db.get(k)}) as unknown as IDBRequest,
      getAll: () => ({result: [...db.values()]}) as unknown as IDBRequest,
      getAllKeys: () => ({result: [...db.keys()]}) as unknown as IDBRequest,
      put: (v: {key: string}) => {
        puts.push(v.key);
        db.set(v.key, v);
        return {result: v.key} as unknown as IDBRequest;
      },
      delete: (k: string) => {
        dels.push(k);
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
  return {
    db,
    puts,
    dels,
    tx,
    clear: () => {
      puts.length = 0;
      dels.length = 0;
    }
  };
}

const idxKeys = (keys: string[]): string[] => keys.filter((k) => k.includes('|idx'));

afterEach(() => {
  rowStore.__setBackingForTest(null);
  rowStore.setOpen(null);
  vi.useRealTimers();
});

describe('a durable index write touches only the changed chunk', () => {
  test('a burst within one seq band writes exactly that chunk, and a write to a new band leaves the first chunk untouched', async () => {
    vi.useFakeTimers();
    const rec = recordingTx();
    rowStore.__setBackingForTest(rec.tx);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 300); // warm the mirror

    // 50 live-tail rows, all in chunk 0 (seq 0..49).
    for (let i = 0; i < 50; i++) {
      await rowStore.upsert(SID, [mrow({mid: 'a' + i, seq: i, text: 'a' + i})]);
    }
    rec.clear();
    await vi.advanceTimersByTimeAsync(3100); // the coalesced flush
    // ONE index write, and it is chunk 0 alone.
    expect(idxKeys(rec.puts)).toEqual([`${SID}|idx|0`]);

    // A single row far up the axis lands in chunk 3 (seq 6000). The flush must
    // rewrite ONLY chunk 3 -- chunk 0 is never re-serialised.
    rec.clear();
    await rowStore.upsert(SID, [mrow({mid: 'far', seq: 3 * SPAN, text: 'far'})]);
    await vi.advanceTimersByTimeAsync(3100);
    expect(idxKeys(rec.puts)).toEqual([`${SID}|idx|3`]);
    expect(idxKeys(rec.puts)).not.toContain(`${SID}|idx|0`);
  });

  test('a below-floor backfill rewrites only the older chunk it landed in', async () => {
    vi.useFakeTimers();
    const rec = recordingTx();
    rowStore.__setBackingForTest(rec.tx);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 100);

    // Fill the tail across chunk 2 so the window floors well above chunk 0.
    for (let i = 0; i < 60; i++) {
      await rowStore.upsert(SID, [mrow({mid: 't' + i, seq: 2 * SPAN + i, text: 't' + i})]);
    }
    await vi.advanceTimersByTimeAsync(3100);
    rec.clear();

    // A backfill page below the floor, in chunk 0 (seq 5): only chunk 0 is written.
    await rowStore.upsert(SID, [mrow({mid: 'old', seq: 5, ts: 5, text: 'old'})]);
    await vi.advanceTimersByTimeAsync(3100);
    expect(idxKeys(rec.puts)).toEqual([`${SID}|idx|0`]);
  });
});

describe('a cross-chunk re-seat leaves no durable twin', () => {
  test('a renumber that moves a row to a new chunk rewrites the old (now empty) chunk and the new one', async () => {
    vi.useFakeTimers();
    const rec = recordingTx();
    rowStore.__setBackingForTest(rec.tx);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 300);

    await rowStore.upsert(SID, [mrow({mid: 'x', seq: 100, ts: 100, text: 'x'})]); // chunk 0
    await vi.advanceTimersByTimeAsync(3100);
    expect(rec.db.has(`${SID}|idx|0`)).toBe(true);
    rec.clear();

    // The engine renumbers the same row (same mid) up to seq 5000: chunk 2.
    await rowStore.upsert(SID, [mrow({mid: 'x', seq: 2 * SPAN + 1000, ts: 100, text: 'x'})]);
    await vi.advanceTimersByTimeAsync(3100);
    // The new chunk is written; the emptied old chunk record is deleted.
    expect(idxKeys(rec.puts)).toContain(`${SID}|idx|2`);
    expect(rec.dels).toContain(`${SID}|idx|0`);

    // A cold reload holds ONE tuple for the row, at its new seq, no twin.
    rowStore.setOpen(null);
    rowStore.close(SID);
    const {messages} = await rowStore.openWindow(SID, 300);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('x');
    expect(rowStore.__mirror(SID)!.idx).toHaveLength(1);
    expect(rowStore.__mirror(SID)!.idx[0].seq).toBe(2 * SPAN + 1000);
  });
});

describe('a cold reload rebuilds the index exactly, in order, from the chunks', () => {
  test('rows scattered across chunks reassemble in ts order with no rows lost or duplicated', async () => {
    const rec = recordingTx();
    rowStore.__setBackingForTest(rec.tx);

    // Insert out of order and across four chunks; ts tracks seq so ts order is the
    // seq order the reload must recover.
    const seqs = [4500, 10, 2500, 2000, 100, 6500, 30];
    for (const seq of seqs) {
      await rowStore.upsert(SID, [mrow({mid: 'r' + seq, seq, ts: seq, text: 'r' + seq})]);
    }
    rowStore.close(SID); // evict the warm mirror; the close flushes the chunks first

    // More than one chunk record was written (the point of chunking).
    const chunkKeys = [...rec.db.keys()].filter((k) => k.startsWith(`${SID}|idx|`));
    expect(chunkKeys.length).toBeGreaterThan(1);
    expect(rec.db.has(`${SID}|idx`)).toBe(false); // no monolith

    const {messages} = await rowStore.openWindow(SID, 100);
    expect(messages.map((m) => m.text)).toEqual([
      'r10',
      'r30',
      'r100',
      'r2000',
      'r2500',
      'r4500',
      'r6500'
    ]);
    // Every tuple present exactly once, in the total order.
    const idx = rowStore.__mirror(SID)!.idx;
    expect(idx.map((t) => t.seq)).toEqual([10, 30, 100, 2000, 2500, 4500, 6500]);
    expect(new Set(idx.map((t) => t.id)).size).toBe(idx.length);
  });
});

describe('the old monolithic index record migrates to chunks on open', () => {
  const seed = (db: Map<string, {key: string}>, rows: StoreRow[]): void => {
    for (const r of rows) db.set(`${SID}|r|${r.id}`, {...r, key: `${SID}|r|${r.id}`} as never);
    db.set(`${SID}|idx`, {
      key: `${SID}|idx`,
      sessionId: SID,
      tuples: rows.map((r) => ({id: r.id, seq: r.seq, ts: r.ts, kind: r.kind}))
    } as never);
  };

  test('a cold open reads the monolith, projects every row, then the flush writes chunks and deletes the monolith', async () => {
    const rec = recordingTx();
    // A device upgraded from the monolithic build: one <sid>|idx record, no chunks.
    const rows = [
      mrow({mid: 'm0', seq: 0, ts: 0, text: 'm0'}),
      mrow({mid: 'm1', seq: 1, ts: 1, text: 'm1'}),
      mrow({mid: 'm2', seq: 2 * SPAN + 3, ts: 5000, text: 'm2'})
    ];
    seed(rec.db, rows);
    rowStore.__setBackingForTest(rec.tx);

    // The open reads the legacy record and projects all three rows.
    const first = await rowStore.openWindow(SID, 300);
    expect(first.messages.map((m) => m.text)).toEqual(['m0', 'm1', 'm2']);

    // The flush migrates: the chunked records appear and the monolith is deleted.
    rowStore.setOpen(null);
    rowStore.close(SID);
    await Promise.resolve(); // let pruneStaleChunks' read microtask settle
    expect(rec.db.has(`${SID}|idx`)).toBe(false);
    expect(rec.db.has(`${SID}|idx|0`)).toBe(true); // seqs 0,1
    expect(rec.db.has(`${SID}|idx|2`)).toBe(true); // seq 2*SPAN+3

    // A second cold open now reads the chunks (no monolith) and still shows all.
    const second = await rowStore.openWindow(SID, 300);
    expect(second.messages.map((m) => m.text)).toEqual(['m0', 'm1', 'm2']);
  });

  test('migration is crash-safe: a monolith left in place (flush lost) is re-read and re-migrated', async () => {
    const rec = recordingTx();
    seed(rec.db, [
      mrow({mid: 'k0', seq: 0, ts: 0, text: 'k0'}),
      mrow({mid: 'k1', seq: 5, ts: 5, text: 'k1'})
    ]);
    rowStore.__setBackingForTest(rec.tx);

    // Open (reads monolith, arms the migrating flush) then a crash: drop the warm
    // state WITHOUT flushing, so nothing was written and the monolith survives.
    await rowStore.openWindow(SID, 300);
    rowStore.__setBackingForTest(rec.tx); // drop warm mirrors, keep the same db
    expect(rec.db.has(`${SID}|idx`)).toBe(true); // monolith still there
    expect(rec.db.has(`${SID}|idx|0`)).toBe(false); // chunks never written

    // The next boot re-reads the monolith and projects correctly (idempotent).
    const {messages} = await rowStore.openWindow(SID, 300);
    expect(messages.map((m) => m.text)).toEqual(['k0', 'k1']);
  });
});
