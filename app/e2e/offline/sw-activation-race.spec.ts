import {test, expect, type Page} from '@playwright/test';
import {createServer, type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// THE PARKED WORKER (Chromium, proven 2026-10-03 with CDP ServiceWorker traces).
// A new build's worker installs and calls skipWaiting, so Chromium stops the
// old worker to activate it. A page request arriving at the old worker inside
// that few-millisecond stop restarts the old worker, and the activation is not
// retried until the old worker idles (30 s with no fetch events; never while a
// page keeps sending requests, 5 min at most): the new build sits "waiting".
// A navigation that then triggers the parked activation is dispatched to the
// old worker just as it is stopped, and never completes: the hung reload.
//
// This drives the REAL app/public/cyc-sw.js. 1) A storm of the app's kind of
// requests (keepalive log POSTs, routed 'network') across each swap must never
// park the new worker: the worker declares its network routes to the browser,
// so those requests never wake it. 2) A worker parked anyway (here by a storm on
// the asset route, which must reach the handler) takes over when the page asks
// it to, and a reload after that lands on the new build. 3) A path the routing
// table does not name (fix-download-lane's streamed /__cyc_dl/ downloads)
// still reaches the worker's fetch handler under the declared routes.

const SW_SRC = readFileSync(resolve(__dirname, '..', '..', 'public', 'cyc-sw.js'), 'utf8');
if (!SW_SRC.includes('__CYC_BUILD__')) {
  throw new Error('sw-activation-race: public/cyc-sw.js has no __CYC_BUILD__ placeholder to bake');
}

type File = {type: string; body: string};
const stampOf = (i: number) => String(1950000000 + i);

function distFor(i: number): Record<string, File> {
  const stamp = stampOf(i);
  const asset = `assets/app-${String(i).padStart(8, '0')}.js`;
  return {
    'index.html': {
      type: 'text/html; charset=utf-8',
      body:
        `<!doctype html><html><head><meta charset="utf-8"><title>cyc</title></head>` +
        `<body><div id="cyc-build">BUILD-${stamp}</div>` +
        `<script src="/${asset}"></script></body></html>`
    },
    [asset]: {
      type: 'text/javascript; charset=utf-8',
      body: `window.__cycBuildAsset = ${JSON.stringify(stamp)};`
    },
    'cyc-precache.json': {
      type: 'application/json; charset=utf-8',
      body: JSON.stringify({version: stamp, assets: ['index.html', asset]})
    },
    'cyc-sw.js': {
      type: 'text/javascript; charset=utf-8',
      body: SW_SRC.replace('__CYC_BUILD__', stamp)
    }
  };
}

class Host {
  current = distFor(1);
  readonly server: Server;
  origin = '';
  constructor() {
    this.server = createServer((req, res) => {
      const path = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'index.html';
      res.setHeader('Cache-Control', 'no-store');
      if (path === 'clientlog') {
        req.resume();
        setTimeout(() => res.end('ok'), 10);
        return;
      }
      const file = this.current[path];
      if (!file) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', file.type);
      res.end(file.body);
    });
  }
  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('sw-activation-race: no server port');
    this.origin = `http://127.0.0.1:${addr.port}`;
  }
  close(): Promise<void> {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

type Reg = {installing: string; waiting: string; active: string};
const regState = (page: Page): Promise<Reg> =>
  page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    const s = (w: ServiceWorker | null | undefined) => w?.state ?? 'none';
    return {
      installing: s(r?.installing),
      waiting: s(r?.waiting),
      active: r?.active?.scriptURL ?? ''
    };
  });

// Settled on build i: nothing installing or waiting, and build i's bucket
// exists (only its own complete install creates it). A parked worker stays
// "waiting" for 30 s and more; the activation itself takes milliseconds.
const settledOn = (page: Page, stamp: string) =>
  page.evaluate(async (s) => {
    const r = await navigator.serviceWorker.getRegistration();
    if (!r || r.installing || r.waiting || r.active?.state !== 'activated') return false;
    return (await caches.keys()).includes('cyc-precache-' + s);
  }, stamp);

async function bootFirst(page: Page, host: Host): Promise<void> {
  await page.goto(`${host.origin}/`, {waitUntil: 'load'});
  await page.evaluate(() => navigator.serviceWorker.register('/cyc-sw.js', {scope: '/'}));
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), {timeout: 20_000})
    .toBe(true);
}

// Deploy build i, update, and fire `count` requests every 2 ms across the swap.
async function deployWithStorm(page: Page, host: Host, i: number, path: string): Promise<void> {
  host.current = distFor(i);
  await page.evaluate((p) => {
    for (let k = 0; k < 600; k++)
      setTimeout(() => {
        const init: RequestInit =
          p === '/clientlog' ? {method: 'POST', body: 'x', keepalive: true} : {};
        void fetch(p, init).catch(() => {});
      }, k * 2);
  }, path);
  await page.evaluate(() =>
    navigator.serviceWorker
      .getRegistration()
      .then((r) => r?.update())
      .catch(() => {})
  );
}

// Park one: the asset route must reach the handler, so a storm of cached asset
// hits (answered in a millisecond, so the old worker keeps going idle) still
// races the stop. Retry the swap until one parks: still waiting well after the
// storm is over, and still waiting 8 s later (a worker merely queued behind
// the storm's last requests takes over by itself in that time; a parked one
// does not). Returns the parked build's index.
async function parkOne(page: Page, host: Host): Promise<number> {
  for (let i = 2; i <= 25; i++) {
    const asset = '/' + Object.keys(host.current).find((k) => k.startsWith('assets/'));
    await deployWithStorm(page, host, i, asset);
    await page.waitForTimeout(4000);
    if ((await regState(page)).waiting !== 'installed') continue;
    await page.waitForTimeout(8000);
    if ((await regState(page)).waiting === 'installed') return i;
  }
  throw new Error('no swap parked; the race could not be set up');
}

