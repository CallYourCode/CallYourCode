import {test, expect, type Page} from '@playwright/test';
import {createServer, type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// THE cross-build update proof. The revert of feat-sw-boot happened because the
// worker got STUCK: app/public/cyc-sw.js was byte-identical build to build (the
// stamp lived only in cyc-precache.json), so a browser's service-worker update
// check found the script unchanged, never re-installed, and the versioned
// precache froze on the FIRST build forever. A cold-boot test cannot catch that;
// only a two-build swap can. So this spec drives the REAL app/public/cyc-sw.js
// through three successive builds in a real browser and proves the worker keeps
// updating: each build's byte-different script re-installs, its stamp-named cache
// wins, the page is served the new build, older caches are evicted by activate,
// and there is no reload loop and no stale asset.
//
// It runs its own tiny static host (a second "dist" it can repoint mid-test)
// because the suite's shared python http.server serves one fixed dir and cannot
// be swapped. 127.0.0.1 is a secure context, so the worker registers normally.
// The worker source served here is the exact app/public/cyc-sw.js with the stamp
// baked in the same way scripts/build-cyc.sh bakes it (__CYC_BUILD__ -> stamp),
// so this tests the shipped artifact and the build's stamp injection together.

test.skip(({browserName}) => browserName !== 'chromium', 'service worker is chromium-only here');

// The real worker, with the build script's stamp substitution applied. Stamps
// are 10-digit so their lexical order is their numeric order, exactly as
// cyc-sw.js's cycCacheNames() assumes when it calls the last name the current
// build.
const SW_SRC = readFileSync(resolve(__dirname, '..', '..', 'public', 'cyc-sw.js'), 'utf8');
if (!SW_SRC.includes('__CYC_BUILD__')) {
  throw new Error('sw-update-swap: public/cyc-sw.js has no __CYC_BUILD__ placeholder to bake');
}

type Build = {stamp: string; hash: string};
const A: Build = {stamp: '1900000001', hash: 'aaaaaaaa'};
const B: Build = {stamp: '1900000002', hash: 'bbbbbbbb'};
const C: Build = {stamp: '1900000003', hash: 'cccccccc'};

// A minimal but real dist for one build: the app shell references this build's
// one hashed asset, so "the page loaded build X" is observable in the DOM, and a
// stale asset would be observable too. cyc-sw.js and cyc-precache.json are what
// the worker actually reads.
function distFor(b: Build): Record<string, {type: string; body: string}> {
  const assetPath = `assets/app-${b.hash}.js`;
  return {
    'index.html': {
      type: 'text/html; charset=utf-8',
      body:
        '<!doctype html><html><head><meta charset="utf-8"><title>cyc</title></head>' +
        `<body><div id="cyc-build">BUILD-${b.stamp}</div>` +
        `<script src="/${assetPath}"></script></body></html>`
    },
    [assetPath]: {
      type: 'text/javascript; charset=utf-8',
      body: `window.__cycBuildAsset = ${JSON.stringify(b.stamp)};`
    },
    'cyc-precache.json': {
      type: 'application/json; charset=utf-8',
      body: JSON.stringify({version: b.stamp, assets: ['index.html', assetPath]})
    },
    'cyc-sw.js': {
      type: 'text/javascript; charset=utf-8',
      body: SW_SRC.replace('__CYC_BUILD__', b.stamp)
    }
  };
}

// A static host whose served build can be repointed between reloads. Every
// response is no-store so an HTTP cache can never mask what the worker does; the
// service-worker update check bypasses the HTTP cache for the top-level script
// anyway, this just removes all doubt.
class SwapHost {
  private current: Record<string, {type: string; body: string}>;
  readonly server: Server;
  origin = '';

  constructor(first: Build) {
    this.current = distFor(first);
    this.server = createServer((req, res) => {
      const path = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'index.html';
      const file = this.current[path === '' ? 'index.html' : path];
      res.setHeader('Cache-Control', 'no-store');
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
    if (!addr || typeof addr === 'string') throw new Error('sw-update-swap: no server port');
    this.origin = `http://127.0.0.1:${addr.port}`;
  }

  serve(b: Build): void {
    this.current = distFor(b);
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

async function cacheKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('cyc-precache-')));
}

// The shell the worker serves right now, read through the controller (a fetch
// for /index.html is a "shell" route in cyc-sw.js). Its marker is the build the
// worker currently hands the page.
async function servedShell(page: Page): Promise<string> {
  return page.evaluate(() => fetch('/index.html', {cache: 'no-store'}).then((r) => r.text()));
}

// Register once, then wait until the worker controls the page and build A's
// stamp-named cache holds every asset the manifest names.
async function warmBuildA(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.register('/cyc-sw.js', {scope: '/'}));
  await expect
    .poll(
      () =>
        page.evaluate(async (stamp) => {
          if (!navigator.serviceWorker.controller) return false;
          const names = (await caches.keys()).filter((n) => n.startsWith('cyc-precache-'));
          if (!names.includes('cyc-precache-' + stamp)) return false;
          let manifest: {assets?: string[]};
          try {
            manifest = await (await fetch('/cyc-precache.json', {cache: 'no-store'})).json();
          } catch {
            return false;
          }
          for (const a of manifest.assets ?? []) {
            if (!(await caches.match(a, {ignoreSearch: true}))) return false;
          }
          return true;
        }, A.stamp),
      {timeout: 30_000, message: 'the worker never warmed build A'}
    )
    .toBe(true);
}

// Repoint the host at the next build, force an update check, and wait until the
// new build has installed (its stamp-named cache exists) and is being served
// (the worker now hands out that build's shell). Then reload so the document
// itself is the new build. Returns nothing; asserts are in the test.
async function swapTo(page: Page, next: Build, host: SwapHost): Promise<void> {
  host.serve(next);
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
  });
  await expect
    .poll(
      () =>
        page.evaluate(async (stamp) => {
          const names = (await caches.keys()).filter((n) => n.startsWith('cyc-precache-'));
          if (!names.includes('cyc-precache-' + stamp)) return false;
          const html = await fetch('/index.html', {cache: 'no-store'}).then((r) => r.text());
          return html.includes('BUILD-' + stamp);
        }, next.stamp),
      {timeout: 30_000, message: `the worker never re-installed / served build ${next.stamp}`}
    )
    .toBe(true);
  // A reload now boots the document off the new build (the worker serves the
  // highest-stamp shell + assets). This is a plain navigation, not a loop.
  await page.reload({waitUntil: 'load'});
}

