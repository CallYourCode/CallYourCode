import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {FX_DAY, FX_NIGHT, paintFx, createFxPaint} from '../plugins/files/filesPaint';
import {openFilesViewer} from '../plugins/files/filesViewer';

// Normalise style values as jsdom does.
const norm = (prop: string, value: string): string => {
  const p = document.createElement('div');
  (p.style as unknown as Record<string, string>)[prop] = value;
  return (p.style as unknown as Record<string, string>)[prop];
};
const sty = (el: HTMLElement, prop: string, expected: string) =>
  expect((el.style as unknown as Record<string, string>)[prop]).toBe(norm(prop, expected));

let coarse = false;
const installMatchMedia = () => {
  (window as unknown as {matchMedia: (q: string) => MediaQueryList}).matchMedia = (q: string) => {
    const listeners = new Set<() => void>();
    return {
      matches: q.includes('coarse') ? coarse : false,
      media: q,
      onchange: null,
      addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false
    } as unknown as MediaQueryList;
  };
};

const day = () => {
  document.documentElement.dataset.theme = 'light';
};
const night = () => {
  document.documentElement.dataset.theme = 'dark';
};

function fxRoot(extra = ''): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = `cyc-fx ${extra}`.trim();
  document.body.append(overlay);
  return overlay;
}

const div = (parent: HTMLElement, cls: string): HTMLElement => {
  const el = document.createElement('div');
  el.className = cls;
  parent.append(el);
  return el;
};

beforeEach(() => {
  coarse = false;
  installMatchMedia();
  document.body.innerHTML = '';
  day();
});
afterEach(() => {
  document.body.innerHTML = '';
  day();
  coarse = false;
});

describe('the overlay + panes + chrome surfaces (was the .cyc-fx palette)', () => {
  test('root, side/editor panes and file scroll take the themed background', () => {
    const overlay = fxRoot();
    const a = div(overlay, 'cyc-fx-pane cyc-fx-a');
    const b = div(overlay, 'cyc-fx-pane cyc-fx-b');
    const fs = div(b, 'cyc-fx-scroll cyc-fx-file-scroll');

    paintFx(overlay);
    sty(overlay, 'background', FX_DAY.editorBg);
    sty(overlay, 'color', FX_DAY.fg);
    sty(a, 'background', FX_DAY.sideBg);
    sty(b, 'background', FX_DAY.editorBg);
    sty(fs, 'background', FX_DAY.editorBg);

    night();
    paintFx(overlay);
    sty(overlay, 'background', FX_NIGHT.editorBg);
    sty(a, 'background', FX_NIGHT.sideBg);
    sty(b, 'background', FX_NIGHT.editorBg);
  });

  test('header border, title, crumb, copy, lang, empty ink', () => {
    const overlay = fxRoot();
    const head = div(overlay, 'cyc-fx-head');
    const title = div(head, 'cyc-fx-title');
    const crumb = div(head, 'cyc-fx-crumb');
    const copy = div(head, 'cyc-fx-copy');
    const lang = div(head, 'cyc-fx-lang');
    const empty = div(overlay, 'cyc-fx-empty');

    paintFx(overlay);
    sty(head, 'borderBottomColor', FX_DAY.tabBorder);
    sty(title, 'color', FX_DAY.tabActiveFg);
    sty(crumb, 'color', FX_DAY.dim);
    sty(copy, 'color', FX_DAY.fg);
    sty(lang, 'color', FX_DAY.selFg);
    sty(lang, 'background', FX_DAY.focusOutline);
    sty(empty, 'color', FX_DAY.dim);
  });

  test('the footer ink, and the warn state, follow the theme', () => {
    const overlay = fxRoot();
    const foot = div(overlay, 'cyc-fx-foot');
    const left = div(foot, 'cyc-fx-foot-left');
    const right = div(foot, 'cyc-fx-foot-right cyc-fx-warn');

    paintFx(overlay);
    sty(foot, 'background', FX_DAY.tabInactiveBg);
    sty(foot, 'borderTopColor', FX_DAY.tabBorder);
    sty(foot, 'color', FX_DAY.dim);
    sty(left, 'color', '');
    sty(right, 'color', FX_DAY.gModified);

    right.classList.remove('cyc-fx-warn');
    paintFx(overlay);
    sty(right, 'color', '');
  });
});

