import {test, expect, type Page} from '@playwright/test';
import {WebSocketServer, type WebSocket as WS} from './wsshim';
import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'http';
import {bootPinned} from './rig';

// The plugin card (list pane "Plan usage") is a sandboxed iframe that reports a
// measurement heartbeat to the parent; the parent logs `card.render` per
// accepted report. The phone log showed one `card.render` every 3 s with an
// unchanged payload on every page (a timer inside the iframe re-measuring an
// unchanged card, and the parent logging every beat). This spec counts the
// cyclog emits at the sink (window.__cycLogTap, installed by ?testhooks=1) for
// the idle cases and for the one case that must still render.

const CHAT = 'stormchat';
const BASE = 1_700_000_000_000;
const PAGE_SIZE = 100;
const CARD_A = '<div style="padding:8px;border:1px solid #888">Plan usage 42% <b>of week</b></div>';
const CARD_B = '<div style="padding:8px;border:1px solid #888">Plan usage 57% <b>of week</b></div>';

type Msg = {seq: number; text: string; ts: number};
type Engine = {
  port: number;
  live(): Msg;
  resendSessions(): void;
  setCard(html: string): void;
  cardFetches(): number;
  close(): Promise<void>;
};

function startEngine(): Promise<Engine> {
  const sockets = new Set<WS>();
  const log: Msg[] = [];
  let n = 0;
  let cardHtml = CARD_A;
  let cardFetches = 0;
  const mint = (): Msg => {
    const m = {seq: log.length, text: `msg-${String(n).padStart(4, '0')}`, ts: BASE + n * 1000};
    n++;
    log.push(m);
    return m;
  };
  for (let i = 0; i < 5; i++) mint();
  let heard = log[log.length - 1].ts;

  const buildPage = () => ({
    page: 0,
    version: log.length,
    sealed: false,
    messages: log.map((m) => ({t: 'chat', id: CHAT, role: 'claude', seq: m.seq, text: m.text, ts: m.ts}))
  });
  const sessionsFrame = () =>
    JSON.stringify({
      t: 'sessions',
      list: [
        {
          id: CHAT,
          name: CHAT,
          cwd: '/tmp/' + CHAT,
          unread: 0,
          muted: false,
          alive: true,
          status: 'idle',
          heardTs: heard,
          title: {text: CHAT, detail: null as string | null}
        }
      ]
    });
  const pluginsFrame = () =>
    JSON.stringify({
      t: 'plugins',
      list: [{id: 'usage-card', name: 'Usage', version: 1, card: {title: 'Plan usage', refreshFloorS: 5}}]
    });
  const broadcast = (raw: string) => {
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(raw);
  };

  const CORS = {'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS'};
  const httpHandler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const url = req.url ?? '';
    if (url.startsWith('/plugin/usage-card/card')) {
      cardFetches++;
      res.writeHead(200, {'content-type': 'application/json', ...CORS});
      res.end(JSON.stringify({ok: true, html: cardHtml, ageMs: 1000, height: 76, dedupe: 'plan'}));
      return;
    }
    if (url.startsWith(`/session/${CHAT}/page/`)) {
      res.writeHead(200, {'content-type': 'application/json', ...CORS});
      res.end(JSON.stringify(buildPage()));
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
    ws.send(pluginsFrame());
    ws.send(sessionsFrame());
    ws.on('message', (raw) => {
      let f: {t?: string; id?: string};
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (f.t === 'attach' && f.id === CHAT) {
        ws.send(
          JSON.stringify({
            t: 'attach-ok',
            id: CHAT,
            known: true,
            pointer: log.length,
            pointerPage: 0,
            tailPage: 0,
            pageSize: PAGE_SIZE,
            total: log.length,
            pages: [buildPage()]
          })
        );
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as {port: number}).port,
        live: () => {
          const m = mint();
          heard = m.ts;
          broadcast(JSON.stringify({t: 'chat', id: CHAT, role: 'claude', text: m.text, ts: m.ts}));
          return m;
        },
        resendSessions: () => broadcast(sessionsFrame()),
        setCard: (html: string) => {
          cardHtml = html;
        },
        cardFetches: () => cardFetches,
        close: () =>
          new Promise<void>((done) => {
            for (const ws of sockets) ws.terminate();
            wss.close(() => server.close(() => done()));
          })
      })
    )
  );
}

