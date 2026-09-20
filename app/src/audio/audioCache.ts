import {engineCapFetch} from '../engine/contract';

const CACHE_MAX_BYTES = 24 * 1024 * 1024;

type Entry = {objectUrl: string; bytes: number};

const entries = new Map<string, Entry>();
let totalBytes = 0;
const inflight = new Map<string, Promise<string>>();

const growing = new Set<string>();

const GROWING_MAX = 64;

export function markGrowing(msgId: string) {
  growing.delete(msgId);
  growing.add(msgId);
  evictAudio(msgId);
  while (growing.size > GROWING_MAX) {
    const oldest = growing.values().next().value as string;
    growing.delete(oldest);
  }
}

export function endGrowing(msgId: string) {
  growing.delete(msgId);
  evictAudio(msgId);
}

function evictAudio(msgId: string) {
  const e = entries.get(msgId);
  if (e) {
    entries.delete(msgId);
    totalBytes -= e.bytes;
    URL.revokeObjectURL(e.objectUrl);
  }
  inflight.delete(msgId);
}

function evictUntilFits(incoming: number) {
  while (totalBytes + incoming > CACHE_MAX_BYTES && entries.size) {
    const [oldKey, old] = entries.entries().next().value as [string, Entry];
    entries.delete(oldKey);
    totalBytes -= old.bytes;
    URL.revokeObjectURL(old.objectUrl);
  }
}

function touch(msgId: string, e: Entry) {
  entries.delete(msgId);
  entries.set(msgId, e);
}

function hasMse(): boolean {
  const MS = (globalThis as {MediaSource?: typeof MediaSource}).MediaSource;
  try {
    return !!MS && MS.isTypeSupported('audio/mpeg');
  } catch {
    return false;
  }
}

async function growingStreamUrl(msgId: string, remoteUrl: string): Promise<string> {
  const res = await engineCapFetch(remoteUrl, {headers: {range: 'bytes=0-'}});
  if (!res.ok) throw new Error(`audio ${res.status}`);
  if (!hasMse() || !res.body) {
    const blob = await res.blob();
    evictUntilFits(blob.size);
    const objectUrl = URL.createObjectURL(blob);
    entries.set(msgId, {objectUrl, bytes: blob.size});
    totalBytes += blob.size;
    return objectUrl;
  }
  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  const reader = res.body.getReader();

  ms.addEventListener(
    'sourceopen',
    () => {
      void pumpGrowing(ms, url, reader);
    },
    {once: true}
  );
  return url;
}

async function pumpGrowing(
  ms: MediaSource,
  url: string,
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  const sb = ms.addSourceBuffer('audio/mpeg');

  try {
    ms.duration = Infinity;
  } catch {}

  const idle = () =>
    sb.updating
      ? new Promise<void>((r) => sb.addEventListener('updateend', () => r(), {once: true}))
      : Promise.resolve();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      await idle();

      if (ms.readyState !== 'open') {
        void reader.cancel().catch(() => {});
        return;
      }
      sb.appendBuffer(value as BufferSource);
    }
    await idle();
    if (ms.readyState === 'open') ms.endOfStream();
  } catch {
    try {
      if (ms.readyState === 'open') ms.endOfStream();
    } catch {}
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function resolveAudioUrl(msgId: string, remoteUrl: string): Promise<string> {
  if (growing.has(msgId)) return growingStreamUrl(msgId, remoteUrl);
  const hit = entries.get(msgId);
  if (hit) {
    touch(msgId, hit);
    return hit.objectUrl;
  }
  const pending = inflight.get(msgId);
  if (pending) return pending;

  const p = (async () => {
    const res = await engineCapFetch(remoteUrl, {signal: AbortSignal.timeout(15_000)});
    if (!res.ok) throw new Error(`audio ${res.status}`);
    const blob = await res.blob();
    evictUntilFits(blob.size);
    const objectUrl = URL.createObjectURL(blob);
    entries.set(msgId, {objectUrl, bytes: blob.size});
    totalBytes += blob.size;
    return objectUrl;
  })();
  inflight.set(msgId, p);
  // The inflight entry is cleaned up when the fetch settles. That cleanup is a
  // derived promise no caller awaits, so it carries its own catch: a 404 (an
  // absent clip, expected when voice is off) rejects `p`, which the awaiting
  // caller already handles, but without this the derived promise's rejection
  // would escape to the window as an uncaught "audio <status>" error.
  void p.finally(() => inflight.delete(msgId)).catch(() => {});
  return p;
}
