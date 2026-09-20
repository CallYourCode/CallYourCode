import {beforeEach, describe, expect, test, vi} from 'vitest';

/* Plugin panel HTML is cached by (engineKey, pluginId, version): a version-
 * matched open renders from memory or IndexedDB with ZERO tunneled fetches, a
 * version bump refetches and replaces the cached row, offline renders any held
 * bytes, and a total-bytes cap drops the oldest panels first. A minimal in-
 * memory IndexedDB stands in for the store so put/get and eviction are proven
 * at the row level, not on a spy. */

// A tiny functional IndexedDB covering exactly what panelVault touches: one
// keyPath:'key' store with put/get/getAll/delete/clear and a transaction that
// completes after the request succeeds (writes wait on oncomplete).
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

const logs = vi.hoisted(() => ({emit: vi.fn()}));
vi.mock('@/shared/logging', () => ({cyclog: logs.emit}));

import * as panelVault from '../engine/panelVault';

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  rows.clear();
  panelVault._resetMemory();
  logs.emit.mockReset();
});

const ENGINE = 'engine://1';

describe('panel cache: version-matched hit renders with no fetch', () => {
  test('first open fetches once and caches; a version-matched repeat open never fetches', async () => {
    const fetchFresh = vi.fn().mockResolvedValue('<html>files v3</html>');
    const rendered: string[] = [];

    await panelVault.loadPanel(ENGINE, 'files', 3, fetchFresh, (h) => rendered.push(h));
    await flush();

    expect(fetchFresh).toHaveBeenCalledTimes(1);
    expect(rendered).toEqual(['<html>files v3</html>']);

    // A repeat open at the same version must render from cache with ZERO
    // fetches. This assertion is non-vacuous: without the cache the second
    // open would fetch again (fetchFresh count would be 2).
    rendered.length = 0;
    await panelVault.loadPanel(ENGINE, 'files', 3, fetchFresh, (h) => rendered.push(h));
    await flush();

    expect(fetchFresh).toHaveBeenCalledTimes(1);
    expect(rendered).toEqual(['<html>files v3</html>']);
    expect(logs.emit).toHaveBeenCalledWith('plugin.panel.cache', {
      plugin: 'files',
      result: 'hit',
      bytes: '<html>files v3</html>'.length
    });
  });

  test('a fresh in-memory instance still hits from IndexedDB with no fetch', async () => {
    const first = vi.fn().mockResolvedValue('<html>persist</html>');
    await panelVault.loadPanel(ENGINE, 'git', 2, first, () => {});
    await flush();
    expect(first).toHaveBeenCalledTimes(1);

    // Drop the memory tier: the IDB row must satisfy the next open alone.
    panelVault._resetMemory();
    const second = vi.fn().mockResolvedValue('<html>persist</html>');
    const rendered: string[] = [];
    await panelVault.loadPanel(ENGINE, 'git', 2, second, (h) => rendered.push(h));
    await flush();

    expect(second).not.toHaveBeenCalled();
    expect(rendered).toEqual(['<html>persist</html>']);
  });
});

describe('panel cache: version bump refetches and replaces the row', () => {
  test('a new version misses, fetches, and drops the stale version', async () => {
    await panelVault.loadPanel(
      ENGINE,
      'files',
      3,
      async () => '<html>v3</html>',
      () => {}
    );
    await flush();

    const bumped = vi.fn().mockResolvedValue('<html>v4</html>');
    const rendered: string[] = [];
    await panelVault.loadPanel(ENGINE, 'files', 4, bumped, (h) => rendered.push(h));
    await flush();

    expect(bumped).toHaveBeenCalledTimes(1);
    expect(rendered).toEqual(['<html>v4</html>']);

    // The stale v3 row is gone: only the v4 row remains for this plugin.
    const remaining = [...rows.values()].filter(
      (r) => r.engineKey === ENGINE && r.pluginId === 'files'
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].version).toBe(4);

    // v4 now hits with no fetch.
    const after = vi.fn().mockResolvedValue('<html>v4</html>');
    await panelVault.loadPanel(ENGINE, 'files', 4, after, () => {});
    await flush();
    expect(after).not.toHaveBeenCalled();
  });
});

describe('panel cache: offline', () => {
  test('offline with a cached version renders it without a live fetch', async () => {
    await panelVault.loadPanel(
      ENGINE,
      'files',
      3,
      async () => '<html>v3</html>',
      () => {}
    );
    await flush();

    // A new version whose fetch fails (engine unreachable): the held v3 bytes
    // still paint, a big offline win over a blank stage.
    const offline = vi.fn().mockRejectedValue(new Error('engine offline'));
    const rendered: string[] = [];
    await panelVault.loadPanel(ENGINE, 'files', 4, offline, (h) => rendered.push(h));
    await flush();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(rendered).toEqual(['<html>v3</html>']);
  });

  test('offline with nothing cached rejects, so the caller can show its error', async () => {
    const offline = vi.fn().mockRejectedValue(new Error('engine offline'));
    const rendered: string[] = [];

    await expect(
      panelVault.loadPanel(ENGINE, 'crons', 1, offline, (h) => rendered.push(h))
    ).rejects.toThrow('engine offline');
    expect(rendered).toEqual([]);
  });
});

describe('panel cache: no usable version falls back to stale-while-revalidate', () => {
  test('paints cached at once, refetches, and swaps only on a byte difference', async () => {
    // Seed a v0 (no usable version) row by fetching once.
    await panelVault.loadPanel(
      ENGINE,
      'notes',
      0,
      async () => '<html>old</html>',
      () => {}
    );
    await flush();

    // Changed bytes -> two renders (cached then fresh), cache updated.
    const changed = vi.fn().mockResolvedValue('<html>new</html>');
    const rendered: string[] = [];
    await panelVault.loadPanel(ENGINE, 'notes', 0, changed, (h) => rendered.push(h));
    await flush();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(rendered).toEqual(['<html>old</html>', '<html>new</html>']);

    // Unchanged bytes -> one render (the cached paint), no swap.
    const same = vi.fn().mockResolvedValue('<html>new</html>');
    const rendered2: string[] = [];
    await panelVault.loadPanel(ENGINE, 'notes', 0, same, (h) => rendered2.push(h));
    await flush();

    expect(same).toHaveBeenCalledTimes(1);
    expect(rendered2).toEqual(['<html>new</html>']);
  });
});

describe('panel cache: cap eviction drops the oldest', () => {
  test('a write over the total-bytes cap evicts the oldest panel first', async () => {
    // ~3MB rows: two fit under the 8MB cap, the third forces the oldest out.
    const big = (tag: string) => tag.repeat(3 * 1024 * 1024);

    await panelVault.loadPanel(
      ENGINE,
      'p-old',
      1,
      async () => big('a'),
      () => {}
    );
    await flush();
    await panelVault.loadPanel(
      ENGINE,
      'p-mid',
      1,
      async () => big('b'),
      () => {}
    );
    await flush();
    await panelVault.loadPanel(
      ENGINE,
      'p-new',
      1,
      async () => big('c'),
      () => {}
    );
    await flush();

    const present = new Set([...rows.values()].map((r) => r.pluginId));
    expect(present.has('p-old')).toBe(false);
    expect(present.has('p-mid')).toBe(true);
    expect(present.has('p-new')).toBe(true);

    // The evicted plugin is a miss again: opening it fetches.
    const refetch = vi.fn().mockResolvedValue(big('a'));
    panelVault._resetMemory();
    await panelVault.loadPanel(ENGINE, 'p-old', 1, refetch, () => {});
    await flush();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
