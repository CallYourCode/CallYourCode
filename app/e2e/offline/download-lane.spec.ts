import {test, expect, type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {bootPinned} from './rig';
import {startTransferEngine, CHAT, type TransferEngine} from './transferEngine';

// THE DOWNLOAD LANE, end to end in a real browser over the real sealed tunnel
// (download-lane, 2026-10-03). The owner tapped a 13.5 MB file: a toast sat on
// "Downloading..." forever, nothing else sent until a reload. A shown file now
// downloads in ranged parts straight into the browser's own downloads (the
// service worker streams it), with progress on its card; a pipe that drops
// mid-file resumes from the bytes already saved; an engine that stops answering
// fails, visibly, within the stall bound instead of hanging.
//
// grep token: `download lane`.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');
test.use({acceptDownloads: true});

const SIZE = 3 * 262144 + 777;

function fileBytes(): Uint8Array {
  const b = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) b[i] = (i * 31 + 11) % 251;
  return b;
}
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');

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

async function bootWithCard(page: Page, eng: TransferEngine, bytes: Uint8Array): Promise<void> {
  await bootPinned(page, eng.port, {size: {width: 1280, height: 900}});
  // the browser download streams through the worker: wait for it to control the page
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, {timeout: 15_000});
  await openChat(page);
  eng.showBinary('study-pack.zip', bytes, 'application/zip');
  await page.waitForSelector('.cyc-download-card', {timeout: 10_000});
}

const cardSize = (page: Page) =>
  page.locator('.cyc-download-card').last().locator('.cyc-doc-size').textContent();

test('download lane: one tap streams the file into the browser download, exact bytes', async ({
  page
}) => {
  const eng = await startTransferEngine();
  try {
    const bytes = fileBytes();
    await bootWithCard(page, eng, bytes);
    const dl = page.waitForEvent('download', {timeout: 30_000});
    await page.locator('.cyc-download-card').last().click();
    const d = await dl;
    // the browser's own download, fed by the worker: not a blob saved after the fact
    expect(new URL(d.url()).pathname).toMatch(/^\/__cyc_dl\//);
    expect(d.suggestedFilename()).toBe('study-pack.zip');
    expect(sha(readFileSync((await d.path())!))).toBe(sha(bytes));
    await expect.poll(() => cardSize(page)).toBe('Downloaded');
    // in ranged parts, not one answer
    expect(eng.docGets().length).toBeGreaterThanOrEqual(4);
  } finally {
    await eng.close();
  }
});

test('download lane: a pipe drop mid-file resumes from the saved bytes and completes', async ({
  page
}) => {
  const eng = await startTransferEngine();
  try {
    const bytes = fileBytes();
    await bootWithCard(page, eng, bytes);
    eng.dropDocAfter(2);
    const dl = page.waitForEvent('download', {timeout: 30_000});
    await page.locator('.cyc-download-card').last().click();
    const d = await dl;
    expect(sha(readFileSync((await d.path())!))).toBe(sha(bytes));
    expect(eng.dropCount()).toBe(1);
    await expect.poll(() => cardSize(page)).toBe('Downloaded');
  } finally {
    await eng.close();
  }
});

test('download lane: an engine that stops answering fails visibly within the bound', async ({
  page
}) => {
  const eng = await startTransferEngine();
  try {
    const bytes = fileBytes();
    await bootWithCard(page, eng, bytes);
    await page.evaluate(() => {
      const w = window as unknown as {__cycDownloadStallMs?: number; __cycDownloadPartMs?: number};
      w.__cycDownloadStallMs = 3_000;
      w.__cycDownloadPartMs = 1_000;
    });
    eng.holdDocParts(true);
    const t = Date.now();
    await page.locator('.cyc-download-card').last().click();
    await expect.poll(() => cardSize(page), {timeout: 15_000}).toMatch(/Download failed/);
    expect(Date.now() - t).toBeLessThan(12_000);
    // the chat is not held by it: the card is a retry, and a retry downloads
    eng.holdDocParts(false);
    const dl = page.waitForEvent('download', {timeout: 30_000});
    await page.locator('.cyc-download-card').last().click();
    const d = await dl;
    expect(sha(readFileSync((await d.path())!))).toBe(sha(bytes));
  } finally {
    await eng.close();
  }
});
