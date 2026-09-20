import {test, expect, type Page} from '@playwright/test';
import {bootPinned, evidenceShot} from './rig';
import {startTransferEngine, sessionIdFor, CHAT, CHUNK, type TransferEngine} from './transferEngine';

// Lane A, end to end in a real browser over the real sealed tunnel: a voice note
// of any size gets through on a link that flaps, resumes from its acked chunks
// across a reload and an engine restart, and shows a definitive state (never a
// retry loop) when it is refused. The engine-side bytes are proven hash-equal to
// the recording. Image attachments ride the same queue: two photos complete
// under the same flapping link, hash-equal on the engine, and the one message
// wire goes out only once both are there. Phone and desktop, with screenshots
// of the state each claims.
//
// grep token: `transfer resume`.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const SHOT_DIR = 'transfer-resume';
const MiB = 1024 * 1024;

const LAYOUTS: [string, number, number][] = [
  ['phone', 390, 844],
  ['desktop', 1280, 900]
];

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
  // On the phone the chat panel slides in over the list; a screenshot taken
  // mid-slide shows both. Wait for every running animation to finish first.
  await settleAnimations(page);
}

async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    // A transition may start a frame or two after the panel is in the DOM:
    // look again after each round until a frame passes with nothing running.
    for (let round = 0; round < 10; round++) {
      await frame();
      await frame();
      // (an endless one, the thinking dots, is not a slide: ignore it)
      const running = document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);
      if (!running.length) return;
      await Promise.all(running.map((a) => a.finished.catch(() => undefined)));
    }
  });
}

// Every screenshot claims a state of the message bubble: it is taken only once
// the panel has stopped moving and the bubble is really in the viewport.
async function shot(page: Page, name: string): Promise<void> {
  await settleAnimations(page);
  await expect(page.locator('.cyc-message').last()).toBeInViewport();
  await evidenceShot(page, SHOT_DIR, name);
}

// Record every toast the page shows after the next navigation, so the reload
// tests can prove the recovery sweep said nothing (window.__cycToasts).
async function recordToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as {__cycToasts: string[]}).__cycToasts = seen;
    const note = (n: Node) => {
      if (!(n instanceof HTMLElement)) return;
      const hits = n.matches('.notyf__toast') ? [n] : [...n.querySelectorAll('.notyf__toast')];
      for (const t of hits) seen.push((t.textContent ?? '').trim());
    };
    new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach(note);
    }).observe(document.documentElement, {childList: true, subtree: true});
  });
}

// Defect #1: after a reload, bytes the transfer queue parked (a voice note in
// flight, an attachment) must never come back into the composer, and no
// "Recovered a recording" toast may be shown. The composer has no voice block
// and the toast log is empty.
async function expectNothingRecovered(page: Page): Promise<void> {
  await expect(page.locator('.cyc-block-voice')).toHaveCount(0);
  const toasts = await page.evaluate(
    () => (window as unknown as {__cycToasts?: string[]}).__cycToasts ?? []
  );
  expect(toasts.filter((t) => /recovered a recording/i.test(t))).toEqual([]);
}

// Speed the worker's backoff and keep the ack timer from firing a spurious
// "failed" while a long transfer is still in flight.
async function tuneWorker(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as {__cycTransferBackoffMs?: number}).__cycTransferBackoffMs = 100;
    (window as unknown as {__cycAckTimeoutMs?: number}).__cycAckTimeoutMs = 600_000;
  });
}

// Create a deterministic clip of `size` bytes in the page, send it as a voice
// note through the store, and return its local id and sha256 (hex) so the test
// can prove the engine ended up with byte-identical audio.
async function sendVoice(
  page: Page,
  sessionId: string,
  size: number
): Promise<{localId: number; sha: string}> {
  return page.evaluate(
    async ({s, size}) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 131 + 7) & 0xff;
      const blob = new Blob([bytes], {type: 'audio/webm'});
      const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
      const sha = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const store = (
        window as unknown as {
          __cycStore: {sendVoiceClip(id: string, b: Blob, o: {durationS?: number; text?: string}): number};
        }
      ).__cycStore;
      const localId = store.sendVoiceClip(s, blob, {durationS: 5, text: 'ship it'});
      return {localId, sha};
    },
    {s: sessionId, size}
  );
}

