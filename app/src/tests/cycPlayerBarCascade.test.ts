import {afterAll, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Real-Chromium cascade coverage for the audio player bar.

import {createAudioPlayerBar} from '../features/chat/navigation/audioPlayerBar';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

async function compileTailwind(candidates: string[]): Promise<string> {
  const entry = readFileSync(resolve(SHELL, 'tailwind.css'), 'utf8');
  const compiler = await compile(entry, {
    base: SHELL,
    async loadStylesheet(id: string, base: string) {
      const path =
        id === 'tailwindcss'
          ? resolve(TW_DIR, 'index.css')
          : resolve(base, id.replace(/^tailwindcss\//, `${TW_DIR}/`));
      return {base: dirname(path), content: readFileSync(path, 'utf8'), path};
    },
    async loadModule(id: string) {
      return {path: id, base: SHELL, module: {} as never};
    }
  });
  return compiler.build(candidates);
}

const tokenize = (className: string) => className.trim().split(/\s+/).filter(Boolean);

// Distinct theme tokens make computed-color assertions unambiguous.
const THEME_VARS = `
:root {
  --cyc-surface: rgb(30, 31, 32);
  --cyc-accent: rgb(1, 2, 3);
  --cyc-text-muted: rgb(4, 5, 6);
  --cyc-text-muted-tint: rgb(7, 8, 9);
}
html[data-theme='dark'] {
  --cyc-surface: rgb(40, 41, 42);
  --cyc-accent: rgb(10, 11, 12);
  --cyc-text-muted: rgb(13, 14, 15);
  --cyc-text-muted-tint: rgb(16, 17, 18);
}
`;

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

type Classes = {
  shownRootClass: string;
  hiddenRootClass: string;
  wrapperClass: string;
  toggleClass: string;
  contentClass: string;
  titleClass: string;
  subtitleClass: string;
  saidClass: string;
  utilsClass: string;
  closeClass: string;
  progressWrapClass: string;
  progressLineClass: string;
  filledClass: string;
};

// Build the real producer with optional playback-state overrides.
function producedClasses(overrides: {loading?: boolean; playing?: boolean} = {}): Classes {
  const bar = createAudioPlayerBar({onToggle: () => {}, onOpen: () => {}, onClose: () => {}});
  bar.show({chat: 'Alice', text: 'a message', playing: true, loading: false, ...overrides});
  const shownRootClass = bar.el.className;
  const wrapper = bar.el.querySelector<HTMLElement>('.cyc-player-wrapper')!;
  const toggle = bar.el.querySelector<HTMLElement>('.cyc-player-ico')!;
  const content = bar.el.querySelector<HTMLElement>('.cyc-player-content')!;
  const title = bar.el.querySelector<HTMLElement>('.cyc-player-title')!;
  const subtitle = bar.el.querySelector<HTMLElement>('.cyc-player-subtitle')!;
  const said = bar.el.querySelector<HTMLElement>('.cyc-player-said')!;
  const utils = bar.el.querySelector<HTMLElement>('.cyc-player-wrapper-utils')!;
  const close = bar.el.querySelector<HTMLElement>('.cyc-player-close')!;
  const progressWrap = bar.el.querySelector<HTMLElement>('.cyc-player-progress-wrapper')!;
  const progressLine = bar.el.querySelector<HTMLElement>('.cyc-player-progress')!;
  const filled = bar.el.querySelector<HTMLElement>('.cyc-player-progress-filled')!;
  const cls: Classes = {
    shownRootClass,
    hiddenRootClass: '',
    wrapperClass: wrapper.className,
    toggleClass: toggle.className,
    contentClass: content.className,
    titleClass: title.className,
    subtitleClass: subtitle.className,
    saidClass: said.className,
    utilsClass: utils.className,
    closeClass: close.className,
    progressWrapClass: progressWrap.className,
    progressLineClass: progressLine.className,
    filledClass: filled.className
  };
  bar.show(null);
  cls.hiddenRootClass = bar.el.className;
  return cls;
}

type Measured = {
  rootDisplay: string;
  rootJustify: string;
  rootAlign: string;
  rootPadTop: string;
  rootPadLeft: string;
  rootPadRight: string;
  rootBg: string;
  rootPosition: string;
  rootHeight: string;
  hiddenDisplay: string;
  wrapDisplay: string;
  wrapGrow: string;
  wrapShrink: string;
  wrapAlign: string;
  wrapMaxWidth: string;
  wrapOverflow: string;
  wrapZ: string;
  wrapCursor: string;
  wrapPadLeft: string;
  wrapPadRight: string;
  wrapRadius: string;
  contentGrow: string;
  contentShrink: string;
  contentOverflow: string;
  contentPosition: string;
  contentPointer: string;
  contentMarginLeft: string;
  contentMarginRight: string;
  toggleShrink: string;
  toggleDisplay: string;
  toggleJustify: string;
  toggleFont: string;
  toggleColor: string;
  toggleOpacity: string;
  toggleMarginLeft: string;
  toggleMarginRight: string;
  closeShrink: string;
  titleFontSize: string;
  titleLineHeight: string;
  titleWeight: string;
  titleWhiteSpace: string;
  titleTextOverflow: string;
  titleOverflow: string;
  titleMaxWidth: string;
  titleWidth: number;
  titleColor: string;
  subtitleFontSize: string;
  subtitleLineHeight: string;
  subtitleWeight: string;
  subtitleWhiteSpace: string;
  subtitleTextOverflow: string;
  subtitleOverflow: string;
  subtitleMaxWidth: string;
  subtitleWidth: number;
  subtitleColor: string;
  saidFontSize: string;
  saidColor: string;
  saidOpacity: string;
  contentInnerWidth: number;
  rootRadius: string;
  progressWrapPosition: string;
  progressWrapTop: string;
  progressWrapLeft: string;
  progressWrapRight: string;
  progressWrapBottom: string;
  progressWrapOverflow: string;
  progressWrapRadius: string;
  linePosition: string;
  lineLeft: string;
  lineRight: string;
  lineBottom: string;
  lineHeight: string;
  lineBg: string;
  lineOverflow: string;
  lineTransform: string;
  filledHeight: string;
  filledWidth: string;
  filledBg: string;
};

async function measure(
  cls: Classes,
  theme: 'day' | 'night',
  dir: 'ltr' | 'rtl' = 'ltr',
  viewport = 900
): Promise<Measured> {
  const utilities = await compileTailwind([
    ...tokenize(cls.shownRootClass),
    ...tokenize(cls.hiddenRootClass),
    ...tokenize(cls.wrapperClass),
    ...tokenize(cls.toggleClass),
    ...tokenize(cls.contentClass),
    ...tokenize(cls.titleClass),
    ...tokenize(cls.subtitleClass),
    ...tokenize(cls.saidClass),
    ...tokenize(cls.utilsClass),
    ...tokenize(cls.closeClass),
    ...tokenize(cls.progressWrapClass),
    ...tokenize(cls.progressLineClass),
    ...tokenize(cls.filledClass)
  ]);
  const shell =
    // Include reset.css so `.cyc-off { display:none !important }` matches production load order.
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    THEME_VARS;
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  const dirAttr = dir === 'rtl' ? " dir='rtl'" : '';
  const html =
    `<!DOCTYPE html><html${themeAttr}${dirAttr}><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell */\n${shell}</style></head><body>` +
    `<div id="root" class="${cls.shownRootClass}">` +
    `<div id="wrapper" class="${cls.wrapperClass}">` +
    `<button id="toggle" class="${cls.toggleClass}"></button>` +
    `<div id="content" class="${cls.contentClass}">` +
    `<div id="title" class="${cls.titleClass}">Alice</div>` +
    `<div id="subtitle" class="${cls.subtitleClass}">` +
    `<span class="cyc-player-time">0:00</span> · ` +
    `<span id="said" class="${cls.saidClass}">a message</span>` +
    `</div>` +
    `</div>` +
    `<div id="utils" class="${cls.utilsClass}">` +
    `<button id="close" class="${cls.closeClass}"></button>` +
    `</div>` +
    `</div>` +
    `<div id="progressWrap" class="${cls.progressWrapClass}">` +
    `<div id="progressLine" class="${cls.progressLineClass}">` +
    `<div id="filled" class="${cls.filledClass}"></div>` +
    `</div>` +
    `</div>` +
    `</div>` +
    `<div id="hidden" class="${cls.hiddenRootClass}"></div>` +
    `</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setViewportSize({width: viewport, height: 800});
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!);
      const r = cs('#root');
      const hidden = cs('#hidden');
      const w = cs('#wrapper');
      const c = cs('#content');
      const t = cs('#toggle');
      const x = cs('#close');
      const ti = cs('#title');
      const su = cs('#subtitle');
      const sa = cs('#said');
      const pw = cs('#progressWrap');
      const pl = cs('#progressLine');
      const fi = cs('#filled');
      const contentEl = document.querySelector<HTMLElement>('#content')!;
      const contentInnerWidth =
        contentEl.clientWidth -
        parseFloat(c.getPropertyValue('padding-left')) -
        parseFloat(c.getPropertyValue('padding-right'));
      return {
        rootDisplay: r.getPropertyValue('display'),
        rootJustify: r.getPropertyValue('justify-content'),
        rootAlign: r.getPropertyValue('align-items'),
        rootPadTop: r.getPropertyValue('padding-top'),
        rootPadLeft: r.getPropertyValue('padding-left'),
        rootPadRight: r.getPropertyValue('padding-right'),
        rootBg: r.getPropertyValue('background-color'),
        rootPosition: r.getPropertyValue('position'),
        rootHeight: r.getPropertyValue('height'),
        hiddenDisplay: hidden.getPropertyValue('display'),
        wrapDisplay: w.getPropertyValue('display'),
        wrapGrow: w.getPropertyValue('flex-grow'),
        wrapShrink: w.getPropertyValue('flex-shrink'),
        wrapAlign: w.getPropertyValue('align-items'),
        wrapMaxWidth: w.getPropertyValue('max-width'),
        wrapOverflow: w.getPropertyValue('overflow'),
        wrapZ: w.getPropertyValue('z-index'),
        wrapCursor: w.getPropertyValue('cursor'),
        wrapPadLeft: w.getPropertyValue('padding-left'),
        wrapPadRight: w.getPropertyValue('padding-right'),
        wrapRadius: w.getPropertyValue('border-top-left-radius'),
        contentGrow: c.getPropertyValue('flex-grow'),
        contentShrink: c.getPropertyValue('flex-shrink'),
        contentOverflow: c.getPropertyValue('overflow'),
        contentPosition: c.getPropertyValue('position'),
        contentPointer: c.getPropertyValue('pointer-events'),
        contentMarginLeft: c.getPropertyValue('margin-left'),
        contentMarginRight: c.getPropertyValue('margin-right'),
        toggleShrink: t.getPropertyValue('flex-shrink'),
        toggleDisplay: t.getPropertyValue('display'),
        toggleJustify: t.getPropertyValue('justify-content'),
        toggleFont: t.getPropertyValue('font-size'),
        toggleColor: t.getPropertyValue('color'),
        toggleOpacity: t.getPropertyValue('opacity'),
        toggleMarginLeft: t.getPropertyValue('margin-left'),
        toggleMarginRight: t.getPropertyValue('margin-right'),
        closeShrink: x.getPropertyValue('flex-shrink'),
        titleFontSize: ti.getPropertyValue('font-size'),
        titleLineHeight: ti.getPropertyValue('line-height'),
        titleWeight: ti.getPropertyValue('font-weight'),
        titleWhiteSpace: ti.getPropertyValue('white-space'),
        titleTextOverflow: ti.getPropertyValue('text-overflow'),
        titleOverflow: ti.getPropertyValue('overflow'),
        titleMaxWidth: ti.getPropertyValue('max-width'),
        titleWidth: parseFloat(ti.getPropertyValue('width')),
        titleColor: ti.getPropertyValue('color'),
        subtitleFontSize: su.getPropertyValue('font-size'),
        subtitleLineHeight: su.getPropertyValue('line-height'),
        subtitleWeight: su.getPropertyValue('font-weight'),
        subtitleWhiteSpace: su.getPropertyValue('white-space'),
        subtitleTextOverflow: su.getPropertyValue('text-overflow'),
        subtitleOverflow: su.getPropertyValue('overflow'),
        subtitleMaxWidth: su.getPropertyValue('max-width'),
        subtitleWidth: parseFloat(su.getPropertyValue('width')),
        subtitleColor: su.getPropertyValue('color'),
        saidFontSize: sa.getPropertyValue('font-size'),
        saidColor: sa.getPropertyValue('color'),
        saidOpacity: sa.getPropertyValue('opacity'),
        contentInnerWidth,
        rootRadius: r.getPropertyValue('border-top-left-radius'),
        progressWrapPosition: pw.getPropertyValue('position'),
        progressWrapTop: pw.getPropertyValue('top'),
        progressWrapLeft: pw.getPropertyValue('left'),
        progressWrapRight: pw.getPropertyValue('right'),
        progressWrapBottom: pw.getPropertyValue('bottom'),
        progressWrapOverflow: pw.getPropertyValue('overflow'),
        progressWrapRadius: pw.getPropertyValue('border-top-left-radius'),
        linePosition: pl.getPropertyValue('position'),
        lineLeft: pl.getPropertyValue('left'),
        lineRight: pl.getPropertyValue('right'),
        lineBottom: pl.getPropertyValue('bottom'),
        lineHeight: pl.getPropertyValue('height'),
        lineBg: pl.getPropertyValue('background-color'),
        lineOverflow: pl.getPropertyValue('overflow'),
        lineTransform: pl.getPropertyValue('transform'),
        filledHeight: fi.getPropertyValue('height'),
        filledWidth: fi.getPropertyValue('width'),
        filledBg: fi.getPropertyValue('background-color')
      };
    });
  } finally {
    await page.close();
  }
}

// Float-offset tokens used by placement probes.
const FLOAT_TOKENS = `
:root {
  --cyc-action-float-size: 3.5rem;
  --cyc-action-float-offset: 1rem;
  --cyc-safe-bottom: 11px;
}
@media (max-width: 550px) {
  :root {
    --cyc-action-float-offset: 1.5rem;
  }
}
`;

type Placement = {
  position: string;
  z: string;
  left: string;
  right: string;
  bottom: string;
  height: string;
  radius: string;
  bg: string;
  shadow: string;
  overflow: string;
};

// Mount inside a positioned viewport for placement assertions.
async function measurePlacement(
  theme: 'day' | 'night',
  dir: 'ltr' | 'rtl',
  viewport: number
): Promise<Placement> {
  const cls = producedClasses();
  const utilities = await compileTailwind(tokenize(cls.shownRootClass));
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    THEME_VARS +
    FLOAT_TOKENS;
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  const dirAttr = dir === 'rtl' ? " dir='rtl'" : '';
  const html =
    `<!DOCTYPE html><html${themeAttr}${dirAttr}><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head><body>` +
    `<div id="parent" style="position:relative;width:${viewport}px;height:800px">` +
    `<div id="root" class="${cls.shownRootClass}"></div>` +
    `</div></body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setViewportSize({width: viewport, height: 800});
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#root')!);
      return {
        position: cs.getPropertyValue('position'),
        z: cs.getPropertyValue('z-index'),
        left: cs.getPropertyValue('left'),
        right: cs.getPropertyValue('right'),
        bottom: cs.getPropertyValue('bottom'),
        height: cs.getPropertyValue('height'),
        radius: cs.getPropertyValue('border-top-left-radius'),
        bg: cs.getPropertyValue('background-color'),
        shadow: cs.getPropertyValue('box-shadow'),
        overflow: cs.getPropertyValue('overflow')
      };
    });
  } finally {
    await page.close();
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
});
afterAll(async () => {
  await browser?.close();
});

