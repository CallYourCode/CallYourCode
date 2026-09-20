import {test, expect, chromium, type BrowserContext, type Page} from '@playwright/test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bootPinned, installIsolation, PAGE} from './rig';
import {startTransferEngine, CHAT, type TransferEngine} from './transferEngine';
import {LAYOUTS, backToList, intentRows, openChat, syncStatus, waitLive} from './offlineKit';

// Offline design v2, section 3: the box clears only once the send's rows are on
// disk. A tab killed between the tap on send and the intent's commit must not
// lose the note: it is either an intent row (sent after the reload) or still
// in the box, never both and never neither. The store is made slow by holding
// the intents store busy from a second connection, so the intent's write
// cannot land before the kill.
//
// grep token: `offline kill`.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const VOICE = '#cyc-thread-pane .cyc-block-voice';
const INPUT = '#cyc-thread-pane .cyc-composer-input';
const sendKind = (r: {kind: string}) => r.kind.startsWith('send-');

async function tune(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as {__cycTransferBackoffMs?: number}).__cycTransferBackoffMs = 100;
  });
}

// A recording staged in the box the way the recorder leaves one: a voice card
// with its bytes attached.
async function stageVoice(page: Page, size: number, text: string): Promise<void> {
  await page.evaluate(
    ({size, text}) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 131 + 7) & 0xff;
      (
        window as unknown as {
          __cycComposerAddVoice: (c: {durationS: number; text: string}, b: ArrayBuffer, m: string) => void;
        }
      ).__cycComposerAddVoice({durationS: 3, text}, bytes.buffer, 'audio/webm');
    },
    {size, text}
  );
}

function compositionCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((res, rej) => {
        const r = indexedDB.open('cyc-clips');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const c = db.transaction('compositions', 'readonly').objectStore('compositions').count();
          c.onsuccess = () => {
            db.close();
            res(c.result);
          };
          c.onerror = () => {
            db.close();
            rej(c.error);
          };
        };
      })
  );
}

// Hold the intents store busy for `ms` from a second connection: every write
// the app makes to it queues behind this one. Resolves once the hold is on.
async function holdIntents(page: Page, ms: number): Promise<void> {
  await page.evaluate(
    (ms) =>
      new Promise<void>((res, rej) => {
        const r = indexedDB.open('cyc-clips');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const s = r.result.transaction('intents', 'readwrite').objectStore('intents');
          const end = performance.now() + ms;
          const spin = () => {
            if (performance.now() < end) s.count().onsuccess = spin;
          };
          const first = s.count();
          first.onsuccess = () => {
            res();
            spin();
          };
          first.onerror = () => rej(first.error);
        };
      }),
    ms
  );
}

async function pressSend(page: Page): Promise<void> {
  await page.locator(INPUT).click();
  await page.keyboard.press('Enter');
}

// The renderer dies on the spot (no unload, no chance for a pending write to
// commit), then the profile closes.
async function kill(ctx: BrowserContext, page: Page): Promise<void> {
  await page.goto('chrome://crash').catch(() => undefined);
  await ctx.close().catch(() => undefined);
}

async function bootCold(page: Page): Promise<void> {
  await installIsolation(page);
  await page.goto(`${PAGE}/?testhooks=1&v=${Date.now()}`);
  await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
}

async function persistent(
  dir: string,
  size: {width: number; height: number}
): Promise<{ctx: BrowserContext; page: Page}> {
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true,
    viewport: size,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return {ctx, page};
}

// Offline, a voice note in the box, its composition on disk.
async function stagedOffline(
  page: Page,
  ctx: BrowserContext,
  engine: TransferEngine,
  layout: 'phone' | 'desktop'
): Promise<void> {
  await engine.stop();
  await page.reload();
  await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
  await ctx.setOffline(true);
  await expect.poll(() => syncStatus(page), {timeout: 10_000}).toBe('offline');
  await backToList(page, layout);
  await openChat(page, CHAT);
  await tune(page);
  await stageVoice(page, 300_000, 'gap note');
  await expect(page.locator(VOICE)).toBeVisible();
  await expect.poll(() => compositionCount(page), {timeout: 10_000}).toBe(1);
}

