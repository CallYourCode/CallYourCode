import {test, expect, type Page} from '@playwright/test';
import {createServer, type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// THE BLACK-SCREEN REPRODUCTION. A new build's precache bucket NAME appears the
// instant the worker's install calls caches.open, before addAll has stored the
// shell, and even if addAll fails (offline, a flaky radio, a killed fetch
// mid-precache). If the worker then serves the NEW network index.html from that
// empty newest bucket, the page is pointed at a hashed entry chunk that is not
// cached either; with no network to fetch it, nothing paints and there is no
// boot line -- exactly the iPhone black screen (app.log 2026-10-01 15:30, a
// reload.go followed by a 27 s hole until a relaunch boot).
//
// This drives the REAL app/public/cyc-sw.js: build A warms fully, then build B
// is served with a byte-different worker and a valid manifest but its ASSETS
// 404, so B's addAll fails. B's install now fails with it: B's half-made bucket
// is deleted and A's worker stays in control (sw-stuck-build.spec.ts proves the
// retry then lands B). The page then goes offline and navigates through the
// controller, and must boot A from A's full bucket. cycServeShell's fallback to
// the newest bucket that holds a shell still covers an empty bucket left behind
// by a worker from before that change (unit-tested in cycSwPrecache.test.ts).
// Before the first fix this served the network and, offline, failed: the blank
// page.

test.skip(({browserName}) => browserName !== 'chromium', 'service worker is chromium-only here');

const SW_SRC = readFileSync(resolve(__dirname, '..', '..', 'public', 'cyc-sw.js'), 'utf8');
if (!SW_SRC.includes('__CYC_BUILD__')) {
  throw new Error('sw-empty-bucket: public/cyc-sw.js has no __CYC_BUILD__ placeholder to bake');
}

const A = {stamp: '1910000001', hash: 'aaaaaaaa'};
const B = {stamp: '1910000002', hash: 'bbbbbbbb'};

type Files = Record<string, {type: string; body: string} | 'gone'>;

function distA(): Files {
  const asset = `assets/app-${A.hash}.js`;
  return {
    'index.html': {
      type: 'text/html; charset=utf-8',
      body:
        `<!doctype html><html><head><meta charset="utf-8"><meta name="cyc-build" content="${A.stamp}"><title>cyc</title></head>` +
        `<body><div id="cyc-build">BUILD-${A.stamp}</div>` +
        `<script src="/${asset}"></script></body></html>`
    },
    [asset]: {
      type: 'text/javascript; charset=utf-8',
      body: `window.__cycBuildAsset = ${JSON.stringify(A.stamp)};`
    },
    'cyc-precache.json': {
      type: 'application/json; charset=utf-8',
      body: JSON.stringify({version: A.stamp, assets: ['index.html', asset]})
    },
    'cyc-sw.js': {
      type: 'text/javascript; charset=utf-8',
      body: SW_SRC.replace('__CYC_BUILD__', A.stamp)
    }
  };
}

// Build B: a byte-different worker (so the update check re-installs) and a valid
// manifest (so install's caches.open creates B's bucket), but the shell and the
// hashed asset are GONE (404), so B's addAll rejects and B's bucket stays empty.
function distB(): Files {
  const asset = `assets/app-${B.hash}.js`;
  return {
    'index.html': 'gone',
    [asset]: 'gone',
    'cyc-precache.json': {
      type: 'application/json; charset=utf-8',
      body: JSON.stringify({version: B.stamp, assets: ['index.html', asset]})
    },
    'cyc-sw.js': {
      type: 'text/javascript; charset=utf-8',
      body: SW_SRC.replace('__CYC_BUILD__', B.stamp)
    }
  };
}

class SwapHost {
  private current: Files;
  readonly server: Server;
  origin = '';
  constructor(first: Files) {
    this.current = first;
    this.server = createServer((req, res) => {
      const path = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'index.html';
      const file = this.current[path === '' ? 'index.html' : path];
      res.setHeader('Cache-Control', 'no-store');
      if (!file || file === 'gone') {
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
    if (!addr || typeof addr === 'string') throw new Error('sw-empty-bucket: no server port');
    this.origin = `http://127.0.0.1:${addr.port}`;
  }
  serve(f: Files): void {
    this.current = f;
  }
  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const precacheNames = (page: Page) =>
  page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('cyc-precache-')));

test('an empty new bucket never blanks the reload: the cached shell still boots offline', async ({
  page
}) => {
  test.setTimeout(120_000);
  const host = new SwapHost(distA());
  await host.listen();
  try {
    // BUILD A cold-boots and the worker warms its full cache.
    await page.goto(`${host.origin}/`, {waitUntil: 'load'});
    await page.evaluate(() => navigator.serviceWorker.register('/cyc-sw.js', {scope: '/'}));
    await expect
      .poll(
        () =>
          page.evaluate(async (stamp) => {
            if (!navigator.serviceWorker.controller) return false;
            const names = (await caches.keys()).filter((n) => n.startsWith('cyc-precache-'));
            if (!names.includes('cyc-precache-' + stamp)) return false;
            return !!(await caches.match('/index.html', {ignoreSearch: true}));
          }, A.stamp),
        {timeout: 30_000, message: 'the worker never warmed build A'}
      )
      .toBe(true);

    // BUILD B: byte-different worker + valid manifest, but its assets 404 (the
    // network killed mid-precache). Force the update check and wait until B's
    // install attempt is over.
    host.serve(distB());
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
        {timeout: 30_000, message: 'build B install attempt never settled'}
      )
      .toBe(true);

    // B's failed install left no bucket behind; A's full bucket is the shell.
    const names = (await precacheNames(page)).sort();
    expect(names, 'a failed install left its empty bucket').not.toContain(
      'cyc-precache-' + B.stamp
    );
    expect(names).toContain('cyc-precache-' + A.stamp);

    // Go offline, then navigate through the controller. The worker must serve a
    // bootable shell (build A, whose chunks are all cached), NOT the empty-bucket
    // network fetch that offline would fail.
    await page.context().setOffline(true);
    const shell = await page.evaluate(() =>
      fetch('/index.html', {cache: 'no-store'})
        .then((r) => r.text())
        .catch((e) => 'FETCH-FAILED: ' + String(e))
    );
    expect(shell, 'the empty newest bucket blanked the offline navigation').toContain('BUILD-');
    expect(shell).toContain('BUILD-' + A.stamp);

    // And a real reload offline still paints the app, not a black screen.
    await page.reload({waitUntil: 'load'});
    expect(await page.textContent('#cyc-build')).toBe('BUILD-' + A.stamp);
  } finally {
    await page.context().setOffline(false);
    await host.close();
  }
});
