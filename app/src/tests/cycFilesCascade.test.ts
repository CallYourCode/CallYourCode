import {afterAll, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';


import {paintFx} from '../plugins/files/filesPaint';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const FILES_CSS = resolve(HERE, '..', 'plugins', 'files', 'files.css');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

// Compile the real Tailwind utilities for the exact class tokens the producer
// emits, using the app's real entry sheet (its @theme breakpoints and the `fine`
// custom variant), so a trailing `!` maps to a real `!important` utility in the
// utilities cascade layer -- authoritative, not hand-authored.
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

// files.css minus its leading `@charset`, which is only valid at the very start
// of a sheet and would be dropped anyway once embedded in the combined <style>.
const filesCss = () => readFileSync(FILES_CSS, 'utf8').replace(/^@charset[^;]*;\s*/, '');

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

type Painted = {cls: string; style: string};
function producedClasses(theme: 'light' | 'dark'): {
  back: Painted;
  vbtn: Painted;
  tabx: Painted;
} {
  document.documentElement.dataset.theme = theme;
  const overlay = document.createElement('div');
  overlay.className = 'cyc-fx';
  const back = document.createElement('button');
  back.className = 'cyc-fx-back';
  const vbtn = document.createElement('button');
  vbtn.className = 'cyc-fx-vbtn';
  const tabx = document.createElement('button');
  tabx.className = 'cyc-fx-tab-x';
  overlay.append(back, vbtn, tabx);
  document.body.append(overlay);
  paintFx(overlay);
  const painted = (el: HTMLElement): Painted => ({
    cls: el.className,
    style: el.getAttribute('style') ?? ''
  });
  return {back: painted(back), vbtn: painted(vbtn), tabx: painted(tabx)};
}

// Build the exact stack the plugin page ships (real Tailwind utilities, then
// files.css, plus the producer's inline base), hover each control so its `:hover` /
// `:hover:enabled` state is live, and read back the computed property.
async function measureHover(
  cls: {back: Painted; vbtn: Painted; tabx: Painted},
  probes: Record<string, {prop: string}>
): Promise<Record<string, string>> {
  const utilities = await compileTailwind([
    ...tokenize(cls.back.cls),
    ...tokenize(cls.vbtn.cls),
    ...tokenize(cls.tabx.cls)
  ]);
  // Mount the real painted element -- class *and* the inline base the producer
  // emits (`background:none` / `opacity:.55`) -- so the hover utility has the
  // real inline base to beat.
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    utilities +
    '\n/* files.css */\n' +
    filesCss() +
    '</style></head><body><div id="cyc-app"><div class="cyc-fx">' +
    `<button id="back" class="${cls.back.cls}" style="${cls.back.style}">B</button>` +
    `<button id="vbtn" class="${cls.vbtn.cls}" style="${cls.vbtn.style}">V</button>` +
    `<button id="tabx" class="${cls.tabx.cls}" style="${cls.tabx.style}">x</button>` +
    '</div></div></body></html>';
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    const out: Record<string, string> = {};
    for (const [id, {prop}] of Object.entries(probes)) {
      // Real hover so :hover / :hover:enabled apply; the pointer stays over the
      // element while its computed style is read.
      await page.hover(`#${id}`);
      out[id] = await page.$eval(
        `#${id}`,
        (el, p) => getComputedStyle(el).getPropertyValue(p as string),
        prop
      );
    }
    return out;
  } finally {
    await page.close();
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.dataset.theme = 'light';
});
afterAll(async () => {
  await browser?.close();
});

describe('files cascade: hover utilities must beat the inline .cyc-fx base', () => {
  test('day: back + vbtn hover backgrounds beat background:none, tab-x hover opacity beats .55', async () => {
    const cls = producedClasses('light');
    const s = await measureHover(cls, {
      back: {prop: 'background-color'},
      vbtn: {prop: 'background-color'},
      tabx: {prop: 'opacity'}
    });
    expect(s.back).toBe('rgb(242, 242, 242)'); // #f2f2f2
    expect(s.vbtn).toBe('rgb(242, 242, 242)'); // #f2f2f2, past :hover:enabled
    expect(s.tabx).toBe('1'); // opacity:1, not .55
  });

  test('night: back + vbtn hover backgrounds beat background:none, tab-x hover opacity beats .55', async () => {
    const cls = producedClasses('dark');
    const s = await measureHover(cls, {
      back: {prop: 'background-color'},
      vbtn: {prop: 'background-color'},
      tabx: {prop: 'opacity'}
    });
    expect(s.back).toBe('rgb(42, 45, 46)'); // #2a2d2e
    expect(s.vbtn).toBe('rgb(42, 45, 46)'); // #2a2d2e, past :hover:enabled
    expect(s.tabx).toBe('1'); // opacity:1, not .55
  });
});