describe('the tree (was tree/selection/git-mark colour)', () => {
  function row(overlay: HTMLElement, opts: {sel?: boolean; git?: string} = {}): HTMLElement {
    const el = div(overlay, `cyc-fx-row${opts.sel ? ' cyc-fx-sel' : ''}`);
    div(el, 'cyc-fx-twist');
    div(el, 'cyc-fx-icon cyc-fx-icon-folder');
    const name = div(el, `cyc-fx-name${opts.git ? ` cyc-fx-g${opts.git}` : ''}`);
    name.textContent = 'x';
    if (opts.git) {
      const mark = div(el, `cyc-fx-gmark cyc-fx-g${opts.git}`);
      mark.textContent = opts.git;
    }
    return el;
  }

  test('a selected row takes the selection fill + focus ring, names go inverse', () => {
    const overlay = fxRoot();
    const sel = row(overlay, {sel: true, git: 'M'});
    const plain = row(overlay, {git: 'A'});

    paintFx(overlay);
    sty(sel, 'background', FX_DAY.selBg);
    sty(sel, 'boxShadow', `inset 0 0 0 1px ${FX_DAY.focusOutline}`);
    sty(sel.querySelector<HTMLElement>('.cyc-fx-name')!, 'color', FX_DAY.selFg);
    sty(sel.querySelector<HTMLElement>('.cyc-fx-gmark')!, 'color', FX_DAY.selFg);

    sty(plain, 'background', '');
    sty(plain, 'boxShadow', '');
    sty(plain.querySelector<HTMLElement>('.cyc-fx-name')!, 'color', FX_DAY.gAdded);
    expect(plain.classList.contains('[&:hover:not(.cyc-fx-sel)]:bg-[#f2f2f2]')).toBe(true);
  });

  test('git letters map to their status ink, ignored dims to 0.7', () => {
    const overlay = fxRoot();
    const rows = {
      M: row(overlay, {git: 'M'}),
      D: row(overlay, {git: 'D'}),
      U: row(overlay, {git: 'U'}),
      I: row(overlay, {git: 'I'})
    };
    paintFx(overlay);
    const ink = (el: HTMLElement) => el.querySelector<HTMLElement>('.cyc-fx-name')!;
    sty(ink(rows.M), 'color', FX_DAY.gModified);
    sty(ink(rows.D), 'color', FX_DAY.gDeleted);
    sty(ink(rows.U), 'color', FX_DAY.gUntracked);
    sty(ink(rows.I), 'color', FX_DAY.gIgnored);
    expect(ink(rows.I).style.opacity).toBe('0.7');
    expect(ink(rows.M).style.opacity).toBe('');

    night();
    paintFx(overlay);
    sty(ink(rows.M), 'color', FX_NIGHT.gModified);
  });

  test('twist, folder icon and indent guide take the dim/indent literals', () => {
    const overlay = fxRoot();
    const r = div(overlay, 'cyc-fx-row');
    const indent = div(r, 'cyc-fx-indent');
    const twist = div(r, 'cyc-fx-twist');
    div(r, 'cyc-fx-icon cyc-fx-icon-folder');
    paintFx(overlay);
    sty(twist, 'color', FX_DAY.dim);
    sty(r.querySelector<HTMLElement>('.cyc-fx-icon-folder')!, 'color', FX_DAY.dim);
    sty(
      indent,
      'backgroundImage',
      `linear-gradient(to right, ${FX_DAY.indent} 1px, transparent 1px)`
    );
  });
});

