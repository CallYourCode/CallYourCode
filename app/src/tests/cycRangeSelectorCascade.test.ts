import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser, type Page} from 'playwright';

// Chromium computed-style coverage for the reply dial.

import {createDialPanel, type DialStep} from '../components/replyLevel';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const SETTINGS = resolve(HERE, '..', 'features', 'settings', 'settings.css');
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

// Theme sentinels: the range colours resolve through the accent / muted-text tokens,
// which fork on html[data-theme]; these name what each var resolved to per theme.
const SENTINEL =
  `<style>:root{--cyc-accent:rgb(10,20,30);--cyc-secondary-color:rgb(40,50,60);` +
  `--cyc-text-muted:rgb(70,80,90)}` +
  `html[data-theme='dark']{--cyc-accent:rgb(110,120,130);--cyc-secondary-color:rgb(140,150,160);` +
  `--cyc-text-muted:rgb(170,180,190)}</style>`;

const STEPS: DialStep[] = [
  {n: 0, name: 'A'},
  {n: 1, name: 'B'},
  {n: 2, name: 'C'}
];

// The exact subtree each dial ships: outerHTML plus every class token in it, so the
// Tailwind compile covers the notch/segment/tag literals the producer emits.
const dialDom = (key: string) => {
  const {el} = createDialPanel({key, title: key, steps: STEPS, value: 1, onPick: () => {}});
  el.classList.remove('cyc-off'); // mount visible so layout (widths/positions) resolves
  const classes = new Set<string>();
  for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
    const cls = node.getAttribute('class');
    if (cls) for (const t of tokenize(cls)) classes.add(t);
  }
  return {html: el.outerHTML, classes: Array.from(classes)};
};

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

let page: Page;

