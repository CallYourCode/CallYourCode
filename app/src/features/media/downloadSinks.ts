import {cyclog} from '@/shared/logging';
import type {DownloadSink} from '../../engine/transfers/download';

// Where a downloaded file's parts go (download-lane, 2026-10-03).
//
// The BROWSER download (laptop, Android): the service worker answers a
// same-origin URL with an attachment whose body is a stream this page feeds,
// part by part, as they arrive over the sealed tunnel. The browser's own
// download manager saves it straight to disk and shows its own progress; one
// tap, no "fetch the whole file, then save it" step, nothing held whole here.
// See public/cyc-sw.js (cycDlOpen / cycServeDownload).
//
// The MEMORY sink (iPhone, or a browser with no worker to stream through):
// the parts collect into one Blob. iOS needs the file in hand for the share
// sheet, which is its only save path from a home-screen app.

export const SW_DL_PREFIX = '/__cyc_dl/';
// The worker answers the open within this long, or it is an older worker
// without the download route (or none at all): use the memory sink instead.
const SW_READY_MS = 1_500;
// The browser fetches the download URL within this long once the frame points
// at it, or the stream path is not working here.
const SW_STARTED_MS = 4_000;
// The browser takes a part (pulls from the stream) within this long, or it
// stopped taking the file: the download fails rather than waiting forever.
const SW_PULL_MS = 20_000;
// Chrome stops an idle worker after ~30 s; a message from the page keeps it up.
const SW_KEEPALIVE_MS = 10_000;
// Parts the page may send ahead of the browser's pulls.
const SW_CREDITS = 4;

// Every browser download this page is feeding. A page that goes away (reload,
// close) fails them at once, so the browser's download list never keeps one
// "in progress" that nothing will ever finish.
const feeding = new Set<() => void>();
let pagehideHooked = false;
function hookPagehide(): void {
  if (pagehideHooked || typeof window === 'undefined') return;
  pagehideHooked = true;
  window.addEventListener('pagehide', () => {
    for (const stop of [...feeding]) stop();
  });
}

export type MemorySink = DownloadSink & {blob(): Blob | null};

export function memorySink(type: string): MemorySink {
  const parts: BlobPart[] = [];
  let out: Blob | null = null;
  return {
    write: async (bytes) => {
      parts.push(bytes as Uint8Array<ArrayBuffer>);
    },
    close: async () => {
      out = new Blob(parts, {type: type || 'application/octet-stream'});
      parts.length = 0;
    },
    abort: () => {
      parts.length = 0;
    },
    blob: () => out
  };
}

// RFC 6266 filename for the worker's content-disposition: an ASCII fallback
// and the exact UTF-8 name.
export function dispositionFor(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Open a browser download fed by this page, or null when this browser cannot
 *  stream one (no controlling worker, an older worker, the URL never fetched).
 *  `onCancel` fires when the user cancels it in the browser's download UI. */
export async function openBrowserDownload(meta: {
  name: string;
  size: number;
  type: string;
  onCancel: () => void;
}): Promise<DownloadSink | null> {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
  if (!sw || typeof MessageChannel === 'undefined') return null;
  const id = crypto.randomUUID();
  const ch = new MessageChannel();
  const port = ch.port1;
  let credits = 0;
  let creditWake: (() => void) | null = null;
  let cancelled = false;
  let readyResolve!: (ok: boolean) => void;
  let startedResolve!: (ok: boolean) => void;
  const ready = new Promise<boolean>((r) => (readyResolve = r));
  const started = new Promise<boolean>((r) => (startedResolve = r));
  port.onmessage = (ev: MessageEvent) => {
    const t = (ev.data as {t?: string})?.t;
    if (t === 'ready') readyResolve(true);
    else if (t === 'started') startedResolve(true);
    else if (t === 'pull') {
      credits++;
      creditWake?.();
    } else if (t === 'cancel') {
      cancelled = true;
      creditWake?.();
      meta.onCancel();
    }
  };
  sw.postMessage(
    {t: 'cyc-dl-open', id, name: meta.name, size: meta.size, type: meta.type, credits: SW_CREDITS},
    [ch.port2]
  );
  const timeout = (ms: number) => new Promise<boolean>((r) => setTimeout(() => r(false), ms));
  if (!(await Promise.race([ready, timeout(SW_READY_MS)]))) {
    port.close();
    cyclog('download.sw.unavailable', {
      name: meta.name,
      why: 'the service worker did not answer the download open; the file collects in memory instead'
    });
    return null;
  }

  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.className = 'cyc-download-frame';
  frame.src = SW_DL_PREFIX + id + '/' + encodeURIComponent(meta.name);
  document.body.append(frame);
  if (!(await Promise.race([started, timeout(SW_STARTED_MS)]))) {
    port.postMessage({t: 'abort'});
    port.close();
    frame.remove();
    cyclog('download.sw.unavailable', {
      name: meta.name,
      why: 'the browser never fetched the streamed download URL; the file collects in memory instead'
    });
    return null;
  }
  // The worker message keeps the worker up; the port message tells the stream
  // its page is still here (the worker fails a stream whose page went quiet).
  const keepalive = setInterval(() => {
    sw.postMessage({t: 'cyc-dl-keepalive'});
    port.postMessage({t: 'alive'});
  }, SW_KEEPALIVE_MS);
  const stop = () => {
    port.postMessage({t: 'abort', reason: 'the page went away'});
    finish();
  };
  hookPagehide();
  feeding.add(stop);
  const finish = () => {
    feeding.delete(stop);
    clearInterval(keepalive);
    // The download manager owns the response now; the frame can go once the
    // last bytes are handed over.
    setTimeout(() => frame.remove(), 1_000);
    setTimeout(() => port.close(), 1_000);
  };

  const credit = async () => {
    const deadline = Date.now() + SW_PULL_MS;
    while (credits <= 0 && !cancelled) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('the browser stopped taking the file');
      await new Promise<void>((r) => {
        creditWake = r;
        setTimeout(r, left);
      });
      creditWake = null;
    }
    if (cancelled) throw new Error('cancelled in the browser');
    credits--;
  };

  return {
    write: async (bytes) => {
      await credit();
      // Transfer, not copy: the page never reads a part again.
      const buf =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.slice().buffer;
      port.postMessage({t: 'chunk', bytes: buf}, [buf as ArrayBuffer]);
    },
    close: async () => {
      port.postMessage({t: 'end'});
      finish();
    },
    abort: (reason) => {
      if (!cancelled) port.postMessage({t: 'abort', reason});
      finish();
    }
  };
}
