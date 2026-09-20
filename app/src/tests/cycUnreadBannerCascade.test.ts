import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {createChatChrome} from '../features/chat/surface/chatChrome';

// Verifies unread-banner and audio-jump styles in Chromium.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const SHELL = resolve(SRC, 'shell');
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

// Stable token values for computed-style assertions.
const ENV = `
:root{
  --cyc-surface:rgb(30,31,32);
  --cyc-accent:rgb(1,2,3);
  --cyc-text:rgb(20,21,22);
  --cyc-msg-time-background:rgba(0,0,0,0.35);
  --cyc-chat-header-height:56px;
  --cyc-composer-height:120px;
}
`;

const PROPS = [
  'position',
  'z-index',
  'left',
  'right',
  'top',
  'transform',
  'border-top-left-radius',
  'background-color',
  'color',
  'display',
  'font-size',
  'line-height',
  'font-weight',
  'padding-left',
  'padding-top',
  'white-space',
  'cursor',
  'width',
  'height'
] as const;

type Probe = Record<(typeof PROPS)[number], string>;

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

// Build the production chrome subtree.
function buildChrome() {
  const chat = document.createElement('div');
  chat.className = 'cyc-thread';
  const scroll = document.createElement('div');
  const chrome = createChatChrome({chat, scroll, nearBottomPx: 100, closeSettleGrace: () => {}});
  const composerBox = document.createElement('div');
  const {audioJumpChip} = chrome.mount(composerBox, () => {});
  const banner = chat.querySelector('.cyc-unread-banner') as HTMLElement;
  return {chrome, banner, audioJumpChip};
}

const collectClasses = (root: HTMLElement): string[] => {
  const set = new Set<string>();
  const add = (el: Element) => el.classList.forEach((c) => set.add(c));
  add(root);
  root.querySelectorAll('*').forEach(add);
  return [...set];
};

// Measure compiled utilities under the application stylesheet stack.
async function measure(
  nodeHTML: string,
  candidates: string[],
  opts: {wrapClass?: string; dir?: 'ltr' | 'rtl'; theme?: 'day' | 'night'},
  selector: string
): Promise<Probe> {
  const utilities = await compileTailwind(candidates);
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/sessions/sessions.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/chat/chat.css'), 'utf8') +
    '\n' +
    ENV;
  const themeAttr = opts.theme === 'night' ? " data-theme='dark'" : '';
  const dirAttr = opts.dir === 'rtl' ? " dir='rtl'" : '';
  const stage = `<div style="position:relative;width:800px;height:800px">${nodeHTML}</div>`;
  const body = opts.wrapClass ? `<div class="${opts.wrapClass}">${stage}</div>` : stage;
  const html =
    `<!DOCTYPE html><html${themeAttr}${dirAttr}><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head><body>${body}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setViewportSize({width: 800, height: 800});
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(
      ([sel, props]) => {
        const cs = getComputedStyle(document.querySelector(sel as string)!);
        const o: Record<string, string> = {};
        for (const p of props as string[]) o[p] = cs.getPropertyValue(p);
        return o as never;
      },
      [selector, PROPS as unknown as string[]] as const
    );
  } finally {
    await page.close();
  }
}

afterAll(async () => {
  await browser?.close();
});

describe('unread-banner cascade: final floating pill preserves the computed chrome', () => {
  for (const theme of ['day', 'night'] as const) {
    for (const dir of ['ltr', 'rtl'] as const) {
      test(`${dir}/${theme}: cyc-list-row-time bg, white ink, 0.875rem bold, 1rem radius, z-3`, async () => {
        const {chrome, banner} = buildChrome();
        chrome.showUnreadBanner(3);
        expect(banner.classList.contains('cyc-off')).toBe(false);
        const candidates = collectClasses(banner);
        const b = await measure(banner.outerHTML, candidates, {dir, theme}, '.cyc-unread-banner');
        expect(b.position).toBe('absolute');
        expect(b['z-index']).toBe('3');
        expect(b['background-color']).toBe('rgba(0, 0, 0, 0.35)');
        expect(b.color).toBe('rgb(255, 255, 255)');
        expect(b['font-size']).toBe('14px');
        expect(b['font-weight']).toBe('500');
        expect(b['line-height']).toBe('18.9px');
        expect(b['white-space']).toBe('nowrap');
        expect(b.cursor).toBe('pointer');
        expect(b['padding-left']).toBe('14px');
        expect(b['padding-top']).toBe('5px');
        expect(b['border-top-left-radius']).toBe('16px');
        expect(b.left).toBe('400px');
        expect(b.right).toBe('0px');
        expect(b.transform).not.toBe('none');
        expect(b.top).toBe('64px');
      });
    }
  }

  test('.cyc-off collapses the pill; showUnreadBanner/hideUnreadBanner drive the toggle', async () => {
    const {chrome, banner} = buildChrome();
    expect(banner.classList.contains('cyc-off')).toBe(true);
    chrome.showUnreadBanner(2);
    expect(banner.classList.contains('cyc-off')).toBe(false);
    expect(banner.textContent).toBe('2 unread messages');
    const shown = await measure(banner.outerHTML, collectClasses(banner), {}, '.cyc-unread-banner');
    expect(shown.display).not.toBe('none');

    chrome.hideUnreadBanner();
    expect(banner.classList.contains('cyc-off')).toBe(true);
    const hidden = await measure(
      banner.outerHTML,
      collectClasses(banner),
      {},
      '.cyc-unread-banner'
    );
    expect(hidden.display).toBe('none');
  });
});

describe('audio-jump direction bubble: final round chip + up/down reveal', () => {
  test('is-up shows only the up glyph; primary bubble, white 0.875rem ink', async () => {
    const {audioJumpChip} = buildChrome();
    audioJumpChip.classList.add('is-up');
    const candidates = collectClasses(audioJumpChip);
    const html = audioJumpChip.outerHTML;

    const up = await measure(html, candidates, {}, '.cyc-clip-jump-up');
    const down = await measure(html, candidates, {}, '.cyc-clip-jump-down');
    expect(up.display).toBe('flex');
    expect(down.display).toBe('none');
    expect(up.color).toBe('rgb(255, 255, 255)');
    expect(up['font-size']).toBe('14px');

    const bubble = await measure(html, candidates, {}, '.cyc-clip-jump-dir');
    expect(bubble.position).toBe('absolute');
    expect(bubble['background-color']).toBe('rgb(1, 2, 3)');
    expect(bubble.width).toBe('20px');
    expect(bubble.height).toBe('20px');
    expect(bubble['border-top-left-radius']).not.toBe('0px');
  });

  test('is-down shows only the down glyph', async () => {
    const {audioJumpChip} = buildChrome();
    audioJumpChip.classList.add('is-down');
    const candidates = collectClasses(audioJumpChip);
    const html = audioJumpChip.outerHTML;
    const up = await measure(html, candidates, {}, '.cyc-clip-jump-up');
    const down = await measure(html, candidates, {}, '.cyc-clip-jump-down');
    expect(down.display).toBe('flex');
    expect(up.display).toBe('none');
  });

  test('neither self-state: both direction glyphs stay hidden (beats icon inline-flex)', async () => {
    const {audioJumpChip} = buildChrome();
    const candidates = collectClasses(audioJumpChip);
    const html = audioJumpChip.outerHTML;
    const up = await measure(html, candidates, {}, '.cyc-clip-jump-up');
    const down = await measure(html, candidates, {}, '.cyc-clip-jump-down');
    expect(up.display).toBe('none');
    expect(down.display).toBe('none');
  });
});
