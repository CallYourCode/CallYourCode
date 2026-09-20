import {test, expect, type Page} from '@playwright/test';
import {WebSocketServer, type WebSocket as WS} from './wsshim';
import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'http';
import {installIsolation, bootPinned, evidenceShot} from './rig';

// MARK-AS-UNREAD, end to end (fix-mark-unread). The regression: marking a chat
// unread had no effect -- the sessions frame zeroed the row's count so the
// badge never appeared, never survived a reload, and there was nothing to clear
// on open. The engine owns the marker (heardTs); the app must paint it, persist
// it, and clear it on open. This drives the WhatsApp-grade contract against a
// mock engine that honours the real /session/<id>/unread route and marks a chat
// read when it is opened (attach), in both a phone and a desktop viewport.
// grep token: `mark unread`.

const IDS = ['alpha', 'bravo'] as const;
const NAME: Record<string, string> = {alpha: 'Alpha Relay', bravo: 'Bravo Metrics'};
const LAST_TS = 1000; // the one agent line every session already has
const SHOTS = 'mark-unread';

// The phone case reaches the row menu with a press-and-hold, which needs touch.
test.use({hasTouch: true});

type Engine = {port: number; unreadOf(id: string): number; close(): Promise<void>};

function startEngine(): Promise<Engine> {
  const sockets = new Set<WS>();
  // The read marker, exactly as the engine models it: unread is the count of
  // agent lines past `heardTs`. Start read (marker at the last line).
  const heardTs = new Map<string, number>(IDS.map((id) => [id, LAST_TS]));
  const unreadOf = (id: string) => (heardTs.get(id)! < LAST_TS ? 1 : 0);
  const markRead = (id: string) => heardTs.set(id, LAST_TS);
  const markUnread = (id: string) => {
    if (heardTs.get(id)! < LAST_TS) return false; // already unread
    heardTs.set(id, LAST_TS - 1);
    return true;
  };

  const sessionsFrame = () =>
    JSON.stringify({
      t: 'sessions',
      list: IDS.map((id, i) => ({
        id,
        name: NAME[id],
        cwd: '/tmp/' + id,
        unread: unreadOf(id),
        muted: false,
        alive: true,
        status: 'idle',
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
          messages: [{id: 'm-' + id, role: 'claude', text: 'Hello from ' + id, ts: LAST_TS, seq: 1, msgId: 'm-' + id}]
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
    const m = (req.url ?? '').match(/^\/session\/([^/]+)\/unread/);
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let moved = false;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
            read?: unknown;
          };
          moved = body.read === true ? (markRead(id), true) : markUnread(id);
        } catch {
          /* a malformed body moves nothing */
        }
        res.writeHead(200, {'content-type': 'application/json', ...CORS});
        res.end(JSON.stringify({ok: moved, unread: unreadOf(id)}));
        if (moved) broadcast(sessionsFrame());
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
      if (!f || !f.id) return;
      // Opening a chat attaches to it and reads it through: that is what clears
      // the badge AND makes the clear survive a reload (the marker moved on the
      // engine, so a fresh frame reports zero).
      if (f.t === 'attach') {
        ws.send(attachOkFrame(f.id));
        markRead(f.id);
        broadcast(sessionsFrame());
      } else if (f.t === 'heard' || f.t === 'progress') {
        markRead(f.id);
        broadcast(sessionsFrame());
      }
    });
    ws.send(JSON.stringify({t: 'host', user: 'test', host: 'testbox'}));
    ws.send(sessionsFrame());
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as {port: number}).port,
        unreadOf,
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
  await page.setViewportSize(size);
  await installIsolation(page);
  await bootPinned(page, port, {size});
}

function row(page: Page, id: string) {
  return page.locator('.cyc-session-entry', {hasText: NAME[id]}).first();
}
// The unread badge is a `.cyc-session-badge-unread` inside that row.
function unreadBadge(page: Page, id: string) {
  return row(page, id).locator('.cyc-session-badge-unread');
}

// Open the row menu: right-click on desktop, press-and-hold on touch (the lift
// timer is 500ms, the menu another 600ms, so hold well past 1.1s without
// moving), then tap "Mark as unread".
async function markUnreadVia(page: Page, id: string, touch: boolean) {
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
  // The item's text span is pointer-events-none; the click target is the
  // `.cyc-menu-item` row. Wait for the open animation to settle so the click
  // is not chasing a moving element.
  const item = page.locator('.cyc-menu-item', {hasText: 'Mark as unread'}).first();
  await item.waitFor({state: 'visible'});
  await page.waitForTimeout(200);
  await item.click();
}

for (const view of [
  {label: 'phone', size: {width: 390, height: 844}, touch: true},
  {label: 'desktop', size: {width: 1280, height: 900}, touch: false}
] as const) {
  test(`mark unread (${view.label}): the badge paints, survives a reload, and clears on open`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    const engine = await startEngine();
    try {
      await boot(page, engine.port, view.size);
      await expect(row(page, 'alpha')).toBeVisible();
      // Nothing is unread to begin with.
      await expect(unreadBadge(page, 'alpha')).toHaveCount(0);
      await evidenceShot(page, SHOTS, `${view.label}-before`);

      // MARK -> the row shows the unread badge immediately.
      await markUnreadVia(page, 'alpha', view.touch);
      await expect(unreadBadge(page, 'alpha')).toBeVisible({timeout: 10_000});
      await expect(unreadBadge(page, 'bravo')).toHaveCount(0); // only the one marked
      expect(engine.unreadOf('alpha')).toBe(1);
      await evidenceShot(page, SHOTS, `${view.label}-marked`);

      // RELOAD -> it persists (the engine's marker, echoed on reconnect).
      await page.reload();
      await page.waitForSelector('.cyc-session-entry');
      await expect(unreadBadge(page, 'alpha')).toBeVisible({timeout: 10_000});
      await evidenceShot(page, SHOTS, `${view.label}-reloaded`);

      // OPEN -> the badge clears (and stays cleared: the engine read it through).
      await row(page, 'alpha').click();
      await page.waitForSelector('.cyc-message-list-scroll', {timeout: 15_000});
      if (view.touch) {
        // Phone hides the list behind the chat; the chat header (`.cyc-mast`)
        // carries the back button. Go back and wait for the list view so the
        // row (and its now-absent badge) is what we actually assert on.
        await page.locator('.cyc-mast .cyc-pane-back').first().click();
        await page.waitForSelector('#cyc-columns[data-view="list"]');
        await page.waitForSelector('.cyc-session-entry');
      }
      await expect(unreadBadge(page, 'alpha')).toHaveCount(0, {timeout: 10_000});
      await expect.poll(() => engine.unreadOf('alpha'), {timeout: 10_000}).toBe(0);
      await evidenceShot(page, SHOTS, `${view.label}-opened`);
    } finally {
      await engine.close();
    }
  });
}
