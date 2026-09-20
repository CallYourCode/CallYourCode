import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Verifies karaoke fades in Chromium because jsdom cannot resolve this cascade.

import {karaokeFor} from '../features/chat/content';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const SRC = resolve(HERE, '..');
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

// Read classes from the live DOM to preserve arbitrary variants.
function candidatesOf(...roots: Element[]): string[] {
  const out = new Set<string>();
  for (const root of roots)
    for (const el of [root, ...root.querySelectorAll('*')])
      for (const c of el.classList) out.add(c);
  return [...out];
}

// Build karaoke DOM with one spoken word.
function karaokeBox(live: boolean): HTMLElement {
  const box = document.createElement('div');
  box.className = 'cyc-karaoke' + (live ? ' cyc-hot' : '');
  box.textContent = 'alpha beta gamma delta';
  karaokeFor(box);
  const words = box.querySelectorAll<HTMLElement>('.cyc-kw');
  words[0].classList.add('cyc-spoken');
  return box;
}

async function resolveKaraoke(bodyHtml: string, candidates: string[]) {
  const utilities = await compileTailwind(candidates);
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/media/media.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
    `<body>${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const read = (el: HTMLElement) => {
        const s = getComputedStyle(el);
        return {
          opacity: s.opacity,
          transitionProperty: s.transitionProperty,
          transitionDuration: s.transitionDuration,
          transitionTimingFunction: s.transitionTimingFunction
        };
      };
      const boxes = document.querySelectorAll<HTMLElement>('.cyc-karaoke');
      const at = (box: HTMLElement, spoken: boolean) =>
        read(
          box.querySelector<HTMLElement>(
            spoken ? '.cyc-kw.cyc-spoken' : '.cyc-kw:not(.cyc-spoken)'
          )!
        );
      return {
        idleUnspoken: at(boxes[0], false),
        liveUnspoken: at(boxes[1], false),
        liveSpoken: at(boxes[1], true)
      };
    });
  } finally {
    await page.close();
  }
}

afterAll(async () => {
  await browser?.close();
});

describe('karaoke live/spoken fade drain', () => {
  test('live word dims to .45 with a 300ms opacity ease; spoken snaps to .999 with no transition', async () => {
    const idle = karaokeBox(false);
    const live = karaokeBox(true);
    const body = `<div>${idle.outerHTML}</div><div>${live.outerHTML}</div>`;
    const g = await resolveKaraoke(body, candidatesOf(idle, live));

    expect(g.idleUnspoken.opacity).toBe('1');
    expect(g.idleUnspoken.transitionDuration).toBe('0s');

    expect(g.liveUnspoken.opacity).toBe('0.45');
    expect(g.liveUnspoken.transitionProperty).toBe('opacity');
    expect(g.liveUnspoken.transitionDuration).toBe('0.3s');
    expect(g.liveUnspoken.transitionTimingFunction).toBe('linear');

    expect(g.liveSpoken.opacity).toBe('0.999');
    expect(g.liveSpoken.transitionDuration).toBe('0s');
  });
});
