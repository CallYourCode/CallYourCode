import type {CycReplyTo} from '../types';
import {cyclog} from '@/shared/logging';
import {CLIPS, transactionOn} from '@/shared/browser';
import {openNamespace} from '@/shared/blobStore';

const MAX_BYTES = 120 * 1024 * 1024;
const MAX_CLIPS = 40;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type ParkedClip = {
  key: string;
  cid?: string;
  sessionId: string;
  blob: Blob;
  mime: string;
  bytes: number;
  durationS?: number;
  replyTo?: CycReplyTo;

  ts: number;

  tries: number;

  sent?: boolean;

  restored?: number;

  // The bytes of a file attachment riding the transfer queue (not a recording):
  // the composer's recovery sweep leaves these alone.
  attachment?: boolean;

  // Parked BY the transfer worker (a voice note or an attachment in flight).
  // Never a composer recording: the recovery sweep after a reload must not put
  // these back in the composer, whatever their kind; the transfer resumes them.
  transfer?: boolean;
};

export type HolderKind = 'composer' | 'transfer';

// Every source of "do not evict this key yet": the composer's staged clips and
// the resumable-transfer worker's in-flight rows both register here, and the
// sweeper spares a key any of them still holds. Additive so the two are unioned
// rather than one overwriting the other. The kind matters for release(): a key
// a transfer holds is the transfer's to release, nobody else's.
const holders = new Map<() => Set<string>, HolderKind>();
const heldBy = (kind?: HolderKind): Set<string> => {
  const all = new Set<string>();
  for (const [fn, k] of holders) {
    if (kind && k !== kind) continue;
    for (const key of fn()) all.add(key);
  }
  return all;
};
const inTheBox = (): Set<string> => heldBy();

export function holding(fn: () => Set<string>, kind: HolderKind = 'composer'): () => void {
  holders.set(fn, kind);
  return () => holders.delete(fn);
}

/* The caps evict the OLDEST unheld clip first and never a held one: a key the
 * composer or the transfer worker still holds is a recording or a file that is
 * not on the engine yet, and evicting it is losing the user's bytes. When the
 * unheld clips alone cannot bring the store under a cap, the store stays over
 * it (logged clip.vault.over-cap-held) rather than eating a held key. */
const store = openNamespace<ParkedClip>({
  tx: <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) =>
    transactionOn<T>(CLIPS, mode, run),
  keyPath: 'key',
  maxBytes: MAX_BYTES,
  maxItems: MAX_CLIPS,
  maxAgeMs: MAX_AGE_MS,
  countNoun: 'clip',
  bytesOf: (r) => r.bytes,
  tsOf: (r) => r.ts,
  heldPolicy: {held: inTheBox, mode: 'skip'},
  onEvict: (rec, cap, now) => {
    cyclog('clip.vault.evicted', {
      cid: rec.cid,
      key: rec.key,
      session: rec.sessionId,
      bytes: rec.bytes,
      ageMs: now - rec.ts,
      tries: rec.tries,
      cap,
      why:
        'the parked-clip store is over a cap and this is the oldest clip in it; ' +
        'the recording is gone from this device now'
    });
  },
  onOverCapHeld: ({total, count, held}) => {
    cyclog('clip.vault.over-cap-held', {
      bytes: total,
      clips: count,
      maxBytes: MAX_BYTES,
      maxClips: MAX_CLIPS,
      held: held.length,
      heldBytes: held.reduce((n, r) => n + r.bytes, 0),
      why:
        'the store is over a cap and every clip left in it is held (in the composer ' +
        'or in a transfer still in flight); none is evicted, the store stays over'
    });
  }
});

export async function list(): Promise<ParkedClip[]> {
  return store.getAll();
}

export async function park(
  rec: Omit<ParkedClip, 'bytes' | 'tries'> & {tries?: number}
): Promise<string | null> {
  try {
    const full: ParkedClip = {...rec, bytes: rec.blob.size, tries: rec.tries ?? 0};
    const ok = await store.put(full);
    if (ok === null) {
      cyclog('clip.vault.park-failed', {
        cid: rec.cid,
        key: rec.key,
        bytes: rec.blob.size,
        session: rec.sessionId,
        why:
          'IndexedDB refused the write (quota, private mode, or no store): the ' +
          'recording exists only in this page and a reload will lose it'
      });
      return null;
    }
    cyclog('clip.vault.parked', {
      cid: rec.cid,
      key: rec.key,
      bytes: rec.blob.size,
      session: rec.sessionId,
      durationS: rec.durationS,
      why: "the recording is on this device's disk now; a reload cannot lose it"
    });
    return rec.key;
  } catch (e) {
    cyclog('clip.vault.park-threw', {cid: rec.cid, key: rec.key, err: e});
    return null;
  }
}

export async function get(key: string): Promise<ParkedClip | undefined> {
  const rec = await store.get(key);
  return rec ?? undefined;
}

/* Delete a parked clip. A key an in-flight transfer holds is refused unless the
 * caller IS the transfer worker (opts.byTransfer): the bytes are the only copy
 * of a recording still on its way to the engine, and the composer dropping a
 * voice block, or a settlement racing the worker, must not take them out from
 * under the transfer. The worker releases them itself when the row settles. */
export async function release(
  key: string,
  why: string,
  fields: Record<string, unknown> = {},
  opts: {byTransfer?: boolean} = {}
): Promise<boolean> {
  if (!opts.byTransfer && heldBy('transfer').has(key)) {
    cyclog('clip.vault.release-refused', {
      key,
      ...fields,
      why:
        'a transfer in flight holds this key; only the transfer worker releases it ' +
        `(caller wanted: ${why})`
    });
    return false;
  }
  await store.del(key);
  cyclog('clip.vault.released', {key, ...fields, why});
  return true;
}

export async function update(key: string, patch: Partial<ParkedClip>) {
  const rec = await store.get(key);
  if (!rec) return;
  await store.put({...rec, ...patch}, {sweep: false});
}

export async function stats(): Promise<{clips: number; bytes: number}> {
  const s = await store.stats();
  return {clips: s.items, bytes: s.bytes};
}
