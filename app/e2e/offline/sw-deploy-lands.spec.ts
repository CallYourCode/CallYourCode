import {test, expect, type Page} from '@playwright/test';
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
import {bootPinned} from './rig';
import {startChatEngine, seedMessages, type ChatEngine} from './chatEngine';
import {captureLog, openChat, type LogCapture} from './offlineKit';

// THE STUCK BUILD, end to end on the real app (iPhone 726ju, 2026-10-03: build
// B deployed, B's worker installed and took control, yet every later launch and
// foreground stayed on build A). The real committed app/dist is build A; build B
// is the same dist re-stamped the way a rebuild differs (new stamp baked into
// the bundle, build.txt, cyc-sw.js and cyc-precache.json, and the build's own
// hashed chunks renamed, with A's chunks carried as scripts/build-cyc.sh does).
// Both are served by deployHost.ts, a scratch origin running the app server's
// real static answer (same headers as the live origin).
//
// The client is open in a chat with an unsent draft. B is deployed while the
// radio drops the precache fetches; the first foreground's update attempt dies.
// The network recovers and ONE more foreground must land the client on B: no
// black screen, the chat and its draft intact, reload.landed naming A -> B.
// Then a relaunch with the origin gone still boots B from the precache.

const DIST = resolve(__dirname, '..', '..', 'dist');
const HOST_TS = resolve(__dirname, 'deployHost.ts');
const NAME = 'Alpha Relay';
const PANE = 'alpha';
const DRAFT = 'this draft survives the update';
const INPUT = '#cyc-thread-pane .cyc-composer-input';

const TEXT = /\.(js|css|html|json|txt|webmanifest)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Build A: the committed dist, source maps left out (never fetched at runtime).
// Build B: A re-stamped (A + 1) with this build's own js/css renamed (their
// content changes when the stamp does), every reference rewritten, and A's own
// chunks carried next to B's, exactly the shape of a real redeploy.
function makeDists(): {a: string; b: string; stampA: string; stampB: string} {
  const root = mkdtempSync(join(tmpdir(), 'cyc-deploy-'));
  const a = join(root, 'a');
  const b = join(root, 'b');
  cpSync(DIST, a, {recursive: true, filter: (src) => !src.endsWith('.map')});
  cpSync(a, b, {recursive: true});
  const stampA = readFileSync(join(a, 'build.txt'), 'utf8').trim().split(/\s+/).pop() ?? '';
  if (!/^\d{10}$/.test(stampA)) throw new Error('sw-deploy-lands: dist has no build stamp');
  const stampB = String(Number(stampA) + 1);
  const own = readFileSync(join(a, 'built-assets.txt'), 'utf8')
    .split('\n')
    .filter((f) => /\.(js|css)$/.test(f));
  const renames = own.map((f) => {
    const base = f.split('/').pop() ?? f;
    return [base, base.replace(/\.(js|css)$/, 'B.$1')] as const;
  });
  for (const f of own) {
    const dir = join(b, 'assets', f.split('/').slice(0, -1).join('/'));
    const base = f.split('/').pop() ?? f;
    renameSync(join(dir, base), join(dir, base.replace(/\.(js|css)$/, 'B.$1')));
  }
  for (const p of walk(b).filter((p) => TEXT.test(p))) {
    let s = readFileSync(p, 'utf8');
    for (const [from, to] of renames) s = s.split(from).join(to);
    s = s.split(stampA).join(stampB);
    writeFileSync(p, s);
  }
  // A's own chunks ride along in B, so a page still on A lazy-loads them.
  for (const f of own) cpSync(join(a, 'assets', f), join(b, 'assets', f));
  return {a, b, stampA, stampB};
}

