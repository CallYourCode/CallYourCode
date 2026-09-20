// Git plugin presentation paint.

import {queryEach} from '@/components/domHelpers';

export type GtTheme = {
  addBg: string;
  delBg: string;
  addFg: string;
  delFg: string;
  hunkFg: string;
  card: string;
  btn: string;
  btnFg: string;
  inputBorder: string;
};

const GT_DAY: GtTheme = {
  addBg: 'rgba(155, 185, 85, 0.2)',
  delBg: 'rgba(255, 0, 0, 0.12)',
  addFg: '#587c0c',
  delFg: '#ad0707',
  hunkFg: '#0078d4',
  card: '#f0f0f0',
  btn: '#e5e5e5',
  btnFg: '#3b3b3b',
  inputBorder: '#cecece'
};

const GT_NIGHT: GtTheme = {
  addBg: 'rgba(70, 149, 74, 0.22)',
  delBg: 'rgba(248, 81, 73, 0.18)',
  addFg: '#81b88b',
  delFg: '#c74e39',
  hunkFg: '#4daafc',
  card: '#202020',
  btn: '#313131',
  btnFg: '#cccccc',
  inputBorder: '#3c3c3c'
};

export const gtTheme = (dark: boolean): GtTheme => (dark ? GT_NIGHT : GT_DAY);

// :hover backgrounds the class list must carry (inline styles cannot express
// :hover). Each branch is a complete literal Tailwind utility so the JIT scanner
// finds both; the picked theme is fixed for the page's lifetime.
export const gtHoverBtn = (dark: boolean): string =>
  dark ? 'hover:bg-[#313131]!' : 'hover:bg-[#e5e5e5]!';

export const gtHoverBrow = (dark: boolean): string =>
  dark
    ? '[&:hover:not(.cyc-gt-brow-on)]:bg-[#313131]!'
    : '[&:hover:not(.cyc-gt-brow-on)]:bg-[#e5e5e5]!';

// Change-viewer +/− tallies keep a class so the selected-row descendant rule
// (`.cyc-gt-row-on .cyc-cx-plus`, shared --fx-sel-fg) still wins over this base
// ink; a single literal utility (specificity 0,1,0) sits under that rule.
export const gtPlus = (dark: boolean): string => (dark ? 'text-[#81b88b]' : 'text-[#587c0c]');
export const gtMinus = (dark: boolean): string => (dark ? 'text-[#c74e39]' : 'text-[#ad0707]');

export function diffRowStyleAttr(kind: string, gt: GtTheme): string {
  const bg = kind === 'add' ? gt.addBg : kind === 'del' ? gt.delBg : '';
  return bg ? ` style="background:${bg}"` : '';
}

export function diffSignStyleAttr(kind: string, gt: GtTheme): string {
  const ink = kind === 'add' ? gt.addFg : kind === 'del' ? gt.delFg : '';
  return ink ? ` style="color:${ink}"` : '';
}

export function diffLnStyleAttr(kind: string, gt: GtTheme, metaFg = ''): string {
  if (kind === 'hunk') return ` style="color:${gt.hunkFg};opacity:0.9"`;
  if (kind === 'meta' && metaFg) return ` style="color:${metaFg};font-style:italic"`;
  return '';
}

// Git list/chrome paint plus code-viewer colours. Hover/::before stay class utilities.
export type GtFx = {
  editorBg: string;
  sideBg: string;
  fg: string;
  dim: string;
  selBg: string;
  selFg: string;
  focusOutline: string;
  lineNo: string;
  hoverBg: string;
  tabActiveBg: string;
  tabActiveFg: string;
  tabInactiveBg: string;
  tabInactiveFg: string;
  tabBorder: string;
  tabTop: string;
  gModified: string;
  gAdded: string;
  gDeleted: string;
  gUntracked: string;
  gIgnored: string;
  gConflict: string;
  gRenamed: string;
  tComment: string;
  tString: string;
  tKeyword: string;
  tControl: string;
  tNumber: string;
  tFunction: string;
  tType: string;
  tVariable: string;
  tPunct: string;
  tRegex: string;
};

