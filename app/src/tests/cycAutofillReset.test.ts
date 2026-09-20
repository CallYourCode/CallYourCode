import {afterAll, describe, expect, test} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser} from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const TOKENS = readFileSync(resolve(SHELL, 'chrome.css'), 'utf8');

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

describe('inputs keep the CYC product font through the retained input reset', () => {
  test('a plain input resolves font-family to the Inter stack', async () => {
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${TOKENS}</style></head>` +
      `<body><input id="f"></body></html>`;
    const page = await (await getBrowser()).newPage();
    try {
      await page.setContent(html, {waitUntil: 'load'});
      const family = await page.evaluate(
        () => getComputedStyle(document.getElementById('f')!).fontFamily
      );
      expect(family).toMatch(/^["']?Inter/);
    } finally {
      await page.close();
    }
  });
});
