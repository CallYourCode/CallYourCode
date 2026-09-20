import {test, expect, type Page} from '@playwright/test';
import {bootPinned, evidenceShot} from './rig';
import {startTransferEngine, sessionIdFor, CHAT, type TransferEngine} from './transferEngine';

// A sent image is never black on reload. The owner's report (phone, 2026-09-02):
// "why is this black on reload. isn't it cached on the app side". Three cases,
// in a real browser over the real sealed tunnel against the transfer engine:
//
//   1. send an image, wait for the ack, reload: the bubble paints from the
//      app's own image cache with ZERO engine media fetches (the engine counts
//      every GET /upload/<id> it serves);
//   2. cache miss and the wire comes up 3 s after boot: the image still paints,
//      with exactly one fetch (the retry window did not burn on a dead wire);
//   3. cache miss and the wire never comes up: the bubble shows a visible
//      "tap to load" state, never a black box and never "no longer on disk";
//      once the engine is back a tap loads it.
//
// grep token: `image cache reload`.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const SHOT_DIR = 'image-cache-reload';
const PHONE = {width: 390, height: 844};

async function openChat(page: Page): Promise<void> {
  await page.$$eval(
    '.cyc-session-entry',
    (els, chat) => {
      const row = els.find((e) => (e.textContent ?? '').includes(chat)) as HTMLElement | undefined;
      if (!row) throw new Error('no chat row for ' + chat);
      row.click();
    },
    CHAT
  );
  await page.waitForSelector('.cyc-message-list-scroll', {timeout: 10_000});
}

async function tuneWorker(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as {__cycTransferBackoffMs?: number}).__cycTransferBackoffMs = 100;
    (window as unknown as {__cycAckTimeoutMs?: number}).__cycAckTimeoutMs = 600_000;
  });
}

// One real PNG (canvas noise) sent as a message through the store, exactly as
// the composer's press does.
async function sendImage(page: Page, sessionId: string, side: number): Promise<number> {
  return page.evaluate(
    async ({s, side}) => {
      const c = document.createElement('canvas');
      c.width = side;
      c.height = side;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(side, side);
      let x = 7;
      for (let i = 0; i < img.data.length; i += 4) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        img.data[i] = x & 0xff;
        img.data[i + 1] = (x >> 8) & 0xff;
        img.data[i + 2] = (x >> 16) & 0xff;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
      const file = new File([blob], 'shot.png', {type: 'image/png'});
      const store = (
        window as unknown as {
          __cycStore: {
            sendAttachments(
              id: string,
              o: {
                text: string;
                wireText: string;
                files: {key: string; file: File; name: string; mime: string; width: number; height: number; at: number; wireAt: number}[];
                words: string[];
              }
            ): number;
          };
        }
      ).__cycStore;
      const text = 'one shot';
      return store.sendAttachments(s, {
        text,
        wireText: text,
        files: [
          {key: crypto.randomUUID(), file, name: file.name, mime: file.type, width: side, height: side, at: 0, wireAt: 0}
        ],
        words: []
      });
    },
    {s: sessionId, side}
  );
}

// The app's image cache (IndexedDB cyc-clips / images, keyed by engine URL).
const IMAGE_DB = async (op: {url: string; act: 'get' | 'delete'}) => {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('cyc-clips');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  try {
    if (!db.objectStoreNames.contains('images')) return null;
    const tx = db.transaction('images', 'readwrite');
    const st = tx.objectStore('images');
    const out = await new Promise<{bytes: number} | null>((res, rej) => {
      const q = op.act === 'get' ? st.get(op.url) : st.delete(op.url);
      q.onsuccess = () => {
        const row = q.result as {bytes?: number} | undefined;
        res(row && typeof row.bytes === 'number' ? {bytes: row.bytes} : null);
      };
      q.onerror = () => rej(q.error);
    });
    await new Promise<void>((res) => {
      tx.oncomplete = () => res();
      tx.onabort = () => res();
    });
    return out;
  } finally {
    db.close();
  }
};

const cachedBytes = (page: Page, url: string) =>
  page.evaluate(IMAGE_DB, {url, act: 'get' as const}).then((r) => r?.bytes ?? 0);
const dropCached = (page: Page, url: string) => page.evaluate(IMAGE_DB, {url, act: 'delete' as const});

