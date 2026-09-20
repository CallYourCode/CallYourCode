import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser, type Page} from 'playwright';


const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const MEDIA = resolve(HERE, '..', 'features', 'media', 'media.css');
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

// Theme sentinel: the preloader colour resolves through --cyc-accent.
const SENTINEL = `<style>:root{--cyc-accent:rgb(10,20,30)}</style>`;

const PRIMARY = 'rgb(10, 20, 30)';

function collectClasses(root: Element, into: Set<string>) {
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const cls = node.getAttribute('class');
    if (cls) for (const t of tokenize(cls)) into.add(t);
  }
}

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
let page: Page;

beforeAll(async () => {
  // The file-viewer loader host: the same explicit .cyc-loader-inline DOM the
  // fileViewer/htmlViewer producers inline (a 40px conic-gradient ring).
  const host = document.createElement('div');
  host.className = 'cyc-file-viewer';
  const loader = document.createElement('div');
  loader.className = 'cyc-loader-inline flex justify-center py-12';
  loader.innerHTML =
    '<span class="cyc-loader-ring cyc-loader-path block w-10 h-10 rounded-full ' +
    'stroke-[var(--cyc-accent)] ' +
    'bg-[conic-gradient(from_0deg,transparent,var(--cyc-accent))] ' +
    '[mask:radial-gradient(farthest-side,transparent_calc(100%_-_4px),#000_0)] ' +
    '[-webkit-mask:radial-gradient(farthest-side,transparent_calc(100%_-_4px),#000_0)] ' +
    '[animation:cyc-spin_0.85s_linear_infinite]"></span>';
  host.appendChild(loader);

  const classes = new Set<string>();
  collectClasses(host, classes);
  const utilities = await compileTailwind(Array.from(classes));
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(MEDIA, 'utf8');
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered sheets */\n${shell}</style>${SENTINEL}</head><body>` +
    `<div id="host" style="position:relative;width:300px;height:300px">${host.outerHTML}</div>` +
    `</body></html>`;
  page = await (await getBrowser()).newPage();
  await page.setContent(html, {waitUntil: 'load'});
});

afterAll(async () => {
  await page?.close();
  await browser?.close();
});

describe('viewer preloader: current .cyc-loader-inline paint reproduces media.css', () => {
  test('the file/html-viewer preloader keeps flex-centered padding, ring size and stroke', async () => {
    const p = await page.$eval('#host', (root) => {
      const cs = (el: Element) => getComputedStyle(el);
      const wrap = root.querySelector('.cyc-loader-inline')!;
      const ring = root.querySelector('.cyc-loader-ring')!;
      const path = root.querySelector('.cyc-loader-path')!;
      const w = cs(wrap);
      const r = cs(ring);
      return {
        display: w.display,
        justify: w.justifyContent,
        padTop: w.paddingTop,
        padBottom: w.paddingBottom,
        ringWidth: r.width,
        ringHeight: r.height,
        stroke: cs(path).stroke
      };
    });

    expect(p.display).toBe('flex'); // .cyc-loader-inline display:flex
    expect(p.justify).toBe('center'); // justify-content:center
    expect(p.padTop).toBe('48px'); // padding: 3rem 0 @ 16px
    expect(p.padBottom).toBe('48px');
    expect(p.ringWidth).toBe('40px'); // 2.5rem @ 16px
    expect(p.ringHeight).toBe('40px');
    expect(p.stroke).toBe(PRIMARY); // stroke: var(--cyc-accent)
  });
});
