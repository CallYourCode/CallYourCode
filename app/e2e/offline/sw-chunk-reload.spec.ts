import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {startChatEngine, seedMessages, type ChatEngine} from './chatEngine';
import {captureLog, type LogCapture} from './offlineKit';
import {deploy, makeBuilds, startHost} from './deployKit';

// EVERY SELF-NAVIGATION THROUGH THE ONE GATE (shared/selfReload.ts navigateSelf),
// proven on its representative: the missing-chunk reload (shared/lazy.ts).
// In Chromium a navigation that triggers a parked worker activation (a request
// restarted the old worker mid-swap) is dispatched to the old worker as it is
// stopped and never completes: the page hangs blank (2026-10-03). A missing
// chunk is exactly when that happens: a deploy is landing. Before the gate the
// missing-chunk reload went straight to location.reload(); through the gate it
// waits, asks the parked worker to take over, and lands on the new build.
//
// Real app, real builds, served by deployHost.ts (the app server's static
// answer). The import is a real dynamic import of a chunk that is gone, through
// lazy() (the ?testhooks=1 __cycLazyImport hook).

const NAME = 'Alpha Relay';
const PANE = 'alpha';
const GONE = '/assets/gone-chunk-0000.js';

const builds = (log: LogCapture) => log.of('boot').map((l) => l.field('build'));

const regState = (page: Page) =>
  page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    const s = (w: ServiceWorker | null | undefined) => w?.state ?? 'none';
    return {installing: s(r?.installing), waiting: s(r?.waiting), active: s(r?.active)};
  });

const cachedOwn = (page: Page, stamp: string) =>
  page.evaluate(async (s) => {
    if (!navigator.serviceWorker.controller) return false;
    const c = await caches.open('cyc-precache-' + s);
    return !!(await c.match('/index.html'));
  }, stamp);

async function bootApp(page: Page, origin: string, port: number, stamp: string): Promise<void> {
  await bootPinned(page, port, {origin, size: {width: 390, height: 844}});
  await expect
    .poll(() => cachedOwn(page, stamp), {timeout: 30_000, message: 'build A was never precached'})
    .toBe(true);
}

// Trigger the missing chunk; resolves when lazy() has rejected (the reload is
// then the gate's business).
const missingChunk = (page: Page) =>
  page.evaluate((p) => {
    const w = window as unknown as {__cycLazyImport: (p: string, w: string) => Promise<string>};
    return w.__cycLazyImport(p + '?t=' + Date.now(), 'the probe chunk');
  }, GONE);

test('a missing chunk with no update in flight reloads at once', async ({page}) => {
  test.setTimeout(90_000);
  const {dirs, stamps} = makeBuilds(0);
  const host = await startHost(dirs[0]);
  const rig: ChatEngine = await startChatEngine({
    sessions: [{id: PANE, name: NAME, messages: seedMessages(PANE, 4, 1_700_000_000_000)}]
  });
  const log = captureLog(page);
  try {
    await bootApp(page, host.origin, rig.port, stamps[0]);
    expect(await missingChunk(page)).toContain('failed');
    await expect.poll(() => builds(log).length, {timeout: 15_000}).toBe(2);
    expect(log.of('nav.go')[0]?.field('why')).toBe('chunk-missing');
    expect(log.of('nav.held')).toEqual([]);
    await page.waitForSelector('.cyc-session-entry', {timeout: 15_000});
  } finally {
    host.proc.kill();
    await rig.close();
  }
});

