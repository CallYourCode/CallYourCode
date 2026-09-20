import {test, expect, type Page} from '@playwright/test';
import {bootPinned, evidenceShot} from './rig';
import {startEngine, type TestEngine} from './engine';

// The offline-first promise, end to end: open the app with the engine DEAD and
// see everything you had last time -- the conversation list AND a chat's history
// -- painted from IndexedDB with no network. Then, when the engine comes back on
// the SAME port (same identity, so the seal re-establishes), the header status
// word clears and new/grown history diff-merges into the open thread without a
// full remount. Proven for phone and desktop.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const SESSION = 'coldchat';
const USER = 'cold';
const HOST = 'coldbox';
const PAGE_SIZE = 100;
const BASE = 1_700_000_000_000;

const SHOT_DIR = 'cold-open';

type Msg = {seq: number; text: string; ts: number};

const seed = (): Msg[] =>
  Array.from({length: 6}, (_, i) => ({
    seq: i,
    text: `cold-${String(i).padStart(2, '0')}`,
    ts: BASE + i * 1000
  }));

function attachOk(msgs: Msg[]): string {
  const tail = msgs.length ? Math.floor(msgs[msgs.length - 1].seq / PAGE_SIZE) : 0;
  const lastSeq = msgs.length ? msgs[msgs.length - 1].seq : 0;
  const pageMsgs = msgs
    .filter((m) => Math.floor(m.seq / PAGE_SIZE) === tail)
    .map((m) => ({t: 'chat', id: SESSION, role: 'claude', seq: m.seq, text: m.text, ts: m.ts}));
  return JSON.stringify({
    t: 'attach-ok',
    id: SESSION,
    known: true,
    pointer: lastSeq + 1,
    pointerPage: tail,
    tailPage: tail,
    pageSize: PAGE_SIZE,
    total: msgs.length,
    pages: [{page: tail, version: lastSeq + 1, sealed: false, messages: pageMsgs}]
  });
}

// `msgs` is shared with the engine by reference, so pushing to it before a
// re-attach makes the engine answer with a grown `total` -- the exact
// "history grew server-side" case the reconcile must notice.
function makeEngine(msgs: Msg[]): Promise<TestEngine> {
  return startEngine({
    user: USER,
    host: HOST,
    onConnect: (ws) => {
      ws.send(JSON.stringify({t: 'host', user: USER, host: HOST}));
      ws.send(
        JSON.stringify({
          t: 'sessions',
          list: [
            {
              id: SESSION,
              name: SESSION,
              cwd: '/tmp/' + SESSION,
              unread: 0,
              muted: false,
              alive: true,
              status: 'idle',
              title: {text: SESSION, detail: null}
            }
          ]
        })
      );
    },
    onMessage: (ws, inner) => {
      if (inner?.t === 'attach' && inner.id === SESSION) ws.send(attachOk(msgs));
    }
  });
}

const sid = (port: number) => `ws://127.0.0.1:${port}/ws|${SESSION}`;

const held = (page: Page, port: number) =>
  page.evaluate(
    (s) =>
      (window as unknown as {__cycMessages(id: string): {text: string}[]}).__cycMessages(s).length,
    sid(port)
  );

const historyWritten = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as {__cycHistoryStats(): {written: number}}).__cycHistoryStats().written
  );

// The header status word is `.cyc-sync-status`: it reads "offline",
// "connecting" or "syncing" while the pipe is not live, and is empty once it is.
const syncStatus = (page: Page) =>
  page.evaluate(() => document.querySelector('.cyc-sync-status')?.textContent ?? '');

const domMsgCount = (page: Page) => page.locator('.cyc-message-list-inner .cyc-message').count();

async function openChat(page: Page): Promise<void> {
  await page.$$eval(
    '.cyc-session-entry',
    (els, name) => {
      const row = els.find((e) => (e.textContent ?? '').includes(name)) as HTMLElement | undefined;
      if (!row) throw new Error('no chat row for ' + name);
      row.click();
    },
    SESSION
  );
  await page.waitForSelector('.cyc-message-list-scroll', {timeout: 10_000});
}

const LAYOUTS: [string, number, number][] = [
  ['phone', 390, 844],
  ['desktop', 1280, 900]
];

