import {expect, type Page} from '@playwright/test';
import {createRequire} from 'node:module';
import type {ChatEngine} from './chatEngine';

/* Shared pieces of the offline acceptance specs (offline design v2, section
 * 10): the two layouts, the console log capture (cyclog writes one debug line
 * per event), the intents store reader, the chat open/back/page-back drivers,
 * and the "offline" transition every spec starts from. */

export const LAYOUTS: {layout: 'phone' | 'desktop'; size: {width: number; height: number}}[] = [
  {layout: 'phone', size: {width: 390, height: 844}},
  {layout: 'desktop', size: {width: 1280, height: 900}}
];

export const sidOf = (port: number, paneId: string) => `ws://127.0.0.1:${port}/ws|${paneId}`;

// One cyclog line: `<iso> app <event> dev=.. pg=.. key=value ...`. `field(k)`
// gives the raw value (JSON for non-strings, quoted when it holds whitespace).
export type LogLine = {
  event: string;
  raw: string;
  at: number;
  field(k: string): string | undefined;
};

export type LogCapture = {
  lines: LogLine[];
  of(event: string): LogLine[];
  has(event: string): boolean;
  // Lines with this event that landed after `since` (a Date.now() mark).
  since(event: string, since: number): LogLine[];
};

export function captureLog(page: Page): LogCapture {
  const lines: LogLine[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'debug') return;
    const raw = msg.text();
    const parts = raw.split(' ');
    if (parts.length < 3 || parts[1] !== 'app') return;
    lines.push({
      event: parts[2],
      raw,
      at: Date.now(),
      field: (k: string) => {
        const m = raw.match(
          new RegExp('(?:^|\\s)' + k.replace(/\./g, '\\.') + '=("(?:[^"\\\\]|\\\\.)*"|\\S+)')
        );
        if (!m) return undefined;
        const v = m[1];
        return v.startsWith('"') ? (JSON.parse(v) as string) : v;
      }
    });
  });
  return {
    lines,
    of: (event) => lines.filter((l) => l.event === event),
    has: (event) => lines.some((l) => l.event === event),
    since: (event, since) => lines.filter((l) => l.event === event && l.at >= since)
  };
}

export type IntentRow = {
  id: string;
  engineKey: string;
  sessionId?: string;
  kind: string;
  state: string;
  payload: Record<string, unknown>;
};

// Every row of the cyc-clips `intents` store, read straight from IndexedDB.
export function intentRows(page: Page): Promise<IntentRow[]> {
  return page.evaluate(
    () =>
      new Promise<IntentRow[]>((res, rej) => {
        const r = indexedDB.open('cyc-clips');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const db = r.result;
          try {
            const g = db.transaction('intents', 'readonly').objectStore('intents').getAll();
            g.onsuccess = () => {
              db.close();
              res(g.result as IntentRow[]);
            };
            g.onerror = () => {
              db.close();
              rej(g.error);
            };
          } catch (e) {
            db.close();
            rej(e);
          }
        };
      })
  );
}

export const syncStatus = (page: Page) =>
  page.evaluate(() => document.querySelector('.cyc-sync-status')?.textContent ?? '');

export const toastCount = (page: Page) => page.locator('.cyc-toast, .notyf__toast').count();

export type Msg = {
  id: string;
  role: string;
  text: string;
  ts: number;
  status?: string;
  failReason?: string;
  msgId?: string;
  cid?: string;
  seq?: number;
};

export const heldMessages = (page: Page, sid: string) =>
  page.evaluate(
    (s) => (window as unknown as {__cycMessages(id: string): Msg[]}).__cycMessages(s),
    sid
  );

export const domMessageCount = (page: Page) =>
  page.locator('.cyc-message-list-inner .cyc-message:not(.cyc-msg-system)').count();

export const row = (page: Page, name: string) =>
  page.locator('.cyc-session-entry', {hasText: name}).first();

export async function openChat(page: Page, name: string): Promise<void> {
  await row(page, name).click();
  await page.waitForSelector('.cyc-message-list-scroll', {timeout: 15_000});
}

// Phone hides the list behind the chat; the chat header carries the back button.
// A reload restores the engaged chat, so a phone that was in a chat comes back
// in it: nothing to do when the list is already the view.
export async function backToList(page: Page, layout: string): Promise<void> {
  if (layout !== 'phone') return;
  if ((await page.getAttribute('#cyc-columns', 'data-view')) === 'list') return;
  await page.locator('.cyc-mast .cyc-pane-back').first().click();
  await page.waitForSelector('#cyc-columns[data-view="list"]');
  await page.waitForSelector('.cyc-session-entry');
}

// Ask for the page before the lowest held one: scroll the list to its top and
// give it the wheel nudge the pager listens for, until the held count grows.
export async function pageBack(page: Page, sid: string, expectHeld: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => {
          const el = document.querySelector('.cyc-message-list-scroll');
          if (!el) return;
          el.scrollTop = 0;
          el.dispatchEvent(new WheelEvent('wheel', {deltaY: -120, bubbles: true}));
        });
        await page.waitForTimeout(250);
        return (await heldMessages(page, sid)).length;
      },
      {timeout: 20_000, message: `the earlier page never painted (want ${expectHeld} held)`}
    )
    .toBeGreaterThanOrEqual(expectHeld);
}

export async function typeAndSend(page: Page, text: string): Promise<void> {
  const input = page.locator('#cyc-thread-pane .cyc-composer-input');
  await input.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

// Section 10 "GIVEN offline": the engine is gone, the app reloads and settles
// on "offline", then the browser goes offline too. The reload runs while the
// static host is still reachable, so it does not depend on the boot-registered
// precache worker; that worker serves the same shell + hashed chunks from its
// cache when they are warm, which is what offline-boot.spec proves directly. The
// "offline" this drives is the engine/websocket being down, asserted below.
export async function goOffline(page: Page, rig: ChatEngine): Promise<void> {
  await rig.stop();
  await page.reload();
  await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
  await page.context().setOffline(true);
  await expect
    .poll(() => syncStatus(page), {timeout: 10_000, message: 'the status word never said offline'})
    .toBe('offline');
}

export async function comeBack(page: Page, rig: ChatEngine): Promise<void> {
  await rig.start();
  await page.context().setOffline(false);
}

export async function waitLive(page: Page, timeout = 20_000): Promise<void> {
  await expect
    .poll(() => syncStatus(page), {timeout, message: 'the status word did not clear (live)'})
    .toBe('');
}

// Playwright's own image comparator (the one behind toHaveScreenshot):
// `null` when the mismatch is within budget, else a message naming the ratio.
const req = createRequire(__filename);
type Comparator = (
  actual: Buffer,
  expected: Buffer,
  o: {maxDiffPixelRatio: number; comparator: 'pixelmatch'}
) => null | {errorMessage: string};
export function pixelDiff(a: Buffer, b: Buffer, maxDiffPixelRatio: number): string | null {
  const bundle = req('playwright-core/lib/coreBundle') as {
    utils: {getComparator(mime: string): Comparator};
  };
  const r = bundle.utils.getComparator('image/png')(a, b, {
    maxDiffPixelRatio,
    comparator: 'pixelmatch'
  });
  return r ? r.errorMessage : null;
}