test("the app's request traffic across a swap never parks the new worker", async ({page}) => {
  test.setTimeout(120_000);
  const host = new Host();
  await host.listen();
  try {
    await bootFirst(page, host);
    // and the steady trickle the app's log shipping keeps up between bursts
    await page.evaluate(
      () =>
        void setInterval(
          () => void fetch('/clientlog', {method: 'POST', body: 'y', keepalive: true}),
          3000
        )
    );
    let retried = 0;
    for (let i = 2; i <= 9; i++) {
      await deployWithStorm(page, host, i, '/clientlog');
      // Until build i has taken over: a worker WAITING more than a few seconds
      // is parked (the activation itself takes milliseconds). An attempt that
      // ends with nothing installing or waiting was a failed install (600
      // requests in flight can starve the worker's own precache fetches); the
      // app's next stale check retries it, and so does this loop.
      const t0 = Date.now();
      let waitingSince = 0;
      let idleSince = 0;
      while (!(await settledOn(page, stampOf(i)))) {
        const st = await regState(page);
        const now = Date.now();
        waitingSince = st.waiting === 'installed' ? waitingSince || now : 0;
        expect(
          now - (waitingSince || now),
          `build ${stampOf(i)} was parked waiting behind a request storm (${i - 1} swap(s) in)`
        ).toBeLessThan(5_000);
        idleSince = st.installing === 'none' && st.waiting === 'none' ? idleSince || now : 0;
        if (idleSince && now - idleSince > 1_500) {
          retried++;
          idleSince = 0;
          await page.evaluate(() =>
            navigator.serviceWorker
              .getRegistration()
              .then((r) => r?.update())
              .catch(() => {})
          );
        }
        expect(now - t0, `build ${stampOf(i)} never took over`).toBeLessThan(30_000);
        await page.waitForTimeout(200);
      }
    }
    console.log(`activation-race: 8 swaps, ${retried} failed install(s) retried`);
  } finally {
    await host.close();
  }
});

test('a parked worker takes over when asked, and the reload then lands', async ({
  page,
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'only Chromium parks a skip-waiting worker');
  test.setTimeout(150_000);
  const host = new Host();
  await host.listen();
  try {
    await bootFirst(page, host);
    const parked = await parkOne(page, host);

    // The page asks the waiting worker to take over (what staleReload does).
    await page.evaluate(() =>
      navigator.serviceWorker
        .getRegistration()
        .then((r) => r?.waiting?.postMessage({t: 'skip-waiting'}))
    );
    await expect
      .poll(() => settledOn(page, stampOf(parked)), {
        timeout: 3_000,
        message: 'the parked worker did not take over when asked'
      })
      .toBe(true);

    await page.evaluate(() => location.replace('/?b=' + Date.now()));
    await expect(page.locator('#cyc-build')).toHaveText('BUILD-' + stampOf(parked), {
      timeout: 10_000
    });
  } finally {
    await host.close();
  }
});

test('a path the routing table does not name still reaches the worker (streamed downloads)', async ({
  page
}) => {
  const host = new Host();
  // The download lane's handler, added the way it extends the worker: answers
  // /__cyc_dl/ itself; every other request is left to cyc-sw.js.
  const sw = host.current['cyc-sw.js'];
  sw.body +=
    "\nself.addEventListener('fetch', (e) => {" +
    "  if (new URL(e.request.url).pathname.startsWith('/__cyc_dl/'))" +
    "    e.respondWith(new Response('FROM-WORKER'));" +
    '});\n';
  await host.listen();
  try {
    await bootFirst(page, host);
    const answer = await page.evaluate(() =>
      fetch('/__cyc_dl/abc123/report.pdf').then(async (r) => `${r.status} ${await r.text()}`)
    );
    expect(answer, 'the download went to the server, past the worker').toBe('200 FROM-WORKER');
    // And the app's constant traffic still skips it: the server answers.
    expect(
      await page.evaluate(() =>
        fetch('/clientlog', {method: 'POST', body: 'x'}).then((r) => r.text())
      )
    ).toBe('ok');
  } finally {
    await host.close();
  }
});

// A self-navigation that a parked worker holds past its few-second bound goes
// to the same URL with cyc-net=1 (shared/selfReload.ts netNavUrl), which the
// routing table sends straight to the network. A plain navigation into the parked activation hangs blank
// (9/9 in a minimal page, 2026-10-03; it fails this test on the round-3
// worker); this one boots. WebKit never parks: there it is a plain network
// boot of the same URL.
test('the escape hatch boots even with a new worker parked', async ({page, browserName}) => {
  test.setTimeout(150_000);
  const host = new Host();
  await host.listen();
  try {
    await bootFirst(page, host);
    const expected =
      browserName === 'chromium' ? 'BUILD-' + stampOf(await parkOne(page, host)) : 'BUILD-';
    await page.evaluate(() => location.replace('/?cyc-net=1&b=' + Date.now()));
    await expect(page.locator('#cyc-build')).toContainText(expected, {timeout: 10_000});
  } finally {
    await host.close();
  }
});
