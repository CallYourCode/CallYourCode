import {engineObjectUrl, whenEngineReady} from '../../engine/contract';
import {cachedImageUrl} from './imageCache';
import {MEDIA_RETRY_WINDOW_MS, MEDIA_RETRY_BACKOFF_MS} from '@/shared/mediaRetry';

// One resolution order for every picture the app paints, the bubble and the
// full-screen viewer alike, so the two can never disagree about where a picture
// comes from:
//   1. the image cache, under the engine URL (the key the bubble cached it by)
//   2. the caller's own bytes (a shown picture this device vaulted)
//   3. a local object URL (the file the user just picked), read at resolve time,
//      never a URL captured earlier that eviction may since have revoked
//   4. the sealed wire, behind the same gate and retry window as the bubble
// A non-http key (a data: or blob: URL handed straight in) is applied as-is.

// A cache miss first waits this long for the sealed wire (a reload paints
// history before the pipe has dialed); the retry window only starts once the
// wire is up, so it is never burned on a wire that is still coming up.
export const MEDIA_WIRE_WAIT_MS = 30_000;
// Re-exported so mediaBox.ts and the media tests keep their existing import
// path; the value itself now lives in @/shared/mediaRetry.
export {MEDIA_RETRY_WINDOW_MS};

export type ImageHow = 'cache' | 'bytes' | 'local' | 'wire' | 'direct';

export type ImageSource = {
  src: string;
  how: ImageHow;
  // True when `src` is an object URL this resolution created, so the painter
  // owns it and revokes it once the picture has loaded (or failed).
  minted: boolean;
};

export type ImageResolveReason = 'wire-down' | 'gone';

export class ImageResolveError extends Error {
  constructor(
    readonly reason: ImageResolveReason,
    readonly key: string,
    readonly status?: number
  ) {
    super(`image ${reason}: ${key}`);
    this.name = 'ImageResolveError';
  }
}

export type ImageWant = {
  // The engine URL of the picture; the image cache key.
  key: string;
  bytes?: () => Promise<Blob | null>;
  local?: () => string | undefined;
};

export type ResolveImageOptions = {
  wireWaitMs?: number;
  retryWindowMs?: number;
  // Straight to the wire: what this device held was handed to the browser and
  // it could not decode it (a released blob URL, a bad cache row), so a fetch
  // is the only source left; it re-fills the cache under the same key.
  fresh?: boolean;
  // Called when the wait is on the wire (a loading surface belongs on screen).
  onWaiting?: () => void;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isEngineUrl(key: string): boolean {
  return /^https?:/i.test(key);
}

export function srcScheme(src: string): string {
  if (!src) return '(none)';
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(src);
  return m ? m[1].toLowerCase() : '(relative)';
}

export async function resolveImageSource(
  want: ImageWant,
  opts: ResolveImageOptions = {}
): Promise<ImageSource> {
  const key = want.key;
  if (!isEngineUrl(key)) return {src: key, how: 'direct', minted: false};

  if (!opts.fresh) {
    const hit = await cachedImageUrl(key).catch((): string | null => null);
    if (hit) return {src: hit, how: 'cache', minted: true};

    if (want.bytes) {
      let blob: Blob | null = null;
      try {
        blob = await want.bytes();
      } catch {
        blob = null;
      }
      if (blob) return {src: URL.createObjectURL(blob), how: 'bytes', minted: true};
    }

    const local = want.local?.();
    if (local) return {src: local, how: 'local', minted: false};
  }

  opts.onWaiting?.();
  const up = await whenEngineReady(key, opts.wireWaitMs ?? MEDIA_WIRE_WAIT_MS);
  if (!up) throw new ImageResolveError('wire-down', key);

  const deadline = Date.now() + (opts.retryWindowMs ?? MEDIA_RETRY_WINDOW_MS);
  for (;;) {
    try {
      // The cache was read above (or is being bypassed): this fills the row the
      // bubble and the viewer both read by this key.
      const src = await engineObjectUrl(key, {cache: 'fill'});
      return {src, how: 'wire', minted: true};
    } catch (err) {
      const status = (err as {status?: number} | null)?.status;
      // The engine answered and does not have it.
      if (status === 404) throw new ImageResolveError('gone', key, 404);
      if (Date.now() >= deadline) throw new ImageResolveError('wire-down', key, status);
      opts.onWaiting?.();
      await sleep(MEDIA_RETRY_BACKOFF_MS);
    }
  }
}
