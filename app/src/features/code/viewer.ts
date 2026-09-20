type CodeAction = {
  source: HTMLElement;
  frame: HTMLElement | null;
  flowControl: boolean;
};

// Resolve only the interactive surfaces we own. Source-body clicks are left alone
// for native selection; a header can change the block flow and inline code can copy.
export function resolveCodeAction(target: EventTarget): CodeAction | null {
  if (!(target instanceof Element)) return null;

  const inline = target.closest<HTMLElement>('.cyc-inline-code');
  if (inline) return {source: inline, frame: null, flowControl: false};

  const head = target.closest<HTMLElement>('.cyc-src-head');
  const frame = head?.closest<HTMLElement>('.cyc-code-frame');
  const source = frame?.querySelector<HTMLElement>('.cyc-src-body');
  if (!head || !frame || !source) return null;

  return {
    source,
    frame,
    flowControl: target.closest('.cyc-code-toggle-wrap') !== null
  };
}
export type CodeFlow = 'wrap' | 'pan';
// Explicit two-state flow model for a conversation code block. `wrap` lets the
// code reflow (base pre-wrap); `pan` pins white-space:pre + overflow:auto so the
// block scrolls horizontally with a hidden scrollbar. The state is a single
// data-cyc-code-flow attribute on the `.cyc-code-frame` container; chat.css / codeViewer.css
// paint the `.cyc-src-body` and its scrollbar off it, and the wrap toggle mirrors the
// active state through aria-pressed.
export function applyCodeFlow(container: HTMLElement, flow: CodeFlow): void {
  container.dataset.cycCodeFlow = flow;
  container
    .querySelector('.cyc-code-toggle-wrap')
    ?.setAttribute('aria-pressed', flow === 'wrap' ? 'true' : 'false');
}
export function flipCodeFlow({frame}: CodeAction) {
  if (!frame) return;
  applyCodeFlow(frame, frame.dataset.cycCodeFlow === 'pan' ? 'wrap' : 'pan');
}
export function tableWrapTargetFrom(target: EventTarget): HTMLElement | null {
  const el = target instanceof Element ? target : null;
  if (!el?.closest('.cyc-snippet-table-toggle-wrap')) {
    return null;
  }
  return el.closest<HTMLElement>('.cyc-snippet-table-box');
}
export function toggleTableWrapping(box: HTMLElement) {
  box.querySelector<HTMLElement>('.cyc-snippet-table-wrap')?.classList.toggle('cyc-overflower');
}
export function tableFullscreenTargetFrom(target: EventTarget): HTMLElement | null {
  const el = target instanceof Element ? target : null;
  if (!el?.closest('.cyc-snippet-table-fullscreen')) {
    return null;
  }
  return el.closest<HTMLElement>('.cyc-snippet-table-box');
}
import copyElementText from '@/features/media/downloads';
import {
  currentPresentationTheme,
  paintTheme,
  type PresentationTheme
} from '@/components/presentation';
const whenReady = <T, R>(value: T | Promise<T>, fn: (v: T) => R) =>
  value instanceof Promise ? value.then(fn) : fn(value as T);
