import {test, expect, type Page} from '@playwright/test';
import {installIsolation} from '../offline/rig';
import {startGateEngine, type GateEngine} from './gaterig';
const PAGE = process.env.CYC_PAGE?.replace(/\/$/, '');
if (!PAGE)
  throw new Error(
    'the gate needs CYC_PAGE pointing at a scratch real app server; use scripts/happy-gate.mjs'
  );
if (/:(10100|8151|8443|10101|10102|7790)\b/.test(PAGE)) {
  throw new Error(
    `CYC_PAGE=${PAGE} is a live or offline-rig port; the gate runs only against its own scratch app server`
  );
}
const PHONE = {width: 390, height: 844};
const LAPTOP = {width: 1280, height: 900};
const SCROLLER = '.cyc-message-list-scroll';

async function boot(page: Page, port: number, size = PHONE, init?: (p: Page) => Promise<unknown>) {
  await page.setViewportSize(size);
  await installIsolation(page);
  if (init) await init(page);
  const pin = encodeURIComponent(`ws://127.0.0.1:${port}/ws`);
  await page.goto(`${PAGE}/index.html?engine=${pin}&testhooks=1&v=${Date.now()}#app`);
  await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
  await page.evaluate(() => (document as {fonts?: {ready: Promise<unknown>}}).fonts?.ready);
}

const tapRow = (page: Page, name: string) =>
  page.locator('.cyc-session-entry', {hasText: name}).first().click();

const activeId = (page: Page) =>
  page.evaluate(() => (localStorage.getItem('cyc-engaged') ?? '').split('|').pop() || null);
const scrollTop = (page: Page) =>
  page.evaluate(
    (sel) => Math.round((document.querySelector(sel) as HTMLElement)?.scrollTop ?? -1),
    SCROLLER
  );

async function settle(page: Page, timeout = 6000, quiet = 800): Promise<number> {
  const t0 = Date.now();
  let last = await scrollTop(page);
  let calm = Date.now();
  while (Date.now() - t0 < timeout) {
    await page.waitForTimeout(150);
    const t = await scrollTop(page);
    if (Math.abs(t - last) > 1) {
      last = t;
      calm = Date.now();
    } else if (Date.now() - calm >= quiet) return t;
  }
  return last;
}

async function expectStill(page: Page, holdMs: number, what: string) {
  const before = await scrollTop(page);
  await page.waitForTimeout(holdMs);
  const after = await scrollTop(page);
  expect(
    Math.abs(after - before),
    `${what}: the view moved ${after - before}px on its own after the landing settled`
  ).toBeLessThanOrEqual(2);
}
let engine: GateEngine;
test.afterEach(async () => {
  await engine?.close();
});

test('J1 open-with-unread lands at the divider and holds still', async ({page}) => {
  engine = await startGateEngine([{id: 'metrics', seed: 60, unread: 8}]);
  await boot(page, engine.port);
  await tapRow(page, 'metrics');
  await page.waitForSelector(SCROLLER, {timeout: 10_000});
  await settle(page);
  const divider = page.locator('.cyc-message-list-inner .cyc-first-unread').first();
  await expect(divider, 'no first-unread divider after opening a chat with 8 unread').toBeVisible();
  const box = await divider.boundingBox();
  expect(box, 'the divider has no box').toBeTruthy();
  expect(box!.y, 'the divider landed under the top bar').toBeGreaterThan(40);
  expect(
    box!.y,
    'the divider landed in the lower half: the unread run starts off screen'
  ).toBeLessThan(PHONE.height * 0.6);
  await expectStill(page, 1500, 'J1');
});

test('J2 a queued send clears on dequeue and the reply renders once', async ({page}) => {
  engine = await startGateEngine([
    {id: 'relay', seed: 10, unread: 0, status: 'working', busy: true}
  ]);
  await boot(page, engine.port);
  await tapRow(page, 'relay');
  await page.waitForSelector(SCROLLER, {timeout: 10_000});
  await settle(page);
  await page.locator('.cyc-composer-input').first().click();
  await page.keyboard.type('gate probe: are you there');
  await page.keyboard.press('Enter');
  const strip = page.locator('.cyc-message.cyc-first-queued');
  await expect(strip.first(), 'the sent message never showed the queued strip').toBeVisible({
    timeout: 5000
  });
  expect(await strip.count(), 'two queued strips at once, the never-two rule').toBeLessThanOrEqual(
    1
  );
  engine.dequeue('relay');
  engine.reply('relay', 'GATE-REPLY-ONE');
  await expect(
    page.locator('.cyc-message', {hasText: 'GATE-REPLY-ONE'}).first(),
    'the reply never rendered'
  ).toBeVisible({timeout: 5000});
  await expect
    .poll(() => strip.count(), {
      timeout: 5000,
      message:
        'the queued strip survived the dequeue; a strip above a newer reply is an impossible state'
    })
    .toBe(0);
  expect(
    await page.locator('.cyc-message', {hasText: 'GATE-REPLY-ONE'}).count(),
    'the reply rendered more than once'
  ).toBe(1);
});

