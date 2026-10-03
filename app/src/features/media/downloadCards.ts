import type {CycFileRef} from '../../types';
import {cyclog} from '@/shared/logging';
import {h} from '../../components/domHelpers';
import {makeIcon} from '../../components/iconGlyphs';
import {toast} from '../../components/widgets';
import {formatBytes} from '@/features/media/mediaBox';
import {canShareFile, iosLike, saveBlob} from '@/features/media/downloads';
import {memorySink, openBrowserDownload, type MemorySink} from '@/features/media/downloadSinks';
import {
  startDownload,
  type DownloadHandle,
  type DownloadProgress,
  type DownloadSink
} from '../../engine/transfers/download';

// A shown file's download, as its card shows it (download-lane, 2026-10-03).
// One tap is the whole job:
//  - laptop / Android: the browser's own download starts at once, fed part by
//    part over the sealed tunnel (downloadSinks.openBrowserDownload); the card
//    shows the same progress and a cancel;
//  - iPhone: the parts collect on the device with progress on the card, then
//    the OS save sheet opens (its only save path from a home-screen app). The
//    sheet needs a fresh tap, so when the bytes take longer than the tap's
//    activation the card turns into "Tap to save" and that one tap opens it.
//    Nothing ever navigates to the file or opens it in the app.
// The state lives here, keyed by docId, so a card the chat list re-renders
// mid-download paints where the download is.

type Phase = DownloadProgress['phase'] | 'starting' | 'ready';

type Job = {
  docId: string;
  name: string;
  size: number;
  phase: Phase;
  received: number;
  total: number;
  reason?: string;
  via: 'browser' | 'memory' | 'share';
  tapAt: number;
  handle?: DownloadHandle;
  blob?: Blob;
};

const jobs = new Map<string, Job>();
// A tap's activation is good for about this long on WebKit: past it the share
// sheet refuses (NotAllowedError) and the card asks for one more tap.
const SHARE_ACTIVATION_MS = 1_000;
// A finished card shows "Downloaded" this long, then its size again.
const DONE_SHOWN_MS = 4_000;
// The failure reason of a file the iOS share sheet will not take.
const UNSAVEABLE = 'unsaveable';

function pct(j: Job): number {
  const t = j.total || j.size;
  return t > 0 ? Math.min(100, Math.floor((j.received / t) * 100)) : 0;
}

function sizeLine(j: Job | undefined, size: number): string {
  if (!j) return formatBytes(size);
  const t = j.total || j.size;
  switch (j.phase) {
    case 'starting':
      return `Starting\u2026`;
    case 'active':
      return t
        ? `${formatBytes(j.received)} / ${formatBytes(t)} \u00b7 ${pct(j)}%`
        : formatBytes(j.received);
    case 'waiting':
      return `${j.reason === 'reconnecting' ? 'Paused, reconnecting' : 'Retrying'} \u00b7 ${pct(j)}%`;
    case 'ready':
      return 'Tap to save';
    case 'done':
      return 'Downloaded';
    case 'failed':
      return j.reason === UNSAVEABLE
        ? 'Cannot be saved on this device'
        : 'Download failed \u00b7 tap to retry';
    case 'cancelled':
      return formatBytes(size);
  }
}

/** Paint one card for its file's download state. The card is the
 *  .cyc-download-card fileMessages draws; called at render and on every change. */
