import {afterEach, beforeEach, describe, expect, test} from 'vitest';

// Git plugin paint coverage for theme, selection, and pointer literals.

import {
  gtFx,
  paintGt,
  createGtPaint,
  gtHoverRow,
  gtHoverBack,
  gtHoverVbtn,
  gtHoverStep,
  gtHoverReview,
  gtForkDim
} from '../plugins/git/gitPaint';
import {openGitViewer} from '../plugins/git/gitViewer';
import {openChangeViewer} from '../plugins/git/changeViewer';

const DAY = gtFx(false);
const NIGHT = gtFx(true);

// jsdom canonicalises colours (hex -> rgb) on read, so compare an element's
// inline style against the same literal normalised through a scratch node.
const norm = (prop: string, value: string): string => {
  const p = document.createElement('div');
  (p.style as unknown as Record<string, string>)[prop] = value;
  return (p.style as unknown as Record<string, string>)[prop];
};
const sty = (el: HTMLElement, prop: string, expected: string) =>
  expect((el.style as unknown as Record<string, string>)[prop]).toBe(norm(prop, expected));

let coarse = false;
// Every coarse MediaQueryList shares one listener registry so a `firePointer()`
// reaches the listener `createGtPaint` registered on its own instance.
const coarseListeners = new Set<() => void>();
const firePointer = () => coarseListeners.forEach((fn) => fn());
const installMatchMedia = () => {
  (window as unknown as {matchMedia: (q: string) => MediaQueryList}).matchMedia = (q: string) => {
    const isCoarse = q.includes('coarse');
    return {
      get matches() {
        return isCoarse ? coarse : false;
      },
      media: q,
      onchange: null,
      addEventListener: (_t: string, fn: () => void) => {
        if (isCoarse) coarseListeners.add(fn);
      },
      removeEventListener: (_t: string, fn: () => void) => {
        if (isCoarse) coarseListeners.delete(fn);
      },
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        if (isCoarse) firePointer();
        return true;
      }
    } as unknown as MediaQueryList;
  };
};

const day = () => {
  document.documentElement.dataset.theme = 'light';
};
const night = () => {
  document.documentElement.dataset.theme = 'dark';
};

function gtRoot(extra = ''): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = `cyc-fx cyc-gt ${extra}`.trim();
  document.body.append(overlay);
  return overlay;
}

const span = (parent: HTMLElement, cls: string): HTMLElement => {
  const el = document.createElement('span');
  el.className = cls;
  parent.append(el);
  return el;
};

beforeEach(() => {
  coarse = false;
  coarseListeners.clear();
  installMatchMedia();
  document.body.innerHTML = '';
  day();
});
afterEach(() => {
  document.body.innerHTML = '';
  day();
  coarse = false;
});

describe('the dim / fg / warn ink (was git-owned color: var(--fx-*))', () => {
  test('every dim-ink role takes the themed dim literal, day and night', () => {
    const overlay = gtRoot();
    const cls = [
      'cyc-gt-refresh',
      'cyc-gt-track',
      'cyc-gt-caret',
      'cyc-gt-viewtag',
      'cyc-gt-brow-up',
      'cyc-gt-bcur',
      'cyc-gt-sec',
      'cyc-gt-review',
      'cyc-gt-none',
      'cyc-gt-act cyc-gt-act-off',
      'cyc-cx-stepat',
      'cyc-cx-nodiff',
      'cyc-gt-from',
      'cyc-gt-refs'
    ].map((c) => span(overlay, c));

    paintGt(overlay, false);
    for (const el of cls) sty(el, 'color', DAY.dim);

    paintGt(overlay, true);
    for (const el of cls) sty(el, 'color', NIGHT.dim);
  });

  test('every fg-ink role takes the themed fg literal', () => {
    const overlay = gtRoot();
    const cls = [
      'cyc-gt-branch-name',
      'cyc-gt-ab',
      'cyc-gt-cmp',
      'cyc-gt-brow',
      'cyc-cx-fpath',
      'cyc-cx-stepbtn'
    ].map((c) => span(overlay, c));

    paintGt(overlay, false);
    for (const el of cls) sty(el, 'color', DAY.fg);

    paintGt(overlay, true);
    for (const el of cls) sty(el, 'color', NIGHT.fg);
  });

  test('the warn roles take the g-modified literal', () => {
    const overlay = gtRoot();
    const warn = span(overlay, 'cyc-gt-warn');
    const cap = span(overlay, 'cyc-cx-cap');
    paintGt(overlay, false);
    sty(warn, 'color', DAY.gModified);
    sty(cap, 'color', DAY.gModified);
    paintGt(overlay, true);
    sty(warn, 'color', NIGHT.gModified);
  });
});

