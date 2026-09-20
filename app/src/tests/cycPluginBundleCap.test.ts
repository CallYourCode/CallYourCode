import {describe, expect, test} from 'vitest';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Ensures plugin bundles avoid the settings dependency.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');

// Resolve local TypeScript imports.
function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = resolve(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const cand of [base + '.ts', base + '.tsx', resolve(base, 'index.ts')]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

const IMPORT_RE = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;

// Return the transitive local import graph.
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(SRC, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src))) {
      const resolved = resolveSpec(file, m[1] ?? m[2]);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

const ENTRIES = ['plugins/git/plugin.ts', 'plugins/files/plugin.ts'] as const;
const HEAVY = resolve(SRC, 'features/settings/preferences.ts');
const HELPER = resolve(SRC, 'plugins/scrollTheme.ts');

describe('plugin pages keep the scrollbar-tint drain off the heavy settings module', () => {
  for (const entry of ENTRIES) {
    test(`${entry} never reaches features/settings/preferences`, () => {
      const graph = importGraph(entry);
      expect(graph.size).toBeGreaterThan(5);
      expect([...graph]).not.toContain(HEAVY);
      expect([...graph]).toContain(HELPER);
    });
  }

  test('the shared scrollTheme helper is import-free and carries the finite tints', () => {
    const src = readFileSync(HELPER, 'utf8');
    expect(src).not.toMatch(/\bimport\b/);
    expect(src).toContain("'--cyc-overflow': 'rgba(100, 100, 100, 0.4)'");
    expect(src).toContain("'--cyc-overflow-active': 'rgba(0, 0, 0, 0.6)'");
    expect(src).toContain("'--cyc-overflow': 'rgba(121, 121, 121, 0.4)'");
    expect(src).toContain("'--cyc-overflow-active': 'rgba(191, 191, 191, 0.4)'");
  });
});
