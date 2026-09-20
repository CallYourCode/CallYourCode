import {afterAll, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Chromium cascade coverage for the real agents-bar class output.

import {createAgentsBar} from '../features/sessions/components/agentsBar';
import type {EngineAgentRun} from '../engine/contract';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const BASE = resolve(SHELL, 'reset.css');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

// Compile the production Tailwind entrypoint for emitted classes.
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

// Theme-specific sentinels make resolved colors unambiguous.
const THEME_VARS = `
:root {
  --cyc-accent: rgb(1, 2, 3);
  --cyc-text-muted: rgb(4, 5, 6);
  --cyc-danger: rgb(7, 8, 9);
}
html[data-theme='dark'] {
  --cyc-accent: rgb(10, 11, 12);
  --cyc-text-muted: rgb(13, 14, 15);
  --cyc-danger: rgb(16, 17, 18);
  --cyc-surface: rgb(19, 20, 21);
  --cyc-border-color: rgb(28, 29, 30);
}
:root {
  --cyc-surface: rgb(22, 23, 24);
  --cyc-border-color: rgb(25, 26, 27);
}
`;

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

// Capture emitted classes for idle and running bars.
function producedClasses(): {
  idleRootClass: string;
  runningRootClass: string;
  wrapperClass: string;
  titleClass: string;
  contentClass: string;
  stopClass: string;
} {
  const bar = createAgentsBar();
  const base: EngineAgentRun = {
    toolUseId: 't1',
    agentId: 'a1',
    ts: Date.now(),
    desc: 'render the corpus',
    endedTs: null,
    tokens: null,
    source: 'pi',
    model: 'opus'
  };
  bar.update([base]);
  const stop = bar.el.querySelector<HTMLElement>('.cyc-agents-stop')!;
  const stopClass = stop.className;
  const runningRootClass = bar.el.className;
  const content = bar.el.querySelector<HTMLElement>('.cyc-agents-strip-content')!;
  const contentClass = content.className;
  const wrapper = bar.el.querySelector<HTMLElement>('.cyc-agents-strip-wrap')!;
  const wrapperClass = wrapper.className;
  bar.update([{...base, endedTs: Date.now()}]);
  const idleRootClass = bar.el.className;
  const title = bar.el.querySelector<HTMLElement>('.cyc-agents-strip-title')!;
  return {
    idleRootClass,
    runningRootClass,
    wrapperClass,
    titleClass: title.className,
    contentClass,
    stopClass
  };
}

// Measure computed styles for the emitted class sets.
async function measure(
  cls: {
    idleRootClass: string;
    runningRootClass: string;
    wrapperClass: string;
    titleClass: string;
    contentClass: string;
    stopClass: string;
  },
  theme: 'day' | 'night',
  dir: 'ltr' | 'rtl' = 'ltr'
): Promise<{
  titleColor: string;
  liveTitleColor: string;
  contentOverflow: string;
  stopPosition: string;
  stopColor: string;
  rootCursor: string;
  rootDisplay: string;
  rootJustify: string;
  rootBg: string;
  rootMinHeight: string;
  rootPadTop: string;
  rootPadLeft: string;
  wrapHeight: string;
  wrapPadTop: string;
  wrapPadBottom: string;
  wrapPadLeft: string;
  wrapPadRight: string;
  wrapRadius: string;
}> {
  const utilities = await compileTailwind([
    ...tokenize(cls.idleRootClass),
    ...tokenize(cls.runningRootClass),
    ...tokenize(cls.wrapperClass),
    ...tokenize(cls.titleClass),
    ...tokenize(cls.contentClass),
    ...tokenize(cls.stopClass)
  ]);
  const shell =
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
    `<div id="root" class="${cls.idleRootClass}">` +
    `<div id="wrapper" class="${cls.wrapperClass}"></div>` +
    `<div id="title" class="${cls.titleClass}">2 agents done</div>` +
    `</div>` +
    `<div id="liveRoot" class="${cls.runningRootClass}">` +
    `<div id="content" class="${cls.contentClass}">` +
    `<div id="liveTitle" class="${cls.titleClass}">1 agent running</div>` +
    `</div>` +
    `</div>` +
    `<button id="stop" class="${cls.stopClass}"></button>` +
    `</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const title = document.querySelector('#title')!;
      const liveTitle = document.querySelector('#liveTitle')!;
      const content = document.querySelector('#content')!;
      const stop = document.querySelector('#stop')!;
      const root = document.querySelector('#root')!;
      const wrap = document.querySelector('#wrapper')!;
      const ts = getComputedStyle(title);
      const lts = getComputedStyle(liveTitle);
      const cs = getComputedStyle(content);
      const ss = getComputedStyle(stop);
      const rs = getComputedStyle(root);
      const ws = getComputedStyle(wrap);
      return {
        titleColor: ts.getPropertyValue('color'),
        liveTitleColor: lts.getPropertyValue('color'),
        contentOverflow: cs.getPropertyValue('overflow'),
        stopPosition: ss.getPropertyValue('position'),
        stopColor: ss.getPropertyValue('color'),
        rootCursor: rs.getPropertyValue('cursor'),
        rootDisplay: rs.getPropertyValue('display'),
        rootJustify: rs.getPropertyValue('justify-content'),
        rootBg: rs.getPropertyValue('background-color'),
        rootMinHeight: rs.getPropertyValue('min-height'),
        rootPadTop: rs.getPropertyValue('padding-top'),
        rootPadLeft: rs.getPropertyValue('padding-left'),
        wrapHeight: ws.getPropertyValue('height'),
        wrapPadTop: ws.getPropertyValue('padding-top'),
        wrapPadBottom: ws.getPropertyValue('padding-bottom'),
        wrapPadLeft: ws.getPropertyValue('padding-left'),
        wrapPadRight: ws.getPropertyValue('padding-right'),
        wrapRadius: ws.getPropertyValue('border-top-left-radius')
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

describe('agents-bar cascade: producer paints must beat the un-layered shell skin', () => {
  test('day: idle title dims to secondary, live title keeps current primary, content stays visible, stop is absolute/danger', async () => {
    const s = await measure(producedClasses(), 'day');
    expect(s.titleColor).toBe('rgb(4, 5, 6)'); // --cyc-text-muted, not primary
    expect(s.liveTitleColor).toBe('rgb(1, 2, 3)'); 
    expect(s.contentOverflow).toBe('visible'); // not the un-layered `hidden`
    expect(s.stopPosition).toBe('absolute'); // not the un-layered `relative`
    expect(s.stopColor).toBe('rgb(7, 8, 9)'); // --cyc-danger, not secondary-text
  });

  test('night: idle title dims to secondary, live title keeps current primary, content stays visible, stop is absolute/danger', async () => {
    const s = await measure(producedClasses(), 'night');
    expect(s.titleColor).toBe('rgb(13, 14, 15)'); // --cyc-text-muted (dark)
    expect(s.liveTitleColor).toBe('rgb(10, 11, 12)'); 
    expect(s.contentOverflow).toBe('visible');
    expect(s.stopPosition).toBe('absolute');
    expect(s.stopColor).toBe('rgb(16, 17, 18)'); // --cyc-danger (dark)
  });
});

describe('agents-bar cascade: final wrapper geometry + root cursor under the un-layered shell', () => {
  // Token rem values resolve against the 15px app root.
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'day'],
    ['ltr', 'night'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: wrapper geometry (44px) is symmetric, radius stays --cyc-radius, root cursor auto`, async () => {
      const s = await measure(producedClasses(), theme, dir);
      expect(s.wrapHeight).toBe('44px'); // h-11! beats un-layered height:100%
      expect(s.wrapPadTop).toBe('2px'); // py-0.5! beats un-layered padding:0
      expect(s.wrapPadBottom).toBe('2px');
      expect(s.wrapPadLeft).toBe('4px'); // px-1! beats un-layered padding:1rem
      expect(s.wrapPadRight).toBe('4px'); // symmetric -> no RTL drift
      expect(s.wrapRadius).toBe('6px'); // --cyc-radius, not the dropped 0.5rem
      expect(s.rootCursor).toBe('auto'); 
      expect(s.rootDisplay).toBe('flex'); // producer-owned; no surviving base
      expect(s.rootJustify).toBe('space-between'); // producer-owned
      expect(s.rootPadTop).toBe('4px'); // p-1 = 0.25rem @ 16px root
      expect(s.rootPadLeft).toBe('4px');
      // min-h-13 = 3.25rem: the strip's stable floor. Matches the wrapper 44px + p-1
      // 8px populated height; the `--cyc-overlay-stack-height` reservation is this
      // 3.25rem plus a 0.375rem breathing gap (3.625rem), so a jump-pill-only (bare)
      // strip cannot collapse under the reserved dock slot.
      expect(s.rootMinHeight).toBe('52px');
      expect(s.rootBg).toBe(theme === 'night' ? 'rgb(19, 20, 21)' : 'rgb(22, 23, 24)');
    });
  }
});

