// One namespaced blob-store engine behind every IndexedDB blob cache. It owns
// the machinery the caches used to copy-paste: opening a single-store database
// (or borrowing a shared multi-store one), a serialized-write option, and ONE
// eviction sweep with age, bytes, and count caps plus tier and held ordering.
// Every cache-specific rule (a ledger, a memory tier, transfer holders, an
// exceptId, TTL-on-read) stays in the thin domain wrapper: this file has no
// knowledge of any single cache.
//
// It stays on the exact IndexedDB surface the test fakes emulate: open, get,
// getAll, put, delete, clear. No indexes, no IDBKeyRange.

// A transaction runner over one store: resolve the request result once the
// transaction has completed (null when it did not). Either the own-database
// runner below or shared/browser's transactionOn bound to a store.
export type Tx = <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
) => Promise<T | null>;

export type Cap = string;
export type EvictRec<R> = {row: R; cap: Cap};

export type OverCapStats<R> = {total: number; count: number; held: R[]};

export type NamespaceConfig<R> = {
  // The store's transaction runner and its keyPath (used to read a row's key
  // for deletes and held/meta membership).
  tx: Tx;
  keyPath: string;

  maxBytes: number;
  maxItems?: number;
  maxAgeMs?: number;
  // The noun in a count cap's reason ("<noun> count > N"); required when
  // maxItems is set.
  countNoun?: string;

  bytesOf: (row: R) => number;
  tsOf: (row: R) => number;

  // Higher tiers evict LATER. Absent means every row shares one tier.
  tierOf?: (row: R) => number;
  // A secondary within-tier order applied before oldest-first (for example
  // showVault's images before documents). Absent means oldest-first alone.
  secondaryOrder?: (a: R, b: R) => number;

  // Held keys are never age-evicted. mode 'skip' spares them from the byte and
  // count caps as well; mode 'last' keeps them evictable but orders them after
  // every unheld row.
  heldPolicy?: {held: () => Set<string>; mode: 'skip' | 'last'};

  // The key of the row a write is about, excluded from that write's own sweep
  // (the composition being saved).
  exceptKeyOf?: (row: R) => string;

  // Rows excluded from getAll and the sweep though still reachable by key (the
  // eviction ledger).
  metaKeys?: Set<string>;

  serializedWrites?: boolean;

  // Per evicted row, in eviction order, before its delete: the cache's own
  // eviction log line (and, for the panel cache, its memory-tier drop).
  onEvict?: (row: R, cap: Cap, now: number) => void;
  // Once after every delete of a sweep that evicted anything: the shown-doc
  // ledger write.
  onEvicted?: (evicted: EvictRec<R>[], now: number) => Promise<void> | void;
  // When a sweep ends still over a cap with held rows the only thing left to
  // take: the clip cache's over-cap-held line.
  onOverCapHeld?: (stats: OverCapStats<R>) => void;
};

export type PutOpts = {sweep?: boolean; before?: () => Promise<void> | void};

export type Handle<R> = {
  get: (key: string) => Promise<R | null>;
  getAll: () => Promise<R[]>;
  put: (row: R, opts?: PutOpts) => Promise<IDBValidKey | null>;
  del: (key: string) => Promise<void>;
  clear: () => Promise<void>;
  sweep: (incomingBytes?: number, exceptKey?: string) => Promise<void>;
  stats: () => Promise<{items: number; bytes: number}>;
  // The raw transaction runner, for the rare cache write that must bypass the
  // sweep and the write queue (the shown-doc ledger row).
  tx: Tx;
};

const EMPTY: Set<string> = new Set();

// A single-store IndexedDB opened and cached exactly as the shown-doc vault
// always has: one keyPath store created on upgrade, the connection dropped on
// versionchange, and a blocked open left resolving null so callers fall back to
// the network instead of hanging.
export function ownDbTx(dbName: string, storeName: string, keyPath: string): Tx {
  let db: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase | null> | null = null;
  let blockedReq: IDBOpenDBRequest | null = null;

  function openDb(): Promise<IDBDatabase | null> {
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    if (blockedReq) return Promise.resolve(null);
    opening = new Promise<IDBDatabase | null>((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(dbName, 1);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName, {keyPath});
      };
      req.onsuccess = () => {
        blockedReq = null;
        db = req.result;
        db.onversionchange = () => {
          db?.close();
          db = null;
          opening = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        blockedReq = null;
        resolve(null);
      };
      req.onblocked = () => {
        blockedReq = req;
        opening = null;
        resolve(null);
      };
    });
    return opening;
  }

  return function tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T | null> {
    return openDb().then((d) => {
      if (!d) return null;
      return new Promise<T | null>((resolve) => {
        let req: IDBRequest<T>;
        try {
          req = run(d.transaction(storeName, mode).objectStore(storeName));
        } catch {
          resolve(null);
          return;
        }
        req.onsuccess = () => {
          if (mode === 'readonly') {
            resolve(req.result);
            return;
          }
          const t = req.transaction;
          if (!t) {
            resolve(req.result);
            return;
          }
          t.oncomplete = () => resolve(req.result);
          t.onerror = () => resolve(null);
          t.onabort = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      });
    });
  };
}

