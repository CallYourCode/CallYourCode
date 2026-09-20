import {test, expect, type Page} from '@playwright/test';
import {bootPinned, evidenceShot} from './rig';
import {startChatEngine, seedEvents, seedMessages, type ChatEngine} from './chatEngine';
import {
  LAYOUTS,
  backToList,
  captureLog,
  comeBack,
  domMessageCount,
  goOffline,
  heldMessages,
  intentRows,
  openChat,
  pageBack,
  pixelDiff,
  row,
  sidOf,
  syncStatus,
  toastCount,
  typeAndSend,
  waitLive
} from './offlineKit';

// Offline design v2, section 10, tests 1 to 4, 6 to 9 and 11: the app offline
// looks and behaves like the app online. Every test warms the cache against
// the chat rig (open a chat, page back once, the session log lands), then
// loses the engine and the network, reloads, and asserts from the cache; the
// engine's return is the drain's proof.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const A = 'alpha';
const B = 'bravo';
const C = 'charlie';
const NAME: Record<string, string> = {
  [A]: 'Alpha Relay',
  [B]: 'Bravo Sixty',
  [C]: 'Charlie Scraper'
};
const BASE = 1_700_000_000_000;
const SHOT_DIR = 'offline-normal';

// The unread marker of B sits before message 40 (heardTs at message 40, so
// the 20 after it are unread); the rig does not move it on `heard`.
const bMsgs = () => seedMessages(B, 60, BASE + 1_000_000);
const cMsgs = () => seedMessages(C, 5, BASE + 2_000_000);

function rig(port?: number): Promise<ChatEngine> {
  return startChatEngine({
    port,
    trackHeard: false,
    sessions: [
      {
        id: A,
        name: NAME[A],
        messages: seedMessages(A, 150, BASE),
        events: seedEvents(A, 10, BASE),
        contextPct: 42
      },
      {id: B, name: NAME[B], messages: bMsgs(), heardTs: bMsgs()[39].ts},
      {id: C, name: NAME[C], messages: cMsgs(), heardTs: cMsgs()[1].ts}
    ]
  });
}

const sessionEvents = (page: Page) => page.locator('.cyc-message.cyc-session-event').count();

// Warm: open A, page back once (page 0 of A joins the cache), the session log
// lands, then back to the list on the phone.
async function warm(page: Page, port: number, layout: string): Promise<void> {
  await openChat(page, NAME[A]);
  await expect
    .poll(() => heldMessages(page, sidOf(port, A)).then((m) => m.length), {timeout: 15_000})
    .toBe(50);
  await pageBack(page, sidOf(port, A), 150);
  await expect.poll(() => sessionEvents(page), {timeout: 15_000}).toBe(10);
  await backToList(page, layout);
}

type RowShape = {name: string; badges: string[]; avatars: string[]};
const rowShapes = (page: Page): Promise<RowShape[]> =>
  page.$$eval('.cyc-session-entry', (els) =>
    els.map((e) => ({
      name: e.querySelector('.cyc-who')?.textContent ?? '',
      badges: [...e.querySelectorAll('.cyc-session-badge')].map((b) => b.textContent ?? ''),
      avatars: [...e.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '')
    }))
  );

// The header itself (search bar width, the sync-status strip) is expected to
// differ online vs offline by design now, and its height change pushes the
// row list down with it; a whole-list screenshot would pick up both a
// legitimate header change and the accumulated subpixel rounding of several
// rows' heights summed together, so compare each row's OWN screenshot
// instead: it is not itself resized by the header, only relocated.
type RowSize = {width: number; height: number};

// A row's true CSS height does not change between online and offline (only its
// on-page Y does, by the status bar's height), but Chrome rounds an
// auto-clipped element screenshot's edges to the pixel grid independently
// each time, so the SAME row can come back 1px taller or shorter depending on
// the fractional part of its current Y. Pin width/height to the sizes from the
// first (online) capture and reuse them for the second so the two images are
// always directly comparable.
const rowShots = async (
  page: Page,
  sizes?: RowSize[]
): Promise<{shots: Buffer[]; sizes: RowSize[]}> => {
  await page.evaluate(() => document.fonts.ready);
  // `backToList`'s pane-back click only waits for the view's data-attribute,
  // not for its slide transition to finish; boundingBox() (unlike
  // locator.screenshot()) does not wait for a stable box on its own.
  await page.waitForTimeout(350);
  const rows = page.locator('.cyc-session-entry');
  const n = await rows.count();
  const shots: Buffer[] = [];
  const outSizes: RowSize[] = [];
  for (let i = 0; i < n; i++) {
    const box = await rows.nth(i).boundingBox();
    if (!box) throw new Error(`session row ${i} has no box`);
    const size = sizes?.[i] ?? {width: Math.round(box.width), height: Math.round(box.height)};
    shots.push(await page.screenshot({clip: {x: box.x, y: box.y, ...size}}));
    outSizes.push(size);
  }
  return {shots, sizes: outSizes};
};