// Two real PNGs (canvas noise, so they do not compress) sent as one message
// through the store, exactly as the composer's press does. Returns the local
// message id and each file's sha256 (hex) and size, in file order.
async function sendImages(
  page: Page,
  sessionId: string,
  side: number
): Promise<{localId: number; shas: string[]; sizes: number[]}> {
  return page.evaluate(
    async ({s, side}) => {
      const hex = async (bytes: ArrayBuffer) =>
        [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
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
        const file = new File([blob], name, {type: 'image/png'});
        return {file, sha: await hex(await blob.arrayBuffer())};
      };
      const a = await makePng(7, 'first.png');
      const b = await makePng(99, 'second.png');
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
      const localId = store.sendAttachments(s, {
        text,
        wireText: text,
        files: [a, b].map(({file}) => ({
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
      return {localId, shas: [a.sha, b.sha], sizes: [a.file.size, b.file.size]};
    },
    {s: sessionId, side}
  );
}

const failed = (page: Page) => page.locator('.cyc-message.cyc-msg-failed');
const albumImages = (page: Page) => page.locator('.cyc-message .cyc-multipart-album img.cyc-still');
const voiceCard = (page: Page) => page.locator('.cyc-message .cyc-clip.cyc-voice');
const progress = (page: Page) => page.locator('.cyc-send-progress');

async function expectDelivered(
  page: Page,
  engine: TransferEngine,
  timeout = 60_000
): Promise<void> {
  // Delivered means the engine actually finished the transfer (not merely that a
  // still-sending bubble happens to show no progress label), and the bubble is a
  // voice card, not failed, with the pending progress gone.
  await expect.poll(() => engine.finishes(), {timeout}).toBeGreaterThanOrEqual(1);
  await expect(voiceCard(page)).toHaveCount(1, {timeout});
  await expect(progress(page)).toHaveCount(0, {timeout});
  await expect(failed(page)).toHaveCount(0, {timeout: 2_000});
}

// Delivered for an attachment message: both transfers finished on the engine,
// the engine received exactly one message wire naming both real uploadIds (in
// file order), the bytes behind each id hash-equal the file, and the bubble is
// the two-image album with the progress label gone and no failure.
async function expectImagesDelivered(
  page: Page,
  engine: TransferEngine,
  shas: string[],
  timeout: number
): Promise<void> {
  await expect.poll(() => engine.finishes(), {timeout}).toBe(2);
  await expect.poll(() => engine.utterances().length, {timeout: 20_000}).toBe(1);
  const [u] = engine.utterances();
  const ids = (u.uploads ?? []).map((x) => x.uploadId);
  expect(ids).toHaveLength(2);
  expect(ids.every((id) => id.startsWith('srv-up-'))).toBe(true);
  expect(ids.map((id) => engine.finishedShaOf(id))).toEqual(shas);
  await expect(albumImages(page)).toHaveCount(2, {timeout: 10_000});
  await expect(progress(page)).toHaveCount(0, {timeout: 10_000});
  await expect(failed(page)).toHaveCount(0, {timeout: 2_000});
}

for (const [layout, width, height] of LAYOUTS) {
  test(`chaos flap: a 4 MiB clip completes hash-equal, progress then delivered (${layout})`, async ({
    page
  }) => {
    test.setTimeout(150_000);
    const engine: TransferEngine = await startTransferEngine({chaos: 600 * 1024});
    const port = engine.port;
    const sid = sessionIdFor(port);
    try {
      await bootPinned(page, port, {size: {width, height}});
      await openChat(page);
      await tuneWorker(page);

      const {sha} = await sendVoice(page, sid, 4 * MiB);
      // The bubble shows progress while the chunks fight through the flapping
      // pipe.
      await expect(progress(page)).toBeVisible({timeout: 30_000});
      await shot(page, `${layout}-progress`);

      await expectDelivered(page, engine, 120_000);
      await shot(page, `${layout}-delivered`);

      // The pipe really did flap several times, and the engine ended up with
      // byte-identical audio.
      expect(engine.dropCount()).toBeGreaterThanOrEqual(3);
      expect(engine.finishes()).toBe(1);
      expect(engine.finishedSha()).toBe(sha);
    } finally {
      await engine.close();
    }
  });

  test(`reload mid-transfer resumes from acked, not zero (${layout})`, async ({page}) => {
    test.setTimeout(120_000);
    // Slow the chunks so the reload lands mid-transfer.
    const engine: TransferEngine = await startTransferEngine({putDelayMs: 200});
    const port = engine.port;
    const sid = sessionIdFor(port);
    try {
      await bootPinned(page, port, {size: {width, height}});
      await openChat(page);
      await tuneWorker(page);

      const {sha} = await sendVoice(page, sid, 2 * MiB); // 8 chunks
      // Wait until at least one chunk has landed, then reload mid-transfer.
      await expect.poll(() => engine.putCount(), {timeout: 30_000}).toBeGreaterThanOrEqual(2);
      await recordToasts(page);
      await page.reload();
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      await openChat(page);
      await tuneWorker(page);

      await expectDelivered(page, engine, 90_000);
      expect(engine.finishedSha()).toBe(sha);
      // The in-flight note's bytes stayed the message's: the composer is empty
      // and the recovery sweep said nothing (defect #1).
      await expectNothingRecovered(page);

      // Resumed from acked: chunk 0 was PUT exactly once. A restart-from-zero
      // would have PUT it (and every early chunk) again after the reload.
      const zeros = engine.putLog().filter((n) => n === 0).length;
      expect(zeros).toBe(1);
      // Total PUTs are close to the chunk count (at most one chunk re-sent for
      // the one that was in flight at reload), never the ~2x of a full restart.
      const count = Math.ceil((2 * MiB) / CHUNK);
      expect(engine.putCount()).toBeLessThanOrEqual(count + 1);
      expect(engine.putCount()).toBeGreaterThanOrEqual(count);
      await shot(page, `${layout}-reload-resumed`);
    } finally {
      await engine.close();
    }
  });

  test(`engine restart mid-transfer: the transfer completes on reconnect (${layout})`, async ({
    page
  }) => {
    test.setTimeout(150_000);
    const engine: TransferEngine = await startTransferEngine({putDelayMs: 250});
    const port = engine.port;
    const sid = sessionIdFor(port);
    try {
      await bootPinned(page, port, {size: {width, height}});
      await openChat(page);
      await tuneWorker(page);

      const {sha} = await sendVoice(page, sid, 1536 * 1024); // 6 chunks
      await expect.poll(() => engine.putCount(), {timeout: 30_000}).toBeGreaterThanOrEqual(1);

      // The engine goes away for 20 s mid-transfer, then returns on the same
      // port (same identity). The app resumes on the connected edge.
      await engine.stop();
      await page.waitForTimeout(20_000);
      await engine.start();

      await expectDelivered(page, engine, 60_000);
      expect(engine.finishedSha()).toBe(sha);
      await shot(page, `${layout}-restart-completed`);
    } finally {
      await engine.close();
    }
  });

  test(`chaos flap: two images complete hash-equal as one message, progress then delivered (${layout})`, async ({
    page
  }) => {
    test.setTimeout(150_000);
    const engine: TransferEngine = await startTransferEngine({chaos: 600 * 1024, echoUtterances: true});
    const port = engine.port;
    const sid = sessionIdFor(port);
    try {
      await bootPinned(page, port, {size: {width, height}});
      await openChat(page);
      await tuneWorker(page);

      // Two ~1.5 MiB noise PNGs (640x640 RGBA does not compress).
      const {shas} = await sendImages(page, sid, 640);
      // The album is on screen at once with a progress label while both files
      // fight through the flapping pipe; no wire goes out yet.
      await expect(albumImages(page)).toHaveCount(2, {timeout: 10_000});
      await expect(progress(page)).toBeVisible({timeout: 30_000});
      expect(engine.utterances()).toHaveLength(0);
      await shot(page, `${layout}-images-progress`);

      await expectImagesDelivered(page, engine, shas, 120_000);
      await shot(page, `${layout}-images-delivered`);

      expect(engine.dropCount()).toBeGreaterThanOrEqual(2);
    } finally {
      await engine.close();
    }
  });

  test(`reload mid-transfer: two images resume their rows and the intent (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const engine: TransferEngine = await startTransferEngine({putDelayMs: 200, echoUtterances: true});
    const port = engine.port;
    const sid = sessionIdFor(port);
    try {
      await bootPinned(page, port, {size: {width, height}});
      await openChat(page);
      await tuneWorker(page);

      // Two ~3 MiB noise PNGs (12 chunks each): at 200 ms a chunk, the reload
      // below lands while both are still moving.
      const {shas, sizes} = await sendImages(page, sid, 1024);
      // Both files have landed at least one chunk, then reload mid-transfer.
      await expect.poll(() => engine.putCount(), {timeout: 30_000}).toBeGreaterThanOrEqual(3);
      expect(engine.finishes()).toBe(0);
      await recordToasts(page);
      await page.reload();
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      await openChat(page);
      await tuneWorker(page);

      // The intent came back from the outbox: the album bubble is there again,
      // still sending, before either file is done.
      await expect(albumImages(page)).toHaveCount(2, {timeout: 10_000});
      expect(engine.utterances()).toHaveLength(0);

      await expectImagesDelivered(page, engine, shas, 90_000);
      await expectNothingRecovered(page);
      await shot(page, `${layout}-images-reload-resumed`);

      // Resumed from acked, per file: chunk 0 was PUT exactly once for each of
      // the two transfers, and the total is at most one re-sent chunk per file
      // (the one in flight at reload), never a restart from zero.
      const zeros = engine.putLog().filter((n) => n === 0).length;
      expect(zeros).toBe(2);
      const chunks = sizes.reduce((n, size) => n + Math.ceil(size / CHUNK), 0);
      expect(engine.putCount()).toBeGreaterThanOrEqual(chunks);
      expect(engine.putCount()).toBeLessThanOrEqual(chunks + 2);
    } finally {
      await engine.close();
    }
  });

  test(`oversize is a definitive failure with no retry loop (${layout})`, async ({page}) => {
    test.setTimeout(90_000);
    // Cap user-audio tiny so a modest clip is refused at begin (413), the exact
    // definitive path a real 400 MB-over-cap note would hit.
    const engine: TransferEngine = await startTransferEngine({
      capOverride: {'user-audio': 256 * 1024}
    });
    const port = engine.port;
    const sid = sessionIdFor(port);
    try {
      await bootPinned(page, port, {size: {width, height}});
      await openChat(page);
      await tuneWorker(page);

      await sendVoice(page, sid, 1 * MiB); // over the 256 KiB test cap
      // The bubble settles into a definitive failed state.
      await expect(failed(page)).toHaveCount(1, {timeout: 30_000});
      await expect(page.locator('.cyc-voice-failed')).toBeVisible();
      // The bubble names the reason and the cap the engine's 413 carried
      // ({max: 256 KiB}), not the generic "recording was not saved" copy.
      await expect(page.locator('.cyc-voice-failed')).toHaveText(/not sent: too large \(over 256 KB\)/);
      await shot(page, `${layout}-oversize-failed`);

      // No retry loop: after the definitive 413 the engine sees no more begins.
      const finishesA = engine.putCount();
      await page.waitForTimeout(3_000);
      expect(engine.putCount()).toBe(finishesA);
      // and it stays failed (does not silently flip back to sending).
      await expect(failed(page)).toHaveCount(1);
    } finally {
      await engine.close();
    }
  });
}