describe('player-bar cascade: current box is reproduced, surviving skin still wins', () => {
  // Root font-size is 15px, so rem utilities resolve against that.
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'day'],
    ['ltr', 'night'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: producer-owned root/wrapper/content box + surviving .cyc-player-* skin`, async () => {
      const s = await measure(producedClasses(), theme, dir);

      // Root box.
      expect(s.rootDisplay).toBe('flex');
      expect(s.rootJustify).toBe('space-between');
      expect(s.rootAlign).toBe('center');
      expect(s.rootPadTop).toBe('4px'); // p-1
      expect(s.rootPadLeft).toBe('4px');
      expect(s.rootPadRight).toBe('4px');
      expect(s.rootBg).toBe(theme === 'night' ? 'rgb(40, 41, 42)' : 'rgb(30, 31, 32)');
      expect(s.rootPosition).toBe('absolute'); 
      expect(s.rootHeight).toBe('48px'); 

      // Wrapper box and physical padding.
      expect(s.wrapDisplay).toBe('flex');
      expect(s.wrapGrow).toBe('1'); // flex-auto -> 1 1 auto
      expect(s.wrapShrink).toBe('1');
      expect(s.wrapAlign).toBe('center');
      expect(s.wrapMaxWidth).toBe('100%');
      expect(s.wrapOverflow).toBe('visible'); // = default; old .cyc-bar-wrap overflow:hidden gone
      expect(s.wrapZ).toBe('auto');
      expect(s.wrapCursor).toBe('default'); 
      expect(s.wrapPadLeft).toBe('8px'); // pl-2 = 0.5rem
      expect(s.wrapPadRight).toBe('4px'); // pr-1 = 0.25rem
      expect(s.wrapRadius).toBe('6px'); // retained html body .cyc-bar-wrap radius

      
      // Content box; logical margins flip in RTL.
      expect(s.contentGrow).toBe('1');
      expect(s.contentShrink).toBe('1');
      expect(s.contentOverflow).toBe('hidden');
      expect(s.contentPosition).toBe('relative');
      expect(s.contentPointer).toBe('all'); 
      if (dir === 'ltr') {
        expect(s.contentMarginRight).toBe('8px'); // me-2 trailing
        expect(s.contentMarginLeft).toBe('4px'); // skin margin-inline-start
      } else {
        expect(s.contentMarginLeft).toBe('8px'); // me-2 trailing (flipped)
        expect(s.contentMarginRight).toBe('4px'); // skin margin-inline-start (flipped)
      }

      // Icon buttons.
      expect(s.toggleShrink).toBe('0');
      expect(s.toggleDisplay).toBe('flex');
      expect(s.toggleJustify).toBe('center');
      expect(s.toggleFont).toBe('24px');
      expect(s.toggleColor).toBe(theme === 'night' ? 'rgb(10, 11, 12)' : 'rgb(1, 2, 3)');
      expect(s.toggleOpacity).toBe('1');
      expect(s.toggleMarginLeft).toBe('0px');
      expect(s.toggleMarginRight).toBe('0px');
      expect(s.closeShrink).toBe('0');

      // Title/subtitle type.
      expect(s.titleFontSize).toBe('14px');
      expect(s.titleLineHeight).toBe('18px');
      expect(s.titleWeight).toBe('500'); 
      expect(s.titleWhiteSpace).toBe('nowrap');
      expect(s.titleTextOverflow).toBe('ellipsis');
      expect(s.titleOverflow).toBe('hidden');
      expect(s.titleMaxWidth).toBe('100%');

      expect(s.subtitleFontSize).toBe('14px');
      expect(s.subtitleLineHeight).toBe('18px');
      expect(s.subtitleWeight).toBe('400');
      expect(s.subtitleWhiteSpace).toBe('nowrap');
      expect(s.subtitleTextOverflow).toBe('ellipsis');
      expect(s.subtitleOverflow).toBe('hidden');
      expect(s.subtitleMaxWidth).toBe('100%');

      const secondary = theme === 'night' ? 'rgb(13, 14, 15)' : 'rgb(4, 5, 6)';
      expect(s.subtitleColor).toBe(secondary);
      expect(s.titleColor).not.toBe(secondary);

      // Full-width text with subpixel slack against the content box.
      expect(Math.abs(s.titleWidth - s.contentInnerWidth)).toBeLessThan(1);
      expect(Math.abs(s.subtitleWidth - s.contentInnerWidth)).toBeLessThan(1);
      expect(s.titleWidth).toBeGreaterThan(0);

      expect(s.saidFontSize).toBe('14px');
      expect(s.saidColor).toBe(secondary);
      expect(s.saidOpacity).toBe('0.8');

      // Progress overlay.
      const lightSecondary = theme === 'night' ? 'rgb(16, 17, 18)' : 'rgb(7, 8, 9)';
      const primary = theme === 'night' ? 'rgb(10, 11, 12)' : 'rgb(1, 2, 3)';
      expect(s.progressWrapPosition).toBe('absolute');
      expect(s.progressWrapTop).toBe('0px');
      expect(s.progressWrapLeft).toBe('0px');
      expect(s.progressWrapRight).toBe('0px');
      expect(s.progressWrapBottom).toBe('0px');
      expect(s.progressWrapOverflow).toBe('hidden');
      // rounded-[inherit] copies the bar root's computed corner (0.875rem = 13.125px).
      expect(s.rootRadius).toBe('14px');
      expect(s.progressWrapRadius).toBe(s.rootRadius);
      expect(s.linePosition).toBe('absolute');
      expect(s.lineLeft).toBe('0px'); // inset-x-0
      expect(s.lineRight).toBe('0px');
      expect(s.lineBottom).toBe('0px');
      expect(s.lineHeight).toBe('4px'); // h-[0.25rem]
      expect(s.lineBg).toBe(lightSecondary);
      expect(s.lineOverflow).toBe('hidden');
      expect(s.lineTransform).toBe('none');
      expect(s.filledHeight).toBe('4px'); // h-full of the 0.25rem line
      expect(s.filledWidth).toBe('0px'); // w-0 initial (runtime drives inline width)
      expect(s.filledBg).toBe(primary);

      // State: `show(null)` re-adds `.cyc-off` -> the root collapses to display:none.
      expect(s.hiddenDisplay).toBe('none');
    });
  }
});

describe('player-bar cascade: loading dims the icon, playing only swaps the glyph', () => {
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'day'],
    ['ltr', 'night'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: loading:true dims the toggle to 0.5, loading:false stays 1`, async () => {
      const loading = await measure(producedClasses({loading: true}), theme, dir);
      const idle = await measure(producedClasses({loading: false}), theme, dir);

      expect(loading.toggleOpacity).toBe('0.5');
      expect(idle.toggleOpacity).toBe('1');

      const primary = theme === 'night' ? 'rgb(10, 11, 12)' : 'rgb(1, 2, 3)';
      expect(loading.toggleColor).toBe(primary);
      expect(idle.toggleColor).toBe(primary);
      expect(loading.toggleFont).toBe('24px');
      expect(idle.toggleFont).toBe('24px');

      expect(loading.saidOpacity).toBe('0.8');
      expect(idle.saidOpacity).toBe('0.8');
    });
  }

  test('playing vs paused: only the glyph + title differ, not the icon skin', async () => {
    const playing = producedClasses({playing: true});
    const paused = producedClasses({playing: false});

    expect(playing.toggleClass).toBe(paused.toggleClass);
    expect(playing.shownRootClass).toBe(paused.shownRootClass);

    const p = await measure(playing, 'day', 'ltr');
    const q = await measure(paused, 'day', 'ltr');
    expect(p.toggleColor).toBe(q.toggleColor);
    expect(p.toggleFont).toBe(q.toggleFont);
    expect(p.toggleOpacity).toBe(q.toggleOpacity);
    expect(p.toggleColor).toBe('rgb(1, 2, 3)'); // primary sentinel
    expect(p.toggleFont).toBe('24px');
    expect(p.toggleOpacity).toBe('1');
  });
});

