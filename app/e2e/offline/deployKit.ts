import {spawn, type ChildProcess} from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

// Deploys for the update specs: real builds of the committed app/dist served by
// deployHost.ts (the app server's real static answer) that a spec can swap.

const DIST = resolve(__dirname, '..', '..', 'dist');
const HOST_TS = resolve(__dirname, 'deployHost.ts');

const TEXT = /\.(js|css|html|json|txt|webmanifest)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Build A: the committed dist, source maps left out (never fetched at runtime).
// Build k (1..n): A re-stamped (A + k) with A's own js/css renamed (their
// content changes when the stamp does), every reference rewritten, and every
// earlier build's own chunks carried next to its own, exactly the shape of a
// run of real redeploys (a page still on an earlier build lazy-loads its own).
export function makeBuilds(n: number): {dirs: string[]; stamps: string[]} {
  const root = mkdtempSync(join(tmpdir(), 'cyc-deploy-'));
  const a = join(root, 'a');
  cpSync(DIST, a, {recursive: true, filter: (src) => !src.endsWith('.map')});
  const stampA = readFileSync(join(a, 'build.txt'), 'utf8').trim().split(/\s+/).pop() ?? '';
  if (!/^\d{10}$/.test(stampA)) throw new Error('deployKit: dist has no build stamp');
  const own = readFileSync(join(a, 'built-assets.txt'), 'utf8')
    .split('\n')
    .filter((f) => /\.(js|css)$/.test(f));
  const suffix = (k: number) => (k === 1 ? 'B' : 'B' + k); // build 1 keeps the old 'B' names
  const ownOf = (k: number) =>
    k === 0 ? own : own.map((f) => f.replace(/\.(js|css)$/, suffix(k) + '.$1'));
  const dirs = [a];
  const stamps = [stampA];
  for (let k = 1; k <= n; k++) {
    const b = join(root, 'b' + k);
    cpSync(a, b, {recursive: true});
    const stamp = String(Number(stampA) + k);
    const renames = own.map((f, i) => [f.split('/').pop() ?? f, ownOf(k)[i].split('/').pop() ?? f]);
    for (let i = 0; i < own.length; i++)
      renameSync(join(b, 'assets', own[i]), join(b, 'assets', ownOf(k)[i]));
    for (const p of walk(b).filter((p) => TEXT.test(p))) {
      let s = readFileSync(p, 'utf8');
      for (const [from, to] of renames) s = s.split(from).join(to);
      s = s.split(stampA).join(stamp);
      writeFileSync(p, s);
    }
    for (let j = 0; j < k; j++)
      for (const f of ownOf(j)) cpSync(join(dirs[j], 'assets', f), join(b, 'assets', f));
    dirs.push(b);
    stamps.push(stamp);
  }
  return {dirs, stamps};
}

export function makeDists(): {a: string; b: string; stampA: string; stampB: string} {
  const {dirs, stamps} = makeBuilds(1);
  return {a: dirs[0], b: dirs[1], stampA: stamps[0], stampB: stamps[1]};
}

export async function startHost(dist: string): Promise<{origin: string; proc: ChildProcess}> {
  const proc = spawn('bun', [HOST_TS, dist], {stdio: ['ignore', 'pipe', 'pipe']});
  const port = await new Promise<number>((ok, fail) => {
    let out = '';
    const t = setTimeout(() => fail(new Error('deployHost never listened: ' + out)), 15_000);
    const take = (d: Buffer) => {
      out += String(d);
      const m = out.match(/LISTENING (\d+)/);
      if (m) {
        clearTimeout(t);
        ok(Number(m[1]));
      }
    };
    proc.stdout?.on('data', take);
    proc.stderr?.on('data', take);
    proc.on('exit', (c) => fail(new Error(`deployHost exited ${c}: ${out}`)));
  });
  return {origin: `http://127.0.0.1:${port}`, proc};
}

export const deploy = async (origin: string, dist: string, fail: boolean, stall = false) => {
  const q = `dist=${encodeURIComponent(dist)}&fail=${fail ? 1 : 0}&stall=${stall ? 1 : 0}`;
  const r = await fetch(`${origin}/__deploy?${q}`);
  if (!r.ok) throw new Error('deploy failed');
};