test('a missing chunk while the new worker is parked waits, asks it to take over, and lands', async ({
  page,
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'only Chromium parks a skip-waiting worker');
  test.setTimeout(170_000);
  const N = 12;
  const {dirs, stamps} = makeBuilds(N);
  const host = await startHost(dirs[0]);
  const rig: ChatEngine = await startChatEngine({
    sessions: [{id: PANE, name: NAME, messages: seedMessages(PANE, 4, 1_700_000_000_000)}]
  });
  const log = captureLog(page);
  try {
    await bootApp(page, host.origin, rig.port, stamps[0]);

    // Park a build: deploy it and, across its swap, a storm of cached asset hits
    // (the asset route must reach the worker, so it still races the stop). A
    // swap that does not park lands by itself (the app's own controllerchange
    // reload); take the next build. Parked = still waiting 8 s on.
    let parked = 0;
    for (let k = 1; k <= N && !parked; k++) {
      await deploy(host.origin, dirs[k], false);
      await page.evaluate(() => {
        for (let i = 0; i < 1500; i++)
          setTimeout(
            () => void fetch('/assets/fonts/cyc-term-symbols.woff2').catch(() => {}),
            i * 2
          );
        void navigator.serviceWorker
          .getRegistration()
          .then((r) => r?.update())
          .catch(() => {});
      });
      await page.waitForTimeout(4000);
      if ((await regState(page)).waiting === 'installed') {
        await page.waitForTimeout(8000);
        if ((await regState(page)).waiting === 'installed') {
          parked = k;
          break;
        }
      }
      // Not parked: let the app land the build before the next deploy. An
      // install the storm starved failed outright (nothing installing or
      // waiting); the app's next stale check would retry it, so does this.
      await expect
        .poll(
          async () => {
            const last = builds(log).pop();
            if (last === stamps[k]) return last;
            const st = await regState(page).catch(() => null);
            if (st && st.installing === 'none' && st.waiting === 'none')
              await page
                .evaluate(() =>
                  navigator.serviceWorker
                    .getRegistration()
                    .then((r) => r?.update())
                    .catch(() => {})
                )
                .catch(() => {});
            return last;
          },
          {timeout: 30_000, intervals: [1000], message: `build ${stamps[k]} never landed`}
        )
        .toBe(stamps[k]);
      await expect.poll(() => cachedOwn(page, stamps[k]), {timeout: 20_000}).toBe(true);
    }
    expect(parked, 'no swap parked; the race could not be set up').toBeGreaterThan(0);
    const before = builds(log).length;
    const own = builds(log).pop();

    // A missing chunk now. The reload must not navigate into the parked
    // activation (it would hang): it waits, asks, and lands on the parked build.
    const at = Date.now();
    expect(await missingChunk(page)).toContain('failed');
    await expect
      .poll(() => builds(log).length, {
        timeout: 20_000,
        message: `the missing-chunk reload never landed (hung?) on ${own} -> ${stamps[parked]}`
      })
      .toBe(before + 1);
    expect(builds(log).pop()).toBe(stamps[parked]);
    // The page that landed is the missing-chunk reload's own. Before the gate
    // that navigation hung: it triggered the parked activation, was dispatched
    // to the old worker as it was stopped and never committed, and the page
    // only moved because the app's update reload (after the controllerchange
    // it caused) superseded it 1.2 s later. Without that rescue (no newer
    // build.txt, or a page that is not stale) it stays hung, as in
    // sw-activation-race.
    const went = log.since('nav.go', at).map((l) => l.field('why'));
    expect(went, 'the missing-chunk reload did not land; something else moved the page').toEqual([
      'chunk-missing'
    ]);
    expect(log.since('reload.go', at)).toEqual([]);
    const held = log.since('nav.held', at)[0];
    expect(held?.field('why')).toBe('chunk-missing');
    expect(held?.field('hold')).toBe('sw-waiting');
    // Not a blank page: the app is up on the new build.
    await page.waitForSelector('.cyc-session-entry', {timeout: 15_000});
    expect(await regState(page)).toMatchObject({installing: 'none', waiting: 'none'});
  } catch (e) {
    const re = /^(boot|sw\.|build\.|reload\.|nav\.|chunk\.)/;
    console.log(
      ['UPDATE TRAIL', ...log.lines.filter((l) => re.test(l.event)).map((l) => l.raw)].join('\n')
    );
    throw e;
  } finally {
    host.proc.kill();
    await rig.close();
  }
});
