import {beforeEach, describe, expect, test, vi} from 'vitest';

// The clipVault over an in-memory stand-in for its IndexedDB store (jsdom has
// no IndexedDB): every tx() the vault issues runs against this Map, so the
// cap sweep and release() are exercised on real records.
const db = new Map<string, Record<string, unknown> & {key: string}>();
vi.mock('@/shared/browser', () => ({
  CLIPS: 'clips',
  transactionOn: async (_store: string, _mode: string, run: (s: unknown) => unknown) => {
    const fake = {
      getAll: () => ({result: [...db.values()]}),
      get: (k: string) => ({result: db.get(k)}),
      put: (r: {key: string}) => {
        db.set(r.key, r as Record<string, unknown> & {key: string});
        return {result: r.key};
      },
      delete: (k: string) => {
        db.delete(k);
        return {result: undefined as unknown};
      }
    };
    return (run(fake) as {result: unknown}).result;
  }
}));

const logged: {event: string; fields: Record<string, unknown>}[] = [];
vi.mock('@/shared/logging', () => ({
  cyclog: (event: string, fields: Record<string, unknown> = {}) => {
    logged.push({event, fields});
  }
}));

import * as clipVault from '../audio/clipVault';

const MB = 1024 * 1024;
const blobOf = (bytes: number) => ({size: bytes, type: 'audio/webm'}) as unknown as Blob;

function plant(key: string, bytes: number, ts: number, extra: Record<string, unknown> = {}) {
  db.set(key, {key, sessionId: 's', blob: blobOf(bytes), mime: 'audio/webm', bytes, ts, tries: 0, ...extra});
}

const events = (name: string) => logged.filter((l) => l.event === name);

describe('clipVault caps and holders', () => {
  let unhold: (() => void)[] = [];
  beforeEach(() => {
    db.clear();
    logged.length = 0;
    for (const u of unhold) u();
    unhold = [];
  });

  test('the byte cap evicts the oldest UNHELD clip and never a held one', async () => {
    const now = Date.now();
    // three 50 MB clips (150 MB, over the 120 MB cap once anything is parked)
    plant('old-held', 50 * MB, now - 3000);
    plant('mid', 50 * MB, now - 2000);
    plant('new', 50 * MB, now - 1000);
    unhold.push(clipVault.holding(() => new Set(['old-held']), 'transfer'));

    expect(await clipVault.park({key: 'in', sessionId: 's', blob: blobOf(1 * MB), mime: 'audio/webm', ts: now})).toBe('in');

    // the oldest clip is held: spared. The next oldest went instead.
    expect(db.has('old-held')).toBe(true);
    expect(db.has('mid')).toBe(false);
    expect(db.has('new')).toBe(true);
    expect(db.has('in')).toBe(true);
    expect(events('clip.vault.evicted').map((e) => e.fields.key)).toEqual(['mid']);
    expect(events('clip.vault.over-cap-held')).toHaveLength(0);
  });

  test('when every clip is held the store stays over the cap and says so (clip.vault.over-cap-held)', async () => {
    const now = Date.now();
    plant('a', 60 * MB, now - 3000);
    plant('b', 60 * MB, now - 2000);
    unhold.push(clipVault.holding(() => new Set(['a']), 'composer'));
    unhold.push(clipVault.holding(() => new Set(['b']), 'transfer'));

    await clipVault.park({key: 'c', sessionId: 's', blob: blobOf(10 * MB), mime: 'audio/webm', ts: now});

    expect([...db.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(events('clip.vault.evicted')).toHaveLength(0);
    const over = events('clip.vault.over-cap-held');
    expect(over).toHaveLength(1);
    expect(over[0].fields).toMatchObject({held: 2, heldBytes: 120 * MB, maxBytes: 120 * MB});
  });

  test('the count cap and the age cap skip held keys too', async () => {
    const now = Date.now();
    // 41 tiny clips: one over the 40 cap once a 42nd is parked; the oldest is
    // held and ALSO older than 7 days (the age cap would take it first).
    plant('held-ancient', 10, now - 8 * 24 * 3600 * 1000);
    for (let i = 1; i <= 40; i++) plant(`k${i}`, 10, now - (41 - i) * 1000);
    unhold.push(clipVault.holding(() => new Set(['held-ancient']), 'transfer'));

    await clipVault.park({key: 'in', sessionId: 's', blob: blobOf(10), mime: 'audio/webm', ts: now});

    expect(db.has('held-ancient')).toBe(true);
    // two unheld went: the oldest for the count cap and one more for the incoming
    const gone = events('clip.vault.evicted').map((e) => e.fields.key);
    expect(gone).toEqual(['k1', 'k2']);
    expect(db.size).toBe(40);
  });

  test('release refuses a key an in-flight transfer holds unless the worker itself releases it', async () => {
    plant('t1', 10, Date.now());
    plant('c1', 10, Date.now());
    unhold.push(clipVault.holding(() => new Set(['t1']), 'transfer'));
    unhold.push(clipVault.holding(() => new Set(['c1']), 'composer'));

    // the composer (or a settlement racing the worker) cannot take a transfer's bytes
    expect(await clipVault.release('t1', 'composer dropped the block')).toBe(false);
    expect(db.has('t1')).toBe(true);
    expect(events('clip.vault.release-refused')).toHaveLength(1);
    expect(events('clip.vault.released')).toHaveLength(0);

    // a composer-held key is not a transfer's: released as before
    expect(await clipVault.release('c1', 'composer dropped the block')).toBe(true);
    expect(db.has('c1')).toBe(false);

    // the worker's own release goes through
    expect(await clipVault.release('t1', 'transfer finished', {}, {byTransfer: true})).toBe(true);
    expect(db.has('t1')).toBe(false);
    expect(events('clip.vault.released')).toHaveLength(2);
  });

  test('park records the transfer flag so the recovery sweep can skip it', async () => {
    await clipVault.park({key: 'x', sessionId: 's', blob: blobOf(5), mime: 'audio/webm', ts: Date.now(), transfer: true});
    expect(db.get('x')).toMatchObject({transfer: true, bytes: 5});
  });
});
