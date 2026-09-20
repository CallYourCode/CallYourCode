import {afterAll, describe, expect, test} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser} from 'playwright';

// Read keyframes through Chromium's CSS parser.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const SHEETS = [
  resolve(SRC, 'shell', 'chrome.css'),
  resolve(SRC, 'features', 'chat', 'chat.css'),
  resolve(SRC, 'features', 'composer', 'composer.css'),
  resolve(SRC, 'features', 'sessions', 'sessions.css')
];
const CSS = SHEETS.map((p) => readFileSync(p, 'utf8')).join('\n');

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

type Frames = Record<string, Record<string, string>>;

let cache: Record<string, Frames> | null = null;
async function keyframes(): Promise<Record<string, Frames>> {
  if (cache) return cache;
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style id="s">${CSS}</style></head>` +
    `<body></body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    cache = await page.evaluate(() => {
      const sheet = (document.getElementById('s') as HTMLStyleElement).sheet!;
      const out: Record<string, Record<string, Record<string, string>>> = {};
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSKeyframesRule)) continue;
        const frames: Record<string, Record<string, string>> = {};
        for (const kf of Array.from(rule.cssRules) as CSSKeyframeRule[]) {
          const decls: Record<string, string> = {};
          for (const prop of Array.from(kf.style)) decls[prop] = kf.style.getPropertyValue(prop);
          frames[kf.keyText] = decls;
        }
        out[rule.name] = frames;
      }
      return out as never;
    });
    return cache;
  } finally {
    await page.close();
  }
}

const NEW_NAMES = [
  'cyc-msg-flash',
  'cyc-dot-wave',
  'cyc-busy-dot-flash',
  'cyc-rec-dot-ring',
  'cyc-drop-ring',
  'cyc-search-label-reveal'
];

describe('CYC keyframes keep their start/end contract', () => {
  test('all cyc- keyframe names are defined and parsed', async () => {
    const kf = await keyframes();
    for (const name of NEW_NAMES) expect(Object.keys(kf), `${name} defined`).toContain(name);
  });

  test('the recorder dot pulses a danger ring via transform + box-shadow, never opacity', async () => {
    const kf = await keyframes();
    const ring = kf['cyc-rec-dot-ring'];
    expect(ring['0%'].transform).toBe('scale(0.86)');
    expect(ring['0%']['box-shadow']).toContain('color-mix');
    expect(ring['70%']['box-shadow']).toContain('7px');
    for (const stop of Object.keys(ring))
      expect(ring[stop].opacity, `${stop} opacity`).toBeUndefined();
  });

  test('the drop-target dragover pulse blooms an accent ring on the box-shadow spread', async () => {
    const kf = await keyframes();
    const ring = kf['cyc-drop-ring'];
    // Drop pulse uses box-shadow.
    expect(ring['0%']['box-shadow']).toBeDefined();
    expect(ring['70%']['box-shadow']).toContain('12px');
    for (const stop of Object.keys(ring))
      expect(ring[stop]['stroke-dashoffset'], `${stop} dashoffset`).toBeUndefined();
  });

  test('the search label wipes in from its leading edge via clip-path, resting fully revealed', async () => {
    const kf = await keyframes();
    const reveal = kf['cyc-search-label-reveal'];
    expect(reveal['0%']['clip-path']).toContain('100%');
    expect(reveal['0%'].transform).toBe('translateX(-6px)');
    expect(reveal['100%']['clip-path']).not.toContain('100%');
    expect(reveal['100%'].transform).toBe('translateX(0px)');
  });

  test('the working glyph keyframe is gone; status labels are text only', async () => {
    const kf = await keyframes();
    expect(Object.keys(kf)).not.toContain('cyc-activity-cycle');
  });

  test('the message flash and dot wave start and end transparent / crest opaque', async () => {
    const kf = await keyframes();
    const flash = kf['cyc-msg-flash'];
    expect((flash['0%, 100%'] ?? flash['0%']).opacity).toBe('0');
    const wave = kf['cyc-dot-wave'];
    expect((wave['0%, 66%, 100%'] ?? wave['0%']).opacity).toBe('0');
    expect(wave['33%'].opacity).toBe('1');
  });

  test('the busy dot-flashing keyframe dims at rest and flashes fully opaque at the crest', async () => {
    const kf = await keyframes();
    const flash = kf['cyc-busy-dot-flash'];
    expect((flash['0%, 100%'] ?? flash['0%']).opacity).toBe('0.25');
    expect(flash['50%'].opacity).toBe('1');
  });

  test('the reduced-motion block does NOT zero the busy-dot animation', async () => {
    // Regression guard: the busy dots must keep animating even when the OS asks
    // for reduced motion, so no @media (prefers-reduced-motion: reduce) rule may
    // set `animation: none` on `.cyc-busy-dot`.
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style id="s">${CSS}</style></head>` +
      `<body></body></html>`;
    const page = await (await getBrowser()).newPage();
    try {
      await page.setContent(html, {waitUntil: 'load'});
      const zeroed = await page.evaluate(() => {
        const sheet = (document.getElementById('s') as HTMLStyleElement).sheet!;
        for (const rule of Array.from(sheet.cssRules)) {
          if (!(rule instanceof CSSMediaRule)) continue;
          if (!rule.conditionText.includes('prefers-reduced-motion')) continue;
          for (const inner of Array.from(rule.cssRules)) {
            if (!(inner instanceof CSSStyleRule)) continue;
            if (!inner.selectorText.includes('.cyc-busy-dot')) continue;
            const name = inner.style.animationName || inner.style.animation;
            if (name === 'none' || name.trim() === 'none') return true;
          }
        }
        return false;
      });
      expect(zeroed).toBe(false);
    } finally {
      await page.close();
    }
  });
});
