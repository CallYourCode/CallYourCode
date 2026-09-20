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
  gitPane,
  gitPatch,
  gitShow,
  gitBranches,
  gitRefLog,
  failed,
  type GitPaneState,
  type GitRow,
  type GitCommit,
  type GitPatch,
  type GitBranch,
  type CompareAgainst,
  type ChangeWhat
} from './gitData';
import {openChangeViewer, changeOpen} from './changeViewer';
import {renderSyntax} from '@/features/code/languages';
const whenReady = <T, R>(value: T | Promise<T>, fn: (v: T) => R) =>
  value instanceof Promise ? value.then(fn) : fn(value as T);

import {createSplitPane, TAP_SLOP} from './splitPane';
import {
  gtTheme,
  gtFx,
  gtHoverBtn,
  gtHoverBrow,
  gtHoverRow,
  gtHoverBack,
  gtHoverVbtn,
  gtHoverReview,
  gtForkDim,
  createGtPaint,
  diffRowStyleAttr,
  diffSignStyleAttr,
  diffLnStyleAttr
} from './gitPaint';
import {
  GT_ROOT,
  GT_REFRESH,
  GT_LIST_SCROLL,
  GT_LIST,
  GT_BRANCH,
  GT_BRANCH_GAP,
  GT_BRANCH_NAME,
  GT_TRACK,
  GT_AB,
  GT_BRANCH_PICK,
  GT_CARET,
  GT_VIEWTAG,
  GT_COMPARES,
  GT_CMP,
  GT_BRANCHES,
  GT_BROW,
  GT_BROW_NAME,
  GT_BROW_UP,
  GT_BCUR,
  GT_SEC,
  GT_SEC_RIGHT,
  GT_REVIEW,
  GT_REVIEW_B,
  GT_NONE,
  GT_ROW,
  GT_LABEL,
  GT_NAME,
  GT_DIR,
  GT_FROM,
  GT_ACT,
  GT_REFS,
  GT_WHEN,
  GT_SHA
} from './gitChrome';

const SPLIT_TABLET = 0.42;
const SPLIT_LAPTOP = 0.32;

const SPLIT_KEY = 'cyc-gt-split';