describe('the code viewer (was line/gutter/diff/prism colour)', () => {
  function codeWrap(overlay: HTMLElement): HTMLElement {
    const b = div(overlay, 'cyc-fx-pane cyc-fx-b');
    const scroll = div(b, 'cyc-fx-scroll cyc-fx-file-scroll');
    const body = div(scroll, 'cyc-fx-file');
    return div(body, 'cyc-fx-code-wrap cyc-fx-code');
  }
  function line(wrap: HTMLElement, kind?: string): HTMLElement {
    const ln = div(wrap, 'cyc-fx-line');
    div(ln, 'cyc-fx-num');
    div(ln, `cyc-fx-gline${kind ? ` cyc-fx-d-${kind}` : ''}`);
    return ln;
  }

  test('line numbers and the code face take the editor literals', () => {
    const overlay = fxRoot();
    const wrap = codeWrap(overlay);
    const ln = line(wrap);
    paintFx(overlay);
    sty(wrap, 'color', FX_DAY.fg);
    const num = ln.querySelector<HTMLElement>('.cyc-fx-num')!;
    sty(num, 'background', FX_DAY.editorBg);
    sty(num, 'color', FX_DAY.lineNo);
  });

  test('diff gutters colour by kind; the deleted triangle takes the deleted ink', () => {
    const overlay = fxRoot();
    const wrap = codeWrap(overlay);
    const added = line(wrap, 'added').querySelector<HTMLElement>('.cyc-fx-gline')!;
    const modified = line(wrap, 'modified').querySelector<HTMLElement>('.cyc-fx-gline')!;
    const delGline = line(wrap, 'deleted').querySelector<HTMLElement>('.cyc-fx-gline')!;
    const mark = div(delGline, 'cyc-fx-d-deleted-mark');

    paintFx(overlay);
    sty(added, 'borderLeftColor', FX_DAY.dAdded);
    sty(modified, 'borderLeftColor', FX_DAY.dModified);
    sty(delGline, 'borderLeftColor', 'transparent');
    sty(mark, 'borderLeftColor', FX_DAY.dDeleted);

    night();
    paintFx(overlay);
    sty(added, 'borderLeftColor', FX_NIGHT.dAdded);
    sty(mark, 'borderLeftColor', FX_NIGHT.dDeleted);
  });

  test('prism syntax tokens take the VS Code palette per category and theme', () => {
    const overlay = fxRoot();
    const wrap = codeWrap(overlay);
    const tok = (type: string) => {
      const s = document.createElement('span');
      s.className = `token ${type}`;
      wrap.append(s);
      return s;
    };
    const kw = tok('keyword');
    const str = tok('string');
    const num = tok('number');
    const com = tok('comment');
    const fn = tok('function');
    const del = tok('deleted');

    paintFx(overlay);
    sty(kw, 'color', FX_DAY.tKeyword);
    sty(str, 'color', FX_DAY.tString);
    sty(num, 'color', FX_DAY.tNumber);
    sty(com, 'color', FX_DAY.tComment);
    sty(fn, 'color', FX_DAY.tFunction);
    sty(del, 'color', FX_DAY.gDeleted);

    night();
    paintFx(overlay);
    sty(kw, 'color', FX_NIGHT.tKeyword);
    sty(com, 'color', FX_NIGHT.tComment);
  });
});

describe('tabs + rails (was tab/rail state colour + shadow side)', () => {
  test('an active tab inverts, and the top accent sits on the wide side', () => {
    const overlay = fxRoot('cyc-fx-wide');
    const tabs = div(overlay, 'cyc-fx-tabs');
    const on = div(tabs, 'cyc-fx-tab cyc-fx-tab-on');
    const off = div(tabs, 'cyc-fx-tab');

    paintFx(overlay);
    sty(tabs, 'background', FX_DAY.tabInactiveBg);
    sty(on, 'background', FX_DAY.tabActiveBg);
    sty(on, 'color', FX_DAY.tabActiveFg);
    sty(on, 'boxShadow', `inset 0 2px 0 0 ${FX_DAY.tabTop}`);
    sty(off, 'background', FX_DAY.tabInactiveBg);
    sty(off, 'color', FX_DAY.tabInactiveFg);
    sty(off, 'boxShadow', '');
  });

  test('on the phone the tab accent flips to the bottom edge', () => {
    const overlay = fxRoot('cyc-fx-phone');
    const tabs = div(overlay, 'cyc-fx-tabs');
    const on = div(tabs, 'cyc-fx-tab cyc-fx-tab-on');
    paintFx(overlay);
    sty(on, 'boxShadow', `inset 0 -2px 0 0 ${FX_DAY.tabTop}`);
  });

  test('rail halves invert with side-specific accents, dragging tints the rail', () => {
    const overlay = fxRoot();
    const rail = div(overlay, 'cyc-fx-rail');
    const a = div(rail, 'cyc-fx-rail-half cyc-fx-rail-a cyc-fx-rail-on');
    const b = div(rail, 'cyc-fx-rail-half cyc-fx-rail-b');

    paintFx(overlay);
    sty(rail, 'background', FX_DAY.tabBorder);
    sty(a, 'background', FX_DAY.tabActiveBg);
    sty(a, 'boxShadow', `inset 2px 0 0 0 ${FX_DAY.tabTop}`);
    sty(b, 'background', FX_DAY.tabInactiveBg);
    sty(b, 'boxShadow', '');

    overlay.classList.add('cyc-fx-dragging');
    paintFx(overlay);
    sty(rail, 'background', FX_DAY.focusOutline);
  });
});