test('J3 a settings write survives a reload, against the real app server', async ({page}) => {
  engine = await startGateEngine([{id: 'metrics', seed: 6, unread: 0}]);
  await boot(page, engine.port);
  const openSettings = async () => {
    await page.locator('.cyc-pane-header button').first().click();
    await page.waitForTimeout(400);
    const item = page.locator('.cyc-menu-item', {hasText: 'Settings'});
    if (await item.count()) {
      await item.first().click();
      await page.waitForTimeout(800);
    }
  };
  await openSettings();
  const input = page.locator('input[aria-label="Autoplay"]');
  await expect(input, 'no Autoplay switch in Settings').toHaveCount(1);

  const ctl = await input.evaluate((e) => {
    const r = (e.parentElement ?? e).getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height};
  });
  expect(ctl.w, 'the Autoplay control paints at zero width').toBeGreaterThan(14);
  expect(ctl.h, 'the Autoplay control paints at zero height').toBeGreaterThan(10);
  expect(
    ctl.x >= 0 && ctl.y >= 0 && ctl.x + ctl.w <= PHONE.width,
    `the Autoplay control sits outside the viewport at ${JSON.stringify(ctl)}`
  ).toBe(true);
  const before = await input.evaluate((e) => (e as HTMLInputElement).checked);
  const wrote = page.waitForResponse(
    (r) => r.url().includes('/settings') && r.request().method() === 'POST' && r.ok(),
    {timeout: 5000}
  );
  await page.locator('.cyc-list-row').filter({has: input}).click();
  await wrote;

  const pin = encodeURIComponent(`ws://127.0.0.1:${engine.port}/ws`);
  await page.goto(`${PAGE}/index.html?engine=${pin}&testhooks=1&v=${Date.now()}#app`);
  await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
  await openSettings();
  const after = await page
    .locator('input[aria-label="Autoplay"]')
    .evaluate((e) => (e as HTMLInputElement).checked);
  expect(after, 'the settings write did not survive the reload').toBe(!before);
});

test('J4 one tap moves between sessions and the landing holds', async ({page}) => {
  engine = await startGateEngine([
    {id: 'metrics', seed: 40, unread: 0},
    {id: 'scraper', seed: 40, unread: 3}
  ]);
  await boot(page, engine.port, LAPTOP);
  await tapRow(page, 'metrics');
  await page.waitForSelector(SCROLLER, {timeout: 10_000});
  await settle(page);
  await tapRow(page, 'scraper');
  await expect
    .poll(() => activeId(page), {
      timeout: 1500,
      message: 'the first tap on the second session did not open it'
    })
    .toBe('scraper');
  await settle(page);
  await expect(
    page.locator('.cyc-message-list-inner .cyc-first-unread').first(),
    'no divider after switching into a session with 3 unread'
  ).toBeVisible();
  await expectStill(page, 1500, 'J4');
});

test('J5 the next-agent jump lands on the blocked session cleanly', async ({page}) => {
  engine = await startGateEngine([
    {id: 'quiet-one', seed: 20, unread: 0, status: 'done'},
    {id: 'stuck-one', seed: 30, unread: 2, status: 'blocked'}
  ]);
  await boot(page, engine.port, LAPTOP, (p) =>
    p.addInitScript(() =>
      localStorage.setItem('cyc-keymap', JSON.stringify({nextWaiting: 'Ctrl+Shift+W'}))
    )
  );
  await tapRow(page, 'quiet-one');
  await page.waitForSelector(SCROLLER, {timeout: 10_000});
  await settle(page);
  await page.keyboard.press('Control+Shift+KeyW');
  await expect
    .poll(() => activeId(page), {
      timeout: 1500,
      message: 'the next-agent chord did not focus the blocked session'
    })
    .toBe('stuck-one');
  await settle(page);
  await expectStill(page, 1500, 'J5');
});
