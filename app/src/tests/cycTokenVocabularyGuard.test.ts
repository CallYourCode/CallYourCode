// Theme token producer/consumer integrity.

import {describe, expect, test} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const TESTS_DIR = join('src', 'tests');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const FILES = sourceFiles(SRC).map((path) => ({path, text: readFileSync(path, 'utf8')}));
const rel = (path: string) =>
  path.slice(path.indexOf(TESTS_DIR) >= 0 ? path.indexOf(TESTS_DIR) : path.indexOf('src'));

describe('applyCycTheme writes the CYC copper palette with stable day/night literals', () => {
  const DAY: Record<string, string> = {
    '--cyc-accent': '#96602f',
    '--cyc-accent-rgb': '150,96,47',
    '--cyc-accent-tint': 'rgba(150, 96, 47, 0.1)',
    '--cyc-accent-pressed': '#784d26',
    '--cyc-danger': '#cc2f2f',
    '--cyc-danger-tint': 'rgba(204, 47, 47, 0.1)',
    '--cyc-surface': '#ffffff',
    '--cyc-surface-rgb': '255,255,255',
    '--cyc-text': '#1c1c1e',
    '--cyc-text-muted': '#6b6b70',
    '--cyc-text-muted-tint': 'rgba(107, 107, 112, 0.1)',
    '--cyc-bubble-out-ink': '#1b1b1d',
    '--cyc-bubble-out-ink-rgb': '27,27,29',
    '--cyc-bubble-out-surface': '#ead9c6',
    '--cyc-bubble-out-surface-rgb': '234,217,198',
    '--cyc-bubble-flash': 'rgba(150, 96, 47, .88)',
    '--cyc-bubble-flash-color': 'rgba(150, 96, 47, .88)'
  };
  const NIGHT: Record<string, string> = {
    '--cyc-accent': '#c98652',
    '--cyc-accent-rgb': '201,134,82',
    '--cyc-accent-tint': 'rgba(201, 134, 82, 0.1)',
    '--cyc-accent-pressed': '#a16b42',
    '--cyc-danger': '#e8484a',
    '--cyc-danger-tint': 'rgba(232, 72, 74, 0.1)',
    '--cyc-surface': '#17171a',
    '--cyc-surface-rgb': '23,23,26',
    '--cyc-text': '#ededee',
    '--cyc-text-muted': '#a0a0a6',
    '--cyc-text-muted-tint': 'rgba(160, 160, 166, 0.1)',
    '--cyc-bubble-out-ink': '#fbfbfc',
    '--cyc-bubble-out-ink-rgb': '251,251,252',
    '--cyc-bubble-out-surface': '#4a3527',
    '--cyc-bubble-out-surface-rgb': '74,53,39',
    '--cyc-bubble-flash': 'rgba(168, 108, 56, .88)',
    '--cyc-bubble-flash-color': 'rgba(168, 108, 56, .88)'
  };

  const readAll = async (name: 'day' | 'night', keys: string[]) => {
    const {applyCycTheme} = await import('../features/settings/preferences');
    applyCycTheme(name);
    const style = document.documentElement.style;
    const out: Record<string, string> = {};
    for (const token of keys) out[token] = style.getPropertyValue(token).trim();
    return out;
  };

  test('day literals', async () => {
    expect(await readAll('day', Object.keys(DAY))).toEqual(DAY);
  });
  test('night literals', async () => {
    expect(await readAll('night', Object.keys(NIGHT))).toEqual(NIGHT);
  });

  test('the pressed accent is a hex', async () => {
    const {applyCycTheme} = await import('../features/settings/preferences');
    for (const theme of ['day', 'night'] as const) {
      applyCycTheme(theme);
      const style = document.documentElement.style;
      expect(style.getPropertyValue('--cyc-accent-pressed').trim()).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('the CYC composer tokens are produced and consumed in lockstep', () => {
  // Token declarations and painter writes are producers; var() reads are consumers.
  const COMPOSER_TOKENS = ['--cyc-composer-surface'] as const;
  const declares = (text: string, token: string) => new RegExp(`${token}['"]?\\s*:`).test(text);
  const reads = (text: string, token: string) => new RegExp(`var\\(\\s*${token}\\s*\\)`).test(text);

  for (const token of COMPOSER_TOKENS) {
    test(`${token} is declared by at least one producer`, () => {
      const producers = FILES.filter((f) => declares(f.text, token)).map((f) => rel(f.path));
      expect(producers.length).toBeGreaterThan(0);
    });
    test(`${token} is read by at least one consumer`, () => {
      const consumers = FILES.filter((f) => reads(f.text, token)).map((f) => rel(f.path));
      expect(consumers.length).toBeGreaterThan(0);
    });
    test(`${token} has no reader without a producer`, () => {
      const anyProducer = FILES.some((f) => declares(f.text, token));
      const anyConsumer = FILES.some((f) => reads(f.text, token));
      expect(anyProducer).toBe(anyConsumer);
    });
  }
});
