import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {startChatEngine, seedMessages, type ChatEngine} from './chatEngine';
import {captureLog, openChat, type LogCapture} from './offlineKit';
import {deploy, makeDists, startHost} from './deployKit';

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
// The network recovers and ONE more foreground installs and activates B. The
// reload onto B never comes mid-typing: it waits while the box holds the draft
// (well past the old 45 s patience), and lands the moment the app goes to the
// background, or the box is emptied. No black screen, the chat and its draft
// intact, reload.landed naming A -> B.
// Then a relaunch with the origin gone still boots B from the precache.

const NAME = 'Alpha Relay';
const PANE = 'alpha';
const DRAFT = 'this draft survives the update';
const INPUT = '#cyc-thread-pane .cyc-composer-input';

// What the app does when the user brings it back: the visibility edge.
const foreground = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

const settledUpdate = (page: Page) =>
  page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!reg && !reg.installing && !reg.waiting;
  });

// The app going to the background. Playwright cannot hide a page, so the
// document reports hidden and the edge fires, which is all the app reads.
const background = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  });

// B's worker took over (not merely installed): nothing installing or waiting,
// and B's bucket holds the shell.
const onB = (page: Page, stampB: string) =>
  page.evaluate(async (stamp) => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || reg.installing || reg.waiting || reg.active?.state !== 'activated') return false;
    const c = await caches.open('cyc-precache-' + stamp);
    return !!(await c.match('/index.html'));
  }, stampB);

const builds = (log: LogCapture) => log.of('boot').map((l) => l.field('build'));

type Rig = {
  a: string;
  b: string;
  stampA: string;
  stampB: string;
  host: Awaited<ReturnType<typeof startHost>>;
  rig: ChatEngine;
  log: LogCapture;
};

// Build A boots live, its worker precaches A, and the user has a draft open.
async function warmWithDraft(page: Page): Promise<Rig> {
  const {a, b, stampA, stampB} = makeDists();
  const host = await startHost(a);
  const rig = await startChatEngine({
    sessions: [{id: PANE, name: NAME, messages: seedMessages(PANE, 6, 1_700_000_000_000)}]
  });
  const log = captureLog(page);
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
  await openChat(page, NAME);
  await page.locator(INPUT).click();
  await page.keyboard.type(DRAFT);
  return {a, b, stampA, stampB, host, rig, log};
}

async function landedOnB(page: Page, r: Rig): Promise<void> {
  await expect
    .poll(() => r.log.of('reload.landed').map((l) => l.field('to')), {
      timeout: 20_000,
      message: `the held reload never landed build B (boots: ${builds(r.log).join(',')})`
    })
    .toEqual([r.stampB]);
  expect(builds(r.log)).toEqual([r.stampA, r.stampB]);
  const landed = r.log.of('reload.landed')[0];
  expect(landed.field('from')).toBe(r.stampA);
  expect(Number(landed.field('gap')), 'the reload sat on a blank page').toBeLessThan(5_000);
  // Not a black screen: the chat is back.
  await page.waitForSelector('.cyc-message-list-scroll', {timeout: 15_000});
}

async function teardown(r: Rig | undefined): Promise<void> {
  if (!r) return;
  r.host.proc.kill();
  await r.rig.close();
}

// On failure: what the app logged across the update (as app.log would show it)
// and where the worker registration stands.
async function trail(page: Page, r: Rig | undefined): Promise<void> {
  if (!r) return;
  const re = /^(boot|sw\.|build\.|reload\.)/;
  const reg = await Promise.race([
    page
      .evaluate(async () => {
        const g = await navigator.serviceWorker.getRegistration();
        const s = (w: ServiceWorker | null | undefined) => w?.state ?? 'none';
        return `installing=${s(g?.installing)} waiting=${s(g?.waiting)} active=${s(g?.active)} controlled=${!!navigator.serviceWorker.controller} keys=${(await caches.keys()).join(',')}`;
      })
      .catch((e: unknown) => 'unreadable: ' + String(e)),
    new Promise<string>((ok) => setTimeout(() => ok('page wedged'), 3000))
  ]);
  console.log(
    [
      'UPDATE TRAIL',
      ...r.log.lines.filter((l) => re.test(l.event)).map((l) => l.raw),
      'REG ' + reg
    ].join('\n')
  );
}

test('a deploy whose first precache dies installs on one foreground; the reload waits out the draft and lands in the background', async ({
  page
}) => {
  test.setTimeout(170_000);
  let r: Rig | undefined;
  try {
    r = await warmWithDraft(page);
    const {b, stampA, stampB, host, log} = r;

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
    expect(log.of('build.behind')[0]?.field('served')).toBe(stampB);

    // The network recovers. ONE foreground installs B and B takes over.
    await deploy(host.origin, b, false);
    await foreground(page);
    await expect
      .poll(() => onB(page, stampB), {timeout: 30_000, message: "B's worker never took over"})
      .toBe(true);

    // Never mid-typing: the draft holds the reload past the old 45 s patience.
    await expect
      .poll(() => Math.max(0, ...log.of('reload.deferred').map((l) => Number(l.field('waited')))), {
        timeout: 70_000,
        intervals: [1000],
        message: 'the reload was never held by the draft'
      })
      .toBeGreaterThanOrEqual(46_000);
    expect(log.of('reload.deferred').pop()?.field('hold')).toBe('draft');
    expect(builds(log), 'the reload came while the user was typing').toEqual([stampA]);
    await expect(page.locator(INPUT)).toHaveText(DRAFT);

    // The app goes to the background: the reload lands B there, draft intact.
    await background(page);
    await landedOnB(page, r);
    expect(log.of('reload.go')[0]?.field('hidden')).toBe('true');
    expect(log.of('reload.landed')[0]?.field('hidden')).toBe('true');
    await expect(page.locator(INPUT)).toHaveText(DRAFT, {timeout: 10_000});

    // Offline start: the origin is gone, a relaunch boots B from the precache.
    host.proc.kill();
    await new Promise((x) => host.proc.once('exit', x));
    await page.goto(`${host.origin}/?testhooks=1&relaunch=1`);
    await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
    expect(builds(log).pop()).toBe(stampB);
  } catch (e) {
    await trail(page, r);
    throw e;
  } finally {
    await teardown(r);
  }
});

test('a reload held by a draft lands as soon as the box is emptied', async ({page}) => {
  test.setTimeout(120_000);
  let r: Rig | undefined;
  try {
    r = await warmWithDraft(page);
    const {b, stampA, stampB, host, log} = r;
    await deploy(host.origin, b, false);
    await foreground(page);
    await expect
      .poll(() => onB(page, stampB), {timeout: 30_000, message: "B's worker never took over"})
      .toBe(true);
    // Held while the draft is there.
    await expect.poll(() => log.of('reload.deferred').length, {timeout: 20_000}).toBeGreaterThan(0);
    expect(builds(log)).toEqual([stampA]);

    // The user empties the box: the reload follows on the next tick.
    await page.locator(INPUT).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await expect(page.locator(INPUT)).toHaveText('');
    await landedOnB(page, r);
    expect(log.of('reload.go')[0]?.field('hidden')).toBe('false');
  } catch (e) {
    await trail(page, r);
    throw e;
  } finally {
    await teardown(r);
  }
});