for (const {layout, size} of LAYOUTS) {
  test(`send tapped, intent write still pending, tab killed: the note is back in the box and sends once (${layout})`, async () => {
    test.setTimeout(150_000);
    const engine = await startTransferEngine({echoUtterances: true});
    const dir = mkdtempSync(join(tmpdir(), 'cyc-kill-'));
    let ctx: BrowserContext | null = null;
    try {
      let page: Page;
      ({ctx, page} = await persistent(dir, size));
      await bootPinned(page, engine.port, {size});
      await openChat(page, CHAT);
      await waitLive(page);
      await stagedOffline(page, ctx, engine, layout);

      // The intent store is busy: the send's row cannot commit. The box has to
      // keep the note until it does.
      await holdIntents(page, 10_000);
      await pressSend(page);
      await page.waitForTimeout(500);
      await expect(page.locator(VOICE), 'the box cleared before the row was on disk').toBeVisible();
      await kill(ctx, page);
      ctx = null;

      ({ctx, page} = await persistent(dir, size));
      await bootCold(page);
      await backToList(page, layout);
      await openChat(page, CHAT);
      await expect(page.locator(VOICE), 'the note is gone').toBeVisible({timeout: 15_000});
      expect((await intentRows(page)).filter(sendKind)).toHaveLength(0);
      await tune(page);

      // Sent again with the engine back, it lands once.
      await engine.start();
      await waitLive(page, 30_000);
      await pressSend(page);
      await expect.poll(() => engine.utterances().length, {timeout: 40_000}).toBe(1);
      await expect(page.locator(VOICE)).toHaveCount(0);
      await expect
        .poll(() => intentRows(page).then((r) => r.filter(sendKind).length), {timeout: 20_000})
        .toBe(0);
      await page.waitForTimeout(2000);
      expect(engine.utterances()).toHaveLength(1);
    } finally {
      if (ctx) await ctx.close().catch(() => undefined);
      await engine.close();
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test(`send tapped, intent row on disk, tab killed: the note lands once after the reload (${layout})`, async () => {
    test.setTimeout(150_000);
    const engine = await startTransferEngine({echoUtterances: true});
    const dir = mkdtempSync(join(tmpdir(), 'cyc-kill-'));
    let ctx: BrowserContext | null = null;
    try {
      let page: Page;
      ({ctx, page} = await persistent(dir, size));
      await bootPinned(page, engine.port, {size});
      await openChat(page, CHAT);
      await waitLive(page);
      await stagedOffline(page, ctx, engine, layout);

      await pressSend(page);
      await expect
        .poll(() => intentRows(page).then((r) => r.filter(sendKind).length), {timeout: 10_000})
        .toBe(1);
      await kill(ctx, page);
      ctx = null;

      ({ctx, page} = await persistent(dir, size));
      await bootCold(page);
      await backToList(page, layout);
      await openChat(page, CHAT);
      expect((await intentRows(page)).filter(sendKind)).toHaveLength(1);
      // The intent is on disk, so the box's copy is not: the composition went
      // in the intent's own write, and the note is not back in the box.
      await page.waitForTimeout(1500);
      await expect(page.locator(VOICE), 'the note is in the box as well as queued').toHaveCount(0);
      expect(await compositionCount(page)).toBe(0);
      await tune(page);

      await engine.start();
      await expect.poll(() => engine.utterances().length, {timeout: 40_000}).toBe(1);
      await expect
        .poll(() => intentRows(page).then((r) => r.filter(sendKind).length), {timeout: 20_000})
        .toBe(0);
      await page.waitForTimeout(2000);
      expect(engine.utterances()).toHaveLength(1);
    } finally {
      if (ctx) await ctx.close().catch(() => undefined);
      await engine.close();
      rmSync(dir, {recursive: true, force: true});
    }
  });
}
