import {test, expect, type Page} from '@playwright/test';
import {bootPinned, evidenceShot} from './rig';
import {startTransferEngine, sessionIdFor, CHAT, type TransferEngine} from './transferEngine';

// The full-screen image viewer never shows the browser's broken-image icon.
// The owner's report (phone, 2026-09-02): "whenever I open an image in the
// image viewer it shows a broken icon" while the bubble thumbnail paints. Five
// cases, in a real browser over the real sealed tunnel against the transfer
// engine, each opening the viewer the way a tap on the bubble does:
//
//   1. own sent image, viewer opened right after the ack;
//   2. own sent image after a reload (the bubble paints from the app's image
//      cache; the viewer must too, with zero engine media fetches);
//   3. an image the agent showed (`show`), before and after a reload;
//   4. wire down, bytes cached: the viewer paints from the cache;
//   5. wire down, bytes gone: the viewer shows a visible "tap to load" state,
//      never the broken icon; once the engine is back a tap loads it.
//
// Each case asserts the viewer's <img> decodes real pixels (naturalWidth > 0)
// within 3 s and records which source it got (blob:/http/data), plus the
// viewer.image.* cyclog lines the resolution wrote.
//
// grep token: `image viewer`.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const SHOT_DIR = 'image-viewer';
const PHONE = {width: 390, height: 844};
const PAINT_MS = 3_000;

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

// Two noise PNGs sent as one message (an album), the way a phone sends a
// handful of photos at once.
async function sendTwoImages(page: Page, sessionId: string, side: number): Promise<number> {
  return page.evaluate(
    async ({s, side}) => {
      const makePng = async (seed: number, name: string) => {
        const c = document.createElement('canvas');
        c.width = side;
        c.height = side;
        const ctx = c.getContext('2d')!;
        const img = ctx.createImageData(side, side);
        let x = seed;
        for (let i = 0; i < img.data.length; i += 4) {
          x = (x * 1103515245 + 12345) & 0x7fffffff;
          img.data[i] = x & 0xff;
          img.data[i + 1] = (x >> 8) & 0xff;
          img.data[i + 2] = (x >> 16) & 0xff;
          img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
        return new File([blob], name, {type: 'image/png'});
      };
      const files = [await makePng(7, 'first.png'), await makePng(99, 'second.png')];
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
      const text = 'two shots';
      return store.sendAttachments(s, {
        text,
        wireText: text,
        files: files.map((file) => ({
          key: crypto.randomUUID(),
          file,
          name: file.name,
          mime: file.type,
          width: side,
          height: side,
          at: 0,
          wireAt: 0
        })),
        words: []
      });
    },
    {s: sessionId, side}
  );
}

// The same noise PNG rendered in the page, handed back as bytes so the engine
// can serve it as a shown picture.
async function pngBytes(page: Page, side: number): Promise<Uint8Array> {
  const b64 = await page.evaluate(async (side) => {
    const c = document.createElement('canvas');
    c.width = side;
    c.height = side;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(side, side);
    let x = 11;
    for (let i = 0; i < img.data.length; i += 4) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      img.data[i] = x & 0xff;
      img.data[i + 1] = (x >> 8) & 0xff;
      img.data[i + 2] = (x >> 16) & 0xff;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  }, side);
  return new Uint8Array(Buffer.from(b64, 'base64'));
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
const progress = (page: Page) => page.locator('.cyc-send-progress');
const viewer = (page: Page) => page.locator('.cyc-imgview');
const viewerTap = (page: Page) => page.locator('.cyc-imgview .cyc-imgview-tap');

// The viewer.image.* cyclog lines (cyclog echoes every line to console.debug).
function collectViewerLog(page: Page): () => string[] {
  const lines: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('viewer.image.')) lines.push(t);
  });
  return () => [...lines];
}

async function expectBubblePainted(page: Page, timeout: number): Promise<void> {
  await expect
    .poll(async () => page.$eval('.cyc-message .cyc-media-box img.cyc-still', (el) => (el as HTMLImageElement).naturalWidth), {
      timeout,
      message: 'the image bubble never decoded real pixels'
    })
    .toBeGreaterThan(0);
}

