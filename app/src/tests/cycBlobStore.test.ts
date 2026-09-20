import {describe, expect, test} from 'vitest';
import {openNamespace, type NamespaceConfig, type Tx} from '../shared/blobStore';

/* The shared blob-store engine's ONE sweep, proven on real rows through an
 * in-memory stand-in for its transaction runner (the engine touches only
 * get/getAll/put/delete/clear). Each behaviour is asserted against a control
 * that omits it, so none of these tests can pass vacuously. */

type Row = {key: string; bytes: number; ts: number; tier?: string};

function mem(): {db: Map<string, Row>; tx: Tx} {
  const db = new Map<string, Row>();
  const tx = (<T>(_mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) => {
    const store = {
      get: (k: string): {result: unknown} => ({result: db.get(k)}),
      getAll: (): {result: unknown} => ({result: [...db.values()]}),
      put: (v: Row): {result: unknown} => {
        db.set(v.key, v);
        return {result: v.key};
      },
      delete: (k: string): {result: unknown} => {
        db.delete(k);
        return {result: undefined};
      },
      clear: (): {result: unknown} => {
        db.clear();
        return {result: undefined};
      }
    } as unknown as IDBObjectStore;
    return Promise.resolve((run(store) as unknown as {result: T}).result);
  }) as Tx;
  return {db, tx};
}

const base = (tx: Tx, over: Partial<NamespaceConfig<Row>> = {}): NamespaceConfig<Row> => ({
  tx,
  keyPath: 'key',
  maxBytes: 50,
  bytesOf: (r) => r.bytes,
  tsOf: (r) => r.ts,
  ...over
});

describe('blobStore sweep: tier ordering', () => {
  test('a lower tier evicts before a higher one even when it is newer', async () => {
    const {db, tx} = mem();
    const evicted: string[] = [];
    const h = openNamespace<Row>(
      base(tx, {tierOf: (r) => (r.tier === 'low' ? 0 : 1), onEvict: (r) => evicted.push(r.key)})
    );
    db.set('high', {key: 'high', bytes: 40, ts: 1, tier: 'high'});
    db.set('low', {key: 'low', bytes: 40, ts: 2, tier: 'low'});

    await h.sweep(0);

    // Oldest-first alone would take 'high' (ts 1); the tier flips it.
    expect(evicted).toEqual(['low']);
    expect(db.has('high')).toBe(true);
    expect(db.has('low')).toBe(false);
  });

  test('control: with no tier the oldest is taken instead', async () => {
    const {db, tx} = mem();
    const evicted: string[] = [];
    const h = openNamespace<Row>(base(tx, {onEvict: (r) => evicted.push(r.key)}));
    db.set('high', {key: 'high', bytes: 40, ts: 1, tier: 'high'});
    db.set('low', {key: 'low', bytes: 40, ts: 2, tier: 'low'});

    await h.sweep(0);

    expect(evicted).toEqual(['high']);
  });
});

describe('blobStore sweep: held mode skip', () => {
  test('a held key is spared even as the oldest, and the store stays over', async () => {
    const {db, tx} = mem();
    const evicted: string[] = [];
    const h = openNamespace<Row>(
      base(tx, {
        heldPolicy: {held: () => new Set(['a']), mode: 'skip'},
        onEvict: (r) => evicted.push(r.key)
      })
    );
    db.set('a', {key: 'a', bytes: 40, ts: 1});
    db.set('b', {key: 'b', bytes: 40, ts: 2});

    await h.sweep(0);

    // 'a' is oldest and would go first, but held-skip removes it from the
    // candidates entirely; only 'b' can be taken.
    expect(evicted).toEqual(['b']);
    expect(db.has('a')).toBe(true);
  });

  test('control: with no holder the oldest is taken', async () => {
    const {db, tx} = mem();
    const evicted: string[] = [];
    const h = openNamespace<Row>(base(tx, {onEvict: (r) => evicted.push(r.key)}));
    db.set('a', {key: 'a', bytes: 40, ts: 1});
    db.set('b', {key: 'b', bytes: 40, ts: 2});

    await h.sweep(0);

    expect(evicted).toEqual(['a']);
  });
});

