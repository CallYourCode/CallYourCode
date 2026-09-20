const CACHE_MAX_BYTES = 64 * 1024 * 1024;

// One minted object URL, possibly reachable under several ids (the transfer
// key it was staged under, and the engine uploadId that adopts it). The URL is
// revoked, and its bytes uncounted, only when the last id holding it goes.
type Entry = {objectUrl: string; bytes: number; refs: number};

const entries = new Map<string, Entry>();
let totalBytes = 0;

function release(e: Entry) {
  e.refs--;
  if (e.refs > 0) return;
  totalBytes -= e.bytes;
  URL.revokeObjectURL(e.objectUrl);
}

function evictUntilFits(incoming: number) {
  while (totalBytes + incoming > CACHE_MAX_BYTES && entries.size) {
    const [oldKey, old] = entries.entries().next().value as [string, Entry];
    entries.delete(oldKey);
    release(old);
  }
}

export function rememberLocalUpload(uploadId: string, file: File): void {
  if (entries.has(uploadId)) return;
  evictUntilFits(file.size);
  entries.set(uploadId, {objectUrl: URL.createObjectURL(file), bytes: file.size, refs: 1});
  totalBytes += file.size;
}

// The engine's uploadId adopts the preview minted under the transfer key: the
// SAME object URL answers both ids, so the pending bubble's <img> src string
// is unchanged across the swap and the decoded picture is kept (minting a
// second URL for the same file forced a visible reload at send completion).
// True when toId now resolves; false when the source id has been evicted.
export function aliasLocalUpload(fromId: string, toId: string): boolean {
  if (entries.has(toId)) return true;
  const e = entries.get(fromId);
  if (!e) return false;
  e.refs++;
  entries.set(toId, e);
  return true;
}

export function localUploadUrl(uploadId: string): string | undefined {
  return entries.get(uploadId)?.objectUrl;
}
