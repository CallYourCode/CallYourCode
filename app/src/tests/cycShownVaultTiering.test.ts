import {beforeEach, describe, expect, test, vi} from 'vitest';

/* The tiering fix: prefetched shown documents evict BEFORE user-opened ones, so
 * a prefetch flood can never cost the user a document they actually opened.
 *
 * The test is non-vacuous by construction: it ports today's eviction order as
 * `oldEnforceCaps` and shows that under it the user-opened doc is the one
 * evicted, while the tiered store spares it and takes a prefetched row instead.
 * Neuter tierOf in showVault (make it constant) and the survival assertion
 * below fails. */

// The same minimal in-memory IndexedDB the offline suite uses: one keyPath
// 'key' store, writes resolving on oncomplete.
type Row = Record<string, unknown>;
const rows = new Map<string, Row>();
function req(result: unknown, txn?: {oncomplete?: (() => void) | null}) {
  const r: {
    result: unknown;
    transaction?: unknown;
    onsuccess?: (() => void) | null;
    onerror?: (() => void) | null;
  } = {result, transaction: txn};
  queueMicrotask(() => {
    r.onsuccess?.();
    if (txn) queueMicrotask(() => txn.oncomplete?.());
  });
  return r;
}
function objectStore(txn: {oncomplete?: (() => void) | null}) {
  return {
    put: (v: Row) => {
      rows.set(String(v.key), v);
      return req(v.key, txn);
    },
    get: (k: string) => req(rows.get(String(k)), txn),
    getAll: () => req([...rows.values()], txn),
    delete: (k: string) => {
      rows.delete(String(k));
      return req(undefined, txn);
    },
    clear: () => {
      rows.clear();
      return req(undefined, txn);
    }
  };
}
const fakeDb = {
  objectStoreNames: {contains: () => true},
  createObjectStore: () => objectStore({}),
  close: () => {},
  onversionchange: null as unknown,
  transaction: () => {
    const txn: {oncomplete?: (() => void) | null} = {};
    return {objectStore: () => objectStore(txn)};
  }
};
const fakeIndexedDb = {
  open: () => {
    const r: {
      result: unknown;
      onupgradeneeded?: (() => void) | null;
      onsuccess?: (() => void) | null;
      onerror?: (() => void) | null;
      onblocked?: (() => void) | null;
    } = {result: fakeDb};
    queueMicrotask(() => {
      r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r;
  }
};
vi.stubGlobal('indexedDB', fakeIndexedDb);

vi.mock('../engine/contract', () => ({
  engineCapFetch: vi.fn(),
  docUrl: (id: string) => `doc://${id}`
}));

import * as showVault from '../engine/showVault';

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

const MB = 1024 * 1024;
const big = 'x'.repeat(5 * MB); // one 5MB body reused by reference, no per-doc copy

beforeEach(() => {
  rows.clear();
});

// Today's enforceCaps, ported verbatim as the reference: images before
// documents, oldest first within each, age then bytes then count. No tier.
type Ref = {key: string; blob?: unknown; bytes: number; ts: number};
function oldEnforceCaps(all: Ref[], incomingBytes: number): string[] {
  const MAX_BYTES = 24 * MB;
  const MAX_DOCS = 200;
  const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const doomed: string[] = [];
  let total = all.reduce((n, r) => n + r.bytes, 0) + incomingBytes;
  let count = all.length + 1;
  const queue = [...all.filter((r) => r.blob), ...all.filter((r) => !r.blob)];
  for (const rec of queue) {
    if (now - rec.ts > MAX_AGE_MS) {
      doomed.push(rec.key);
      total -= rec.bytes;
      count--;
      continue;
    }
    if (total > MAX_BYTES) {
      doomed.push(rec.key);
      total -= rec.bytes;
      count--;
      continue;
    }
    if (count > MAX_DOCS) {
      doomed.push(rec.key);
      count--;
    }
  }
  return doomed;
}

describe('shown vault tiering: a prefetch flood spares the user-opened doc', () => {
  test('the opened doc survives the flood; the old order would have evicted it', async () => {
    // Recent timestamps (none age out): opened is the OLDEST, prefetched newer.
    const t0 = Date.now();

    // A user-opened doc, older than everything else but well within the age cap.
    await showVault.put({
      key: 'opened',
      sessionId: 's',
      name: 'opened.md',
      fileKind: 'markdown',
      content: big,
      ts: t0 - 1000,
      tier: 'opened'
    });
    await flush();

    // The state right before the decisive write: opened (oldest) plus three
    // prefetched rows, all 5MB docs, 20MB in the store.
    const before: Ref[] = [
      {key: 'opened', bytes: 5 * MB, ts: t0 - 1000},
      {key: 'pf-1', bytes: 5 * MB, ts: t0 + 1},
      {key: 'pf-2', bytes: 5 * MB, ts: t0 + 2},
      {key: 'pf-3', bytes: 5 * MB, ts: t0 + 3}
    ];
    // The reference (today's order) would evict the OLDEST doc: the opened one.
    expect(oldEnforceCaps(before, 5 * MB)).toContain('opened');

    // Now flood the real tiered store with prefetched docs past the 24MB cap.
    for (let i = 1; i <= 5; i++) {
      await showVault.put({
        key: `pf-${i}`,
        sessionId: 's',
        name: `pf-${i}.md`,
        fileKind: 'markdown',
        content: big,
        ts: t0 + i,
        tier: 'prefetched'
      });
      await flush();
    }

    // The tiered store evicted prefetched rows first: the user-opened doc is
    // still here.
    expect(await showVault.get('opened')).not.toBeNull();
    // And prefetched rows were the ones taken (the store is capped, so some are
    // gone).
    const survivors = (await showVault.list()).map((r) => r.key).sort();
    expect(survivors).toContain('opened');
    const evictedPrefetched = ['pf-1', 'pf-2', 'pf-3', 'pf-4', 'pf-5'].filter(
      (k) => !survivors.includes(k)
    );
    expect(evictedPrefetched.length).toBeGreaterThan(0);
  });

  test('a user open that hits a prefetched row promotes it to opened', async () => {
    await showVault.put({
      key: 'doc',
      sessionId: 's',
      name: 'doc.md',
      fileKind: 'markdown',
      content: 'hi',
      tier: 'prefetched'
    });
    await flush();
    expect((await showVault.get('doc'))?.tier).toBe('prefetched');

    // loadDoc hitting the vaulted row upgrades its tier without a fetch.
    await showVault.loadDoc('doc', 'doc://doc', 's');
    await flush();
    expect((await showVault.get('doc'))?.tier).toBe('opened');
  });
});
