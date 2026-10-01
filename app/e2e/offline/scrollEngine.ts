import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'http';
import {deflateSync} from 'node:zlib';
import {WebSocketServer, type WebSocket as WS} from './wsshim';

// A hermetic sealed engine for the scrolling lane (scroll-pin.spec.ts and
// scroll-landing.spec.ts). One long conversation, an engine-side read marker
// (heardTs) the spec sets to open the chat with N unread agent lines, image
// uploads whose bytes arrive late and taller than the placeholder, an echo of
// every utterance after a configurable delay, and agent replies the spec pushes
// whenever it wants. Nothing here touches the user's live stack.

export type ScrollEngineOptions = {
  // How many messages the long conversation carries.
  count?: number;
  // Every Nth agent line carries an image upload (0 = none).
  imageEvery?: number;
  // The image bytes are held this long before the tunnel answers.
  imageDelayMs?: number;
  // The utterance echo (the engine's own copy of what the user sent) is held this long.
  echoDelayMs?: number;
  // Agent lines past the marker on open (0 = the chat opens read).
  unread?: number;
  // The session activity overlay (tool-call pills, reply summaries): the
  // session carries a claudeSessionId, the history's records ride on the one
  // attach-ok page as `t:"s"` rows (the real engine's shape: one seq axis with
  // the messages), and the spec can push live ones with `event()`.
  overlay?: boolean;
  // Every Nth agent line in the seeded history is preceded by a run of tool
  // events and followed by a reply summary (0 = no seeded events).
  eventsEvery?: number;
  // The attach-ok answer is held this long (the real engine answers after the
  // app has already painted the chat from its in-memory window).
  attachDelayMs?: number;
  // The utterance echo carries `queued: true` and a `dequeued` frame follows
  // after this many ms (the real engine's shape while the agent is working).
  dequeueDelayMs?: number;
};

// One session record as the engine's log line carries it (`t:"s"` on a page,
// `ev` of a session-event frame).
export type ScrollEvent = {
  id: string;
  seq: number;
  ts: number;
  kind: 'prompt' | 'reply' | 'tool';
  text: string;
  tool?: {name: string};
};

export type ScrollEngine = {
  port: number;
  sessionId: string;
  lastTs(): number;
  // Push one agent line (a reply) into the conversation right now.
  say(text: string, opts?: {image?: boolean}): number;
  // Move the read marker so the next open has `n` unread agent lines.
  setUnread(n: number): void;
  utterances(): {text: string; cid?: string}[];
  // Push one live overlay event (a tool call or a reply summary). `ts` defaults
  // to now; an earlier ts lands the row above the newest bubble, as the real
  // engine's transcript tail does when it lags the chat.
  event(kind: 'tool' | 'reply', text: string, opts?: {ts?: number; tool?: string}): ScrollEvent;
  // Release the queued mark on the echoed utterance with this ts.
  dequeue(ts: number): void;
  // What the next `/session-agents` poll answers. A run with `endedTs: null`
  // shows the agents bar over the list, which reserves 3.25rem of top pad.
  setAgentRuns(runs: ScrollAgentRun[]): void;
  close(): Promise<void>;
};

export type ScrollAgentRun = {
  toolUseId: string;
  agentId: string | null;
  ts: number;
  desc: string;
  endedTs: number | null;
  tokens: string | null;
};

export const runningAgent = (n = 1): ScrollAgentRun => ({
  toolUseId: `toolu_scroll_${n}`,
  agentId: `agent-scroll-${n}`,
  ts: Date.now() - 20_000,
  desc: `Builder ${n} for the composer fix`,
  endedTs: null,
  tokens: null
});

const BASE = Date.UTC(2024, 3, 2, 8, 0, 0);
export const SESSION_ID = 'scroll-long';
export const SESSION_NAME = 'Long Thread';
const IMG_W = 300;
const IMG_H = 720;
const PNG_BYTES = makeGradientPng(IMG_W, IMG_H);

const LINES = [
  'Can you check why the relay drops the third peer?',
  'Looking now. The third peer negotiates over the same port and the second pair never releases it.',
  'ok',
  'Fixed in the pool: every pair takes its own allocation and returns it on close. Tests pass.',
  'Now the metrics page renders twice on load, once empty and once filled. Please make it one paint.',
  'The first paint comes from the cached snapshot and the second from the live query. I will hold the paint until the live query lands unless it takes longer than a second, then paint the cache.',
  'sounds right',
  'Done. One paint on a warm cache, two on a cold one, both within the frame budget.',
  'Also the recipe scraper stopped parsing ingredient lists with fractions like 1/2 and 3/4, it reads them as dates.',
  'The date guard runs before the fraction parser. Swapped the order and added the fraction cases to the fixture set, all green.'
];

