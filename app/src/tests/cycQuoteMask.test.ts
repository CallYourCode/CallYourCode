// Quote-mark mask rendering and compiled utility coverage.

import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {QUOTE_MARK_CLASS, applyQuoteDecor} from '../features/chat/quoteDecor';
import {setFormatted} from '../features/chat/content';
import {replyPanel} from '../features/chat/messages/messageContent';
import type {CycReplyTo} from '../types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const SHELL = resolve(SRC, 'shell');
const CHAT = resolve(SRC, 'features', 'chat');
const CODE = resolve(SRC, 'features', 'code');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

const MARK_CANDIDATES = QUOTE_MARK_CLASS.split(/\s+/).filter(Boolean);

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

describe('quote-mark mask compiles as a finite literal utility (build-output guard)', () => {
  const source = readFileSync(resolve(CHAT, 'quoteDecor.ts'), 'utf8');

  test('the mask is a literal scannable candidate, never a runtime interpolation', () => {
    expect(source).toContain('[mask:url(data:image/svg+xml,');
    expect(source).toContain('[-webkit-mask:url(data:image/svg+xml,');
    expect(source).not.toMatch(/\[-?[a-z-]*mask:\$\{/);
    expect(QUOTE_MARK_CLASS).not.toContain('${');
    for (const cand of MARK_CANDIDATES) expect(cand).not.toMatch(/["'\s]/);
  });

  test('Tailwind emits a real mask rule carrying the finite SVG glyph', async () => {
    const css = await compileTailwind(MARK_CANDIDATES);
    expect(css).toContain('2.667');
    expect(css).toMatch(/-webkit-mask:\s*url\(data:image\/svg\+xml/);
    expect(css).toMatch(/[^-]mask:\s*url\(data:image\/svg\+xml/);
    expect(css).toContain('contain');
  });
});

const allClasses = (el: HTMLElement): string[] => {
  const out = new Set<string>();
  const walk = (n: Element) => {
    for (const c of n.classList) out.add(c);
    for (const child of n.children) walk(child);
  };
  walk(el);
  return [...out];
};

type MarkProbe = {
  hasMask: boolean;
  maskImage: string;
  webkitMaskImage: string;
  background: string;
  corners: number[];
  fraction: number;
  maxAlpha: number;
};

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

async function probeMark(bodyHtml: string, extraClasses: string[], rootVars: string) {
  const utilities = await compileTailwind([...MARK_CANDIDATES, ...extraClasses]);
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CHAT, 'chat.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CODE, 'codeViewer.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html style="${rootVars}"><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
    `<body style="margin:0;font-size:100px">${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return (await page.evaluate(async () => {
      const el = document.querySelector('.cyc-callout-mark') as HTMLElement | null;
      if (!el) throw new Error('no .cyc-callout-mark in the produced subtree');
      const s = getComputedStyle(el);
      const maskImage =
        s.getPropertyValue('-webkit-mask-image') || s.getPropertyValue('mask-image');
      const background = s.getPropertyValue('background-color');
      const m = maskImage.match(/url\((['"]?)(.*?)\1\)/);
      if (!m) {
        return {
          hasMask: false,
          maskImage,
          webkitMaskImage: s.getPropertyValue('-webkit-mask-image'),
          background,
          corners: [] as number[],
          fraction: 1,
          maxAlpha: 0
        };
      }
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = m[2];
      });
      const N = 100;
      const canvas = document.createElement('canvas');
      canvas.width = N;
      canvas.height = N;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, N, N);
      ctx.drawImage(img, 0, 0, N, N);
      const d = ctx.getImageData(0, 0, N, N).data;
      const A = (x: number, y: number) => d[(y * N + x) * 4 + 3];
      let opaque = 0;
      let maxAlpha = 0;
      for (let i = 3; i < d.length; i += 4) {
        const a = d[i];
        if (a > 20) opaque++;
        if (a > maxAlpha) maxAlpha = a;
      }
      return {
        hasMask: true,
        maskImage,
        webkitMaskImage: s.getPropertyValue('-webkit-mask-image'),
        background,
        corners: [A(1, 1), A(N - 2, 1), A(1, N - 2), A(N - 2, N - 2)],
        fraction: opaque / (N * N),
        maxAlpha
      };
    })) as MarkProbe;
  } finally {
    await page.close();
  }
}

const reply = (over: Partial<CycReplyTo> = {}): CycReplyTo => ({
  ts: 1700000000000,
  role: 'claude',
  title: 'Ada',
  text: 'the quoted line',
  quote: true,
  ...over
});

/** Each producer whose `.cyc-callout-marked` frame mounts the shared quote mark. */
function quotePaths(): {name: string; node: HTMLElement}[] {
  const md = document.createElement('div');
  setFormatted(md, '> a quoted markdown line');

  const replyNode = replyPanel(reply(), false);

  const composer = document.createElement('div');
  composer.className =
    'cyc-callout-surface cyc-callout-rail cyc-callout-marked py-1! ps-3! pe-6! text-[0.9375rem]! leading-[1.25]!';
  applyQuoteDecor(composer);

  return [
    {name: 'chat-markdown', node: md},
    {name: 'chat-reply', node: replyNode},
    {name: 'composer-block', node: composer}
  ];
}

const THEMES: {name: string; primary: string; vars: string}[] = [
  {
    name: 'day',
    primary: 'rgb(0, 120, 255)',
    vars:
      '--cyc-accent:rgb(0,120,255);--cyc-accent-rgb:0,120,255;' +
      '--cyc-sender-rgb:0,120,255;--cyc-text-muted:rgb(90,90,94);' +
      '--cyc-message-minor-size:13px'
  },
  {
    name: 'night',
    primary: 'rgb(120, 180, 255)',
    vars:
      '--cyc-accent:rgb(120,180,255);--cyc-accent-rgb:120,180,255;' +
      '--cyc-sender-rgb:120,180,255;--cyc-text-muted:rgb(180,180,184);' +
      '--cyc-message-minor-size:13px'
  }
];

describe('quote mark renders a masked glyph, not a solid square (real Chromium)', () => {
  for (const theme of THEMES) {
    for (const {name, node} of quotePaths()) {
      test(`${name} @ ${theme.name}: masked quotation-mark shape`, async () => {
        const probe = await probeMark(node.outerHTML, allClasses(node), theme.vars);

        expect(probe.hasMask, `mask-image was none -> solid square (${probe.maskImage})`).toBe(
          true
        );
        expect(probe.webkitMaskImage).toContain('data:image/svg+xml');
        expect(probe.background).toBe(theme.primary);
        for (const a of probe.corners) expect(a, 'a corner painted -> solid square').toBe(0);
        expect(probe.maxAlpha).toBeGreaterThan(200);
        expect(probe.fraction).toBeGreaterThan(0.02);
        expect(probe.fraction).toBeLessThan(0.6);
      });
    }
  }
});
