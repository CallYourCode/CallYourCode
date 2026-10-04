import {test, expect, type Page} from '@playwright/test';
import {createServer, type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// THE STUCK-BUILD REPRODUCTION (iPhone 726ju, 2026-10-03). Build B was deployed;
// the iPhone's update check found B's worker (sw.updatefound 13:41:34), B
// installed and activated (13:41:42), and yet every later launch booted build A.
// B's install had not filled B's bucket (the precache fetches died with the app
// suspended mid-install), and install swallowed that failure, so B's worker took
// control holding nothing of its own. The shell serve then answered every launch
// from A's full bucket, and since B's worker bytes never change again, no update
// check ever re-ran the install: stuck on A until the NEXT deploy.
//
// This drives the REAL app/public/cyc-sw.js in Chromium and WebKit: build A
// warms; build B is deployed but its assets fail during B's first install; the
// network recovers; then one foreground, which is what the app does on every
// visibility edge when build.txt says it is behind (staleReload nudgeWorker:
// registration.update()). The client must be served build B after that one
// foreground, and an offline relaunch must still boot from cache.

const SW_SRC = readFileSync(resolve(__dirname, '..', '..', 'public', 'cyc-sw.js'), 'utf8');
if (!SW_SRC.includes('__CYC_BUILD__')) {
  throw new Error('sw-stuck-build: public/cyc-sw.js has no __CYC_BUILD__ placeholder to bake');
}

type Build = {stamp: string; hash: string};
const A: Build = {stamp: '1920000001', hash: 'aaaaaaaa'};
const B: Build = {stamp: '1920000002', hash: 'bbbbbbbb'};

type File = {type: string; body: string};

function distFor(b: Build): Record<string, File> {
  const asset = `assets/app-${b.hash}.js`;
  return {
    'index.html': {
      type: 'text/html; charset=utf-8',
      body:
        '<!doctype html><html><head><meta charset="utf-8"><title>cyc</title></head>' +
        `<body><div id="cyc-build">BUILD-${b.stamp}</div>` +
        `<script src="/${asset}"></script></body></html>`
    },
    [asset]: {
      type: 'text/javascript; charset=utf-8',
      body: `window.__cycBuildAsset = ${JSON.stringify(b.stamp)};`
    },
    'cyc-precache.json': {
      type: 'application/json; charset=utf-8',
      body: JSON.stringify({version: b.stamp, assets: ['index.html', asset]})
    },
    'cyc-sw.js': {
      type: 'text/javascript; charset=utf-8',
      body: SW_SRC.replace('__CYC_BUILD__', b.stamp)
    }
  };
}

// A static host that can be repointed at another build and can fail the build's
// precache fetches (the shell and assets/) with a 503, the way a suspended or
// dropped radio kills them mid-install. The worker script and the manifest still
// answer, so the update check sees the new worker and its install starts.
class SwapHost {
  private current: Record<string, File>;
  failPrecache = false;
  readonly server: Server;
  origin = '';
  constructor(first: Build) {
    this.current = distFor(first);
    this.server = createServer((req, res) => {
      const path = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'index.html';
      const file = this.current[path];
      res.setHeader('Cache-Control', 'no-store');
      const precached = path === 'index.html' || path.startsWith('assets/');
      if (this.failPrecache && precached) {
        res.statusCode = 503;
        res.end('unavailable');
        return;
      }
      if (!file) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', file.type);
      res.statusCode = 200;
      res.end(file.body);
    });
  }
  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('sw-stuck-build: no server port');
    this.origin = `http://127.0.0.1:${addr.port}`;
  }
  serve(b: Build): void {
    this.current = distFor(b);
  }
  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

// The shell the controlling worker hands out right now.
const servedShell = (page: Page) =>
  page.evaluate(() =>
    fetch('/index.html', {cache: 'no-store'})
      .then((r) => r.text())
      .catch((e) => 'FETCH-FAILED: ' + String(e))
  );

// registration.update(), then wait until no install is in flight: the update
// attempt has either taken over or been discarded.
async function updateAndSettle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update().catch(() => {});
  });
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          return !!reg && !reg.installing && !reg.waiting;
        }),
      {timeout: 30_000, message: 'the update attempt never settled'}
    )
    .toBe(true);
}

test('a deploy whose first precache fails still lands within one foreground', async ({page}) => {
  test.setTimeout(120_000);
  const host = new SwapHost(A);
  await host.listen();
  try {
    // BUILD A cold-boots and the worker warms its full bucket.
    await page.goto(`${host.origin}/`, {waitUntil: 'load'});
    await page.evaluate(() => navigator.serviceWorker.register('/cyc-sw.js', {scope: '/'}));
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            if (!navigator.serviceWorker.controller) return false;
            return !!(await caches.match('/index.html', {ignoreSearch: true}));
          }),
        {timeout: 30_000, message: 'the worker never warmed build A'}
      )
      .toBe(true);
    expect(await servedShell(page)).toContain('BUILD-' + A.stamp);

    // BUILD B is deployed, but its first install's precache fetches die.
    host.serve(B);
    host.failPrecache = true;
    await updateAndSettle(page);
    // Whatever that attempt did, the page is never blanked: a shell still serves.
    expect(await servedShell(page)).toContain('BUILD-');

    // The network recovers. ONE foreground (the app's visibility check nudges
    // registration.update()) must deliver build B.
    host.failPrecache = false;
    await updateAndSettle(page);
    await expect
      .poll(() => servedShell(page), {
        timeout: 15_000,
        message: 'one foreground after the network recovered did not deliver build B (stuck on A)'
      })
      .toContain('BUILD-' + B.stamp);

    await page.reload({waitUntil: 'load'});
    expect(await page.textContent('#cyc-build')).toBe('BUILD-' + B.stamp);
    expect(await page.evaluate(() => (window as {__cycBuildAsset?: string}).__cycBuildAsset)).toBe(
      B.stamp
    );

    // An offline relaunch still boots build B, wholly from the precache. The
    // origin going away is the offline here: WebKit's emulated offline mode
    // also fails responses the worker serves from cache, so it cannot stand in
    // for a phone with no network.
    await host.close();
    await page.goto(`${host.origin}/?offline=1`, {waitUntil: 'load'});
    expect(await page.textContent('#cyc-build')).toBe('BUILD-' + B.stamp);
    expect(await page.evaluate(() => (window as {__cycBuildAsset?: string}).__cycBuildAsset)).toBe(
      B.stamp
    );
  } finally {
    if (host.server.listening) await host.close();
  }
});