describe('player-bar cascade: final root box placement (positioned parent, real float tokens)', () => {
  // The absolute root box (position/z/offsets/height/radius/surface/shadow/overflow)
  
  // literals with the raw `--cyc-action-float-*`/`--cyc-safe-bottom` token references
  // preserved. These probes mount the root in a viewport-sized position:relative
  // parent and inject the real float-offset tokens so placement is exercised
  // authentically, then gate the computed offsets/z/shadow/surface/radius.
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'day'],
    ['ltr', 'night'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: absolute root box resolves offsets/z/shadow/surface/radius`, async () => {
      const s = await measurePlacement(theme, dir, 800);
      expect(s.position).toBe('absolute');
      expect(s.z).toBe('2'); // z-[2], matches sibling newConversation
      expect(s.height).toBe('48px'); // h-[3rem]
      expect(s.radius).toBe('14px'); // rounded-[0.875rem]
      expect(s.overflow).toBe('hidden');
      // Tailwind v4 `shadow-[...]` composes empty ring/inset placeholder layers ahead
      
      expect(s.shadow).toContain('rgba(0, 0, 0, 0.18) 0px 1px 8px 0px');
      expect(s.bg).toBe(theme === 'night' ? 'rgb(40, 41, 42)' : 'rgb(30, 31, 32)');
      // >550 breakpoint: offset 1rem = 16px. right = 16 + env(0) + 56 (3.5rem
      // float size) + 10 (0.625rem gap) = 82px.
      expect(s.left).toBe('16px');
      expect(s.right).toBe('82px');
      // bottom = offset(16) + --cyc-safe-bottom sentinel(11) = 27px, proving the token
      // is consumed (not the headless env() default of 0).
      expect(s.bottom).toBe('27px');
    });
  }

  test('breakpoint exactness: <=550 uses 1.5rem offset, 551..899 == >=900 use 1rem', async () => {
    const small = await measurePlacement('day', 'ltr', 500);
    const mid = await measurePlacement('day', 'ltr', 800);
    const wide = await measurePlacement('day', 'ltr', 1000);
    // <=550: offset 1.5rem = 22.5px; bottom = 22.5 + 11 sentinel = 33.5px.
    expect(small.left).toBe('24px');
    expect(small.bottom).toBe('35px');
    // 551..899 and >=900 are identical: the bar has a single unconditional root box,
    // its only responsive input is --cyc-action-float-offset (which shifts solely at
    // max-width:550px), so 800 and 1000 render byte-identically.
    expect(mid.left).toBe('16px');
    expect(wide.left).toBe('16px');
    expect(mid.left).toBe(wide.left);
    expect(mid.right).toBe(wide.right);
    expect(mid.bottom).toBe(wide.bottom);
    // The <=550 offset genuinely differs from >550 (breakpoint is exercised).
    expect(small.left).not.toBe(mid.left);
  });

  test('RTL invariance: physical left/right/bottom are byte-identical to ltr', async () => {
    // The primary regression a start-/end- logicalization mistake would introduce:
    // physical left/right must not flip under RTL. Sweep all three breakpoints.
    for (const viewport of [500, 800, 1000]) {
      const ltr = await measurePlacement('day', 'ltr', viewport);
      const rtl = await measurePlacement('day', 'rtl', viewport);
      expect(rtl.left).toBe(ltr.left);
      expect(rtl.right).toBe(ltr.right);
      expect(rtl.bottom).toBe(ltr.bottom);
    }
  });
});

describe('player-bar cascade: current box is viewport-invariant (no media queries on the slice)', () => {
  for (const viewport of [500, 800, 1000]) {
    test(`viewport ${viewport}px: box invariant`, async () => {
      const s = await measure(producedClasses(), 'day', 'ltr', viewport);
      const loading = await measure(producedClasses({loading: true}), 'day', 'ltr', viewport);
      expect(s.rootDisplay).toBe('flex');
      expect(s.rootJustify).toBe('space-between');
      expect(s.rootAlign).toBe('center');
      expect(s.rootPadLeft).toBe('4px');
      expect(s.wrapGrow).toBe('1');
      expect(s.wrapAlign).toBe('center');
      expect(s.wrapRadius).toBe('6px');
      expect(s.contentOverflow).toBe('hidden');
      expect(s.toggleShrink).toBe('0');
      expect(s.titleFontSize).toBe('14px');
      expect(s.titleLineHeight).toBe('18px');
      expect(s.titleWeight).toBe('500');
      expect(s.subtitleColor).toBe('rgb(4, 5, 6)');
      
      // media query: the loading dim, said opacity, and icon color are invariant.
      expect(s.toggleColor).toBe('rgb(1, 2, 3)'); // primary sentinel
      expect(s.toggleOpacity).toBe('1');
      expect(loading.toggleOpacity).toBe('0.5');
      expect(s.saidOpacity).toBe('0.8');
      expect(s.progressWrapPosition).toBe('absolute');
      expect(s.progressWrapOverflow).toBe('hidden');
      expect(s.progressWrapRadius).toBe('14px');
      expect(s.linePosition).toBe('absolute');
      expect(s.lineBottom).toBe('0px');
      expect(s.lineHeight).toBe('4px');
      expect(s.lineBg).toBe('rgb(7, 8, 9)'); // light-secondary sentinel (day)
      expect(s.lineTransform).toBe('none');
      expect(s.filledHeight).toBe('4px');
      expect(s.filledWidth).toBe('0px');
      expect(s.filledBg).toBe('rgb(1, 2, 3)'); // primary sentinel (day)
    });
  }
});

describe('player-bar cascade: progress line is display-only, dropped translateY hover/active were dead', () => {
  async function mountLine(): Promise<{
    read: () => Promise<{
      transform: string;
      height: string;
      bottom: string;
      left: string;
      pointerEvents: string;
    }>;
    hover: () => Promise<void>;
    press: () => Promise<void>;
    release: () => Promise<void>;
    close: () => Promise<void>;
  }> {
    const cls = producedClasses();
    const utilities = await compileTailwind([
      ...tokenize(cls.shownRootClass),
      ...tokenize(cls.wrapperClass),
      ...tokenize(cls.progressWrapClass),
      ...tokenize(cls.progressLineClass),
      ...tokenize(cls.filledClass)
    ]);
    const shell =
      readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
      '\n' +
      readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
      '\n' +
      readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
      '\n' +
      THEME_VARS;
    const html =
      `<!DOCTYPE html><html data-pointer='fine'><head><meta charset="utf-8">` +
      `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head><body>` +
      `<div id="root" class="${cls.shownRootClass}">` +
      `<div id="progressWrap" class="${cls.progressWrapClass}">` +
      `<div id="progressLine" class="${cls.progressLineClass}">` +
      `<div id="filled" class="${cls.filledClass}"></div>` +
      `</div>` +
      `</div>` +
      `</div>` +
      `</body></html>`;
    const page = await (await getBrowser()).newPage();
    await page.setViewportSize({width: 900, height: 800});
    await page.setContent(html, {waitUntil: 'load'});
    const read = () =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('#progressLine')!);
        return {
          transform: cs.getPropertyValue('transform'),
          height: cs.getPropertyValue('height'),
          bottom: cs.getPropertyValue('bottom'),
          left: cs.getPropertyValue('left'),
          pointerEvents: cs.getPropertyValue('pointer-events')
        };
      });
    return {
      read,
      /* The overlay is pointer-events:none (taps fall through to the bar), so
       * page.hover() would wait forever for hoverability; move by coordinates. */
      hover: async () => {
        const box = (await page.locator('#progressLine').boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      },
      press: async () => {
        const box = (await page.locator('#progressLine').boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
      },
      release: () => page.mouse.up(),
      close: () => page.close()
    };
  }

  test('fine pointer: hover and active leave transform:none and geometry unchanged', async () => {
    const line = await mountLine();
    try {
      const rest = await line.read();
      expect(rest.transform).toBe('none');
      expect(rest.height).toBe('4px');
      expect(rest.bottom).toBe('0px');
      expect(rest.left).toBe('0px');
      expect(rest.pointerEvents).toBe('none'); // the overlay must never eat the bar's taps

      await line.hover();
      const hovered = await line.read();
      expect(hovered).toEqual(rest); // hover changes nothing (dead util removed)

      await line.press();
      const pressed = await line.read();
      expect(pressed).toEqual(rest); // active changes nothing either
      await line.release();
    } finally {
      await line.close();
    }
  });
});

describe('player-bar cascade: runtime progress drives filled inline width, line has no seek side effect', () => {
  test('progress() sets rounded pct width; clamps; line has no pointer/seek handler', () => {
    const bar = createAudioPlayerBar({onToggle: () => {}, onOpen: () => {}, onClose: () => {}});
    bar.show({chat: 'Alice', text: 'a message', playing: true, loading: false});
    const filled = bar.el.querySelector<HTMLElement>('.cyc-player-progress-filled')!;
    const line = bar.el.querySelector<HTMLElement>('.cyc-player-progress')!;
    const wrap = bar.el.querySelector<HTMLElement>('.cyc-player-progress-wrapper')!;

    bar.progress(0, 10, 0);
    expect(filled.style.width).toBe('0%');
    bar.progress(3, 10, 0.3);
    expect(filled.style.width).toBe('30%');
    bar.progress(3.7, 10, 0.37);
    expect(filled.style.width).toBe('37%');
    bar.progress(10, 10, 1);
    expect(filled.style.width).toBe('100%');
    // Clamp out-of-range ratios to [0,1].
    bar.progress(20, 10, 1.5);
    expect(filled.style.width).toBe('100%');
    bar.progress(-5, 10, -0.5);
    expect(filled.style.width).toBe('0%');

    bar.progress(3, 10, 0.3);
    expect(filled.style.width).toBe('30%');
    line.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, clientX: 5}));
    line.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: 5}));
    wrap.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, clientX: 5}));
    expect(filled.style.width).toBe('30%');
  });
});