const ROWS_MAX = 800;

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
  U: 'untracked',
  C: 'conflicted',
  I: 'ignored'
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ago(seconds: number): string {
  if (!seconds) return '';
  const d = Math.round(Date.now() / 1000) - seconds;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d`;
  const t = new Date(seconds * 1000);
  return `${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

type Showing =
  | {kind: 'file'; path: string; side: 'staged' | 'unstaged'; name: string}
  | {kind: 'commit'; sha: string; subject: string; short: string; by: string};

let openViewer: (() => void) | null = null;

export function openGitViewer(sessionId: string, sessionName: string, onClose?: () => void) {
  openViewer?.();

  const overlay = h('div', `cyc-fx cyc-gt ${GT_ROOT}`);

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
    railLabelB: 'No diff',
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

  const refreshBtn = makeIconButton('replace', `cyc-gt-refresh ${GT_REFRESH}`, false, false);
  refreshBtn.title = 'Refresh';
  refreshBtn.setAttribute('aria-label', 'Refresh');
  headA.append(back, headATitles, refreshBtn);

  const listScroll = h('div', `cyc-fx-scroll cyc-gt-list-scroll ${GT_LIST_SCROLL}`);
  const list = h('div', `cyc-gt-list ${GT_LIST}`);
  listScroll.append(list);

  const footA = h('div', 'cyc-fx-foot');
  const footALeft = h('div', 'cyc-fx-foot-left');
  const footARight = h('div', 'cyc-fx-foot-right');
  footA.append(footALeft, footARight);
  paneA.append(headA, listScroll, footA);

  const headB = h('div', 'cyc-fx-head');
  const headBTitles = h('div', 'cyc-fx-head-titles');
  const titleB = h('div', 'cyc-fx-title');
  const langB = h('span', 'cyc-fx-lang');
  const crumbB = h('div', 'cyc-fx-crumb');
  const titleBRow = h('div', 'cyc-fx-title-row');
  titleBRow.append(titleB, langB);
  headBTitles.append(titleBRow, crumbB);
  const copyBtn = makeIconButton('copy', 'cyc-fx-copy', false, false);
  copyBtn.title = 'Copy diff';
  copyBtn.setAttribute('aria-label', 'Copy diff');
  copyBtn.disabled = true;

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

  const reviewBtn = h(
    'button',
    `cyc-gt-review cyc-gt-review-b ${GT_REVIEW_B} cyc-fx-hidden ${gtHoverReview(dark)}`
  );
  reviewBtn.style.border = `1px solid ${gt.inputBorder}`;
  reviewBtn.textContent = 'Review';
  reviewBtn.title = 'Read this commit file by file';
  headB.append(headBTitles, reviewBtn, viewBar, copyBtn);

  const diffScroll = h('div', 'cyc-fx-scroll cyc-fx-file-scroll');
  const diffBody = h('div', 'cyc-fx-file');
  diffScroll.append(diffBody);

  const footB = h('div', 'cyc-fx-foot');
  const footBLeft = h('div', 'cyc-fx-foot-left');
  const footBRight = h('div', 'cyc-fx-foot-right');
  footB.append(footBLeft, footBRight);
  paneB.append(headB, diffScroll, footB);

  let state: GitPaneState | null = null;

  let paneNote = 'Loading…';

  let noRepo = false;

  let paneErr = '';
  let showing: Showing | null = null;
  let diffText = '';

  let branches: GitBranch[] | null = null;
  let branchesError = '';
  let defaultBranch = '';
  let picking = false;
  let viewingRef = '';
  let refLog: GitCommit[] | null = null;
  let refLogError = '';
  const viewPrefs = readView();
  let fontStep = viewPrefs.step;
  let wrapOn = viewPrefs.wrap;
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
  const alive = () => openViewer === close;

  const noneEl = (text: string, warn = false): HTMLElement => {
    const el = h('div', warn ? `cyc-gt-none ${GT_NONE} cyc-fx-warn` : `cyc-gt-none ${GT_NONE}`);
    el.textContent = text;
    return el;
  };

  const sectionHead = (text: string, right = '', review?: ChangeWhat) => {
    const el = h('div', `cyc-gt-sec ${GT_SEC}`);
    const t = h('span', 'cyc-gt-sec-name');
    t.textContent = text;
    el.append(t);
    if (review) {
      const b = h('button', `cyc-gt-review ${GT_REVIEW} ${gtHoverReview(dark)}`);
      b.style.border = `1px solid ${gt.inputBorder}`;
      b.textContent = 'Review';
      b.dataset.what = review;
      b.title =
        review === 'staged'
          ? 'Read everything staged as one change'
          : 'Read everything not staged as one change';
      el.append(b);
    }
    if (right) {
      const r = h('span', `cyc-gt-sec-right ${GT_SEC_RIGHT}`);
      r.textContent = right;
      el.append(r);
    }
    return el;
  };

  function fileRow(r: GitRow, side: 'staged' | 'unstaged'): HTMLElement {
    const el = h('div', `cyc-gt-row ${GT_ROW} ${gtHoverRow(dark)}`);
    el.dataset.path = r.path;
    el.dataset.side = side;
    if (showing?.kind === 'file' && showing.path === r.path && showing.side === side) {
      el.classList.add('cyc-gt-row-on');
    }

    const name = r.path.split('/').pop() ?? r.path;
    const icon = h('span', 'cyc-fx-icon cyc-fx-icon-seti');
    const paint = fileIcon(name, isDark());
    icon.textContent = paint.char;
    icon.style.color = paint.color;
    el.append(icon);

    const label = h('span', `cyc-gt-label ${GT_LABEL}`);
    const nameEl = h('span', `cyc-gt-name ${GT_NAME} cyc-fx-g${r.code}`);
    nameEl.textContent = name;
    label.append(nameEl);

    if (r.from) {
      const arrow = h('span', `cyc-gt-from ${GT_FROM}`);
      arrow.textContent = '←';
      label.append(arrow);
    }
    const dir = r.from || (r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '');
    if (dir) {
      const dirEl = h('span', `cyc-gt-dir ${GT_DIR}`);
      dirEl.textContent = dir;
      dirEl.title = dir;
      label.append(dirEl);
    }
    el.append(label);

    if (GIT_LABEL[r.code]) {
      const mark = h('span', `cyc-fx-gmark cyc-fx-g${r.code}`);
      mark.textContent = GIT_LABEL[r.code];
      mark.title = GIT_WORD[r.code] ?? '';
      el.append(mark);
    }

    if (r.outside) {
      const why = h('span', `cyc-gt-act ${GT_ACT} cyc-gt-act-off hover:brightness-[1.15]`);
      why.textContent = '·';
      why.title = "Outside this session's directory";
      el.append(why);
    }
    return el;
  }

  function commitRow(c: GitCommit): HTMLElement {
    const el = h('div', `cyc-gt-row ${GT_ROW} cyc-gt-crow ${gtHoverRow(dark)}`);
    el.dataset.sha = c.sha;
    if (showing?.kind === 'commit' && showing.sha === c.sha) el.classList.add('cyc-gt-row-on');
    const sha = h('span', `cyc-gt-sha ${GT_SHA}`);
    sha.textContent = c.short;

    const label = h('span', `cyc-gt-label ${GT_LABEL} cyc-gt-clabel`);
    const subject = h('span', `cyc-gt-name ${GT_NAME}`);
    subject.textContent = c.subject || '(no message)';
    subject.title = `${c.subject}\n${c.author}`;
    label.append(subject);
    el.append(sha, label);

    if (c.refs) {
      const refs = h('span', `cyc-gt-refs ${GT_REFS}`);
      refs.style.background = gt.btn;
      refs.textContent = c.refs.replace('HEAD -> ', '');
      el.append(refs);
    }
    const when = h('span', `cyc-gt-when ${GT_WHEN}`);
    when.textContent = ago(c.when);
    el.append(when);
    return el;
  }

  function renderList() {
    list.textContent = '';
    if (!state) {
      const empty = h('div', 'cyc-fx-empty');
      empty.textContent = paneNote;
      list.append(empty);
      paintHeadA();
      paintFootA();
      paint.repaint();
      return;
    }

    const info = viewedBranch();
    const shownName = viewingRef || state.branch || `detached at ${state.detached || '?'}`;
    const card = h(
      'button',
      `cyc-gt-branch ${GT_BRANCH} ${GT_BRANCH_GAP} cyc-gt-branch-pick ${GT_BRANCH_PICK} hover:brightness-[1.08]`
    );
    card.style.background = gt.card;
    card.setAttribute('aria-expanded', picking ? 'true' : 'false');
    card.title = 'Switch which branch this pane shows';
    const bname = h(
      'span',
      `cyc-gt-branch-name ${GT_BRANCH_NAME} before:content-['⑂_'] ${gtForkDim(dark)}`
    );
    bname.textContent = shownName;
    if (!state.branch && !viewingRef) bname.classList.add('cyc-gt-warn');
    card.append(bname);

    if (viewingRef && viewingRef !== state.branch) {
      const tag = h('span', `cyc-gt-viewtag ${GT_VIEWTAG}`);
      tag.style.background = gt.btn;
      tag.textContent = 'viewing';
      tag.title = `Showing ${viewingRef}'s commits. The changes below are still ${state.branch || 'the checked-out branch'}.`;
      card.append(tag);
    }
    const upstream = info ? info.upstream : state.upstream;
    const trackEl = h('span', `cyc-gt-track ${GT_TRACK}`);
    trackEl.textContent = upstream || 'no upstream';
    if (!upstream) trackEl.classList.add('cyc-gt-dim');
    card.append(trackEl);
    const ahead = info ? info.ahead : state.ahead;
    const behind = info ? info.behind : state.behind;
    if (ahead || behind) {
      const ab = h('span', `cyc-gt-ab ${GT_AB}`);
      ab.style.background = gt.btn;
      ab.textContent = `${ahead ? `↑${ahead}` : ''}${behind ? ` ↓${behind}` : ''}`.trim();
      ab.title = `${ahead} ahead, ${behind} behind ${upstream || 'the remote'}`;
      card.append(ab);
    }
    const caret = h('span', `cyc-gt-caret ${GT_CARET}`);
    caret.textContent = picking ? '▴' : '▾';
    card.append(caret);
    list.append(card);

    if (picking) list.append(branchList());

    const cmpRef = viewingRef || state.branch;
    if (cmpRef && defaultBranch && cmpRef !== defaultBranch) {
      const bar = h('div', `cyc-gt-compares ${GT_COMPARES}`);
      const mk = (label: string, against: CompareAgainst, title: string) => {
        const b = h('button', `cyc-gt-cmp ${GT_CMP} ${gtHoverBtn(dark)}`);
        b.style.border = `1px solid ${gt.inputBorder}`;
        b.textContent = label;
        b.dataset.against = against;
        b.title = title;
        bar.append(b);
      };
      mk('Since fork', 'mergebase', `What ${cmpRef} added since it forked from ${defaultBranch}`);
      mk(`vs ${defaultBranch}`, 'main', `${cmpRef} against the tip of ${defaultBranch}`);
      list.append(bar);
    }

    const cut = (rows: GitRow[]) => (rows.length > ROWS_MAX ? rows.slice(0, ROWS_MAX) : rows);
    const say = (rows: GitRow[]) =>
      rows.length > ROWS_MAX ? `${ROWS_MAX} of ${rows.length}` : String(rows.length);

    list.append(
      sectionHead('Staged changes', say(state.staged), state.staged.length ? 'staged' : undefined)
    );
    if (!state.staged.length) {
      list.append(noneEl('Nothing staged.'));
    } else {
      for (const r of cut(state.staged)) list.append(fileRow(r, 'staged'));
    }

    list.append(
      sectionHead('Changes', say(state.unstaged), state.unstaged.length ? 'unstaged' : undefined)
    );
    if (!state.unstaged.length) {
      list.append(noneEl('Nothing changed.'));
    } else {
      for (const r of cut(state.unstaged)) list.append(fileRow(r, 'unstaged'));
    }

    const viewing = !!viewingRef && viewingRef !== state.branch;
    const heading = viewing ? `${viewingRef} · commits` : 'Recent commits';
    if (!viewing) {
      list.append(sectionHead(heading, state.log.length ? String(state.log.length) : ''));
      if (state.logError) {
        list.append(noneEl(`git log: ${state.logError}`, true));
      } else if (!state.log.length) {
        list.append(noneEl('No commits yet.'));
      } else {
        for (const c of state.log) list.append(commitRow(c));
      }
    } else {
      list.append(sectionHead(heading, refLog ? String(refLog.length) : ''));
      if (refLogError) {
        list.append(noneEl(`git log: ${refLogError}`, true));
      } else if (!refLog) {
        list.append(noneEl('Reading this branch…'));
      } else if (!refLog.length) {
        list.append(noneEl('No commits on this branch.'));
      } else {
        for (const c of refLog) list.append(commitRow(c));
      }
    }

    paintHeadA();
    paintFootA();
    paint.repaint();
  }

  function viewedBranch(): GitBranch | null {
    if (!viewingRef || !branches) return null;
    return branches.find((b) => b.name === viewingRef) ?? null;
  }

  function branchList(): HTMLElement {
    const box = h('div', `cyc-gt-branches ${GT_BRANCHES}`);
    box.style.border = `1px solid ${gt.inputBorder}`;
    if (branchesError) {
      box.append(noneEl(branchesError, true));
      return box;
    }
    if (!branches) {
      box.append(noneEl('Reading branches…'));
      return box;
    }
    if (!branches.length) {
      box.append(noneEl('No branches.'));
      return box;
    }
    for (let i = 0; i < branches.length; i++) {
      const b = branches[i];
      const row = h('button', `cyc-gt-brow ${GT_BROW} ${gtHoverBrow(dark)}`);
      if (i < branches.length - 1) row.style.borderBottom = `1px solid ${gt.inputBorder}`;
      row.dataset.branch = b.name;
      const shown = viewingRef ? b.name === viewingRef : b.current;
      if (shown) {
        row.classList.add('cyc-gt-brow-on');
        row.style.background = gt.card;
      }
      const name = h('span', `cyc-gt-brow-name ${GT_BROW_NAME}`);
      name.textContent = b.name;
      row.append(name);
      if (b.current) {
        const cur = h('span', `cyc-gt-bcur ${GT_BCUR}`);
        cur.style.background = gt.btn;
        cur.textContent = 'current';
        cur.title = 'The checked-out branch';
        row.append(cur);
      }
      if (b.upstream) {
        const up = h('span', `cyc-gt-brow-up ${GT_BROW_UP} cyc-gt-dim`);
        up.textContent = b.upstream;
        row.append(up);
      }
      if (b.ahead || b.behind) {
        const ab = h('span', `cyc-gt-ab ${GT_AB}`);
        ab.style.background = gt.btn;
        ab.textContent = `${b.ahead ? `↑${b.ahead}` : ''}${b.behind ? ` ↓${b.behind}` : ''}`.trim();
        row.append(ab);
      }
      box.append(row);
    }
    return box;
  }

  function paintHeadA() {
    titleA.textContent = state ? state.name : sessionName;

    crumbA.textContent = !state
      ? noRepo
        ? 'Not a git repository'
        : paneNote
      : state.branch
        ? `${state.branch}${state.upstream ? ` · ${state.upstream}` : ''}`
        : `detached at ${state.detached || '?'}`;
    railA.querySelector('.cyc-fx-rail-label')!.textContent = state ? state.name : sessionName;
  }

  function paintFootA() {
    if (!state) {
      footALeft.textContent = noRepo ? '' : paneNote;
      footARight.textContent = '';
      footARight.classList.remove('cyc-fx-warn');
      return;
    }
    const s = state.staged.length;
    const u = state.unstaged.length;
    footALeft.textContent = !s && !u ? 'Working tree clean' : `${s} staged · ${u} changed`;
    footARight.classList.remove('cyc-gt-dim');

    if (paneErr) {
      footARight.textContent = paneErr;
      footARight.classList.remove('cyc-fx-warn');
      footARight.classList.add('cyc-gt-dim');
      return;
    }

    if (state.truncated) {
      footARight.textContent = 'too many changes to list in full';
      footARight.classList.add('cyc-fx-warn');
    } else if (state.cwdInRepo) {
      footARight.textContent = `session is in ${state.cwdInRepo}/`;
      footARight.classList.remove('cyc-fx-warn');
    } else {
      footARight.textContent = '';
      footARight.classList.remove('cyc-fx-warn');
    }
  }

  function applyView() {
    const size = FONT_STEPS[fontStep];
    const wrapEl = diffBody.querySelector<HTMLElement>('.cyc-fx-code-wrap');
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

  reviewBtn.addEventListener('click', () => {
    if (showing?.kind !== 'commit' || !state) return;
    openChangeViewer(sessionId, state.name, {
      what: 'commit',
      sha: showing.sha,
      subject: showing.subject
    });
  });

  function paintEmptyB(message: string) {
    diffBody.textContent = '';
    const empty = h('div', 'cyc-fx-empty');
    empty.textContent = message;
    diffBody.append(empty);
    langB.textContent = '';
    langB.classList.add('cyc-fx-hidden');
    reviewBtn.classList.add('cyc-fx-hidden');
    copyBtn.disabled = true;
    diffText = '';
    hasCode = false;
    applyView();
    // Repaint so the empty message ink and the lang badge's hidden collapse
    // (both painted now) settle even on the load-error / empty exits.
    paint.repaint();
  }

  function paintPatch(p: Extract<GitPatch, {ok: true}>) {
    diffBody.textContent = '';
    const wrap = h('pre', 'cyc-fx-code-wrap cyc-fx-code cyc-gt-diff');
    const widest = p.lines.reduce((m, l) => Math.max(m, l.o, l.n), 0);
    wrap.style.setProperty('--fx-num-w', `${String(widest || 1).length}ch`);

    const KIND: Record<string, string> = {
      add: 'cyc-gt-add',
      del: 'cyc-gt-del',
      hunk: 'cyc-gt-hunk',
      meta: 'cyc-gt-meta',
      ctx: ''
    };
    const SIGN: Record<string, string> = {add: '+', del: '−', ctx: ' ', hunk: '', meta: ''};

    const draw = (bodies: string[]) => {
      let html = '';
      for (let i = 0; i < p.lines.length; i++) {
        const l = p.lines[i];
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
      wrap.innerHTML = html;
      paint.repaint();
    };

    // Attach before the first draw so the paint pass inside draw() reaches the
    // now-live line numbers / prism tokens.
    diffBody.append(wrap);
    draw(p.lines.map((l) => esc(l.t)));

    type Run = {lang: string; idx: number[]};
    const runs: Run[] = [];
    let cur: Run | null = null;
    let plain = false;
    for (let i = 0; i < p.lines.length; i++) {
      const l = p.lines[i];
      if (l.k === 'meta' && l.t.startsWith('diff --git ')) {
        const b = / b\/(.+)$/.exec(l.t);
        cur = {lang: b ? (prismLanguage(b[1]) ?? '') : '', idx: []};
        runs.push(cur);
        continue;
      }
      if (l.k !== 'add' && l.k !== 'del' && l.k !== 'ctx') continue;

      if (!cur) {
        cur = {lang: showing?.kind === 'file' ? (prismLanguage(showing.name) ?? '') : '', idx: []};
        runs.push(cur);
      }
      cur.idx.push(i);
    }

    const stamp = ++paintSeq;
    const bodies = p.lines.map((l) => esc(l.t));
    let pending = 0;
    for (const run of runs) {
      if (!run.lang || !run.idx.length) continue;
      const text = run.idx.map((i) => p.lines[i].t).join('\n');
      if (!colourable(text, run.idx.length)) {
        plain = true;
        continue;
      }
      pending++;
      whenReady(renderSyntax(text, run.lang), (html) => {
        pending--;
        if (!html || stamp !== paintSeq || !alive()) return;
        const split = splitHighlighted(html, run.idx.length);
        if (!split) return;
        for (let k = 0; k < run.idx.length; k++) bodies[run.idx[k]] = split[k];
        if (!pending) draw(bodies);
      });
    }
    hasCode = true;
    applyView();
    return plain;
  }

  async function openDiff(what: Showing) {
    showing = what;
    renderList();
    titleB.textContent = what.kind === 'file' ? what.name : what.subject || what.short;
    const lang = what.kind === 'file' ? prismLanguage(what.name) : '';
    langB.textContent = lang ? lang.toUpperCase() : '';
    langB.classList.toggle('cyc-fx-hidden', !lang);
    reviewBtn.classList.toggle('cyc-fx-hidden', what.kind !== 'commit');

    crumbB.textContent =
      what.kind === 'file'
        ? `${what.side === 'staged' ? 'staged' : 'not staged'} · ${what.path}`
        : `${what.short} · ${what.by}`;
    railB.querySelector('.cyc-fx-rail-label')!.textContent =
      what.kind === 'file' ? what.name : what.short;
    diffBody.textContent = '';
    const opening = h('div', 'cyc-fx-empty');
    opening.textContent = 'Reading the diff…';
    diffBody.append(opening);
    copyBtn.disabled = true;
    hasCode = false;
    applyView();
    // Settle the lang badge collapse and the loading-placeholder ink before the
    // diff request resolves (both are painted now).
    paint.repaint();
    footBLeft.textContent = '';
    footBRight.textContent = '';
    if (!pane.isWide()) pane.showSide('b');

    const a = guard();
    const r =
      what.kind === 'file'
        ? await gitPatch(sessionId, what.path, what.side, a.signal)
        : await gitShow(sessionId, what.sha, a.signal);
    aborts.delete(a);
    if (!alive() || showing !== what) return;
    if (failed(r)) {
      if (r.error === 'aborted') return;
      paintEmptyB(r.error);
      return;
    }
    if (!r.lines.length) {
      paintEmptyB('No changes on this side. The list may be out of date; pull down Refresh.');
      footBRight.textContent = 'empty';
      return;
    }
    const plain = paintPatch(r);

    diffText = r.lines
      .map((l) =>
        l.k === 'add' ? `+${l.t}` : l.k === 'del' ? `-${l.t}` : l.k === 'ctx' ? ` ${l.t}` : l.t
      )
      .join('\n');
    copyBtn.disabled = false;
    const bits: string[] = [];
    if (r.added) bits.push(`+${r.added}`);
    if (r.deleted) bits.push(`-${r.deleted}`);
    if (r.files > 1) bits.push(`${r.files} files`);
    if (r.binary) bits.push('binary');
    footBLeft.textContent = bits.join(' · ') || 'no line changes';
    footBRight.textContent = `${r.truncated ? 'Truncated · ' : ''}${plain ? 'Plain · ' : ''}${r.lines.length} lines`;
    footBRight.classList.toggle('cyc-fx-warn', r.truncated);
  }

  async function reload() {
    const a = guard();
    const r = await gitPane(sessionId, a.signal);
    aborts.delete(a);
    if (!alive()) return;
    if (failed(r)) {
      if (r.error === 'aborted') return;

      if (state) {
        paneErr = `git: ${r.error}`;
        renderList();
        return;
      }
      paneNote = `git: ${r.error}`;
      noRepo = false;
      renderList();
      return;
    }
    if (!r.repo) {
      state = null;
      paneErr = '';
      paneNote = "This session's directory is not in a git repository.";
      noRepo = true;
      if (!showing) paintEmptyB('Not a git repository.');
      renderList();
      return;
    }
    if (noRepo) {
      noRepo = false;
      if (!showing) paintEmptyB('Pick a file or a commit on the left.');
    }
    state = r;
    paneNote = '';
    paneErr = '';
    renderList();
  }

  async function loadBranches() {
    if (branches || !state) return;
    const a = guard();
    const r = await gitBranches(sessionId, a.signal);
    aborts.delete(a);
    if (!alive()) return;
    if (failed(r)) {
      if (r.error === 'aborted') return;
      branchesError = `branches: ${r.error}`;
      renderList();
      return;
    }
    if (!r.repo) {
      branchesError = 'not a git repository';
      renderList();
      return;
    }
    branches = r.branches;
    defaultBranch = r.defaultBranch;
    branchesError = '';
    renderList();
  }

  async function loadRefLog(ref: string) {
    refLog = null;
    refLogError = '';
    renderList();
    const a = guard();
    const r = await gitRefLog(sessionId, ref, a.signal);
    aborts.delete(a);
    if (!alive() || viewingRef !== ref) return;
    if (failed(r)) {
      if (r.error === 'aborted') return;
      refLogError = r.error;
      renderList();
      return;
    }
    refLog = r.log;
    renderList();
  }

  let down: {x: number; y: number; key: string} | null = null;
  const keyOf = (el: HTMLElement) => el.dataset.sha ?? `${el.dataset.side}:${el.dataset.path}`;

  list.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.cyc-gt-row');
    down = el ? {x: e.clientX, y: e.clientY, key: keyOf(el)} : null;
  });

  list.addEventListener('pointerup', (e) => {
    const start = down;
    down = null;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.cyc-gt-row');
    if (!el || !start || keyOf(el) !== start.key) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) return;
    if (!state) return;

    const path = el.dataset.path ?? '';
    const sha = el.dataset.sha;
    if (sha) {
      const c = (viewingRef && refLog ? refLog : state.log).find((x) => x.sha === sha);
      if (c)
        void openDiff({
          kind: 'commit',
          sha: c.sha,
          subject: c.subject,
          short: c.short,
          by: c.author
        });
      return;
    }
    if (!path) return;
    const rowSide = el.dataset.side === 'staged' ? 'staged' : 'unstaged';
    void openDiff({kind: 'file', path, side: rowSide, name: path.split('/').pop() ?? path});
  });

  list.addEventListener('click', (e) => {
    if (!state) return;
    const t = e.target as HTMLElement;

    const cmp = t.closest<HTMLElement>('.cyc-gt-cmp');
    if (cmp) {
      const against: CompareAgainst = cmp.dataset.against === 'main' ? 'main' : 'mergebase';
      const ref = viewingRef || state.branch;
      if (!ref) {
        toast('No branch to compare');
        return;
      }
      const subject =
        against === 'main' ? `${ref} vs ${defaultBranch}` : `${ref} since ${defaultBranch}`;
      openChangeViewer(sessionId, state.name, {what: 'compare', sha: '', subject, ref, against});
      return;
    }

    const brow = t.closest<HTMLElement>('.cyc-gt-brow');
    if (brow) {
      const chosen = brow.dataset.branch ?? '';
      picking = false;
      if (!chosen || chosen === state.branch) {
        viewingRef = '';
        refLog = null;
        refLogError = '';
        renderList();
      } else {
        viewingRef = chosen;
        void loadRefLog(chosen);
      }
      return;
    }

    if (t.closest('.cyc-gt-branch-pick')) {
      picking = !picking;
      renderList();
      if (picking) void loadBranches();
      return;
    }

    const review = t.closest<HTMLElement>('.cyc-gt-review');
    if (review) {
      const what = review.dataset.what === 'staged' ? 'staged' : 'unstaged';
      openChangeViewer(sessionId, state.name, {what, sha: '', subject: ''});
    }
  });

  refreshBtn.addEventListener('click', () => {
    footARight.textContent = 'Refreshing…';

    branches = null;
    branchesError = '';
    viewingRef = '';
    refLog = null;
    refLogError = '';
    picking = false;
    void reload().then(() => {
      if (alive()) void loadBranches();
    });
  });

  copyBtn.addEventListener('click', async () => {
    if (!diffText) return;
    toast((await copyText(diffText)) ? 'Copied' : 'Copy failed');
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

    if (changeOpen()) return;

    if (picking) {
      e.preventDefault();
      e.stopPropagation();
      picking = false;
      renderList();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const onPop = () => {
    if (changeOpen()) return;
    close();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', onPop);
  back.addEventListener('click', close);

  cleanups.push(() => pane.destroy());
  cleanups.push(() => paint.destroy());

  (document.getElementById('cyc-stage') ?? document.body).append(overlay);

  paintEmptyB('Pick a file or a commit on the left.');
  renderList();
  pane.restoreSplit();

  void reload().then(() => {
    if (alive()) void loadBranches();
  });
}
