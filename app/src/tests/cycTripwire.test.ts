/* THE THREE-LAYER TRIPWIRE (offline design v2, section 4).
 *
 * UI <- store selectors + one status <- sync worker <- engine. The UI knows
 * the pipe through four store exports (syncStatus, onSyncStatus,
 * engineReachable, sessionSyncedAt, plus intentState) and nothing else: no
 * client import, no connection state, no dormant vocabulary, no demo mode.
 * And the sync worker never reads the document or shows a toast. Two greps,
 * both empty, mechanically:
 *
 *   grep -rn "from '@/engine/client'\|connectionOf\|hostUpOf\|isDormant\|eventsUnavailable\|dataState.mode === 'demo'" src --exclude-dir=engine
 *   grep -n "document\.\|toast(" src/engine/sync/*.ts
 *
 * And one house rule with the same mechanical proof: no em-dash anywhere in
 * the app source, neither the character nor its escape:
 *
 *   grep -rn $'\u2014' src; grep -rn 'u2014' src
 *
 *   bun run test --run src/tests/cycTripwire.test.ts
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {describe, expect, test} from 'vitest';

const SRC = join(__dirname, '..');
const SELF = join(__dirname, 'cycTripwire.test.ts');

function walk(dir: string, skip: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (skip(path)) continue;
    if (entry.isDirectory()) walk(path, skip, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function hits(files: string[], pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (pattern.test(line)) found.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe('the three-layer tripwire', () => {
  test('nothing outside src/engine reaches past the store selectors', () => {
    const files = walk(SRC, (p) => p === join(SRC, 'engine') || p === SELF);
    const pattern =
      /from '@\/engine\/client'|connectionOf|hostUpOf|isDormant|eventsUnavailable|dataState\.mode === 'demo'/;
    expect(hits(files, pattern)).toEqual([]);
  });

  test('the sync worker never reads the document or shows a toast', () => {
    const files = walk(join(SRC, 'engine', 'sync'), () => false);
    expect(hits(files, /document\.|toast\(/)).toEqual([]);
  });

  test('no em-dash in the app source, as a character or as its escape', () => {
    const files = walk(SRC, (p) => p === SELF);
    expect(hits(files, /\u2014|\\u2014/)).toEqual([]);
  });
});
