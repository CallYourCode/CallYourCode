import {test, expect, type Page} from '@playwright/test';
import {createServer, request, type IncomingMessage, type ServerResponse} from 'node:http';
import type {Socket} from 'node:net';
import {bootPinned} from './rig';
import {startChatEngine, seedMessages, type ChatEngine} from './chatEngine';
import {captureLog} from './offlineKit';
import {deploy, makeBuilds, startHost} from './deployKit';

// THE TORN DEPLOY (verifier, 2026-10-04). Build C lands while B's precache is
// in flight: B's worker read B's manifest, then fetched C's index.html. That
// shell names C's entry chunk, which no bucket holds; B installed it anyway
// and the next offline launch was blank. The install must refuse a shell of
// another build (stamp and named assets); A stays whole and the offline launch
// boots it. A proxy holds only the worker's shell fetch (cache: 'reload') until
// C is deployed.

const PANE = 'alpha';

async function shellHoldingProxy(target: string) {
  const st = {
    hold: false,
    offline: false,
    held: [] as {req: IncomingMessage; res: ServerResponse}[]
  };
  const socks = new Set<Socket>();
  const pass = (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(target);
    const up = request(
      {host: u.hostname, port: u.port, path: req.url, method: req.method, headers: req.headers},
      (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      }
    );
    up.on('error', () => req.socket.destroy());
    req.pipe(up);
  };
  const server = createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (st.offline) return void req.socket.destroy();
    const workerShell =
      (p === '/' || p === '/index.html') && req.headers['cache-control'] === 'no-cache';
    if (st.hold && workerShell) return void st.held.push({req, res});
    pass(req, res);
  });
  server.on('connection', (c) => {
    socks.add(c);
    c.on('close', () => socks.delete(c));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: 'http://127.0.0.1:' + (server.address() as {port: number}).port,
    st,
    release() {
      const h = st.held;
      st.held = [];
      st.hold = false;
      h.forEach(({req, res}) => pass(req, res));
    },
    close: () =>
      new Promise<void>((r) => {
        socks.forEach((c) => c.destroy());
        server.close(() => r());
      })
  };
}

// Every bucket that holds a shell must hold the entry chunk that shell names.
const tornBuckets = (page: Page) =>
  page.evaluate(async () => {
    const torn: string[] = [];
    for (const k of (await caches.keys()).filter((k) => k.startsWith('cyc-precache-'))) {
      const shell = await (await caches.open(k)).match('/index.html');
      if (!shell) continue;
      const entry = /assets\/index-[^"]+\.js/.exec(await shell.text())?.[0];
      if (!entry || !(await caches.match('/' + entry))) torn.push(k + ' -> ' + entry);
    }
    return torn;
  });

test('a deploy landing mid-precache never leaves a torn bucket; the offline launch boots', async ({
  page
}) => {
  test.setTimeout(120_000);
  const {dirs, stamps} = makeBuilds(2);
  const host = await startHost(dirs[0]);
  const px = await shellHoldingProxy(host.origin);
  const rig: ChatEngine = await startChatEngine({
    sessions: [{id: PANE, name: 'Alpha Relay', messages: seedMessages(PANE, 4, 1_700_000_000_000)}]
  });
  const log = captureLog(page);
  try {
    await bootPinned(page, rig.port, {origin: px.origin, size: {width: 390, height: 844}});
    await expect
      .poll(
        () =>
          page.evaluate(async (s) => {
            if (!navigator.serviceWorker.controller) return false;
            return !!(await (await caches.open('cyc-precache-' + s)).match('/index.html'));
          }, stamps[0]),
        {timeout: 30_000, message: 'build A was never precached'}
      )
      .toBe(true);

    // B deploys; its worker reads B's manifest, and its shell fetch is held...
    px.st.hold = true;
    await deploy(host.origin, dirs[1], false);
    await page.evaluate(() =>
      navigator.serviceWorker
        .getRegistration()
        .then((r) => r?.update())
        .catch(() => {})
    );
    await expect.poll(() => px.st.held.length, {timeout: 30_000}).toBeGreaterThan(0);
    // ...while C lands. The held fetch then answers with C's shell.
    await deploy(host.origin, dirs[2], false);
    px.release();
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const r = await navigator.serviceWorker.getRegistration();
            return !!r && !r.installing;
          }),
        {timeout: 30_000, message: "B's install never settled"}
      )
      .toBe(true);
    await page.waitForTimeout(1000);
    expect(await tornBuckets(page), 'a bucket holds a shell whose entry chunk is nowhere').toEqual(
      []
    );

    // The offline launch right away (no foreground in between) is not blank.
    px.st.offline = true;
    await page.goto(px.origin + '/?testhooks=1&relaunch=' + Date.now()).catch(() => {});
    await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
    expect(log.of('boot').length).toBeGreaterThanOrEqual(2);
  } finally {
    px.release();
    await px.close();
    host.proc.kill();
    await rig.close();
  }
});
