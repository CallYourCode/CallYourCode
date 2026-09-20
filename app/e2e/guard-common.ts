import type {FullConfig, TestCase} from '@playwright/test/reporter';
import process from 'node:process';

export const NARROWING: Record<string, boolean> = {
  '-g': true,
  '--grep': true,
  '-G': true,
  '--grep-invert': true,
  '--shard': true,
  '--last-failed': false,
  '--only-changed': false
};

export function filtered(config: FullConfig): string | null {
  const narrowed: string[] = [];
  const argv = process.argv.slice(2);

  const values = new Set<number>();
  argv.forEach((arg, i) => {
    if (values.has(i)) return;
    const eq = arg.indexOf('=');

    const short = /^-[gG]./.test(arg) && arg[1] !== '-' && eq < 0;
    const flag = short ? arg.slice(0, 2) : eq > 0 ? arg.slice(0, eq) : arg;
    if (!(flag in NARROWING)) return;
    let value = short ? arg.slice(2) : eq > 0 ? arg.slice(eq + 1) : '';
    if (!value && NARROWING[flag] && i + 1 < argv.length) {
      value = argv[i + 1];
      values.add(i + 1);
    }
    narrowed.push(value ? `${flag} ${value}` : flag);
  });

  argv.forEach((arg, i) => {
    if (values.has(i) || arg.startsWith('-')) return;
    if (/\.spec\.ts/.test(arg) || arg.startsWith('e2e/')) narrowed.push(arg);
  });

  if (config.grep && String(config.grep) !== '/.*/') narrowed.push(`grep ${String(config.grep)}`);
  if (config.grepInvert) narrowed.push(`grep-invert ${String(config.grepInvert)}`);
  if (config.shard) narrowed.push(`--shard ${config.shard.current}/${config.shard.total}`);
  return narrowed.length ? [...new Set(narrowed)].join(' ') : null;
}

export function refuseReporterOverride(guard: string): void {
  const argv = process.argv.slice(2);
  const at = argv.findIndex((a) => a === '--reporter' || a.startsWith('--reporter='));
  if (at < 0) return;
  const arg = argv[at];
  const given = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : (argv[at + 1] ?? '');
  const named = given
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const bare = guard.replace(/^\.\//, '');
  if (named.some((n) => n.replace(/^\.\//, '') === bare)) return;
  throw new Error(
    `--reporter REPLACES this config's reporter array, which unloads ${guard}. ` +
      'The run would go ahead with no count floor and no skip check, and would say ' +
      'nothing about it.\n' +
      `  Name the guard as well:  --reporter=${given || '<yours>'},${guard}\n` +
      '  Or drop the flag: the config already prints the run with the list reporter.'
  );
}

export function keyOf(test: TestCase, projects: string[]): string {
  const file = test.location.file.replace(/^.*[/\\]/, '');
  const titles = test
    .titlePath()
    .filter((t) => !!t && !projects.includes(t) && !t.endsWith('.spec.ts'));
  return [file, ...titles].join(' > ');
}
