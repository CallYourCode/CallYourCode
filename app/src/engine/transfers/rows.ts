import {transactionOn, TRANSFERS} from '@/shared/browser';
import {cyclog} from '@/shared/logging';
import type {CycUpload} from '../contract';

// One resumable transfer (Lane A). The bytes live in a vault (clipVault for a
// voice note, keyed by `blobKey`); this row is the durable plan for moving them
// to the engine chunk by chunk. It survives a reload: on boot the row is
// hydrated and the worker resumes from `acked` rather than byte zero.
export type TransferRow = {
  // The app's stable handle for this send (== the outbox cid / clipVault key).
  key: string;
  // The engine's transfer id, learned at begin. Absent until the first begin.
  id?: string;
  sessionId: string;
  kind: 'upload' | 'user-audio';
  // The vault key the bytes are parked under (== key for a voice note).
  blobKey: string;
  size: number;
  mime: string;
  name?: string;
  // Seconds of audio for an audio attachment; begin forwards it so the fronted
  // /upload sees x-duration-s exactly as a direct POST would.
  durationS?: number;
  // The message this row belongs to when several rows share one message (the
  // attachments of one send). Absent for a voice note: its key IS the cid.
  ownerCid?: string;
  // Lowercase hex sha256 of the bytes; declared at begin, verified at finish.
  sha256: string;
  // The engine's chunk size (262144), learned at begin.
  chunk: number;
  // Chunk indices the engine has confirmed. Progress = acked.length / total.
  acked: number[];
  state: 'queued' | 'active' | 'done' | 'gone';
  // Why the engine refused, in the words the failed bubble shows ("too large
  // (over 300 MB)"). Set with state 'gone' when the refusal has a reason worth
  // showing; absent for the rest (the bubble falls back to its generic copy).
  refused?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  // The /upload or /user-audio reply, present once state is 'done'. The waiting
  // outbox intent reads result to send its message (a voice note's msgId).
  result?: CycUpload | {msgId: string} | Record<string, unknown>;
};

const live = new Map<string, TransferRow>();
let hydrated = false;

export function all(): TransferRow[] {
  return [...live.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function get(key: string): TransferRow | undefined {
  return live.get(key);
}

// True once the row's write completed.
export function put(row: TransferRow): Promise<boolean> {
  row.updatedAt = Date.now();
  live.set(row.key, row);
  return transactionOn(TRANSFERS, 'readwrite', (s) => s.put(row)).then((r) => r !== null);
}

export function remove(key: string): void {
  live.delete(key);
  void transactionOn(TRANSFERS, 'readwrite', (s) => s.delete(key));
}

export async function hydrate(): Promise<TransferRow[]> {
  if (hydrated) return all();
  const rows = await transactionOn<TransferRow[]>(
    TRANSFERS,
    'readonly',
    (s) => s.getAll() as unknown as IDBRequest<TransferRow[]>
  );
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r && typeof r.key === 'string' && typeof r.sessionId === 'string') {
        // A row left mid-flight (state 'active') is really queued again after a
        // reload: nothing is in flight until the worker picks it up.
        if (r.state === 'active') r.state = 'queued';
        if (!Array.isArray(r.acked)) r.acked = [];
        live.set(r.key, r);
      }
    }
  }
  hydrated = true;
  cyclog('transfers.hydrated', {
    count: live.size,
    why: 'in-flight transfers restored from disk; the worker resumes each from its acked chunks'
  });
  return all();
}

// The keys of transfers still needing the vault bytes, so the clipVault sweeper
// does not evict a recording an in-flight transfer will still read.
export function heldKeys(): Set<string> {
  const held = new Set<string>();
  for (const r of live.values()) {
    if (r.state === 'queued' || r.state === 'active') held.add(r.blobKey);
  }
  return held;
}
