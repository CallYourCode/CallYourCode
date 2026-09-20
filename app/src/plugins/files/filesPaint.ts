// Files-plugin presentation paint. Hover roles use class utilities so inline color cannot beat `:hover`.

import {queryEach, swapClasses} from '@/components/domHelpers';

type FxColors = {
  editorBg: string;
  sideBg: string;
  fg: string;
  dim: string;
  selBg: string;
  selFg: string;
  focusOutline: string;
  indent: string;
  lineNo: string;
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
  dAdded: string;
  dModified: string;
  dDeleted: string;
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

export const FX_DAY: FxColors = {
  editorBg: '#ffffff',
  sideBg: '#f8f8f8',
  fg: '#3b3b3b',
  dim: '#6f6f6f',
  selBg: '#0060c0',
  selFg: '#ffffff',
  focusOutline: '#0078d4',
  indent: '#a9a9a9',
  lineNo: '#6e7681',
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
  dAdded: '#48985d',
  dModified: '#2090d3',
  dDeleted: '#e51400',
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

export const FX_NIGHT: FxColors = {
  editorBg: '#1f1f1f',
  sideBg: '#181818',
  fg: '#cccccc',
  dim: '#9d9d9d',
  selBg: '#04395e',
  selFg: '#ffffff',
  focusOutline: '#0078d4',
  indent: '#585858',
  lineNo: '#6e7681',
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
  dAdded: '#2ea043',
  dModified: '#0078d4',
  dDeleted: '#f85149',
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

// Git status letter class (`.cyc-fx-g<code>`) -> palette colour key.
const GIT_COLOR: Record<string, keyof FxColors> = {
  gM: 'gModified',
  gA: 'gAdded',
  gD: 'gDeleted',
  gU: 'gUntracked',
  gR: 'gRenamed',
  gC: 'gConflict',
  gI: 'gIgnored'
};

// Prism token groups in files.css source order (a later group wins on the rare
// multi-class token, matching that file's equal-specificity cascade).
const TOKEN_GROUPS: Array<{names: string[]; key: keyof FxColors}> = [
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

// Hover utilities. `!` beats inline background/opacity from applyGeom.
const BACK_DAY = ['text-[#6f6f6f]', 'hover:bg-[#f2f2f2]!', 'hover:text-[#3b3b3b]'];
const BACK_NIGHT = ['text-[#9d9d9d]', 'hover:bg-[#2a2d2e]!', 'hover:text-[#cccccc]'];
const VBTN_DAY = ['text-[#6f6f6f]', 'hover:enabled:bg-[#f2f2f2]!', 'hover:enabled:text-[#3b3b3b]'];
const VBTN_NIGHT = [
  'text-[#9d9d9d]',
  'hover:enabled:bg-[#2a2d2e]!',
  'hover:enabled:text-[#cccccc]'
];
const VBTN_ON_DAY = ['bg-[#f2f2f2]!', 'text-[#0078d4]!', 'shadow-[inset_0_0_0_1px_#0078d4]!'];
const VBTN_ON_NIGHT = ['bg-[#2a2d2e]!', 'text-[#0078d4]!', 'shadow-[inset_0_0_0_1px_#0078d4]!'];
const ROW_DAY = ['[&:hover:not(.cyc-fx-sel)]:bg-[#f2f2f2]'];
const ROW_NIGHT = ['[&:hover:not(.cyc-fx-sel)]:bg-[#2a2d2e]'];
const TABX_DAY = ['hover:bg-[#f2f2f2]', 'hover:opacity-100!'];
const TABX_NIGHT = ['hover:bg-[#2a2d2e]', 'hover:opacity-100!'];

const BACK_ALL = [...BACK_DAY, ...BACK_NIGHT];
const VBTN_ALL = [...VBTN_DAY, ...VBTN_NIGHT, ...VBTN_ON_DAY, ...VBTN_ON_NIGHT];
const ROW_ALL = [...ROW_DAY, ...ROW_NIGHT];
const TABX_ALL = [...TABX_DAY, ...TABX_NIGHT];

function isDark(): boolean {
  return document.documentElement.dataset.theme === 'dark';
}

function isCoarse(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function gitClass(el: HTMLElement): string | null {
  for (const k in GIT_COLOR) if (el.classList.contains(`cyc-fx-${k}`)) return k;
  return null;
}

function paintGitInk(el: HTMLElement, sel: boolean, c: FxColors): void {
  const g = gitClass(el);
  el.style.color = sel ? c.selFg : g ? c[GIT_COLOR[g]] : c.fg;
  el.style.opacity = g === 'gI' ? '0.7' : '';
}

function tokenColor(el: HTMLElement, c: FxColors): string {
  let col = c.tPunct;
  for (const group of TOKEN_GROUPS) {
    if (group.names.some((n) => el.classList.contains(n))) col = c[group.key];
  }
  return col;
}

// Chrome geometry. Applied before theme paint so `border:0` cannot wipe colours.
const GEOM: Array<[string, Record<string, string>]> = [
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
  ['.cyc-fx-tree', {padding: '0.25rem 0'}],
  [
    '.cyc-fx-row',
    {
      display: 'flex',
      'align-items': 'center',
      'padding-right': '0.5rem',
      cursor: 'pointer',
      'user-select': 'none',
      'white-space': 'nowrap'
    }
  ],
  [
    '.cyc-fx-indent',
    {
      flex: '0 0 auto',
      'align-self': 'stretch',
      'background-size': '12px 100%',
      'background-position': '8px 0',
      opacity: '0.55'
    }
  ],
  [
    '.cyc-fx-twist',
    {
      flex: '0 0 auto',
      width: '1.125rem',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center'
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
  ['.cyc-fx-name', {'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis'}],
  ['.cyc-fx-link', {'font-style': 'italic'}],
  [
    '.cyc-fx-gmark',
    {'margin-left': 'auto', 'padding-left': '0.5rem', 'font-weight': '600', 'font-size': '0.75rem'}
  ],
  ['.cyc-fx-img', {display: 'block', 'max-width': '100%', margin: '1rem auto'}],
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
  [
    '.cyc-fx-tabs',
    {
      flex: '0 0 auto',
      'align-items': 'stretch',
      'min-width': '0',
      'overflow-x': 'auto',
      'overflow-y': 'hidden',
      'scrollbar-width': 'none',
      '-webkit-overflow-scrolling': 'touch'
    }
  ],
  [
    '.cyc-fx-tab',
    {
      flex: '0 0 auto',
      display: 'flex',
      'align-items': 'center',
      gap: '0.375rem',
      'max-width': '11rem',
      'min-width': '0',
      padding: '0 0.375rem 0 0.5rem',
      border: '0',
      'border-right-width': '1px',
      'border-right-style': 'solid',
      'font-family': 'inherit',
      'font-size': '0.75rem',
      cursor: 'pointer',
      'user-select': 'none',
      '-webkit-tap-highlight-color': 'transparent'
    }
  ],
  [
    '.cyc-fx-tab-icon',
    {flex: '0 0 auto', 'font-family': "'seti'", 'font-size': '14px', 'line-height': '1'}
  ],
  [
    '.cyc-fx-tab-name',
    {'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap'}
  ],
  [
    '.cyc-fx-tab-x',
    {
      flex: '0 0 auto',
      width: '1.25rem',
      height: '1.25rem',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      'border-radius': '0.1875rem',
      'font-size': '1rem',
      'line-height': '1',
      // Inline base dim the layered `hover:opacity-100!` utility beats (was
      // `#cyc-app .cyc-fx-tab-x{opacity:.55}`).
      opacity: '0.55'
    }
  ],
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

// Apply the constant geometry inline. The overlay itself carries the `.cyc-fx`
// box; `.cyc-fx-lang`'s only stateful bit (the `.cyc-fx-hidden` collapse) is the
// finite display decision resolved here.
function applyGeom(overlay: HTMLElement): void {
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
  for (const [sel, css] of GEOM) {
    overlay.querySelectorAll<HTMLElement>(sel).forEach((el) => set(el, css));
  }
  overlay.querySelectorAll<HTMLElement>('.cyc-fx-lang').forEach((el) => {
    el.style.display = el.classList.contains('cyc-fx-hidden') ? 'none' : '';
  });
}

export function paintFx(overlay: HTMLElement): void {
  const dark = isDark();
  const c = dark ? FX_NIGHT : FX_DAY;
  const coarse = isCoarse();
  const wide = overlay.classList.contains('cyc-fx-wide');
  const dragging = overlay.classList.contains('cyc-fx-dragging');
  const grip = wide ? (coarse ? '-12px' : '-4px') : '';
  // Coarse pointer grows button size.
  const btn = coarse ? '2rem' : '1.75rem';

  applyGeom(overlay);

  const each = (sel: string, fn: (el: HTMLElement) => void) => queryEach(overlay, sel, fn);

  overlay.style.background = c.editorBg;
  overlay.style.color = c.fg;

  each('.cyc-fx-a', (el) => (el.style.background = c.sideBg));
  each('.cyc-fx-b', (el) => (el.style.background = c.editorBg));
  each('.cyc-fx-file-scroll', (el) => (el.style.background = c.editorBg));
  each('.cyc-fx-head', (el) => (el.style.borderBottomColor = c.tabBorder));
  each('.cyc-fx-title', (el) => (el.style.color = c.tabActiveFg));
  each('.cyc-fx-crumb', (el) => (el.style.color = c.dim));
  each('.cyc-fx-copy', (el) => {
    el.style.color = c.fg;
    el.style.opacity = (el as HTMLButtonElement).disabled ? '0.35' : '';
  });
  each('.cyc-fx-empty', (el) => (el.style.color = c.dim));
  each('.cyc-fx-twist', (el) => (el.style.color = c.dim));
  each('.cyc-fx-icon-folder', (el) => (el.style.color = c.dim));
  each('.cyc-fx-code-wrap', (el) => (el.style.color = c.fg));

  each('.cyc-fx-lang', (el) => {
    el.style.color = c.selFg;
    el.style.background = c.focusOutline;
  });
  each('.cyc-fx-indent', (el) => {
    el.style.backgroundImage = `linear-gradient(to right, ${c.indent} 1px, transparent 1px)`;
  });
  each('.cyc-fx-num', (el) => {
    el.style.background = c.editorBg;
    el.style.color = c.lineNo;
  });
  each('.cyc-fx-gline', (el) => {
    el.style.background = c.editorBg;
    el.style.borderLeftColor = el.classList.contains('cyc-fx-d-added')
      ? c.dAdded
      : el.classList.contains('cyc-fx-d-modified')
        ? c.dModified
        : 'transparent';
  });
  each('.cyc-fx-d-deleted-mark', (el) => (el.style.borderLeftColor = c.dDeleted));

  each('.cyc-fx-foot', (el) => {
    el.style.background = c.tabInactiveBg;
    el.style.borderTopColor = c.tabBorder;
    el.style.color = c.dim;
  });
  each('.cyc-fx-foot-left, .cyc-fx-foot-right', (el) => {
    el.style.color = el.classList.contains('cyc-fx-warn') ? c.gModified : '';
  });

  // Phone: file scroll above the tab strip. Wide: tab strip under the header.
  each('.cyc-fx-b > .cyc-fx-head', (el) => (el.style.order = '0'));
  each('.cyc-fx-b > .cyc-fx-scroll', (el) => (el.style.order = wide ? '2' : '1'));
  each('.cyc-fx-b > .cyc-fx-foot', (el) => (el.style.order = '3'));

  each('.cyc-fx-tabs', (el) => {
    el.style.display = el.classList.contains('cyc-fx-hidden') ? 'none' : 'flex';
    el.style.background = c.tabInactiveBg;
    el.style.borderTopColor = c.tabBorder;
    el.style.borderBottomColor = c.tabBorder;
    el.style.borderTopStyle = 'solid';
    el.style.borderBottomStyle = 'solid';
    el.style.order = wide ? '1' : '2';
    // Wide keeps the divider on the bottom edge; the phone override moves the
    // 1px divider to the top edge and widens the safe-area gutter.
    el.style.borderTopWidth = wide ? '0' : '1px';
    el.style.borderBottomWidth = wide ? '1px' : '0';
    el.style.paddingInline = wide
      ? 'max(0.5rem, env(safe-area-inset-left, 0px)) max(0.5rem, env(safe-area-inset-right, 0px))'
      : 'max(1rem, env(safe-area-inset-left, 0px)) max(1rem, env(safe-area-inset-right, 0px))';
  });
  each('.cyc-fx-tab', (el) => {
    const on = el.classList.contains('cyc-fx-tab-on');
    el.style.borderRightColor = c.tabBorder;
    el.style.background = on ? c.tabActiveBg : c.tabInactiveBg;
    el.style.color = on ? c.tabActiveFg : c.tabInactiveFg;
    el.style.boxShadow = on ? `inset 0 ${wide ? '2px' : '-2px'} 0 0 ${c.tabTop}` : '';
    el.style.height = coarse ? '2.25rem' : '2rem';
  });
  each('.cyc-fx-tab-x', (el) => swapClasses(el, TABX_ALL, dark ? TABX_NIGHT : TABX_DAY));

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

  each('.cyc-fx-back', (el) => {
    swapClasses(el, BACK_ALL, dark ? BACK_NIGHT : BACK_DAY);
    el.style.width = btn;
    el.style.height = btn;
  });
  each('.cyc-fx-vbtn', (el) => {
    const base = dark ? VBTN_NIGHT : VBTN_DAY;
    const on = el.classList.contains('cyc-fx-vbtn-on');
    swapClasses(el, VBTN_ALL, on ? [...base, ...(dark ? VBTN_ON_NIGHT : VBTN_ON_DAY)] : base);
    el.style.width = btn;
    el.style.height = btn;
    // `[disabled]` dimming + default cursor (was
    // `#cyc-app .cyc-fx-vbtn[disabled]{opacity:.35;cursor:default}`).
    const disabled = (el as HTMLButtonElement).disabled;
    el.style.opacity = disabled ? '0.35' : '';
    el.style.cursor = disabled ? 'default' : 'pointer';
  });

  each('.cyc-fx-row', (el) => {
    const sel = el.classList.contains('cyc-fx-sel');
    el.style.background = sel ? c.selBg : '';
    el.style.boxShadow = sel ? `inset 0 0 0 1px ${c.focusOutline}` : '';
    swapClasses(el, ROW_ALL, dark ? ROW_NIGHT : ROW_DAY);
    const name = el.querySelector<HTMLElement>('.cyc-fx-name');
    if (name) paintGitInk(name, sel, c);
    const mark = el.querySelector<HTMLElement>('.cyc-fx-gmark');
    if (mark) paintGitInk(mark, sel, c);
  });

  each('.cyc-fx-code .token', (el) => (el.style.color = tokenColor(el, c)));
}

export type FxPaint = {repaint: () => void; destroy: () => void};

// Wire `paintFx` to live theme (data-theme) and pointer flips for `overlay`,
// returning the repaint the render code calls after each DOM change and a
// teardown that detaches the observers.
export function createFxPaint(overlay: HTMLElement): FxPaint {
  const repaint = () => paintFx(overlay);

  const themeObserver = new MutationObserver(repaint);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });

  let ptr: MediaQueryList | undefined;
  const onPtr = () => repaint();
  try {
    ptr = matchMedia('(pointer: coarse)');
    ptr.addEventListener('change', onPtr);
  } catch {
    ptr = undefined;
  }

  return {
    repaint,
    destroy: () => {
      themeObserver.disconnect();
      ptr?.removeEventListener('change', onPtr);
    }
  };
}