// Send one image and wait for the engine's ack (the echoed user chat frame)
// and for the bubble to paint.
async function sendAndAck(page: Page, engine: TransferEngine, sid: string): Promise<string> {
  await sendImage(page, sid, 256);
  await expect.poll(() => engine.finishes(), {timeout: 30_000}).toBe(1);
  await expect.poll(() => engine.utterances().length, {timeout: 20_000}).toBe(1);
  const [u] = engine.utterances();
  const uploadId = u.upload?.uploadId ?? '';
  expect(uploadId.startsWith('srv-up-')).toBe(true);
  await expect(progress(page)).toHaveCount(0, {timeout: 10_000});
  await expect(page.locator('.cyc-message.cyc-msg-failed')).toHaveCount(0);
  await expectBubblePainted(page, 10_000);
  return engine.uploadUrl(uploadId);
}

async function reloadAndOpen(page: Page): Promise<void> {
  await page.reload();
  await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
  await openChat(page);
  await expect(bubbleImg(page)).toHaveCount(1, {timeout: 15_000});
}

// A tap on the bubble: the media box's own click handler is what opens the
// viewer (a tap card over it stops its own click, so the element is clicked
// directly and the real open path runs either way).
async function tapBubble(page: Page): Promise<void> {
  await page.$eval('.cyc-message .cyc-media-box', (el) => (el as HTMLElement).click());
  await expect(viewer(page)).toHaveCount(1, {timeout: 5_000});
}

// What the viewer's main <img> shows right now: the owner's symptom is the
// browser's broken-image icon (complete, naturalWidth 0, a src that failed).
const viewerState = (page: Page) =>
  page.evaluate(() => {
    const ov = document.querySelector('.cyc-imgview');
    const img = ov?.querySelector('img.cyc-imgview-img:not(.cyc-imgview-neighbour)') as
      | HTMLImageElement
      | null
      | undefined;
    const src = img?.getAttribute('src') ?? '';
    return {
      open: !!ov,
      src,
      scheme: src ? src.split(':')[0] : '(none)',
      complete: img?.complete ?? false,
      naturalWidth: img?.naturalWidth ?? -1,
      tap: !!ov?.querySelector('.cyc-imgview-tap'),
      tapText: ov?.querySelector('.cyc-imgview-tap')?.textContent ?? '',
      waiting: !!ov?.querySelector('.cyc-imgview-waiting'),
      gone: !!ov?.querySelector('.cyc-imgview-gone')
    };
  });

async function expectViewerPainted(
  page: Page,
  label: string,
  log: () => string[],
  timeout = PAINT_MS
): Promise<void> {
  let last = await viewerState(page);
  try {
    await expect
      .poll(
        async () => {
          last = await viewerState(page);
          // The image counts as painted only once it has decoded real pixels
          // (naturalWidth > 0) AND finished loading (complete). Under load the
          // two land on separate frames -- naturalWidth flips first -- so a poll
          // on naturalWidth alone can return a snapshot whose `complete` is still
          // false, which the assertion below then reads as a failure.
          return last.complete && last.naturalWidth > 0 ? last.naturalWidth : 0;
        },
        {timeout, message: `${label}: the viewer image never decoded real pixels`}
      )
      .toBeGreaterThan(0);
  } finally {
    console.log(`[image viewer] ${label}:`, JSON.stringify(last));
    for (const l of log()) console.log(`[image viewer] ${label} log:`, l);
  }
  expect(last.complete).toBe(true);
  expect(last.tap, `${label}: the viewer shows tap-to-load over a painted image`).toBe(false);
}

async function closeViewer(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0, {timeout: 5_000});
}

test('own sent image: the viewer paints right after the ack', async ({page}) => {
  test.setTimeout(90_000);
  const engine = await startTransferEngine({echoUtterances: true, serveUploads: true});
  const sid = sessionIdFor(engine.port);
  const log = collectViewerLog(page);
  try {
    await bootPinned(page, engine.port, {size: PHONE});
    await openChat(page);
    await tuneWorker(page);
    await sendAndAck(page, engine, sid);

    await tapBubble(page);
    await expectViewerPainted(page, 'after ack', log);
    await evidenceShot(page, SHOT_DIR, 'phone-after-ack');
    // The viewer took the bytes this page already has; the engine served none.
    expect(engine.uploadGets(), 'the viewer fetched the image from the engine').toEqual([]);
    await closeViewer(page);
  } finally {
    await engine.close();
  }
});

