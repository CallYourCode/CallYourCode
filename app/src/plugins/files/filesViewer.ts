import {h} from '@/components/domHelpers';
import {makeIconButton} from '@/components/iconGlyphs';
import {toast} from '@/components/widgets';
import {copyText} from '@/features/media/downloads';
import {
  fileIcon,
  prismLanguage,
  FOLDER_SVG,
  FOLDER_OPEN_SVG,
  CHEVRON_SVG
} from '@/features/media/icons';
import {
  fsList,
  fsRead,
  fsGit,
  fsDiff,
  fsRaw,
  foldDirs,
  failed,
  type FsEntry,
  type GitCode,
  type DiffMark
} from './filesData';

import {
  FONT_STEPS,
  LINE_RATIO,
  readView,
  writeView,
  WRAP_SVG,
  colourable,
  esc,
  splitHighlighted
} from '@/features/code/viewer';
import {renderSyntax} from '@/features/code/languages';
const whenReady = <T, R>(value: T | Promise<T>, fn: (v: T) => R) =>
  value instanceof Promise ? value.then(fn) : fn(value as T);

import {createSplitPane, TAP_SLOP} from './splitPane';
import {createFxPaint} from './filesPaint';

const ROW_TOUCH = 34;

const DELETED_GUTTER_MARK =
  'cyc-fx-d-deleted-mark pointer-events-none absolute left-0 -bottom-[3px] border-solid border-y-[3px] border-y-transparent border-l-[5px]';

function syncDeletedGutter(gline: HTMLElement, kind: string | undefined) {
  const existing = gline.querySelector(':scope > .cyc-fx-d-deleted-mark');
  if (kind === 'deleted') {
    if (!existing) {
      const mark = document.createElement('span');
      mark.className = DELETED_GUTTER_MARK;
      gline.append(mark);
    }
  } else {
    existing?.remove();
  }
}
const ROW_POINTER = 22;

const SPLIT_TABLET = 0.27;
const SPLIT_LAPTOP = 0.2;

const SPLIT_KEY = 'cyc-fx-split';

const ROWS_MAX = 5000;