const bubbleImg = (page: Page) => page.locator('.cyc-message .cyc-media-box img.cyc-still');
const goneCard = (page: Page) => page.locator('.cyc-message .cyc-media-gone');
const tapCard = (page: Page) => page.locator('.cyc-message .cyc-media-tap');
const progress = (page: Page) => page.locator('.cyc-send-progress');

// The bubble's image is painted: decoded with real pixels, revealed, and its
// source is an object URL (bytes in hand), never the bare engine URL.
const paintState = (page: Page) =>
  page.$eval('.cyc-message .cyc-media-box img.cyc-still', (el) => {
    const img = el as HTMLImageElement;
    return {
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      invisible: img.classList.contains('invisible'),
      src: img.src
    };
  });

async function expectPainted(page: Page, timeout: number): Promise<void> {
  await expect
    .poll(async () => (await paintState(page)).naturalWidth, {
      timeout,
      message: 'the image bubble never decoded real pixels'
    })
    .toBeGreaterThan(0);
  const st = await paintState(page);
  expect(st.complete).toBe(true);
  expect(st.invisible, 'the still is painted but kept invisible').toBe(false);
  expect(st.src.startsWith('blob:'), `src is not an object URL: ${st.src}`).toBe(true);
}

// Send one image and wait for the engine's ack (the echoed user chat frame)
// and for the app's image cache to hold the bytes under the engine URL.
async function sendAndAck(page: Page, engine: TransferEngine, sid: string): Promise<string> {
  await sendImage(page, sid, 256);
  await expect.poll(() => engine.finishes(), {timeout: 30_000}).toBe(1);
  await expect.poll(() => engine.utterances().length, {timeout: 20_000}).toBe(1);
  const [u] = engine.utterances();
  const uploadId = u.upload?.uploadId ?? '';
  expect(uploadId.startsWith('srv-up-')).toBe(true);
  await expect(progress(page)).toHaveCount(0, {timeout: 10_000});
  await expect(page.locator('.cyc-message.cyc-msg-failed')).toHaveCount(0);
  return engine.uploadUrl(uploadId);
}

// What the box looks like right now: the owner's symptom is a black box.
const boxState = (page: Page) =>
  page.$eval('.cyc-message .cyc-media-box', (el) => {
    const img = el.querySelector('img.cyc-still') as HTMLImageElement | null;
    return {
      bg: getComputedStyle(el).backgroundColor,
      imgInvisible: img?.classList.contains('invisible') ?? null,
      imgNaturalWidth: img?.naturalWidth ?? null,
      gone: !!el.querySelector('.cyc-media-gone'),
      goneText: el.querySelector('.cyc-media-gone')?.textContent ?? '',
      tap: !!el.querySelector('.cyc-media-tap')
    };
  });

async function reloadAndOpen(page: Page): Promise<void> {
  await page.reload();
  await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
  await openChat(page);
  await expect(bubbleImg(page)).toHaveCount(1, {timeout: 15_000});
}

test('sent image paints from the app cache on reload with zero engine media fetches', async ({page}) => {
  test.setTimeout(90_000);
  const engine = await startTransferEngine({echoUtterances: true, serveUploads: true});
  const sid = sessionIdFor(engine.port);
  try {
    await bootPinned(page, engine.port, {size: PHONE});
    await openChat(page);
    await tuneWorker(page);
    const url = await sendAndAck(page, engine, sid);
    // Sending never fetched the image back: it was painted from the local file.
    expect(engine.uploadGets()).toEqual([]);

    await reloadAndOpen(page);
    await expectPainted(page, 20_000);
    // Let any late retry land before counting.
    await page.waitForTimeout(1_500);
    console.log('[image cache reload] after reload:', JSON.stringify({...(await boxState(page)), gets: engine.uploadGets()}));
    expect(engine.uploadGets(), 'the reload fetched the image from the engine').toEqual([]);
    await expect(goneCard(page)).toHaveCount(0);
    await expect(tapCard(page)).toHaveCount(0);
    // and the bytes sit in the cache under the key the remote path resolves to
    expect(await cachedBytes(page, url), `no image cache row under ${url}`).toBeGreaterThan(0);
    await evidenceShot(page, SHOT_DIR, 'phone-cached-reload');
  } finally {
    await engine.close();
  }
});

