import {test, expect, type Page} from '@playwright/test';
import {WebSocketServer, type WebSocket as WS} from './wsshim';
import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'http';
import {installIsolation, bootPinned, evidenceShot} from './rig';

// The chat list can be hand-arranged by dragging a row (long-press on touch, a
// small drag past a threshold with a mouse). The order the drag lands is written
// to the engine via POST /sessions/order and echoed back as `order` indices on
// the next `sessions` frame, so it is what re-renders and what survives a reload.
// This spec drives a real drag in both a phone and a desktop viewport against a
// mock engine that honours that contract, and asserts the landed order sticks
// across page.reload(). grep token: `list reorder`.

const IDS = ['alpha', 'bravo', 'charlie'] as const;
const NAME: Record<string, string> = {
  alpha: 'Alpha Relay',
  bravo: 'Bravo Metrics',
  charlie: 'Charlie Scraper'
};
const SHOTS = 'reorder';

// The phone case drives real touch input; without a touch-capable context the
// browser never synthesises the pointer events the row drag listens for.
test.use({hasTouch: true});

type Engine = {port: number; order(): string[]; close(): Promise<void>};

function startEngine(): Promise<Engine> {
  const sockets = new Set<WS>();
  // The engine owns the order as a per-session index; a reorder POST rewrites it.
  const order = new Map<string, number>(IDS.map((id, i) => [id, i]));
  const sorted = () => [...IDS].sort((a, b) => order.get(a)! - order.get(b)!);
  const sessionsFrame = () =>
    JSON.stringify({
      t: 'sessions',
      list: sorted().map((id) => ({
        id,
        name: NAME[id],
        cwd: '/tmp/' + id,
        unread: 0,
        muted: false,
        alive: true,
        status: 'idle',
        order: order.get(id)
      }))
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
    if (req.method === 'POST' && (req.url ?? '').startsWith('/sessions/order')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
            order?: unknown;
          };
          const ids = Array.isArray(body.order) ? (body.order as string[]) : [];
          ids.forEach((id, i) => {
            if (order.has(id)) order.set(id, i);
          });
        } catch {
          /* a malformed order body leaves the arrangement untouched */
        }
        res.writeHead(200, {'content-type': 'application/json', ...CORS});
        res.end(JSON.stringify({ok: true}));
        // Echo the new arrangement so the app renders from engine truth, not just
        // its own optimistic DOM move.
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
    ws.send(JSON.stringify({t: 'host', user: 'test', host: 'testbox'}));
    // A fresh connection (including one made after a reload) receives the current
    // arrangement, which is how a saved order survives the reload.
    ws.send(sessionsFrame());
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as {port: number}).port,
        order: () => sorted(),
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
  // Manual reorder is gated on sort-by-latest being OFF (the default is ON); the
  // user hits this bug only with the manual arrangement chosen.
  await page.addInitScript(() => localStorage.setItem('cyc-sort-by-latest', '0'));
  await bootPinned(page, port, {size});
}

const shortNames = (page: Page) =>
  page.$$eval('.cyc-session-entry', (els) =>
    els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
  );

// The rendered row order, reduced to the leading id-word of each fixture name.
async function ordered(page: Page): Promise<string[]> {
  const rows = await shortNames(page);
  return rows.map((t) => {
    for (const id of IDS) if (t.includes(NAME[id])) return id;
    return t;
  });
}

async function rowCenter(page: Page, id: string): Promise<{x: number; y: number}> {
  const box = await page
    .locator('.cyc-session-entry', {hasText: NAME[id]})
    .first()
    .boundingBox();
  if (!box) throw new Error('no row box for ' + id);
  return {x: box.x + box.width / 2, y: box.y + box.height / 2};
}

async function lowerHalf(page: Page, id: string): Promise<{x: number; y: number}> {
  const box = await page
    .locator('.cyc-session-entry', {hasText: NAME[id]})
    .first()
    .boundingBox();
  if (!box) throw new Error('no row box for ' + id);
  return {x: box.x + box.width / 2, y: box.y + box.height * 0.8};
}

test('list reorder (phone): a long-pressed row drags to the bottom and survives a reload', async ({
  page
}) => {
  test.setTimeout(90_000);
  const engine = await startEngine();
  try {
    await boot(page, engine.port, {width: 390, height: 844});
    await expect.poll(() => ordered(page)).toEqual(['alpha', 'bravo', 'charlie']);
    await evidenceShot(page, SHOTS, 'phone-before');

    const start = await rowCenter(page, 'alpha');
    const drop = await lowerHalf(page, 'charlie');
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x?: number, y?: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{x: x!, y: y!}]
      });

    await touch('touchStart', start.x, start.y);
    // Hold still past the 500ms lift timer (but under the 600ms menu window) so
    // the row is picked up for dragging rather than opening the row menu.
    await page.waitForTimeout(600);
    const stepsY = [start.y + 20, (start.y + drop.y) / 2, drop.y - 10, drop.y];
    for (const y of stepsY) {
      await touch('touchMove', start.x, y);
      await page.waitForTimeout(60);
    }
    await touch('touchEnd');

    await expect.poll(() => ordered(page), {timeout: 10_000}).toEqual([
      'bravo',
      'charlie',
      'alpha'
    ]);
    expect(engine.order()).toEqual(['bravo', 'charlie', 'alpha']);
    await evidenceShot(page, SHOTS, 'phone-after');

    await page.reload();
    await page.waitForSelector('.cyc-session-entry');
    await expect.poll(() => ordered(page), {timeout: 10_000}).toEqual([
      'bravo',
      'charlie',
      'alpha'
    ]);
  } finally {
    await engine.close();
  }
});

test('list reorder (desktop): a dragged row past the threshold lands and survives a reload', async ({
  page
}) => {
  test.setTimeout(90_000);
  const engine = await startEngine();
  try {
    await boot(page, engine.port, {width: 1280, height: 900});
    await expect.poll(() => ordered(page)).toEqual(['alpha', 'bravo', 'charlie']);
    await evidenceShot(page, SHOTS, 'desktop-before');

    const start = await rowCenter(page, 'alpha');
    const drop = await lowerHalf(page, 'charlie');

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // Cross the 10px drag threshold to pick the row up (mouse does not wait for a
    // long-press), then travel to the drop point.
    await page.mouse.move(start.x, start.y + 15, {steps: 4});
    await page.mouse.move(drop.x, (start.y + drop.y) / 2, {steps: 6});
    await page.mouse.move(drop.x, drop.y, {steps: 6});
    await page.mouse.up();

    await expect.poll(() => ordered(page), {timeout: 10_000}).toEqual([
      'bravo',
      'charlie',
      'alpha'
    ]);
    expect(engine.order()).toEqual(['bravo', 'charlie', 'alpha']);
    await evidenceShot(page, SHOTS, 'desktop-after');

    await page.reload();
    await page.waitForSelector('.cyc-session-entry');
    await expect.poll(() => ordered(page), {timeout: 10_000}).toEqual([
      'bravo',
      'charlie',
      'alpha'
    ]);
  } finally {
    await engine.close();
  }
});
