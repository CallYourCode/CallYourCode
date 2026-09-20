import {test, expect, type Page} from '@playwright/test';
import {WebSocketServer, type WebSocket as WS} from './wsshim';
import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'http';
import {PAGE, installIsolation, bootPinned} from './rig';
const CHAT = 'renderledger';
const QUIET = 'renderquiet';
const BASE = 1_700_000_000_000;
const COUNT = 1000;
const PAGE_SIZE = 100;

const OPEN_WINDOW = PAGE_SIZE;
type Msg = {seq: number; text: string; ts: number};
type Engine = {
  port: number;

  attaches(): string[];

  olders(): number[];

  live(id?: string): Msg;

  resendSessions(): void;

  setQuietThinking(on: boolean): void;

  muteAttach(on: boolean): void;
  close(): Promise<void>;
};

function startEngine(o: {unread?: boolean} = {}): Promise<Engine> {
  const sockets = new Set<WS>();
  const attaches: string[] = [];
  const olderFetches: number[] = [];
  const logs = new Map<string, Msg[]>([
    [CHAT, []],
    [QUIET, []]
  ]);
  const heard = new Map<string, number>([
    [CHAT, 0],
    [QUIET, 0]
  ]);
  let n = 0;
  let quietThinking = false;
  let attachMuted = false;
  const mint = (id: string): Msg => {
    const log = logs.get(id)!;
    const m = {seq: log.length, text: `msg-${String(n).padStart(4, '0')}`, ts: BASE + n * 1000};
    n++;
    log.push(m);
    return m;
  };
  for (let i = 0; i < COUNT; i++) mint(CHAT);
  mint(QUIET);

  {
    const l = logs.get(QUIET)!;
    heard.set(QUIET, l.length ? l[l.length - 1].ts : 0);
  }
  {
    const l = logs.get(CHAT)!;
    heard.set(CHAT, o.unread ? 0 : l.length ? l[l.length - 1].ts : 0);
  }
  const pageOf = (seq: number) => Math.floor(seq / PAGE_SIZE);
  const tailPage = (id: string) => {
    const l = logs.get(id)!;
    return l.length ? pageOf(l[l.length - 1].seq) : 0;
  };
  const pointerSeq = (id: string) => {
    const l = logs.get(id)!,
      h = heard.get(id)!;
    for (const m of l) if (m.ts > h) return m.seq;
    return l.length ? l[l.length - 1].seq + 1 : 0;
  };
  const unreadOf = (id: string) => {
    const l = logs.get(id)!,
      h = heard.get(id)!;
    return l.filter((m) => m.ts > h).length;
  };
  const buildPage = (id: string, p: number) => {
    const l = logs.get(id)!,
      lo = p * PAGE_SIZE,
      hi = lo + PAGE_SIZE;
    const messages = l
      .filter((m) => m.seq >= lo && m.seq < hi)
      .map((m) => ({t: 'chat', id, role: 'claude', seq: m.seq, text: m.text, ts: m.ts}));
    const last = messages[messages.length - 1] as {seq?: number} | undefined;
    return {page: p, version: last ? (last.seq ?? lo) + 1 : lo, sealed: p < tailPage(id), messages};
  };
  const sessionsFrame = () =>
    JSON.stringify({
      t: 'sessions',
      list: [
        {
          id: CHAT,
          name: CHAT,
          cwd: '/tmp/' + CHAT,
          unread: unreadOf(CHAT),
          muted: false,
          alive: true,
          status: 'idle',
          heardTs: heard.get(CHAT),
          title: {text: CHAT, detail: null as string | null}
        },
        {
          id: QUIET,
          name: QUIET,
          cwd: '/tmp/' + QUIET,
          unread: unreadOf(QUIET),
          muted: false,
          alive: true,
          status: quietThinking ? 'working' : 'idle',
          thinking: quietThinking,
          heardTs: heard.get(QUIET),
          title: {text: QUIET, detail: null as string | null}
        }
      ]
    });
  const broadcast = (raw: string) => {
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(raw);
  };
  const answerAttach = (ws: WS, id: string) => {
    if (ws.readyState !== ws.OPEN) return;
    const tail = tailPage(id);
    const ptr = pointerSeq(id);
    const ptrPage = Math.min(tail, Math.max(0, pageOf(ptr)));
    const wanted = ptrPage === tail ? [tail] : [ptrPage, tail];
    ws.send(
      JSON.stringify({
        t: 'attach-ok',
        id,
        known: true,
        pointer: ptr,
        pointerPage: ptrPage,
        tailPage: tail,
        pageSize: PAGE_SIZE,
        total: logs.get(id)!.length,
        pages: wanted.map((p) => buildPage(id, p))
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
    const m = (req.url ?? '').match(/^\/session\/([^/]+)\/page\/(\d+)/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      if (!logs.has(id)) {
        res.writeHead(404, CORS);
        res.end('{}');
        return;
      }
      const p = Math.max(0, parseInt(m[2], 10));
      if (p < tailPage(id)) olderFetches.push(p);
      res.writeHead(200, {'content-type': 'application/json', ...CORS});
      res.end(JSON.stringify(buildPage(id, p)));
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
    ws.send(sessionsFrame());
    ws.on('message', (raw) => {
      let f: {t?: string; id?: string; seq?: number; explicit?: boolean};
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (f.t === 'attach' && f.id && logs.has(f.id)) {
        attaches.push(f.id);
        if (!attachMuted) answerAttach(ws, f.id);
        return;
      }
      if (f.t === 'progress' && f.id && logs.has(f.id)) {
        const seq = Math.floor(Number(f.seq));
        const l = logs.get(f.id)!;
        let ts = 0;
        for (const mm of l) {
          if (mm.seq > seq) break;
          ts = mm.ts;
        }
        if (ts) {
          if (f.explicit === true && ts < heard.get(f.id)!) heard.set(f.id, ts);
          else if (ts > heard.get(f.id)!) heard.set(f.id, ts);
          broadcast(sessionsFrame());
        }
        return;
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as {port: number}).port,
        attaches: () => attaches.slice(),
        olders: () => olderFetches.slice(),
        live: (id = CHAT) => {
          const m = mint(id);
          heard.set(id, m.ts);
          broadcast(JSON.stringify({t: 'chat', id, role: 'claude', text: m.text, ts: m.ts}));
          return m;
        },
        resendSessions: () => broadcast(sessionsFrame()),
        setQuietThinking: (on: boolean) => {
          quietThinking = on;
          broadcast(sessionsFrame());
        },
        muteAttach: (on: boolean) => {
          attachMuted = on;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const ws of sockets) ws.terminate();
            wss.close(() => server.close(() => done()));
          })
      })
    )
  );
}
const PHONE = {width: 390, height: 844};
async function boot(page: Page, port: number) {
  await page.setViewportSize(PHONE);
  await installIsolation(page);
  await bootPinned(page, port);
}
const sid = (port: number, id: string) => `ws://127.0.0.1:${port}/ws|${id}`;
async function openChat(page: Page, name = CHAT) {
  await page.$$eval(
    '.cyc-session-entry',
    (els, chat) => {
      const row = els.find((e) => (e.textContent ?? '').includes(chat)) as HTMLElement | undefined;
      if (!row) throw new Error('no chat row for ' + chat);
      row.click();
    },
    name
  );
  await page.waitForSelector('.cyc-message-list-scroll', {timeout: 10_000});
}
const held = (page: Page, port: number, id = CHAT) =>
  page.evaluate(
    (s) =>
      (
        window as unknown as {__cycMessages(id: string): {text: string; ts: number}[]}
      ).__cycMessages(s),
    sid(port, id)
  );

async function armObserver(page: Page, selector: string, key: string) {
  await page.evaluate(
    ({selector, key}) => {
      const root = document.querySelector(selector);
      if (!root) throw new Error('no surface at ' + selector);
      const w = window as unknown as {__cycMut: Record<string, number>};
      w.__cycMut = w.__cycMut ?? {};
      w.__cycMut[key] = 0;
      const mo = new MutationObserver((muts) => {
        w.__cycMut[key] += muts.length;
      });
      mo.observe(root, {childList: true, attributes: true, characterData: true, subtree: true});
    },
    {selector, key}
  );
}
const mutations = (page: Page, key: string) =>
  page.evaluate((k) => (window as unknown as {__cycMut: Record<string, number>}).__cycMut[k], key);
type SurfaceStat = {paints: number; skips: number};
type SurfaceStats = {tabs: SurfaceStat; list: SurfaceStat; chat: SurfaceStat};

const surfaceStats = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as {__cycSurfaceStats(): SurfaceStats}).__cycSurfaceStats()
  ) as Promise<SurfaceStats>;
