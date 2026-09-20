import {h} from '@/components/domHelpers';
import {makeIconButton} from '@/components/iconGlyphs';
import {toast} from '@/components/widgets';
import {copyText} from '@/features/media/downloads';
import {fileIcon, prismLanguage} from '@/features/media/icons';
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
import {
  gitChange,
  gitCompare,
  failed,
  type ChangeWhat,
  type ChangeFile,
  type GitChange,
  type GitCommit,
  type CompareAgainst
} from './gitData';
import {renderSyntax} from '@/features/code/languages';
const whenReady = <T, R>(value: T | Promise<T>, fn: (v: T) => R) =>
  value instanceof Promise ? value.then(fn) : fn(value as T);

import {createSplitPane, TAP_SLOP} from './splitPane';
import {
  gtTheme,
  gtFx,
  gtPlus,
  gtMinus,
  gtHoverRow,
  gtHoverBack,
  gtHoverVbtn,
  gtHoverStep,
  gtForkDim,
  createGtPaint,
  diffRowStyleAttr,
  diffSignStyleAttr,
  diffLnStyleAttr
} from './gitPaint';
import {
  GT_ROOT,
  GT_LIST_SCROLL,
  GT_LIST,
  CX_STEP,
  CX_STEPBTN,
  CX_STEPAT,
  CX_DOC,
  GT_BRANCH,
  CX_SUM_GAP,
  GT_BRANCH_NAME,
  GT_TRACK,
  CX_TALLY,
  CX_CAP,
  GT_SEC,
  GT_SEC_RIGHT,
  GT_NONE,
  GT_ROW,
  GT_LABEL,
  GT_NAME,
  GT_FROM,
  GT_DIR,
  CX_SKIP,
  GT_WHEN,
  GT_SHA,
  CX_WHAT,
  CX_FPATH,
  CX_FILE,
  CX_FHEAD,
  CX_NODIFF
} from './gitChrome';

const SPLIT_TABLET = 0.38;
const SPLIT_LAPTOP = 0.28;
const SPLIT_KEY = 'cyc-cx-split';

const COLOUR_MARGIN = 800;

const isDark = () => document.documentElement.dataset.theme === 'dark';

const GIT_LABEL: Record<string, string> = {
  M: 'M',
  A: 'A',
  D: 'D',
  R: 'R',
  U: 'U',
  C: '!',
  I: ''
};
const GIT_WORD: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  U: 'new file',
  C: 'conflicted',
  I: 'ignored'
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function when(seconds: number): string {
  if (!seconds) return '';
  const t = new Date(seconds * 1000);
  return (
    `${t.getDate()} ${MONTHS[t.getMonth()]} ${String(t.getHours()).padStart(2, '0')}:` +
    String(t.getMinutes()).padStart(2, '0')
  );
}

type ChangeRef = {
  what: ChangeWhat | 'compare';
  sha: string;
  subject: string;
  ref?: string;
  against?: CompareAgainst;
};

let openViewer: (() => void) | null = null;

export function changeOpen(): boolean {
  return openViewer !== null;
}