import {renderSyntax} from './languages';
export function renderSyntaxBlocks(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('code.cyc-src-body[data-language]').forEach((code) => {
    const language = code.dataset.language!;
    delete code.dataset.language;
    const text = code.textContent || '';
    whenReady(renderSyntax(text, language), (html) => {
      if (html && code.textContent === text) {
        code.innerHTML = html;
        // Highlighting is async, so the `.token` spans appear after the
        // sibling paintCodeBlocks() call ran; ink them now in the live theme.
        paintCodeTokens(code, currentPresentationTheme());
      }
    });
  });
}
const CODE_NIGHT_SURFACE = 'bg-[rgba(0,0,0,0.8)]!';
// Prism token colours. Later groups win on multi-class tokens.
const PRISM_INK: Array<{names: string[]; day: string; night: string}> = [
  {
    names: ['comment', 'prolog', 'doctype', 'cdata'],
    day: '#6b6b70',
    night: '#a0a0a6'
  },
  {names: ['punctuation'], day: '#6b6b70', night: '#a0a0a6'},
  {
    names: ['property', 'tag', 'boolean', 'number', 'constant', 'symbol', 'deleted'],
    day: '#d64246',
    night: '#ff6262'
  },
  {
    names: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'],
    day: '#6b6b70',
    night: '#c98652'
  },
  {names: ['operator', 'entity', 'url'], day: '#d64246', night: '#ff6262'},
  {names: ['atrule', 'attr-value', 'keyword'], day: '#96602f', night: '#ff6262'},
  {names: ['function', 'class-name'], day: '#d64246', night: '#ededee'},
  {names: ['regex', 'important', 'variable'], day: '#1c1c1e', night: '#ededee'}
];
// Comment tokens dim (not recolour) in night; namespace is always .7 either way.
const PRISM_DIM = ['comment', 'prolog', 'doctype', 'cdata'];
// Embedded CSS strings: danger in day, ordinary string ink in night.
const PRISM_CSS_STRING_CTX = '.language-css, .style';
const PRISM_CSS_STRING_INK = {day: '#d64246', night: '#c98652'} as const;
// Inks every `.token` under `root` for `theme`, plus prism.css's three
// static non-theme bits (important/bold -> weight 500, italic, entity -> cursor:help).
export function paintCodeTokens(root: ParentNode, theme: PresentationTheme): void {
  const night = theme === 'night';
  root.querySelectorAll<HTMLElement>('.token').forEach((tok) => {
    let color = '';
    for (const group of PRISM_INK)
      if (group.names.some((n) => tok.classList.contains(n)))
        color = night ? group.night : group.day;
    // Contextual override, applied last to match prism.css source order.
    if (tok.classList.contains('string') && tok.closest(PRISM_CSS_STRING_CTX))
      color = night ? PRISM_CSS_STRING_INK.night : PRISM_CSS_STRING_INK.day;
    tok.style.color = color;
    tok.style.opacity = tok.classList.contains('namespace')
      ? '0.7'
      : night && PRISM_DIM.some((n) => tok.classList.contains(n))
        ? '0.5'
        : '';
    tok.style.fontWeight =
      tok.classList.contains('important') || tok.classList.contains('bold') ? '500' : '';
    tok.style.fontStyle = tok.classList.contains('italic') ? 'italic' : '';
    tok.style.cursor = tok.classList.contains('entity') ? 'help' : '';
  });
}
export function paintCodeBlocks(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('pre.cyc-code-frame').forEach((pre) => {
    if (pre.dataset.codePainted) return;
    pre.dataset.codePainted = '1';
    const run = () => {
      const theme = currentPresentationTheme();
      pre.classList.toggle(CODE_NIGHT_SURFACE, theme === 'night');
      paintCodeTokens(pre, theme);
    };
    paintTheme(pre, run);
  });
}
const TAP_MS = 500;
const TAP_SLOP = 10;
export function installCodeBlockActions(
  root: HTMLElement,
  onCopied: (copied: boolean) => void,
  onFullscreen: (block: HTMLElement) => void
): void {
  let down: {
    t: number;
    x: number;
    y: number;
    touch: boolean;
  } | null = null;
  root.addEventListener(
    'pointerdown',
    (e) => {
      down =
        e.target instanceof Element && e.target.closest('.cyc-src-pane')
          ? {t: Date.now(), x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch'}
          : null;
    },
    true
  );
  root.addEventListener(
    'click',
    (e) => {
      const tableBox = e.target && tableWrapTargetFrom(e.target);
      if (tableBox) {
        e.preventDefault();
        e.stopPropagation();
        toggleTableWrapping(tableBox);
        return;
      }
      const tableFull = e.target && tableFullscreenTargetFrom(e.target);
      if (tableFull) {
        e.preventDefault();
        e.stopPropagation();
        onFullscreen(tableFull);
        return;
      }
      const action = e.target && resolveCodeAction(e.target);
      if (action?.frame) {
        e.preventDefault();
        e.stopPropagation();
        if (action.flowControl) {
          flipCodeFlow(action);
          return;
        }
        if (e.target instanceof Element && e.target.closest('.cyc-src-head-fullscreen')) {
          onFullscreen(action.frame);
          return;
        }
        void copyElementText(action.source).then(onCopied);
        return;
      }
      const press = down;
      down = null;
      if (!press) return;
      if (!press.touch) return;
      if (Date.now() - press.t >= TAP_MS) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP) return;
      if (!(window.getSelection()?.isCollapsed ?? true)) return;
      const block =
        e.target instanceof Element ? e.target.closest<HTMLElement>('.cyc-code-frame') : null;
      if (!block) return;
      if (e.target instanceof Element && e.target.closest('.cyc-code-viewer')) return;
      e.preventDefault();
      e.stopPropagation();
      onFullscreen(block);
    },
    true
  );
}
function codeSelectionText(sel: Selection): string | null {
  if (sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode) as Element | null;
  if (!el) return null;
  if (el.closest('.cyc-fx-code')) {
    const frag = range.cloneContents();
    const rows = frag.querySelectorAll('.cyc-fx-line');
    if (rows.length) {
      return Array.from(rows, (r) => r.querySelector('.cyc-fx-ln')?.textContent ?? '').join('\n');
    }
    const one = frag.querySelector('.cyc-fx-ln');
    return one?.textContent ?? range.toString();
  }
  if (el.closest('pre.cyc-code-frame, pre.cyc-fv-text')) {
    const frag = range.cloneContents();
    const code = frag.querySelector('.cyc-src-body');
    return code?.textContent ?? range.toString();
  }
  return null;
}
export function installCodeCopy(doc: Document = document): void {
  doc.addEventListener(
    'copy',
    (e) => {
      const ev = e as ClipboardEvent;
      if (!ev.clipboardData) return;
      const sel = (doc.defaultView ?? window).getSelection();
      if (!sel) return;
      const text = codeSelectionText(sel);
      if (text == null) return;
      ev.preventDefault();
      ev.clipboardData.setData('text/plain', text);
    },
    true
  );
}
export {codeSelectionText};
export const FONT_STEPS = [9, 10, 11, 12.5, 14, 16, 18, 20];
const FONT_DEFAULT = 3;
export const LINE_RATIO = 1.44;
const VIEW_KEY = 'cyc-fx-view';
export function readView(): {
  step: number;
  wrap: boolean;
} {
  try {
    const raw = JSON.parse(viewStorage().get(VIEW_KEY) || '{}');
    const step =
      typeof raw?.step === 'number' && raw.step >= 0 && raw.step < FONT_STEPS.length
        ? Math.round(raw.step)
        : FONT_DEFAULT;
    return {step, wrap: raw?.wrap === true};
  } catch {
    return {step: FONT_DEFAULT, wrap: false};
  }
}
export function writeView(step: number, wrap: boolean) {
  viewStorage().set(VIEW_KEY, JSON.stringify({step, wrap}));
}
export const WRAP_SVG =
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 6h16"/><path d="M4 12h13a3 3 0 0 1 0 6h-4l2 -2m0 4l-2 -2"/><path d="M4 18h3"/></svg>';
export const HIGHLIGHT_MAX_BYTES = 200000;
const HIGHLIGHT_MAX_LINES = 6000;
export const colourable = (text: string, lines: number) =>
  text.length <= HIGHLIGHT_MAX_BYTES && lines <= HIGHLIGHT_MAX_LINES;