test('U1 replay-paints-once: a cold-open window is a handful of paints, not one per frame', async ({
  page
}) => {
  test.setTimeout(60_000);
  const engine = await startEngine();
  try {
    await boot(page, engine.port);
    const before = await page.evaluate(() =>
      (window as unknown as {__cycRenderCount(): number}).__cycRenderCount()
    );
    await openChat(page);
    await expect
      .poll(() => held(page, engine.port).then((m) => m.length), {timeout: 20_000})
      .toBe(OPEN_WINDOW);
    await page.waitForTimeout(700);
    const after = await page.evaluate(() =>
      (window as unknown as {__cycRenderCount(): number}).__cycRenderCount()
    );
    expect(
      after - before,
      'opening a chat with a full window painted the app more than a handful of times: ' +
        'the burst is not coalescing into the one landed paint (U1)'
    ).toBeLessThanOrEqual(6);
  } finally {
    await engine.close();
  }
});
test('U2 open-paints-local: a cached chat paints its window while the engine says nothing', async ({
  page
}) => {
  test.setTimeout(90_000);

  const engine = await startEngine({unread: true});
  try {
    await boot(page, engine.port);
    await openChat(page);
    await expect
      .poll(() => held(page, engine.port).then((m) => m.length), {timeout: 20_000})
      .toBeGreaterThanOrEqual(OPEN_WINDOW);
    await page.waitForTimeout(2500);
    engine.muteAttach(true);
    await page.reload();
    await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
    if (!(await page.locator('.cyc-message-list-scroll').count())) await openChat(page);

    await expect
      .poll(() => page.locator('.cyc-message-list-inner .cyc-message').count(), {timeout: 8000})
      .toBeGreaterThan(5);
    const msgs = await held(page, engine.port);
    expect(
      msgs.length,
      'the cached window did not hydrate while the engine was silent'
    ).toBeGreaterThan(OPEN_WINDOW / 2);
  } finally {
    await engine.close();
  }
});
test('U3 backfill-holds-the-view: an older page lands above without moving what is on screen', async ({
  page
}) => {
  test.setTimeout(60_000);
  const engine = await startEngine();
  try {
    await boot(page, engine.port);
    await openChat(page);
    await expect
      .poll(() => held(page, engine.port).then((m) => m.length), {timeout: 20_000})
      .toBe(OPEN_WINDOW);

    await page.waitForTimeout(800);
    let before = {fromBottom: 0};
    for (let i = 0; i < 12 && !engine.olders().length; i++) {
      before = await page.evaluate(() => {
        const el = document.querySelector('.cyc-message-list-scroll') as HTMLElement;
        el.scrollTop = 1;
        el.scrollTop = 0;
        return {fromBottom: el.scrollHeight - el.scrollTop};
      });
      await page.waitForTimeout(500);
    }
    await expect.poll(() => engine.olders().length, {timeout: 15_000}).toBeGreaterThan(0);
    await expect
      .poll(() => held(page, engine.port).then((m) => m.length), {timeout: 20_000})
      .toBeGreaterThan(OPEN_WINDOW);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => {
      const el = document.querySelector('.cyc-message-list-scroll') as HTMLElement;
      return {fromBottom: el.scrollHeight - el.scrollTop};
    });
    expect(
      Math.abs(after.fromBottom - before.fromBottom),
      'the older page moved the view: the fromBottom anchor did not hold (U3)'
    ).toBeLessThanOrEqual(4);
  } finally {
    await engine.close();
  }
});
test('U4 no-op-notify-touches-nothing: an unchanged store leaves both surfaces untouched', async ({
  page
}) => {
  test.setTimeout(60_000);
  const engine = await startEngine();
  try {
    await boot(page, engine.port);
    await openChat(page);
    await expect
      .poll(() => held(page, engine.port).then((m) => m.length), {timeout: 20_000})
      .toBe(OPEN_WINDOW);
    await page.waitForTimeout(1000);
    await armObserver(page, '.cyc-stack', 'list');
    await armObserver(page, '.cyc-message-list-inner', 'chat');

    for (let i = 0; i < 10; i++) engine.resendSessions();
    await page.waitForTimeout(800);
    expect(
      await mutations(page, 'list'),
      'a notify that changed NOTHING mutated the chat list DOM: rows are being rebuilt or ' +
        'reordered for engine chatter (U4)'
    ).toBe(0);
    expect(
      await mutations(page, 'chat'),
      'a notify that changed NOTHING mutated the open chat DOM: messageNodes or pills are ' +
        'being rebuilt for engine chatter (U4)'
    ).toBe(0);
  } finally {
    await engine.close();
  }
});
test('U5 unchanged-rows-keep-their-nodes: identity survives a real update elsewhere', async ({
  page
}) => {
  test.setTimeout(60_000);
  const engine = await startEngine();
  try {
    await boot(page, engine.port);
    await openChat(page);
    await expect
      .poll(() => held(page, engine.port).then((m) => m.length), {timeout: 20_000})
      .toBe(OPEN_WINDOW);
    await page.waitForTimeout(600);

    await page.evaluate((quiet) => {
      const w = window as unknown as {__probeRow?: Element | null; __probeMessage?: Element | null};
      w.__probeRow =
        [...document.querySelectorAll('.cyc-session-entry')].find((e) =>
          (e.textContent ?? '').includes(quiet)
        ) ?? null;
      const messageNodes = document.querySelectorAll('.cyc-message-list-inner .cyc-message');
      w.__probeMessage = messageNodes.length > 4 ? messageNodes[messageNodes.length - 4] : null;
      if (!w.__probeRow || !w.__probeMessage) throw new Error('probe nodes missing');
    }, QUIET);

    engine.live(CHAT);
    await page.waitForTimeout(800);
    const kept = await page.evaluate((quiet) => {
      const w = window as unknown as {__probeRow?: Element | null; __probeMessage?: Element | null};
      const row =
        [...document.querySelectorAll('.cyc-session-entry')].find((e) =>
          (e.textContent ?? '').includes(quiet)
        ) ?? null;
      const messageNodes = document.querySelectorAll('.cyc-message-list-inner .cyc-message');
      return {
        row: row !== null && row === w.__probeRow,
        messageNode:
          w.__probeMessage !== null && [...messageNodes].includes(w.__probeMessage as Element)
      };
    }, QUIET);
    expect(
      kept.row,
      'a row whose content did not change lost its DOM node when another chat updated (U5): ' +
        'clicks in flight on it died, hover strobed'
    ).toBe(true);
    expect(
      kept.messageNode,
      'a settled messageNode was rebuilt when a new message appended below it (U5)'
    ).toBe(true);
  } finally {
    await engine.close();
  }
});
test('U6 animations-survive-updates: the typing indicator is created once and lives across notifies', async ({
  page
}) => {
  test.setTimeout(60_000);
  const engine = await startEngine();
  try {
    await boot(page, engine.port);
    engine.setQuietThinking(true);

    await page.waitForTimeout(800);
    const found = await page.evaluate((quiet) => {
      const w = window as unknown as {__probeAnim?: Element | null};
      const row = [...document.querySelectorAll('.cyc-session-entry')].find((e) =>
        (e.textContent ?? '').includes(quiet)
      );
      w.__probeAnim = row?.querySelector('.cyc-list-row-subtitle') ?? null;
      return !!w.__probeAnim;
    }, QUIET);
    expect(found, 'no subtitle node on the thinking row').toBe(true);

    for (let i = 0; i < 5; i++) engine.resendSessions();
    engine.live(CHAT);
    await page.waitForTimeout(800);
    const kept = await page.evaluate((quiet) => {
      const w = window as unknown as {__probeAnim?: Element | null};
      const row = [...document.querySelectorAll('.cyc-session-entry')].find((e) =>
        (e.textContent ?? '').includes(quiet)
      );
      return row?.querySelector('.cyc-list-row-subtitle') === w.__probeAnim;
    }, QUIET);
    expect(
      kept,
      'the animating indicator node was recreated by a notify that did not change its state ' +
        '(U6): its animation restarts, which is the visible stutter'
    ).toBe(true);
  } finally {
    await engine.close();
  }
});
test('busy-dots-glyph: a thinking row and the toolbar show the dots glyph; idle ones do not', async ({
  page
}) => {
  test.setTimeout(60_000);
  const engine = await startEngine();
  try {
    await boot(page, engine.port);
    engine.setQuietThinking(true);
    await page.waitForTimeout(800);

    const rows = await page.evaluate((quiet) => {
      const entries = [...document.querySelectorAll('.cyc-session-entry')];
      const thinkingRow = entries.find((e) => (e.textContent ?? '').includes(quiet));
      const idleRow = entries.find((e) => !(e.textContent ?? '').includes(quiet));
      return {
        thinkingHasDots: !!thinkingRow?.querySelector('.cyc-list-row-subtitle .cyc-busy-dots'),
        idleHasDots: !!idleRow?.querySelector('.cyc-list-row-subtitle .cyc-busy-dots')
      };
    }, QUIET);
    expect(rows.thinkingHasDots, 'the thinking row has no dots glyph').toBe(true);
    expect(rows.idleHasDots, 'the idle row wrongly shows a dots glyph').toBe(false);

    await openChat(page, QUIET);
    const busyHeader = await page.$eval(
      '.cyc-mast-status',
      (el) => !!el.querySelector('.cyc-busy-dots')
    );
    expect(busyHeader, 'the toolbar has no dots glyph while the session is thinking').toBe(true);

    engine.setQuietThinking(false);
    await page.waitForTimeout(800);
    const idleHeader = await page.$eval(
      '.cyc-mast-status',
      (el) => !!el.querySelector('.cyc-busy-dots')
    );
    expect(idleHeader, 'the toolbar wrongly shows a dots glyph once idle').toBe(false);
  } finally {
    await engine.close();
  }
});

