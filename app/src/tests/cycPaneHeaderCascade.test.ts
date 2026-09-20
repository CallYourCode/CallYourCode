import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Chromium cascade coverage for pane-header spacing and safe-area behavior.

import {paneHeader} from '../features/sessions/components/paneHeader';
import {createHeader} from '../features/sessions/header/header';
import {installPresentationReactivity} from '../components/presentation';

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

const paneHeaderClass = () => paneHeader('t', () => {}).el.className;

// Set the width before rendering a header.
const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});

// Headless Chromium needs an explicit safe-area value.
const SENTINEL = `<style>:root { --cyc-safe-top: 11px; }</style>`;

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

async function buildPage(cls: string) {
  const utilities = await compileTailwind(tokenize(cls));
  const shell =
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell */\n${shell}</style>${SENTINEL}</head><body>` +
    `<div id="bare" class="${cls}"></div>` +
    `<div id="cyc-left-pane"><div id="left" class="${cls}"></div></div>` +
    `<div id="cyc-thread-pane"><div id="chat" class="${cls}"></div></div>` +
    `</body></html>`;
  const page = await (await getBrowser()).newPage();
  await page.setContent(html, {waitUntil: 'load'});
  return page;
}

// Chat-header cascade coverage.
(globalThis as {ResizeObserver?: unknown}).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const CHAT = resolve(SHELL, '..', 'features', 'chat', 'chat.css');

// Fixed values make cascade assertions deterministic.
const CHAT_SENTINEL =
  `<style>:root{--cyc-surface:rgb(1,2,3);--cyc-chat-width:600px;--cyc-safe-top:0px}` +
  `html[data-theme='dark']{--cyc-surface:rgb(4,5,6)}</style>`;

// Render the header and compile all emitted utility classes.
const chatHeaderDom = (width: 'phone' | 'tablet' | 'laptop' = 'laptop') => {
  setWidth(width === 'laptop' ? 1000 : width === 'tablet' ? 800 : 400);
  const teardownReactivity = installPresentationReactivity();
  const el = createHeader({
    session: {
      id: 's1',
      name: 'Peer',
      cwd: '/',
      unread: 0,
      muted: false,
      thinking: false,
      messages: []
    } as never,
    onBack: () => {},
    onToggleConversation: () => {},
    onToggleMute: () => {},
    onOpenProfile: () => {}
  }).el;
  const classes = new Set<string>();
  for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
    const cls = node.getAttribute('class');
    if (cls) for (const t of tokenize(cls)) classes.add(t);
  }
  teardownReactivity();
  return {html: el.outerHTML, classes: Array.from(classes)};
};

async function buildChatPage(
  width: 'phone' | 'tablet' | 'laptop' = 'laptop'
): Promise<import('playwright').Page> {
  const {html, classes} = chatHeaderDom(width);
  const utilities = await compileTailwind(classes);
  const shell =
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(CHAT, 'utf8');
  const doc =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell + chat */\n${shell}</style>${CHAT_SENTINEL}</head><body>` +
    `<div id="cyc-thread-pane"><div class="cyc-thread active" style="--cyc-chat-header-height:88px">${html}</div></div>` +
    `</body></html>`;
  const page = await (await getBrowser()).newPage();
  await page.setContent(doc, {waitUntil: 'load'});
  return page;
}

const headerBox = (page: import('playwright').Page) =>
  page.$eval('#cyc-thread-pane .cyc-mast', (el) => {
    const c = getComputedStyle(el);
    return {
      bg: c.backgroundColor,
      minHeight: c.minHeight,
      height: c.height,
      transition: c.transitionProperty,
      position: c.position,
      zIndex: c.zIndex,
      radius: c.borderTopLeftRadius,
      padLeft: c.paddingLeft
    };
  });

const pad = (page: import('playwright').Page, sel: string) =>
  page.$eval(sel, (el) => getComputedStyle(el).paddingLeft);
const box = (page: import('playwright').Page, sel: string) =>
  page.$eval(sel, (el) => {
    const cs = getComputedStyle(el);
    return {minHeight: cs.minHeight, paddingTop: cs.paddingTop};
  });

afterAll(async () => {
  await browser?.close();
});

describe('pane-header cascade: current PANE_HEADER_UTILS beats the un-layered shell', () => {
  test('inline pad narrows on phone and widens on tablet across a live resize', async () => {
    const page = await buildPage(paneHeaderClass());
    try {
      // rem is 16px (chrome.css `html { font-size: 16px }`): px-2 = 7.5px, px-4 = 15px.
      await page.setViewportSize({width: 400, height: 800}); // phone (<=550)
      expect(await pad(page, '#bare')).toBe('8px'); // max-tab:px-2, not the px-4 base
      await page.setViewportSize({width: 800, height: 800}); // tablet (>550)
      expect(await pad(page, '#bare')).toBe('16px'); // px-4 base
    } finally {
      await page.close();
    }
  });

  test('the safe-area top inset rides only the list pane, never the chat pane', async () => {
    const page = await buildPage(paneHeaderClass());
    try {
      await page.setViewportSize({width: 800, height: 800});
      const bare = await box(page, '#bare');
      const left = await box(page, '#left');
      // The list pane wins the safe-area inset: pad-top is the sentinel 11px and the
      // min-height grows by exactly that inset over the bare min-h-14 base -- proof the
      // `!` arbitrary variant beats the layered base (which would leave it at `bare`).
      expect(left.paddingTop).toBe('11px');
      expect(bare.paddingTop).toBe('0px');
      expect(parseFloat(left.minHeight)).toBeCloseTo(parseFloat(bare.minHeight) + 11, 1);
      // #cyc-thread-pane header is excluded: identical to the bare, ancestor-less base.
      expect(await box(page, '#chat')).toEqual(bare);
    } finally {
      await page.close();
    }
  });
});