const FX_DAY: GtFx = {
  editorBg: '#ffffff',
  sideBg: '#f8f8f8',
  fg: '#3b3b3b',
  dim: '#6f6f6f',
  selBg: '#0060c0',
  selFg: '#ffffff',
  focusOutline: '#0078d4',
  lineNo: '#6e7681',
  hoverBg: '#f2f2f2',
  tabActiveBg: '#ffffff',
  tabActiveFg: '#333333',
  tabInactiveBg: '#f8f8f8',
  tabInactiveFg: '#6f6f6f',
  tabBorder: '#e5e5e5',
  tabTop: '#0078d4',
  gModified: '#895503',
  gAdded: '#587c0c',
  gDeleted: '#ad0707',
  gUntracked: '#007100',
  gIgnored: '#8e8e90',
  gConflict: '#ad0707',
  gRenamed: '#007100',
  tComment: '#008000',
  tString: '#a31515',
  tKeyword: '#0000ff',
  tControl: '#af00db',
  tNumber: '#098658',
  tFunction: '#795e26',
  tType: '#267f99',
  tVariable: '#001080',
  tPunct: '#000000',
  tRegex: '#811f3f'
};

const FX_NIGHT: GtFx = {
  editorBg: '#1f1f1f',
  sideBg: '#181818',
  fg: '#cccccc',
  dim: '#9d9d9d',
  selBg: '#04395e',
  selFg: '#ffffff',
  focusOutline: '#0078d4',
  lineNo: '#6e7681',
  hoverBg: '#2a2d2e',
  tabActiveBg: '#1f1f1f',
  tabActiveFg: '#ffffff',
  tabInactiveBg: '#181818',
  tabInactiveFg: '#9d9d9d',
  tabBorder: '#2b2b2b',
  tabTop: '#0078d4',
  gModified: '#e2c08d',
  gAdded: '#81b88b',
  gDeleted: '#c74e39',
  gUntracked: '#73c991',
  gIgnored: '#8c8c8c',
  gConflict: '#e4676b',
  gRenamed: '#73c991',
  tComment: '#6a9955',
  tString: '#ce9178',
  tKeyword: '#569cd6',
  tControl: '#c586c0',
  tNumber: '#b5cea8',
  tFunction: '#dcdcaa',
  tType: '#4ec9b0',
  tVariable: '#9cdcfe',
  tPunct: '#d4d4d4',
  tRegex: '#d16969'
};

export const gtFx = (dark: boolean): GtFx => (dark ? FX_NIGHT : FX_DAY);

// :hover / ::before Tailwind utilities the class list must carry. Each branch is
// a complete literal so the JIT scanner finds both; the picked theme is fixed for
// the page's lifetime. `!` is required because git.css ships un-layered, so a base
// declaration would otherwise beat a layered hover.
export const gtHoverRow = (dark: boolean): string =>
  dark
    ? '[&:hover:not(.cyc-gt-row-on)]:bg-[#2a2d2e]!'
    : '[&:hover:not(.cyc-gt-row-on)]:bg-[#f2f2f2]!';

export const gtHoverBack = (dark: boolean): string =>
  dark ? 'hover:bg-[#2a2d2e]! hover:text-[#cccccc]!' : 'hover:bg-[#f2f2f2]! hover:text-[#3b3b3b]!';

export const gtHoverVbtn = (dark: boolean): string =>
  dark
    ? 'hover:enabled:bg-[#2a2d2e]! hover:enabled:text-[#cccccc]!'
    : 'hover:enabled:bg-[#f2f2f2]! hover:enabled:text-[#3b3b3b]!';

export const gtHoverStep = (dark: boolean): string =>
  dark ? 'hover:enabled:bg-[#2a2d2e]!' : 'hover:enabled:bg-[#f2f2f2]!';

export const gtHoverReview = (dark: boolean): string =>
  dark ? 'hover:text-[#cccccc]!' : 'hover:text-[#3b3b3b]!';

// The `⑂` fork glyph the branch card draws as a `::before` (its colour was
// `before:text-(--fx-dim)`), literalised per theme.
export const gtForkDim = (dark: boolean): string =>
  dark ? 'before:text-[#9d9d9d]' : 'before:text-[#6f6f6f]';

// Git status letter class (`.cyc-fx-g<code>` / on `.cyc-gt-name`) -> palette key.
const GIT_COLOR: Record<string, keyof GtFx> = {
  gM: 'gModified',
  gA: 'gAdded',
  gD: 'gDeleted',
  gU: 'gUntracked',
  gR: 'gRenamed',
  gC: 'gConflict',
  gI: 'gIgnored'
};

