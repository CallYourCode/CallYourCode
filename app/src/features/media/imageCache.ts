import {transactionOn, IMAGES} from '@/shared/browser';
import {openNamespace} from '@/shared/blobStore';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;

type Row = {url: string; blob: Blob; bytes: number; at: number};

// The image cache over the shared blob-store engine: get/getAll/put and one
// eviction sweep. The freshness rule (TTL checked on read) and the sweep-after-
// put ordering stay here, the two behaviours the raw store never had.
const store = openNamespace<Row>({
  tx: <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) =>
    transactionOn<T>(IMAGES, mode, run),
  keyPath: 'url',
  maxBytes: CACHE_MAX_BYTES,
  maxAgeMs: TTL_MS,
  bytesOf: (r) => r.bytes || 0,
  tsOf: (r) => r.at
});

function fresh(row: Row | null): row is Row {
  return !!row?.blob && Date.now() - row.at <= TTL_MS;
}

export async function cachedImageUrl(url: string): Promise<string | null> {
  if (!/^https?:/i.test(url)) return null;
  const row = await store.get(url);
  if (!row?.blob) return null;
  if (Date.now() - row.at > TTL_MS) {
    void store.del(url);
    return null;
  }
  try {
    return URL.createObjectURL(row.blob);
  } catch {
    return null;
  }
}

/** The cached blob itself (null on miss/expiry). Same freshness rules as
 *  cachedImageUrl; callers that need bytes (a notification icon data URI)
 *  rather than an object URL. */
export async function cachedImageBlob(url: string): Promise<Blob | null> {
  if (!/^https?:/i.test(url)) return null;
  const row = await store.get(url);
  if (!row?.blob) return null;
  if (Date.now() - row.at > TTL_MS) {
    void store.del(url);
    return null;
  }
  return row.blob;
}

/** Every fresh cached image whose url contains `substring`, as url -> blob.
 *  Boot-time avatar warm-up reads this once; expired rows are skipped (the
 *  sweep deletes them on the next write). */
export async function cachedImagesMatching(substring: string): Promise<Map<string, Blob>> {
  const rows = await store.getAll();
  const out = new Map<string, Blob>();
  for (const row of rows) {
    if (typeof row?.url !== 'string' || !row.blob) continue;
    if (!row.url.includes(substring)) continue;
    if (!fresh(row)) continue;
    out.set(row.url, row.blob);
  }
  return out;
}

export function putImage(url: string, blob: Blob): void {
  if (!/^https?:/i.test(url)) return;
  const row: Row = {url, blob, bytes: blob.size, at: Date.now()};
  void store.put(row, {sweep: false}).then(() => store.sweep());
}
