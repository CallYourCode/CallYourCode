import {test, expect, type Page} from '@playwright/test';
import {bootIsolated, reloadIsolated} from './rig';

// The payoff of registering the precache worker at boot (src/swBoot.ts): once a
// warm load has primed the worker's cache with the app shell + every hashed
// chunk this build produced, the app cold-starts with the network fully cut.
//
// Every other offline spec cuts only the *engine* (the websocket) and reloads
// while the static host is still reachable, because that is all the offline-first
// data model needs. This spec cuts the static host too, which only the service
// worker can survive, so it is the direct end-to-end proof that boot registration
// (not just the push path) is what makes the shell itself offline-capable. The
// fetch handler's routing is unit-proven in src/tests/cycSwPrecache.test.ts; this
// proves the whole thing wired together in a real browser.

test.skip(({browserName}) => browserName !== 'chromium', 'service worker is chromium-only here');

// The worker installs on the load event and its precache addAll runs in the
// background, so a reload must not race it: poll until the worker controls the
// page and its cache holds the shell + every hashed asset the manifest names.
async function cacheWarm(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          if (!navigator.serviceWorker.controller) return false;
          const names = (await caches.keys()).filter((n) => n.startsWith('cyc-precache-'));
          if (!names.length) return false;
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
        }),
      {timeout: 30_000, message: 'the precache worker never finished warming its cache'}
    )
    .toBe(true);
}

test('cold boot with the network cut: the shell + chunks load from the precache worker', async ({
  page
}) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`));

  // WARM: a normal boot registers the worker and lets it precache the build.
  await bootIsolated(page, 1280, 900);
  await cacheWarm(page);

  // CUT THE NETWORK entirely (the static host, not just the engine) and reload:
  // the only way this shell + its lazy chunks can load now is from the worker.
  await page.context().setOffline(true);

  // Prove the cut is real: a request the worker does not answer (build.txt is a
  // pass-through) fails outright while offline.
  const netCut = await page.evaluate(() =>
    fetch('/build.txt', {cache: 'no-store'}).then(
      () => false,
      () => true
    )
  );
  expect(netCut, 'the browser context was not actually offline').toBe(true);

  await reloadIsolated(page);

  // The app booted from cache: the fixture roster painted and nothing threw.
  expect(await page.locator('.cyc-session-entry').count()).toBeGreaterThan(0);
  expect(await page.locator('.cyc-composer, [class*="composer"]').count()).toBeGreaterThan(0);
  expect(
    pageErrors,
    `uncaught exception(s) during the offline cold boot:\n${pageErrors.join('\n---\n')}`
  ).toEqual([]);

  await page.context().setOffline(false);
});
