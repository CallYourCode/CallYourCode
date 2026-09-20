import {afterAll, beforeEach, describe, expect, test} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser} from 'playwright';
import {applyCycTheme} from '../features/settings/preferences';
import {setPresentationTheme} from '../components/presentation';

// Verifies theme-specific scrollbar values in Chromium.

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');

const LITERALS = {
  day: {
    '--cyc-overflow': 'rgba(100, 100, 100, 0.4)',
    '--cyc-overflow-hover': 'rgba(100, 100, 100, 0.7)',
    '--cyc-overflow-active': 'rgba(0, 0, 0, 0.6)'
  },
  night: {
    '--cyc-overflow': 'rgba(121, 121, 121, 0.4)',
    '--cyc-overflow-hover': 'rgba(100, 100, 100, 0.7)',
    '--cyc-overflow-active': 'rgba(191, 191, 191, 0.4)'
  }
} as const;

// Capture the exact inline `style=""` applyCycTheme writes on <html> for a theme.
function emittedStyle(theme: 'day' | 'night'): string {
  document.documentElement.removeAttribute('style');
  applyCycTheme(theme);
  return document.documentElement.getAttribute('style') ?? '';
}

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

async function measure(theme: 'day' | 'night') {
  const style = emittedStyle(theme).replace(/"/g, '&quot;');
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html style="${style}"><head><meta charset="utf-8"><style>${shell}</style></head>` +
    `<body><div id="cyc-app"><div id="n"></div></div></body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#n')!);
      return {
        scroll: cs.getPropertyValue('--cyc-overflow').trim(),
        hover: cs.getPropertyValue('--cyc-overflow-hover').trim(),
        active: cs.getPropertyValue('--cyc-overflow-active').trim(),
        scrollbarColor: cs.getPropertyValue('scrollbar-color').trim()
      };
    });
  } finally {
    await page.close();
  }
}

beforeEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  setPresentationTheme('day');
});
afterAll(async () => {
  await browser?.close();
});

describe('scrollbar theme vars are TS-owned', () => {
  for (const theme of ['day', 'night'] as const) {
    test(`${theme}: applyCycTheme writes the exact --cyc-overflow* literals inline`, () => {
      applyCycTheme(theme);
      const s = document.documentElement.style;
      expect(s.getPropertyValue('--cyc-overflow')).toBe(LITERALS[theme]['--cyc-overflow']);
      expect(s.getPropertyValue('--cyc-overflow-hover')).toBe(LITERALS[theme]['--cyc-overflow-hover']);
      expect(s.getPropertyValue('--cyc-overflow-active')).toBe(
        LITERALS[theme]['--cyc-overflow-active']
      );
    });
  }

  for (const theme of ['day', 'night'] as const) {
    test(`${theme}: a #cyc-app descendant inherits the vars and the retained skin consumes them`, async () => {
      const m = await measure(theme);
      expect(m.scroll).toBe(LITERALS[theme]['--cyc-overflow']);
      expect(m.hover).toBe(LITERALS[theme]['--cyc-overflow-hover']);
      expect(m.active).toBe(LITERALS[theme]['--cyc-overflow-active']);
      expect(m.scrollbarColor).toContain(LITERALS[theme]['--cyc-overflow']);
    });
  }
});
