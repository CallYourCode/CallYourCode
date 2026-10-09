import {test, expect, type Page} from '@playwright/test';
import {WebSocketServer, type WebSocket as WS} from './wsshim';
import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'http';
import {installIsolation, bootPinned, evidenceShot} from './rig';

// THE LIST STAR, end to end (agent-star). The owner stars a chat from the row
// menu (press-and-hold on touch, right-click on desktop); the row shows a gold
// star after the name and a gold wash, in day and night. The star is a session
// setting on the engine (the same POST /session/<id>/settings patch as mute and
// the bell), so it survives a reload, and Unstar puts the row back exactly as
// it was. The mock engine honours that route and broadcasts the sessions frame
// like the real one. `charlie` arrives already starred, so the first frame is
// covered too. grep token: `list star`.

const IDS = ['alpha', 'bravo', 'charlie'] as const;
const NAME: Record<string, string> = {
  alpha: 'Alpha Relay',
  bravo: 'Bravo Metrics',
  charlie: 'Charlie Notes'
};
const LAST_TS = 1000;
const SHOTS = 'agent-star';
const PLAIN = 'rgba(0, 0, 0, 0)'; // an unstarred, unselected row paints nothing

type Settings = {muted?: boolean; notify?: boolean; starred?: boolean};
type Engine = {port: number; settingsOf(id: string): Settings; close(): Promise<void>};

function startEngine(): Promise<Engine> {
  const sockets = new Set<WS>();
  const settings = new Map<string, Settings>(IDS.map((id) => [id, {}]));
  settings.set('charlie', {starred: true});

  const sessionsFrame = () =>
    JSON.stringify({
      t: 'sessions',
      list: IDS.map((id, i) => ({
        id,
        name: NAME[id],
        cwd: '/tmp/' + id,
        unread: 0,
        alive: true,
        status: 'idle',
        settings: settings.get(id),
        order: i
      }))
    });
  const attachOkFrame = (id: string) =>
    JSON.stringify({
      t: 'attach-ok',
      id,
      known: true,
      pageSize: 100,
      total: 1,
      pointer: 0,
      pointerPage: 0,
      tailPage: 0,
      pages: [
        {
          page: 0,
          version: 1,
          sealed: true,
          messages: [
            {
              id: 'm-' + id,
              role: 'claude',
              text: 'Hello from ' + id,
              ts: LAST_TS,
              seq: 1,
              msgId: 'm-' + id
            }
          ]
        }
      ]
    });
  const broadcast = (raw: string) => {
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(raw);
  };

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
  const httpHandler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    // The engine's route: a partial patch of booleans, null clears a key.
    const m = (req.url ?? '').match(/^\/session\/([^/]+)\/settings/);
    if (req.method === 'POST' && m && settings.has(decodeURIComponent(m[1]))) {
      const id = decodeURIComponent(m[1]);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const next = {...settings.get(id)} as Record<string, boolean>;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          for (const k of ['muted', 'notify', 'starred']) {
            if (typeof body[k] === 'boolean') next[k] = body[k];
            else if (body[k] === null) delete next[k];
          }
        } catch {
          /* a malformed body changes nothing */
        }
        settings.set(id, next);
        res.writeHead(200, {'content-type': 'application/json', ...CORS});
        res.end(JSON.stringify({ok: true, settings: next}));
        broadcast(sessionsFrame());
      });
      return;
    }
    res.writeHead(404, CORS);
    res.end('{}');
  };

  const server: Server = createServer(httpHandler);
  const wss = new WebSocketServer({server});
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('error', () => {});
    ws.on('message', (raw: Buffer | string) => {
      let f: {t?: string; id?: string} | null = null;
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (f?.t === 'attach' && f.id) ws.send(attachOkFrame(f.id));
    });
    ws.send(JSON.stringify({t: 'host', user: 'test', host: 'testbox'}));
    ws.send(sessionsFrame());
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as {port: number}).port,
        settingsOf: (id) => settings.get(id) ?? {},
        close: () =>
          new Promise<void>((done) => {
            for (const ws of sockets) ws.terminate();
            wss.close(() => server.close(() => done()));
          })
      })
    )
  );
}

