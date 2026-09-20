import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {startChatEngine, seedMessages, type ChatEngine} from './chatEngine';
import {LAYOUTS, backToList, comeBack, goOffline, openChat, row, waitLive} from './offlineKit';

// Offline design v2, section 10, test 5: a rename, a reorder and a mark-unread
// made offline apply at once in the list, survive a reload, and reach the
// engine as POSTs when it returns; the engine's next sessions frame keeps
// them. Phone drives the row menu and the drag with real touch input.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');
test.use({hasTouch: true});

const A = 'alpha';
const B = 'bravo';
const C = 'charlie';
const NAME: Record<string, string> = {
  [A]: 'Alpha Relay',
  [B]: 'Bravo Metrics',
  [C]: 'Charlie Scraper'
};
const RENAMED = 'Alpha Renamed';
const BASE = 1_700_000_000_000;

function rig(): Promise<ChatEngine> {
  return startChatEngine({
    sessions: [A, B, C].map((id, i) => ({
      id,
      name: NAME[id],
      messages: seedMessages(id, 5, BASE + i * 1_000_000)
    }))
  });
}

const names = (page: Page) =>
  page.$$eval('.cyc-session-entry .cyc-who', (els) => els.map((e) => e.textContent ?? ''));

const unreadBadge = (page: Page, name: string) =>
  row(page, name).locator('.cyc-session-badge-unread');

// The row menu: right-click on desktop, press-and-hold on touch (past the
// 500 ms lift timer and the 600 ms menu window, without moving).
async function menuItem(page: Page, name: string, item: string, touch: boolean) {
  const r = row(page, name);
  if (touch) {
    const box = await r.boundingBox();
    if (!box) throw new Error('no row box for ' + name);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    await page.waitForTimeout(1250);
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await cdp.detach();
  } else {
    await r.click({button: 'right'});
  }
  const it = page.locator('.cyc-menu-item', {hasText: item}).first();
  await it.waitFor({state: 'visible'});
  await page.waitForTimeout(200);
  await it.click();
}

async function center(page: Page, name: string, frac = 0.5): Promise<{x: number; y: number}> {
  const box = await row(page, name).boundingBox();
  if (!box) throw new Error('no row box for ' + name);
  return {x: box.x + box.width / 2, y: box.y + box.height * frac};
}

// Drag the first row to the bottom (list-reorder.spec.ts drives the same input).
async function dragToBottom(page: Page, name: string, below: string, touch: boolean) {
  const start = await center(page, name);
  const drop = await center(page, below, 0.8);
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    const t = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{x: x!, y: y!}]
      });
    await t('touchStart', start.x, start.y);
    await page.waitForTimeout(600);
    for (const y of [start.y + 20, (start.y + drop.y) / 2, drop.y - 10, drop.y]) {
      await t('touchMove', start.x, y);
      await page.waitForTimeout(60);
    }
    await t('touchEnd');
    await cdp.detach();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + 15, {steps: 4});
    await page.mouse.move(drop.x, (start.y + drop.y) / 2, {steps: 6});
    await page.mouse.move(drop.x, drop.y, {steps: 6});
    await page.mouse.up();
  }
}

for (const {layout, size} of LAYOUTS) {
  const touch = layout === 'phone';

  test(`5 rename, reorder and mark-unread offline apply, survive a reload, reach the engine (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const engine = await rig();
    try {
      // Manual arrangement is gated on sort-by-latest being off.
      await page.addInitScript(() => localStorage.setItem('cyc-sort-by-latest', '0'));
      await bootPinned(page, engine.port, {size});
      await openChat(page, NAME[A]);
      await backToList(page, layout);
      await expect.poll(() => names(page)).toEqual([NAME[A], NAME[B], NAME[C]]);

      await goOffline(page, engine);
      await expect.poll(() => names(page)).toEqual([NAME[A], NAME[B], NAME[C]]);

      // Reorder: A to the bottom.
      await dragToBottom(page, NAME[A], NAME[C], touch);
      await expect.poll(() => names(page), {timeout: 10_000}).toEqual([NAME[B], NAME[C], NAME[A]]);

      // Rename A (the menu asks through window.prompt).
      page.once('dialog', (d) => void d.accept(RENAMED));
      await menuItem(page, NAME[A], 'Rename', touch);
      await expect.poll(() => names(page), {timeout: 10_000}).toEqual([NAME[B], NAME[C], RENAMED]);

      // Mark B unread.
      await expect(unreadBadge(page, NAME[B])).toHaveCount(0);
      await menuItem(page, NAME[B], 'Mark as unread', touch);
      await expect(unreadBadge(page, NAME[B])).toBeVisible({timeout: 10_000});
      expect(engine.posts).toHaveLength(0);

      // Reload with the engine still gone: every change is in the roster.
      // (The shell needs the network to load, Lane C, so the browser comes
      // back online for the reload; the engine is what stays away.)
      await page.context().setOffline(false);
      await page.reload();
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      await expect.poll(() => names(page), {timeout: 10_000}).toEqual([NAME[B], NAME[C], RENAMED]);
      await expect(unreadBadge(page, NAME[B])).toBeVisible({timeout: 10_000});
      expect(engine.posts).toHaveLength(0);

      // The engine returns: the drain POSTs all three, the frame keeps them.
      await comeBack(page, engine);
      await expect
        .poll(() => engine.posts.length, {
          timeout: 20_000,
          message: 'the drain never posted the three intents'
        })
        .toBe(3);
      const byPath = Object.fromEntries(engine.posts.map((p) => [p.path, p.body]));
      expect(byPath['/sessions/order']).toEqual({order: [B, C, A]});
      expect(byPath['/session/alpha/rename']).toEqual({name: RENAMED});
      expect(byPath['/session/bravo/unread']).toEqual({read: false});
      expect(engine.orderOf()).toEqual([B, C, A]);
      expect(engine.nameOf(A)).toBe(RENAMED);
      expect(engine.unreadOf(B)).toBe(1);

      await waitLive(page);
      engine.broadcastSessions();
      await page.waitForTimeout(1000);
      expect(await names(page)).toEqual([NAME[B], NAME[C], RENAMED]);
      await expect(unreadBadge(page, NAME[B])).toHaveText('1');
    } finally {
      await engine.close();
    }
  });
}
