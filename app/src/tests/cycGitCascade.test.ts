import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {
  gtHoverBack,
  gtHoverVbtn,
  gtHoverStep,
  gtHoverRow,
  gtHoverReview,
  gtForkDim,
  gtFx,
  paintGt
} from '../plugins/git/gitPaint';

function producedBase(theme: 'light' | 'dark'): {back: string; vbtn: string} {
  document.documentElement.dataset.theme = theme;
  const overlay = document.createElement('div');
  overlay.className = 'cyc-fx cyc-gt';
  const back = document.createElement('button');
  back.className = 'cyc-fx-back';
  const vbtn = document.createElement('button');
  vbtn.className = 'cyc-fx-vbtn';
  overlay.append(back, vbtn);
  document.body.append(overlay);
  paintGt(overlay, theme === 'dark');
  const style = (el: HTMLElement) => (el.getAttribute('style') ?? '').replace(/"/g, '&quot;');
  const out = {back: style(back), vbtn: style(vbtn)};
  overlay.remove();
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const GIT_CSS = resolve(HERE, '..', 'plugins', 'git', 'git.css');
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

const gitCss = () => readFileSync(GIT_CSS, 'utf8').replace(/^@charset[^;]*;\s*/, '');

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

// Render the plugin cascade and measure hovered properties.
async function measure(
  theme: 'light' | 'dark',
  nodes: {id: string; html: string}[],
  probes: {id: string; prop: string; pseudo?: string}[]
): Promise<Record<string, string>> {
  const classes = nodes.flatMap((n) => {
    const m = /class="([^"]*)"/.exec(n.html);
    return m ? tokenize(m[1]) : [];
  });
  const utilities = await compileTailwind(classes);
  const body = nodes.map((n) => n.html).join('');
  const html =
    '<!DOCTYPE html><html data-theme="' +
    theme +
    '"><head><meta charset="utf-8"><style>' +
    utilities +
    '\n/* un-layered git.css */\n' +
    gitCss() +
    '</style></head><body><div id="cyc-app"><div class="cyc-fx cyc-gt">' +
    body +
    '</div></div></body></html>';
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    const out: Record<string, string> = {};
    for (const {id, prop, pseudo} of probes) {
      await page.hover(`#${id}`);
      out[id] = await page.$eval(
        `#${id}`,
        (el, [p, ps]) => getComputedStyle(el, (ps as string) || null).getPropertyValue(p as string),
        [prop, pseudo ?? ''] as [string, string]
      );
    }
    return out;
  } finally {
    await page.close();
  }
}

const toRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const DAY = gtFx(false);
const NIGHT = gtFx(true);
const pick = (theme: 'light' | 'dark') => (theme === 'dark' ? NIGHT : DAY);

for (const theme of ['light', 'dark'] as const) {
  describe(`git cascade (${theme}): utilities and the inline fill must beat the un-layered git.css`, () => {
    test('back / vbtn hover backgrounds beat the inline background:none; stepbtn beats the button surface', async () => {
      const base = producedBase(theme);
      const s = await measure(
        theme,
        [
          {
            id: 'back',
            html: `<button id="back" class="cyc-fx-back ${gtHoverBack(theme === 'dark')}" style="${base.back}">B</button>`
          },
          {
            id: 'vbtn',
            html: `<button id="vbtn" class="cyc-fx-vbtn ${gtHoverVbtn(theme === 'dark')}" style="${base.vbtn}">V</button>`
          },
          {
            id: 'step',
            html: `<button id="step" class="cyc-cx-stepbtn ${gtHoverStep(theme === 'dark')}">‹</button>`
          }
        ],
        [
          {id: 'back', prop: 'background-color'},
          {id: 'vbtn', prop: 'background-color'},
          {id: 'step', prop: 'background-color'}
        ]
      );
      const hoverBg = toRgb(pick(theme).hoverBg);
      expect(s.back).toBe(hoverBg);
      expect(s.vbtn).toBe(hoverBg);
      expect(s.step).toBe(hoverBg);
    });

    test('back / vbtn / review hover ink beats the dim residual (and the inline dim paint)', async () => {
      const dim = toRgb(pick(theme).dim);
      const s = await measure(
        theme,
        [
          {
            id: 'back',
            html: `<button id="back" class="cyc-fx-back ${gtHoverBack(theme === 'dark')}">B</button>`
          },
          {
            id: 'vbtn',
            html: `<button id="vbtn" class="cyc-fx-vbtn ${gtHoverVbtn(theme === 'dark')}">V</button>`
          },
          {
            id: 'review',
            html: `<button id="review" style="color:${dim}" class="cyc-gt-review ${gtHoverReview(theme === 'dark')}">R</button>`
          }
        ],
        [
          {id: 'back', prop: 'color'},
          {id: 'vbtn', prop: 'color'},
          {id: 'review', prop: 'color'}
        ]
      );
      const fg = toRgb(pick(theme).fg);
      expect(s.back).toBe(fg);
      expect(s.vbtn).toBe(fg);
      expect(s.review).toBe(fg);
      expect(s.review).not.toBe(dim);
    });

    test('a plain row takes the hover fill; a selected row keeps its inline fill (the :not guard)', async () => {
      const selBg = toRgb(pick(theme).selBg);
      const s = await measure(
        theme,
        [
          {
            id: 'plain',
            html: `<div id="plain" class="cyc-gt-row ${gtHoverRow(theme === 'dark')}">p</div>`
          },
          {
            id: 'sel',
            html: `<div id="sel" style="background:${selBg}" class="cyc-gt-row cyc-gt-row-on ${gtHoverRow(theme === 'dark')}">s</div>`
          }
        ],
        [
          {id: 'plain', prop: 'background-color'},
          {id: 'sel', prop: 'background-color'}
        ]
      );
      expect(s.plain).toBe(toRgb(pick(theme).hoverBg));
      expect(s.sel).toBe(selBg);
    });

    test('the branch fork ::before takes the dim ink (a pseudo-element can only be a class)', async () => {
      const s = await measure(
        theme,
        [
          {
            id: 'fork',
            html: `<span id="fork" class="cyc-gt-branch-name before:content-['x'] ${gtForkDim(theme === 'dark')}">main</span>`
          }
        ],
        [{id: 'fork', prop: 'color', pseudo: '::before'}]
      );
      expect(s.fork).toBe(toRgb(pick(theme).dim));
    });
  });
}
