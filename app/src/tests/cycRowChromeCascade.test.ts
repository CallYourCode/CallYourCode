import {afterAll, afterEach, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Generic row chrome cascade coverage.

import {row, toggle, paintRowChrome} from '../components/widgets';
import {chatRow} from '../features/chat/navigation/chatRow';
import {
  currentPresentation,
  installPresentationReactivity,
  presentationPainterCount,
  setPresentationTheme
} from '../components/presentation';
import type {CycSession} from '../types';

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

// Distinct day and night color sentinels.
const ENV = `
:root{ --cyc-text-muted: rgb(4,5,6); --cyc-accent: rgb(1,2,3); --cyc-danger: rgb(7,8,9); }
html[data-theme='dark']{ --cyc-text-muted: rgb(13,14,15); --cyc-accent: rgb(10,11,12); --cyc-danger: rgb(16,17,18); }
`;

const PROPS = [
  'padding-left',
  'padding-top',
  'padding-bottom',
  'min-height',
  'border-top-left-radius',
  'color',
  'font-size',
  'line-height',
  'margin-top',
  'margin-left',
  'position',
  'column-gap',
  'grid-template-columns'
] as const;
type Probe = Record<(typeof PROPS)[number], string>;

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

const tokenize = (s: string) => s.trim().split(/\s+/).filter(Boolean);

// Render producer classes in the browser cascade fixture.
async function measure(className: string, theme: 'day' | 'night'): Promise<Probe> {
  const utilities = await compileTailwind(tokenize(className));
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/sessions/sessions.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/chat/chat.css'), 'utf8') +
    '\n' +
    ENV;
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  const html =
    `<!DOCTYPE html><html${themeAttr}><head><meta charset="utf-8">` +
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

// Reset width-sensitive presentation state for each test.
const ORIGINAL_WIDTH = window.innerWidth;
const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});
let teardown: (() => void) | undefined;
const sync = () => {
  teardown?.();
  teardown = installPresentationReactivity();
};

