import {afterAll, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Real-Chromium cascade coverage for signal-meter samples.

import {signalStrip, fillSignalSamples} from '../features/composer/voice/waveform';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const MEDIA_CSS = resolve(HERE, '..', 'features', 'media', 'media.css');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

// Deterministic primary-color fixture.
const PRIMARY = 'rgb(3, 7, 11)';

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

// Build the production signal-meter hierarchy.
function signalMeter(): HTMLElement {
  const meter = document.createElement('div');
  meter.className = 'cyc-signal-meter relative flex items-center';
  meter.style.height = '50px';
  const track = signalStrip('cyc-signal-track h-full w-full');
  const progress = signalStrip(
    'cyc-signal-progress absolute inset-0 pointer-events-none [clip-path:inset(0_100%_0_0)]'
  );
  meter.append(track, progress);
  for (const div of [track, progress]) {
    const strip = div.querySelector<HTMLElement>('.cyc-signal-samples')!;
    fillSignalSamples(strip);
  }
  return meter;
}

function classTokens(root: Element): string[] {
  return [root, ...root.querySelectorAll('*')]
    .flatMap((e) => (e.getAttribute('class') || '').split(/\s+/))
    .filter(Boolean);
}

let styles: Record<string, Record<string, string>>;

beforeEach(() => {
  document.body.innerHTML = '';
});
afterAll(async () => {
  await browser?.close();
});

describe('signal samples: fixed count + normalized heights, no baked geometry', () => {
  test('every meter emits the same fixed sample count with heights inside the band', () => {
    const meter = signalMeter();
    const tracks = meter.querySelectorAll<HTMLElement>('.cyc-signal-samples');
    expect(tracks.length).toBe(2);
    for (const strip of tracks) {
      const samples = [...strip.querySelectorAll<HTMLElement>('.cyc-signal-sample')];
      expect(samples.length).toBe(56);
      for (const s of samples) {
        const pct = parseFloat(s.style.height);
        expect(s.style.height.endsWith('%')).toBe(true);
        expect(pct).toBeGreaterThanOrEqual(15);
        expect(pct).toBeLessThanOrEqual(90);
        expect(s.style.width).toBe('');
      }
    }
    expect(meter.outerHTML).not.toMatch(/cyc-wave-bar|cyc-wave-bg|cyc-wave-bars|cyc-wave-box/);
  });
});

describe('signal cascade: sample fill/opacity + track height resolve per context', () => {
  test('voice, nonvoice and played-overlay samples read their final values', async () => {
    const voice = document.createElement('cyc-voice-card');
    voice.className = 'cyc-clip cyc-voice';
    voice.id = 'voice';
    voice.append(signalMeter());

    const nonvoice = document.createElement('cyc-voice-card');
    nonvoice.className = 'cyc-clip';
    nonvoice.id = 'nonvoice';
    nonvoice.append(signalMeter());

    const candidates = [...classTokens(voice), ...classTokens(nonvoice)];
    const utilities = await compileTailwind(candidates);
    const shell =
      `:root{--cyc-accent:${PRIMARY}}\n` +
      readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
      '\n' +
      readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
      '\n' +
      readFileSync(MEDIA_CSS, 'utf8');
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
      `<body>${voice.outerHTML}${nonvoice.outerHTML}</body></html>`;

    const page = await (await getBrowser()).newPage();
    try {
      await page.setContent(html, {waitUntil: 'load'});
      styles = await page.evaluate(() => {
        const read = (sel: string, props: string[]) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`selector ${sel} matched nothing`);
          const s = getComputedStyle(el);
          const o: Record<string, string> = {};
          for (const p of props) o[p] = s.getPropertyValue(p);
          return o;
        };
        return {
          voiceSample: read('#voice .cyc-signal-track .cyc-signal-sample', [
            'background-color',
            'opacity'
          ]),
          voiceTrack: read('#voice .cyc-signal-track .cyc-signal-samples', ['height']),
          overlaySample: read('#voice .cyc-signal-progress .cyc-signal-sample', [
            'background-color',
            'opacity'
          ]),
          nonvoiceSample: read('#nonvoice .cyc-signal-track .cyc-signal-sample', [
            'background-color',
            'opacity'
          ]),
          nonvoiceTrack: read('#nonvoice .cyc-signal-track .cyc-signal-samples', ['height'])
        };
      });
    } finally {
      await page.close();
    }

    expect(styles.voiceSample['background-color']).toBe(PRIMARY);
    expect(styles.nonvoiceSample['background-color']).toBe(PRIMARY);
    expect(styles.overlaySample['background-color']).toBe(PRIMARY);

    expect(styles.voiceSample.opacity).toBe('0.45');
    expect(styles.nonvoiceSample.opacity).toBe('0.4');
    expect(parseFloat(styles.voiceTrack.height)).toBeCloseTo(50, 1);
    expect(parseFloat(styles.nonvoiceTrack.height)).toBeCloseTo(50, 1);

    expect(styles.overlaySample.opacity).toBe('1');
  });
});
