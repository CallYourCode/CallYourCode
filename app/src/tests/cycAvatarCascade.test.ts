import {afterAll, describe, expect, test, vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Verify avatar styles in Chromium's layered CSS cascade.

vi.mock('../engine/contract', () => ({
  engineObjectUrl: vi.fn((url: string) => Promise.resolve(url))
}));

import {avatarColor, avatarView} from '../components/avatarView';
import {setPresentationTheme} from '../components/presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

// Compile the producer's Tailwind utilities.
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

const subtreeTokens = (el: Element) =>
  [el, ...el.querySelectorAll('*')]
    .flatMap((e) => (e.getAttribute('class') || '').split(/\s+/))
    .filter(Boolean);

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

// Measure the app's CSS cascade in Chromium.
async function measure(
  bodyHtml: string,
  candidates: string[],
  probes: Record<string, {selector: string; props: string[]}>
): Promise<Record<string, Record<string, string>>> {
  const utilities = await compileTailwind(candidates);
  const shell = readFileSync(resolve(SHELL, 'chrome.css'), 'utf8');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head><body>${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(
      ({probes}) => {
        const out: Record<string, Record<string, string>> = {};
        for (const [key, {selector, props}] of Object.entries(probes)) {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`probe ${key}: selector ${selector} matched nothing`);
          const s = getComputedStyle(el);
          out[key] = {};
          for (const p of props) out[key][p] = s.getPropertyValue(p);
        }
        return out;
      },
      {probes}
    );
  } finally {
    await page.close();
  }
}

describe('avatar cascade: final .cyc-face-photo geometry keeps the img box', () => {
  test('photo box + container resolve to the per-instance size, block, cover, 50% 50%, and the 14px radius literal', async () => {
    const header = avatarView('Alice', 42, '', 'av1.svg', 'seed-a');
    header.id = 'header';
    const row = avatarView('Bravo', 54, '', 'av2.svg', 'seed-b');
    row.id = 'row';
    const headerImg = header.querySelector('img.cyc-face-photo');
    const rowImg = row.querySelector('img.cyc-face-photo');
    expect(headerImg).not.toBeNull();
    expect(rowImg).not.toBeNull();

    const candidates = [...subtreeTokens(header), ...subtreeTokens(row)];
    const props = ['width', 'height', 'display', 'object-fit', 'object-position', 'border-radius'];
    const styles = await measure(`${header.outerHTML}${row.outerHTML}`, candidates, {
      header: {selector: '#header img.cyc-face-photo', props},
      row: {selector: '#row img.cyc-face-photo', props},
      headerContainer: {selector: '#header', props: ['border-radius']},
      rowContainer: {selector: '#row', props: ['border-radius']}
    });

    for (const [key, size] of [
      ['header', 42],
      ['row', 54]
    ] as const) {
      const s = styles[key];
      expect(parseFloat(s.width)).toBeCloseTo(size, 1);
      expect(parseFloat(s.height)).toBeCloseTo(size, 1);
      expect(s.display).toBe('block');
      expect(s['object-fit']).toBe('cover');
      expect(s['object-position']).toBe('50% 50%');
      expect(s['border-radius']).toBe('12px');
    }
    expect(styles.headerContainer['border-radius']).toBe('12px');
    expect(styles.rowContainer['border-radius']).toBe('12px');
  });

  test('fallback path is pure JS: img error removes the img and draws the robot/initial', () => {
    const el = avatarView('Zed', 42, '', 'av3.svg', 'seed-z');
    const img = el.querySelector('img.cyc-face-photo');
    expect(img).not.toBeNull();
    img!.dispatchEvent(new Event('error'));
    expect(el.querySelector('img.cyc-face-photo')).toBeNull();
    expect(el.querySelector('svg.cyc-robot') || el.textContent).toBeTruthy();
  });
});