// Prism token groups in git.css source order (a later group wins on the rare
// multi-class token, matching that file's equal-specificity cascade).
const TOKEN_GROUPS: Array<{names: string[]; key: keyof GtFx}> = [
  {names: ['comment', 'prolog', 'doctype', 'cdata'], key: 'tComment'},
  {names: ['punctuation'], key: 'tPunct'},
  {names: ['string', 'char', 'attr-value', 'inserted'], key: 'tString'},
  {names: ['number', 'boolean'], key: 'tNumber'},
  {names: ['keyword', 'atrule', 'rule'], key: 'tKeyword'},
  {names: ['important', 'directive'], key: 'tControl'},
  {names: ['function', 'function-name'], key: 'tFunction'},
  {names: ['class-name', 'builtin', 'tag', 'selector'], key: 'tType'},
  {
    names: ['property', 'attr-name', 'variable', 'constant', 'symbol', 'parameter'],
    key: 'tVariable'
  },
  {names: ['regex'], key: 'tRegex'},
  {names: ['operator', 'entity', 'url'], key: 'tPunct'},
  {names: ['deleted'], key: 'gDeleted'}
];

function gitClass(el: HTMLElement): string | null {
  for (const k in GIT_COLOR) if (el.classList.contains(`cyc-fx-${k}`)) return k;
  return null;
}

function tokenColor(el: HTMLElement, c: GtFx): string {
  let col = c.tPunct;
  for (const group of TOKEN_GROUPS) {
    if (group.names.some((n) => el.classList.contains(n))) col = c[group.key];
  }
  return col;
}

