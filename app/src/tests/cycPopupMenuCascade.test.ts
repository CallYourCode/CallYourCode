import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {openMenu} from '../components/popupMenu';
import type {CycMenuItem} from '../components/popupMenu';

// Regression for the harness picker: icon-less rows ("Claude"/"Codex"/
// "OpenCode") clipped to one character because their lone text span auto-placed
// into the fixed 1.5rem icon column. Prove the real Chromium layout gives an
// icon-less item a single text track wide enough to show the whole label.

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

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

const classesIn = (root: Element): string[] => {
  const out = new Set<string>();
  const walk = (el: Element) => {
    for (const c of el.classList) out.add(c);
    for (const child of el.children) walk(child);
  };
  walk(root);
  return [...out];
};

type Row = {
  cols: string; // grid-template-columns on the item
  textW: number; // rendered width of the label span
  textLeft: number; // label offset within the item
  itemW: number;
};

// Render a real openMenu tree in Chromium and measure the first item's label.
async function measureMenu(items: CycMenuItem[]): Promise<Row> {
  const {element} = openMenu(items, {clientX: 40, clientY: 40} as MouseEvent);
  const markup = element.outerHTML;
  element.remove();

  const utilities = await compileTailwind(classesIn(element));
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8');
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
    `<body>${markup}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const item = document.querySelector('.cyc-menu-item') as HTMLElement;
      const text = item.querySelector('.cyc-menu-item-text') as HTMLElement;
      const itemBox = item.getBoundingClientRect();
      const textBox = text.getBoundingClientRect();
      return {
        cols: getComputedStyle(item).getPropertyValue('grid-template-columns'),
        textW: textBox.width,
        textLeft: textBox.left - itemBox.left,
        itemW: itemBox.width
      };
    });
  } finally {
    await page.close();
  }
}

describe('popupMenu item grid: icon-less rows are not clipped to the icon column', () => {
  test('an icon-less harness row gets a single text track and shows the whole label', async () => {
    const r = await measureMenu([
      {text: 'OpenCode', onClick: () => {}},
      {text: 'Claude', onClick: () => {}}
    ]);
    // One text track, not the 1.5rem icon column + 1fr.
    expect(r.cols).not.toContain('24px');
    // The label sits at the item's inner edge (px-3 = 12px), not pushed to the
    // second column at 24 + 12 = 36px, and is wide enough for the whole word,
    // far past the ~24px one-character clip.
    expect(r.textLeft).toBeLessThan(20);
    expect(r.textW).toBeGreaterThan(48);
  });

  test('an item with an icon still reserves the 24px icon track', async () => {
    const r = await measureMenu([
      {icon: 'folder', text: 'projects/callyourcode', onClick: () => {}}
    ]);
    // First track is the 1.5rem (24px) icon column.
    expect(r.cols.startsWith('24px')).toBe(true);
    // Label sits past the icon column + gap (24 + 12 = 36px).
    expect(r.textLeft).toBeGreaterThan(30);
  });
});
