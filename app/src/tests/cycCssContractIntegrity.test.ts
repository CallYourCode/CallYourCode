import {afterAll, describe, expect, test} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser} from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const TESTS = join('src', 'tests');
const TOKENS_CSS = readFileSync(resolve(SRC, 'shell', 'chrome.css'), 'utf8');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|css)$/.test(entry.name) && !full.includes(TESTS)) out.push(full);
  }
  return out;
}

const NON_TEST = sourceFiles(SRC)
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

const producedBare = (cls: string): boolean =>
  new RegExp(`(?<![.\\w-])${cls}(?![\\w-])`).test(NON_TEST);
const consumedAsSelector = (cls: string): boolean =>
  new RegExp(`\\.${cls}(?![\\w-])`).test(NON_TEST);

describe('CYC message-state / content classes are both produced and consumed', () => {
  const STYLED = ['cyc-msg-received', 'cyc-msg-sent', 'cyc-msg-system', 'cyc-inline-code'] as const;

  for (const cls of STYLED) {
    test(`${cls} has a live producer and a live consumer`, () => {
      expect(producedBare(cls), `${cls} is emitted by a producer`).toBe(true);
      expect(consumedAsSelector(cls), `${cls} is read by a selector/variant`).toBe(true);
    });
  }

  test('cyc-list-row-time is emitted as a row marker span', () => {
    expect(producedBare('cyc-list-row-time')).toBe(true);
  });
});

describe('every CYC theme token keeps a writer and a var() reader', () => {
  const TOKENS = [
    'cyc-accent',
    'cyc-text',
    'cyc-text-muted',
    'cyc-surface',
    'cyc-danger',
    'cyc-border-color',
    'cyc-background-color',
    'cyc-link-color',
    'cyc-ok',
    'cyc-overflowbar-color',
    'cyc-bubble-ink',
    'cyc-bubble-in-surface',
    'cyc-bubble-status',
    'cyc-bubble-error',
    'cyc-bubble-glyph',
    'cyc-bubble-time'
  ] as const;

  const hasReader = (t: string): boolean => new RegExp(`var\\(--${t}\\b`).test(NON_TEST);
  const hasWriter = (t: string): boolean =>
    new RegExp(`--${t}\\s*:|['"\`]--${t}['"\`]|['"\`]${t}['"\`]`).test(NON_TEST);

  for (const t of TOKENS) {
    test(`--${t} has both a writer and a reader`, () => {
      expect(hasWriter(t), `--${t} is written`).toBe(true);
      expect(hasReader(t), `--${t} is read via var()`).toBe(true);
    });
  }
});

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

const ACCENT_DAY = 'rgb(150, 96, 47)';
const ACCENT_NIGHT = 'rgb(201, 134, 82)';
async function linkColor(theme: 'day' | 'night', accent: string): Promise<string> {
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  const seed = `${theme === 'night' ? "html[data-theme='dark']" : ':root'}{--cyc-accent:${accent}}`;
  const html =
    `<!DOCTYPE html><html${themeAttr}><head><meta charset="utf-8">` +
    `<style>${TOKENS_CSS}\n${seed}</style></head>` +
    `<body><a id="probe" href="#">x</a></body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => getComputedStyle(document.getElementById('probe')!).color);
  } finally {
    await page.close();
  }
}

describe('the derived link ink computes from the accent palette entry', () => {
  test('chrome.css authors --cyc-link-color from --cyc-accent (no duplicate palette value)', () => {
    expect(/--cyc-link-color\s*:\s*var\(--cyc-accent\)/.test(TOKENS_CSS)).toBe(true);
  });
  test('a link resolves to the day accent', async () => {
    expect(await linkColor('day', ACCENT_DAY)).toBe(ACCENT_DAY);
  });
  test('a link resolves to the night accent', async () => {
    expect(await linkColor('night', ACCENT_NIGHT)).toBe(ACCENT_NIGHT);
  });
});