export function openChangeViewer(sessionId: string, sessionName: string, ref: ChangeRef) {
  openViewer?.();

  const overlay = h('div', `cyc-fx cyc-gt cyc-cx ${GT_ROOT}`);

  // The git page fixes its theme at boot; resolve the git-owned literal paint
  // once (see gitPaint.ts).
  const dark = isDark();
  const gt = gtTheme(dark);
  const fx = gtFx(dark);
  const paint = createGtPaint(overlay, dark);

  const pane = createSplitPane(overlay, {
    storageKey: SPLIT_KEY,
    splitTablet: SPLIT_TABLET,
    splitLaptop: SPLIT_LAPTOP,
    railLabelA: sessionName,
    railLabelB: 'Diff',
    onLayout: () => paint.repaint()
  });
  const {paneA, paneB, railA, railB} = pane;

  const headA = h('div', 'cyc-fx-head');
  const back = makeIconButton('left', `cyc-fx-back ${gtHoverBack(dark)}`, false, false);
  back.title = 'Back';
  back.setAttribute('aria-label', 'Back');
  const headATitles = h('div', 'cyc-fx-head-titles');
  const titleA = h('div', 'cyc-fx-title');
  const crumbA = h('div', 'cyc-fx-crumb');
  headATitles.append(titleA, crumbA);
  headA.append(back, headATitles);

  const listScroll = h('div', `cyc-fx-scroll cyc-gt-list-scroll ${GT_LIST_SCROLL}`);
  const list = h('div', `cyc-gt-list cyc-cx-list ${GT_LIST}`);
  listScroll.append(list);

  const footA = h('div', 'cyc-fx-foot');
  const footALeft = h('div', 'cyc-fx-foot-left');
  const footARight = h('div', 'cyc-fx-foot-right');
  footA.append(footALeft, footARight);
  paneA.append(headA, listScroll, footA);

  const headB = h('div', 'cyc-fx-head');
  const headBTitles = h('div', 'cyc-fx-head-titles');
  const titleB = h('div', 'cyc-fx-title');
  const crumbB = h('div', 'cyc-fx-crumb');
  headBTitles.append(titleB, crumbB);

  const step = h('div', `cyc-cx-step ${CX_STEP}`);
  const prevBtn = h('button', `cyc-cx-stepbtn ${CX_STEPBTN} ${gtHoverStep(dark)}`);
  prevBtn.textContent = '‹';
  prevBtn.title = 'Previous file';
  prevBtn.setAttribute('aria-label', 'Previous file');
  const stepAt = h('span', `cyc-cx-stepat ${CX_STEPAT}`);
  const nextBtn = h('button', `cyc-cx-stepbtn ${CX_STEPBTN} ${gtHoverStep(dark)}`);
  nextBtn.textContent = '›';
  nextBtn.title = 'Next file';
  nextBtn.setAttribute('aria-label', 'Next file');
  step.append(prevBtn, stepAt, nextBtn);

  const viewBar = h('div', 'cyc-fx-view');
  const vbtn = (label: string, title: string) => {
    const b = h('button', `cyc-fx-vbtn ${gtHoverVbtn(dark)}`);
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
  const copyBtn = makeIconButton('copy', 'cyc-fx-copy', false, false);
  copyBtn.title = 'Copy this change as text';
  copyBtn.setAttribute('aria-label', 'Copy this change as text');
  copyBtn.disabled = true;
  headB.append(headBTitles, step, viewBar, copyBtn);

  const diffScroll = h('div', 'cyc-fx-scroll cyc-fx-file-scroll');
  const doc = h('div', `cyc-cx-doc ${CX_DOC}`);
  diffScroll.append(doc);

  const footB = h('div', 'cyc-fx-foot');
  const footBLeft = h('div', 'cyc-fx-foot-left');
  const footBRight = h('div', 'cyc-fx-foot-right');
  footB.append(footBLeft, footBRight);
  paneB.append(headB, diffScroll, footB);

  type Loaded = Extract<GitChange, {ok: true}>;
  let change: Loaded | null = null;

  let note = 'Loading…';

  let compareCommits: GitCommit[] = [];
  let compareBase = '';
  let at = 0;
  const sections: HTMLElement[] = [];
  const rows: HTMLElement[] = [];
  const coloured = new Set<number>();
  const viewPrefs = readView();
  let fontStep = viewPrefs.step;
  let wrapOn = viewPrefs.wrap;
  let hasCode = false;
  let plainSomewhere = false;

  const cleanups: Array<() => void> = [];
  const aborts = new Set<AbortController>();
  const alive = () => openViewer === close;

  const title = () =>
    ref.what === 'compare'
      ? ref.subject || 'Compare'
      : ref.what === 'commit'
        ? change?.commit?.subject || ref.subject || 'Commit'
        : ref.what === 'staged'
          ? 'Staged changes'
          : 'Working changes';

  const tally = (added: number, deleted: number) =>
    [added ? `+${added}` : '', deleted ? `−${deleted}` : ''].filter(Boolean).join(' ') ||
    'no line changes';

  function counts(host: HTMLElement, added: number, deleted: number) {
    if (added) {
      const a = h('span', `cyc-cx-plus ${gtPlus(dark)}`);
      a.textContent = `+${added}`;
      host.append(a);
    }
    if (deleted) {
      const d = h('span', `cyc-cx-minus ${gtMinus(dark)}`);
      d.textContent = `−${deleted}`;
      host.append(d);
    }
  }

  const whyNoDiff = (f: ChangeFile) =>
    f.binary
      ? 'Binary file: git has no lines to show.'
      : f.added + f.deleted > 0
        ? `No diff here: this change is over the size sent at once ` +
          `(${f.added + f.deleted} changed lines in this file). Open it on its own in the git pane.`
        : 'Not shown: this change is over the size a phone is handed at once.';

  function renderList() {
    list.textContent = '';
    if (!change) {
      const empty = h('div', 'cyc-fx-empty');
      empty.textContent = note;
      list.append(empty);
      paintHeadA();
      paintFootA();
      paint.repaint();
      return;
    }

    const card = h('div', `cyc-gt-branch ${GT_BRANCH} cyc-cx-sum ${CX_SUM_GAP}`);
    card.style.background = gt.card;
    const what = h(
      'span',
      `cyc-gt-branch-name ${GT_BRANCH_NAME} cyc-cx-what ${CX_WHAT} before:content-['⑂_'] ${gtForkDim(dark)}`
    );
    what.textContent =
      ref.what === 'compare'
        ? compareBase || 'base'
        : ref.what === 'commit'
          ? (change.commit?.short ?? '')
          : ref.what === 'staged'
            ? 'index'
            : 'working tree';
    card.append(what);
    const n = change.files.length;
    const files = h('span', `cyc-gt-track ${GT_TRACK}`);
    files.textContent = `${n} file${n === 1 ? '' : 's'}`;
    card.append(files);
    const tally = h('span', `cyc-cx-tally ${CX_TALLY}`);
    counts(tally, change.added, change.deleted);
    card.append(tally);
    list.append(card);

    const skipped = change.files.filter((f) => f.skipped).length;
    if (change.truncated || skipped) {
      const warn = h('div', `cyc-cx-cap ${CX_CAP}`);
      warn.style.background = gt.card;
      warn.textContent = change.truncated
        ? `${change.fileCount} files changed; the first ${change.files.length} are listed.`
        : `${skipped} of ${n} files are listed without their diff: too big to show here.`;
      list.append(warn);
    }

    if (ref.what === 'compare') {
      const csec = h('div', `cyc-gt-sec ${GT_SEC}`);
      const cname = h('span', 'cyc-gt-sec-name');
      cname.textContent = 'Commits';
      const cright = h('span', `cyc-gt-sec-right ${GT_SEC_RIGHT}`);
      cright.textContent = String(compareCommits.length);
      csec.append(cname, cright);
      list.append(csec);
      if (!compareCommits.length) {
        const none = h('div', `cyc-gt-none ${GT_NONE}`);
        none.textContent = 'No commits ahead of the base.';
        list.append(none);
      } else {
        for (const c of compareCommits) list.append(commitRow(c));
      }
    }

    const sec = h('div', `cyc-gt-sec ${GT_SEC}`);
    const secName = h('span', 'cyc-gt-sec-name');
    secName.textContent = 'Files';
    const secRight = h('span', `cyc-gt-sec-right ${GT_SEC_RIGHT}`);
    secRight.textContent = String(n);
    sec.append(secName, secRight);
    list.append(sec);

    if (!n) {
      const none = h('div', `cyc-gt-none ${GT_NONE}`);
      none.textContent =
        ref.what === 'compare'
          ? 'No files differ from the base.'
          : ref.what === 'staged'
            ? 'Nothing staged.'
            : ref.what === 'unstaged'
              ? 'Nothing changed.'
              : 'This commit changed no files.';
      list.append(none);
    }

    rows.length = 0;
    for (let i = 0; i < change.files.length; i++) {
      const row = fileRow(change.files[i], i);
      rows.push(row);
      list.append(row);
    }
    markAt();
    paintHeadA();
    paintFootA();
  }

  function fileRow(f: ChangeFile, i: number): HTMLElement {
    const el = h('div', `cyc-gt-row ${GT_ROW} cyc-cx-frow ${gtHoverRow(dark)}`);
    el.dataset.i = String(i);
    el.dataset.path = f.path;

    const name = f.path.split('/').pop() ?? f.path;
    const icon = h('span', 'cyc-fx-icon cyc-fx-icon-seti');
    const paint = fileIcon(name, isDark());
    icon.textContent = paint.char;
    icon.style.color = paint.color;
    el.append(icon);

    const label = h('span', `cyc-gt-label ${GT_LABEL}`);
    const nameEl = h('span', `cyc-gt-name ${GT_NAME} cyc-fx-g${f.code}`);
    nameEl.textContent = name;
    label.append(nameEl);

    if (f.from) {
      const arrow = h('span', `cyc-gt-from ${GT_FROM}`);
      arrow.textContent = '←';
      label.append(arrow);
    }
    const dir = f.from || (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '');
    if (dir) {
      const dirEl = h('span', `cyc-gt-dir ${GT_DIR}`);
      dirEl.textContent = dir;
      dirEl.title = dir;
      label.append(dirEl);
    }
    el.append(label);

    const tally = h('span', `cyc-cx-tally ${CX_TALLY}`);
    counts(tally, f.added, f.deleted);
    el.append(tally);

    if (GIT_LABEL[f.code]) {
      const mark = h('span', `cyc-fx-gmark cyc-fx-g${f.code}`);
      mark.textContent = GIT_LABEL[f.code];
      mark.title = GIT_WORD[f.code] ?? '';
      el.append(mark);
    }
    if (f.skipped) {
      const dot = h('span', `cyc-cx-skip ${CX_SKIP}`);
      dot.textContent = '·';
      dot.title = whyNoDiff(f);
      el.append(dot);
    }
    return el;
  }

  function commitRow(c: GitCommit): HTMLElement {
    const el = h('div', `cyc-gt-row ${GT_ROW} cyc-cx-crow ${gtHoverRow(dark)}`);
    el.dataset.sha = c.sha;
    const sha = h('span', `cyc-gt-sha ${GT_SHA}`);
    sha.textContent = c.short;
    const label = h('span', `cyc-gt-label ${GT_LABEL} cyc-gt-clabel`);
    const subject = h('span', `cyc-gt-name ${GT_NAME}`);
    subject.textContent = c.subject || '(no message)';
    subject.title = `${c.subject}\n${c.author}`;
    label.append(subject);
    el.append(sha, label);
    const at = h('span', `cyc-gt-when ${GT_WHEN}`);
    at.textContent = when(c.when);
    el.append(at);
    return el;
  }

  function paintHeadA() {
    titleA.textContent = title();
    crumbA.textContent = !change
      ? note
      : ref.what === 'compare'
        ? `against ${compareBase || 'the base'}`
        : ref.what === 'commit' && change.commit
          ? `${change.commit.short} · ${change.commit.author} · ${when(change.commit.when)}`
          : ref.what === 'staged'
            ? 'what committing now would record'
            : 'what committing now would miss';
    railA.querySelector('.cyc-fx-rail-label')!.textContent = title();
  }

  function paintFootA() {
    if (!change) {
      footALeft.textContent = note;
      footARight.textContent = '';
      footARight.classList.remove('cyc-fx-warn');
      return;
    }
    const n = change.files.length;
    footALeft.textContent = `${n} file${n === 1 ? '' : 's'} · ${tally(change.added, change.deleted)}`;
    const skipped = change.files.filter((f) => f.skipped).length;
    footARight.textContent = change.truncated
      ? `of ${change.fileCount} changed`
      : skipped
        ? `${skipped} without a diff`
        : '';
    footARight.classList.toggle('cyc-fx-warn', change.truncated || skipped > 0);
  }

  function applyView() {
    const size = FONT_STEPS[fontStep];
    for (const el of doc.querySelectorAll<HTMLElement>('.cyc-fx-code-wrap')) {
      el.style.fontSize = `${size}px`;
      el.style.setProperty('--fx-line-h', `${Math.round(size * LINE_RATIO)}px`);
    }
    paneB.classList.toggle('cyc-fx-wrapped', wrapOn);
    wrapBtn.classList.toggle('cyc-fx-vbtn-on', wrapOn);
    wrapBtn.setAttribute('aria-pressed', wrapOn ? 'true' : 'false');
    smallerBtn.disabled = !hasCode || fontStep === 0;
    biggerBtn.disabled = !hasCode || fontStep === FONT_STEPS.length - 1;
    wrapBtn.disabled = !hasCode;
    // The wrap button's pressed (`.cyc-fx-vbtn-on`) style is painted now.
    paint.repaint();
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
    doc.textContent = '';
    sections.length = 0;
    const empty = h('div', 'cyc-fx-empty');
    empty.textContent = message;
    doc.append(empty);
    copyBtn.disabled = true;
    hasCode = false;
    stepAt.textContent = '';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    applyView();
    // Repaint so the empty message ink (painted now) settles on the error exits.
    paint.repaint();
  }

  const KIND: Record<string, string> = {
    add: 'cyc-gt-add',
    del: 'cyc-gt-del',
    hunk: 'cyc-gt-hunk',
    meta: 'cyc-gt-meta',
    ctx: ''
  };
  const SIGN: Record<string, string> = {add: '+', del: '−', ctx: ' ', hunk: '', meta: ''};

  function rowsHtml(f: ChangeFile, bodies: string[]): string {
    let html = '';
    for (let i = 0; i < f.lines.length; i++) {
      const l = f.lines[i];
      const cls = KIND[l.k];
      html +=
        '<div class="cyc-fx-line' +
        (cls ? ' ' + cls : '') +
        '"' +
        diffRowStyleAttr(l.k, gt) +
        '>' +
        '<span class="cyc-fx-num">' +
        (l.o || '') +
        '</span>' +
        '<span class="cyc-fx-num">' +
        (l.n || '') +
        '</span>' +
        '<span class="cyc-gt-sign"' +
        diffSignStyleAttr(l.k, gt) +
        '>' +
        SIGN[l.k] +
        '</span>' +
        '<code class="cyc-fx-ln"' +
        diffLnStyleAttr(l.k, gt, fx.dim) +
        '>' +
        bodies[i] +
        '</code></div>';
    }
    return html;
  }

  function paintChange(c: Loaded) {
    doc.textContent = '';
    sections.length = 0;
    coloured.clear();
    plainSomewhere = false;

    for (let i = 0; i < c.files.length; i++) {
      const f = c.files[i];
      const sec = h('div', `cyc-cx-file ${CX_FILE}`);
      sec.dataset.i = String(i);

      const head = h('div', `cyc-cx-fhead ${CX_FHEAD}`);
      const icon = h('span', 'cyc-fx-icon cyc-fx-icon-seti');
      const paint = fileIcon(f.path.split('/').pop() ?? f.path, isDark());
      icon.textContent = paint.char;
      icon.style.color = paint.color;
      head.append(icon);
      const path = h('span', `cyc-cx-fpath ${CX_FPATH}`);
      path.textContent = f.from ? `${f.from} → ${f.path}` : f.path;
      path.title = path.textContent;
      head.append(path);
      const tally = h('span', `cyc-cx-tally ${CX_TALLY}`);
      counts(tally, f.added, f.deleted);
      head.append(tally);
      if (GIT_LABEL[f.code]) {
        const mark = h('span', `cyc-fx-gmark cyc-fx-g${f.code}`);
        mark.textContent = GIT_LABEL[f.code];
        mark.title = GIT_WORD[f.code] ?? '';
        head.append(mark);
      }
      sec.append(head);

      if (!f.lines.length) {
        const said = h('div', `cyc-cx-nodiff ${CX_NODIFF}`);
        said.textContent = f.skipped || f.binary ? whyNoDiff(f) : 'No line changes in this file.';
        sec.append(said);
      } else {
        const pre = h('pre', 'cyc-fx-code-wrap cyc-fx-code cyc-gt-diff');
        const widest = f.lines.reduce((m, l) => Math.max(m, l.o, l.n), 0);
        pre.style.setProperty('--fx-num-w', `${String(widest || 1).length}ch`);
        pre.innerHTML = rowsHtml(
          f,
          f.lines.map((l) => esc(l.t))
        );
        sec.append(pre);
        if (f.truncated) {
          const cut = h('div', `cyc-cx-nodiff ${CX_NODIFF} cyc-fx-warn`);
          cut.textContent = "This file's diff is longer than what is shown here.";
          sec.append(cut);
        }
      }
      sections.push(sec);
      doc.append(sec);
      colourWatch.observe(sec);
    }

    hasCode = c.files.some((f) => f.lines.length > 0);
    copyBtn.disabled = !hasCode;
    applyView();
    at = 0;
    paintStep();
    paintFootB();
    paint.repaint();
  }

  const colourWatch = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        colourWatch.unobserve(e.target);
        colourFile(Number((e.target as HTMLElement).dataset.i));
      }
    },
    {root: diffScroll, rootMargin: `${COLOUR_MARGIN}px 0px`}
  );
  cleanups.push(() => colourWatch.disconnect());

  function colourFile(i: number) {
    if (!change || coloured.has(i)) return;
    coloured.add(i);
    const f = change.files[i];
    if (!f?.lines.length) return;
    const lang = prismLanguage(f.path);
    if (!lang) return;
    const idx: number[] = [];
    for (let k = 0; k < f.lines.length; k++) {
      const kind = f.lines[k].k;
      if (kind === 'add' || kind === 'del' || kind === 'ctx') idx.push(k);
    }
    if (!idx.length) return;
    const text = idx.map((k) => f.lines[k].t).join('\n');
    if (!colourable(text, idx.length)) {
      plainSomewhere = true;
      paintFootB();
      return;
    }
    whenReady(renderSyntax(text, lang), (html) => {
      if (!html || !alive() || change !== changeAtPaint) return;
      const split = splitHighlighted(html, idx.length);
      if (!split) return;
      const bodies = f.lines.map((l) => esc(l.t));
      for (let k = 0; k < idx.length; k++) bodies[idx[k]] = split[k];
      const pre = sections[i]?.querySelector<HTMLElement>('.cyc-fx-code-wrap');
      if (pre) {
        pre.innerHTML = rowsHtml(f, bodies);
        paint.repaint();
      }
    });
  }

  let changeAtPaint: Loaded | null = null;

  function paintStep() {
    const n = sections.length;
    stepAt.textContent = n ? `${at + 1}/${n}` : '';
    prevBtn.disabled = at <= 0;
    nextBtn.disabled = at >= n - 1;
  }

  function paintFootB() {
    if (!change) {
      footBLeft.textContent = '';
      footBRight.textContent = '';
      return;
    }
    const lines = change.files.reduce((m, f) => m + f.lines.length, 0);
    footBLeft.textContent = `${tally(change.added, change.deleted)} · ${lines} lines`;

    const missing = change.files.filter((f) => f.skipped).length;
    footBRight.textContent = missing
      ? `${missing} file${missing === 1 ? '' : 's'} without a diff`
      : plainSomewhere
        ? 'Plain'
        : '';
    footBRight.classList.toggle('cyc-fx-warn', missing > 0);
  }

  function markAt() {
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('cyc-gt-row-on', i === at);
    paint.repaint();
  }

  function jump(i: number, carry: boolean) {
    const sec = sections[i];
    if (!sec) return;
    at = i;
    diffScroll.scrollTop +=
      sec.getBoundingClientRect().top - diffScroll.getBoundingClientRect().top;
    paintStep();
    markAt();
    if (carry && !pane.isWide()) pane.showSide('b');
  }

  let ticking = false;
  diffScroll.addEventListener(
    'scroll',
    () => {
      if (ticking || !sections.length) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (!alive()) return;
        const top = diffScroll.getBoundingClientRect().top + 1;
        let now = 0;
        for (let i = 0; i < sections.length; i++) {
          if (sections[i].getBoundingClientRect().top <= top) now = i;
          else break;
        }
        if (now === at) return;
        at = now;
        paintStep();
        markAt();
      });
    },
    {passive: true}
  );

  prevBtn.addEventListener('click', () => jump(at - 1, false));
  nextBtn.addEventListener('click', () => jump(at + 1, false));

  let down: {x: number; y: number; i: string} | null = null;
  list.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.cyc-cx-frow');
    down = el ? {x: e.clientX, y: e.clientY, i: el.dataset.i ?? ''} : null;
  });
  list.addEventListener('pointerup', (e) => {
    const start = down;
    down = null;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.cyc-cx-frow');
    if (!el || !start || (el.dataset.i ?? '') !== start.i) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) return;
    jump(Number(el.dataset.i), true);
  });

  async function load() {
    const a = new AbortController();
    aborts.add(a);

    if (ref.what === 'compare') {
      const c = await gitCompare(sessionId, ref.ref ?? '', ref.against ?? 'mergebase', a.signal);
      aborts.delete(a);
      if (!alive()) return;
      if (failed(c)) {
        if (c.error === 'aborted') return;
        change = null;
        note = `git: ${c.error}`;
        renderList();
        paintEmptyB(note);
        return;
      }
      compareCommits = c.commits;
      compareBase = c.base;
      const shown: Loaded = {
        ok: true,
        what: 'commit',
        commit: null,
        files: c.files,
        fileCount: c.fileCount,
        added: c.added,
        deleted: c.deleted,
        truncated: c.truncated
      };
      change = shown;
      changeAtPaint = shown;
      note = '';
      renderList();
      if (!c.files.length) {
        paintEmptyB('No files differ from the base.');
        return;
      }
      paintChange(shown);
      paintHeadB();
      if (!pane.isWide()) pane.showSide('a', false);
      return;
    }
    const r = await gitChange(sessionId, ref.what, ref.sha, a.signal);
    aborts.delete(a);
    if (!alive()) return;
    if (failed(r)) {
      if (r.error === 'aborted') return;
      change = null;
      note = `git: ${r.error}`;
      renderList();
      paintEmptyB(note);
      return;
    }
    change = r;
    changeAtPaint = r;
    note = '';
    renderList();
    if (!r.files.length) {
      paintEmptyB(
        ref.what === 'commit' ? 'This commit changed no files.' : 'Nothing to review here.'
      );
      return;
    }
    paintChange(r);
    paintHeadB();
    if (!pane.isWide()) pane.showSide('a', false);
  }

  function paintHeadB() {
    titleB.textContent = title();
    crumbB.textContent = change
      ? `${change.files.length} file${change.files.length === 1 ? '' : 's'} · ` +
        tally(change.added, change.deleted)
      : '';
    railB.querySelector('.cyc-fx-rail-label')!.textContent = 'Diff';
  }

  copyBtn.addEventListener('click', async () => {
    if (!change) return;

    const text = change.files
      .map((f) => {
        const head = `--- ${f.from ? `${f.from} -> ` : ''}${f.path}`;
        if (!f.lines.length) return `${head}\n${whyNoDiff(f)}`;
        return (
          `${head}\n` +
          f.lines
            .map((l) =>
              l.k === 'add'
                ? `+${l.t}`
                : l.k === 'del'
                  ? `-${l.t}`
                  : l.k === 'ctx'
                    ? ` ${l.t}`
                    : l.t
            )
            .join('\n')
        );
      })
      .join('\n\n');
    toast((await copyText(text)) ? 'Copied' : 'Copy failed');
  });

  const close = () => {
    if (openViewer !== close) return;
    openViewer = null;
    for (const a of aborts) a.abort();
    aborts.clear();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    for (const fn of cleanups) fn();
    overlay.remove();
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
  cleanups.push(() => paint.destroy());

  (document.getElementById('cyc-stage') ?? document.body).append(overlay);

  paintHeadA();
  paintHeadB();
  paintEmptyB('Reading the change…');
  renderList();
  pane.restoreSplit();
  void load();
}