async function boot(page: Page, port: number, size: {width: number; height: number}) {
  // Day on first boot; a later switch to night is written by the test itself
  // and kept across the reload.
  await page.addInitScript(() => {
    if (!localStorage.getItem('cyc-skin')) localStorage.setItem('cyc-skin', 'day');
  });
  await page.setViewportSize(size);
  await installIsolation(page);
  await bootPinned(page, port, {size});
}

async function reloadInto(page: Page, skin: 'day' | 'night') {
  await page.evaluate((s) => localStorage.setItem('cyc-skin', s), skin);
  await page.reload();
  await page.waitForSelector('.cyc-session-entry');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(skin === 'night' ? 'dark' : 'light');
}

function row(page: Page, id: string) {
  return page.locator('.cyc-session-entry', {hasText: NAME[id]}).first();
}
function star(page: Page, id: string) {
  return row(page, id).locator('.cyc-list-row-star');
}
function bgOf(page: Page, id: string) {
  return row(page, id).evaluate((el) => getComputedStyle(el).backgroundColor);
}

// Open the row menu: right-click on desktop, press-and-hold on touch (the lift
// timer is 500ms, the menu another 600ms, so hold well past 1.1s without
// moving), then tap the item.
async function rowMenu(page: Page, id: string, touch: boolean, text: string) {
  const r = row(page, id);
  if (touch) {
    const box = await r.boundingBox();
    if (!box) throw new Error('no row box for ' + id);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    await page.waitForTimeout(1250);
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  } else {
    await r.click({button: 'right'});
  }
  const item = page
    .locator('.cyc-menu-item', {hasText: new RegExp('^\\s*' + text + '\\s*$')})
    .first();
  await item.waitFor({state: 'visible'});
  await page.waitForTimeout(200);
  await item.click();
  await expect(page.locator('.cyc-menu-item')).toHaveCount(0);
}

async function expectStarred(page: Page, id: string) {
  await expect(star(page, id)).toBeVisible({timeout: 10_000});
  await expect(row(page, id)).toHaveClass(/\bcyc-starred\b/);
  // the star sits right after the name, on the title line
  await expect(
    row(page, id).locator('.cyc-list-row-title .cyc-who + .cyc-list-row-star')
  ).toHaveCount(1);
}

async function expectPlain(page: Page, id: string) {
  await expect(star(page, id)).toHaveCount(0, {timeout: 10_000});
  await expect(row(page, id)).not.toHaveClass(/\bcyc-starred\b/);
}

// The phone reaches the row menu with a press-and-hold, which needs touch; the
// laptop is a mouse (a fine pointer), which is what its hover wash is for.
test.describe('phone', () => {
  test.use({hasTouch: true});
  test(`list star (phone): hold -> Star -> star + wash -> reload -> still starred -> Unstar`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    const engine = await startEngine();
    try {
      await boot(page, engine.port, {width: 390, height: 844});
      await expectPlain(page, 'alpha');
      await expectStarred(page, 'charlie'); // starred on the engine before boot
      const plainBg = await bgOf(page, 'bravo');
      expect(plainBg).toBe(PLAIN);

      // A plain press-and-hold (no travel) still opens the menu over drag-reorder.
      await rowMenu(page, 'alpha', true, 'Star');
      await expectStarred(page, 'alpha');
      await expectPlain(page, 'bravo');
      expect(engine.settingsOf('alpha').starred).toBe(true);
      expect(await bgOf(page, 'alpha')).not.toBe(plainBg); // the gold wash
      await expect(row(page, 'alpha').locator('.cyc-who')).toHaveText(NAME.alpha);
      await evidenceShot(page, SHOTS, 'phone-light');

      // RELOAD (into night) -> still starred, the wash and star repainted.
      await reloadInto(page, 'night');
      await expectStarred(page, 'alpha');
      expect(await bgOf(page, 'alpha')).not.toBe(PLAIN);
      expect(await bgOf(page, 'bravo')).toBe(PLAIN);
      await evidenceShot(page, SHOTS, 'phone-dark');

      // UNSTAR -> back to exactly the plain row.
      await rowMenu(page, 'alpha', true, 'Unstar');
      await expectPlain(page, 'alpha');
      expect(engine.settingsOf('alpha').starred).toBe(false);
      expect(await bgOf(page, 'alpha')).toBe(PLAIN);
      await evidenceShot(page, SHOTS, 'phone-dark-unstarred');

      // A tap still opens the chat.
      await row(page, 'charlie').click();
      await page.waitForSelector('.cyc-message-list-scroll', {timeout: 15_000});
    } finally {
      await engine.close();
    }
  });
});

