import {describe, expect, test} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {
  MEDIA_PRIMARY_BG,
  MEDIA_PRIMARY_TEXT,
  MEDIA_PRIMARY_ACCENT,
  MEDIA_SURFACE_BG,
  MEDIA_SECONDARY_TEXT
} from '../features/media/mediaPaint';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const SHELL = resolve(SRC, 'shell');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

function sourceTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceTs(full));
    else if (entry.name.endsWith('.ts') && entry.name !== 'cycMediaClassExtraction.test.ts')
      out.push(full);
  }
  return out;
}
const FILES = sourceTs(SRC).map((path) => ({path, text: readFileSync(path, 'utf8')}));
const ALL_SOURCE = FILES.map((f) => f.text).join('\n');

// Detect arbitrary-value utilities assembled inside template literals.
const INTERPOLATED_UTILITY = /[a-z][a-z0-9]*-\[[^\]\n'"`]*\$\{/;

describe('no runtime Tailwind arbitrary-value interpolation survives in app/src', () => {
  test('no .ts assembles a `-[${...}]` utility at runtime', () => {
    const hits = FILES.filter((f) => INTERPOLATED_UTILITY.test(f.text)).map((f) => f.path);
    expect(hits).toEqual([]);
  });
});

const MAPS = {
  MEDIA_PRIMARY_BG,
  MEDIA_PRIMARY_TEXT,
  MEDIA_PRIMARY_ACCENT,
  MEDIA_SURFACE_BG,
  MEDIA_SECONDARY_TEXT
} as const;
const CANDIDATES = Object.values(MAPS).flatMap((m) => Object.values(m));

describe('media theme-map values are whole literal classes visible to the scanner', () => {
  test('every value is a fully-formed arbitrary utility, never interpolated', () => {
    for (const cls of CANDIDATES) {
      expect(cls).toMatch(/^[a-z][a-z0-9]*-\[[^\]]+\]$/);
      expect(cls).not.toContain('${');
    }
  });

  test('every emitted class appears verbatim in source (extractor will catch it)', () => {
    for (const cls of CANDIDATES) {
      expect(ALL_SOURCE, `missing literal ${cls}`).toContain(`'${cls}'`);
    }
  });
});

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

describe('media theme-map values compile to real CSS via the app Tailwind entry', () => {
  test('each arbitrary utility emits a rule carrying its literal value', async () => {
    const css = await compileTailwind(CANDIDATES);
    for (const cls of CANDIDATES) {
      const value = cls.slice(cls.indexOf('[') + 1, cls.lastIndexOf(']'));
      expect(css, `no rule for ${cls}`).toContain(value);
    }
  });
});

describe('derived removal arrays equal the union of the theme values they clear', () => {
  test('media painters clear exactly their own map values', () => {
    expect(Object.values(MEDIA_PRIMARY_BG)).toEqual(['bg-[#96602f]', 'bg-[#c98652]']);
    expect(Object.values(MEDIA_PRIMARY_TEXT)).toEqual(['text-[#96602f]', 'text-[#c98652]']);
    expect(Object.values(MEDIA_PRIMARY_ACCENT)).toEqual(['accent-[#96602f]', 'accent-[#c98652]']);
    expect(Object.values(MEDIA_SURFACE_BG)).toEqual(['bg-[#ffffff]', 'bg-[#17171a]']);
    expect(Object.values(MEDIA_SECONDARY_TEXT)).toEqual(['text-[#6b6b70]', 'text-[#a0a0a6]']);
  });
});
