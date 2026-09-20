import {h} from '../../components/domHelpers';
import {makeIconButton} from '../../components/iconGlyphs';
import {PANE_BACK_UTILS} from '@/features/sessions/components/paneHeader';
import {toast} from '../../components/widgets';
import {cyclog} from '@/shared/logging';
import {docUrl, engineCapFetch} from '../../engine/contract';
import {loadDoc} from '../../engine/showVault';
import {loadErrorText} from './loadError';
import {saveText} from '@/features/media/downloads';
import type {CycFileRef} from '../../types';
import {
  PAGE_SANDBOX,
  frameDocument,
  themeVars,
  installSandboxBridge,
  loadSandboxDocument
} from '@/features/plugins/sandbox';

const PAGE_MAX_BYTES = 1024 * 1024;

const STATE_FETCH_MS = 4000;

const noBody = (): null => null;

let openViewer: (() => void) | null = null;

type PageSubmission = {
  label: string;

  body: string;

  page: string;

  json: boolean;
};

export type HtmlViewerOptions = {
  sessionId?: string;

  onSubmit?: (s: PageSubmission) => {ok: boolean; message: string};

  onClose?: () => void;
};

export function openHtmlViewer(file: CycFileRef, url?: string, opts: HtmlViewerOptions = {}) {
  openViewer?.();

  const docSource = url ?? docUrl(file.docId);
  const stateUrl = `${docSource}/state`;

  const loadState = async (): Promise<{
    ok: boolean;
    saved: boolean;
    data: unknown;
    message: string;
  }> => {
    try {
      const res = await engineCapFetch(stateUrl, {signal: AbortSignal.timeout(STATE_FETCH_MS)});
      const body = (await res.json().catch(noBody)) as {
        ok?: boolean;
        saved?: boolean;
        data?: unknown;
        error?: string;
      } | null;
      if (res.ok && body?.ok) {
        return {
          ok: true,
          saved: !!body.saved,
          data: body.data ?? null,
          message: body.saved ? 'loaded' : 'this page has nothing saved yet'
        };
      }

      return {
        ok: false,
        saved: false,
        data: null,
        message:
          `${body?.error ?? `the engine could not answer (HTTP ${res.status})`}. ` +
          'Nothing was loaded, and this is NOT an empty page: do not save over it.'
      };
    } catch (err) {
      return {
        ok: false,
        saved: false,
        data: null,
        message:
          'the engine that owns this page could not be reached ' +
          `(${err instanceof Error ? err.message : 'error'}). ` +
          'Nothing was loaded, and this is NOT an empty page: do not save over it.'
      };
    }
  };

  const saveState = async (body: string): Promise<{ok: boolean; message: string}> => {
    try {
      const res = await engineCapFetch(stateUrl, {
        method: 'POST',
        body,
        headers: {'content-type': 'application/json'},
        signal: AbortSignal.timeout(STATE_FETCH_MS)
      });
      const answer = (await res.json().catch(noBody)) as {ok?: boolean; error?: string} | null;
      if (res.ok && answer?.ok) return {ok: true, message: 'saved'};

      return {
        ok: false,
        message: answer?.error ?? `the engine refused the save (HTTP ${res.status})`
      };
    } catch (err) {
      return {
        ok: false,
        message:
          'the engine that owns this page could not be reached ' +
          `(${err instanceof Error ? err.message : 'error'}), so nothing was saved. ` +
          'Whatever was saved before is still there.'
      };
    }
  };

  const overlay = h(
    'div',
    'cyc-html-viewer absolute inset-0 z-10 flex flex-col box-border overscroll-contain bg-[var(--cyc-background-color)] pt-[var(--cyc-safe-top)] pb-[min(var(--cyc-safe-bottom),0.75rem)]'
  );

  // pane-header chrome inlined: the shared const carries bg-transparent, this header is surface
  const header = h(
    'div',
    'cyc-pane-header cyc-hv-header flex items-center justify-between px-4 min-h-14 flex-none cursor-default [transition:background-color_0.3s_cubic-bezier(0.32,0.72,0,1)] bg-[var(--cyc-surface)] border-b border-[color:var(--cyc-border-color)]'
  );
  const back = makeIconButton('left', 'cyc-pane-back ' + PANE_BACK_UTILS);
  const title = h(
    'div',
    'cyc-title-container cyc-hv-title flex-auto min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-[length:1rem]'
  );
  title.textContent = file.name;

  let rawSource = '';
  const downloadBtn = makeIconButton(
    'download',
    'cyc-hv-download flex-none disabled:opacity-40! disabled:pointer-events-none'
  );
  downloadBtn.disabled = true;
  downloadBtn.title = 'Download';
  downloadBtn.setAttribute('aria-label', 'Download');
  downloadBtn.addEventListener('click', () => {
    if (downloadBtn.disabled) return;
    saveText(file.name, rawSource, 'text/html;charset=utf-8');
  });
  header.append(back, title, downloadBtn);

  const stage = h('div', 'cyc-hv-stage relative flex min-h-0 w-full flex-auto flex-col');
  overlay.append(header, stage);

  const close = () => {
    if (openViewer !== close) return;
    openViewer = null;
    window.removeEventListener('keydown', onKeyDown, {capture: true});

    bridge.uninstall();

    const frame = stage.querySelector('iframe');
    if (frame) frame.src = 'about:blank';
    overlay.remove();
    opts.onClose?.();
  };
  openViewer = close;

  const bridge = installSandboxBridge(() => stage.querySelector('iframe'), {
    onClose: close,
    onSave: saveState,
    onLoad: loadState,
    onEmptySubmit: () => {
      cyclog('page.answer.refused', {reason: 'empty-body', page: file.name});
      toast(`${file.name}: nothing to submit (the answer was empty)`);
    },
    onSubmit: opts.onSubmit
      ? (p) => opts.onSubmit!({label: p.label, body: p.body, page: file.name, json: p.json})
      : undefined
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener('keydown', onKeyDown, {capture: true});
  back.addEventListener('click', close);

  const fail = (message: string) => {
    const errEl = h(
      'div',
      'cyc-hv-error px-4 py-8 text-center text-[color:var(--cyc-text-muted)] text-[length:0.9375rem] leading-[1.4]'
    );
    errEl.textContent = message;
    stage.append(errEl);
  };

  // Explicit 40px inline busy-ring shown while the document loads.
  const loader = h('div', 'cyc-loader-inline flex justify-center py-12');
  loader.innerHTML =
    '<span class="cyc-loader-ring cyc-loader-path block w-10 h-10 rounded-full ' +
    'stroke-[var(--cyc-accent)] ' +
    'bg-[conic-gradient(from_0deg,transparent,var(--cyc-accent))] ' +
    '[mask:radial-gradient(farthest-side,transparent_calc(100%_-_4px),#000_0)] ' +
    '[-webkit-mask:radial-gradient(farthest-side,transparent_calc(100%_-_4px),#000_0)] ' +
    '[animation:cyc-spin_0.85s_linear_infinite]"></span>';
  stage.append(loader);
  void (async () => {
    let doc: {name?: string; fileKind?: string; content?: string};
    try {
      doc = await loadDoc(file.docId, docSource, opts.sessionId ?? '');
    } catch (err) {
      loader.remove();
      fail(loadErrorText(file.name, err));
      return;
    }
    if (openViewer !== close) return;
    loader.remove();

    const source = typeof doc.content === 'string' ? doc.content : '';
    if (!source.trim()) return fail(`${file.name} is empty, so there is nothing to run.`);

    rawSource = source;
    downloadBtn.disabled = false;

    if (source.length > PAGE_MAX_BYTES) {
      return fail(
        `${file.name} is ${Math.round(source.length / 1024)}KB, over the ` +
          `${Math.round(PAGE_MAX_BYTES / 1024)}KB limit for an interactive page, so it was not run. ` +
          'Nothing was truncated.'
      );
    }

    const {theme, vars} = themeVars();
    const frame = document.createElement('iframe');
    frame.className =
      'cyc-hv-frame block w-full flex-auto border-0 bg-[var(--cyc-background-color)]';
    frame.setAttribute('sandbox', PAGE_SANDBOX);

    frame.setAttribute('allow', '');

    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = file.name;

    stage.append(frame);
    loadSandboxDocument(frame, frameDocument(source, theme, vars));
  })();

  (document.getElementById('cyc-stage') ?? document.body).append(overlay);
}
