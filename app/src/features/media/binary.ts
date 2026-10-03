import {startDownload} from '../../engine/transfers/download';
import {memorySink} from '@/features/media/downloadSinks';

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
 *  as they arrive. It rides the download lane (engine/transfers/download.ts):
 *  ranged parts on the engine's bulk lane, so the chat never waits behind it,
 *  each part with a deadline, resumed after a dropped pipe, and failed rather
 *  than hung when nothing moves. The blob keeps the engine's content-type so a
 *  saved or shared file carries its kind. `size` is the card's, when known. */
export async function fetchBinary(
  url: string,
  opts: {
    onProgress?: (received: number, total: number) => void;
    signal?: AbortSignal;
    size?: number;
  } = {}
): Promise<Blob> {
  if (opts.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const sink = memorySink('');
  const dl = startDownload({
    name: url.split('/').slice(-2, -1)[0] ?? url,
    url,
    size: opts.size ?? 0,
    sink,
    onProgress: (p) => {
      if (p.received > 0 && p.phase === 'active') opts.onProgress?.(p.received, p.total);
    }
  });
  const onAbort = () => dl.cancel();
  opts.signal?.addEventListener('abort', onAbort, {once: true});
  try {
    const end = await dl.done;
    if (end.phase === 'cancelled') {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (end.phase !== 'done') throw new Error(end.reason ?? 'download failed');
    const blob = sink.blob()!;
    const type = end.type || 'application/octet-stream';
    return blob.type === type ? blob : new Blob([blob], {type});
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