// Verify the title and subtitle remain inside the fixed wrapper.
async function measureContainment(theme: 'day' | 'night'): Promise<{
  wrapTop: number;
  wrapBottom: number;
  titleTop: number;
  titleBottom: number;
  subtitleTop: number;
  subtitleBottom: number;
  wrapDisplay: string;
  wrapAlign: string;
}> {
  const bar = createAgentsBar();
  const base: EngineAgentRun = {
    toolUseId: 't1',
    agentId: 'a1',
    ts: Date.now(),
    desc: 'render the corpus with a description long enough to want to wrap',
    endedTs: null,
    tokens: null,
    source: 'pi',
    model: 'opus'
  };
  bar.update([base]);
  const graphHtml = bar.el.outerHTML;
  const tokens = new Set<string>();
  bar.el.classList.forEach((t) => tokens.add(t));
  bar.el.querySelectorAll('*').forEach((n) => n.classList.forEach((t) => tokens.add(t)));

  const utilities = await compileTailwind([...tokens]);
  const shell =
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    THEME_VARS;
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  // Use a fixed-width host for containment checks.
  const html =
    `<!DOCTYPE html><html${themeAttr}><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell */\n${shell}</style></head><body>` +
    `<div style="position:fixed;top:0;left:0;width:20rem">${graphHtml}</div>` +
    `</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const wrap = document.querySelector('.cyc-agents-strip-wrap')!;
      const title = document.querySelector('.cyc-agents-strip-title')!;
      const subtitle = document.querySelector('.cyc-agents-strip-subtitle')!;
      const wr = wrap.getBoundingClientRect();
      const tr = title.getBoundingClientRect();
      const sr = subtitle.getBoundingClientRect();
      const ws = getComputedStyle(wrap);
      return {
        wrapTop: wr.top,
        wrapBottom: wr.bottom,
        titleTop: tr.top,
        titleBottom: tr.bottom,
        subtitleTop: sr.top,
        subtitleBottom: sr.bottom,
        wrapDisplay: ws.getPropertyValue('display'),
        wrapAlign: ws.getPropertyValue('align-items')
      };
    });
  } finally {
    await page.close();
  }
}

describe('agents-bar cascade: title/subtitle stay inside the fixed bar', () => {
  for (const theme of ['day', 'night'] as const) {
    test(`${theme}: wrapper is a centred flex row and the title/subtitle bounding boxes stay within the fixed bar`, async () => {
      const s = await measureContainment(theme);
      expect(s.wrapDisplay).toBe('flex');
      expect(s.wrapAlign).toBe('center');
      // Allow for sub-pixel layout rounding.
      const eps = 0.5;
      expect(s.titleTop).toBeGreaterThanOrEqual(s.wrapTop - eps);
      expect(s.titleBottom).toBeLessThanOrEqual(s.wrapBottom + eps);
      expect(s.subtitleTop).toBeGreaterThanOrEqual(s.wrapTop - eps);
      expect(s.subtitleBottom).toBeLessThanOrEqual(s.wrapBottom + eps);
    });
  }
});

// Chromium coverage for slot parent-state variants.
function slotClass(): string {
  const bar = createAgentsBar();
  return bar.el.querySelector<HTMLElement>('.cyc-agents-slot')!.className;
}

async function measureSlot(theme: 'day' | 'night', dir: 'ltr' | 'rtl' = 'ltr') {
  const slot = slotClass();
  const utilities = await compileTailwind(tokenize(`${slot} cyc-off`));
  const shell =
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(BASE, 'utf8') +
    '\n' +
    THEME_VARS;
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  const dirAttr = dir === 'rtl' ? " dir='rtl'" : '';
  // Use fixed-width bare and non-bare hosts.
  const html =
    `<!DOCTYPE html><html${themeAttr}${dirAttr}><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell */\n${shell}</style></head><body>` +
    `<div class="cyc-agents-bar cyc-agents-bare" style="width:300px;display:flex">` +
    `<div id="bare" class="${slot}"></div></div>` +
    `<div class="cyc-agents-bar" style="width:300px;display:flex">` +
    `<div id="live" class="${slot}"></div>` +
    `<div id="hidden" class="${slot} cyc-off"></div></div>` +
    `</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const box = (id: string) => {
        const s = getComputedStyle(document.getElementById(id)!);
        return {
          minWidth: s.getPropertyValue('min-width'),
          maxWidth: s.getPropertyValue('max-width'),
          flexGrow: s.getPropertyValue('flex-grow'),
          flexShrink: s.getPropertyValue('flex-shrink'),
          flexBasis: s.getPropertyValue('flex-basis'),
          borderWidth: s.getPropertyValue('border-inline-start-width'),
          borderStyle: s.getPropertyValue('border-inline-start-style'),
          borderColor: s.getPropertyValue('border-inline-start-color'),
          display: s.getPropertyValue('display')
        };
      };
      return {bare: box('bare'), live: box('live'), hidden: box('hidden')};
    });
  } finally {
    await page.close();
  }
}

type SlotBox = Awaited<ReturnType<typeof measureSlot>>['bare'];

describe('agents-bar cascade: `.cyc-agents-slot` parent-state geometry + dropped .cyc-off leg', () => {
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'day'],
    ['ltr', 'night'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: bare fills, non-bare draws the inline-start divider, hide collapses`, async () => {
      const s = await measureSlot(theme, dir);
      expect(s.bare.minWidth).toBe('0px');
      expect(s.bare.maxWidth).toBe('100%');
      expect(s.bare.flexGrow).toBe('1');
      expect(s.bare.flexShrink).toBe('1');
      expect(s.bare.flexBasis).toBe('auto');
      expect(s.bare.borderWidth).toBe('0px');
      expect(s.live.minWidth).toBe('128px');
      expect(s.live.maxWidth).toBe('45%');
      expect(s.live.flexGrow).toBe('0');
      expect(s.live.borderWidth).toBe('1px');
      expect(s.live.borderStyle).toBe('solid');
      expect(s.live.borderColor).toBe(theme === 'night' ? 'rgb(28, 29, 30)' : 'rgb(25, 26, 27)');
      expect(s.hidden.display).toBe('none');
    });
  }
});