type Counts = Record<string, number>;
type Beat = {phase: string; nonEmpty: boolean; height: number; nodes: number};

// Installed before the bundle runs: window.__cycLogTap receives every cyclog
// emit (event, fields). We keep per-event counts and the card.render payloads.
const TAP = () => {
  const w = window as unknown as {
    __cycLogTap?: (event: string, fields: Record<string, unknown>) => void;
    __stormCounts: Record<string, number>;
    __stormBeats: Beat[];
    __stormSkips: number[];
  };
  w.__stormCounts = {};
  w.__stormBeats = [];
  w.__stormSkips = [];
  w.__cycLogTap = (event, fields) => {
    w.__stormCounts[event] = (w.__stormCounts[event] ?? 0) + 1;
    if (event === 'card.render') {
      w.__stormBeats.push({
        phase: String(fields.phase),
        nonEmpty: fields.nonEmpty === true,
        height: Number(fields.height),
        nodes: Number(fields.nodes)
      });
    }
    if (event === 'render.skipped' && fields.surface === 'card') {
      w.__stormSkips.push(Number(fields.skipped));
    }
  };
};

async function counts(page: Page): Promise<Counts> {
  return page.evaluate(() => ({...(window as unknown as {__stormCounts: Counts}).__stormCounts}));
}
const of = (c: Counts, ev: string) => c[ev] ?? 0;
function delta(a: Counts, b: Counts, ev: string) {
  return of(b, ev) - of(a, ev);
}

async function openChat(page: Page) {
  await page.locator('.cyc-session-entry', {hasText: CHAT}).first().click();
  await expect(page.locator('.cyc-message-list-inner .cyc-message')).not.toHaveCount(0);
}

// The card is verified once the parent promoted the first heartbeat.
async function waitCardVerified(page: Page) {
  await expect
    .poll(async () => of(await counts(page), 'card.frame'), {timeout: 20_000})
    .toBeGreaterThan(0);
  await expect(page.locator('.cyc-plugincard-frame:not(.cyc-plugincard-frame-candidate)')).toHaveCount(1);
  // Let any load/font-triggered beats settle before the idle windows start.
  await page.waitForTimeout(1500);
}

