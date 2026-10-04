import type {CycFileRef} from '../../types';
import {h} from '../../components/domHelpers';
import {makeIcon, makeIconButton} from '../../components/iconGlyphs';
import {cyclog} from '@/shared/logging';
import {formatBytes} from '@/features/media/mediaBox';
import {saveMethodFor, shareOrSaveBlob} from '@/features/media/downloads';
import {fetchBinary, transferTimeoutMs, type MediaKind} from '@/features/media/binary';

let openViewer: (() => void) | null = null;

const SPINNER_UTILS =
  'cyc-loader-ring cyc-loader-path block w-10 h-10 rounded-full stroke-[var(--cyc-accent)] ' +
  'bg-[conic-gradient(from_0deg,transparent,var(--cyc-accent))] ' +
  '[mask:radial-gradient(farthest-side,transparent_calc(100%_-_4px),#000_0)] ' +
  '[-webkit-mask:radial-gradient(farthest-side,transparent_calc(100%_-_4px),#000_0)] ' +
  '[animation:cyc-spin_0.85s_linear_infinite]';

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = h(
    'button',
    'cyc-mv-btn cyc-ctl relative h-11 min-w-[8rem] rounded-2xl px-5! font-medium ' +
      'text-white bg-[var(--cyc-accent)] [transition:opacity_0.15s] fine:hover:opacity-90'
  );
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/** A full-screen player/save sheet for a shown binary. A video/audio file plays
 *  inline (a blob URL on a <video controls playsinline> / <audio controls>);
 *  anything else lands here only when the device saves through the OS share
 *  sheet (iOS), where a Save button gives the second tap the activation the
 *  awaited fetch consumed. The bytes stream in over the sealed channel with a
 *  live progress line, an error state, and a header download/share button. */
export function openMediaViewer(file: CycFileRef, url: string, kind: MediaKind | null): void {
  openViewer?.();

  const overlay = h(
    'div',
    'cyc-media-viewer absolute inset-0 z-[12] flex flex-col overflow-hidden bg-[rgba(0,0,0,0.92)] ' +
      'pt-[var(--cyc-safe-top)] pb-[min(var(--cyc-safe-bottom),0.75rem)] ' +
      '[animation:cyc-imgview-in_0.12s_ease-out]'
  );
  const header = h('div', 'cyc-mv-head flex-none flex items-center gap-2 p-2 text-white');
  const back = makeIconButton('left', 'cyc-mv-back text-white! flex-none');
  const title = h(
    'div',
    'cyc-mv-title min-w-0 flex-auto overflow-hidden text-ellipsis whitespace-nowrap ' +
      'text-[0.9375rem] opacity-90'
  );
  title.textContent = file.name;
  const saveBtn = makeIconButton('download', 'cyc-mv-save text-white! flex-none');
  saveBtn.title = 'Save';
  saveBtn.setAttribute('aria-label', 'Save');
  saveBtn.hidden = true;
  header.append(back, title, saveBtn);

  const stage = h(
    'div',
    'cyc-mv-stage flex-auto min-h-0 flex flex-col items-center justify-center gap-4 p-4 ' +
      'text-white text-center'
  );
  overlay.append(header, stage);

  let blob: Blob | null = null;
  let blobUrl: string | null = null;
  let closed = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const close = () => {
    if (openViewer !== close) return;
    openViewer = null;
    closed = true;
    if (timer) clearTimeout(timer);
    controller.abort();
    window.removeEventListener('keydown', onKey, {capture: true});
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    overlay.remove();
  };
  openViewer = close;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener('keydown', onKey, {capture: true});
  back.addEventListener('click', close);

  const doSave = () => {
    if (blob) void shareOrSaveBlob(file.name, blob);
  };
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    doSave();
  });

  const status = h('div', 'cyc-mv-status text-[0.9375rem] opacity-85');
  status.textContent = 'Downloading\u2026';
  const loader = h('div', 'cyc-mv-loading flex flex-col items-center gap-3');
  loader.append(h('span', SPINNER_UTILS), status);
  stage.append(loader);

  const started = Date.now();
  cyclog('download.open', {name: file.name, kind: kind ?? 'binary', bytes: file.size});

  const onProgress = (received: number, total: number) => {
    if (closed) return;
    status.textContent = total
      ? `Downloading\u2026 ${formatBytes(received)} / ${formatBytes(total)}`
      : `Downloading\u2026 ${formatBytes(received)}`;
  };

  const showError = () => {
    if (closed) return;
    stage.replaceChildren();
    const msg = h('div', 'cyc-mv-error text-[0.9375rem] opacity-90');
    msg.textContent = `Could not download ${file.name}`;
    stage.append(
      msg,
      actionButton('Retry', () => {
        close();
        openMediaViewer(file, url, kind);
      })
    );
  };

  const showReady = () => {
    if (closed || !blob) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    saveBtn.hidden = false;
    blobUrl = URL.createObjectURL(blob);
    stage.replaceChildren();
    if (kind === 'video') {
      const v = h('video', 'cyc-mv-video max-w-full max-h-full', {
        controls: '',
        playsinline: '',
        preload: 'auto'
      });
      v.src = blobUrl;
      stage.append(v);
      return;
    }
    if (kind === 'audio') {
      const a = h('audio', 'cyc-mv-audio w-full max-w-lg', {controls: '', preload: 'auto'});
      a.src = blobUrl;
      stage.append(a);
      return;
    }
    const method = saveMethodFor(file.name, blob);
    if (method === 'none') {
      // iOS with a file the share sheet will not take: say so, never a link.
      const line = h('div', 'cyc-mv-error text-[0.9375rem] opacity-90');
      line.textContent = `This device cannot save ${file.name} from here`;
      stage.append(line);
      return;
    }
    if (method === 'share') {
      // The OS share sheet must run from a tap; the awaited fetch spent the
      // tap that opened this sheet, so this button carries a fresh one.
      const ico = h('div', 'cyc-mv-file-ico text-[2.5rem] opacity-80');
      ico.append(makeIcon('document'));
      const line = h('div', 'cyc-mv-file text-[0.9375rem] opacity-90');
      line.textContent = `${file.name} \u00b7 ${formatBytes(blob.size)}`;
      stage.append(ico, line, actionButton('Save', doSave));
      return;
    }
    // A plain download link needs no gesture: save at once.
    doSave();
    const done = h('div', 'cyc-mv-saved text-[0.9375rem] opacity-90');
    done.textContent = `Saved ${file.name}`;
    stage.append(done);
  };

  timer = setTimeout(() => controller.abort(), transferTimeoutMs(file.size));

  void fetchBinary(url, {onProgress, signal: controller.signal, size: file.size}).then(
    (b) => {
      if (closed) return;
      blob = b;
      cyclog('download.done', {
        name: file.name,
        bytes: b.size,
        ms: Date.now() - started,
        kind: kind ?? 'binary'
      });
      showReady();
    },
    (err) => {
      if (closed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      cyclog('download.failed', {name: file.name, ms: Date.now() - started, err});
      showError();
    }
  );

  (document.getElementById('cyc-stage') ?? document.body).append(overlay);
}
