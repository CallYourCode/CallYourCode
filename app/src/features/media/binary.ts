import {engineCapFetch, type EngineFetchInit} from '../../engine/contract';

// A shown file the engine tags `binary` is only ever named, never typed, so its
// extension is what says whether it is something the app can play. Video goes to
// a <video controls playsinline>, audio to an <audio controls>; everything else
// is a plain download.
const VIDEO_EXT = new Set([
  'mp4',
  'm4v',
  'mov',
  'webm',
  'ogv',
  'mkv',
  'avi',
  '3gp',
  'mpg',
  'mpeg'
]);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac']);

export type MediaKind = 'video' | 'audio';

/** The playable media kind a filename names, or null for anything else. */
export function mediaKindOf(name: string): MediaKind | null {
  const dot = name.lastIndexOf('.');
  const ext = (dot >= 0 ? name.slice(dot + 1) : '').toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}

/** How long to give a shown-file transfer before it is aborted. The old flat
 *  30 s cap failed a 7.5 MB file over the sealed channel; this is 60 s of
 *  headroom plus ~1 s per 100 KB (an ~10 MB/min floor), capped at 30 min, and
 *  5 min when the size is unknown. The viewer also offers a manual cancel. */
export function transferTimeoutMs(sizeBytes: number): number {
  if (!sizeBytes) return 300_000;
  return Math.min(30 * 60_000, 60_000 + (sizeBytes / 102_400) * 1000);
}

/** Fetch a shown binary over the sealed channel into one Blob, reporting bytes
 *  as they arrive. The response body is streamed when the browser exposes a
 *  reader (so a slow large file shows real progress), else read whole with a
 *  single terminal progress call. The blob keeps the response's content-type so
 *  a saved or shared file carries its kind. */
export async function fetchBinary(
  url: string,
  opts: {onProgress?: (received: number, total: number) => void; signal?: AbortSignal} = {}
): Promise<Blob> {
  const init: EngineFetchInit = {};
  if (opts.signal) init.signal = opts.signal;
  const res = await engineCapFetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const blob = await res.blob();
    opts.onProgress?.(blob.size, total || blob.size);
    return blob.type ? blob : new Blob([blob], {type});
  }
  const reader = body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    opts.onProgress?.(received, total);
  }
  return new Blob(chunks, {type});
}
