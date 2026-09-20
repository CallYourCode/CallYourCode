import {test, expect, type Page} from '@playwright/test';
import {WebSocketServer, type WebSocket as WS} from './wsshim';
import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'http';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {bootPinned} from './rig';

// Owner's phone (2026-09-02): "the whole conversation rerenders on every chunk
// of the message". An agent reply reaches the app as ONE chat row followed by
// the clip that grows behind it: `chat` (growing) -> `say` -> N x `say-grow`
// -> the same `chat` again (growing cleared, durationS) -> `say-done`. While
// that streams, the other rows of the chat must keep their DOM: no row outside
// the growing bubble is rebuilt, no node outside it is removed, and the
// elements of earlier rows stay connected.
//
// This spec opens a chat of 60 mixed rows (text, code block, photo, file,
// voice note, spoken reply) at phone width, streams one reply in 40 chunks,
// and watches the list with a MutationObserver that classifies every mutation
// as inside or outside the growing bubble. Two further streams that happen
// alongside a reply on a live engine are measured the same way: 40 short chat
// rows in a row (an agent narrating), and 40 session beats (status/detail
// flips while the agent works).

const CHAT = 'streamchat';
const BASE = 1_700_000_000_000;
const PAGE_SIZE = 100;
const CHUNKS = 40;
const CHUNK_GAP_MS = 120;
const HISTORY = 60;
const KEEP_ROWS = 10;

// A 1x1 PNG, so photo rows resolve their picture over the tunnel like real ones.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

type Wire = Record<string, unknown>;

const img = (id: string) => ({
  uploadId: id,
  name: `${id}.png`,
  mime: 'image/png',
  size: PNG_1x1.length,
  path: `${id}.png`,
  image: true,
  width: 96,
  height: 64
});

const CODE =
  'Here is the patch:\n```ts\nexport function sum(a: number, b: number) {\n  return a + b;\n}\n```\nApplied.';

// 60 rows of mixed kinds. Every kind that has its own renderer appears at
// least a handful of times so the reuse path is exercised across all of them.
function history(): Wire[] {
  const out: Wire[] = [];
  for (let i = 0; i < HISTORY; i++) {
    const ts = BASE + i * 60_000;
    const base = {t: 'chat', id: CHAT, seq: i, ts};
    switch (i % 8) {
      case 0:
        out.push({...base, role: 'user', text: `question ${i}: what does the loader do?`});
        break;
      case 1:
        out.push({
          ...base,
          role: 'claude',
          text: `It reads the manifest first (${i}), then the pages.`
        });
        break;
      case 2:
        out.push({...base, role: 'claude', text: CODE});
        break;
      case 3:
        out.push({...base, role: 'user', text: 'this one', upload: img(`p${i}`)});
        break;
      case 4:
        out.push({
          ...base,
          role: 'claude',
          text: `notes-${i}.md`,
          file: {docId: `d${i}`, name: `notes-${i}.md`, fileKind: 'markdown', size: 4096}
        });
        break;
      case 5:
        out.push({
          ...base,
          role: 'user',
          kind: 'voice',
          text: `spoken question ${i}`,
          durationS: 4
        });
        break;
      case 6:
        out.push({
          ...base,
          role: 'claude',
          text: `Spoken answer ${i}.`,
          msgId: `m${i}`,
          durationS: 3
        });
        break;
      default:
        out.push({...base, role: 'user', text: `ok ${i}`});
    }
  }
  return out;
}

type Engine = {
  port: number;
  send(frame: Wire): void;
  setDetail(d: string): void;
  sessionsFrame(): string;
  nextSeq(): number;
  close(): Promise<void>;
};

function startEngine(): Promise<Engine> {
  const sockets = new Set<WS>();
  const log = history();
  let detail = 'idle';
  const buildPage = () => ({page: 0, version: log.length, sealed: false, messages: log});
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
          heardTs: BASE,
          title: {text: CHAT, detail}
        }
      ]
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
    if (url.startsWith('/upload/')) {
      res.writeHead(200, {'content-type': 'image/png', ...CORS});
      res.end(PNG_1x1);
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
        send: (frame) => {
          if (frame.t === 'chat') log.push(frame);
          broadcast(JSON.stringify(frame));
        },
        setDetail: (d) => {
          detail = d;
        },
        sessionsFrame,
        nextSeq: () => log.length,
        close: () =>
          new Promise<void>((done) => {
            for (const ws of sockets) ws.terminate();
            wss.close(() => server.close(() => done()));
          })
      })
    )
  );
}