describe('the change-viewer file surfaces (was --fx-side-bg / --fx-tab-border)', () => {
  test('the sticky file head takes the side background and border, the file body the border', () => {
    const overlay = gtRoot();
    const fhead = span(overlay, 'cyc-cx-fhead');
    const file = span(overlay, 'cyc-cx-file');
    paintGt(overlay, false);
    sty(fhead, 'background', DAY.sideBg);
    sty(fhead, 'borderBottomColor', DAY.tabBorder);
    sty(file, 'borderTopColor', DAY.tabBorder);

    paintGt(overlay, true);
    sty(fhead, 'background', NIGHT.sideBg);
    sty(fhead, 'borderBottomColor', NIGHT.tabBorder);
    sty(file, 'borderTopColor', NIGHT.tabBorder);
  });
});

describe('the selected row (was the .cyc-gt-row-on fill + inverse ink)', () => {
  function row(overlay: HTMLElement, on: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = `cyc-gt-row cyc-cx-frow${on ? ' cyc-gt-row-on' : ''}`;
    span(el, 'cyc-gt-name cyc-fx-gM');
    span(el, 'cyc-fx-gmark cyc-fx-gM');
    span(el, 'cyc-cx-plus');
    span(el, 'cyc-cx-minus');
    span(el, 'cyc-gt-dir');
    span(el, 'cyc-gt-sha');
    span(el, 'cyc-gt-when');
    span(el, 'cyc-cx-skip');
    span(el, 'cyc-gt-from');
    span(el, 'cyc-gt-refs');
    overlay.append(el);
    return el;
  }
  const q = (el: HTMLElement, sel: string) => el.querySelector<HTMLElement>(sel)!;

  test('a selected row takes the selection fill, group A/B ink go inverse, from/refs stay dim', () => {
    const overlay = gtRoot();
    const sel = row(overlay, true);
    const plain = row(overlay, false);

    paintGt(overlay, false);
    // selected fill
    sty(sel, 'background', DAY.selBg);
    sty(plain, 'background', '');
    // group A inverts; when not selected the name / mark take their git-status
    // ink (both carry cyc-fx-gM here)
    // and the +/- tallies clear to their own base utility
    for (const s of ['.cyc-gt-name', '.cyc-fx-gmark']) {
      sty(q(sel, s), 'color', DAY.selFg);
      sty(q(plain, s), 'color', DAY.gModified);
    }
    for (const s of ['.cyc-cx-plus', '.cyc-cx-minus']) {
      sty(q(sel, s), 'color', DAY.selFg);
      sty(q(plain, s), 'color', '');
    }
    // group B inverts, then falls back to dim
    for (const s of ['.cyc-gt-dir', '.cyc-gt-sha', '.cyc-gt-when', '.cyc-cx-skip']) {
      sty(q(sel, s), 'color', DAY.selFg);
      sty(q(plain, s), 'color', DAY.dim);
    }
    sty(q(sel, '.cyc-gt-from'), 'color', DAY.dim);
    sty(q(sel, '.cyc-gt-refs'), 'color', DAY.dim);

    night();
    paintGt(overlay, true);
    sty(sel, 'background', NIGHT.selBg);
    sty(q(sel, '.cyc-gt-name'), 'color', NIGHT.selFg);
    sty(q(plain, '.cyc-gt-dir'), 'color', NIGHT.dim);
  });

  test('dropping the on marker clears the fill and returns the ink on the next paint', () => {
    const overlay = gtRoot();
    const el = row(overlay, true);
    paintGt(overlay, false);
    sty(el, 'background', DAY.selBg);
    sty(q(el, '.cyc-gt-name'), 'color', DAY.selFg);

    el.classList.remove('cyc-gt-row-on');
    paintGt(overlay, false);
    sty(el, 'background', '');
    // the name returns to its git-status ink (cyc-fx-gM), the dir to dim
    sty(q(el, '.cyc-gt-name'), 'color', DAY.gModified);
    sty(q(el, '.cyc-gt-dir'), 'color', DAY.dim);
  });
});