beforeAll(async () => {
  const verbosity = dialDom('verbosity');
  const complexity = dialDom('complexity');
  const classes = new Set<string>([...verbosity.classes, ...complexity.classes]);
  const utilities = await compileTailwind(Array.from(classes));
  const shell =
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(SETTINGS, 'utf8') +
    '\n' +
    readFileSync(MEDIA, 'utf8');
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered sheets */\n${shell}</style>${SENTINEL}</head><body>` +
    `<div id="verbosity" style="width:300px">${verbosity.html}</div>` +
    `<div id="complexity" style="width:300px">${complexity.html}</div>` +
    `</body></html>`;
  page = await (await getBrowser()).newPage();
  await page.setContent(html, {waitUntil: 'load'});
});

afterAll(async () => {
  await page?.close();
  await browser?.close();
});

const theme = async (name: string) => {
  await page.evaluate(
    (t) =>
      t === 'dark'
        ? document.documentElement.setAttribute('data-theme', 'dark')
        : document.documentElement.removeAttribute('data-theme'),
    name
  );
  // settings.css puts `transition: background-color 120ms` on the notch, so a live
  // theme switch animates its bg; let it settle before reading the computed colour.
  await page.waitForTimeout(200);
};
const direction = (d: string) =>
  page.evaluate((v) => document.documentElement.setAttribute('dir', v), d);

const COLOR = {
  light: {accent: 'rgb(10, 20, 30)', muted: 'rgb(70, 80, 90)'},
  dark: {accent: 'rgb(110, 120, 130)', muted: 'rgb(170, 180, 190)'}
} as const;
const IDLE = 'rgba(127, 127, 127, 0.32)';
// Stops are deliberately darker than the rail so they read as dots on the
// faded line (simple-slider decision, 2026-09-06).
const STOP_IDLE = 'rgba(127, 127, 127, 0.7)';

type Rect = {left: number; right: number; top: number; bottom: number; width: number};
const centre = (r: Rect) => (r.left + r.right) / 2;

const probe = (root: string) =>
  page.$eval(root, (host) => {
    const cs = (el: Element) => getComputedStyle(el);
    const v = (el: Element, name: string) => cs(el).getPropertyValue(name).trim();
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width};
    };
    const container = host.querySelector('.cyc-steprange')!;
    const segs = Array.from(host.querySelectorAll('.cyc-steprange-seg'));
    const notches = Array.from(host.querySelectorAll('.cyc-steprange-notch'));
    const tags = Array.from(host.querySelectorAll('.cyc-steprange-tag'));
    const c = cs(container);
    return {
      pad: {top: c.paddingTop, right: c.paddingRight, bottom: c.paddingBottom, left: c.paddingLeft},
      tokens: {
        rail: v(container, '--cyc-steprange-rail'),
        grab: v(container, '--cyc-steprange-grab')
      },
      seg: segs.map((s) => cs(s).backgroundColor),
      notch: notches.map((n) => ({bg: cs(n).backgroundColor, rect: rect(n)})),
      tag: tags.map((t) => ({color: cs(t).color, rect: rect(t)}))
    };
  });

describe('reply-dial cascade: current producers reproduce the reply-level skin', () => {
  for (const t of ['light', 'dark'] as const) {
    for (const d of ['ltr', 'rtl'] as const) {
      test(`geometry + paint reproduced (${t}, ${d})`, async () => {
        await theme(t);
        await direction(d);
        const col = COLOR[t];
        // The dial ships value:1 -> the crossed run is seg0 + notch0/notch1, the
        // un-crossed run is seg1 + notch2, so both the reached ink and the idle base
        // are exercised straight from the producer.
        const v = await probe('#verbosity');
        const c = await probe('#complexity');

        // Container padding: the steppedRangeSlider inline 1rem wins over the base
        // `.cyc-replylevel-range` shorthand -> 16px all sides for verbosity; complexity
        // keeps its inline padding-top:2.375rem (38px) from replyLevel.ts.
        expect(v.pad).toEqual({top: '16px', right: '16px', bottom: '16px', left: '16px'});
        expect(c.pad).toEqual({top: '38px', right: '16px', bottom: '16px', left: '16px'});

        // Geometry tokens: baked as layered literals on the producer.
        expect(v.tokens).toEqual({rail: '0.2rem', grab: '1.2'});

        // Structure: three notches joined by two connector segments.
        expect(v.seg).toHaveLength(2);
        expect(v.notch).toHaveLength(3);
        expect(v.tag).toHaveLength(3);

        // Fill = the crossed run inked to the accent, the rest the reply-skin idle grey.
        expect(v.seg[0]).toBe(col.accent);
        expect(v.seg[1]).toBe(IDLE);
        expect(v.notch[0].bg).toBe(col.accent);
        expect(v.notch[1].bg).toBe(col.accent);
        expect(v.notch[2].bg).toBe(STOP_IDLE);

        // Grip: the selected notch (data-current) swells past the idle notches; the
        // `data-[current=true]` size utility wins the layered cascade.
        expect(v.notch[1].rect.width).toBeGreaterThan(v.notch[0].rect.width);
        expect(v.notch[1].rect.width).toBeGreaterThan(v.notch[2].rect.width);

        // Tag colours owned by settings.css: selected accent, the rest the muted token.
        expect(v.tag[0].color).toBe(col.muted);
        expect(v.tag[1].color).toBe(col.accent);
        expect(v.tag[2].color).toBe(col.muted);

        // Every tag rides above its own notch (bottom-anchored placement).
        for (let i = 0; i < 3; i++) {
          expect(v.tag[i].rect.bottom).toBeLessThanOrEqual(v.notch[i].rect.top + 0.5);
        }
        // The interior tag centres on its notch; the endpoints pin to the notch's
        // outer (inline) edge so they stay within the rail. Asserted as the edge
        // alignment itself: a centre-delta threshold silently depended on the
        // dot width and broke when the dots grew (2026-09-06).
        expect(Math.abs(centre(v.tag[1].rect) - centre(v.notch[1].rect))).toBeLessThan(1);
        expect(Math.abs(v.tag[0].rect.left - v.notch[0].rect.left)).toBeLessThan(1);
        expect(Math.abs(v.tag[2].rect.right - v.notch[2].rect.right)).toBeLessThan(1);

        // Complexity dial reproduces the same reached/idle cascade and above-notch tags.
        expect(c.notch[1].bg).toBe(col.accent);
        expect(c.notch[2].bg).toBe(STOP_IDLE);
        expect(c.tag[1].color).toBe(col.accent);
        for (let i = 0; i < 3; i++) {
          expect(c.tag[i].rect.bottom).toBeLessThanOrEqual(c.notch[i].rect.top + 0.5);
        }
      });
    }
  }
});

describe('reply-level plugin label: inline line-clamp box owns it after the dropped settings.css rule', () => {
  // The label's inline `line-clamp-2 h-[2.1rem]` owns the exact clamp box. This stacks the
  // real settings.css, so it proves the inline utilities alone reproduce the display/
  // -webkit-box-orient/-webkit-line-clamp/overflow/height (verified computed-equal in Chromium).
  test('the 2-line clamp box (display/orient/clamp/overflow/height) is inline-owned', async () => {
    await theme('light');
    await direction('ltr');
    const l = await page.$eval('#verbosity .cyc-replylevel-label', (el) => {
      const c = getComputedStyle(el);
      return {
        boxOrient: c.getPropertyValue('-webkit-box-orient'),
        lineClamp: c.getPropertyValue('-webkit-line-clamp'),
        overflow: c.overflow,
        height: c.height
      };
    });
    expect(l.boxOrient).toBe('vertical'); // line-clamp-2
    expect(l.lineClamp).toBe('2'); // line-clamp-2
    expect(l.overflow).toBe('hidden'); // line-clamp-2
    expect(l.height).toBe('33.5938px'); // h-[2.1rem] @ rem=15px
  });
});

// Interaction coverage lives in cycRangeSelectorInteraction.test.ts; Chromium only sees the static cascade.