const FX_GEOM: Array<[string, Record<string, string>]> = [
  ['.cyc-fx-track', {display: 'flex', height: '100%', 'will-change': 'transform'}],
  [
    '.cyc-fx-pane',
    {
      display: 'flex',
      'flex-direction': 'column',
      'min-width': '0',
      height: '100%',
      flex: '0 0 auto'
    }
  ],
  [
    '.cyc-fx-head',
    {
      display: 'flex',
      'align-items': 'center',
      gap: '0.25rem',
      flex: '0 0 auto',
      padding: '0.5rem 0.625rem',
      'border-bottom-width': '1px',
      'border-bottom-style': 'solid',
      'min-height': '3rem'
    }
  ],
  ['.cyc-fx-head-titles', {'min-width': '0', flex: '1'}],
  [
    '.cyc-fx-title-row',
    {display: 'flex', 'align-items': 'center', gap: '0.375rem', 'min-width': '0'}
  ],
  [
    '.cyc-fx-title',
    {
      'font-size': '1rem',
      'font-weight': '600',
      'white-space': 'nowrap',
      overflow: 'hidden',
      'text-overflow': 'ellipsis'
    }
  ],
  [
    '.cyc-fx-lang',
    {
      flex: '0 0 auto',
      'font-size': '0.625rem',
      'font-weight': '600',
      'letter-spacing': '0.04em',
      padding: '0.0625rem 0.3125rem',
      'border-radius': '0.1875rem'
    }
  ],
  [
    '.cyc-fx-crumb',
    {
      'font-size': '0.75rem',
      'white-space': 'nowrap',
      overflow: 'hidden',
      'text-overflow': 'ellipsis'
    }
  ],
  [
    '.cyc-fx-back',
    {
      flex: '0 0 auto',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      border: '0',
      'border-radius': '0.1875rem',
      padding: '0',
      // Inline base fill the layered `hover:bg-[...]!` utility beats (was
      // `#cyc-app .cyc-fx-back{background:none}`).
      background: 'none',
      cursor: 'pointer',
      '-webkit-tap-highlight-color': 'transparent'
    }
  ],
  ['.cyc-fx-copy', {flex: '0 0 auto'}],
  ['.cyc-fx-view', {flex: '0 0 auto', display: 'flex', 'align-items': 'center', gap: '0.0625rem'}],
  [
    '.cyc-fx-vbtn',
    {
      flex: '0 0 auto',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      border: '0',
      'border-radius': '0.1875rem',
      padding: '0',
      'font-family': 'inherit',
      'font-size': '0.6875rem',
      'font-weight': '600',
      'line-height': '1',
      // Inline base fill the layered `hover:enabled:bg-[...]!` utility beats (was
      // `#cyc-app .cyc-fx-vbtn{background:none}`).
      background: 'none',
      cursor: 'pointer',
      'user-select': 'none',
      '-webkit-user-select': 'none',
      '-webkit-tap-highlight-color': 'transparent'
    }
  ],
  ['.cyc-fx-vbtn-wrap', {'font-size': '1rem'}],
  [
    '.cyc-fx-scroll',
    {
      flex: '1',
      'min-height': '0',
      overflow: 'auto',
      'overscroll-behavior': 'contain',
      '-webkit-overflow-scrolling': 'touch'
    }
  ],
  [
    '.cyc-fx-icon',
    {
      flex: '0 0 auto',
      width: '1.25rem',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      'margin-right': '0.3125rem'
    }
  ],
  ['.cyc-fx-icon-seti', {'font-family': "'seti'", 'font-size': '15px', 'line-height': '1'}],
  [
    '.cyc-fx-gmark',
    {'margin-left': 'auto', 'padding-left': '0.5rem', 'font-weight': '600', 'font-size': '0.75rem'}
  ],
  ['.cyc-fx-empty', {padding: '2rem 1.25rem', 'text-align': 'center'}],
  [
    '.cyc-fx-foot',
    {
      display: 'flex',
      'align-items': 'center',
      gap: '0.75rem',
      padding: '0.3125rem 0.625rem',
      'border-top-width': '1px',
      'border-top-style': 'solid',
      'font-size': '0.6875rem',
      'min-height': '1.75rem',
      'padding-bottom': 'calc(0.3125rem + env(safe-area-inset-bottom, 0px))'
    }
  ],
  [
    '.cyc-fx-foot-left',
    {
      'min-width': '0',
      flex: '1',
      overflow: 'hidden',
      'text-overflow': 'ellipsis',
      'white-space': 'nowrap'
    }
  ],
  ['.cyc-fx-foot-right', {flex: '0 0 auto', 'white-space': 'nowrap'}],
  ['.cyc-fx-rail', {flex: '0 0 auto', display: 'flex', 'flex-direction': 'column'}],
  [
    '.cyc-fx-rail-half',
    {
      flex: '1',
      'min-height': '0',
      'flex-direction': 'column',
      'align-items': 'center',
      'justify-content': 'center',
      gap: '0.375rem',
      border: '0',
      padding: '0',
      cursor: 'pointer',
      overflow: 'hidden',
      'font-size': '0.6875rem'
    }
  ],
  [
    '.cyc-fx-rail-label',
    {
      'writing-mode': 'vertical-rl',
      'text-orientation': 'mixed',
      'max-height': '60%',
      overflow: 'hidden',
      'text-overflow': 'ellipsis',
      'white-space': 'nowrap'
    }
  ],
  ['.cyc-fx-rail-chev', {'font-size': '0.875rem', 'line-height': '1'}]
];

function applyFxGeom(overlay: HTMLElement): void {
  const set = (el: HTMLElement, css: Record<string, string>) => {
    for (const k in css) el.style.setProperty(k, css[k]);
  };
  set(overlay, {
    position: 'absolute',
    inset: '0',
    'z-index': '11',
    display: 'flex',
    overflow: 'hidden',
    'font-size': '13px',
    'overscroll-behavior': 'contain',
    'touch-action': 'pan-y'
  });
  for (const [sel, css] of FX_GEOM) {
    overlay.querySelectorAll<HTMLElement>(sel).forEach((el) => set(el, css));
  }
}