for (const [layout, width, height] of LAYOUTS) {
  test(`cold-open offline paints list+chat from cache, then reconnect reconciles (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    // `msgs` is shared by reference with the engine; the engine answers `attach`
    // from whatever it holds now, so pushing to `msgs` grows the server-side
    // history, and `rig.start()` relistens on the SAME port with the SAME
    // identity so the app's seeded key still seals the reconnect.
    const msgs = seed();
    const rig: TestEngine = await makeEngine(msgs);
    const port = rig.port;
    try {
      // --- WARM: engine up, open the chat, let its page + meta + roster cache ---
      await bootPinned(page, port, {size: {width, height}});
      await openChat(page);
      await expect
        .poll(() => held(page, port), {timeout: 20_000, message: 'the warm chat never hydrated'})
        .toBeGreaterThanOrEqual(6);
      await expect
        .poll(() => historyWritten(page), {
          timeout: 20_000,
          message: 'nothing was written to the cyc-history store while warm'
        })
        .toBeGreaterThan(0);

      // --- (a) COLD OPEN, ENGINE DEAD: list + chat must paint from IndexedDB ---
      await rig.stop();
      await page.reload();
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      await expect
        .poll(() => page.locator('.cyc-session-entry').count(), {
          timeout: 20_000,
          message: 'the roster did not repaint from cache with the engine dead'
        })
        .toBeGreaterThan(0);
      // the row is one this spec invented -- proves it is the cached roster, not a fixture
      const rowText = await page.locator('.cyc-session-entry').first().textContent();
      expect(rowText ?? '').toContain(SESSION);

      await openChat(page);
      await expect
        .poll(() => domMsgCount(page), {
          timeout: 15_000,
          message: 'the cached chat history did not paint with the engine dead'
        })
        .toBeGreaterThan(0);
      await expect.poll(() => held(page, port), {timeout: 15_000}).toBeGreaterThanOrEqual(6);

      // --- (b) OFFLINE INDICATOR: the status word says so while the engine is down ---
      await expect
        .poll(() => syncStatus(page), {
          timeout: 20_000,
          message: 'the status word never said offline while the engine was down'
        })
        .toBe('offline');
      // The connectivity word is now a slim band PINNED TO THE BOTTOM of the list,
      // OVERLAYING the rows (out of flow), present only while not-live and slid/faded
      // away when live. It reserves NO height, so the first list row never moves
      // between offline and online.
      const headerGeometry = () =>
        page.evaluate(() => {
          const burger = document.querySelector('.cyc-pane-menu-btn');
          const search = document.querySelector('.cyc-search-input');
          const bar = document.querySelector('.cyc-sync-status') as HTMLElement | null;
          const pane = document.querySelector('.cyc-left-content');
          const row = document.querySelector('.cyc-session-entry');
          if (!burger || !search || !bar || !pane) return null;
          const b = burger.getBoundingClientRect();
          const s = search.getBoundingClientRect();
          const st = bar.getBoundingClientRect();
          const p = pane.getBoundingClientRect();
          const r = row?.getBoundingClientRect();
          return {
            burgerRight: b.right,
            searchLeft: s.left,
            searchBottom: s.bottom,
            barHeight: st.height,
            barTop: st.top,
            paneBottom: p.bottom,
            opacity: parseFloat(getComputedStyle(bar).opacity || '1'),
            rowTop: r?.top ?? null
          };
        });
      const geomOffline = await headerGeometry();
      expect(geomOffline).not.toBeNull();
      // no blank fixed box left of the search bar: it starts right after the burger
      expect(geomOffline!.searchLeft - geomOffline!.burgerRight).toBeLessThan(24);
      // the band has real height, is shown (opaque) and rides low over the list --
      // well below the search, near the pane's bottom, not up in the header
      expect(geomOffline!.barHeight).toBeGreaterThan(0);
      expect(geomOffline!.opacity).toBeGreaterThan(0.9);
      expect(geomOffline!.barTop).toBeGreaterThan(geomOffline!.searchBottom + 40);
      await evidenceShot(page, SHOT_DIR, `${layout}-offline`);

      // capture a settled message node to prove reconcile does not remount it
      await page.evaluate(() => {
        const nodes = document.querySelectorAll('.cyc-message-list-inner .cyc-message');
        (window as unknown as {__probe?: Element | null}).__probe =
          nodes.length > 1 ? nodes[0] : null;
      });

      // --- history grew server-side while we were offline (total 7 > cached 6) ---
      msgs.push({seq: 6, text: 'cold-06-grew', ts: BASE + 6000});

      // --- RECONNECT on the same port (same identity -> the seal re-establishes) ---
      await rig.start();

      // (b cont.) the status word clears once truly live
      await expect
        .poll(() => syncStatus(page), {
          timeout: 30_000,
          message: 'the status word did not clear after the engine returned'
        })
        .toBe('');
      // ... and the band fades/slides away (live) -- poll past its fade transition --
      // while the first list row does not move at all between offline and online
      // (the band was never in flow).
      await expect
        .poll(() => headerGeometry().then((g) => g?.opacity ?? 1), {
          timeout: 5_000,
          message: 'the connectivity band did not fade away once live'
        })
        .toBeLessThan(0.05);
      const geomOnline = await headerGeometry();
      expect(geomOnline).not.toBeNull();
      expect(geomOnline!.rowTop).toBe(geomOffline!.rowTop);
      await evidenceShot(page, SHOT_DIR, `${layout}-online`);

      // --- (c) RECONNECT RECONCILE: the grown tail (total 7 > cached 6) merges in ---
      await expect
        .poll(() => held(page, port), {
          timeout: 20_000,
          message: 'the grown history did not reconcile into the open thread'
        })
        .toBeGreaterThanOrEqual(7);

      // the pre-existing message node was NOT rebuilt by the merge (no full remount)
      const kept = await page.evaluate(() => {
        const probe = (window as unknown as {__probe?: Element | null}).__probe;
        if (!probe) return false;
        const nodes = document.querySelectorAll('.cyc-message-list-inner .cyc-message');
        return [...nodes].includes(probe);
      });
      expect(kept, 'a settled message node was remounted by the reconnect reconcile').toBe(true);
    } finally {
      await rig.close();
    }
  });
}
