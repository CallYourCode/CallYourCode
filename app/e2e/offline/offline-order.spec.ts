import {test, expect, chromium, type BrowserContext, type Page} from '@playwright/test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bootPinned, installIsolation, PAGE} from './rig';
import {startTransferEngine, sessionIdFor, CHAT, type TransferEngine} from './transferEngine';
import {
  LAYOUTS,
  backToList,
  heldMessages,
  intentRows,
  openChat,
  syncStatus,
  typeAndSend,
  waitLive
} from './offlineKit';

// Offline design v2, section 3: one queue per engine, FIFO, one intent in
// flight. A voice note or a file whose bytes are still moving holds the sends
// behind it; it never lets a later text overtake it. Queued offline in the
// order voice, text, file, with the tab killed in between, the three reach the
// engine once each and in that order.
//
// grep token: `offline order`.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const sendKind = (r: {kind: string}) => r.kind.startsWith('send-');

async function tune(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as {__cycTransferBackoffMs?: number}).__cycTransferBackoffMs = 100;
  });
}

async function sendVoice(page: Page, sid: string, size: number, text: string): Promise<void> {
  await page.evaluate(
    ({s, size, text}) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 131 + 7) & 0xff;
      const blob = new Blob([bytes], {type: 'audio/webm'});
      const store = (
        window as unknown as {
          __cycStore: {sendVoiceClip(id: string, b: Blob, o: {durationS?: number; text?: string}): number};
        }
      ).__cycStore;
      store.sendVoiceClip(s, blob, {durationS: 3, text});
    },
    {s: sid, size, text}
  );
}

async function sendFile(page: Page, sid: string, size: number, text: string): Promise<void> {
  await page.evaluate(
    ({s, size, text}) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 17 + 3) & 0xff;
      const file = new File([bytes], 'note.txt', {type: 'text/plain'});
      const store = (
        window as unknown as {
          __cycStore: {sendAttachments(id: string, o: Record<string, unknown>): number};
        }
      ).__cycStore;
      store.sendAttachments(s, {
        text,
        wireText: text,
        files: [{key: crypto.randomUUID(), file, name: file.name, mime: file.type, at: 0, wireAt: 0}],
        words: []
      });
    },
    {s: sid, size, text}
  );
}

// A fresh page on a profile that already holds the config and keys: no rig
// registration, the engine is down while it boots from the cache.
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