const touch = () => matchMedia('(pointer: coarse)').matches;
const isDark = () => document.documentElement.dataset.theme === 'dark';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${day} ${d.getFullYear()}`;
}

const GIT_LABEL: Record<GitCode, string> = {
  M: 'M',
  A: 'A',
  D: 'D',
  R: 'R',
  U: 'U',
  C: '!',
  I: ''
};

const EMPTY_B = 'Pick a file on the left.';

let openViewer: (() => void) | null = null;

type Row = {
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  entry: FsEntry;
};

export function openFilesViewer(sessionId: string, sessionName: string, onClose?: () => void) {
  openViewer?.();

  const overlay = h('div', 'cyc-fx');
  const fxPaint = createFxPaint(overlay);
  const repaint = fxPaint.repaint;

  const pane = createSplitPane(overlay, {
    storageKey: SPLIT_KEY,
    splitTablet: SPLIT_TABLET,
    splitLaptop: SPLIT_LAPTOP,
    railLabelA: sessionName,
    railLabelB: 'No file',
    ignoreSwipeWithin: '.cyc-fx-tabs',
    onLayout: repaint
  });
  const {paneA, paneB, railA, railB} = pane;

  const headA = h('div', 'cyc-fx-head');
  const back = makeIconButton('left', 'cyc-fx-back', false, false);
  back.title = 'Back';
  back.setAttribute('aria-label', 'Back');
  const headATitles = h('div', 'cyc-fx-head-titles');
  const titleA = h('div', 'cyc-fx-title');
  const crumbA = h('div', 'cyc-fx-crumb');
  headATitles.append(titleA, crumbA);
  headA.append(back, headATitles);

  const treeScroll = h('div', 'cyc-fx-scroll');
  const tree = h('div', 'cyc-fx-tree');
  treeScroll.append(tree);

  const footA = h('div', 'cyc-fx-foot');
  const footALeft = h('div', 'cyc-fx-foot-left');
  const footARight = h('div', 'cyc-fx-foot-right');
  footA.append(footALeft, footARight);
  paneA.append(headA, treeScroll, footA);

  const headB = h('div', 'cyc-fx-head');
  const headBTitles = h('div', 'cyc-fx-head-titles');
  const titleB = h('div', 'cyc-fx-title');
  const langB = h('span', 'cyc-fx-lang');
  const crumbB = h('div', 'cyc-fx-crumb');
  const titleBRow = h('div', 'cyc-fx-title-row');
  titleBRow.append(titleB, langB);
  headBTitles.append(titleBRow, crumbB);
  const copyBtn = makeIconButton('copy', 'cyc-fx-copy', false, false);
  copyBtn.title = 'Copy file';
  copyBtn.setAttribute('aria-label', 'Copy file');
  copyBtn.disabled = true;

  const viewBar = h('div', 'cyc-fx-view');
  const vbtn = (label: string, title: string) => {
    const b = h('button', 'cyc-fx-vbtn');
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.disabled = true;
    viewBar.append(b);
    return b;
  };
  const smallerBtn = vbtn('A−', 'Smaller text');
  const biggerBtn = vbtn('A+', 'Bigger text');
  const wrapBtn = vbtn('', 'Word wrap');
  wrapBtn.classList.add('cyc-fx-vbtn-wrap');
  wrapBtn.innerHTML = WRAP_SVG;
  headB.append(headBTitles, viewBar, copyBtn);

  const tabsEl = h('div', 'cyc-fx-tabs');

  const fileScroll = h('div', 'cyc-fx-scroll cyc-fx-file-scroll');
  const fileBody = h('div', 'cyc-fx-file');
  fileScroll.append(fileBody);

  const footB = h('div', 'cyc-fx-foot');
  const footBLeft = h('div', 'cyc-fx-foot-left');
  const footBRight = h('div', 'cyc-fx-foot-right');
  footB.append(footBLeft, footBRight);
  paneB.append(headB, tabsEl, fileScroll, footB);

  let root = '';
  let rootName = sessionName;
  const dirs = new Map<string, FsEntry[]>();
  const loading = new Set<string>();
  const expanded = new Set<string>(['']);
  let git: Record<string, GitCode> = {};
  let gitNote = '';
  let selected: string | null = null;
  let openPath: string | null = null;

  const openTabs: Array<{path: string; name: string}> = [];
  let openText = '';
  let rowsShown = 0;
  let rowsTotal = 0;

  const view = readView();
  let fontStep = view.step;
  let wrapOn = view.wrap;
  let hasCode = false;

  let paintSeq = 0;

  const cleanups: Array<() => void> = [];
  const aborts = new Set<AbortController>();
  const abortAll = () => {
    for (const a of aborts) a.abort();
    aborts.clear();
  };
  const guard = () => {
    const a = new AbortController();
    aborts.add(a);
    return a;
  };

  function buildRows(): Row[] {
    const out: Row[] = [];
    let total = 0;
    const walk = (dir: string, depth: number) => {
      const entries = dirs.get(dir);
      if (!entries) return;
      for (const e of entries) {
        total++;
        const path = dir ? `${dir}/${e.name}` : e.name;
        if (out.length < ROWS_MAX) out.push({path, name: e.name, dir: e.dir, depth, entry: e});
        if (e.dir && expanded.has(path)) walk(path, depth + 1);
      }
    };
    walk('', 0);
    rowsShown = out.length;
    rowsTotal = total;
    return out;
  }

  function renderTree() {
    const rows = buildRows();
    const rowH = touch() ? ROW_TOUCH : ROW_POINTER;
    const dark = isDark();
    const frag = document.createDocumentFragment();

    for (const r of rows) {
      const el = h('div', 'cyc-fx-row');
      el.style.height = `${rowH}px`;
      el.dataset.path = r.path;
      el.dataset.dir = r.dir ? '1' : '';
      if (r.path === selected) el.classList.add('cyc-fx-sel');
      if (r.path === openPath) el.classList.add('cyc-fx-open');

      const indent = h('span', 'cyc-fx-indent');
      indent.style.width = `${r.depth * 12}px`;
      el.append(indent);

      const twist = h('span', 'cyc-fx-twist');
      if (r.dir) {
        if (r.entry.children !== false) {
          twist.innerHTML = CHEVRON_SVG;
          twist.classList.add('cyc-fx-twist-on');
          if (expanded.has(r.path)) twist.classList.add('cyc-fx-twist-open');
        }
      }
      el.append(twist);

      const icon = h('span', 'cyc-fx-icon');
      if (r.dir) {
        icon.innerHTML = expanded.has(r.path) ? FOLDER_OPEN_SVG : FOLDER_SVG;
        icon.classList.add('cyc-fx-icon-folder');
      } else {
        const paint = fileIcon(r.name, dark);
        icon.classList.add('cyc-fx-icon-seti');
        icon.textContent = paint.char;
        icon.style.color = paint.color;
      }
      el.append(icon);

      const name = h('span', 'cyc-fx-name');
      name.textContent = r.name;
      const code = git[r.path];
      if (code) name.classList.add(`cyc-fx-g${code}`);
      if (r.entry.link) name.classList.add('cyc-fx-link');
      el.append(name);

      if (code && GIT_LABEL[code]) {
        const mark = h('span', `cyc-fx-gmark cyc-fx-g${code}`);
        mark.textContent = GIT_LABEL[code];
        el.append(mark);
      }
      frag.append(el);
    }

    tree.textContent = '';
    tree.append(frag);
    paintFootA();
  }

  function paintFootA() {
    if (selected) {
      const parent = selected.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : '';
      const e = dirs.get(parent)?.find((x) => x.name === selected!.split('/').pop());
      if (e) {
        footALeft.textContent = e.dir
          ? `${e.name} · ${dirs.get(selected)?.length ?? '?'} items · ${fmtDate(e.mtime)}`
          : `${e.name} · ${fmtBytes(e.size)} · ${fmtDate(e.mtime)}`;
      } else {
        footALeft.textContent = selected;
      }
    } else {
      footALeft.textContent = rootName;
    }
    const cut = rowsShown < rowsTotal;
    footARight.textContent = cut ? `${rowsShown} of ${rowsTotal} shown` : `${rowsShown} shown`;
    footARight.classList.toggle('cyc-fx-warn', cut);
    if (gitNote) {
      footARight.textContent = gitNote;
      footARight.classList.add('cyc-fx-warn');
    }
    repaint();
  }

  async function loadDir(path: string): Promise<boolean> {
    if (dirs.has(path) || loading.has(path)) return dirs.has(path);
    loading.add(path);
    const a = guard();
    const r = await fsList(sessionId, path, a.signal);
    aborts.delete(a);
    loading.delete(path);
    if (openViewer !== close) return false;
    if (failed(r)) {
      if (r.error !== 'aborted') toast(r.error);
      return false;
    }
    if (!root) {
      root = r.root;
      rootName = r.name || sessionName;
    }
    dirs.set(path, r.entries);
    if (r.truncated) {
      toast(`${r.entries.length} of ${r.total} entries shown in ${path || rootName}`);
    }
    return true;
  }

  async function toggleDir(path: string) {
    if (expanded.has(path)) {
      expanded.delete(path);
      renderTree();
      return;
    }
    expanded.add(path);
    renderTree();
    if (await loadDir(path)) renderTree();
  }

  function renderTabs() {
    tabsEl.textContent = '';
    tabsEl.classList.toggle('cyc-fx-hidden', !openTabs.length);
    const dark = isDark();
    for (const t of openTabs) {
      const el = h('button', 'cyc-fx-tab');
      el.dataset.path = t.path;
      if (t.path === openPath) el.classList.add('cyc-fx-tab-on');
      const icon = h('span', 'cyc-fx-tab-icon');
      const paint = fileIcon(t.name, dark);
      icon.textContent = paint.char;
      icon.style.color = paint.color;
      const name = h('span', 'cyc-fx-tab-name');
      name.textContent = t.name;
      el.title = t.path;
      const x = h('span', 'cyc-fx-tab-x');
      x.textContent = '×';
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', `Close ${t.name}`);
      el.append(icon, name, x);
      tabsEl.append(el);
    }
    showActiveTab();
    repaint();
  }

  function showActiveTab() {
    const el = tabsEl.querySelector<HTMLElement>('.cyc-fx-tab-on');
    if (!el) return;
    const pad = 16;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left - pad < tabsEl.scrollLeft) {
      tabsEl.scrollLeft = Math.max(0, left - pad);
    } else if (right + pad > tabsEl.scrollLeft + tabsEl.clientWidth) {
      tabsEl.scrollLeft = right + pad - tabsEl.clientWidth;
    }
  }

  function closeTab(path: string) {
    const i = openTabs.findIndex((t) => t.path === path);
    if (i < 0) return;
    const wasOpen = path === openPath;
    openTabs.splice(i, 1);
    if (!wasOpen) {
      renderTabs();
      return;
    }
    if (!openTabs.length) {
      openPath = null;
      openText = '';
      renderTabs();
      paintEmptyB(EMPTY_B);
      renderTree();
      return;
    }

    const next = openTabs[Math.min(i, openTabs.length - 1)];
    void openInB(next.path, next.name);
  }

  function applyView() {
    const size = FONT_STEPS[fontStep];
    const wrapEl = fileBody.querySelector<HTMLElement>('.cyc-fx-code-wrap');
    if (wrapEl) {
      wrapEl.style.fontSize = `${size}px`;
      wrapEl.style.setProperty('--fx-line-h', `${Math.round(size * LINE_RATIO)}px`);
    }
    paneB.classList.toggle('cyc-fx-wrapped', wrapOn);
    wrapBtn.classList.toggle('cyc-fx-vbtn-on', wrapOn);
    wrapBtn.setAttribute('aria-pressed', wrapOn ? 'true' : 'false');

    smallerBtn.disabled = !hasCode || fontStep === 0;
    biggerBtn.disabled = !hasCode || fontStep === FONT_STEPS.length - 1;
    wrapBtn.disabled = !hasCode;
    repaint();
  }

  const stepFont = (d: number) => {
    const next = Math.min(FONT_STEPS.length - 1, Math.max(0, fontStep + d));
    if (next === fontStep) return;
    fontStep = next;
    writeView(fontStep, wrapOn);
    applyView();
  };
  smallerBtn.addEventListener('click', () => stepFont(-1));
  biggerBtn.addEventListener('click', () => stepFont(1));
  wrapBtn.addEventListener('click', () => {
    wrapOn = !wrapOn;
    writeView(fontStep, wrapOn);
    applyView();
  });

  function paintEmptyB(message: string) {
    fileBody.textContent = '';
    const empty = h('div', 'cyc-fx-empty');
    empty.textContent = message;
    fileBody.append(empty);
    titleB.textContent = 'No file';
    langB.textContent = '';
    langB.classList.add('cyc-fx-hidden');
    crumbB.textContent = '';
    copyBtn.disabled = true;
    footBLeft.textContent = '';
    footBRight.textContent = '';
    railB.querySelector('.cyc-fx-rail-label')!.textContent = 'No file';
    hasCode = false;
    applyView();
  }

  function paintFile(name: string, text: string, marks: DiffMark[]): (m: DiffMark[]) => void {
    fileBody.textContent = '';
    const lines = text.split('\n');

    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

    const wrap = h('pre', 'cyc-fx-code-wrap cyc-fx-code');

    wrap.style.setProperty('--fx-num-w', `${String(lines.length).length}ch`);

    const kinds: string[] = [];
    let glines: HTMLElement[] = [];

    const draw = (code: string[]) => {
      let html = '';
      for (let i = 0; i < code.length; i++) {
        const k = kinds[i];
        html +=
          '<div class="cyc-fx-line"><span class="cyc-fx-num">' +
          (i + 1) +
          '</span><span class="cyc-fx-gline' +
          (k ? ' cyc-fx-d-' + k : '') +
          '"></span><code class="cyc-fx-ln">' +
          code[i] +
          '</code></div>';
      }
      wrap.innerHTML = html;
      glines = [...wrap.querySelectorAll<HTMLElement>('.cyc-fx-gline')];
      for (let i = 0; i < glines.length; i++) syncDeletedGutter(glines[i], kinds[i]);
      repaint();
    };

    const setMarks = (next: DiffMark[]) => {
      kinds.length = 0;
      for (const m of next) {
        if (m.line >= 1 && m.line <= lines.length) kinds[m.line - 1] = m.kind;
      }
      for (let i = 0; i < glines.length; i++) {
        glines[i].className = kinds[i] ? `cyc-fx-gline cyc-fx-d-${kinds[i]}` : 'cyc-fx-gline';
        syncDeletedGutter(glines[i], kinds[i]);
      }
      repaint();
    };
    setMarks(marks);

    draw(lines.map(esc));
    fileBody.append(wrap);

    const lang = prismLanguage(name);
    if (lang && colourable(text, lines.length)) {
      const stamp = ++paintSeq;
      whenReady(renderSyntax(text, lang), (html) => {
        if (!html || stamp !== paintSeq) return;
        const split = splitHighlighted(html, lines.length);
        if (split) draw(split);
      });
    } else {
      ++paintSeq;
    }

    hasCode = true;
    applyView();
    return setMarks;
  }

  async function openInB(path: string, name: string) {
    openPath = path;
    selected = path;
    if (!openTabs.some((t) => t.path === path)) openTabs.push({path, name});
    renderTabs();
    renderTree();
    titleB.textContent = name;
    const lang = prismLanguage(name);
    langB.textContent = lang ? lang.toUpperCase() : '';
    langB.classList.toggle('cyc-fx-hidden', !lang);
    crumbB.textContent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : rootName;
    railB.querySelector('.cyc-fx-rail-label')!.textContent = name;
    fileBody.textContent = '';
    const opening = h('div', 'cyc-fx-empty');
    opening.textContent = 'Opening…';
    fileBody.append(opening);
    copyBtn.disabled = true;
    hasCode = false;
    applyView();
    footBLeft.textContent = '';
    footBRight.textContent = '';

    if (!pane.isWide()) pane.showSide('b');

    const a = guard();
    const r = await fsRead(sessionId, path, a.signal);
    aborts.delete(a);
    if (openViewer !== close || openPath !== path) return;
    if (failed(r)) {
      paintEmptyB(r.error);
      titleB.textContent = name;
      return;
    }
    if (r.kind === 'image') {
      fileBody.textContent = '';
      const img = h('img', 'cyc-fx-img') as HTMLImageElement;
      img.src = await fsRaw(sessionId, path);
      img.alt = name;
      fileBody.append(img);
      openText = '';
      copyBtn.disabled = true;
      hasCode = false;
      applyView();
      footBLeft.textContent = `${fmtBytes(r.size)} · ${fmtDate(r.mtime)}`;
      footBRight.textContent = 'Image';
      return;
    }
    if (r.kind === 'binary') {
      paintEmptyB(`${name} is a binary file (${fmtBytes(r.size)}) and is not shown.`);
      titleB.textContent = name;
      footBLeft.textContent = `${fmtBytes(r.size)} · ${fmtDate(r.mtime)}`;
      footBRight.textContent = 'Binary';
      return;
    }

    openText = r.text;
    copyBtn.disabled = false;
    const setMarks = paintFile(name, r.text, []);
    footBLeft.textContent = `${fmtBytes(r.size)} · ${r.lines} line${r.lines === 1 ? '' : 's'} · ${fmtDate(r.mtime)}`;

    const plain = prismLanguage(name) && !colourable(r.text, r.lines) ? 'Plain · ' : '';
    footBRight.textContent = `${r.truncated ? 'Truncated · ' : ''}${plain}UTF-8`;
    footBRight.classList.toggle('cyc-fx-warn', r.truncated);
    repaint();

    const d = await fsDiff(sessionId, path, a.signal);
    if (openViewer !== close || openPath !== path) return;
    if (d.ok && d.repo && d.marks.length) {
      setMarks(d.marks);
      const parts: string[] = [];
      if (d.added) parts.push(`+${d.added}`);
      if (d.modified) parts.push(`~${d.modified}`);
      if (d.deleted) parts.push(`-${d.deleted}`);
      footBRight.textContent = `${parts.join(' ')} · ${footBRight.textContent}`;
    }
  }

  let strip: {x: number; y: number; left: number; axis: '' | 'x' | 'y'} | null = null;
  tabsEl.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      strip = {x: e.touches[0].clientX, y: e.touches[0].clientY, left: tabsEl.scrollLeft, axis: ''};
    },
    {passive: true}
  );
  tabsEl.addEventListener(
    'touchmove',
    (e) => {
      if (!strip || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - strip.x;
      const dy = e.touches[0].clientY - strip.y;
      if (!strip.axis) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        strip.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (strip.axis !== 'x') return;
      e.preventDefault();
      tabsEl.scrollLeft = strip.left - dx;
    },
    {passive: false}
  );
  const endStrip = () => {
    strip = null;
  };
  tabsEl.addEventListener('touchend', endStrip, {passive: true});
  tabsEl.addEventListener('touchcancel', endStrip, {passive: true});

  let tabDown: {x: number; y: number; path: string} | null = null;
  tabsEl.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.cyc-fx-tab');
    tabDown = el ? {x: e.clientX, y: e.clientY, path: el.dataset.path ?? ''} : null;
  });
  tabsEl.addEventListener('pointerup', (e) => {
    const down = tabDown;
    tabDown = null;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.cyc-fx-tab');
    const path = el?.dataset.path ?? '';
    if (!down || !path || path !== down.path) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP) return;
    if ((e.target as HTMLElement).closest('.cyc-fx-tab-x')) {
      closeTab(path);
      return;
    }
    if (path === openPath) return;
    const t = openTabs.find((x) => x.path === path);
    if (t) void openInB(t.path, t.name);
  });

  tree.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.cyc-fx-row');
    if (!row) return;
    const path = row.dataset.path ?? '';
    const dir = row.dataset.dir === '1';
    selected = path;
    if (dir) {
      void toggleDir(path);
      paintFootA();
      renderTree();
      return;
    }

    if (path === openPath) {
      renderTree();
      if (!pane.isWide()) pane.showSide('b');
      return;
    }
    void openInB(path, path.split('/').pop() ?? path);
  });

  copyBtn.addEventListener('click', async () => {
    if (!openText) return;
    toast((await copyText(openText)) ? 'Copied' : 'Copy failed');
  });

  const close = () => {
    if (openViewer !== close) return;
    openViewer = null;
    abortAll();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    for (const fn of cleanups) fn();
    overlay.remove();
    onClose?.();
  };
  openViewer = close;

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onPop = () => close();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', onPop);
  back.addEventListener('click', close);

  cleanups.push(() => pane.destroy());
  cleanups.push(fxPaint.destroy);

  (document.getElementById('cyc-stage') ?? document.body).append(overlay);

  titleA.textContent = sessionName;
  crumbA.textContent = 'Loading…';
  paintEmptyB(EMPTY_B);

  renderTabs();
  pane.restoreSplit();

  void (async () => {
    if (!(await loadDir(''))) {
      crumbA.textContent = 'could not read the session directory';
      return;
    }
    titleA.textContent = rootName;
    railA.querySelector('.cyc-fx-rail-label')!.textContent = rootName;

    const home = '/Users/';
    const parent = root.slice(0, root.lastIndexOf('/'));
    const shown = parent.startsWith(home)
      ? '~ / ' + parent.split('/').slice(3).join(' / ')
      : parent.split('/').filter(Boolean).join(' / ');
    crumbA.textContent = shown;
    renderTree();

    const a = guard();
    const gs = await fsGit(sessionId, a.signal);
    aborts.delete(a);
    if (openViewer !== close) return;
    if (gs.ok && gs.repo) {
      git = foldDirs(gs.files);
      if (gs.truncated) gitNote = 'git status too large to show in full';
      renderTree();
    } else if (failed(gs)) {
      gitNote = `git: ${gs.error}`;
      paintFootA();
    }
  })();
}