export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function splitHighlighted(html: string, want: number): string[] | null {
  const out: string[] = [];
  const open: Array<{
    tag: string;
    name: string;
  }> = [];
  let cur = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    const text = lt < 0 ? html.slice(i) : html.slice(i, lt);
    if (text) {
      const parts = text.split('\n');
      for (let p = 0; p < parts.length; p++) {
        if (p) {
          for (let k = open.length - 1; k >= 0; k--) cur += `</${open[k].name}>`;
          out.push(cur);
          cur = open.map((o) => o.tag).join('');
        }
        cur += parts[p];
      }
    }
    if (lt < 0) break;
    const gt = html.indexOf('>', lt);
    if (gt < 0) return null;
    const tag = html.slice(lt, gt + 1);
    cur += tag;
    if (tag[1] === '/') {
      if (!open.length) return null;
      open.pop();
    } else if (tag[gt - lt - 1] !== '/') {
      const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
      if (!m) return null;
      open.push({tag, name: m[1]});
    }
    i = gt + 1;
  }
  if (open.length) return null;
  out.push(cur);
  while (out.length > want && out[out.length - 1] === '') out.pop();
  return out.length === want ? out : null;
}
export type ViewStorage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};
const localStorageStore: ViewStorage = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }
};
let current: ViewStorage = localStorageStore;
export function viewStorage(): ViewStorage {
  return current;
}
export function setViewStorage(store: ViewStorage): void {
  current = store;
}