function isCoarse(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

// Is `el` inside a selected list row? The selected-row rules invert descendant
// ink to --fx-sel-fg; the same descendant classes also appear outside any row
// (the change-viewer summary card and file-section heads), where they keep their
// base ink, so the check is by nearest `.cyc-gt-row` ancestor.
function selRow(el: Element): boolean {
  const row = el.closest('.cyc-gt-row');
  return !!row && row.classList.contains('cyc-gt-row-on');
}

export function paintGt(overlay: HTMLElement, dark: boolean): void {
  const c = gtFx(dark);
  const coarse = isCoarse();
  const wide = overlay.classList.contains('cyc-fx-wide');
  const dragging = overlay.classList.contains('cyc-fx-dragging');
  const grip = wide ? (coarse ? '-12px' : '-4px') : '';
  // Back / view button size.
  const btn = coarse ? '2rem' : '1.75rem';
  const each = (sel: string, fn: (el: HTMLElement) => void) => queryEach(overlay, sel, fn);

  // -------------------------------------------------------------------------
  // The `.cyc-fx` code-viewer chrome (was the git.css `.cyc-fx-*` block).
  applyFxGeom(overlay);

  overlay.style.background = c.editorBg;
  overlay.style.color = c.fg;

  each('.cyc-fx-a', (el) => (el.style.background = c.sideBg));
  each('.cyc-fx-b, .cyc-fx-file-scroll', (el) => (el.style.background = c.editorBg));
  each('.cyc-fx-head', (el) => (el.style.borderBottomColor = c.tabBorder));
  each('.cyc-fx-title', (el) => (el.style.color = c.tabActiveFg));
  each('.cyc-fx-crumb', (el) => (el.style.color = c.dim));
  each('.cyc-fx-copy', (el) => {
    el.style.color = c.fg;
    el.style.opacity = (el as HTMLButtonElement).disabled ? '0.35' : '';
  });
  each('.cyc-fx-empty', (el) => (el.style.color = c.dim));
  each('.cyc-fx-code-wrap', (el) => (el.style.color = c.fg));
  each('.cyc-fx-num', (el) => (el.style.color = c.lineNo));
  each('.cyc-fx-lang', (el) => {
    el.style.color = c.selFg;
    el.style.background = c.focusOutline;
    el.style.display = el.classList.contains('cyc-fx-hidden') ? 'none' : '';
  });
  each('.cyc-fx-foot', (el) => {
    el.style.background = c.tabInactiveBg;
    el.style.borderTopColor = c.tabBorder;
    el.style.color = c.dim;
  });
  each('.cyc-fx-foot-left, .cyc-fx-foot-right', (el) => {
    el.style.color = el.classList.contains('cyc-fx-warn') ? c.gModified : '';
  });
  each('.cyc-fx-code .token', (el) => (el.style.color = tokenColor(el, c)));

  // Back / view buttons: the base dim ink and box size the hover utilities (on
  // the class list) must beat, plus the `.cyc-fx-vbtn-on` pressed state.
  each('.cyc-fx-back', (el) => {
    el.style.color = c.dim;
    el.style.width = btn;
    el.style.height = btn;
  });
  each('.cyc-fx-vbtn', (el) => {
    const on = el.classList.contains('cyc-fx-vbtn-on');
    el.style.color = on ? c.focusOutline : c.dim;
    // Off restores the `background:none` base (applyFxGeom's inline fill) the
    // layered `hover:enabled:bg-[...]!` utility beats; on paints the pressed fill.
    el.style.background = on ? c.hoverBg : 'none';
    el.style.boxShadow = on ? `inset 0 0 0 1px ${c.focusOutline}` : '';
    el.style.width = btn;
    el.style.height = btn;
    // `[disabled]` dimming + default cursor (was
    // `#cyc-app .cyc-fx-vbtn[disabled]{opacity:.35;cursor:default}`).
    const disabled = (el as HTMLButtonElement).disabled;
    el.style.opacity = disabled ? '0.35' : '';
    el.style.cursor = disabled ? 'default' : 'pointer';
  });

  // Wide: col-resize splitter. Phone: two nav halves.
  each('.cyc-fx-rail', (el) => {
    el.style.background = dragging ? c.focusOutline : c.tabBorder;
    el.style.borderLeftColor = c.tabBorder;
    el.style.borderRightColor = c.tabBorder;
    el.style.borderLeftStyle = 'solid';
    el.style.borderRightStyle = 'solid';
    el.style.borderLeftWidth = wide ? '0' : '1px';
    el.style.borderRightWidth = wide ? '0' : '1px';
    el.style.position = wide ? 'relative' : '';
    el.style.overflow = wide ? 'visible' : '';
    el.style.cursor = wide ? 'col-resize' : '';
    el.style.touchAction = wide ? 'none' : '';
  });
  each('.cyc-fx-rail-half', (el) => {
    const on = el.classList.contains('cyc-fx-rail-on');
    el.style.display = wide ? 'none' : 'flex';
    el.style.background = on ? c.tabActiveBg : c.tabInactiveBg;
    el.style.color = on ? c.tabActiveFg : c.tabInactiveFg;
    el.style.boxShadow = on
      ? `inset ${el.classList.contains('cyc-fx-rail-a') ? '2px' : '-2px'} 0 0 0 ${c.tabTop}`
      : '';
  });
  each('.cyc-fx-rail-grip', (el) => {
    el.style.display = wide ? 'block' : 'none';
    el.style.position = wide ? 'absolute' : '';
    el.style.top = wide ? '0' : '';
    el.style.bottom = wide ? '0' : '';
    el.style.zIndex = wide ? '2' : '';
    el.style.cursor = wide ? 'col-resize' : '';
    el.style.touchAction = wide ? 'none' : '';
    el.style.left = grip;
    el.style.right = grip;
  });

  // -------------------------------------------------------------------------
  // The git-owned `.cyc-gt-*` / `.cyc-cx-*` skin.
  // Dim ink.
  each(
    '.cyc-gt-refresh,.cyc-gt-track,.cyc-gt-caret,.cyc-gt-viewtag,.cyc-gt-brow-up,' +
      '.cyc-gt-bcur,.cyc-gt-sec,.cyc-gt-review,.cyc-gt-none,.cyc-gt-act-off,' +
      '.cyc-cx-stepat,.cyc-cx-nodiff',
    (el) => (el.style.color = c.dim)
  );

  // Foreground ink.
  each(
    '.cyc-gt-branch-name,.cyc-gt-ab,.cyc-gt-cmp,.cyc-gt-brow,.cyc-cx-fpath,.cyc-cx-stepbtn',
    (el) => (el.style.color = c.fg)
  );

  // Warn ink.
  each('.cyc-gt-warn,.cyc-cx-cap', (el) => (el.style.color = c.gModified));

  // Change-viewer file-section surfaces (was --fx-side-bg / --fx-tab-border).
  each('.cyc-cx-fhead', (el) => {
    el.style.background = c.sideBg;
    el.style.borderBottomColor = c.tabBorder;
    el.style.minHeight = coarse ? '34px' : '';
  });
  each('.cyc-cx-file', (el) => (el.style.borderTopColor = c.tabBorder));

  // Selected rows invert to sel-fg; unselected names keep git-status colour.
  each('.cyc-gt-name,.cyc-fx-gmark', (el) => {
    if (selRow(el)) {
      el.style.color = c.selFg;
      el.style.opacity = '';
      return;
    }
    const g = gitClass(el);
    el.style.color = g ? c[GIT_COLOR[g]] : '';
    el.style.opacity = g === 'gI' ? '0.7' : '';
  });
  each('.cyc-cx-plus,.cyc-cx-minus', (el) => {
    el.style.color = selRow(el) ? c.selFg : '';
  });
  each('.cyc-gt-dir,.cyc-gt-sha,.cyc-gt-when,.cyc-cx-skip', (el) => {
    el.style.color = selRow(el) ? c.selFg : c.dim;
  });
  each('.cyc-gt-from,.cyc-gt-refs', (el) => (el.style.color = c.dim));

  // The selected-row fill and the coarse-pointer row height.
  each('.cyc-gt-row', (el) => {
    el.style.background = el.classList.contains('cyc-gt-row-on') ? c.selBg : '';
    el.style.minHeight = coarse ? '36px' : '';
  });

  // Coarse-pointer control sizes (were `@media (pointer: coarse)`).
  each('.cyc-cx-stepbtn', (el) => {
    el.style.width = coarse ? '1.75rem' : '';
    el.style.height = coarse ? '1.75rem' : '';
  });
  each('.cyc-gt-act', (el) => {
    el.style.width = coarse ? '1.75rem' : '';
    el.style.height = coarse ? '1.75rem' : '';
  });
}

export type GtPaint = {repaint: () => void; destroy: () => void};

export function createGtPaint(overlay: HTMLElement, dark: boolean): GtPaint {
  const repaint = () => paintGt(overlay, dark);
  let ptr: MediaQueryList | undefined;
  const onPtr = () => repaint();
  try {
    ptr = matchMedia('(pointer: coarse)');
    ptr.addEventListener('change', onPtr);
  } catch {
    ptr = undefined;
  }
  return {repaint, destroy: () => ptr?.removeEventListener('change', onPtr)};
}
