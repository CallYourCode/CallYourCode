import {describe, expect, test} from 'vitest';
import {upgradeHistoryDb} from '../engine/history';

// upgradeHistoryDb is the whole of onupgradeneeded for the `cyc-history`
// IndexedDB, pure over the calls it makes, so it runs here without a browser.
// v4 is the offline schema: `pages` (pages + meta), `roster` and `anchors` as
// stores of their own. The session records ride on the pages, not a store of
// their own. Every row written before v4 is stale (v3 re-keyed the rows from
// harness session ids to engine agent ids; before v4 the roster lived inside
// `pages` with nine fields), so a v1, v2 or v3 store lands at v4 with `pages`
// cleared exactly once and the two new stores created. A fresh install or a
// same-version open clears nothing.

function fakeDb(stores: string[]) {
  const names = new Set(stores);
  const calls: string[] = [];
  const db = {
    objectStoreNames: {contains: (n: string) => names.has(n)} as DOMStringList,
    deleteObjectStore: (n: string) => {
      names.delete(n);
      calls.push(`delete:${n}`);
    },
    createObjectStore: (n: string, o?: IDBObjectStoreParameters) => {
      names.add(n);
      calls.push(`create:${n}(${String(o?.keyPath)})`);
      return {} as IDBObjectStore;
    }
  };
  const tx = {
    objectStore: (n: string) => ({
      clear: () => {
        calls.push(`clear:${n}`);
        return {} as IDBRequest<undefined>;
      }
    })
  };
  return {db, tx, calls, names};
}

const NEW_STORES = ['create:roster(engineKey)', 'create:anchors(sessionId)'];

describe('upgradeHistoryDb', () => {
  test('a fresh install creates the three stores and clears nothing', () => {
    const f = fakeDb([]);
    upgradeHistoryDb(f.db, 0, f.tx);
    expect(f.calls).toEqual(['create:pages(key)', ...NEW_STORES]);
  });

  test('a v2 database (roster inside pages, session-id keys) lands at v4 empty of pages', () => {
    const f = fakeDb(['pages']);
    upgradeHistoryDb(f.db, 2, f.tx);
    expect(f.calls).toEqual(['clear:pages', ...NEW_STORES]);
    expect([...f.names].sort()).toEqual(['anchors', 'pages', 'roster']);
  });

  test('a v3 database (agent-id keys, roster still inside pages) lands at v4 empty of pages', () => {
    const f = fakeDb(['pages']);
    upgradeHistoryDb(f.db, 3, f.tx);
    expect(f.calls).toEqual(['clear:pages', ...NEW_STORES]);
  });

  test('a v1 database drops the dead sessions store and clears the old-keyed pages', () => {
    const f = fakeDb(['sessions', 'pages']);
    upgradeHistoryDb(f.db, 1, f.tx);
    expect(f.calls).toEqual(['delete:sessions', 'clear:pages', ...NEW_STORES]);
  });

  test('a v1 database without a pages store gets one, with nothing to clear', () => {
    const f = fakeDb(['sessions']);
    upgradeHistoryDb(f.db, 1, f.tx);
    expect(f.calls).toEqual(['delete:sessions', 'create:pages(key)', ...NEW_STORES]);
  });

  test('from v4 on, an upgrade keeps every record and every store', () => {
    const f = fakeDb(['pages', 'roster', 'anchors']);
    upgradeHistoryDb(f.db, 4, f.tx);
    expect(f.calls).toEqual([]);
  });

  test('without an upgrade transaction there is nothing to clear through, and no throw', () => {
    const f = fakeDb(['pages']);
    expect(() => upgradeHistoryDb(f.db, 2, null)).not.toThrow();
    expect(f.calls).toEqual(NEW_STORES);
  });
});