for (const {layout, size} of LAYOUTS) {
  const boot = (page: Page, port: number) => bootPinned(page, port, {size});

  test(`1 looks normal offline (${layout})`, async ({page}) => {
    test.setTimeout(120_000);
    const engine = await rig();
    const log = captureLog(page);
    try {
      await boot(page, engine.port);
      await warm(page, engine.port, layout);
      await waitLive(page);
      const online = await rowShapes(page);
      expect(online.map((r) => r.name)).toEqual([NAME[C], NAME[B], NAME[A]]);
      const {shots: onlineRowShots, sizes: rowSizes} = await rowShots(page);
      await evidenceShot(page, SHOT_DIR, `list-${layout}-online`);

      await goOffline(page, engine);
      // Desktop keeps the chat open beside the list: reopen the same chat so
      // the row highlight matches the online capture (it paints from cache).
      if (layout === 'desktop') await openChat(page, NAME[A]);
      expect(await rowShapes(page)).toEqual(online);
      await expect(page.locator('.cyc-conn')).toHaveCount(0);
      await expect(page.locator('.cyc-toast')).toHaveCount(0);
      await expect(page.locator('.notyf__toast')).toHaveCount(0);
      await expect(page.locator('.cyc-pill-events')).toHaveCount(0);
      expect(await syncStatus(page)).toBe('offline');
      const {shots: offlineRowShots} = await rowShots(page, rowSizes);
      await evidenceShot(page, SHOT_DIR, `list-${layout}-offline`);
      expect(offlineRowShots.length).toBe(onlineRowShots.length);
      for (let i = 0; i < onlineRowShots.length; i++) {
        const mismatch = pixelDiff(offlineRowShots[i]!, onlineRowShots[i]!, 0.005);
        expect(mismatch, `session row ${i} offline differs from online by more than 0.5 %`).toBeNull();
      }

      // The composer is a contenteditable, not a textarea; it takes input offline.
      if (layout === 'phone') await openChat(page, NAME[A]);
      const input = page.locator('#cyc-thread-pane .cyc-composer-input[contenteditable="true"]');
      await expect(input).toBeVisible();
      await expect(page.locator('#cyc-thread-pane .cyc-composer')).not.toHaveClass(
        /cyc-composer-disabled/
      );
      expect(log.has('history.older.failed')).toBe(false);
    } finally {
      await engine.close();
    }
  });

  test(`2 chat opens at the unread marker offline, no second landing (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const engine = await rig();
    try {
      await boot(page, engine.port);
      await warm(page, engine.port, layout);
      await openChat(page, NAME[B]);
      await expect
        .poll(() => heldMessages(page, sidOf(engine.port, B)).then((m) => m.length), {
          timeout: 15_000
        })
        .toBe(60);
      await backToList(page, layout);

      await goOffline(page, engine);
      await openChat(page, NAME[B]);
      const marker = page.locator('.cyc-message-list-scroll [data-cyc-unread]').first();
      await expect(marker).toBeVisible({timeout: 15_000});
      await page.waitForTimeout(1500);
      const inView = await page.evaluate(() => {
        const box = document.querySelector('.cyc-message-list-scroll')!.getBoundingClientRect();
        const m = document
          .querySelector('.cyc-message-list-scroll [data-cyc-unread]')!
          .getBoundingClientRect();
        return m.top >= box.top - 1 && m.top <= box.bottom;
      });
      expect(inView, 'the unread marker is not in the viewport after the offline open').toBe(true);
      const before = await page.evaluate(
        () => document.querySelector('.cyc-message-list-scroll')!.scrollTop
      );

      const attaches = engine.attaches.length;
      await comeBack(page, engine);
      await expect.poll(() => engine.attaches.length, {timeout: 20_000}).toBeGreaterThan(attaches);
      await waitLive(page);
      await page.waitForTimeout(1500);
      const after = await page.evaluate(
        () => document.querySelector('.cyc-message-list-scroll')!.scrollTop
      );
      expect(Math.abs(after - before), 'the attach-ok moved the chat').toBeLessThanOrEqual(2);
    } finally {
      await engine.close();
    }
  });

  test(`3 older pages page back from the cache offline (${layout})`, async ({page}) => {
    test.setTimeout(120_000);
    const engine = await rig();
    const log = captureLog(page);
    try {
      await boot(page, engine.port);
      await warm(page, engine.port, layout);

      await goOffline(page, engine);
      const mark = Date.now();
      await openChat(page, NAME[A]);
      // The cache paints the tail page first; the page before it is asked for
      // at the top, and comes from the cache too.
      await expect
        .poll(() => heldMessages(page, sidOf(engine.port, A)).then((m) => m.length), {
          timeout: 15_000
        })
        .toBe(50);
      await page.waitForTimeout(1000);
      await pageBack(page, sidOf(engine.port, A), 150);
      expect(log.since('history.older', mark).length).toBeGreaterThanOrEqual(1);
      expect(log.has('history.older.failed')).toBe(false);
      expect(log.has('history.older.uncached')).toBe(false);
      expect(await toastCount(page)).toBe(0);
      const held = await heldMessages(page, sidOf(engine.port, A));
      expect(held[0].text).toBe('alpha-0000');
      expect(await domMessageCount(page)).toBeGreaterThan(50);
    } finally {
      await engine.close();
    }
  });

  test(`4 a send offline waits as an intent and drains when the engine returns (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const engine = await rig();
    try {
      await boot(page, engine.port);
      await warm(page, engine.port, layout);

      await goOffline(page, engine);
      await openChat(page, NAME[A]);
      await expect.poll(() => domMessageCount(page), {timeout: 15_000}).toBeGreaterThan(0);
      await typeAndSend(page, 'hello');
      const sid = sidOf(engine.port, A);
      await expect
        .poll(
          () => heldMessages(page, sid).then((m) => m.find((x) => x.text === 'hello')?.status),
          {timeout: 10_000}
        )
        .toBe('sending');
      const bubble = page
        .locator('.cyc-message-list-inner .cyc-message', {hasText: 'hello'})
        .last();
      await expect(bubble.locator('.cyc-stamp-clock')).toHaveCount(1);
      await expect
        .poll(() => intentRows(page).then((r) => r.filter((i) => i.kind === 'send-text').length), {
          timeout: 10_000
        })
        .toBe(1);
      // The read marker also queues a `progress` mark; the send is the one row
      // the spec counts.
      const rows = (await intentRows(page)).filter((i) => i.kind === 'send-text');
      expect(rows).toHaveLength(1);
      const cid = String(rows[0].payload.cid);
      expect(cid).toBeTruthy();

      await comeBack(page, engine);
      await expect
        .poll(() => engine.utterances.filter((u) => u.cid === cid).length, {
          timeout: 10_000,
          message: 'the queued send never reached the engine'
        })
        .toBe(1);
      await expect
        .poll(
          () => heldMessages(page, sid).then((m) => m.find((x) => x.text === 'hello')?.status),
          {timeout: 15_000}
        )
        .toBe('delivered');
      await expect.poll(() => intentRows(page).then((r) => r.length), {timeout: 10_000}).toBe(0);
      expect(engine.utterances.filter((u) => u.cid === cid)).toHaveLength(1);
    } finally {
      await engine.close();
    }
  });

  test(`6 the session log paints from the cache offline (${layout})`, async ({page}) => {
    test.setTimeout(120_000);
    const engine = await rig();
    try {
      await boot(page, engine.port);
      await warm(page, engine.port, layout);

      await goOffline(page, engine);
      await openChat(page, NAME[A]);
      // The records ride the pages: the open paints the tail from the cache and
      // the earlier records come back page by page (page 0 was warmed above),
      // all offline, from the same cache the messages page from.
      await pageBack(page, sidOf(engine.port, A), 150);
      await expect.poll(() => sessionEvents(page), {timeout: 15_000}).toBe(10);
      const texts = await page.locator('.cyc-message.cyc-session-event').allTextContents();
      expect(texts.join(' ')).toContain('alpha-event-9');
      await expect(page.locator('.cyc-pill-events')).toHaveCount(0);
      expect(await toastCount(page)).toBe(0);
    } finally {
      await engine.close();
    }
  });

  test(`7 the status word timeline: connecting, offline, syncing, live (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const engine = await rig();
    try {
      await boot(page, engine.port);
      await warm(page, engine.port, layout);

      // Record every word the status box shows, from the moment it exists.
      await page.addInitScript(() => {
        type Entry = {t: number; text: string};
        const log: Entry[] = [];
        (window as unknown as {__cycStatusLog: Entry[]}).__cycStatusLog = log;
        let el: Element | null = null;
        const push = (text: string) => {
          const last = log[log.length - 1];
          if (!last || last.text !== text) log.push({t: performance.now(), text});
        };
        const mo = new MutationObserver((recs) => {
          if (!el) {
            el = document.querySelector('.cyc-sync-status');
            if (!el) return;
            (window as unknown as {__cycStatusAt: number}).__cycStatusAt = performance.now();
            push(el.textContent ?? '');
          }
          for (const r of recs) {
            if (r.target !== el && !el.contains(r.target)) continue;
            for (const n of r.removedNodes) push(n.textContent ?? '');
            push(el.textContent ?? '');
          }
        });
        // The init script runs before <html> exists: observe the document node.
        mo.observe(document, {childList: true, subtree: true, characterData: true});
      });
      await engine.stop();
      await page.reload();
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      const readLog = () =>
        page.evaluate(() => {
          const w = window as unknown as {
            __cycStatusLog: {t: number; text: string}[];
            __cycStatusAt: number;
          };
          return {log: w.__cycStatusLog, at: w.__cycStatusAt, now: performance.now()};
        });
      await expect
        .poll(() => readLog().then((r) => r.now - r.at), {timeout: 10_000})
        .toBeGreaterThan(5500);
      const early = await readLog();
      const connecting = early.log.find((e) => e.text === 'connecting');
      expect(connecting, `no "connecting": ${JSON.stringify(early.log)}`).toBeTruthy();
      expect(connecting!.t - early.at).toBeLessThan(500);
      const offline = early.log.find((e) => e.text === 'offline' && e.t > connecting!.t);
      expect(offline, `no "offline" after connecting: ${JSON.stringify(early.log)}`).toBeTruthy();
      expect(offline!.t - early.at).toBeLessThanOrEqual(5500);
      expect(await syncStatus(page)).toBe('offline');

      await page.context().setOffline(true);
      await expect.poll(() => syncStatus(page)).toBe('offline');
      const back = await readLog();
      await comeBack(page, engine);
      await waitLive(page, 10_000);
      const late = await readLog();
      const words = late.log.filter((e) => e.t > back.now).map((e) => e.text);
      expect(words, 'no "syncing" before live').toContain('syncing');
      expect(words[words.length - 1]).toBe('');
      for (const e of late.log) expect(['', 'connecting', 'offline', 'syncing']).toContain(e.text);
      expect(late.log.some((e) => e.text.includes('engine disconnected'))).toBe(false);
      expect(await page.locator('.notyf__toast', {hasText: 'engine disconnected'}).count()).toBe(0);
    } finally {
      await engine.close();
    }
  });

  test(`8 backoff caps the dials and hidden stops them (${layout})`, async ({page}) => {
    test.setTimeout(150_000);
    const engine = await rig();
    const log = captureLog(page);
    try {
      await boot(page, engine.port);
      await warm(page, engine.port, layout);

      await engine.stop();
      await page.reload();
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      const dials = () =>
        page.evaluate(() => (window as unknown as {__cycDials: number}).__cycDials);
      await expect.poll(dials, {timeout: 5000}).toBeGreaterThanOrEqual(1);
      const first = await dials();
      await page.waitForTimeout(8000);
      const at8 = await dials();
      expect(at8 - first, 'more than 3 dials in the 8 s after the first').toBeLessThanOrEqual(3);

      const hiddenAt = Date.now();
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          get: () => 'hidden',
          configurable: true
        });
        Object.defineProperty(document, 'hidden', {get: () => true, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      // Hidden stops the dialing after HIDDEN_STOP_MS (30 s): `sync.parked`.
      await expect
        .poll(
          () =>
            log.since('sync.parked', hiddenAt).filter((l) => l.field('why') === 'hidden').length,
          {
            timeout: 35_000,
            message: 'hidden never parked the dial'
          }
        )
        .toBe(1);
      const parked = await dials();
      await page.waitForTimeout(40_000);
      expect(await dials(), 'a dial after the hidden park').toBe(parked);
    } finally {
      await engine.close();
    }
  });

  test(`9 a reload mid-drain delivers every queued send once (${layout})`, async ({page}) => {
    test.setTimeout(120_000);
    const engine = await rig();
    try {
      await boot(page, engine.port);
      await warm(page, engine.port, layout);

      await engine.stop();
      await page.reload();
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      await openChat(page, NAME[A]);
      await expect.poll(() => domMessageCount(page), {timeout: 15_000}).toBeGreaterThan(0);
      for (let i = 1; i <= 5; i++) await typeAndSend(page, `queued-${i}`);
      await expect
        .poll(() => intentRows(page).then((r) => r.filter((i) => i.kind === 'send-text').length), {
          timeout: 10_000
        })
        .toBe(5);
      const cids = (await intentRows(page))
        .filter((r) => r.kind === 'send-text')
        .map((r) => String(r.payload.cid));
      expect(new Set(cids).size).toBe(5);

      engine.holdAcksAfter(2);
      await engine.start();
      await expect
        .poll(() => engine.acks, {timeout: 20_000, message: 'the drain never got two acks'})
        .toBe(2);
      await page.reload();
      engine.releaseAcks();
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      await expect
        .poll(() => engine.delivered.size, {
          timeout: 30_000,
          message: 'not every queued send was delivered'
        })
        .toBe(5);
      await expect.poll(() => intentRows(page).then((r) => r.length), {timeout: 15_000}).toBe(0);
      expect([...engine.delivered.keys()].sort()).toEqual([...cids].sort());
      expect(engine.msgs(A).filter((m) => m.role === 'user')).toHaveLength(5);
      expect(
        engine
          .msgs(A)
          .filter((m) => m.role === 'user')
          .map((m) => m.text)
          .sort()
      ).toEqual(['queued-1', 'queued-2', 'queued-3', 'queued-4', 'queued-5']);
      await page.waitForTimeout(2000);
      expect(engine.delivered.size).toBe(5);

      // The app side: the two rows the page replayed (acked before the
      // reload) landed in their pending bubbles; five bubbles, no twins.
      await backToList(page, layout);
      await openChat(page, NAME[A]);
      const mine = () =>
        heldMessages(page, sidOf(engine.port, A)).then((m) => m.filter((x) => x.role === 'user'));
      await expect
        .poll(() => mine().then((m) => m.map((x) => x.status)), {timeout: 15_000})
        .toEqual(['delivered', 'delivered', 'delivered', 'delivered', 'delivered']);
      expect((await mine()).map((m) => m.text).sort(), 'a replayed row painted a twin').toEqual([
        'queued-1',
        'queued-2',
        'queued-3',
        'queued-4',
        'queued-5'
      ]);
      expect(
        await page
          .locator('.cyc-message-list-inner .cyc-message:not(.cyc-msg-system)', {
            hasText: /queued-\d/
          })
          .count()
      ).toBe(5);
    } finally {
      await engine.close();
    }
  });

  test(`11 engine-only actions are grey offline, no toast (${layout})`, async ({page}) => {
    test.setTimeout(120_000);
    const engine = await rig();
    try {
      await boot(page, engine.port);
      await warm(page, engine.port, layout);

      await goOffline(page, engine);
      await openChat(page, NAME[A]);
      const stop = page.locator('#cyc-thread-pane .cyc-stop-btn');
      await expect(stop).toHaveAttribute('disabled', '');
      await expect(stop).toHaveAttribute('title', 'needs the engine');
      await stop.click({force: true});
      await page.waitForTimeout(300);
      expect(await toastCount(page)).toBe(0);
      await expect(page.locator('.cyc-confirm-stop')).toHaveCount(0);

      await page.locator('#cyc-thread-pane .cyc-ctx-btn').click();
      const compact = page.locator('.cyc-confirm-compact .cyc-sheet-btn', {hasText: 'Compact'});
      await expect(compact).toBeVisible();
      await expect(compact).toHaveAttribute('disabled', '');
      await expect(compact).toHaveAttribute('title', 'needs the engine');
      await compact.click({force: true});
      await page.waitForTimeout(300);
      expect(await toastCount(page)).toBe(0);
      await expect(page.locator('.cyc-confirm-compact')).toBeVisible();
      await page.locator('.cyc-confirm-compact .cyc-sheet-btn', {hasText: 'Cancel'}).click();
      expect(await row(page, NAME[A]).count()).toBe(1);
    } finally {
      await engine.close();
    }
  });
}