describe('chat-header cascade: HEADER_BOX beats PANE_HEADER_UTILS; shell/chat still govern', () => {
  test('bg / min-h / h / transition win via `!`; position, z, radius stay shell-governed', async () => {
    const page = await buildChatPage();
    try {
      await page.setViewportSize({width: 900, height: 800}); // >=551 and <900
      const s = await headerBox(page);
      // `bg-[var(--cyc-surface)]!` beats the layered bg-transparent from PANE_HEADER_UTILS.
      expect(s.bg).toBe('rgb(1, 2, 3)');
      // `min-h-!` / `h-!` beat the layered min-h-14 base -> both read the --cyc-chat-header-height sentinel.
      expect(s.minHeight).toBe('88px');
      expect(s.height).toBe('88px');
      // `[transition:...]!` re-widened the bg-only PANE_HEADER_UTILS transition.
      expect(s.transition).toContain('transform');
      expect(s.transition).toContain('margin-bottom');
      expect(s.transition).toContain('background-color');
      expect(s.position).toBe('relative');
      expect(s.zIndex).toBe('2');
      expect(s.radius).toBe('6px');
      expect(s.padLeft).toBe('4px');

      // Same background at data-theme=dark -> proves it tracks --cyc-surface, not a fixed
      
      // themes over the 0.3s reveal transition, so wait for the fade to settle first.
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#cyc-thread-pane .cyc-mast')!)
            .backgroundColor === 'rgb(4, 5, 6)'
      );
    } finally {
      await page.close();
    }
  });

  test('phone (<=550): width painter pad + class z variant + chat.css radius primitive; RTL symmetric', async () => {
    const page = await buildChatPage('phone');
    try {
      await page.setViewportSize({width: 400, height: 800}); // <=550
      const s = await headerBox(page);
      expect(s.padLeft).toBe('12px');
      // `[.cyc-hdr-phone_&]:z-[3]` (0,2,0) beats the base layered z-[2] (0,1,0) on phone.
      expect(s.zIndex).toBe('3');
      // chat.css border-radius:0 !important (the surviving phone radius primitive) flattens
      // the phone header -- a layered `!` cannot beat this un-layered `!important`.
      expect(s.radius).toBe('0px');
      // h-! still applies (not the layered min-h-14 = 52.5px), reading the pinned sentinel.
      expect(s.height).toBe('88px');
      expect(s.position).toBe('relative');

      // RTL leaves the symmetric inline padding untouched (logical, 0.75rem both sides).
      await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
      const rtl = await headerBox(page);
      expect(rtl.padLeft).toBe('12px');
      expect(rtl.height).toBe('88px');
    } finally {
      await page.close();
    }
  });

  test('header-info start pad: 0.625rem at laptop, ps-[49px] below; header-text 0.875rem', async () => {
    const info = '#cyc-thread-pane .cyc-mast .cyc-mast-info';
    const text = '#cyc-thread-pane .cyc-mast .cyc-mast-text';
    // Laptop (>=900): paintInfoPad baked padding-inline-start:0.625rem inline over the
    // ps-[49px] base. rem is 16px -> 9.375px.
    const laptop = await buildChatPage('laptop');
    try {
      await laptop.setViewportSize({width: 1000, height: 800});
      expect(await pad(laptop, info)).toBe('10px');
      // header-text carries the unconditional ps-[0.875rem] -> 13.125px (rule G).
      expect(await pad(laptop, text)).toBe('14px');
    } finally {
      await laptop.close();
    }
    const tablet = await buildChatPage('tablet');
    try {
      await tablet.setViewportSize({width: 800, height: 800});
      expect(await pad(tablet, info)).toBe('49px');
      expect(await pad(tablet, text)).toBe('14px');
    } finally {
      await tablet.close();
    }
  });

  test('back button: position:absolute at tablet, display:none at laptop (>=900)', async () => {
    const back = '#cyc-thread-pane .cyc-mast .cyc-pane-back';
    const tablet = await buildChatPage('tablet');
    try {
      await tablet.setViewportSize({width: 900, height: 800});
      expect(
        await tablet.$eval(back, (el) => {
          const c = getComputedStyle(el);
          return {position: c.position, display: c.display};
        })
      ).toEqual({position: 'absolute', display: expect.not.stringMatching(/^none$/)});
    } finally {
      await tablet.close();
    }
    const laptop = await buildChatPage('laptop');
    try {
      await laptop.setViewportSize({width: 1000, height: 800});
      expect(await laptop.$eval(back, (el) => getComputedStyle(el).display)).toBe('none');
    } finally {
      await laptop.close();
    }
  });
});