test.describe('laptop', () => {
  test.use({hasTouch: false});
  test(`list star (laptop): right-click -> Star -> star + wash, hover, selected -> reload -> Unstar`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    const engine = await startEngine();
    try {
      await boot(page, engine.port, {width: 1280, height: 800});
      await expectPlain(page, 'alpha');
      await expectStarred(page, 'charlie');

      await rowMenu(page, 'alpha', false, 'Star');
      await expectStarred(page, 'alpha');
      expect(engine.settingsOf('alpha').starred).toBe(true);
      const rest = await bgOf(page, 'alpha');
      expect(rest).not.toBe(PLAIN);
      await page.mouse.move(1000, 700); // off the list
      await evidenceShot(page, SHOTS, 'laptop-light');

      // HOVER -> a deeper gold, not the plain row's grey.
      await row(page, 'charlie').hover();
      await expect.poll(() => bgOf(page, 'charlie')).not.toBe(rest);
      await evidenceShot(page, SHOTS, 'laptop-light-hover');

      // SELECTED -> the open chat's row keeps its gold under the selection.
      await row(page, 'alpha').click();
      await page.waitForSelector('.cyc-message-list-scroll', {timeout: 15_000});
      await expect(row(page, 'alpha')).toHaveClass(/\bactive\b/);
      await page.mouse.move(1000, 700);
      await expect.poll(() => bgOf(page, 'alpha')).not.toBe(rest);
      await evidenceShot(page, SHOTS, 'laptop-light-selected');

      // RELOAD (into night) -> still starred.
      await reloadInto(page, 'night');
      await expectStarred(page, 'alpha');
      await expectStarred(page, 'charlie');
      await page.mouse.move(1000, 700);
      await evidenceShot(page, SHOTS, 'laptop-dark');
      await row(page, 'charlie').hover();
      await page.waitForTimeout(250);
      await evidenceShot(page, SHOTS, 'laptop-dark-hover');
      await row(page, 'alpha').click();
      await expect(row(page, 'alpha')).toHaveClass(/\bactive\b/);
      await page.mouse.move(1000, 700);
      await page.waitForTimeout(250);
      await evidenceShot(page, SHOTS, 'laptop-dark-selected');

      // UNSTAR the selected row -> the plain selected grey, no star.
      await rowMenu(page, 'alpha', false, 'Unstar');
      await expectPlain(page, 'alpha');
      expect(engine.settingsOf('alpha').starred).toBe(false);
      await page.mouse.move(1000, 700);
      await expect.poll(() => bgOf(page, 'alpha')).toBe('rgba(255, 255, 255, 0.07)');
      await expect(row(page, 'bravo')).not.toHaveClass(/\bcyc-starred\b/);
      await evidenceShot(page, SHOTS, 'laptop-dark-unstarred');
    } finally {
      await engine.close();
    }
  });
});