describe('the interactive controls (was hover + on state + pointer size)', () => {
  test('back and view buttons carry the per-theme hover utilities; on-state adds its skin', () => {
    const overlay = fxRoot();
    const back = div(overlay, 'cyc-fx-back');
    const vbtn = div(overlay, 'cyc-fx-vbtn');
    const vOn = div(overlay, 'cyc-fx-vbtn cyc-fx-vbtn-on');

    paintFx(overlay);
    expect(back.classList.contains('text-[#6f6f6f]')).toBe(true);
    expect(back.classList.contains('hover:bg-[#f2f2f2]!')).toBe(true);
    expect(vbtn.classList.contains('hover:enabled:bg-[#f2f2f2]!')).toBe(true);
    expect(vOn.classList.contains('text-[#0078d4]!')).toBe(true);
    expect(vOn.classList.contains('shadow-[inset_0_0_0_1px_#0078d4]!')).toBe(true);

    night();
    paintFx(overlay);
    expect(back.classList.contains('text-[#9d9d9d]')).toBe(true);
    expect(back.classList.contains('text-[#6f6f6f]')).toBe(false);
    expect(back.classList.contains('hover:bg-[#2a2d2e]!')).toBe(true);

    vOn.classList.remove('cyc-fx-vbtn-on');
    paintFx(overlay);
    expect(vOn.classList.contains('text-[#0078d4]!')).toBe(false);
  });

  test('coarse pointer grows the buttons, tab height and the wide splitter grip', () => {
    const overlay = fxRoot('cyc-fx-wide');
    const back = div(overlay, 'cyc-fx-back');
    const vbtn = div(overlay, 'cyc-fx-vbtn');
    const tab = div(div(overlay, 'cyc-fx-tabs'), 'cyc-fx-tab');
    const rail = div(overlay, 'cyc-fx-rail');
    const grip = div(rail, 'cyc-fx-rail-grip');

    coarse = true;
    installMatchMedia();
    paintFx(overlay);
    expect(back.style.width).toBe('2rem');
    expect(back.style.height).toBe('2rem');
    expect(vbtn.style.width).toBe('2rem');
    expect(tab.style.height).toBe('2.25rem');
    expect(grip.style.left).toBe('-12px');
    expect(grip.style.right).toBe('-12px');

    coarse = false;
    installMatchMedia();
    paintFx(overlay);
    expect(back.style.width).toBe('1.75rem');
    expect(tab.style.height).toBe('2rem');
    expect(grip.style.left).toBe('-4px');
    expect(grip.style.right).toBe('-4px');
    expect(grip.style.display).toBe('block');
  });

  test('the hover controls carry their inline base, and buttons dim when disabled', () => {
    const overlay = fxRoot();
    const back = document.createElement('button');
    back.className = 'cyc-fx-back';
    const tabx = document.createElement('button');
    tabx.className = 'cyc-fx-tab-x';
    const vbtnOff = document.createElement('button');
    vbtnOff.className = 'cyc-fx-vbtn';
    const vbtnDis = document.createElement('button');
    vbtnDis.className = 'cyc-fx-vbtn';
    vbtnDis.disabled = true;
    const copyDis = document.createElement('button');
    copyDis.className = 'cyc-fx-copy';
    copyDis.disabled = true;
    overlay.append(back, tabx, vbtnOff, vbtnDis, copyDis);

    paintFx(overlay);
    expect(back.style.background).toBe('none');
    expect(vbtnOff.style.background).toBe('none');
    expect(tabx.style.opacity).toBe('0.55');
    expect(vbtnOff.style.opacity).toBe('');
    expect(vbtnOff.style.cursor).toBe('pointer');
    expect(vbtnDis.style.opacity).toBe('0.35');
    expect(vbtnDis.style.cursor).toBe('default');
    expect(copyDis.style.opacity).toBe('0.35');

    vbtnDis.disabled = false;
    copyDis.disabled = false;
    paintFx(overlay);
    expect(vbtnDis.style.opacity).toBe('');
    expect(vbtnDis.style.cursor).toBe('pointer');
    expect(copyDis.style.opacity).toBe('');
  });
});

