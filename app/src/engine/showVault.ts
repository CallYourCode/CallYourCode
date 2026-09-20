import {cyclog} from '@/shared/logging';
import {openNamespace, ownDbTx, type EvictRec} from '@/shared/blobStore';
import {engineCapFetch} from './contract';

const DB_NAME = 'cyc-shown';
const STORE = 'docs';

const LEDGER_KEY = '__evictions';

const LEDGER_MAX = 50;

const MAX_BYTES = 24 * 1024 * 1024;
const MAX_DOCS = 200;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// A shown document is opened when the user opened it and prefetched when only a
// receipt hook admitted its card. Prefetched rows evict before opened ones, so
// a prefetch flood never costs the user a document they actually opened. A row
// written before this field existed reads as opened: user content is never
// demoted.
type Tier = 'opened' | 'prefetched';

type ShownDoc = {
  key: string;

  sessionId: string;
  name: string;
  fileKind: string;

  content: string;

  blob?: Blob;
  bytes: number;

  ts: number;

  tier?: Tier;
};

type Tombstone = {
  key: string;
  name: string;

  cap: string;

  kind: string;
  bytes: number;

  ts: number;
};

type Ledger = {key: typeof LEDGER_KEY; count: number; stones: Tombstone[]};

const store = openNamespace<ShownDoc>({
  tx: ownDbTx(DB_NAME, STORE, 'key'),
  keyPath: 'key',
  maxBytes: MAX_BYTES,
  maxItems: MAX_DOCS,
  maxAgeMs: MAX_AGE_MS,
  countNoun: 'doc',
  bytesOf: (r) => r.bytes,
  tsOf: (r) => r.ts,
  // Prefetched rows evict before opened ones; a missing tier is opened.
  tierOf: (r) => (r.tier === 'prefetched' ? 0 : 1),
  // Inside a tier, pictures go before documents (then oldest first).
  secondaryOrder: (a, b) => (a.blob ? 0 : 1) - (b.blob ? 0 : 1),
  metaKeys: new Set([LEDGER_KEY]),
  serializedWrites: true,
  onEvict: (rec, cap, now) => {
    cyclog('shown.vault.evicted', {
      key: rec.key,
      session: rec.sessionId,
      name: rec.name,
      bytes: rec.bytes,
      ageMs: now - rec.ts,
      cap,

      kind: rec.blob ? 'image' : 'document',
      why:
        'the shown-document cache is over a cap; pictures go before documents ' +
        'and oldest first within each, so opening that card again is a fetch ' +
        'from its engine'
    });
  },
  onEvicted: async (evicted, now) => {
    await remember(
      evicted.map(({row, cap}: EvictRec<ShownDoc>) => ({
        key: row.key,
        name: row.name,
        cap,
        kind: row.blob ? 'image' : 'document',
        bytes: row.bytes,
        ts: now
      }))
    );
  }
});

const tx = store.tx;

export async function list(): Promise<ShownDoc[]> {
  return store.getAll();
}

export async function evictions(): Promise<{count: number; stones: Tombstone[]}> {
  const rec = await tx<Ledger>('readonly', (s) => s.get(LEDGER_KEY) as IDBRequest<Ledger>);
  return {count: rec?.count ?? 0, stones: rec?.stones ?? []};
}

async function remember(stones: Tombstone[]): Promise<void> {
  if (!stones.length) return;
  const had = await evictions();
  const next: Ledger = {
    key: LEDGER_KEY,
    count: had.count + stones.length,
    stones: [...stones, ...had.stones].slice(0, LEDGER_MAX)
  };
  await tx('readwrite', (s) => s.put(next));
}

export async function get(key: string): Promise<ShownDoc | null> {
  try {
    return (await store.get(key)) ?? null;
  } catch {
    return null;
  }
}