test('own sent image: the viewer paints after a reload from the app cache, zero engine fetches', async ({page}) => {
  test.setTimeout(90_000);
  const engine = await startTransferEngine({echoUtterances: true, serveUploads: true});
  const sid = sessionIdFor(engine.port);
  const log = collectViewerLog(page);
  try {
    await bootPinned(page, engine.port, {size: PHONE});
    await openChat(page);
    await tuneWorker(page);
    const url = await sendAndAck(page, engine, sid);
    expect(await cachedBytes(page, url), `no image cache row under ${url}`).toBeGreaterThan(0);

    await reloadAndOpen(page);
    await expectBubblePainted(page, 20_000);
    await tapBubble(page);
    await expectViewerPainted(page, 'after reload', log);
    await evidenceShot(page, SHOT_DIR, 'phone-after-reload');
    await page.waitForTimeout(1_000);
    expect(engine.uploadGets(), 'the viewer fetched the image from the engine').toEqual([]);
    await closeViewer(page);
  } finally {
    await engine.close();
  }
});

test('a shown image: the viewer paints before and after a reload', async ({page}) => {
  test.setTimeout(90_000);
  const engine = await startTransferEngine({echoUtterances: true, serveUploads: true});
  const log = collectViewerLog(page);
  try {
    await bootPinned(page, engine.port, {size: PHONE});
    await openChat(page);
    const bytes = await pngBytes(page, 200);
    engine.showImage('diagram.png', bytes, 'image/png');
    await expect(bubbleImg(page)).toHaveCount(1, {timeout: 15_000});
    await expectBubblePainted(page, 20_000);

    await tapBubble(page);
    await expectViewerPainted(page, 'shown, before reload', log);
    await evidenceShot(page, SHOT_DIR, 'phone-shown-before-reload');
    await closeViewer(page);

    await reloadAndOpen(page);
    await expectBubblePainted(page, 20_000);
    await tapBubble(page);
    await expectViewerPainted(page, 'shown, after reload', log);
    await evidenceShot(page, SHOT_DIR, 'phone-shown-after-reload');
    console.log('[image viewer] shown doc GETs:', JSON.stringify(engine.docGets()));
    // One fetch for the bubble; the viewer reads the same cache row, before and
    // after the reload (at HEAD the viewer fetched it a second time on its own).
    expect(engine.docGets(), 'the viewer fetched the shown picture apart from the bubble').toHaveLength(1);
    await closeViewer(page);
  } finally {
    await engine.close();
  }
});

test('wire down, bytes cached: the viewer paints from the cache', async ({page}) => {
  test.setTimeout(90_000);
  const engine = await startTransferEngine({echoUtterances: true, serveUploads: true});
  const sid = sessionIdFor(engine.port);
  const log = collectViewerLog(page);
  try {
    await bootPinned(page, engine.port, {size: PHONE});
    await openChat(page);
    await tuneWorker(page);
    const url = await sendAndAck(page, engine, sid);
    expect(await cachedBytes(page, url)).toBeGreaterThan(0);

    await engine.stop();
    await reloadAndOpen(page);
    await expectBubblePainted(page, 20_000);
    await tapBubble(page);
    await expectViewerPainted(page, 'wire down, cached', log);
    await evidenceShot(page, SHOT_DIR, 'phone-wire-down-cached');
    await closeViewer(page);
  } finally {
    await engine.close();
  }
});

const albumImages = (page: Page) => page.locator('.cyc-message .cyc-multipart-album img.cyc-still');

// The phone's own case: photos sent as one message, the page reloaded while
// they were still going up (the transfers resume from the vault on disk), then
// delivered and acked, the vault released; now a tap opens the viewer.
test('album resumed from the vault after a reload, then acked: the viewer paints every picture', async ({page}) => {
  test.setTimeout(120_000);
  // Slow chunks so the reload lands mid-transfer (two ~3 MiB PNGs, 12 chunks each).
  const engine = await startTransferEngine({putDelayMs: 200, echoUtterances: true, serveUploads: true});
  const sid = sessionIdFor(engine.port);
  const log = collectViewerLog(page);
  try {
    await bootPinned(page, engine.port, {size: PHONE});
    await openChat(page);
    await tuneWorker(page);
    await sendTwoImages(page, sid, 1024);
    await expect.poll(() => engine.putCount(), {timeout: 30_000}).toBeGreaterThanOrEqual(2);
    await page.reload();
    await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
    await openChat(page);
    await tuneWorker(page);
    await expect.poll(() => engine.finishes(), {timeout: 60_000}).toBe(2);
    await expect.poll(() => engine.utterances().length, {timeout: 20_000}).toBe(1);
    const ids = (engine.utterances()[0].uploads ?? []).map((x) => x.uploadId);
    expect(ids).toHaveLength(2);
    await expect(albumImages(page)).toHaveCount(2, {timeout: 10_000});
    await expect(progress(page)).toHaveCount(0, {timeout: 10_000});
    await expect(page.locator('.cyc-message.cyc-msg-failed')).toHaveCount(0);
    // Let the vault release the delivered bytes before the tap.
    await page.waitForTimeout(1_500);
    const bubbles = await page.$$eval('.cyc-message .cyc-multipart-album img.cyc-still', (els) =>
      els.map((el) => {
        const img = el as HTMLImageElement;
        return {src: img.getAttribute('src') ?? '', naturalWidth: img.naturalWidth};
      })
    );
    console.log('[image viewer] resumed album bubbles:', JSON.stringify(bubbles));

    await page.$eval('.cyc-message .cyc-multipart-album .cyc-media-box', (el) => (el as HTMLElement).click());
    await expect(viewer(page)).toHaveCount(1, {timeout: 5_000});
    await expectViewerPainted(page, 'resumed album, first', log);
    await evidenceShot(page, SHOT_DIR, 'phone-resumed-album-first');
    await page.keyboard.press('ArrowRight');
    await expectViewerPainted(page, 'resumed album, second', log);
    await evidenceShot(page, SHOT_DIR, 'phone-resumed-album-second');
    for (const id of ids) {
      expect(await cachedBytes(page, engine.uploadUrl(id)), `no image cache row for ${id}`).toBeGreaterThan(0);
    }
    await closeViewer(page);
  } finally {
    await engine.close();
  }
});