describe('createFxPaint live reactivity', () => {
  test('flipping data-theme repaints, and destroy stops it', async () => {
    const overlay = fxRoot();
    div(overlay, 'cyc-fx-pane cyc-fx-a');
    const paint = createFxPaint(overlay);
    paint.repaint();
    sty(overlay, 'background', FX_DAY.editorBg);

    night();
    await Promise.resolve();
    await Promise.resolve();
    sty(overlay, 'background', FX_NIGHT.editorBg);

    paint.destroy();
    day();
    await Promise.resolve();
    await Promise.resolve();
    sty(overlay, 'background', FX_NIGHT.editorBg);
  });
});

type Call = {op: string; args: Record<string, string>};

function mockEngine(handler: (c: Call) => unknown) {
  (window as unknown as {cyc: unknown}).cyc = {
    call: (op: string, args: Record<string, string>) =>
      Promise.resolve({ok: true, result: handler({op, args})}),
    save: () => Promise.resolve({ok: true, message: ''}),
    load: () => Promise.resolve({ok: true, saved: false, data: null, message: ''}),
    close: () => {}
  };
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('driving the real files viewer', () => {
  beforeEach(() => {
    (globalThis as unknown as {ResizeObserver: unknown}).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    document.body.innerHTML = '<div id="cyc-app"><div id="cyc-stage"></div></div>';
    day();
  });

  test('the tree, its git marks and the opened file all take the themed paint', async () => {
    mockEngine(({op, args}) => {
      if (op === 'list')
        return {
          ok: true,
          path: args.path,
          root: '/home/proj',
          name: 'proj',
          entries: [
            {name: 'a.ts', dir: false, size: 42, mtime: Date.now()},
            {name: 'b.md', dir: false, size: 9, mtime: Date.now()}
          ],
          total: 2,
          truncated: false
        };
      if (op === 'git')
        return {ok: true, repo: true, root: '/home/proj', files: {'a.ts': 'M'}, truncated: false};
      if (op === 'read')
        return {
          ok: true,
          kind: 'text',
          path: args.path,
          name: 'a.ts',
          size: 42,
          mtime: Date.now(),
          lines: 2,
          text: 'const x = 1\nfoo()\n',
          truncated: false
        };
      if (op === 'diff')
        return {
          ok: true,
          repo: true,
          marks: [{line: 1, kind: 'added'}],
          added: 1,
          modified: 0,
          deleted: 0
        };
      return {ok: false, error: 'no'};
    });

    openFilesViewer('page', 'proj');
    await flush();

    const overlay = document.querySelector<HTMLElement>('.cyc-fx')!;
    expect(overlay).toBeTruthy();
    sty(overlay, 'background', FX_DAY.editorBg);

    const rows = [...overlay.querySelectorAll<HTMLElement>('.cyc-fx-row')];
    expect(rows.length).toBe(2);
    const gitRow = rows.find((r) => r.querySelector('.cyc-fx-name')?.textContent === 'a.ts')!;
    sty(gitRow.querySelector<HTMLElement>('.cyc-fx-name')!, 'color', FX_DAY.gModified);

    gitRow.dispatchEvent(new Event('click', {bubbles: true}));
    await flush();

    const nums = [...overlay.querySelectorAll<HTMLElement>('.cyc-fx-num')];
    expect(nums.length).toBeGreaterThan(0);
    sty(nums[0], 'color', FX_DAY.lineNo);
    const added = overlay.querySelector<HTMLElement>('.cyc-fx-gline.cyc-fx-d-added')!;
    sty(added, 'borderLeftColor', FX_DAY.dAdded);

    const tabOn = overlay.querySelector<HTMLElement>('.cyc-fx-tab.cyc-fx-tab-on')!;
    expect(tabOn).toBeTruthy();
    sty(tabOn, 'color', FX_DAY.tabActiveFg);

    night();
    await Promise.resolve();
    await Promise.resolve();
    sty(overlay, 'background', FX_NIGHT.editorBg);
    sty(nums[0], 'color', FX_NIGHT.lineNo);

    (window as unknown as {cyc?: unknown}).cyc = undefined;
  });
});
