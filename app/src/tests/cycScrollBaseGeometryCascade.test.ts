import {afterAll, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {scrollSurface} from '../shared/dom';
import {autosize} from '../features/composer/editor';

// Chromium computed-style coverage for scrollSurface and autosize geometry.

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

const tokenize = (className: string) => className.trim().split(/\s+/).filter(Boolean);

const PROPS = [
  'position',
  'top',
  'left',
  'width',
  'height',
  'max-height',
  'overflow-x',
  'overflow-y'
] as const;
type Probe = Record<(typeof PROPS)[number], string>;

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

// Mount a node with the exact producer className under the shrunk un-layered shell (its
// compiled utilities are layered), inside an 800x800 positioned parent, and read the
// computed box back in Chromium.
async function measure(className: string): Promise<Probe> {
  const utilities = await compileTailwind(tokenize(className));
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
    `<body><div id="parent" style="position:relative;width:800px;height:800px">` +
    `<div id="n" class="${className}"></div></div></body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(
      (props) => {
        const cs = getComputedStyle(document.querySelector('#n')!);
        const o: Record<string, string> = {};
        for (const p of props) o[p] = cs.getPropertyValue(p);
        return o as never;
      },
      PROPS as unknown as string[]
    );
  } finally {
    await page.close();
  }
}

// Capture the exact classNames the real producers emit.
function producers() {
  const scroll = scrollSurface().className;

  const input = document.createElement('div');
  const a = autosize(input);
  const field = input.className;
  a.destroy();

  // pairing/screen.ts builds its scroll node inside mountPairingScreen (which pulls the
  // engine/keyring stack); read its base-only literal from source and guard it there.
  const pairingSrc = readFileSync(resolve(SRC, 'features/pairing/screen.ts'), 'utf8');
  const pairMatch = pairingSrc.match(
    /'(cyc-pairing-scroll cyc-overflow[^']*)'\s*\+\s*\n\s*'([^']*)'/
  );
  const pairing = pairMatch ? (pairMatch[1] + pairMatch[2]).trim() : '';

  return {scroll, field, pairing};
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterAll(async () => {
  await browser?.close();
});

describe('overflow primitives', () => {
  test('scrollSurface fills its positioned host and supplies a finite vertical viewport', async () => {
    const p = producers();
    for (const t of [
      'cyc-overflow-pane',
      'absolute',
      'inset-0',
      'w-full',
      'max-h-full',
      'overflow-x-hidden',
      'overflow-y-auto',
      'overscroll-contain'
    ]) {
      expect(tokenize(p.scroll)).toContain(t);
    }
    const g = await measure(p.scroll);
    expect(g.position).toBe('absolute');
    expect(g['overflow-x']).toBe('hidden');
    expect(g['overflow-y']).toBe('auto');
  });

  test('the autosize field carries the same base fill (position pinned relative inline)', async () => {
    const p = producers();
    const g = await measure(p.field);
    // The class-level geometry is absolute-fill; the live field is pinned `relative` inline
    // in autosize(), which beats any stylesheet -- assert the box the classes contribute.
    expect(g['overflow-x']).toBe('hidden');
    expect(g['overflow-y']).toBe('auto');
    expect(g['max-height']).toBe('100%');
  });
});

describe('cyc-overflow base-only drain: pairing keeps overflow-hidden (does not scroll)', () => {
  test('pairing scroll is an absolute fill with both overflow axes hidden', async () => {
    const p = producers();
    expect(p.pairing).toContain('cyc-overflow');
    expect(p.pairing).toContain('overflow-hidden');
    expect(p.pairing).not.toContain('cyc-overflow-y');
    expect(p.pairing).not.toContain('overflow-y-auto');
    const g = await measure(p.pairing);
    expect(g.position).toBe('absolute');
    expect(g['overflow-x']).toBe('hidden');
    expect(g['overflow-y']).toBe('hidden'); // preserved: no `-y`, this region never scrolls
  });
});

describe('relative! consumers still beat the final layered base', () => {
  // settings/pane.ts, sessions/panes/listPane.ts add `relative! flex-auto`;
  // media/fileViewer.ts adds `relative! flex-[1_1_auto]`. All must compute position:relative.
  for (const consumer of ['relative! flex-auto', 'relative! flex-[1_1_auto]'] as const) {
    test(`\`${consumer}\` on the scrollContainer base computes position:relative`, async () => {
      const p = producers();
      const g = await measure(`${p.scroll} ${consumer}`);
      expect(g.position).toBe('relative'); // relative! (layered, important) beats absolute
      expect(g['overflow-y']).toBe('auto'); // the scroll still scrolls vertically
    });
  }
});
