import {engineCapFetch} from '../engine/contract';
import {CHUNK} from '@shared/tunnel';

const CACHE_MAX_BYTES = 24 * 1024 * 1024;

type Entry = {objectUrl: string; bytes: number};

const entries = new Map<string, Entry>();
let totalBytes = 0;
// A finished clip being fetched: one transfer per clip, whoever asked first.
const inflight = new Map<string, ClipFetch>();

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

/* The MediaSource this browser can stream an mp3 through: MediaSource where it
 * exists, else ManagedMediaSource (iPhone Safari 17.1+ has only that one; the
 * player element sets disableRemotePlayback, which it requires). */
type MediaSourceCtor = typeof MediaSource;
function mediaSourceCtor(): MediaSourceCtor | null {
  const g = globalThis as {MediaSource?: MediaSourceCtor; ManagedMediaSource?: MediaSourceCtor};
  for (const MS of [g.MediaSource, g.ManagedMediaSource]) {
    try {
      if (MS && MS.isTypeSupported('audio/mpeg')) return MS;
    } catch {}
  }
  return null;
}

/* A clip's body as it arrives over the tunnel, readable by several consumers
 * at once: the chunks so far, a wake-up for each new one, and the whole. */
type Transfer = {
  chunks: Uint8Array[];
  ended: boolean;
  broken: boolean;
  next(): Promise<void>;
  cancel(): void;
  whole: Promise<Uint8Array[]>;
};

function readBody(body: ReadableStream<Uint8Array>, onChunk?: () => void): Transfer {
  const reader = body.getReader();
  let wakers: (() => void)[] = [];
  const notify = () => {
    const w = wakers;
    wakers = [];
    for (const fn of w) fn();
  };
  const t: Transfer = {
    chunks: [],
    ended: false,
    broken: false,
    next: () => new Promise<void>((r) => wakers.push(r)),
    cancel: () => void reader.cancel().catch(() => {}),
    whole: Promise.resolve([])
  };
  t.whole = (async () => {
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        if (value?.length) t.chunks.push(value);
        onChunk?.();
        notify();
      }
      return t.chunks;
    } catch (e) {
      t.broken = true;
      throw e;
    } finally {
      t.ended = true;
      notify();
    }
  })();
  t.whole.catch(() => {});
  return t;
}

/* A URL the player starts on from the first bytes, while the rest is still
 * arriving: the chunks so far are appended once the source opens, then each
 * new one as it lands. A body that breaks mid-way ends the stream with a
 * network error the player reports, never a silent truncation. A live
 * (growing) stream is cancelled when the player lets go; a finished clip's
 * transfer carries on, since the cache and the waveform want its bytes. */
