import 'diff2html/bundles/css/diff2html.min.css';

import {html as diff2html} from 'diff2html';
import {parseMarkdownDocument} from '@/features/content/markdown';
import {h} from '../../components/domHelpers';
import {makeIconButton} from '../../components/iconGlyphs';
import {PANE_BACK_UTILS} from '@/features/sessions/components/paneHeader';
import {scrollSurface} from '@/shared/dom';
import {docUrl} from '../../engine/contract';
import {loadDoc} from '../../engine/showVault';
import {loadErrorText} from './loadError';
import {copyText, saveText} from '@/features/media/downloads';
import type {CycFileRef} from '../../types';
import {renderMarkdown} from './pageRenderer';
import {toast} from '../../components/widgets';
import {paintPresentation} from '../../components/presentation';

const SIDE_BY_SIDE_MIN_WIDTH = 900;

type DiffFormat = 'line-by-line' | 'side-by-side';

function renderDiff(content: string, format: DiffFormat): HTMLElement {
  const el = h('div', 'cyc-fv-diff');

  el.innerHTML = diff2html(content, {
    outputFormat: format,
    drawFileList: false,
    matching: 'lines'
  });
  return el;
}

const TASK_BOX_STATES = new Map([
  [' ', '\u2610'],
  ['x', '\u2611']
]);

function taskBoxes(content: string): string {
  return content.replace(/^(\s*)[-+*]\s+\[(.)\]\s+/gm, (all, indent: string, mark: string) => {
    const box = TASK_BOX_STATES.get(mark.toLowerCase());
    return box ? `${indent}${box} ` : all;
  });
}

let openViewer: (() => void) | null = null;

