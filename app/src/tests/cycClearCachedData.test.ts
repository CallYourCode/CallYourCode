import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

/* The settings "Clear cached data" button drops this device's cached chats.
 * The conversation store now lives in the cyc-rows IndexedDB database, so a
 * clear that does not delete cyc-rows leaves the cached conversation behind
 * (the owner's real-device bug). And deleteDatabase resolves on onblocked, so
 * the delete silently no-ops while the row store's persistent connection is
 * open. clearCachedData must add cyc-rows to the cleared set AND close the row
 * store's connection (dropping its warm mirrors) before the delete.
 *
 * These tests wire the REAL rowStore over the REAL deleteDatabase path against a
 * fake IndexedDB that models the one behaviour a spy cannot: a delete blocks on
 * an open connection and only succeeds once every connection is closed. */

// A minimal in-memory IndexedDB covering exactly what rowStore.openDb/realTx and
// clearCachedData's deleteDatabase touch. Databases and their rows persist in a
// module registry across open/close, so a delete truly removes bytes and a
// re-open lazily rebuilds. deleteDatabase fires onblocked (and deletes nothing)
// while any connection to the database is still open, exactly like the browser.
type StoreMap = Map<string, {key: string}>;
type DbEntry = {stores: Map<string, StoreMap>; conns: Set<FakeDb>};
const registry = new Map<string, DbEntry>();

function fire(target: {onsuccess?: (() => void) | null; result?: unknown}) {
  queueMicrotask(() => target.onsuccess?.());
}

function makeStore(rows: StoreMap): IDBObjectStore {
  const request = (result: unknown) => {
    const r = {result} as unknown as IDBRequest & {result: unknown};
    fire(r as unknown as {onsuccess?: (() => void) | null});
    return r as unknown as IDBRequest;
  };
  return {
    get: (k: string) => request(rows.get(k)),
    getAll: () => request([...rows.values()]),
    getAllKeys: () => request([...rows.keys()]),
    put: (v: {key: string}) => {
      rows.set(v.key, v);
      return request(v.key);
    },
    delete: (k: string) => {
      rows.delete(k);
      return request(undefined);
    },
    clear: () => {
      rows.clear();
      return request(undefined);
    }
  } as unknown as IDBObjectStore;
}

class FakeDb {
  onversionchange: (() => void) | null = null;
  constructor(
    private name: string,
    private stores: Map<string, StoreMap>
  ) {}
  get objectStoreNames() {
    return {contains: (n: string) => this.stores.has(n)} as unknown as DOMStringList;
  }
  createObjectStore(name: string) {
    const s: StoreMap = new Map();
    this.stores.set(name, s);
    return makeStore(s);
  }
  transaction(name: string) {
    const s = this.stores.get(name) ?? new Map();
    return {objectStore: () => makeStore(s)} as unknown as IDBTransaction;
  }
  close() {
    registry.get(this.name)?.conns.delete(this);
  }
}

const fakeIndexedDb = {
  open: (name: string) => {
    const r = {result: undefined as unknown} as unknown as IDBOpenDBRequest & {
      result: unknown;
      onupgradeneeded?: (() => void) | null;
      onsuccess?: (() => void) | null;
      onerror?: (() => void) | null;
      onblocked?: (() => void) | null;
    };
    let entry = registry.get(name);
    const fresh = !entry;
    if (!entry) {
      entry = {stores: new Map(), conns: new Set()};
      registry.set(name, entry);
    }
    const conn = new FakeDb(name, entry.stores);
    entry.conns.add(conn);
    r.result = conn as unknown as IDBDatabase;
    queueMicrotask(() => {
      if (fresh) r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r as unknown as IDBOpenDBRequest;
  },
  deleteDatabase: (name: string) => {
    const r = {} as unknown as IDBOpenDBRequest & {
      onsuccess?: (() => void) | null;
      onerror?: (() => void) | null;
      onblocked?: (() => void) | null;
    };
    queueMicrotask(() => {
      const entry = registry.get(name);
      if (entry && entry.conns.size > 0) {
        // A page still holds the database: the browser fires onblocked and the
        // delete makes no progress. This is the defect the fix must dodge.
        r.onblocked?.();
        return;
      }
      registry.delete(name);
      r.onsuccess?.();
    });
    return r as unknown as IDBOpenDBRequest;
  }
};

vi.stubGlobal('indexedDB', fakeIndexedDb);

vi.mock('@/features/chat/wallpaper', () => ({paintAllChatWallpapers: () => {}}));
vi.mock('@/components/presentation', () => ({setPresentationTheme: () => {}}));

import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow, type StoreRow} from '../engine/store/rows/core';
import type {CycEngineMessage} from '../engine/store/types';
import {clearCachedData} from '../features/settings/preferences';

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

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  registry.clear();
  // Start each test from a cold store over the real (faked) IndexedDB backing.
  rowStore.closeForClear();
});

afterEach(() => {
  rowStore.closeForClear();
});

describe('clearCachedData clears the conversation store', () => {
  test('seeded cyc-rows holds nothing for the session after a clear', async () => {
    await rowStore.upsert(SID, [mrow({mid: 'a', seq: 0, text: 'hi'}), mrow({mid: 'b', seq: 1})]);
    await flush();
    // The rows are really durable before the clear.
    rowStore.closeForClear();
    expect((await rowStore.openWindow(SID, 50)).messages).toHaveLength(2);

    await clearCachedData();
    await flush();
    // The clear really deleted the database (a blocked no-op would leave it).
    expect(registry.has('cyc-rows')).toBe(false);

    // A fresh read after the clear: the store reopens empty and holds nothing
    // for the session.
    const {messages} = await rowStore.openWindow(SID, 50);
    expect(messages).toHaveLength(0);
  });

  test('clearCachedData completes while the row store connection is open', async () => {
    await rowStore.upsert(SID, [mrow({mid: 'a', seq: 0})]);
    await flush();
    // The store keeps its persistent connection open here. Without closing it,
    // deleteDatabase blocks forever; the fix closes it first, so the clear
    // resolves and the database is actually deleted (not a blocked no-op).
    await expect(clearCachedData()).resolves.toBeUndefined();
    await flush();
    expect(registry.has('cyc-rows')).toBe(false);
  });

  test('the store lazily reopens and accepts writes after a clear', async () => {
    await rowStore.upsert(SID, [mrow({mid: 'a', seq: 0, text: 'old'})]);
    await flush();
    await clearCachedData();
    await flush();

    // No re-init call: the next write reopens the connection on its own.
    await rowStore.upsert(SID, [mrow({mid: 'c', seq: 5, text: 'fresh'})]);
    await flush();
    rowStore.closeForClear();
    const {messages} = await rowStore.openWindow(SID, 50);
    expect(messages.map((m) => m.text)).toEqual(['fresh']);
    expect(registry.has('cyc-rows')).toBe(true);
  });

  test('an open chat drops its warm mirror on a clear (no painting from the dead store)', async () => {
    rowStore.setOpen(SID);
    await rowStore.upsert(SID, [mrow({mid: 'a', seq: 0, text: 'shown'})]);
    await flush();
    await rowStore.openWindow(SID, 50);
    expect(rowStore.projection(SID).messages).toHaveLength(1);

    await clearCachedData();
    await flush();

    // The visible session's warm mirror is empty: it cannot keep repainting the
    // cleared conversation.
    expect(rowStore.projection(SID).messages).toHaveLength(0);
    expect(rowStore.isOpen(SID)).toBe(false);
  });
});