test('#403a no-op-notify-skips-the-surface-entry-point: an unchanged store invokes no surface', async ({
  page
}) => {
  test.setTimeout(60_000);
  const engine = await startEngine();
  try {
    await boot(page, engine.port);
    await openChat(page);
    await expect
      .poll(() => held(page, engine.port).then((m) => m.length), {timeout: 20_000})
      .toBe(OPEN_WINDOW);
    await page.waitForTimeout(1000);
    const before = await surfaceStats(page);

    for (let i = 0; i < 10; i++) engine.resendSessions();
    await page.waitForTimeout(800);
    const after = await surfaceStats(page);
    expect(
      after.chat.paints - before.chat.paints,
      'a notify that changed NOTHING re-ran the chat pane entry point: renderMessages rebuilt the ' +
        'whole conversation for engine chatter (#403a, CPU-side of U4)'
    ).toBe(0);
    expect(
      after.list.paints - before.list.paints,
      'a notify that changed NOTHING re-ran the chat list entry point: rows are rebuilt and ' +
        'discarded for engine chatter (#403a, CPU-side of U4)'
    ).toBe(0);
    expect(
      after.tabs.paints - before.tabs.paints,
      'a notify that changed NOTHING re-ran the tab strip entry point (#403a)'
    ).toBe(0);

    expect(
      after.chat.skips + after.list.skips - before.chat.skips - before.list.skips,
      'the notifies never reached the surfaces at all, so the skip guard was not exercised'
    ).toBeGreaterThan(0);
  } finally {
    await engine.close();
  }
});
test('#403a a-real-change-still-renders: a live line repaints the chat and its list row', async ({
  page
}) => {
  test.setTimeout(60_000);
  const engine = await startEngine();
  try {
    await boot(page, engine.port);
    await openChat(page);
    await expect
      .poll(() => held(page, engine.port).then((m) => m.length), {timeout: 20_000})
      .toBe(OPEN_WINDOW);
    await page.waitForTimeout(1000);
    const before = await surfaceStats(page);

    engine.live(CHAT);
    await expect
      .poll(() => held(page, engine.port).then((m) => m.length), {timeout: 10_000})
      .toBe(OPEN_WINDOW + 1);
    await page.waitForTimeout(400);
    const after = await surfaceStats(page);
    expect(
      after.chat.paints - before.chat.paints,
      'a real new message did NOT repaint the chat pane: content versioning went too far and ' +
        'skipped a genuine change (#403a)'
    ).toBeGreaterThan(0);
    expect(
      after.list.paints - before.list.paints,
      'a real new message did NOT repaint the chat list: the row preview is now stale (#403a)'
    ).toBeGreaterThan(0);
  } finally {
    await engine.close();
  }
});
