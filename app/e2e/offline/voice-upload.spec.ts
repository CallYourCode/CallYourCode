import {test, expect, type Page} from '@playwright/test';
import {bootPinned, evidenceShot} from './rig';
import {startTransferEngine, sessionIdFor, CHAT, type TransferEngine} from './transferEngine';

// The honest voice-note send, end to end in a real browser. A voice note's
// payload now rides the resumable transfer queue (POST /transfer/*), so the
// bubble is honest the whole way: a row from the first frame, progress as the
// chunks land, then a delivered voice card once the engine finishes the transfer
// and the message wire (naming the clip) goes out. Phone and desktop, with a
// screenshot of each state it claims.
//
// grep token: `voice upload honesty`.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

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

async function sendVoice(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (s) => {
    (window as unknown as {__cycAckTimeoutMs?: number}).__cycAckTimeoutMs = 600_000;
    (window as unknown as {__cycTransferBackoffMs?: number}).__cycTransferBackoffMs = 100;
    const bytes = new Uint8Array(1024 * 1024); // four chunks, slow enough to watch progress
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 3) & 0xff;
    const blob = new Blob([bytes], {type: 'audio/webm'});
    (
      window as unknown as {__cycStore: {sendVoiceClip(id: string, b: Blob, o: object): number}}
    ).__cycStore.sendVoiceClip(s, blob, {durationS: 3, text: 'ship it'});
  }, sessionId);
}

async function run(page: Page, label: string, w: number, h: number) {
  const engine: TransferEngine = await startTransferEngine({putDelayMs: 400});
  const sessionId = sessionIdFor(engine.port);
  try {
    await bootPinned(page, engine.port, {size: {width: w, height: h}});
    await openChat(page);

    await sendVoice(page, sessionId);
    await expect.poll(() => engine.putCount(), {timeout: 15_000}).toBeGreaterThanOrEqual(1);

    // 1) Progress on the bubble while the transfer moves the chunks.
    await expect(page.locator('.cyc-send-progress')).toBeVisible({timeout: 20_000});
    await evidenceShot(page, '', `voice-upload-${label}-progress`);

    // 2) Delivered: a voice card, no failed state, no lingering progress.
    await expect(page.locator('.cyc-message .cyc-clip.cyc-voice')).toHaveCount(1, {timeout: 30_000});
    await expect(page.locator('.cyc-message.cyc-msg-failed')).toHaveCount(0);
    await expect(page.locator('.cyc-send-progress')).toHaveCount(0, {timeout: 30_000});
    expect(engine.finishes()).toBe(1);
    await evidenceShot(page, '', `voice-upload-${label}-delivered`);
  } finally {
    await engine.close();
  }
}

test('voice upload honesty: progress then delivered (phone)', async ({page}) => {
  test.setTimeout(90_000);
  await run(page, 'phone', 390, 844);
});

test('voice upload honesty: progress then delivered (desktop)', async ({page}) => {
  test.setTimeout(90_000);
  await run(page, 'desktop', 1280, 800);
});