test('cache miss, wire up 3 s after boot: the image still paints, one fetch', async ({page}) => {
  test.setTimeout(90_000);
  const engine = await startTransferEngine({echoUtterances: true, serveUploads: true});
  const sid = sessionIdFor(engine.port);
  try {
    await bootPinned(page, engine.port, {size: PHONE});
    await openChat(page);
    await tuneWorker(page);
    const url = await sendAndAck(page, engine, sid);
    await dropCached(page, url);
    expect(await cachedBytes(page, url)).toBe(0);

    // The pipe dials at boot but the seal handshake is held: the wire is not up.
    engine.holdHandshake();
    await reloadAndOpen(page);
    await page.waitForTimeout(3_000);
    expect(engine.uploadGets(), 'a fetch went out before the wire was up').toEqual([]);
    engine.releaseHandshake();

    await expectPainted(page, 30_000);
    await page.waitForTimeout(1_500);
    expect(engine.uploadGets()).toHaveLength(1);
    await expect(goneCard(page)).toHaveCount(0);
    await expect(tapCard(page)).toHaveCount(0);
    // and the fetched bytes are cached now: the key the remote path used
    expect(await cachedBytes(page, url)).toBeGreaterThan(0);
    await evidenceShot(page, SHOT_DIR, 'phone-late-wire');
  } finally {
    await engine.close();
  }
});

test('cache miss, wire never up: a visible tap-to-load state, not a black box; a tap loads once the engine is back', async ({
  page
}) => {
  test.setTimeout(150_000);
  const engine = await startTransferEngine({echoUtterances: true, serveUploads: true});
  const sid = sessionIdFor(engine.port);
  try {
    await bootPinned(page, engine.port, {size: PHONE});
    await openChat(page);
    await tuneWorker(page);
    const url = await sendAndAck(page, engine, sid);
    await dropCached(page, url);

    await engine.stop();
    await reloadAndOpen(page);
    // Evidence of what the box shows while the wire is down (the owner saw black).
    await page.waitForTimeout(5_000);
    const at5 = await boxState(page);
    console.log('[image cache reload] wire down, 5 s in:', JSON.stringify(at5));
    await evidenceShot(page, SHOT_DIR, 'phone-wire-down-5s');
    // While it waits for the wire it is a visible loading surface, not black.
    expect(at5.bg, 'the waiting box paints black').not.toMatch(/^rgba?\(0, 0, 0(, 1)?\)$/);
    expect(at5.gone).toBe(false);
    await page.waitForTimeout(15_000);
    const at20 = await boxState(page);
    console.log('[image cache reload] wire down, 20 s in:', JSON.stringify(at20));
    await evidenceShot(page, SHOT_DIR, 'phone-wire-down-20s');
    expect(at20.bg, 'the waiting box paints black').not.toMatch(/^rgba?\(0, 0, 0(, 1)?\)$/);
    expect(at20.gone).toBe(false);
    // The bubble settles into the tap-to-load state (after the wire wait), and
    // never into the "no longer on disk" card: the image IS on the engine.
    await expect(tapCard(page)).toHaveCount(1, {timeout: 60_000});
    await expect(tapCard(page)).toBeVisible();
    await expect(tapCard(page)).toContainText(/tap to load/i);
    await expect(goneCard(page)).toHaveCount(0);
    const paint = await page.$eval('.cyc-message .cyc-media-tap', (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {bg: cs.backgroundColor, w: r.width, h: r.height};
    });
    expect(paint.w).toBeGreaterThan(40);
    expect(paint.h).toBeGreaterThan(40);
    expect(paint.bg, 'the tap-to-load state paints black').not.toMatch(/^rgba?\(0, 0, 0(, 1)?\)$/);
    await evidenceShot(page, SHOT_DIR, 'phone-tap-to-load');
    // It stays that way (no retry loop flipping it back to a black box).
    await page.waitForTimeout(2_000);
    await expect(tapCard(page)).toHaveCount(1);
    await expect(goneCard(page)).toHaveCount(0);
    expect(engine.uploadGets()).toEqual([]);

    // The engine returns on the same port; a tap loads the image.
    await engine.start();
    await tapCard(page).click();
    await expect(tapCard(page)).toHaveCount(0, {timeout: 5_000});
    await expectPainted(page, 45_000);
    await page.waitForTimeout(1_000);
    expect(engine.uploadGets()).toHaveLength(1);
    await expect(goneCard(page)).toHaveCount(0);
    await evidenceShot(page, SHOT_DIR, 'phone-tapped-loaded');
  } finally {
    await engine.close();
  }
});