export function openNamespace<R>(cfg: NamespaceConfig<R>): Handle<R> {
  const keyOf = (row: R): string => (row as Record<string, unknown>)[cfg.keyPath] as string;
  const tierOf = cfg.tierOf ?? (() => 0);
  const secondary = cfg.secondaryOrder ?? (() => 0);
  const ageLabel =
    cfg.maxAgeMs === undefined ? '' : `age > ${Math.round(cfg.maxAgeMs / 86400000)}d`;
  const bytesLabel = `total bytes > ${cfg.maxBytes}`;
  const countLabel = `${cfg.countNoun} count > ${cfg.maxItems}`;

  // Resolves the raw request result: the stored row, or undefined on a miss
  // (the exact shape the caches read before this engine existed, and one fewer
  // microtask than a coalescing wrapper, which a microtask-counting media test
  // is sensitive to).
  const get = (key: string): Promise<R | null> =>
    cfg.tx<R>('readonly', (s) => s.get(key) as IDBRequest<R>);

  async function getAll(): Promise<R[]> {
    const all = (await cfg.tx<R[]>('readonly', (s) => s.getAll() as IDBRequest<R[]>)) ?? [];
    const rows = cfg.metaKeys ? all.filter((r) => !cfg.metaKeys!.has(keyOf(r))) : all;
    return rows.sort((a, b) => cfg.tsOf(a) - cfg.tsOf(b));
  }

  async function del(key: string): Promise<void> {
    await cfg.tx<undefined>('readwrite', (s) => s.delete(key));
  }

  async function clear(): Promise<void> {
    await cfg.tx<undefined>('readwrite', (s) => s.clear());
  }

  async function sweep(incomingBytes = 0, exceptKey?: string): Promise<void> {
    const raw = await getAll();
    const all = exceptKey === undefined ? raw : raw.filter((r) => keyOf(r) !== exceptKey);
    if (!all.length) return;
    const now = Date.now();
    const held = cfg.heldPolicy ? cfg.heldPolicy.held() : EMPTY;
    const mode = cfg.heldPolicy?.mode;

    let total = all.reduce((n, r) => n + cfg.bytesOf(r), 0) + incomingBytes;
    let count = all.length + 1;
    const evicted: EvictRec<R>[] = [];

    // Phase 1: everything expired, whatever its tier. Held rows are never
    // age-evicted (both held modes).
    const survivors: R[] = [];
    for (const r of all) {
      const isHeld = held.has(keyOf(r));
      if (cfg.maxAgeMs !== undefined && !isHeld && now - cfg.tsOf(r) > cfg.maxAgeMs) {
        evicted.push({row: r, cap: ageLabel});
        total -= cfg.bytesOf(r);
        count--;
        continue;
      }
      survivors.push(r);
    }

    // Phase 2: while over a byte or count cap, evict in eviction order (tier
    // ascending, then the cache's secondary order, then oldest first). Held
    // rows drop out entirely under 'skip' and sort last under 'last'.
    const candidates = (mode === 'skip' ? survivors.filter((r) => !held.has(keyOf(r))) : survivors)
      .slice()
      .sort((a, b) => {
        if (mode === 'last') {
          const h = (held.has(keyOf(a)) ? 1 : 0) - (held.has(keyOf(b)) ? 1 : 0);
          if (h) return h;
        }
        const t = tierOf(a) - tierOf(b);
        if (t) return t;
        const s = secondary(a, b);
        if (s) return s;
        return cfg.tsOf(a) - cfg.tsOf(b);
      });
    for (const r of candidates) {
      if (total > cfg.maxBytes) {
        evicted.push({row: r, cap: bytesLabel});
        total -= cfg.bytesOf(r);
        count--;
        continue;
      }
      if (cfg.maxItems !== undefined && count > cfg.maxItems) {
        evicted.push({row: r, cap: countLabel});
        count--;
        continue;
      }
      break;
    }

    for (const {row, cap} of evicted) {
      cfg.onEvict?.(row, cap, now);
      await del(keyOf(row));
    }

    const over = total > cfg.maxBytes || (cfg.maxItems !== undefined && count > cfg.maxItems);
    if (over && cfg.onOverCapHeld) {
      cfg.onOverCapHeld({total, count, held: all.filter((r) => held.has(keyOf(r)))});
    }
    if (evicted.length && cfg.onEvicted) await cfg.onEvicted(evicted, now);
  }

  let writes: Promise<unknown> = Promise.resolve();
  const settled = (): undefined => undefined;
  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = writes.then(run, run);
    writes = next.then(settled, settled);
    return next;
  }

  function put(row: R, opts: PutOpts = {}): Promise<IDBValidKey | null> {
    const run = async (): Promise<IDBValidKey | null> => {
      if (opts.before) await opts.before();
      if (opts.sweep !== false) await sweep(cfg.bytesOf(row), cfg.exceptKeyOf?.(row));
      return cfg.tx<IDBValidKey>('readwrite', (s) => s.put(row));
    };
    return cfg.serializedWrites ? serialized(run) : run();
  }

  async function stats(): Promise<{items: number; bytes: number}> {
    const all = await getAll();
    return {items: all.length, bytes: all.reduce((n, r) => n + cfg.bytesOf(r), 0)};
  }

  return {get, getAll, put, del, clear, sweep, stats, tx: cfg.tx};
}