function mediaStreamUrl(MS: MediaSourceCtor, t: Transfer, cancelOnDetach: boolean): string {
  const ms = new MS();
  const url = URL.createObjectURL(ms);
  const feed = async () => {
    const sb = ms.addSourceBuffer('audio/mpeg');
    try {
      ms.duration = Infinity;
    } catch {}
    const idle = () =>
      sb.updating
        ? new Promise<void>((r) => sb.addEventListener('updateend', () => r(), {once: true}))
        : Promise.resolve();
    try {
      let next = 0;
      for (;;) {
        while (next < t.chunks.length) {
          await idle();
          if (ms.readyState !== 'open') {
            if (cancelOnDetach) t.cancel();
            return;
          }
          sb.appendBuffer(t.chunks[next++] as BufferSource);
        }
        if (t.ended) break;
        await t.next();
      }
      await idle();
      if (ms.readyState === 'open') {
        if (t.broken) ms.endOfStream('network');
        else ms.endOfStream();
      }
    } catch {
      try {
        if (ms.readyState === 'open') ms.endOfStream('network');
      } catch {}
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  ms.addEventListener('sourceopen', () => void feed(), {once: true});
  return url;
}

function cacheBlob(msgId: string, blob: Blob): string {
  evictUntilFits(blob.size);
  const objectUrl = URL.createObjectURL(blob);
  entries.set(msgId, {objectUrl, bytes: blob.size});
  totalBytes += blob.size;
  return objectUrl;
}

async function growingStreamUrl(msgId: string, remoteUrl: string): Promise<string> {
  const res = await engineCapFetch(remoteUrl, {headers: {range: 'bytes=0-'}});
  if (!res.ok) throw new Error(`audio ${res.status}`);
  const MS = mediaSourceCtor();
  if (!MS || !res.body) return cacheBlob(msgId, await res.blob());
  return mediaStreamUrl(MS, readBody(res.body), true);
}

/* One finished clip on its way from the engine. `head` lands with the first
 * frame; `url` is the cached blob once the whole clip is in. The 15 s limit is
 * on silence (no first frame, or no next one), not on the whole: a long clip
 * on a slow tunnel that keeps arriving is not cut off. */
type ClipFetch = {
  head: Promise<{type: string; transfer: Transfer}>;
  url: Promise<string>;
};
const SILENCE_MS = 15_000;

function fetchClip(msgId: string, remoteUrl: string): ClipFetch {
  const ctl = new AbortController();
  let timer = 0;
  const arm = () => {
    clearTimeout(timer);
    timer = window.setTimeout(
      () => ctl.abort(new DOMException('the engine stopped sending the clip', 'TimeoutError')),
      SILENCE_MS
    );
  };
  arm();
  const head = (async () => {
    const res = await engineCapFetch(remoteUrl, {signal: ctl.signal});
    if (!res.ok) throw new Error(`audio ${res.status}`);
    const body = res.body ?? new Response(await res.blob()).body!;
    return {
      type: res.headers.get('content-type') ?? '',
      transfer: readBody(body, arm)
    };
  })();
  const url = (async () => {
    try {
      const h = await head;
      const chunks = await h.transfer.whole;
      return cacheBlob(msgId, new Blob(chunks as BlobPart[], {type: h.type}));
    } finally {
      clearTimeout(timer);
    }
  })();
  const f: ClipFetch = {head, url};
  inflight.set(msgId, f);
  // Cleanup rides a derived promise no caller awaits, so it carries its own
  // catch: a 404 (an absent clip, expected when voice is off) rejects `url`,
  // which the awaiting caller handles, but without this the derived rejection
  // would escape to the window as an uncaught "audio <status>" error.
  void url
    .finally(() => {
      if (inflight.get(msgId) === f) inflight.delete(msgId);
    })
    .catch(() => {});
  head.catch(() => {});
  return f;
}

/* The speaker's source for a clip: the cached blob when there is one, else a
 * stream the player starts on as soon as the first bytes land. It joins the
 * clip's one transfer, whoever started it (the waveform fetches every visible
 * voice card when a chat opens, so a press usually lands mid-transfer). A body
 * crosses the tunnel in frames of exactly CHUNK bytes (256 KB, ~16 s of reply
 * audio) but the last, so a first frame shorter than that is the whole clip,
 * here in one go: a blob. So is anything not mp3 (a voice note is webm/ogg,
 * which an audio/mpeg source cannot take). With no MediaSource of any kind this
 * is resolveAudioUrl: the whole clip, then play. */
export async function streamAudioUrl(msgId: string, remoteUrl: string): Promise<string> {
  if (growing.has(msgId)) return growingStreamUrl(msgId, remoteUrl);
  const MS = mediaSourceCtor();
  if (!MS || entries.has(msgId)) return resolveAudioUrl(msgId, remoteUrl);
  const f = inflight.get(msgId) ?? fetchClip(msgId, remoteUrl);
  const {type, transfer: t} = await f.head;
  if (!t.chunks.length && !t.ended) await t.next();
  const more = !t.ended && (t.chunks[0]?.length ?? 0) >= CHUNK;
  if (!/^audio\/mpeg\b/i.test(type) || !more) return f.url;
  return mediaStreamUrl(MS, t, false);
}

export async function resolveAudioUrl(msgId: string, remoteUrl: string): Promise<string> {
  if (growing.has(msgId)) return growingStreamUrl(msgId, remoteUrl);
  const hit = entries.get(msgId);
  if (hit) {
    touch(msgId, hit);
    return hit.objectUrl;
  }
  return (inflight.get(msgId) ?? fetchClip(msgId, remoteUrl)).url;
}