test.describe('plugin card render storm', () => {
  test.setTimeout(120_000);
  let engine: Engine;
  test.beforeEach(async () => {
    engine = await startEngine();
  });
  test.afterEach(async () => {
    await engine.close();
  });

  test('an unchanged card renders nothing while idle, on frames, on resize/visibility, on a new message', async ({
    page
  }) => {
    await page.addInitScript(TAP);
    await bootPinned(page, engine.port);
    await openChat(page);
    await waitCardVerified(page);
    const report: Record<string, number> = {};

    // 1. Idle open chat, 30 s. At HEAD the iframe's 3 s timer reported ~10 beats.
    const idle0 = await counts(page);
    await page.waitForTimeout(30_000);
    const idle1 = await counts(page);
    report.idle30s = delta(idle0, idle1, 'card.render');
    report.idle30s_skipped = delta(idle0, idle1, 'render.skipped');

    // 2. A session frame every 2 s with no content change (5 frames, 10 s).
    const fr0 = await counts(page);
    for (let i = 0; i < 5; i++) {
      engine.resendSessions();
      await page.waitForTimeout(2000);
    }
    const fr1 = await counts(page);
    report.frames5x2s = delta(fr0, fr1, 'card.render');

    // 3. Resize twice and a visibility change. The iframe's ResizeObserver
    // re-measures; the parent counts the identical beats on the frame element
    // (data-card-skips) and logs the first one plus every 64th.
    const frame = page.locator('.cyc-plugincard-frame:not(.cyc-plugincard-frame-candidate)');
    const skipsOf = async () => Number((await frame.getAttribute('data-card-skips')) ?? '0');
    const rv0 = await counts(page);
    const rvSkips0 = await skipsOf();
    await page.setViewportSize({width: 1100, height: 720});
    await page.waitForTimeout(600);
    await page.setViewportSize({width: 1280, height: 720});
    await page.waitForTimeout(600);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(1500);
    const rv1 = await counts(page);
    report.resizeVisibility = delta(rv0, rv1, 'card.render');
    report.resizeVisibility_skipped = (await skipsOf()) - rvSkips0;

    // 4. A new chat message arrives.
    const nm0 = await counts(page);
    engine.live();
    await expect(page.locator('.cyc-message-list-inner .cyc-message')).toHaveCount(6);
    await page.waitForTimeout(3500);
    const nm1 = await counts(page);
    report.newMessage = delta(nm0, nm1, 'card.render');

    const total = await counts(page);
    report.total_card_render = of(total, 'card.render');
    report.total_card_frame = of(total, 'card.frame');
    report.total_render_skipped = of(total, 'render.skipped');
    console.log('render-storm counts: ' + JSON.stringify(report));
    test.info().annotations.push({type: 'counts', description: JSON.stringify(report)});

    expect(report.idle30s, 'idle: timer beats re-rendered an unchanged card').toBe(0);
    expect(report.frames5x2s, 'session frames re-rendered an unchanged card').toBe(0);
    expect(report.resizeVisibility, 'resize/visibility re-rendered an unchanged card').toBe(0);
    expect(report.newMessage, 'a new message re-rendered an unchanged card').toBe(0);
    // The resize did measure the card again, and the parent skipped it.
    expect(report.resizeVisibility_skipped, 'resize never re-measured the card').toBeGreaterThan(0);
    // Exactly one accepted render for the whole session: the first verified
    // beat. The skips (first one, then every 64th) reach the log.
    expect(report.total_card_render).toBe(1);
    expect(report.total_card_frame).toBe(1);
    expect(report.total_render_skipped, 'no render.skipped line reached the log').toBeGreaterThan(0);
  });

  test('a changed card still renders once, and the log carries the skips', async ({page}) => {
    await page.addInitScript(TAP);
    await bootPinned(page, engine.port);
    await openChat(page);
    await waitCardVerified(page);
    const before = await counts(page);
    const fetches = engine.cardFetches();

    // A refresh with the SAME html: fetched again, no render, one skip at most.
    await page.locator('.cyc-plugincard-refresh').click();
    await expect.poll(() => engine.cardFetches()).toBeGreaterThan(fetches);
    await page.waitForTimeout(2000);
    const same = await counts(page);
    expect(delta(before, same, 'card.render'), 'same html re-rendered').toBe(0);

    // A refresh with NEW html: exactly one new render (the candidate that verified).
    engine.setCard(CARD_B);
    // The refresh button is floored at refreshFloorS=5; wait it out.
    await page.waitForTimeout(5200);
    await page.locator('.cyc-plugincard-refresh').click();
    await expect
      .poll(async () => delta(same, await counts(page), 'card.frame'), {timeout: 20_000})
      .toBe(1);
    await page.waitForTimeout(2500);
    const changed = await counts(page);
    const beats = await page.evaluate(() => (window as unknown as {__stormBeats: Beat[]}).__stormBeats);
    console.log('render-storm change: ' + JSON.stringify({renders: delta(same, changed, 'card.render'), beats}));
    expect(delta(same, changed, 'card.render'), 'a changed card must render exactly once').toBe(1);
    expect(beats[beats.length - 1].phase).toBe('candidate');
    expect(beats[beats.length - 1].nonEmpty).toBe(true);
    // The frame for the new html is the active one and the old one is gone.
    await expect(page.locator('.cyc-plugincard-frame')).toHaveCount(1);

    // Force the active frame to re-measure with an identical beat, so the parent
    // skips it and the first skip reaches the log as skipped=1. The card lives in
    // the fixed-width nav rail (railWidth = min(320, viewport)), so a desktop
    // viewport resize never changes the frame's size and its own ResizeObserver
    // never fires. Re-measure it the way the app does when the pane is re-shown:
    // a visibilitychange reveals the card, which pings the active frame; it
    // answers with the same beat. Poll for the skip rather than sleeping a fixed
    // window -- under parallel load the round trip drifts past any fixed wait.
    const skipsNow = () =>
      page.evaluate(() => (window as unknown as {__stormSkips: number[]}).__stormSkips.length);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(skipsNow, {timeout: 20_000}).toBeGreaterThan(0);
    const skips = await page.evaluate(() => (window as unknown as {__stormSkips: number[]}).__stormSkips);
    const after = await counts(page);
    expect(delta(changed, after, 'card.render'), 'the reveal re-rendered the new card').toBe(0);
    expect(skips[0]).toBe(1);
  });
});
