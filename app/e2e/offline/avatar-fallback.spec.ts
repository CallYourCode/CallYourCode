import {test, expect, type Page} from '@playwright/test';
import {WebSocketServer, type WebSocket as WS} from './wsshim';
import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'http';
import {installIsolation, bootPinned, evidenceShot} from './rig';

// Every agent has a real remote photo, but the photo endpoint is BLOCKED (the
// engine 404s `/photo` and the browser aborts any that leaks past the tunnel).
// The invariant under test: every avatar slot still paints the deterministic
// name-derived robot SVG (the broken-image glyph is unreachable), phone +
// desktop.

const SHOT_DIR = 'avatar-fallback';

const AGENTS = [
  {id: 'photorelay', name: 'Photo Relay'},
  {id: 'photobeacon', name: 'Photo Beacon'}
];
const BASE = 1_700_000_000_000;

type Engine = {port: number; photoHits(): number; close(): Promise<void>};

function startEngine(): Promise<Engine> {
  const sockets = new Set<WS>();
  let photoHits = 0;
  const line = (id: string) => ({
    t: 'chat',
    id,
    role: 'claude',
    seq: 0,
    text: `hello from ${id}`,
    ts: BASE
  });
  const sessionsFrame = () =>
    JSON.stringify({
      t: 'sessions',
      list: AGENTS.map((a) => ({
        id: a.id,
        name: a.name,
        cwd: '/tmp/' + a.id,
        unread: 0,
        muted: false,
        alive: true,
        status: 'idle',
        // A real remote photo per agent -- this is what the app tries (and fails)
        // to load, so the auto avatar has to hold the floor.
        photo: `/session/${a.id}/photo`,
        heardTs: BASE,
        title: {text: a.name, detail: null as string | null}
      }))
    });
  const answerAttach = (ws: WS, id: string) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(
      JSON.stringify({
        t: 'attach-ok',
        id,
        known: true,
        pointer: 0,
        pointerPage: 0,
        tailPage: 0,
        pageSize: 100,
        total: 1,
        pages: [{page: 0, version: 1, sealed: false, messages: [line(id)]}]
      })
    );
  };
  const CORS = {'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS'};
  const httpHandler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    // The photo endpoint is the blocked resource: always 404, never any bytes.
    if (/\/photo(\?|$)/.test(req.url ?? '')) photoHits++;
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
    ws.send(sessionsFrame());
    ws.on('message', (raw) => {
      let f: {t?: string; id?: string};
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (f.t === 'attach' && f.id && AGENTS.some((a) => a.id === f.id)) answerAttach(ws, f.id);
    });
  });
  return new Promise((res) =>
    server.listen(0, '127.0.0.1', () =>
      res({
        port: (server.address() as {port: number}).port,
        photoHits: () => photoHits,
        close: () =>
          new Promise<void>((done) => {
            for (const ws of sockets) ws.terminate();
            wss.close(() => server.close(() => done()));
          })
      })
    )
  );
}

async function openChat(page: Page) {
  await page.locator('.cyc-session-entry').first().click();
  await page.waitForSelector('.cyc-message-list-scroll', {timeout: 15_000});
}

// Every avatar slot on screen holds the name-derived robot SVG (inline, so it
// cannot be a broken glyph) with drawn content; no real photo ever swapped in.
async function assertNoBrokenGlyph(page: Page, label: string) {
  const robots = page.locator('.cyc-face svg.cyc-robot');
  const n = await robots.count();
  expect(n, `${label}: no robot fallback rendered`).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const paths = await robots.nth(i).locator('path').count();
    expect(paths, `${label}: robot ${i} has no letter skeleton`).toBeGreaterThan(0);
  }
  // With the photo blocked, no photo img holding a src should exist at all.
  const photos = await page
    .locator('img.cyc-face-photo')
    .evaluateAll((els) => els.filter((e) => !!e.getAttribute('src')).length);
  expect(photos, `${label}: a real photo img reached the DOM though the photo was blocked`).toBe(0);
}

const CASES = [
  {label: 'phone', size: {width: 390, height: 844}},
  {label: 'desktop', size: {width: 1280, height: 800}}
] as const;

for (const c of CASES) {
  test(`no broken avatar glyph with photos blocked (${c.label})`, async ({page}) => {
    test.setTimeout(60_000);
    const engine = await startEngine();
    try {
      // Belt-and-suspenders: abort any photo that ever leaves the browser network
      // (the tunnel path is already dead-ended by the engine's 404).
      await page.route('**/photo**', (r) => r.abort());
      await page.setViewportSize(c.size);
      await installIsolation(page);
      await bootPinned(page, engine.port, {size: c.size});

      // 1) The chat list rows paint the robot fallback immediately.
      await assertNoBrokenGlyph(page, `${c.label} list`);
      await evidenceShot(page, SHOT_DIR, `${c.label}-list`);

      // 2) The thread header avatar.
      await openChat(page);
      await page.waitForSelector('.cyc-mast-person svg.cyc-robot', {timeout: 15_000});
      await assertNoBrokenGlyph(page, `${c.label} header`);

      // 3) The profile pane avatar.
      await page.locator('.cyc-mast-person').first().click();
      await page.waitForSelector('.cyc-account-avatar svg.cyc-robot', {timeout: 15_000});
      await assertNoBrokenGlyph(page, `${c.label} profile`);
      await evidenceShot(page, SHOT_DIR, `${c.label}-profile`);
    } finally {
      await engine.close();
    }
  });
}
