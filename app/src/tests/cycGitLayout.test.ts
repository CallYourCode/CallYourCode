import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Real-Chromium computed-style coverage for Git layout.

import {
  GT_ROW,
  GT_SEC,
  GT_BRANCH,
  GT_BRANCH_GAP,
  GT_BRANCH_PICK,
  GT_LABEL,
  GT_NAME,
  GT_ACT,
  CX_FILE,
  CX_DOC,
  CX_FHEAD,
  CX_STEPBTN,
  CX_STEP
} from '../plugins/git/gitChrome';

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

type Probe = {id: string; props: string[]};

// Render the fixture with the production stylesheet order.
async function measure(
  theme: 'light' | 'dark',
  body: string,
  probes: Probe[]
): Promise<Record<string, Record<string, string>>> {
  const classes = [...body.matchAll(/class="([^"]*)"/g)].flatMap((m) => tokenize(m[1]));
  const utilities = await compileTailwind(classes);
  const html =
    '<!DOCTYPE html><html data-theme="' +
    theme +
    '"><head><meta charset="utf-8"><style>' +
    utilities +
    '\n/* un-layered git.css */\n' +
    gitCss() +
    '</style></head><body><div id="cyc-app"><div id="cyc-stage"><div class="cyc-fx cyc-gt">' +
    body +
    '</div></div></div></body></html>';
  const page = await (await getBrowser()).newPage();
  await page.setViewportSize({width: 1000, height: 700});
  try {
    await page.setContent(html, {waitUntil: 'load'});
    const out: Record<string, Record<string, string>> = {};
    for (const {id, props} of probes) {
      out[id] = await page.$eval(
        `#${id}`,
        (el, list) => {
          const cs = getComputedStyle(el as HTMLElement);
          const r: Record<string, string> = {};
          for (const p of list as string[]) r[p] = cs.getPropertyValue(p);
          return r;
        },
        props
      );
    }
    return out;
  } finally {
    await page.close();
  }
}

for (const theme of ['light', 'dark'] as const) {
  describe(`git layout (${theme}): constant geometry resolves`, () => {
    test('a file row keeps its min-height and asymmetric padding', async () => {
      const s = await measure(theme, `<div id="row" class="cyc-gt-row ${GT_ROW}">r</div>`, [
        {id: 'row', props: ['display', 'align-items', 'min-height', 'padding', 'column-gap']}
      ]);
      expect(s.row.display).toBe('flex');
      expect(s.row['align-items']).toBe('center');
      expect(s.row['min-height']).toBe('26px');
      expect(s.row.padding).toBe('0px 8px 0px 12px');
      expect(s.row['column-gap']).toBe('6px');
    });

    test('a section head stays an uppercase space-between row', async () => {
      const s = await measure(theme, `<div id="sec" class="cyc-gt-sec ${GT_SEC}">s</div>`, [
        {id: 'sec', props: ['display', 'justify-content', 'text-transform', 'padding', 'font-size']}
      ]);
      expect(s.sec.display).toBe('flex');
      expect(s.sec['justify-content']).toBe('space-between');
      expect(s.sec['text-transform']).toBe('uppercase');
      expect(s.sec.padding).toBe('10px 12px 4px');
      expect(s.sec['font-size']).toBe('11px');
    });

    test('the branch card keeps its box, radius and column gap', async () => {
      const s = await measure(
        theme,
        `<button id="card" class="cyc-gt-branch ${GT_BRANCH} ${GT_BRANCH_GAP} cyc-gt-branch-pick ${GT_BRANCH_PICK}">b</button>`,
        [
          {
            id: 'card',
            props: ['display', 'flex-wrap', 'padding', 'border-radius', 'column-gap', 'width']
          }
        ]
      );
      expect(s.card.display).toBe('flex');
      expect(s.card['flex-wrap']).toBe('wrap');
      expect(s.card.padding).toBe('8px 10px');
      expect(s.card['border-radius']).toBe('6px');
      expect(s.card['column-gap']).toBe('8px');
      expect(s.card.width).toBe('976px');
    });

    test('the clabel combinator still overrides the current name flex', async () => {
      const s = await measure(
        theme,
        `<span class="cyc-gt-label cyc-gt-clabel ${GT_LABEL}">` +
          `<span id="plain" class="cyc-gt-name ${GT_NAME}">a</span></span>` +
          `<span class="cyc-gt-label ${GT_LABEL}">` +
          `<span id="free" class="cyc-gt-name ${GT_NAME}">b</span></span>`,
        [
          {id: 'plain', props: ['flex-grow', 'flex-shrink', 'overflow', 'text-overflow']},
          {id: 'free', props: ['flex-grow', 'flex-shrink']}
        ]
      );
      expect(s.plain['flex-grow']).toBe('1');
      expect(s.free['flex-grow']).toBe('0');
      expect(s.free['flex-shrink']).toBe('1');
      expect(s.plain.overflow).toBe('hidden');
      expect(s.plain['text-overflow']).toBe('ellipsis');
    });

    test('the first change-viewer file drops its top border, the next keeps it', async () => {
      const s = await measure(
        theme,
        `<div class="cyc-cx-doc ${CX_DOC}">` +
          `<div id="f0" class="cyc-cx-file ${CX_FILE}">0</div>` +
          `<div id="f1" class="cyc-cx-file ${CX_FILE}">1</div></div>`,
        [
          {id: 'f0', props: ['border-top-width', 'border-top-style', 'flex-direction']},
          {id: 'f1', props: ['border-top-width', 'border-top-style']}
        ]
      );
      expect(s.f0['border-top-style']).toBe('none');
      expect(s.f0['border-top-width']).toBe('0px');
      expect(s.f0['flex-direction']).toBe('column');
      expect(s.f1['border-top-style']).toBe('solid');
      expect(s.f1['border-top-width']).toBe('1px');
    });

    test('the sticky file head keeps its position and min-height', async () => {
      const s = await measure(theme, `<div id="head" class="cyc-cx-fhead ${CX_FHEAD}">h</div>`, [
        {id: 'head', props: ['position', 'min-height', 'z-index', 'padding']}
      ]);
      expect(s.head.position).toBe('sticky');
      expect(s.head['min-height']).toBe('28px');
      expect(s.head['z-index']).toBe('2');
      expect(s.head.padding).toBe('4px 10px');
    });

    test('the action badge and step button keep their box, residual state still wins', async () => {
      const s = await measure(
        theme,
        `<span id="act" class="cyc-gt-act ${GT_ACT} cyc-gt-act-off">.</span>` +
          `<div class="cyc-cx-step ${CX_STEP}">` +
          `<button id="step" class="cyc-cx-stepbtn ${CX_STEPBTN}">-</button>` +
          `<button id="stepoff" class="cyc-cx-stepbtn ${CX_STEPBTN}" disabled>-</button></div>`,
        [
          {id: 'act', props: ['width', 'height', 'opacity']},
          {id: 'step', props: ['width', 'height', 'opacity']},
          {id: 'stepoff', props: ['opacity']}
        ]
      );
      expect(s.act.width).toBe('24px');
      expect(s.act.height).toBe('24px');
      expect(s.act.opacity).toBe('0.5');
      expect(s.step.width).toBe('24px');
      expect(s.step.opacity).toBe('1');
      expect(s.stepoff.opacity).toBe('0.3');
    });
  });
}
