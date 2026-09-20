import {afterAll, describe, expect, test} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser} from 'playwright';
import {busyDotsGlyph} from '../components/domHelpers';

// Proves the busy dots actually animate in a real browser, not just that the
// markup carries a class name. Playwright screenshots disable animations, so
// a snapshot alone cannot show motion; this reads Chromium's computed style
// instead, which is the exact regression that broke the previous Tailwind
// arbitrary-utility implementation (class present, animation never applied).

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(HERE, '..', 'features', 'chat', 'chat.css'), 'utf8');

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

describe('the busy dots carry a real, applied animation in a running browser', () => {
  test('each dot has a non-none computed animation-name and a distinct stagger', async () => {
    const glyph = busyDotsGlyph();
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head>` +
      `<body>${glyph.outerHTML}</body></html>`;

    const page = await (await getBrowser()).newPage();
    try {
      await page.setContent(html, {waitUntil: 'load'});
      const computed = await page.evaluate(() => {
        const dots = [...document.querySelectorAll('.cyc-busy-dot')] as HTMLElement[];
        return dots.map((d) => {
          const cs = getComputedStyle(d);
          return {
            animationName: cs.animationName,
            animationDuration: cs.animationDuration,
            animationIterationCount: cs.animationIterationCount,
            animationDelay: cs.animationDelay
          };
        });
      });

      expect(computed).toHaveLength(3);
      for (const dot of computed) {
        expect(dot.animationName).toBe('cyc-busy-dot-flash');
        expect(dot.animationName).not.toBe('none');
        expect(dot.animationIterationCount).toBe('infinite');
        expect(dot.animationDuration).not.toBe('0s');
      }
      const delays = computed.map((d) => d.animationDelay);
      expect(new Set(delays).size).toBe(3);
    } finally {
      await page.close();
    }
  });

  test('the dots STILL animate under an emulated prefers-reduced-motion: reduce', async () => {
    // The exact regression that slipped through: the reduced-motion media block
    // used to zero the animation (animation: none), which froze the dots on the
    // owner's phone (iOS Reduce Motion on) while headless Chromium -- with the
    // setting off -- kept passing. Emulate the setting and prove the animation
    // is still applied.
    const glyph = busyDotsGlyph();
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head>` +
      `<body>${glyph.outerHTML}</body></html>`;

    const page = await (await getBrowser()).newPage();
    try {
      await page.emulateMedia({reducedMotion: 'reduce'});
      await page.setContent(html, {waitUntil: 'load'});
      const reduced = await page.evaluate(
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
      expect(reduced).toBe(true);
      const computed = await page.evaluate(() => {
        const dots = [...document.querySelectorAll('.cyc-busy-dot')] as HTMLElement[];
        return dots.map((d) => {
          const cs = getComputedStyle(d);
          return {
            animationName: cs.animationName,
            animationDuration: cs.animationDuration,
            animationIterationCount: cs.animationIterationCount
          };
        });
      });
      expect(computed).toHaveLength(3);
      for (const dot of computed) {
        expect(dot.animationName).toBe('cyc-busy-dot-flash');
        expect(dot.animationName).not.toBe('none');
        expect(dot.animationIterationCount).toBe('infinite');
        expect(dot.animationDuration).not.toBe('0s');
      }
    } finally {
      await page.close();
    }
  });

  test('the dots glyph keeps a visible gap before the trailing suffix', async () => {
    // Guards the second owner-reported bug: the dots jammed against the time
    // ("<dots><1m"). A margin-inline-end on the glyph itself gives the gap for
    // every caller (list row and toolbar header).
    const glyph = busyDotsGlyph();
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head>` +
      `<body>${glyph.outerHTML}</body></html>`;
    const page = await (await getBrowser()).newPage();
    try {
      await page.setContent(html, {waitUntil: 'load'});
      const marginEnd = await page.evaluate(() => {
        const el = document.querySelector('.cyc-busy-dots') as HTMLElement;
        return parseFloat(getComputedStyle(el).marginInlineEnd || '0');
      });
      expect(marginEnd).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  test('the cyc-busy-dot-flash keyframes rule is defined in the loaded stylesheet', async () => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style id="s">${CSS}</style></head><body></body></html>`;
    const page = await (await getBrowser()).newPage();
    try {
      await page.setContent(html, {waitUntil: 'load'});
      const hasKeyframes = await page.evaluate(() => {
        const sheet = (document.getElementById('s') as HTMLStyleElement).sheet!;
        return Array.from(sheet.cssRules).some(
          (r) => r instanceof CSSKeyframesRule && r.name === 'cyc-busy-dot-flash'
        );
      });
      expect(hasKeyframes).toBe(true);
    } finally {
      await page.close();
    }
  });
});