export function paintDownloadCard(card: HTMLElement, file: CycFileRef): void {
  card.dataset.cycDoc = file.docId;
  const j = jobs.get(file.docId);
  const size = card.querySelector<HTMLElement>('.cyc-doc-size');
  if (size) size.textContent = sizeLine(j, file.size);
  const live = !!j && (j.phase === 'starting' || j.phase === 'active' || j.phase === 'waiting');
  card.dataset.cycDl = j ? j.phase : 'idle';
  const btn = card.querySelector<HTMLButtonElement>('.cyc-download-btn');
  if (btn) {
    const icon = live ? 'close' : j?.phase === 'failed' ? 'refresh' : 'download';
    if (btn.dataset.icon !== icon) {
      btn.dataset.icon = icon;
      btn.replaceChildren(makeIcon(icon));
    }
    const label = live ? 'Cancel download' : j?.phase === 'ready' ? 'Save' : 'Download';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  let bar = card.querySelector<HTMLElement>('.cyc-dl-bar');
  if (live || j?.phase === 'ready') {
    if (!bar) {
      bar = h(
        'div',
        'cyc-dl-bar absolute start-0 bottom-0 h-[3px] rounded-b-md bg-[var(--cyc-accent)] ' +
          '[transition:width_0.2s_linear] pointer-events-none'
      );
      card.append(bar);
    }
    bar.style.width = `${j!.phase === 'ready' ? 100 : pct(j!)}%`;
  } else bar?.remove();
}

function repaint(j: Job): void {
  for (const card of document.querySelectorAll<HTMLElement>('.cyc-download-card')) {
    if (card.dataset.cycDoc !== j.docId) continue;
    paintDownloadCard(card, {docId: j.docId, name: j.name, size: j.size, fileKind: 'binary'});
  }
}

/** True while this file is downloading (the card's button then cancels). */
export function downloadLive(docId: string): boolean {
  const p = jobs.get(docId)?.phase;
  return p === 'starting' || p === 'active' || p === 'waiting';
}

export function cancelDownload(docId: string): void {
  const j = jobs.get(docId);
  if (!j || !downloadLive(docId)) return;
  cyclog('download.cancel.tap', {name: j.name, received: j.received, total: j.total});
  j.handle?.cancel();
}

// The share sheet, from inside a tap. True when it opened (or the user
// dismissed it); false when the activation was gone or the device refused.
async function shareNow(j: Job, blob: Blob): Promise<boolean> {
  const nav = navigator as Navigator & {
    share?: (d: {files: File[]; title?: string}) => Promise<void>;
  };
  const file = new File([blob], j.name, {type: blob.type || 'application/octet-stream'});
  try {
    await nav.share!({files: [file], title: j.name});
    cyclog('download.saved', {name: j.name, via: 'share', bytes: blob.size});
    return true;
  } catch (err) {
    const name = (err as {name?: string})?.name;
    if (name === 'AbortError') {
      cyclog('download.saved', {name: j.name, via: 'share-cancelled', bytes: blob.size});
      return true;
    }
    cyclog('download.share.failed', {
      name: j.name,
      err: String(err),
      why:
        name === 'NotAllowedError'
          ? 'the tap that started the download is too old for the save sheet; the card asks for one more tap'
          : 'the save sheet refused the file'
    });
    return false;
  }
}

function setPhase(j: Job, p: DownloadProgress | {phase: Phase}): void {
  j.phase = p.phase;
  if ('received' in p) {
    j.received = p.received;
    j.total = p.total;
    j.reason = p.reason;
  }
  repaint(j);
}

/** The tap on a shown binary's card (not a video or audio file, which plays). */
export function tapDownloadCard(file: CycFileRef, url: string): void {
  const prev = jobs.get(file.docId);
  if (prev && downloadLive(file.docId)) {
    cyclog('download.tap.busy', {name: file.name, phase: prev.phase, received: prev.received});
    return;
  }
  if (prev?.phase === 'ready' && prev.blob) {
    // iPhone, second tap: this click carries the activation the sheet needs.
    const blob = prev.blob;
    void shareNow(prev, blob).then((ok) => {
      if (ok) {
        prev.blob = undefined;
        setPhase(prev, {phase: 'done'});
        doneLater(prev);
      } else toast(`Could not open the save sheet for ${file.name}`);
    });
    return;
  }
  const j: Job = {
    docId: file.docId,
    name: file.name,
    size: file.size,
    phase: 'starting',
    received: 0,
    total: file.size,
    via: 'memory',
    tapAt: Date.now()
  };
  jobs.set(file.docId, j);
  repaint(j);
  void run(j, url);
}

function doneLater(j: Job): void {
  setTimeout(() => {
    if (jobs.get(j.docId) === j && j.phase === 'done') {
      jobs.delete(j.docId);
      repaint(j);
    }
  }, DONE_SHOWN_MS);
}

async function run(j: Job, url: string): Promise<void> {
  const ios = iosLike();
  let sink: DownloadSink | null = null;
  let mem: MemorySink | null = null;
  if (!ios) {
    sink = await openBrowserDownload({
      name: j.name,
      size: j.size,
      type: 'application/octet-stream',
      onCancel: () => j.handle?.cancel()
    });
    if (sink) j.via = 'browser';
  } else {
    j.via = 'share';
    if (!canShareFile(j.name, new Blob([]))) {
      // Never a link to the bytes on iOS: WebKit opens it as a page inside the
      // app with no way back. Say so instead of downloading for nothing.
      j.reason = UNSAVEABLE;
      setPhase(j, {phase: 'failed'});
      cyclog('download.share.unavailable', {name: j.name, bytes: j.size});
      toast(`This device cannot save ${j.name} from here`);
      return;
    }
  }
  if (!sink) sink = mem = memorySink('');
  cyclog('download.start', {
    name: j.name,
    bytes: j.size,
    via: j.via,
    why:
      j.via === 'browser'
        ? "the browser's own download is fed part by part as the parts arrive"
        : j.via === 'share'
          ? 'iOS saves through the share sheet, which needs the whole file: the parts collect here first'
          : 'no service worker to stream through: the parts collect here, then save as one file'
  });
  j.handle = startDownload({
    name: j.name,
    url,
    size: j.size,
    sink,
    onProgress: (p) => setPhase(j, p)
  });
  const end = await j.handle.done;
  if (end.phase === 'failed') {
    toast(`Could not download ${j.name}`);
    return;
  }
  if (end.phase === 'cancelled') {
    jobs.delete(j.docId);
    repaint(j);
    return;
  }
  if (j.via === 'browser') {
    doneLater(j);
    return;
  }
  const blob = mem!.blob()!;
  if (j.via === 'share') {
    if (Date.now() - j.tapAt < SHARE_ACTIVATION_MS && (await shareNow(j, blob))) {
      setPhase(j, {phase: 'done'});
      doneLater(j);
      return;
    }
    j.blob = blob;
    setPhase(j, {phase: 'ready'});
    return;
  }
  saveBlob(j.name, blob);
  cyclog('download.saved', {name: j.name, via: 'download', bytes: blob.size});
  doneLater(j);
}

/** Test seam: forget every download. */
export function __resetDownloadCardsForTest(): void {
  for (const j of jobs.values()) j.handle?.cancel();
  jobs.clear();
}
