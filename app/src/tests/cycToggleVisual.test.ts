import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Chromium-measured toggle rendering under the full shell cascade (Tailwind
// utilities + un-layered shell CSS). Pins the three visual regressions found
// on the owner's "toggle looks weird" report:
// 1. the shared-chrome 6px !important radius squared the track under the
//    circular knob (the track must stay a pill),
// 2. the knob transitioned `transform` while Tailwind v4 moves it with the
//    `translate` property, so the slide snapped with no animation,
// 3. the pending half-way knob sat frozen; it now breathes (cyc-toggle-wait)
//    so the wait reads as deliberate.

import {toggle} from '../components/widgets';
import {setPresentationTheme} from '../components/presentation';

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

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

type Box = {x: number; y: number; w: number; h: number};
type Shot = {
  track: Box;
  knob: Box;
  trackRadius: string;
  knobRadius: string;
  knobTransition: string;
  knobAnimation: string;
  trackBg: string;
  labelOpacity: string;
  chromeControlRadius: string;
};

function classTokens(el: HTMLElement): string[] {
  const out = new Set<string>();
  for (const node of [el, ...el.querySelectorAll<HTMLElement>('*')]) {
    for (const c of node.className.split(/\s+/)) if (c) out.add(c);
  }
  return [...out];
}

async function renderShot(el: HTMLElement, theme: 'day' | 'night'): Promise<Shot> {
  const utilities = await compileTailwind(classTokens(el));
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/plugins/plugins.css'), 'utf8');
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  // The .cyc-icon-btn control proves the un-layered 6px chrome sheet really is
  // in the fixture; the pill assertions are non-vacuous only alongside it.
  const html =
    `<!DOCTYPE html><html${themeAttr}><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
    `<body><div style="position:relative;width:400px;height:200px;padding:40px">` +
    el.outerHTML +
    `<button class="cyc-icon-btn" id="chrome-control"></button>` +
    `</div></body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const label = document.querySelector<HTMLElement>('.cyc-tick-toggle')!;
      const track = document.querySelector<HTMLElement>('.cyc-toggle-track')!;
      const knob = document.querySelector<HTMLElement>('.cyc-toggle-knob')!;
      const control = document.querySelector<HTMLElement>('#chrome-control')!;
      const b = (e: HTMLElement) => {
        const r = e.getBoundingClientRect();
        return {x: r.x, y: r.y, w: r.width, h: r.height};
      };
      const ct = getComputedStyle(track);
      const ck = getComputedStyle(knob);
      return {
        track: b(track),
        knob: b(knob),
        trackRadius: ct.borderRadius,
        knobRadius: ck.borderRadius,
        knobTransition: ck.transitionProperty,
        knobAnimation: ck.animationName,
        trackBg: ct.backgroundColor,
        labelOpacity: getComputedStyle(label).opacity,
        chromeControlRadius: getComputedStyle(control).borderRadius
      };
    });
  } finally {
    await page.close();
  }
}

type StateName = 'off' | 'on' | 'pending' | 'disabled';
function makeState(state: StateName): HTMLElement {
  if (state === 'off') return toggle({checked: false}).el;
  if (state === 'on') return toggle({checked: true}).el;
  if (state === 'disabled') return toggle({checked: false, disabled: true}).el;
  const t = toggle({checked: false});
  t.setPending(true);
  return t.el;
}

const THEMES = ['day', 'night'] as const;
const STATES: StateName[] = ['off', 'on', 'pending', 'disabled'];

describe('toggle rendering measured in Chromium under the full cascade', () => {
  test.each(THEMES.flatMap((th) => STATES.map((st) => [th, st] as const)))(
    '%s/%s: pill track, aligned circular knob, animated slide',
    async (theme, state) => {
      setPresentationTheme(theme);
      const shot = await renderShot(makeState(state), theme);
      setPresentationTheme('day');

      // The un-layered chrome sheet is live in this fixture (guards vacuity).
      expect(shot.chromeControlRadius).toBe('6px');

      // Track: 36x16 pill, never the squared 6px shared-chrome radius.
      expect(shot.track.w).toBe(36);
      expect(shot.track.h).toBe(16);
      expect(shot.trackRadius).not.toBe('6px');
      expect(parseFloat(shot.trackRadius)).toBeGreaterThanOrEqual(8);

      // Knob: 20px circle, vertically centered on the track (2px overhang).
      expect(shot.knob.w).toBe(20);
      expect(shot.knob.h).toBe(20);
      expect(shot.knobRadius).toBe('50%');
      expect(shot.knob.y).toBeCloseTo(shot.track.y - 2, 1);

      // Horizontal position per state: flush start, flush end, dead center.
      if (state === 'on') {
        expect(shot.knob.x + shot.knob.w).toBeCloseTo(shot.track.x + shot.track.w, 1);
      } else if (state === 'pending') {
        expect(shot.knob.x + shot.knob.w / 2).toBeCloseTo(shot.track.x + shot.track.w / 2, 1);
      } else {
        expect(shot.knob.x).toBeCloseTo(shot.track.x, 1);
      }

      // The slide animates: Tailwind v4 moves the knob with `translate`, so
      // the transition must cover `translate` (transitioning `transform` was
      // the dead spec that made the knob snap).
      expect(shot.knobTransition).toContain('translate');
      expect(shot.knobTransition).not.toContain('transform');

      // Pending breathes (cyc-toggle-wait); settled states do not animate.
      if (state === 'pending') {
        expect(shot.knobAnimation).toBe('cyc-toggle-wait');
        expect(shot.labelOpacity).toBe('0.6');
      } else {
        expect(shot.knobAnimation).toBe('none');
        expect(shot.labelOpacity).toBe(state === 'disabled' ? '0.3' : '1');
      }
    },
    120000
  );

  test('day and night keep their own track colours under the cascade', async () => {
    setPresentationTheme('day');
    const day = await renderShot(makeState('on'), 'day');
    setPresentationTheme('night');
    const night = await renderShot(makeState('on'), 'night');
    setPresentationTheme('day');
    expect(day.trackBg).toBe('rgb(150, 96, 47)'); // #96602f copper day
    expect(night.trackBg).toBe('rgb(201, 134, 82)'); // #c98652 copper night
  }, 120000);
});
