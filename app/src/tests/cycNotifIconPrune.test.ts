import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';

/* Pruning the cyc-avatars store (the unbounded-growth fix): rows whose session
 * left the roster are deleted by the page-side writer, on the same roster-sync
 * path that writes them. The rule under test (stated in notifAvatars.ts):
 * prune only when armed (cold-open hydration done) and only when the keep-set
 * actually changed; a pruned-then-returned session is written afresh.
 *
 * The wire is mocked (engineImageBlob); notifIconDb runs REAL against a fake
 * indexedDB so the deletes are proven at the row level, not on a spy. */

const {engineImageBlob} = vi.hoisted(() => ({engineImageBlob: vi.fn()}));
vi.mock('../engine/contract', () => ({
  engineImageBlob,
  engineObjectUrl: vi.fn(),
  cachedImageObjectUrls: vi.fn(() => Promise.resolve(new Map<string, string>()))
}));

import {pruneNotifIcons, putNotifIcon} from '../features/media/notifIconDb';
import {
  armNotifAvatarPrune,
  pruneNotifAvatars,
  syncNotifAvatar
} from '../features/media/notifAvatars';

type Row = Record<string, unknown>;
const rows = new Map<string, Row>();

function fakeReq<T>(result: T): {result: T; onsuccess?: () => void; onerror?: () => void} {
  const r: {result: T; onsuccess?: () => void; onerror?: () => void} = {result};
  queueMicrotask(() => r.onsuccess?.());
  return r;
}

const fakeDb = {
  objectStoreNames: {contains: () => true},
  close: () => {},
  transaction: () => ({
    objectStore: () => ({
      get: (k: string) => fakeReq(rows.get(String(k))),
      getAllKeys: () => fakeReq([...rows.keys()]),
      put: (v: Row) => {
        rows.set(String(v.sessionId), v);
        return fakeReq(undefined);
      },
      delete: (k: string) => {
        rows.delete(String(k));
        return fakeReq(undefined);
      }
    })
  })
};

const openSpy = vi.fn((_name: string) => {
  const r: {result: unknown; onsuccess?: () => void; onerror?: () => void} = {result: fakeDb};
  queueMicrotask(() => r.onsuccess?.());
  return r;
});

beforeAll(() => {
  vi.stubGlobal('indexedDB', {open: openSpy});
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const seed = (id: string) => putNotifIcon({sessionId: id, icon: 'data:i/' + id, key: 'k', at: 1});

/* Ordered describe: armNotifAvatarPrune is one-way module state (as in the
 * app: armed once, after hydration, for the page's life), so the unarmed test
 * runs first. */
describe('cyc-avatars pruning: departed sessions leave the store', () => {
  test('unarmed (hydration not done), a prune call touches nothing', async () => {
    await seed('s-early');
    openSpy.mockClear();
    await pruneNotifAvatars([]);
    await flush();
    expect(openSpy).not.toHaveBeenCalled();
    expect(rows.has('s-early')).toBe(true);
    rows.clear();
  });

  test('a roster shrink removes exactly the departed rows', async () => {
    await Promise.all([seed('s1'), seed('s2'), seed('s3')]);
    await expect(pruneNotifIcons(new Set(['s1', 's3']))).resolves.toEqual(['s2']);
    expect([...rows.keys()].sort()).toEqual(['s1', 's3']);
    // Non-vacuity the other way: a keep-set covering everything deletes nothing.
    await expect(pruneNotifIcons(new Set(['s1', 's3']))).resolves.toEqual([]);
    expect(rows.size).toBe(2);
    rows.clear();
  });

  test('armed, an unchanged keep-set never opens the DB; a changed one prunes', async () => {
    armNotifAvatarPrune();
    await Promise.all([seed('a'), seed('b'), seed('c')]);
    await pruneNotifAvatars(['a', 'b']);
    await flush();
    expect([...rows.keys()].sort()).toEqual(['a', 'b']);

    openSpy.mockClear();
    await pruneNotifAvatars(['b', 'a']); // same set, any order: free
    await flush();
    expect(openSpy).not.toHaveBeenCalled();

    await pruneNotifAvatars(['a']); // the roster changed: b departs
    await flush();
    expect([...rows.keys()]).toEqual(['a']);
    rows.clear();
  });

  test('a pruned session that returns to the roster is written afresh', async () => {
    await syncNotifAvatar({id: 's-back', name: 'Boomerang'});
    await flush();
    expect(rows.has('s-back')).toBe(true);

    await pruneNotifAvatars([]); // departed: the row and the write claim go
    await flush();
    expect(rows.has('s-back')).toBe(false);

    await syncNotifAvatar({id: 's-back', name: 'Boomerang'}); // it came back
    await flush();
    expect(rows.has('s-back')).toBe(true);
  });
});