for (const {layout, size} of LAYOUTS) {
  test(`voice, text, file queued offline, tab killed, engine up: land once each, in order (${layout})`, async () => {
    test.setTimeout(150_000);
    const engine: TransferEngine = await startTransferEngine({echoUtterances: true});
    const sid = sessionIdFor(engine.port);
    const dir = mkdtempSync(join(tmpdir(), 'cyc-order-'));
    let ctx: BrowserContext | null = null;
    try {
      let page: Page;
      ({ctx, page} = await persistent(dir, size));
      await bootPinned(page, engine.port, {size});
      await openChat(page, CHAT);
      await waitLive(page);

      // Offline: the engine is gone, the app reloads onto the cache, the
      // browser goes offline too.
      await engine.stop();
      await page.reload();
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      await ctx.setOffline(true);
      await expect.poll(() => syncStatus(page), {timeout: 10_000}).toBe('offline');
      await backToList(page, layout);
      await openChat(page, CHAT);
      await tune(page);

      await sendVoice(page, sid, 300_000, 'voice one');
      await typeAndSend(page, 'text two');
      await sendFile(page, sid, 20_000, 'file three');
      await expect
        .poll(() => intentRows(page).then((r) => r.filter(sendKind).length), {timeout: 10_000})
        .toBe(3);
      const rows = (await intentRows(page)).filter(sendKind);
      const cidOf = (k: string) => String(rows.find((r) => r.kind === k)!.payload.cid);
      const cids = {voice: cidOf('send-voice'), text: cidOf('send-text'), files: cidOf('send-files')};
      // The transfer rows land a moment after the intents (enqueue parks the
      // bytes first): let them, then kill the tab.
      await page.waitForTimeout(1500);

      // The whole context goes; a fresh one opens on the same profile while
      // the engine is still down.
      await ctx.close();
      ctx = null;
      ({ctx, page} = await persistent(dir, size));
      await bootCold(page);
      await backToList(page, layout);
      await openChat(page, CHAT);
      const kept = (await intentRows(page)).filter(sendKind);
      expect(kept.map((r) => r.kind).sort()).toEqual(['send-files', 'send-text', 'send-voice']);
      await tune(page);

      await engine.start();
      await expect
        .poll(() => engine.utterances().length, {timeout: 40_000, message: 'not all three landed'})
        .toBe(3);
      await expect
        .poll(() => intentRows(page).then((r) => r.filter(sendKind).length), {timeout: 20_000})
        .toBe(0);
      // Nothing more goes out once the queue is empty.
      await page.waitForTimeout(3000);
      const utts = engine.utterances();
      expect(utts.filter((u) => u.cid === cids.voice)).toHaveLength(1);
      expect(utts.filter((u) => u.cid === cids.text)).toHaveLength(1);
      expect(utts.filter((u) => u.cid === cids.files)).toHaveLength(1);
      expect(utts).toHaveLength(3);
      // FIFO: the voice note went first, its bytes moved, then the text, then
      // the file.
      expect(utts.map((u) => u.text)).toEqual(['voice one', 'text two', 'file three']);
      const final = await heldMessages(page, sid);
      for (const t of ['voice one', 'text two', 'file three']) {
        expect(final.find((m) => m.text === t)?.status, t).toBe('delivered');
      }
    } finally {
      if (ctx) await ctx.close().catch(() => undefined);
      await engine.close();
      rmSync(dir, {recursive: true, force: true});
    }
  });
}

// A refused head. The voice note's bytes are over the engine's cap: its
// transfer is refused at begin (413, gone) and the note fails for good. The
// text queued behind it goes on that failure alone, within the normal drain
// latency, with no tap, no new send and no edge, and the status word settles.
for (const {layout, size} of LAYOUTS) {
  test(`a voice note refused at the head of the queue: the text behind it lands, the status settles (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const engine: TransferEngine = await startTransferEngine({
      echoUtterances: true,
      capOverride: {'user-audio': 1024}
    });
    const sid = sessionIdFor(engine.port);
    try {
      await bootPinned(page, engine.port, {size});
      await openChat(page, CHAT);
      await waitLive(page);
      await tune(page);

      // Queue the note while the engine is down, so the text lands behind it.
      await engine.stop();
      await expect.poll(() => syncStatus(page), {timeout: 15_000}).not.toBe('');
      await sendVoice(page, sid, 50_000, 'refused note');
      await typeAndSend(page, 'text behind');
      await expect
        .poll(() => intentRows(page).then((r) => r.filter(sendKind).length), {timeout: 10_000})
        .toBe(2);

      await engine.start();
      await expect
        .poll(() => heldMessages(page, sid).then((m) => m.find((x) => x.text === 'refused note')?.status), {
          timeout: 40_000
        })
        .toBe('failed');
      // The text goes on the refusal itself, not on some later kick.
      await expect
        .poll(() => engine.utterances().map((u) => u.text), {
          timeout: 5_000,
          message: 'the text behind the refused note waited for an unrelated kick'
        })
        .toEqual(['text behind']);
      await expect
        .poll(() => heldMessages(page, sid).then((m) => m.find((x) => x.text === 'text behind')?.status), {
          timeout: 20_000
        })
        .toBe('delivered');
      await waitLive(page);

      // The note stays failed with its reason, and nothing more goes out.
      await page.waitForTimeout(2_000);
      expect(engine.utterances().map((u) => u.text)).toEqual(['text behind']);
      expect((await heldMessages(page, sid)).find((x) => x.text === 'refused note')?.status).toBe('failed');
      const rows = (await intentRows(page)).filter(sendKind);
      expect(rows.map((r) => [r.kind, r.state])).toEqual([['send-voice', 'failed']]);
    } finally {
      await engine.close();
    }
  });
}