// ---------------------------------------------------------------------------
// In-page probe. Installed after the chat is open and before a stream starts.

type ChunkStat = {
  addedOut: number;
  removedOut: number;
  attrOut: number;
  textOut: number;
  addedIn: number;
  removedIn: number;
  attrIn: number;
  textIn: number;
  renders: number;
  renderMs: number;
  chatPaints: number;
  chatPaintMs: number;
  // Labels for the first out-of-bubble mutations (see `label` in INSTALL).
  notes: string[];
};

type ProbeWindow = {
  __streamProbe?: {
    stats: ChunkStat;
    keep: {mid: string; el: Element}[];
    growingMid: string | null;
    obs: MutationObserver;
    classify: (records: MutationRecord[]) => void;
    // Records buffered by the observer and classified only in TAKE, after the
    // step has set growingMid. The observer fires mid-render, before the newly
    // landed row's id is known, so classifying there would score every chunk
    // against the previous chunk's growing row.
    pending: MutationRecord[];
    lastPerf: number;
  };
};

// `growingMid` names the message id (data-mid) of the bubble that is allowed
// to change. A mutation counts as inside it when its target sits under that
// row, or when the row itself is the node being added (its first paint).
const INSTALL = (keepRows: number) => {
  const w = window as unknown as ProbeWindow;
  const inner = document.querySelector('.cyc-message-list-inner')!;
  const zero = (): ChunkStat => ({
    addedOut: 0,
    removedOut: 0,
    attrOut: 0,
    textOut: 0,
    addedIn: 0,
    removedIn: 0,
    attrIn: 0,
    textIn: 0,
    renders: 0,
    renderMs: 0,
    chatPaints: 0,
    chatPaintMs: 0,
    notes: []
  });
  const rows = Array.from(inner.querySelectorAll<HTMLElement>('.cyc-message[data-mid]'));
  // The last `keepRows` rows before the stream: the ones a reader is looking at.
  const keep = rows.slice(-keepRows).map((el) => ({mid: el.dataset.mid!, el}));
  const probe = {
    stats: zero(),
    keep,
    growingMid: null as string | null,
    pending: [] as MutationRecord[],
    lastPerf: 0,
    obs: null as unknown as MutationObserver,
    classify: null as unknown as (records: MutationRecord[]) => void
  };
  const rowOf = (n: Node): HTMLElement | null => {
    const el = n.nodeType === 1 ? (n as HTMLElement) : n.parentElement;
    return el?.closest<HTMLElement>('.cyc-message[data-mid]') ?? null;
  };
  const inside = (n: Node): boolean => {
    if (!probe.growingMid) return false;
    return rowOf(n)?.dataset.mid === probe.growingMid;
  };
  // A short label for an out-of-bubble mutation, so a failing run says WHICH
  // node moved: kind, the element, and the row (data-mid) it belongs to.
  const label = (kind: string, n: Node, extra = ''): string => {
    const el = n.nodeType === 1 ? (n as HTMLElement) : n.parentElement;
    const cls = el ? el.className.toString().split(/\s+/).slice(0, 2).join('.') : '#text';
    const mid = rowOf(n)?.dataset.mid ?? el?.dataset?.mid ?? '-';
    return `${kind} ${el?.tagName.toLowerCase() ?? '#text'}.${cls} row=${mid}${extra}`;
  };
  const note = (s: ChunkStat, text: string) => {
    if (s.notes.length < 12) s.notes.push(text);
  };
  probe.classify = (records) => {
    const s = probe.stats;
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of Array.from(r.addedNodes)) {
          if (inside(n) || inside(r.target)) s.addedIn++;
          else {
            s.addedOut++;
            note(s, label('add', n));
          }
        }
        for (const n of Array.from(r.removedNodes)) {
          // A removed node is detached: classify by the parent it left and by
          // its own data-mid (a whole row removed is a row outside the bubble
          // unless it IS the growing bubble).
          const own = n.nodeType === 1 ? (n as HTMLElement).dataset?.mid : undefined;
          if (inside(r.target) || (own && own === probe.growingMid)) s.removedIn++;
          else {
            s.removedOut++;
            note(s, label('remove', n));
          }
        }
      } else if (r.type === 'attributes') {
        if (inside(r.target)) s.attrIn++;
        else {
          s.attrOut++;
          note(s, label('attr', r.target, ` ${r.attributeName}`));
        }
      } else if (r.type === 'characterData') {
        if (inside(r.target)) s.textIn++;
        else {
          s.textOut++;
          note(s, label('text', r.target));
        }
      }
    }
  };
  probe.obs = new MutationObserver((records) => probe.pending.push(...records));
  probe.obs.observe(inner, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true
  });
  w.__streamProbe = probe;
  return {rows: rows.length, keep: keep.map((k) => k.mid)};
};

