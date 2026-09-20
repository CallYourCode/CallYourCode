import type {CycReplyTo} from '../../../types';
import type {VoiceClip} from '../components/messageComposer';
import {cyclog} from '@/shared/logging';
import {COMPOSITIONS, transactionOn} from '@/shared/browser';
import {openNamespace} from '@/shared/blobStore';

const MAX_COMPOSITIONS = 8;
const MAX_BYTES = 80 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredBlock =
  | {kind: 'reply'; reply: CycReplyTo}
  | {kind: 'quote'; text: string; title?: string; source?: CycReplyTo}
  | {kind: 'prompt'; text: string}
  | {kind: 'attach'; file: File; fromPage?: {label: string; page: string}; durationS?: number}
  | {kind: 'voice'; clip: VoiceClip; vaultKey: string; mime?: string};

type StoredComposition = {
  sessionId: string;
  blocks: StoredBlock[];

  bytes: number;

  ts: number;
};

let inTheBox: () => Set<string> = () => new Set();

export function holding(fn: () => Set<string>) {
  inTheBox = fn;
}

const store = openNamespace<StoredComposition>({
  tx: <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) =>
    transactionOn<T>(COMPOSITIONS, mode, run),
  keyPath: 'sessionId',
  maxBytes: MAX_BYTES,
  maxItems: MAX_COMPOSITIONS,
  maxAgeMs: MAX_AGE_MS,
  countNoun: 'composition',
  bytesOf: (r) => r.bytes,
  tsOf: (r) => r.ts,
  // Held compositions (the chat whose box is open) are evictable for bytes or
  // count but ordered LAST, and never aged out: user-typed content is lossless.
  heldPolicy: {held: () => inTheBox(), mode: 'last'},
  // The composition being saved is excluded from its own sweep.
  exceptKeyOf: (r) => r.sessionId,
  onEvict: (rec, cap, now) => {
    cyclog('composition.vault.evicted', {
      session: rec.sessionId,
      bytes: rec.bytes,
      blocks: rec.blocks.length,
      ageMs: now - rec.ts,
      cap,
      why:
        'the stored-composition store is over a cap and this is the oldest ' +
        "composition in it; what was in that chat's box is gone from this device now"
    });
  }
});

export async function list(): Promise<StoredComposition[]> {
  return store.getAll();
}

export function get(sessionId: string): Promise<StoredComposition | null> {
  return store.get(sessionId);
}

export async function save(
  sessionId: string,
  blocks: StoredBlock[]
): Promise<StoredComposition | null> {
  const previous = await get(sessionId);
  const bytes = blocks.reduce((n, b) => n + (b.kind === 'attach' ? b.file.size : 0), 0);
  try {
    const rec: StoredComposition = {sessionId, blocks, bytes, ts: Date.now()};
    const ok = await store.put(rec);
    if (ok === null) {
      cyclog('composition.vault.save-failed', {
        session: sessionId,
        bytes,
        blocks: blocks.map((b) => b.kind),
        why:
          'IndexedDB refused the write (quota, private mode, or a value it ' +
          'could not clone): this composition exists only in this page and a ' +
          'reload will lose it'
      });
      return previous;
    }
    cyclog('composition.vault.saved', {
      session: sessionId,
      bytes,
      blocks: blocks.map((b) => b.kind),
      why: "what is in this chat's box is on this device's disk now; a reload cannot lose it"
    });
    return previous;
  } catch (e) {
    cyclog('composition.vault.save-threw', {session: sessionId, err: e});
    return previous;
  }
}

export async function drop(sessionId: string, why: string) {
  await store.del(sessionId);
  cyclog('composition.vault.dropped', {session: sessionId, why});
}

export async function stats(): Promise<{compositions: number; bytes: number}> {
  const s = await store.stats();
  return {compositions: s.items, bytes: s.bytes};
}