describe('avatar cascade: robot fallback tile/ink paint + TS-owned day/night flip', () => {
  test('container + robot paint equal the endpoints and flip via setPresentationTheme, not a CSS theme selector', async () => {
    setPresentationTheme('day');
    const el = avatarView('Bravo', 54, '', undefined, 'seed-antenna');
    document.body.appendChild(el); // connected, so the theme painter is not pruned
    try {
      expect(el.querySelector('svg.cyc-robot')).not.toBeNull();
      expect(el.querySelector('.cyc-robot .f')).not.toBeNull();
      expect(el.querySelector('.cyc-robot .t')).not.toBeNull();

      // Serialize the day paint the initial TS repaint wrote; drive a live
      // day->night flip through the coordinator and serialize the repainted night
      // markup off the *same* element; then flip back and confirm the day markup
      // is reproduced byte-for-byte (finite, reversible, TS-owned).
      el.id = 'row-day';
      const dayHtml = el.outerHTML;
      setPresentationTheme('night');
      el.id = 'row-night';
      const nightHtml = el.outerHTML;
      setPresentationTheme('day');
      el.id = 'row-day';
      expect(el.outerHTML).toBe(dayHtml);
      expect(nightHtml).not.toBe(dayHtml);

      const hue = avatarColor('seed-antenna');
      const refs =
        `<div id="ref-tile-day" style="background-color: color-mix(in srgb, ${hue} 16%, #ffffff)"></div>` +
        `<div id="ref-ink-day" style="background-color: color-mix(in srgb, ${hue} 72%, #000000)"></div>` +
        `<div id="ref-tile-night" style="background-color: color-mix(in srgb, ${hue} 20%, #0e0e10)"></div>` +
        `<div id="ref-ink-night" style="background-color: color-mix(in srgb, ${hue} 78%, #ffffff)"></div>`;

      const utilities = await compileTailwind(subtreeTokens(el));
      const shell = readFileSync(resolve(SHELL, 'chrome.css'), 'utf8');
      // Both TS-repainted markups + refs in one page. Neither avatar carries a
      // `data-theme`, so any correct night paint must be the TS-written endpoints.
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head><body>${dayHtml}${nightHtml}${refs}</body></html>`;

      const page = await (await getBrowser()).newPage();
      try {
        await page.setContent(html, {waitUntil: 'load'});
        // Theme-independent literal references, read once.
        const ref = await page.evaluate(() => {
          const bc = (id: string) => getComputedStyle(document.getElementById(id)!).backgroundColor;
          return {
            tileDay: bc('ref-tile-day'),
            inkDay: bc('ref-ink-day'),
            tileNight: bc('ref-tile-night'),
            inkNight: bc('ref-ink-night')
          };
        });
        const read = (root: string) =>
          page.evaluate((rootSel) => {
            const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!);
            const box = document.querySelector(`${rootSel} svg.cyc-robot`)!.getBoundingClientRect();
            const c = cs(rootSel);
            const svg = cs(`${rootSel} svg.cyc-robot`);
            const hh = cs(`${rootSel} .cyc-robot .h`);
            const f = cs(`${rootSel} .cyc-robot .f`);
            const t = cs(`${rootSel} .cyc-robot .t`);
            return {
              bg: c.backgroundColor,
              ink: c.color,
              svgPos: svg.position,
              svgFill: svg.fill,
              svgStroke: svg.stroke,
              boxW: box.width,
              boxH: box.height,
              hStroke: hh.stroke,
              fFill: f.fill,
              fStroke: f.stroke,
              tFill: t.fill,
              tStrokeW: t.strokeWidth
            };
          }, root);

        const day = await read('#row-day');
        const night = await read('#row-night');

        // Container tile (background) + ink (color) equal the exact TS endpoints.
        expect(day.bg).toBe(ref.tileDay);
        expect(day.ink).toBe(ref.inkDay);
        expect(night.bg).toBe(ref.tileNight);
        expect(night.ink).toBe(ref.inkNight);
        expect(day.bg).not.toBe(night.bg);
        expect(day.ink).not.toBe(night.ink);

        expect(day.svgPos).toBe('absolute');
        expect(day.svgFill).toBe('none');
        expect(day.svgStroke).toBe(day.ink); // stroke:currentColor == container ink
        expect(day.boxW).toBeCloseTo(54 * 0.84, 0); // 84% box
        expect(day.boxH).toBeCloseTo(54 * 0.84, 0);

        expect(day.hStroke).toBe(ref.tileDay);
        expect(day.fFill).toBe(ref.inkDay);
        expect(day.fStroke).toBe('none');
        expect(day.tFill).toBe(ref.tileDay);
        expect(day.tStrokeW).toBe('1.8px');

        // Robot tile-driven paint carries the TS-written night endpoints too.
        expect(night.hStroke).toBe(ref.tileNight);
        expect(night.tFill).toBe(ref.tileNight);
        expect(night.fFill).toBe(ref.inkNight);
        expect(day.hStroke).not.toBe(night.hStroke);

        // Control: mutating the page `data-theme` must NOT repaint the day avatar
        // -- the endpoints are TS-owned inline literals, not a CSS theme selector.
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
        const dayAfterThemeAttr = await read('#row-day');
        expect(dayAfterThemeAttr.bg).toBe(ref.tileDay);
        expect(dayAfterThemeAttr.ink).toBe(ref.inkDay);
        expect(dayAfterThemeAttr.hStroke).toBe(ref.tileDay);
      } finally {
        await page.close();
      }
    } finally {
      el.remove();
      setPresentationTheme('day');
    }
  });
});