export async function startScrollEngine(o: ScrollEngineOptions = {}): Promise<ScrollEngine> {
  const count = o.count ?? 80;
  const imageEvery = o.imageEvery ?? 0;
  const imageDelayMs = o.imageDelayMs ?? 0;
  const echoDelayMs = o.echoDelayMs ?? 0;
  const overlay = !!o.overlay;
  const eventsEvery = o.eventsEvery ?? 0;
  const attachDelayMs = o.attachDelayMs ?? 0;
  const dequeueDelayMs = o.dequeueDelayMs;
  let agentRuns: ScrollAgentRun[] = [];

  type Msg = {
    id: string;
    role: 'user' | 'claude';
    seq: number;
    ts: number;
    text: string;
    msgId?: string;
    cid?: string;
    upload?: Record<string, unknown>;
  };
  const messages: Msg[] = [];
  let seq = 0;
  let imgN = 0;
  const imageUpload = () => {
    imgN++;
    // No width/height on purpose: the app reserves a 4:3 placeholder and the
    // real (taller) bytes arrive later, which is the late-growth case.
    return {
      uploadId: `img-${imgN}`,
      name: `shot-${imgN}.png`,
      mime: 'image/png',
      size: PNG_BYTES.length,
      path: `shot-${imgN}.png`,
      image: true
    };
  };
  const push = (role: 'user' | 'claude', text: string, image = false): Msg => {
    const n = seq++;
    const m: Msg = {
      id: SESSION_ID,
      role,
      seq: n,
      ts: BASE + n * 60_000,
      text,
      msgId: `m-${n}`
    };
    if (image && role === 'claude') m.upload = imageUpload();
    messages.push(m);
    return m;
  };
  // Records take their seq from the same counter as the messages: seq is
  // storage order (a seeded tool run is written after the line it precedes),
  // ts is display order.
  const events: ScrollEvent[] = [];
  let evN = 0;
  const pushEvent = (kind: ScrollEvent['kind'], text: string, ts: number, tool?: string) => {
    const ev: ScrollEvent = {id: `se-${++evN}`, seq: seq++, ts, kind, text};
    if (tool) ev.tool = {name: tool};
    events.push(ev);
    return ev;
  };
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'claude';
    const withImage = imageEvery > 0 && role === 'claude' && i % imageEvery === 0;
    const m = push(role, LINES[i % LINES.length] + (i % 7 === 0 ? ` (#${i})` : ''), withImage);
    if (eventsEvery > 0 && role === 'claude' && i % eventsEvery === 0) {
      // The agent's activity before this line: a run of tool calls, then the
      // line's own transcript copy as a reply summary right after it.
      for (let k = 0; k < 4; k++) pushEvent('tool', `tool ${k}`, m.ts - 30_000 + k * 1000, k % 3 ? 'Bash' : 'Read');
      pushEvent('reply', m.text, m.ts + 500);
    }
  }

  // The read marker: unread is the count of agent lines past heardTs.
  let heardTs = messages[messages.length - 1].ts;
  const unreadOf = () => messages.filter((m) => m.role === 'claude' && m.ts > heardTs).length;
  const setUnread = (n: number) => {
    const agent = messages.filter((m) => m.role === 'claude');
    if (n <= 0) {
      heardTs = messages[messages.length - 1].ts;
      return;
    }
    const first = agent[Math.max(0, agent.length - n)];
    heardTs = first.ts - 1;
  };
  setUnread(o.unread ?? 0);

  const sockets = new Set<WS>();
  const broadcast = (raw: string) => {
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(raw);
  };
  const sessionsFrame = () =>
    JSON.stringify({
      t: 'sessions',
      list: [
        {
          id: SESSION_ID,
          name: SESSION_NAME,
          cwd: '/srv/long',
          unread: unreadOf(),
          muted: false,
          alive: true,
          status: 'idle',
          ...(overlay ? {claudeSessionId: 'cs-scroll-long'} : {}),
          heardTs,
          lastActivity: messages[messages.length - 1].ts,
          order: 0
        }
      ]
    });
  const wire = (m: Msg) => ({
    t: 'chat',
    id: m.id,
    role: m.role,
    seq: m.seq,
    ts: m.ts,
    text: m.text,
    msgId: m.msgId,
    ...(m.cid ? {cid: m.cid} : {}),
    ...(m.upload ? {upload: m.upload} : {})
  });
  const wireEvent = (ev: ScrollEvent) => ({t: 's', ...ev});
  // The one page: messages and records interleaved by seq, records tagged t:"s".
  const pageRows = () =>
    [...messages.map((m) => ({seq: m.seq, row: wire(m)})), ...events.map((ev) => ({seq: ev.seq, row: wireEvent(ev)}))]
      .sort((a, b) => a.seq - b.seq)
      .map((r) => r.row);
  const attachOkFrame = () =>
    JSON.stringify({
      t: 'attach-ok',
      id: SESSION_ID,
      known: true,
      pageSize: 1000,
      total: seq,
      pointer: seq,
      pointerPage: 0,
      tailPage: 0,
      pages: [{page: 0, version: seq, sealed: false, messages: pageRows()}]
    });

  const utterances: {text: string; cid?: string}[] = [];
  const dequeue = (ts: number) => broadcast(JSON.stringify({t: 'dequeued', id: SESSION_ID, ts}));

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
  const httpHandler = (req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '').split('?')[0];
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (/^\/upload\/img-\d+$/.test(path)) {
      const answer = () => {
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(PNG_BYTES.length),
          ...CORS
        });
        if (method === 'HEAD') res.end();
        else res.end(PNG_BYTES);
      };
      if (imageDelayMs) setTimeout(answer, imageDelayMs);
      else answer();
      return;
    }
    if (method === 'POST' && /^\/session\/[^/]+\/unread/.test(path)) {
      res.writeHead(200, {'content-type': 'application/json', ...CORS});
      res.end(JSON.stringify({ok: true, unread: unreadOf()}));
      return;
    }
    if (method === 'GET' && path === `/session-agents/${SESSION_ID}`) {
      res.writeHead(200, {'content-type': 'application/json', ...CORS});
      res.end(JSON.stringify({runs: agentRuns}));
      return;
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
    ws.on('message', (raw: Buffer | string) => {
      let f: {t?: string; id?: string; text?: string; cid?: string; ts?: number} | null = null;
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!f) return;
      if (f.t === 'attach' && f.id === SESSION_ID) {
        const answer = () => {
          if (ws.readyState === ws.OPEN) ws.send(attachOkFrame());
        };
        if (attachDelayMs) setTimeout(answer, attachDelayMs);
        else answer();
        return;
      }
      if (f.t === 'heard' || f.t === 'progress') {
        const ts = Number(f.ts);
        if (Number.isFinite(ts) && ts > heardTs) heardTs = ts;
        return;
      }
      if (f.t === 'utterance' && f.id === SESSION_ID) {
        const text = String(f.text ?? '');
        const cid = typeof f.cid === 'string' ? f.cid : undefined;
        utterances.push({text, cid});
        const m = push('user', text);
        m.ts = Date.now();
        m.cid = cid;
        const queued = dequeueDelayMs !== undefined;
        const echo = () => {
          broadcast(JSON.stringify({...wire(m), ...(queued ? {queued: true} : {})}));
          if (queued) setTimeout(() => dequeue(m.ts), dequeueDelayMs);
        };
        if (echoDelayMs) setTimeout(echo, echoDelayMs);
        else echo();
      }
    });
    ws.send(JSON.stringify({t: 'host', user: 'test', host: 'testbox'}));
    ws.send(sessionsFrame());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as {port: number}).port;

  return {
    port,
    sessionId: SESSION_ID,
    lastTs: () => messages[messages.length - 1].ts,
    say: (text, opts) => {
      const m = push('claude', text, !!opts?.image);
      m.ts = Date.now();
      broadcast(JSON.stringify(wire(m)));
      return m.ts;
    },
    setUnread: (n) => {
      setUnread(n);
      broadcast(sessionsFrame());
    },
    utterances: () => utterances.slice(),
    event: (kind, text, opts) => {
      const ev = pushEvent(kind, text, opts?.ts ?? Date.now(), opts?.tool);
      broadcast(JSON.stringify({t: 'session-event', id: SESSION_ID, ev: wireEvent(ev)}));
      return ev;
    },
    dequeue,
    setAgentRuns: (runs) => {
      agentRuns = runs;
    },
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 3;
      raw[p] = Math.floor((255 * x) / w);
      raw[p + 1] = Math.floor((255 * y) / h);
      raw[p + 2] = 90;
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