beforeEach(() => {
  document.documentElement.dir = '';
  document.body.innerHTML = '';
  setWidth(1024);
  setPresentationTheme('day');
  sync();
});
afterEach(() => {
  teardown?.();
  teardown = undefined;
  setWidth(ORIGINAL_WIDTH);
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

const sess = (over: Partial<CycSession> = {}): CycSession =>
  ({
    id: 's1',
    name: 'Relay Server',
    messages: [],
    unread: 0,
    muted: false,
    cwd: '/srv/relay',
    lastActivity: 0,
    ...over
  }) as unknown as CycSession;

describe('paintRowChrome width painter: was sessions.css .cyc-list-row-inset / .cyc-list-row-press media', () => {
  test.each([
    [549, 'phone', 'ps-[4rem]!', false],
    [550, 'phone', 'ps-[4rem]!', false],
    [551, 'tablet', 'ps-[3.5rem]!', true],
    [900, 'laptop', 'ps-[3.5rem]!', true]
  ] as const)('width %i -> %s: inset %s, press-radius %s', (px, bucket, inset, radius) => {
    setWidth(px);
    sync();
    expect(currentPresentation().width).toBe(bucket);
    const r = row({icon: 'copy', title: 'Working directory', clickable: true});
    expect(r.className).toContain(inset);
    expect(r.className).not.toContain(inset === 'ps-[4rem]!' ? 'ps-[3.5rem]!' : 'ps-[4rem]!');
    expect(r.className.includes('rounded-[16px]')).toBe(radius);
  });

  test('a mounted row re-paints inset/radius across the 550/551 boundary', () => {
    setWidth(551);
    sync();
    const r = row({icon: 'copy', title: 'x', clickable: true});
    document.body.append(r);
    expect(r.className).toContain('ps-[3.5rem]!');
    expect(r.className).toContain('rounded-[16px]');
    setWidth(550);
    sync();
    expect(r.className).toContain('ps-[4rem]!');
    expect(r.className).not.toContain('ps-[3.5rem]!');
    expect(r.className).not.toContain('rounded-[16px]');
  });

  test('a plain (no inset, no press) row registers no painter; detached rows prune', () => {
    const before = presentationPainterCount();
    const plain = row({title: 'label'}); // no icon, not clickable
    document.body.append(plain);
    expect(presentationPainterCount()).toBe(before); // opt-in: nothing to paint
    const chrome = row({icon: 'copy', title: 'x', clickable: true});
    document.body.append(chrome);
    expect(presentationPainterCount()).toBe(before + 1);
    chrome.remove();
    setWidth(550);
    sync(); // repaint prunes the detached row
    expect(presentationPainterCount()).toBe(before);
  });

  test('paintRowChrome is opt-in and never touches chatRow', () => {
    const a = chatRow(sess());
    expect(a.className).not.toContain('ps-[3.5rem]!');
    expect(a.className).not.toContain('ps-[4rem]!');
    expect(a.className).not.toContain('rounded-[16px]');
    // 2026-09-02: the avatar column is the 48px avatar itself, and the 14px the
    // owner asked for between avatar and title/subtitle is an explicit gap-x
    // (before: a 3.5rem column with the avatar centred, 4px of slack, no gap).
    expect(a.className).toContain('grid-cols-[3rem_minmax(0,1fr)]');
    expect(a.className).toContain('gap-x-3.5');
    expect(a.className).not.toContain('3.5rem');
    expect(a.className).toContain('rounded-xl');
  });

  test('chatRow computed grid: 48px avatar track, 14px gap, text track ends at px-2 (16px root)', async () => {
    const a = chatRow(sess());
    const p = await measure(a.className, 'day');
    expect(p['column-gap']).toBe('14px'); // gap-x-3.5
    // 800px fixture, 8px padding each side, 48px avatar, 14px gap: 1fr = 722px,
    // so the right edge of the time/badge column is still at 800 - 8.
    expect(p['grid-template-columns']).toBe('48px 722px');
    expect(p['padding-left']).toBe('8px');
  });
});

describe('generic row computed cascade (real Chromium): 16px root', () => {
  test('inset row: 4rem start pad on phone, 3.5rem from 551 up (px @16px root)', async () => {
    setWidth(550);
    sync();
    const phone = row({icon: 'copy', title: 'x', clickable: true});
    setWidth(551);
    sync();
    const tablet = row({icon: 'copy', title: 'x', clickable: true});
    expect((await measure(phone.className, 'day'))['padding-left']).toBe('64px'); // 4rem
    const t = await measure(tablet.className, 'day');
    expect(t['padding-left']).toBe('56px'); // 3.5rem
    expect(t['border-top-left-radius']).toBe('16px'); // press corner
    expect((await measure(phone.className, 'day'))['border-top-left-radius']).toBe('0px');
  });

  test('title-only row: 3rem floor, zeroed block padding (no-wrap)', async () => {
    const r = row({title: 'x'}); // no subtitle, no icon
    const p = await measure(r.className, 'day');
    expect(p['min-height']).toBe('48px'); // 3rem, beats layered min-h-14
    expect(p['padding-top']).toBe('0px');
    expect(p['padding-bottom']).toBe('0px');
  });

  test('subtitle row: secondary colour, 13 font/18 line, 0.1875rem top gap; day/night flip', async () => {
    const r = row({title: 't', subtitle: 's'});
    const sub = r.querySelector('.cyc-list-row-subtitle') as HTMLElement;
    const day = await measure(sub.className, 'day');
    expect(day.color).toBe('rgb(4, 5, 6)'); // --cyc-text-muted
    expect(day['font-size']).toBe('13px'); // 0.8125rem
    expect(day['line-height']).toBe('18px');
    expect(day['margin-top']).toBe('3px'); // 0.1875rem
    expect((await measure(sub.className, 'night')).color).toBe('rgb(13, 14, 15)');
  });

  test('in-row toggle geometry: position static, 0.125rem inline margin, no padding', async () => {
    const t = toggle();
    const r = row({title: 'Autoplay', rightContent: t.el});
    const p = await measure(t.el.className, 'day');
    expect(p.position).toBe('static'); // was position:unset
    expect(p['margin-left']).toBe('2px'); // 0.125rem
    expect(p['padding-left']).toBe('0px');
    expect(p['padding-top']).toBe('0px');
    expect(r.querySelector('.cyc-tick-toggle')).toBe(t.el);
  });
});

describe('chatRow subtitle base colour is layered so chat state overrides win', () => {
  test('default = secondary; working = primary; asking = danger (chat.css !important)', async () => {
    const a = chatRow(sess());
    const sub = a.querySelector('.cyc-list-row-subtitle') as HTMLElement;
    expect((await measure(sub.className, 'day')).color).toBe('rgb(4, 5, 6)'); // base secondary
    const working = sub.className + ' cyc-list-row-working';
    expect((await measure(working, 'day')).color).toBe('rgb(1, 2, 3)'); // --cyc-accent
    const asking = sub.className + ' cyc-list-row-asking';
    expect((await measure(asking, 'day')).color).toBe('rgb(7, 8, 9)'); // --cyc-danger
  });

  test('chatRow .cyc-who title span carries the current ellipsis', () => {
    const a = chatRow(sess({name: 'A very long agent name that must clip'}));
    const name = a.querySelector('.cyc-list-row-title .cyc-who') as HTMLElement;
    expect(name.className).toContain('overflow-hidden');
    expect(name.className).toContain('text-ellipsis');
  });
});

describe('settings-style row (widgets row + srow icon/subtitle skin) keeps 0.4375rem block pad', () => {
  test('an important pt/pb from srow still wins over the container py-0!', async () => {
    const r = row({icon: 'lock', title: 'Pinned', subtitle: 'host'});
    r.classList.add('justify-start', 'pt-[0.4375rem]!', 'pb-[0.4375rem]!');
    const p = await measure(r.className, 'day');
    expect(p['padding-top']).toBe('7px'); // 0.4375rem, layered-important beats py-0!
    expect(p['padding-bottom']).toBe('7px');
  });
});

// Cover paintRowChrome independently of row() wiring.
test('paintRowChrome applies inset without press when the row is not pressable', () => {
  setWidth(551);
  sync();
  const el = document.createElement('div');
  el.className = 'cyc-list-row cyc-list-row-inset';
  paintRowChrome(el);
  expect(el.className).toContain('ps-[3.5rem]!');
  expect(el.className).not.toContain('rounded-[16px]');
});