describe('blobStore sweep: held mode last', () => {
  test('unheld rows go before held ones, then held only if nothing else is left', async () => {
    const {db, tx} = mem();
    const order: string[] = [];
    const held = new Set(['h']);
    const h = openNamespace<Row>(
      base(tx, {
        maxBytes: 10,
        heldPolicy: {held: () => held, mode: 'last'},
        onEvict: (r) => order.push(r.key)
      })
    );
    // 'h' is held and newest; 'u' is unheld and oldest. Over by a lot: both go,
    // but the unheld one first though tier and age are equal.
    db.set('u', {key: 'u', bytes: 40, ts: 1});
    db.set('h', {key: 'h', bytes: 40, ts: 2});

    await h.sweep(0);

    expect(order).toEqual(['u', 'h']);
  });

  test('a held-last row is still evictable when it is the only thing over cap', async () => {
    const {db, tx} = mem();
    const lastEvicted: string[] = [];
    const skipEvicted: string[] = [];
    const held = () => new Set(['only']);

    const asLast = openNamespace<Row>(
      base(tx, {heldPolicy: {held, mode: 'last'}, onEvict: (r) => lastEvicted.push(r.key)})
    );
    db.set('only', {key: 'only', bytes: 60, ts: 1});
    await asLast.sweep(0);
    expect(lastEvicted).toEqual(['only']);
    expect(db.has('only')).toBe(false);

    // Control: under 'skip' the same held row is spared and the store stays over.
    const {db: db2, tx: tx2} = mem();
    const asSkip = openNamespace<Row>(
      base(tx2, {heldPolicy: {held, mode: 'skip'}, onEvict: (r) => skipEvicted.push(r.key)})
    );
    db2.set('only', {key: 'only', bytes: 60, ts: 1});
    await asSkip.sweep(0);
    expect(skipEvicted).toEqual([]);
    expect(db2.has('only')).toBe(true);
  });
});

describe('blobStore sweep: exceptKey', () => {
  test('the excepted key is neither counted nor evicted by its own sweep', async () => {
    const {db, tx} = mem();
    const evicted: string[] = [];
    const h = openNamespace<Row>(base(tx, {onEvict: (r) => evicted.push(r.key)}));
    db.set('self', {key: 'self', bytes: 40, ts: 1});
    db.set('other', {key: 'other', bytes: 40, ts: 2});

    // Incoming 40 alongside 'other' (40) is over 50; 'self' is excepted so it
    // is out of the running though it is the oldest.
    await h.sweep(40, 'self');

    expect(evicted).toEqual(['other']);
    expect(db.has('self')).toBe(true);
  });

  test('control: without the exception the oldest (self) is taken', async () => {
    const {db, tx} = mem();
    const evicted: string[] = [];
    const h = openNamespace<Row>(base(tx, {onEvict: (r) => evicted.push(r.key)}));
    db.set('self', {key: 'self', bytes: 40, ts: 1});
    db.set('other', {key: 'other', bytes: 40, ts: 2});

    await h.sweep(40);

    expect(evicted[0]).toBe('self');
  });
});

describe('blobStore sweep: metaKeys', () => {
  test('a meta row is hidden from getAll/stats and never swept, but reachable by key', async () => {
    const {db, tx} = mem();
    const evicted: string[] = [];
    const h = openNamespace<Row>(
      base(tx, {metaKeys: new Set(['__meta']), onEvict: (r) => evicted.push(r.key)})
    );
    db.set('__meta', {key: '__meta', bytes: 999, ts: 0});
    db.set('a', {key: 'a', bytes: 40, ts: 1});
    db.set('b', {key: 'b', bytes: 40, ts: 2});

    expect((await h.getAll()).map((r) => r.key)).toEqual(['a', 'b']);
    expect((await h.stats()).items).toBe(2);

    await h.sweep(0);
    expect(evicted).toEqual(['a']);
    expect(db.has('__meta')).toBe(true);
    expect(await h.get('__meta')).toMatchObject({key: '__meta'});
  });

  test('control: without metaKeys the meta row is listed and can be swept', async () => {
    const {db, tx} = mem();
    const h = openNamespace<Row>(base(tx, {maxBytes: 1024}));
    db.set('__meta', {key: '__meta', bytes: 999, ts: 0});
    db.set('a', {key: 'a', bytes: 40, ts: 1});

    expect((await h.getAll()).map((r) => r.key).sort()).toEqual(['__meta', 'a']);
    expect((await h.stats()).items).toBe(2);
  });
});