test('a new build re-installs the worker, wins, evicts the oldest, and never loops', async ({
  page
}) => {
  // Three warm/install polls of up to 30s each plus two reloads: under the
  // suite's parallel load the service-worker update checks can crawl, so give
  // the whole cross-build sequence generous headroom over the 90s default (a
  // contended run once starved right at the 90s cap and only healed on retry).
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`));

  const host = new SwapHost(A);
  await host.listen();
  try {
    // BUILD A: a cold boot from the network, then the worker warms its cache.
    await page.goto(`${host.origin}/`, {waitUntil: 'load'});
    await warmBuildA(page);
    expect(await cacheKeys(page)).toContain('cyc-precache-' + A.stamp);
    expect(await servedShell(page)).toContain('BUILD-' + A.stamp);

    // BUILD B: byte-different cyc-sw.js (new stamp) + new manifest + new hashed
    // asset. The whole point of the fix: the update check must SEE the change.
    await swapTo(page, B, host);

    // The document is now build B, its own asset ran, the worker serves build B,
    // and build B's stamp-named cache exists.
    expect(await page.textContent('#cyc-build')).toBe('BUILD-' + B.stamp);
    expect(await page.evaluate(() => (window as {__cycBuildAsset?: string}).__cycBuildAsset)).toBe(
      B.stamp
    );
    const shellB = await servedShell(page);
    expect(shellB).toContain('BUILD-' + B.stamp);
    // No stale build-A asset: the served shell points only at build B's hash.
    expect(shellB).toContain(`app-${B.hash}.js`);
    expect(shellB).not.toContain(`app-${A.hash}.js`);
    const afterB = await cacheKeys(page);
    expect(afterB).toContain('cyc-precache-' + B.stamp);
    // By design cyc-sw.js keeps the immediately previous generation (so a page
    // caught mid-swap still resolves), so build A's cache is retained here, NOT
    // deleted yet. The next build is what evicts it -- proven below.
    expect(afterB).toContain('cyc-precache-' + A.stamp);

    // BUILD C: a third build. activate keeps current + previous (B, C) and now
    // drops the oldest (A). This is the "old cache deleted by activate" proof.
    await swapTo(page, C, host);
    expect(await page.textContent('#cyc-build')).toBe('BUILD-' + C.stamp);
    const afterC = await cacheKeys(page);
    expect(afterC).toContain('cyc-precache-' + C.stamp);
    expect(afterC).toContain('cyc-precache-' + B.stamp);
    expect(afterC, 'activate did not evict the oldest build cache').not.toContain(
      'cyc-precache-' + A.stamp
    );
    expect(await servedShell(page)).toContain('BUILD-' + C.stamp);

    // NO reload loop: clients.claim changes the controller without navigating,
    // so a sentinel set on the settled build-C page must survive. If the worker
    // were forcing reloads, this would be wiped.
    await page.evaluate(() => ((window as {__cycSentinel?: number}).__cycSentinel = 1));
    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => (window as {__cycSentinel?: number}).__cycSentinel)).toBe(1);
    expect(await page.textContent('#cyc-build')).toBe('BUILD-' + C.stamp);

    expect(
      pageErrors,
      `uncaught exception(s) during the cross-build swap:\n${pageErrors.join('\n---\n')}`
    ).toEqual([]);
  } finally {
    await host.close();
  }
});