describe('coarse pointer control sizes (was @media (pointer: coarse))', () => {
  test('coarse grows the step / action buttons and the file-head / row min-height', () => {
    const overlay = gtRoot();
    const stepbtn = span(overlay, 'cyc-cx-stepbtn');
    const act = span(overlay, 'cyc-gt-act');
    const fhead = span(overlay, 'cyc-cx-fhead');
    const rowEl = span(overlay, 'cyc-gt-row');

    coarse = true;
    installMatchMedia();
    paintGt(overlay, false);
    expect(stepbtn.style.width).toBe('1.75rem');
    expect(stepbtn.style.height).toBe('1.75rem');
    expect(act.style.width).toBe('1.75rem');
    expect(fhead.style.minHeight).toBe('34px');
    expect(rowEl.style.minHeight).toBe('36px');

    coarse = false;
    installMatchMedia();
    paintGt(overlay, false);
    expect(stepbtn.style.width).toBe('');
    expect(act.style.width).toBe('');
    expect(fhead.style.minHeight).toBe('');
    expect(rowEl.style.minHeight).toBe('');
  });
});

describe('the hover / fork class helpers (the JIT literals the class list carries)', () => {
  test('each helper resolves to the finite per-theme utility, both branches present', () => {
    expect(gtHoverRow(false)).toBe('[&:hover:not(.cyc-gt-row-on)]:bg-[#f2f2f2]!');
    expect(gtHoverRow(true)).toBe('[&:hover:not(.cyc-gt-row-on)]:bg-[#2a2d2e]!');
    expect(gtHoverBack(false)).toBe('hover:bg-[#f2f2f2]! hover:text-[#3b3b3b]!');
    expect(gtHoverBack(true)).toBe('hover:bg-[#2a2d2e]! hover:text-[#cccccc]!');
    expect(gtHoverVbtn(false)).toBe('hover:enabled:bg-[#f2f2f2]! hover:enabled:text-[#3b3b3b]!');
    expect(gtHoverStep(false)).toBe('hover:enabled:bg-[#f2f2f2]!');
    expect(gtHoverStep(true)).toBe('hover:enabled:bg-[#2a2d2e]!');
    expect(gtHoverReview(false)).toBe('hover:text-[#3b3b3b]!');
    expect(gtHoverReview(true)).toBe('hover:text-[#cccccc]!');
    expect(gtForkDim(false)).toBe('before:text-[#6f6f6f]');
    expect(gtForkDim(true)).toBe('before:text-[#9d9d9d]');
  });
});

describe('createGtPaint live pointer reactivity', () => {
  test('flipping the pointer bucket repaints, and destroy stops it', () => {
    const overlay = gtRoot();
    const rowEl = span(overlay, 'cyc-gt-row');
    const paint = createGtPaint(overlay, false);
    paint.repaint();
    expect(rowEl.style.minHeight).toBe('');

    // the pointer becomes coarse and the media query fires its change
    coarse = true;
    firePointer();
    expect(rowEl.style.minHeight).toBe('36px');

    paint.destroy();
    coarse = false;
    firePointer();
    expect(rowEl.style.minHeight).toBe('36px');
  });
});

// Diff-viewer chrome.

