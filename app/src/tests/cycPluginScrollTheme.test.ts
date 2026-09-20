import {afterAll, beforeEach, describe, expect, test} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser} from 'playwright';
import {applyCycScrollTheme} from '../plugins/scrollTheme';
import {paintGt} from '../plugins/git/gitPaint';
import {paintFx} from '../plugins/files/filesPaint';

// Chromium verifies plugin scrollbar variables and producer-painted controls.

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS = resolve(HERE, '..', 'plugins');

const LITERALS = {
  day: {
    scroll: 'rgba(100, 100, 100, 0.4)',
    hover: 'rgba(100, 100, 100, 0.7)',
    active: 'rgba(0, 0, 0, 0.6)'
  },
  night: {
    scroll: 'rgba(121, 121, 121, 0.4)',
    hover: 'rgba(100, 100, 100, 0.7)',
    active: 'rgba(191, 191, 191, 0.4)'
  }
} as const;

type Plugin = {id: 'git' | 'files'; css: string; overlayClass: string};

// `@charset` is invalid after concatenation in the fixture stylesheet.
const readSheet = (id: 'git' | 'files') =>
  readFileSync(resolve(PLUGINS, id, `${id}.css`), 'utf8').replace(/^@charset[^;]*;\s*/, '');

const PLUGIN_LIST: Plugin[] = [
  {id: 'git', css: readSheet('git'), overlayClass: 'cyc-fx cyc-gt'},
  {id: 'files', css: readSheet('files'), overlayClass: 'cyc-fx'}
];

function rootStyle(dark: boolean): string {
  const el = document.createElement('div');
  applyCycScrollTheme(dark, el);
  return (el.getAttribute('style') ?? '').replace(/"/g, '&quot;');
}

function producedControls(plugin: Plugin, dark: boolean): {back: string; copy: string} {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const overlay = document.createElement('div');
  overlay.className = plugin.overlayClass;
  const back = document.createElement('button');
  back.className = 'cyc-fx-back';
  const copy = document.createElement('button');
  copy.className = 'cyc-fx-copy';
  copy.disabled = true;
  overlay.append(back, copy);
  document.body.append(overlay);
  if (plugin.id === 'git') paintGt(overlay, dark);
  else paintFx(overlay);
  const style = (el: HTMLElement) => (el.getAttribute('style') ?? '').replace(/"/g, '&quot;');
  const out = {back: style(back), copy: style(copy)};
  overlay.remove();
  return out;
}

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

async function measure(plugin: Plugin, theme: 'day' | 'night') {
  const dark = theme === 'night';
  const ctrl = producedControls(plugin, dark);
  const html =
    `<!DOCTYPE html><html data-theme="${dark ? 'dark' : 'light'}"><head><meta charset="utf-8">` +
    `<style>${plugin.css}</style></head><body>` +
    `<div id="cyc-app" style="${rootStyle(dark)}">` +
    `<div class="${plugin.overlayClass}">` +
    `<button id="back" class="cyc-fx-back" style="${ctrl.back}">B</button>` +
    `<button id="copy" class="cyc-fx-copy" style="${ctrl.copy}" disabled>C</button>` +
    `<div id="probe"></div>` +
    `</div></div></body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const root = getComputedStyle(document.querySelector('#cyc-app')!);
      const probe = getComputedStyle(document.querySelector('#probe')!);
      const back = getComputedStyle(document.querySelector('#back')!);
      const copy = getComputedStyle(document.querySelector('#copy')!);
      return {
        scroll: root.getPropertyValue('--cyc-overflow').trim(),
        hover: root.getPropertyValue('--cyc-overflow-hover').trim(),
        active: root.getPropertyValue('--cyc-overflow-active').trim(),
        scrollbarColor: probe.getPropertyValue('scrollbar-color').trim(),
        backBg: back.getPropertyValue('background-color').trim(),
        copyOpacity: copy.getPropertyValue('opacity').trim()
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

for (const plugin of PLUGIN_LIST) {
  describe(`${plugin.id} plugin page: scrollbar tints + control base`, () => {
    for (const theme of ['day', 'night'] as const) {
      test(`${theme}: the boot writer's inline vars feed the retained scrollbar skin`, async () => {
        const m = await measure(plugin, theme);
        const lit = LITERALS[theme];
        expect(m.scroll).toBe(lit.scroll);
        expect(m.hover).toBe(lit.hover);
        expect(m.active).toBe(lit.active);
        expect(m.scrollbarColor).toContain(lit.scroll);
      });

      test(`${theme}: the back base fill and disabled copy dim come from the producer, not the sheet`, async () => {
        const m = await measure(plugin, theme);
        expect(m.backBg).toBe('rgba(0, 0, 0, 0)');
        expect(m.copyOpacity).toBe('0.35');
      });
    }
  });
}