const SET_GROWING = (mid: string | null) => {
  (window as unknown as ProbeWindow).__streamProbe!.growingMid = mid;
};

// Fold the paint measures since the last take into the stats, hand the stats
// back, and start a fresh window.
const TAKE = () => {
  const p = (window as unknown as ProbeWindow).__streamProbe!;
  p.classify(p.pending.splice(0).concat(p.obs.takeRecords()));
  const all = performance.getEntriesByType('measure');
  for (const e of all) {
    if (e.startTime < p.lastPerf) continue;
    if (e.name === 'cyc.render') {
      p.stats.renders++;
      p.stats.renderMs += e.duration;
    } else if (e.name === 'cyc.paint.chat') {
      p.stats.chatPaints++;
      p.stats.chatPaintMs += e.duration;
    }
  }
  p.lastPerf = performance.now();
  const out = p.stats;
  p.stats = {
    addedOut: 0,
    removedOut: 0,
    attrOut: 0,
    textOut: 0,
    addedIn: 0,
    removedIn: 0,
    attrIn: 0,
    textIn: 0,
    renders: 0,
    renderMs: 0,
    chatPaints: 0,
    chatPaintMs: 0,
    notes: []
  };
  return out;
};

const KEEP_STATE = () => {
  const p = (window as unknown as ProbeWindow).__streamProbe!;
  return p.keep.map((k) => ({
    mid: k.mid,
    connected: k.el.isConnected,
    // The row that carries this id now: the same element, or a rebuilt one.
    same: document.querySelector(`.cyc-message[data-mid="${k.mid}"]`) === k.el
  }));
};

const MID_OF_LAST = () => {
  const rows = document.querySelectorAll<HTMLElement>(
    '.cyc-message-list-inner .cyc-message[data-mid]'
  );
  return rows.length ? (rows[rows.length - 1].dataset.mid ?? null) : null;
};

const ROW_COUNT = () =>
  document.querySelectorAll('.cyc-message-list-inner .cyc-message[data-mid]').length;

type StreamReport = {
  name: string;
  chunks: number;
  rowsBefore: number;
  rowsAfter: number;
  perChunk: ChunkStat[];
  totals: ChunkStat;
  chunksWithRemovalsOutside: number;
  chunksWithAddsOutside: number;
  keep: {mid: string; connected: boolean; same: boolean}[];
};

function sum(list: ChunkStat[]): ChunkStat {
  const t: ChunkStat = {
    addedOut: 0,
    removedOut: 0,
    attrOut: 0,
    textOut: 0,
    addedIn: 0,
    removedIn: 0,
    attrIn: 0,
    textIn: 0,
    renders: 0,
    renderMs: 0,
    chatPaints: 0,
    chatPaintMs: 0,
    notes: []
  };
  for (const c of list)
    for (const k of Object.keys(t) as (keyof ChunkStat)[]) {
      if (k === 'notes') continue;
      (t[k] as number) += c[k] as number;
    }
  t.renderMs = Math.round(t.renderMs * 10) / 10;
  t.chatPaintMs = Math.round(t.chatPaintMs * 10) / 10;
  return t;
}

async function openChat(page: Page) {
  await page.locator('.cyc-session-entry', {hasText: CHAT}).first().click();
  await expect(page.locator('.cyc-message-list-inner .cyc-message[data-mid]')).toHaveCount(HISTORY);
  // Photos resolve over the tunnel; let that settle so it does not count.
  await page.waitForTimeout(1200);
}

const RENDER_COUNT = () =>
  (window as unknown as {__cycRenderCount?: () => number}).__cycRenderCount?.() ?? 0;

// One wire frame and what the page is expected to do with it: `row` lands a
// new chat row (the probe then names that row as the growing one), `render`
// repaints without a new row, `none` is a beat the app must not paint for
// (a say-grow), so the page just gets CHUNK_GAP_MS to prove it.
type Step = {send: () => void; settle: 'row' | 'render' | 'none'};