describe('the .cyc-fx code-viewer chrome (was the git.css .cyc-fx-* block)', () => {
  test('the overlay and pane surfaces take their themed literal, day and night', () => {
    const overlay = gtRoot();
    const a = span(overlay, 'cyc-fx-a');
    const b = span(overlay, 'cyc-fx-b');
    const fileScroll = span(overlay, 'cyc-fx-file-scroll');
    const head = span(overlay, 'cyc-fx-head');
    const title = span(overlay, 'cyc-fx-title');
    const crumb = span(overlay, 'cyc-fx-crumb');
    const copy = span(overlay, 'cyc-fx-copy');
    const empty = span(overlay, 'cyc-fx-empty');
    const codeWrap = span(overlay, 'cyc-fx-code-wrap');

    paintGt(overlay, false);
    sty(overlay, 'background', DAY.editorBg);
    sty(overlay, 'color', DAY.fg);
    sty(a, 'background', DAY.sideBg);
    sty(b, 'background', DAY.editorBg);
    sty(fileScroll, 'background', DAY.editorBg);
    sty(head, 'borderBottomColor', DAY.tabBorder);
    sty(title, 'color', DAY.tabActiveFg);
    sty(crumb, 'color', DAY.dim);
    sty(copy, 'color', DAY.fg);
    sty(empty, 'color', DAY.dim);
    sty(codeWrap, 'color', DAY.fg);

    paintGt(overlay, true);
    sty(overlay, 'background', NIGHT.editorBg);
    sty(a, 'background', NIGHT.sideBg);
    sty(head, 'borderBottomColor', NIGHT.tabBorder);
    sty(title, 'color', NIGHT.tabActiveFg);
  });

  test('the foot takes its surface + border + ink, and the warn flag flips foot ink', () => {
    const overlay = gtRoot();
    const foot = span(overlay, 'cyc-fx-foot');
    const left = span(overlay, 'cyc-fx-foot-left');
    const right = span(overlay, 'cyc-fx-foot-right cyc-fx-warn');
    paintGt(overlay, false);
    sty(foot, 'background', DAY.tabInactiveBg);
    sty(foot, 'borderTopColor', DAY.tabBorder);
    sty(foot, 'color', DAY.dim);
    sty(left, 'color', '');
    sty(right, 'color', DAY.gModified);
    right.classList.remove('cyc-fx-warn');
    paintGt(overlay, false);
    sty(right, 'color', '');
  });

  test('the language badge takes the selection ink + accent and honours the hidden flag', () => {
    const overlay = gtRoot();
    const lang = span(overlay, 'cyc-fx-lang');
    paintGt(overlay, false);
    sty(lang, 'color', DAY.selFg);
    sty(lang, 'background', DAY.focusOutline);
    expect(lang.style.display).toBe('');
    lang.classList.add('cyc-fx-hidden');
    paintGt(overlay, false);
    expect(lang.style.display).toBe('none');
  });

  test('the diff line numbers take the line-number ink', () => {
    const overlay = gtRoot();
    const wrap = span(overlay, 'cyc-fx-code-wrap cyc-fx-code cyc-gt-diff');
    const num = span(wrap, 'cyc-fx-num');
    paintGt(overlay, false);
    sty(num, 'color', DAY.lineNo);
    paintGt(overlay, true);
    sty(num, 'color', NIGHT.lineNo);
  });

  test('the prism syntax tokens take the VS Code palette', () => {
    const overlay = gtRoot();
    const code = span(overlay, 'cyc-fx-code');
    const kw = span(code, 'token keyword');
    const str = span(code, 'token string');
    const del = span(code, 'token deleted');
    const punct = span(code, 'token');
    paintGt(overlay, false);
    sty(kw, 'color', DAY.tKeyword);
    sty(str, 'color', DAY.tString);
    sty(del, 'color', DAY.gDeleted);
    sty(punct, 'color', DAY.tPunct);
    paintGt(overlay, true);
    sty(kw, 'color', NIGHT.tKeyword);
  });

  test('the back / view buttons take the base dim ink and the pointer-sized box', () => {
    const overlay = gtRoot();
    const back = span(overlay, 'cyc-fx-back');
    const vbtn = span(overlay, 'cyc-fx-vbtn');
    const vbtnOn = span(overlay, 'cyc-fx-vbtn cyc-fx-vbtn-on');

    paintGt(overlay, false);
    sty(back, 'color', DAY.dim);
    expect(back.style.width).toBe('1.75rem');
    expect(back.style.height).toBe('1.75rem');
    sty(vbtn, 'color', DAY.dim);
    expect(back.style.background).toBe('none');
    expect(vbtn.style.background).toBe('none');
    sty(vbtnOn, 'color', DAY.focusOutline);
    sty(vbtnOn, 'background', DAY.hoverBg);

    coarse = true;
    installMatchMedia();
    paintGt(overlay, false);
    expect(back.style.width).toBe('2rem');
    expect(vbtn.style.width).toBe('2rem');
  });

  test('the copy and view buttons dim + take the default cursor when disabled', () => {
    const overlay = gtRoot();
    const vbtnOff = document.createElement('button');
    vbtnOff.className = 'cyc-fx-vbtn';
    const vbtnDis = document.createElement('button');
    vbtnDis.className = 'cyc-fx-vbtn';
    vbtnDis.disabled = true;
    const copyDis = document.createElement('button');
    copyDis.className = 'cyc-fx-copy';
    copyDis.disabled = true;
    overlay.append(vbtnOff, vbtnDis, copyDis);

    paintGt(overlay, false);
    expect(vbtnOff.style.background).toBe('none');
    expect(vbtnOff.style.opacity).toBe('');
    expect(vbtnOff.style.cursor).toBe('pointer');
    expect(vbtnDis.style.opacity).toBe('0.35');
    expect(vbtnDis.style.cursor).toBe('default');
    expect(copyDis.style.opacity).toBe('0.35');

    // re-enabling clears the dim / restores the pointer on the next paint
    vbtnDis.disabled = false;
    copyDis.disabled = false;
    paintGt(overlay, false);
    expect(vbtnDis.style.opacity).toBe('');
    expect(vbtnDis.style.cursor).toBe('pointer');
    expect(copyDis.style.opacity).toBe('');
  });

  test('the split rail flips between the wide splitter and the phone nav halves', () => {
    const overlay = gtRoot();
    const rail = span(overlay, 'cyc-fx-rail');
    const halfA = span(rail, 'cyc-fx-rail-half cyc-fx-rail-a cyc-fx-rail-on');
    const grip = span(rail, 'cyc-fx-rail-grip');

    paintGt(overlay, false);
    expect(rail.style.borderLeftWidth).toBe('1px');
    expect(halfA.style.display).toBe('flex');
    sty(halfA, 'background', DAY.tabActiveBg);
    sty(halfA, 'color', DAY.tabActiveFg);
    expect(grip.style.display).toBe('none');

    // wide: the rail becomes a col-resize splitter with an over-reaching grip
    overlay.classList.add('cyc-fx-wide');
    paintGt(overlay, false);
    expect(rail.style.borderLeftWidth).toBe('0');
    expect(rail.style.cursor).toBe('col-resize');
    expect(halfA.style.display).toBe('none');
    expect(grip.style.display).toBe('block');
    expect(grip.style.left).toBe('-4px');

    // dragging tints the rail with the focus accent
    overlay.classList.add('cyc-fx-dragging');
    paintGt(overlay, false);
    sty(rail, 'background', DAY.focusOutline);
  });

  test('applyFxGeom sets the constant, input-free chrome box inline', () => {
    const overlay = gtRoot();
    const track = span(overlay, 'cyc-fx-track');
    const head = span(overlay, 'cyc-fx-head');
    const scroll = span(overlay, 'cyc-fx-scroll');
    paintGt(overlay, false);
    expect(overlay.style.position).toBe('absolute');
    expect(overlay.style.display).toBe('flex');
    expect(track.style.display).toBe('flex');
    expect(track.style.height).toBe('100%');
    expect(head.style.padding).toBe('0.5rem 0.625rem');
    expect(head.style.minHeight).toBe('3rem');
    expect(scroll.style.overflow).toBe('auto');
  });
});

