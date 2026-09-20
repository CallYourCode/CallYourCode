import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'http';
import {deflateSync} from 'node:zlib';
import {WebSocketServer, type WebSocket as WS} from './wsshim';

// A hermetic sealed engine tailored for the presentation-to-TS screenshot
// oracle. It differs from contract-render's engine in three ways every scenario
// leans on:
//   1. it declares a Search *panel* plugin, so the conversation toolbar lands a
//      plugin-gated Search slot that opens a real panel;
//   2. its one rich session carries ordinary text, one image upload and one file
//      doc, so chat / profile-media render the real attachment paint paths;
//   3. its HTTP surface answers /upload, /doc and /plugin/search/panel with
//      deterministic bytes and status 200, so "available" media is genuinely
//      served through the sealed tunnel rather than faked in the DOM.
//
// Two break knobs exist only to prove the assertions bite (see the spec's
// failure-injection tests): CYC_ORACLE_BREAK_SEARCH drops the Search decl and
// CYC_ORACLE_BREAK_MEDIA answers the upload/doc bytes with 404.

export type PresentationEngine = {
  port: number;
  richId: string;
  close(): Promise<void>;
};

export type PresentationEngineOptions = {
  breakSearch?: boolean;
  breakMedia?: boolean;
};

// A fixed instant well in the past so every timestamp, day-group header and
// "shared on" label paints the same string on every run (paired with the spec's
// timezoneId: 'UTC'). Never Date.now().
const BASE = Date.UTC(2024, 0, 15, 9, 30, 0);
const RICH_ID = 'oracle-relay';
const IMG_ID = 'oracle-img-architecture';
const DOC_ID = 'oracle-doc-runbook';

const PNG_BYTES = makeGradientPng(96, 64);
const DOC_BYTES = Buffer.from(
  'Oracle runbook\n' +
    '==============\n\n' +
    '1. Confirm the relay is accepting peers.\n' +
    '2. Restart after every deploy.\n' +
    '3. Watch the 5xx rate for one worker restart.\n'
);

const SEARCH_PANEL_HTML =
  '<!doctype html><meta charset="utf-8"><title>Search</title>' +
  '<div style="font:14px system-ui;padding:16px;color:#888">Search this conversation</div>';

type SessionSpec = {id: string; name: string; cwd: string; unread: number};

const SESSIONS: SessionSpec[] = [
  {id: RICH_ID, name: 'Relay Server', cwd: '/srv/relay', unread: 0},
  {id: 'oracle-metrics', name: 'Metrics Dashboard', cwd: '/srv/metrics', unread: 2},
  {id: 'oracle-recipes', name: 'Recipe Scraper', cwd: '/srv/recipes', unread: 0},
  {id: 'oracle-build', name: 'Build Pipeline', cwd: '/srv/build', unread: 0},
  {id: 'oracle-auth', name: 'Auth Gateway', cwd: '/srv/auth', unread: 1}
];

function searchPluginDecl() {
  return {
    id: 'search',
    name: 'Search',
    version: 1,
    panel: {icon: 'search', label: 'Search', needsSession: true, dock: 'full'}
  };
}

function sessionsFrame(): string {
  return JSON.stringify({
    t: 'sessions',
    list: SESSIONS.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      unread: s.unread,
      muted: false,
      alive: true,
      status: 'idle',
      heardTs: BASE,
      lastActivity: BASE,
      title: {text: s.name, detail: null as string | null}
    }))
  });
}