async function startHost(dist: string): Promise<{origin: string; proc: ChildProcess}> {
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

const deploy = async (origin: string, dist: string, fail: boolean) => {
  const r = await fetch(`${origin}/__deploy?dist=${encodeURIComponent(dist)}&fail=${fail ? 1 : 0}`);
  if (!r.ok) throw new Error('deploy failed');
};

// What the app does when the user brings it back: the visibility edge.
const foreground = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

const settledUpdate = (page: Page) =>
  page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!reg && !reg.installing && !reg.waiting;
  });

const builds = (log: LogCapture) => log.of('boot').map((l) => l.field('build'));

test('a deploy whose first precache dies lands within one foreground, draft intact', async ({
  page
}) => {
  test.setTimeout(170_000);
  const {a, b, stampA, stampB} = makeDists();
  const host = await startHost(a);
  const rig: ChatEngine = await startChatEngine({
    sessions: [{id: PANE, name: NAME, messages: seedMessages(PANE, 6, 1_700_000_000_000)}]
  });
  const log = captureLog(page);
  try {
    // BUILD A boots, goes live, and its worker precaches A.
    await bootPinned(page, rig.port, {origin: host.origin, size: {width: 390, height: 844}});
    await expect
      .poll(
        () =>
          page.evaluate(async (stamp) => {
            if (!navigator.serviceWorker.controller) return false;
            const c = await caches.open('cyc-precache-' + stamp);
            return !!(await c.match('/index.html'));
          }, stampA),
        {timeout: 30_000, message: 'build A was never precached'}
      )
      .toBe(true);
    expect(builds(log)).toEqual([stampA]);

    // The user is in a chat with an unsent draft.
    await openChat(page, NAME);
    await page.locator(INPUT).click();
    await page.keyboard.type(DRAFT);

    // BUILD B is deployed while the radio kills the precache fetches. The first
    // foreground sees B is newer and its update attempt dies.
    await deploy(host.origin, b, true);
    const deployedAt = Date.now();
    await foreground(page);
    await expect
      .poll(() => log.since('sw.updatefound', deployedAt).length, {
        timeout: 20_000,
        message: 'B was never discovered'
      })
      .toBeGreaterThan(0);
    await expect.poll(() => settledUpdate(page), {timeout: 30_000}).toBe(true);
    expect(builds(log), 'nothing may reload onto a build that is not cached').toEqual([stampA]);

    // The network recovers. ONE foreground lands the client on B. The draft
    // holds the reload back for its patience window, never loses it.
    await deploy(host.origin, b, false);
    await foreground(page);
    await expect
      .poll(() => log.of('reload.landed').map((l) => l.field('to')), {
        timeout: 90_000,
        message: `one foreground after recovery never landed build B (boots: ${builds(log).join(',')})`
      })
      .toEqual([stampB]);
    expect(builds(log)).toEqual([stampA, stampB]);
    const landed = log.of('reload.landed')[0];
    expect(landed.field('from')).toBe(stampA);
    expect(Number(landed.field('gap')), 'the reload sat on a blank page').toBeLessThan(5_000);

    // The page said it was behind, on the first foreground already.
    expect(log.of('build.behind')[0]?.field('served')).toBe(stampB);

    // Not a black screen: the chat is back, with its draft.
    await page.waitForSelector('.cyc-message-list-scroll', {timeout: 15_000});
    await expect(page.locator(INPUT)).toHaveText(DRAFT, {timeout: 10_000});

    // Offline start: the origin is gone, a relaunch boots B from the precache.
    host.proc.kill();
    await new Promise((r) => host.proc.once('exit', r));
    await page.goto(`${host.origin}/?testhooks=1&relaunch=1`);
    await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
    expect(builds(log).pop()).toBe(stampB);
  } finally {
    // The update trail, as app.log would show it.
    const trail = /^(boot|sw\.|build\.|reload\.)/;
    console.log(
      log.lines
        .filter((l) => trail.test(l.event))
        .map((l) => l.raw)
        .join('\n')
    );
    host.proc.kill();
    await rig.close();
  }
});