async function stream(page: Page, name: string, steps: Step[]): Promise<StreamReport> {
  const rowsBefore = await page.evaluate(ROW_COUNT);
  await page.evaluate(TAKE);
  const perChunk: ChunkStat[] = [];
  let growing: string | null = null;
  for (const step of steps) {
    const rows = await page.evaluate(ROW_COUNT);
    const renders = await page.evaluate(RENDER_COUNT);
    step.send();
    if (step.settle === 'row') {
      await page.waitForFunction(
        (n) =>
          document.querySelectorAll('.cyc-message-list-inner .cyc-message[data-mid]').length > n,
        rows,
        {timeout: 2000}
      );
      growing = await page.evaluate(MID_OF_LAST);
    } else if (step.settle === 'render') {
      await page.waitForFunction(
        (n) =>
          ((window as unknown as {__cycRenderCount?: () => number}).__cycRenderCount?.() ?? 0) > n,
        renders,
        {timeout: 2000}
      );
    } else {
      await page.waitForTimeout(CHUNK_GAP_MS);
    }
    await page.evaluate(SET_GROWING, growing);
    perChunk.push(await page.evaluate(TAKE));
  }
  // The trailing notify (200 ms timer) and any image settle.
  await page.waitForTimeout(400);
  perChunk.push(await page.evaluate(TAKE));
  const totals = sum(perChunk);
  return {
    name,
    chunks: steps.length,
    rowsBefore,
    rowsAfter: await page.evaluate(ROW_COUNT),
    perChunk: perChunk.map((c) => ({
      ...c,
      renderMs: Math.round(c.renderMs * 10) / 10,
      chatPaintMs: Math.round(c.chatPaintMs * 10) / 10
    })),
    totals,
    chunksWithRemovalsOutside: perChunk.filter((c) => c.removedOut > 0).length,
    chunksWithAddsOutside: perChunk.filter((c) => c.addedOut > 0).length,
    keep: await page.evaluate(KEEP_STATE)
  };
}

function saveReport(reports: StreamReport[]) {
  const path = process.env.CYC_STREAM_REPORT;
  if (!path) return;
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(reports, null, 2));
}