export function put(
  rec: Omit<ShownDoc, 'bytes' | 'ts'> & {ts?: number; tier?: Tier}
): Promise<boolean> {
  const bytes = rec.blob ? rec.blob.size : rec.content.length;
  const full: ShownDoc = {...rec, bytes, ts: rec.ts ?? Date.now()};
  return store.put(full).then(
    (ok) => {
      if (ok === null) {
        cyclog('shown.vault.put-failed', {
          key: rec.key,
          session: rec.sessionId,
          name: rec.name,
          bytes,
          why:
            'IndexedDB refused the write (quota, private mode, or no store): every open of ' +
            'this card is a fetch from its engine, as it was before the cache existed'
        });
        return false;
      }
      return true;
    },
    (e) => {
      cyclog('shown.vault.put-threw', {key: rec.key, name: rec.name, err: e});
      return false;
    }
  );
}

export async function loadDoc(
  docId: string,
  url: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<{name?: string; fileKind?: string; content?: string}> {
  const hit = await get(docId);
  if (hit) {
    // A user open of a prefetched row promotes it to opened so a later
    // prefetch flood cannot evict it: a cheap same-row rewrite, no sweep.
    if (hit.tier === 'prefetched') {
      void store.put({...hit, tier: 'opened'}, {sweep: false});
    }
    cyclog('shown.vault.hit', {
      key: docId,
      session: hit.sessionId,
      name: hit.name,
      bytes: hit.bytes,
      ageMs: Date.now() - hit.ts,
      why: 'this device already had the document, so the card opened without its engine'
    });
    return {name: hit.name, fileKind: hit.fileKind, content: hit.content};
  }
  await sayWhyItIsAMiss(docId, 'document');

  const res = await engineCapFetch(url, {signal: signal ?? AbortSignal.timeout(10_000)});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = (await res.json()) as {name?: string; fileKind?: string; content?: string};
  if (typeof doc?.content === 'string') {
    void put({
      key: docId,
      sessionId,
      name: doc.name ?? '',
      fileKind: doc.fileKind ?? '',
      content: doc.content,
      tier: 'opened'
    });
  }
  return doc;
}

// Prefetch is fire-and-forget from a per-row receipt hook, so attaching a
// card-heavy chat can call prefetchDoc N times in one synchronous loop. Two
// bounds keep that burst civil on the single muxed tunnel:
//   - a FIFO queue draining at most PREFETCH_MAX_INFLIGHT tunneled fetches at a
//     time, so N distinct docs never fire N simultaneous engineCapFetches; and
//   - a same-doc inflight Map (the imageBlob pattern below), so the same docId
//     in several rows shares ONE fetch instead of racing get() before any put().
const PREFETCH_MAX_INFLIGHT = 3;
const prefetchInflight = new Map<string, Promise<void>>();
const prefetchQueue: (() => void)[] = [];
let prefetchActive = 0;

function pumpPrefetch(): void {
  while (prefetchActive < PREFETCH_MAX_INFLIGHT && prefetchQueue.length) {
    const start = prefetchQueue.shift();
    if (!start) return;
    prefetchActive++;
    start();
  }
}

// Vault a shown document the first time its card is admitted while the engine
// is reachable, so tapping it offline later opens from this device instead of
// failing. Fire-and-forget from the receipt hook: a skip or failure just leaves
// today's vault-on-first-open, so it never blocks or fails the card render. A
// vault hit means the document is already held, so there is no second fetch.
// The returned promise settles when this doc's prefetch finishes (or was
// deduped/queued through); callers never await it.
export function prefetchDoc(
  docId: string,
  url: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<void> {
  const already = prefetchInflight.get(docId);
  if (already) return already;
  const run = new Promise<void>((resolve) => {
    prefetchQueue.push(() => {
      void runPrefetch(docId, url, sessionId, signal).finally(() => {
        prefetchActive--;
        resolve();
        pumpPrefetch();
      });
    });
    pumpPrefetch();
  });
  prefetchInflight.set(docId, run);
  void run.finally(() => {
    prefetchInflight.delete(docId);
  });
  return run;
}

async function runPrefetch(
  docId: string,
  url: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<void> {
  const hit = await get(docId);
  if (hit) return;
  try {
    const res = await engineCapFetch(url, {signal: signal ?? AbortSignal.timeout(10_000)});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = (await res.json()) as {name?: string; fileKind?: string; content?: string};
    if (typeof doc?.content !== 'string') {
      cyclog('shown.vault.prefetch', {
        key: docId,
        session: sessionId,
        err: 'the engine answered without a document body, so nothing was cached'
      });
      return;
    }
    const ok = await put({
      key: docId,
      sessionId,
      name: doc.name ?? '',
      fileKind: doc.fileKind ?? '',
      content: doc.content,
      tier: 'prefetched'
    });
    cyclog('shown.vault.prefetch', {
      key: docId,
      session: sessionId,
      bytes: doc.content.length,
      why: ok
        ? 'a shown card arrived while its engine was reachable, so its document is ' +
          'on this device now and opens without the engine'
        : 'the vault refused the write, so this card stays vault-on-first-open as before'
    });
  } catch (e) {
    cyclog('shown.vault.prefetch', {key: docId, session: sessionId, err: String(e)});
  }
}

async function sayWhyItIsAMiss(docId: string, kind: string): Promise<void> {
  const stone = (await evictions()).stones.find((s) => s.key === docId);
  if (stone) {
    cyclog('shown.vault.miss-evicted', {
      key: docId,
      name: stone.name,
      cap: stone.cap,
      evictedAt: new Date(stone.ts).toISOString(),
      bytes: stone.bytes,
      kind,
      why:
        'this device HAD this and a cap threw it out, so opening it is a fetch from its ' +
        'engine again; if this line is common the cap is the thing to change'
    });
    return;
  }
  cyclog('shown.vault.miss', {
    key: docId,
    kind,
    why: 'this device has never held this one, so opening it is a fetch from its engine'
  });
}

const inflight = new Map<string, Promise<Blob | null>>();

export function imageBlob(
  docId: string,
  url: string,
  sessionId: string,
  name = '',
  signal?: AbortSignal
): Promise<Blob | null> {
  const already = inflight.get(docId);
  if (already) return already;
  const run = (async () => {
    const hit = await get(docId);
    if (hit?.blob) {
      cyclog('shown.vault.hit', {
        key: docId,
        session: hit.sessionId,
        name: hit.name,
        bytes: hit.bytes,
        ageMs: Date.now() - hit.ts,
        kind: 'image',
        why: 'this device already had the picture, so it opened without its engine'
      });
      return hit.blob;
    }
    await sayWhyItIsAMiss(docId, 'image');
    try {
      const res = await engineCapFetch(url, {signal: signal ?? AbortSignal.timeout(10_000)});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();

      await put({
        key: docId,
        sessionId,
        name,
        fileKind: 'image',
        content: '',
        blob,
        tier: 'opened'
      });
      return blob;
    } catch (e) {
      cyclog('shown.vault.image-fetch-failed', {
        key: docId,
        err: String(e),
        why:
          'the picture could not be fetched, so the viewer falls back to the engine URL ' +
          'and shows whatever it showed before this store existed'
      });
      return null;
    }
  })();
  inflight.set(docId, run);

  void run.finally(() => {
    inflight.delete(docId);
  });
  return run;
}

export async function stats(): Promise<{
  docs: number;
  bytes: number;
  evicted: number;
  lastEviction: Tombstone | null;
}> {
  const all = await list();
  const led = await evictions();
  return {
    docs: all.length,
    bytes: all.reduce((n, r) => n + r.bytes, 0),

    evicted: led.count,
    lastEviction: led.stones[0] ?? null
  };
}

export async function clear(why: string): Promise<void> {
  const before = await stats();
  await store.clear();
  cyclog('shown.vault.cleared', {
    docs: before.docs,
    bytes: before.bytes,
    evicted: before.evicted,
    why
  });
}