test('wire down, bytes gone: the viewer shows tap to load, never the broken icon; a tap loads once the engine is back', async ({
  page
}) => {
  test.setTimeout(120_000);
  const engine = await startTransferEngine({echoUtterances: true, serveUploads: true});
  const sid = sessionIdFor(engine.port);
  const log = collectViewerLog(page);
  try {
    await bootPinned(page, engine.port, {size: PHONE});
    await openChat(page);
    await tuneWorker(page);
    const url = await sendAndAck(page, engine, sid);
    await dropCached(page, url);
    expect(await cachedBytes(page, url)).toBe(0);

    await engine.stop();
    await reloadAndOpen(page);
    await tapBubble(page);
    // The viewer is never a broken icon (an <img> that completed with zero
    // pixels on a src) nor a silent black stage: it says it is waiting for the
    // wire, then, once the wire gate runs out (MEDIA_WIRE_WAIT_MS, 30 s, the
    // bubble's own), it settles into a visible tap-to-load state.
    await expect(page.locator('.cyc-imgview .cyc-imgview-waiting')).toHaveCount(1, {timeout: PAINT_MS});
    await page.waitForTimeout(6_000);
    let st = await viewerState(page);
    console.log('[image viewer] wire down, bytes gone, 6 s in:', JSON.stringify(st));
    for (const l of log()) console.log('[image viewer] wire down, bytes gone log:', l);
    await evidenceShot(page, SHOT_DIR, 'phone-wire-down-6s');
    expect(st.complete && st.naturalWidth === 0 && st.src !== '', 'the viewer shows the broken-image icon').toBe(false);
    expect(st.waiting || st.tap, 'the viewer is a silent black stage').toBe(true);
    await expect(viewerTap(page)).toHaveCount(1, {timeout: 40_000});
    st = await viewerState(page);
    console.log('[image viewer] wire down, bytes gone, tap state:', JSON.stringify(st));
    await evidenceShot(page, SHOT_DIR, 'phone-wire-down-tap');
    await expect(viewerTap(page)).toBeVisible();
    await expect(viewerTap(page)).toContainText(/tap to load/i);
    expect(st.complete && st.naturalWidth === 0 && st.src !== '', 'the viewer shows the broken-image icon').toBe(false);
    const paint = await page.$eval('.cyc-imgview .cyc-imgview-tap', (el) => {
      const r = el.getBoundingClientRect();
      return {w: r.width, h: r.height};
    });
    expect(paint.w).toBeGreaterThan(40);
    expect(paint.h).toBeGreaterThan(40);
    expect(engine.uploadGets()).toEqual([]);

    // The engine returns on the same port; a tap loads the picture once the
    // app has re-dialed it (the tap waits on the same wire gate as a bubble).
    await engine.start();
    await viewerTap(page).click();
    await expect(viewerTap(page)).toHaveCount(0, {timeout: 10_000});
    await expectViewerPainted(page, 'wire back, tapped', log, 40_000);
    await evidenceShot(page, SHOT_DIR, 'phone-wire-back-tapped');
    expect(engine.uploadGets()).toHaveLength(1);
    await closeViewer(page);
  } finally {
    await engine.close();
  }
});