test.describe('streaming a reply keeps every other row', () => {
  test.setTimeout(120_000);
  let engine: Engine;
  test.beforeEach(async () => {
    engine = await startEngine();
  });
  test.afterEach(async () => {
    await engine.close();
  });

  test('40 chunks of one reply, 40 narrated rows, 40 session beats: rows outside the growing bubble keep their DOM', async ({
    page
  }) => {
    await bootPinned(page, engine.port, {size: {width: 390, height: 844}});
    await openChat(page);
    const installed = await page.evaluate(INSTALL, KEEP_ROWS);
    expect(installed.rows).toBe(HISTORY);
    expect(installed.keep).toHaveLength(KEEP_ROWS);
    const reports: StreamReport[] = [];

    // 1. One spoken reply growing in 40 chunks: the real wire order.
    {
      const seq = engine.nextSeq();
      const ts = BASE + HISTORY * 60_000 + 5_000;
      const msgId = 'grow-1';
      const text =
        'This is the reply that grows. ' +
        Array.from({length: CHUNKS}, (_, i) => `Sentence number ${i + 1} of the answer.`).join(' ');
      const chat: Wire = {t: 'chat', id: CHAT, role: 'claude', seq, ts, text, msgId, growing: true};
      const steps: Step[] = [
        {send: () => engine.send(chat), settle: 'row'},
        {
          send: () => engine.send({t: 'say', id: CHAT, msgId, text, growing: true}),
          settle: 'render'
        }
      ];
      for (let i = 1; i <= CHUNKS; i++) {
        const chars = Math.round((text.length * i) / CHUNKS);
        steps.push({
          send: () => engine.send({t: 'say-grow', id: CHAT, msgId, durS: i * 0.6, chars}),
          settle: 'none'
        });
      }
      // The engine re-sends the chat frame with growing cleared. The store
      // holds one row per seq and folds this into the row it already has, so
      // it repaints nothing on its own; say-done, next, carries the finish.
      steps.push({
        send: () => engine.send({...chat, growing: undefined, durationS: CHUNKS * 0.6}),
        settle: 'none'
      });
      steps.push({
        send: () => engine.send({t: 'say-done', id: CHAT, msgId, durationS: CHUNKS * 0.6}),
        settle: 'render'
      });
      reports.push(await stream(page, 'growing-reply', steps));
    }

    // 2. Forty short rows in a row: the newest row is the one allowed to change.
    {
      const steps: Step[] = [];
      for (let i = 0; i < CHUNKS; i++) {
        steps.push({
          send: () => {
            const seq = engine.nextSeq();
            engine.send({
              t: 'chat',
              id: CHAT,
              role: 'claude',
              seq,
              ts: BASE + HISTORY * 60_000 + 60_000 + i * 1000,
              text: `narration line ${i + 1}`
            });
          },
          settle: 'row'
        });
      }
      reports.push(await stream(page, 'narrated-rows', steps));
    }

    // 3. Forty session beats with a changing status detail, no chat rows.
    {
      const steps: Step[] = [];
      for (let i = 0; i < CHUNKS; i++) {
        steps.push({
          send: () => {
            engine.setDetail(i % 2 ? 'Reading src/renderHub.ts' : 'Thinking');
            engine.send(JSON.parse(engine.sessionsFrame()));
          },
          settle: 'render'
        });
      }
      reports.push(await stream(page, 'session-beats', steps));
    }

    saveReport(reports);
    for (const r of reports) {
      console.log(
        `stream-rerender ${r.name}: ` +
          JSON.stringify({
            rows: [r.rowsBefore, r.rowsAfter],
            totals: r.totals,
            chunksWithRemovalsOutside: r.chunksWithRemovalsOutside,
            chunksWithAddsOutside: r.chunksWithAddsOutside,
            keepConnected: r.keep.filter((k) => k.connected && k.same).length + '/' + r.keep.length
          })
      );
      test.info().annotations.push({type: r.name, description: JSON.stringify(r.totals)});
    }

    const [grow, rows, beats] = reports;
    const outside = (r: StreamReport) =>
      r.perChunk.flatMap((c, i) => c.notes.map((n) => `${r.name}#${i}: ${n}`));

    // The growing reply: one row added at the start, and nothing outside it is
    // ever removed. Every row that was on screen before keeps its element.
    expect(grow.rowsAfter).toBe(grow.rowsBefore + 1);
    expect(grow.totals.removedOut, outside(grow).join('\n')).toBe(0);
    expect(
      grow.keep.every((k) => k.connected && k.same),
      JSON.stringify(grow.keep)
    ).toBe(true);
    // The 40 say-grow beats themselves paint nothing: renders come from the
    // chat row, the say, and the close-out (chat again + say-done).
    const growBeats = grow.perChunk.slice(2, 2 + CHUNKS);
    expect(growBeats.reduce((n, c) => n + c.renders, 0)).toBe(0);

    // Forty rows in a row: each lands as an add, none rebuilds its neighbour.
    // The row above a new same-role row flips its group-end state in place
    // (two classes and one data attribute): the only writes outside the new row.
    expect(rows.rowsAfter).toBe(rows.rowsBefore + CHUNKS);
    expect(rows.totals.removedOut, outside(rows).join('\n')).toBe(0);
    expect(rows.totals.addedOut, outside(rows).join('\n')).toBe(0);
    expect(rows.totals.attrOut, outside(rows).join('\n')).toBe(3 * CHUNKS);
    const flips = outside(rows).filter((n) => n.includes('attr'));
    expect(
      flips.every((n) => / class$| data-cyc-last$/.test(n)),
      flips.join('\n')
    ).toBe(true);
    expect(
      rows.keep.every((k) => k.connected && k.same),
      JSON.stringify(rows.keep)
    ).toBe(true);

    // Session beats repaint the header, not the list: no row is added or
    // removed and every earlier row keeps its element. A voice clip already
    // on screen may settle its own play control's class as it decodes; that
    // self-update inside an unchanged row is not a re-render of the list, so
    // the only attribute writes allowed outside the (absent) growing bubble
    // are on a cyc-clip control.
    expect(beats.rowsAfter).toBe(beats.rowsBefore);
    expect(beats.totals.addedOut + beats.totals.removedOut, outside(beats).join('\n')).toBe(0);
    const beatAttrs = outside(beats).filter((n) => n.includes('attr'));
    expect(
      beatAttrs.every((n) => n.includes('cyc-clip')),
      beatAttrs.join('\n')
    ).toBe(true);
    expect(
      beats.keep.every((k) => k.connected && k.same),
      JSON.stringify(beats.keep)
    ).toBe(true);
  });
});
