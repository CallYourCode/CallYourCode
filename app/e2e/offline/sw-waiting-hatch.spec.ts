import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {startChatEngine, seedMessages, type ChatEngine} from './chatEngine';
import {captureLog, type LogCapture} from './offlineKit';
import {deploy, makeBuilds, startHost} from './deployKit';

// ONE RULE for every self-navigation (shared/selfReload.ts navigateSelf): a new
// worker still WAITING a few seconds after being asked to take over sends the
// navigation to the same URL with ?cyc-net=1, which cyc-sw.js routes straight
// to the network, never into the stuck old worker. Real app, real builds.
// A request through the old worker that never ends (deployHost's
// /assets/zz-hold-forever.js) keeps the new worker waiting in both browsers.

const NAME = 'Alpha Relay';
const PANE = 'alpha';

const builds = (log: LogCapture) => log.of('boot').map((l) => l.field('build'));

const waitingState = (page: Page) =>
  page
    .evaluate(
      async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state ?? 'none'
    )
    .catch(() => 'unknown');

async function setUp(page: Page) {
  const {dirs, stamps} = makeBuilds(1);
  const host = await startHost(dirs[0]);
  const rig: ChatEngine = await startChatEngine({
    sessions: [{id: PANE, name: NAME, messages: seedMessages(PANE, 4, 1_700_000_000_000)}]
  });
  const log = captureLog(page);
  await bootPinned(page, rig.port, {origin: host.origin, size: {width: 390, height: 844}});
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
  await page.evaluate(() => void fetch('/assets/zz-hold-forever.js').catch(() => {}));
  await page.waitForTimeout(300);
  return {dirs, stamps, host, rig, log};
}

// B is deployed and installs, but stays waiting behind the held request.
async function parkB(page: Page, origin: string, dirB: string) {
  await deploy(origin, dirB, false);
  await page.evaluate(() =>
    navigator.serviceWorker
      .getRegistration()
      .then((r) => r?.update())
      .catch(() => {})
  );
  await expect
    .poll(() => waitingState(page), {timeout: 30_000, message: 'B never installed'})
    .toBe('installed');
}

test('an update reload with the new worker waiting past the bound lands via the network', async ({
  page
}) => {
  test.setTimeout(120_000);
  const {dirs, stamps, host, rig, log} = await setUp(page);
  try {
    await parkB(page, host.origin, dirs[1]);
    // The foreground edge: the app sees B is newer and its update reload goes.
    const at = Date.now();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect
      .poll(() => log.of('reload.landed').map((l) => l.field('to')), {
        timeout: 25_000,
        message: 'the update reload was held behind the waiting worker'
      })
      .toEqual([stamps[1]]);
    expect(builds(log)).toEqual([stamps[0], stamps[1]]);
    expect(log.since('nav.held', at)[0]?.field('why')).toBe('update');
    const go = log.since('nav.go', at)[0];
    expect(go?.field('why')).toBe('update');
    expect(go?.field('viaNetwork')).toBe('true');
    // Not blank, and the marker is gone from the address.
    await page.waitForSelector('.cyc-session-entry', {timeout: 15_000});
    expect(new URL(page.url()).searchParams.has('cyc-net')).toBe(false);
  } finally {
    host.proc.kill();
    await rig.close();
  }
});

test('offline, a sign-out held by a waiting worker says so, and a second one still works', async ({
  page,
  context
}) => {
  test.setTimeout(120_000);
  const {dirs, stamps, host, rig, log} = await setUp(page);
  const signOut = () =>
    page.evaluate(
      () => void (window as unknown as {__cycSignOut: () => Promise<void>}).__cycSignOut()
    );
  try {
    await parkB(page, host.origin, dirs[1]);
    await context.setOffline(true);
    for (let i = 1; i <= 2; i++) {
      await signOut();
      await expect
        .poll(() => log.of('nav.offline').length, {
          timeout: 10_000,
          message: `sign-out ${i} offline failed silently`
        })
        .toBe(i);
      await expect(page.getByText("You're offline").first()).toBeVisible();
      expect(builds(log), 'the page navigated offline').toEqual([stamps[0]]);
    }
    // Back online, the sign-out still pending goes, on the online edge or the
    // next tap, whichever is first (via the network if B still waits; going
    // offline may have ended the held request, and then B took over and it
    // goes the normal way).
    await context.setOffline(false);
    const at = Date.now();
    await signOut().catch(() => {}); // the online edge may already have navigated
    await expect
      .poll(() => builds(log).length, {timeout: 15_000, message: 'the online sign-out never went'})
      .toBe(2);
    expect(log.since('nav.go', at)[0]?.field('why')).toBe('sign-out');
    expect(new URL(page.url()).pathname).toBe('/');
  } finally {
    await context.setOffline(false);
    host.proc.kill();
    await rig.close();
  }
});

// The update and missing-chunk reloads kept their own one-time flags, so once
// the gate stood down offline ("You're offline") they never came back in that
// page's life: stuck on the old build until a relaunch (verifier round 3). The
// gate now owns the pending navigation and decides again on the next edge.
for (const why of ['update', 'chunk-missing'] as const) {
  test(`a ${why} reload stopped offline lands once the network is back`, async ({
    page,
    context
  }) => {
    test.setTimeout(120_000);
    const {dirs, stamps, host, rig, log} = await setUp(page);
    // (the online edge may already have navigated: then this finds no page)
    const foreground = () =>
      page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))).catch(() => {});
    try {
      await parkB(page, host.origin, dirs[1]);
      if (why === 'update') await foreground();
      else
        await page.evaluate(
          () =>
            void (
              window as unknown as {__cycLazyImport: (p: string, w: string) => Promise<string>}
            ).__cycLazyImport('/assets/gone-chunk-0000.js?t=' + Date.now(), 'the probe chunk')
        );
      await expect
        .poll(() => log.of('nav.held').length, {timeout: 10_000, message: 'never held'})
        .toBeGreaterThan(0);
      // The radio drops before the hatch: the gate stops and says so.
      await context.setOffline(true);
      await expect
        .poll(() => log.of('nav.offline').length, {timeout: 15_000, message: 'no offline stop'})
        .toBeGreaterThan(0);
      expect(log.of('nav.offline')[0].field('why')).toBe(why);
      expect(builds(log)).toEqual([stamps[0]]);
      // Back online, the online edge or the next foreground lands B.
      await context.setOffline(false);
      await foreground();
      await expect
        .poll(() => builds(log), {
          timeout: 20_000,
          message: `the ${why} reload never came back after the offline stop`
        })
        .toEqual([stamps[0], stamps[1]]);
      expect(log.of('nav.go').map((l) => l.field('why'))).toEqual([why]);
      await page.waitForSelector('.cyc-session-entry', {timeout: 15_000});
    } finally {
      await context.setOffline(false);
      host.proc.kill();
      await rig.close();
    }
  });
}