// End-to-end viewer paint.

function mockEngine(handler: (op: string, args: Record<string, string>) => unknown) {
  (window as unknown as {cyc: unknown}).cyc = {
    call: (op: string, args: Record<string, string>) =>
      Promise.resolve({ok: true, result: handler(op, args)}),
    save: () => Promise.resolve({ok: true, message: ''}),
    load: () => Promise.resolve({ok: true, saved: false, data: null, message: ''}),
    close: () => {}
  };
}

const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};

const changeFile = (path: string, code: string, added: number, deleted: number) => ({
  path,
  code,
  added,
  deleted,
  binary: false,
  lines: [] as never[],
  truncated: false,
  skipped: false
});

describe('driving the real git viewers', () => {
  beforeEach(() => {
    (globalThis as unknown as {ResizeObserver: unknown}).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (globalThis as unknown as {IntersectionObserver: unknown}).IntersectionObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): unknown[] {
        return [];
      }
    };
    document.body.innerHTML = '<div id="cyc-app"><div id="cyc-stage"></div></div>';
    day();
  });
  afterEach(() => {
    (window as unknown as {cyc?: unknown}).cyc = undefined;
  });

  test('the git viewer paints its live branch card and file / commit rows', async () => {
    mockEngine((op) => {
      if (op === 'pane')
        return {
          ok: true,
          repo: true,
          root: '/home/proj',
          name: 'proj',
          cwdInRepo: '',
          branch: 'main',
          detached: '',
          upstream: '',
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [{path: 'src/app.ts', code: 'M'}],
          truncated: false,
          log: [
            {
              sha: 'deadbeef',
              short: 'deadbee',
              subject: 'first',
              author: 'me',
              when: 1_700_000_000,
              refs: 'HEAD -> main'
            }
          ],
          logError: '',
          lastMessage: ''
        };
      return {ok: false, error: 'no'};
    });

    openGitViewer('sess', 'proj');
    await flush();

    const overlay = document.querySelector<HTMLElement>('.cyc-gt')!;
    expect(overlay).toBeTruthy();

    const bname = overlay.querySelector<HTMLElement>('.cyc-gt-branch-name')!;
    expect(bname.textContent).toBe('main');
    sty(bname, 'color', DAY.fg);

    const fileRow = overlay.querySelector<HTMLElement>('.cyc-gt-row .cyc-gt-name')!;
    expect(fileRow.textContent).toBe('app.ts');
    // an unselected name takes its git-status ink inline (the M file -> modified)
    sty(fileRow, 'color', DAY.gModified);

    const dir = overlay.querySelector<HTMLElement>('.cyc-gt-dir')!;
    sty(dir, 'color', DAY.dim);
    const sha = overlay.querySelector<HTMLElement>('.cyc-gt-crow .cyc-gt-sha')!;
    expect(sha.textContent).toBe('deadbee');
    sty(sha, 'color', DAY.dim);
    const refs = overlay.querySelector<HTMLElement>('.cyc-gt-refs')!;
    sty(refs, 'color', DAY.dim);
  });

  test('the change viewer inverts its default-selected first file row', async () => {
    mockEngine((op) => {
      if (op === 'change')
        return {
          ok: true,
          what: 'unstaged',
          commit: null,
          files: [changeFile('a.ts', 'M', 3, 1), changeFile('b.ts', 'A', 5, 0)],
          fileCount: 2,
          added: 8,
          deleted: 1,
          truncated: false
        };
      return {ok: false, error: 'no'};
    });

    openChangeViewer('sess', 'proj', {what: 'unstaged', sha: '', subject: ''});
    await flush();

    const overlay = document.querySelector<HTMLElement>('.cyc-cx')!;
    expect(overlay).toBeTruthy();

    const rows = [...overlay.querySelectorAll<HTMLElement>('.cyc-cx-frow')];
    expect(rows.length).toBe(2);
    // `at` starts at 0, so markAt selects the first row: it fills + inverts
    expect(rows[0].classList.contains('cyc-gt-row-on')).toBe(true);
    sty(rows[0], 'background', DAY.selBg);
    sty(rows[0].querySelector<HTMLElement>('.cyc-gt-name')!, 'color', DAY.selFg);
    sty(rows[0].querySelector<HTMLElement>('.cyc-cx-plus')!, 'color', DAY.selFg);

    sty(rows[1], 'background', '');
    sty(rows[1].querySelector<HTMLElement>('.cyc-gt-name')!, 'color', DAY.gAdded);

    // the summary card fork name takes fg and carries the ::before dim utility
    const what = overlay.querySelector<HTMLElement>('.cyc-cx-what')!;
    sty(what, 'color', DAY.fg);
    expect(what.classList.contains('before:text-[#6f6f6f]')).toBe(true);
  });
});