export function openFileViewer(
  file: CycFileRef,
  url?: string,
  sessionId = '',
  onClose?: () => void,
  load?: () => Promise<{name?: string; fileKind?: string; content?: string}>
) {
  openViewer?.();

  const overlay = h(
    'div',
    'cyc-file-viewer absolute inset-0 z-10 flex flex-col box-border overscroll-contain bg-[var(--cyc-background-color)] pt-[var(--cyc-safe-top)] pb-[min(var(--cyc-safe-bottom),0.75rem)]'
  );

  // pane-header chrome inlined: the shared const carries bg-transparent, this header is surface
  const header = h(
    'div',
    'cyc-pane-header cyc-fv-header flex items-center justify-between px-4 min-h-14 flex-none cursor-default [transition:background-color_0.3s_cubic-bezier(0.32,0.72,0,1)] bg-[var(--cyc-surface)] border-b border-[color:var(--cyc-border-color)]'
  );
  const back = makeIconButton('left', 'cyc-pane-back ' + PANE_BACK_UTILS);
  const title = h(
    'div',
    'cyc-title-container cyc-fv-title flex-auto min-w-0 me-auto ps-2 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-[length:1rem]'
  );
  title.textContent = file.name;

  let rawContent = '';
  const copyBtn = makeIconButton(
    'copy',
    'cyc-fv-copy flex-none disabled:opacity-40! disabled:pointer-events-none'
  );
  copyBtn.disabled = true;
  const doCopy = async () => {
    if (!rawContent) return;
    toast((await copyText(rawContent)) ? 'Copied' : 'Copy failed');
  };
  copyBtn.addEventListener('click', doCopy);

  const downloadBtn = makeIconButton(
    'download',
    'cyc-fv-download flex-none disabled:opacity-40! disabled:pointer-events-none'
  );
  downloadBtn.disabled = true;
  downloadBtn.title = 'Download';
  downloadBtn.setAttribute('aria-label', 'Download');
  downloadBtn.addEventListener('click', () => {
    if (downloadBtn.disabled) return;
    saveText(file.name, rawContent);
  });
  header.append(back, title, downloadBtn, copyBtn);

  const scroll = scrollSurface();
  scroll.classList.add('cyc-fv-scroll', 'relative!', 'flex-[1_1_auto]');
  const body = h('div', 'cyc-fv-body w-full max-w-3xl mx-auto px-4 pt-4 pb-12 select-text');
  scroll.append(body);
  overlay.append(header, scroll);

  const cleanups: Array<() => void> = [];
  const close = () => {
    if (openViewer !== close) return;
    openViewer = null;
    window.removeEventListener('keydown', onKeyDown, {capture: true});
    for (const fn of cleanups) fn();
    overlay.remove();
    onClose?.();
  };
  openViewer = close;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener('keydown', onKeyDown, {capture: true});
  back.addEventListener('click', close);

  // Explicit 40px inline busy-ring shown while the document loads.
  const loader = h('div', 'cyc-loader-inline flex justify-center py-12');
  loader.innerHTML =
    '<span class="cyc-loader-ring cyc-loader-path block w-10 h-10 rounded-full ' +
    'stroke-[var(--cyc-accent)] ' +
    'bg-[conic-gradient(from_0deg,transparent,var(--cyc-accent))] ' +
    '[mask:radial-gradient(farthest-side,transparent_calc(100%_-_4px),#000_0)] ' +
    '[-webkit-mask:radial-gradient(farthest-side,transparent_calc(100%_-_4px),#000_0)] ' +
    '[animation:cyc-spin_0.85s_linear_infinite]"></span>';
  body.append(loader);
  void (async () => {
    let doc: {name?: string; fileKind?: string; content?: string};
    try {
      doc = await (load ? load() : loadDoc(file.docId, url ?? docUrl(file.docId), sessionId));
    } catch (err) {
      loader.remove();
      const errEl = h(
        'div',
        'cyc-fv-error text-center px-4 py-12 text-[color:var(--cyc-text-muted)]'
      );
      errEl.textContent = loadErrorText(file.name, err);
      body.append(errEl);
      return;
    }
    if (openViewer !== close) return;
    loader.remove();

    const content = typeof doc.content === 'string' ? doc.content : '';
    rawContent = content;
    copyBtn.disabled = false;
    downloadBtn.disabled = false;
    const kind =
      doc.fileKind === 'markdown' || doc.fileKind === 'diff' ? doc.fileKind : file.fileKind;
    if (kind === 'markdown') {
      body.append(renderMarkdown(parseMarkdownDocument(taskBoxes(content)).nodes));
    } else if (kind === 'diff') {
      let format: DiffFormat = 'line-by-line';
      let diffEl = renderDiff(content, format);
      body.classList.add('cyc-fv-body-diff', 'max-w-[80rem]!');
      body.append(diffEl);

      // Laptop-only diff toggle.
      const toggleBtn = h(
        'button',
        'cyc-ctl-primary cyc-ctl-flat primary cyc-fv-diff-toggle text-center overflow-hidden relative items-center font-normal leading-[var(--cyc-line-height)] [transition:opacity_0.25s_cubic-bezier(0.32,0.72,0,1),background-color_0.25s_cubic-bezier(0.32,0.72,0,1),color_0.25s_cubic-bezier(0.32,0.72,0,1)] flex-[0_0_auto]! w-auto! h-[2.125rem]! px-3! py-0! text-[0.875rem] fine:hover:bg-(--cyc-accent-tint)! fine:active:bg-(--cyc-accent-tint)!'
      );
      const paintToggle = (s: {width: string}) => {
        const show = s.width === 'laptop';
        toggleBtn.classList.toggle('hidden!', !show);
        toggleBtn.classList.toggle('block!', show);
      };
      paintPresentation(toggleBtn, paintToggle);
      const syncLabel = () =>
        (toggleBtn.textContent = format === 'line-by-line' ? 'Side-by-side' : 'Unified');
      syncLabel();
      toggleBtn.addEventListener('click', () => {
        format = format === 'line-by-line' ? 'side-by-side' : 'line-by-line';
        const next = renderDiff(content, format);
        diffEl.replaceWith(next);
        diffEl = next;
        syncLabel();
      });
      header.append(toggleBtn);

      const onResize = () => {
        if (format === 'side-by-side' && window.innerWidth < SIDE_BY_SIDE_MIN_WIDTH)
          toggleBtn.click();
      };
      window.addEventListener('resize', onResize);
      cleanups.push(() => window.removeEventListener('resize', onResize));
    } else {
      const pre = h(
        'pre',
        'cyc-fv-text m-0 overflow-x-auto rounded-lg border border-[color:var(--cyc-border-color)] bg-[var(--cyc-surface)] px-4 py-3 font-[family-name:JetBrains_Mono,monospace] text-[0.8125rem] leading-normal text-[color:var(--cyc-text)]'
      );
      pre.textContent = content;
      body.append(pre);
    }
  })();

  (document.getElementById('cyc-stage') ?? document.body).append(overlay);
}