function richMessages() {
  return [
    {
      id: 'm1',
      role: 'user',
      seq: 0,
      ts: BASE,
      text: 'Can you share the architecture diagram and the runbook?'
    },
    {id: 'm2', role: 'claude', seq: 1, ts: BASE + 60_000, text: 'Absolutely, attaching both now.'},
    {
      id: 'm3',
      role: 'claude',
      seq: 2,
      ts: BASE + 120_000,
      text: '',
      upload: {
        uploadId: IMG_ID,
        name: 'architecture.png',
        mime: 'image/png',
        size: PNG_BYTES.length,
        path: 'architecture.png',
        image: true,
        width: 96,
        height: 64
      }
    },
    {
      id: 'm4',
      role: 'claude',
      seq: 3,
      ts: BASE + 180_000,
      text: '',
      file: {docId: DOC_ID, name: 'runbook.txt', fileKind: 'text', size: DOC_BYTES.length}
    }
  ];
}

function attachOkFrame(id: string): string {
  const messages = id === RICH_ID ? richMessages() : [];
  return JSON.stringify({
    t: 'attach-ok',
    id,
    known: true,
    pointer: messages.length,
    pointerPage: 0,
    tailPage: 0,
    pageSize: 100,
    total: messages.length,
    pages: [{page: 0, version: messages.length, sealed: false, messages}]
  });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS'
};

function serveBytes(
  res: ServerResponse,
  method: string,
  status: number,
  type: string,
  body: Buffer
): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': String(body.length),
    ...CORS
  });
  if (method === 'HEAD' || status === 204) res.end();
  else res.end(body);
}

export async function startPresentationEngine(
  o: PresentationEngineOptions = {}
): Promise<PresentationEngine> {
  const breakMedia = o.breakMedia ?? process.env.CYC_ORACLE_BREAK_MEDIA === '1';
  const breakSearch = o.breakSearch ?? process.env.CYC_ORACLE_BREAK_SEARCH === '1';

  const sockets = new Set<WS>();

  const httpHandler = (req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '').split('?')[0];
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    // The album viewer asks for /doc/<id>/raw for shown images; our doc is text,
    // but be permissive so any image-doc probe also lands 200 bytes.
    if (path === `/upload/${IMG_ID}` || path === `/doc/${DOC_ID}/raw`) {
      if (breakMedia) return serveBytes(res, method, 404, 'text/plain', Buffer.from('gone'));
      return serveBytes(res, method, 200, 'image/png', PNG_BYTES);
    }
    if (path === `/doc/${DOC_ID}`) {
      if (breakMedia) return serveBytes(res, method, 404, 'text/plain', Buffer.from('gone'));
      return serveBytes(res, method, 200, 'text/plain; charset=utf-8', DOC_BYTES);
    }
    if (path === '/plugin/search/panel') {
      return serveBytes(
        res,
        method,
        200,
        'text/html; charset=utf-8',
        Buffer.from(SEARCH_PANEL_HTML)
      );
    }
    res.writeHead(404, {'content-type': 'application/json', ...CORS});
    res.end('{}');
  };

  const server: Server = createServer(httpHandler);
  const wss = new WebSocketServer({server});

  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('error', () => {});
    ws.send(JSON.stringify({t: 'host', user: 'test', host: 'testbox'}));
    ws.send(JSON.stringify({t: 'plugins', list: breakSearch ? [] : [searchPluginDecl()]}));
    ws.send(sessionsFrame());
    ws.on('message', (raw) => {
      let f: {t?: string; id?: string};
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (f.t === 'attach' && f.id && SESSIONS.some((s) => s.id === f.id)) {
        if (ws.readyState === ws.OPEN) ws.send(attachOkFrame(f.id));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as {port: number}).port;

  return {
    port,
    richId: RICH_ID,
    close: () =>
      new Promise<void>((done) => {
        for (const ws of sockets) ws.terminate();
        wss.close(() => server.close(() => done()));
      })
  };
}

// -- deterministic PNG (RGB, no external deps) --------------------------------

function makeGradientPng(w: number, h: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 3;
      raw[p] = Math.floor((255 * x) / w);
      raw[p + 1] = Math.floor((255 * y) / h);
      raw[p + 2] = 120;
    }
  }
  const idat = deflateSync(raw, {level: 9});
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}
