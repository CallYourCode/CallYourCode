import {WebSocketServer, type WebSocket as WS} from '../offline/wsshim';
import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'http';

export const PAGE_SIZE = 100;

export type Msg = {
  seq: number;
  role: 'user' | 'claude';
  text: string;
  ts: number;
  queued?: boolean;
};

export type GateSessionOpts = {
  id: string;

  seed?: number;

  claudeEvery?: number;

  unread?: number;

  status?: string;

  busy?: boolean;
};

export type GateEngine = {
  port: number;

  reply(id: string, text: string): Msg;

  dequeue(id: string): void;

  setStatus(id: string, status: string): void;
  unread(id: string): number;
  newest(id: string): Msg | undefined;
  close(): Promise<void>;
};

type Sess = {
  id: string;
  log: Msg[];
  heard: number;
  status: string;
  busy: boolean;
  base: number;
  claudeEvery: number;
};

const SILENT_WAV = (() => {
  const sampleRate = 8000,
    n = sampleRate * 2,
    dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
})();

export function startGateEngine(sessions: GateSessionOpts[]): Promise<GateEngine> {
  const sockets = new Set<WS>();
  const byId = new Map<string, Sess>();

  sessions.forEach((o, si) => {
    const s: Sess = {
      id: o.id,
      log: [],
      heard: 0,
      status: o.status ?? 'idle',
      busy: !!o.busy,
      base: 1_700_000_000_000 + si * 10_000_000,
      claudeEvery: o.claudeEvery ?? 2
    };
    for (let i = 0; i < (o.seed ?? 0); i++) mint(s);
    if (o.unread !== undefined) {
      const claudes = s.log.filter((m) => m.role === 'claude');
      if (o.unread <= 0) s.heard = s.log.length ? s.log[s.log.length - 1].ts : 0;
      else if (o.unread >= claudes.length) s.heard = 0;
      else {
        const firstUnread = claudes[claudes.length - o.unread];
        let h = 0;
        for (const m of s.log) {
          if (m.ts >= firstUnread.ts) break;
          h = m.ts;
        }
        s.heard = h;
      }
    }
    byId.set(o.id, s);
  });

  function mint(s: Sess, role?: 'user' | 'claude'): Msg {
    const seq = s.log.length;
    const r = role ?? (seq % s.claudeEvery === s.claudeEvery - 1 ? 'claude' : 'user');
    const m: Msg = {
      seq,
      role: r,
      text: `${s.id}-msg-${String(seq).padStart(4, '0')}`,
      ts: s.base + seq * 1000
    };
    s.log.push(m);
    return m;
  }

  const pageOf = (seq: number) => Math.floor(seq / PAGE_SIZE);
  const tailPage = (s: Sess) => (s.log.length ? pageOf(s.log[s.log.length - 1].seq) : 0);
  const pointerSeq = (s: Sess) => {
    for (const m of s.log) if (m.role === 'claude' && m.ts > s.heard) return m.seq;
    return s.log.length ? s.log[s.log.length - 1].seq + 1 : 0;
  };
  const unreadOf = (s: Sess) => s.log.filter((m) => m.role === 'claude' && m.ts > s.heard).length;
  const buildPage = (s: Sess, n: number) => {
    const lo = n * PAGE_SIZE,
      hi = lo + PAGE_SIZE;
    const messages = s.log
      .filter((m) => m.seq >= lo && m.seq < hi)
      .map((m) => ({t: 'chat', id: s.id, ...m}));
    const last = messages[messages.length - 1] as {seq: number} | undefined;
    return {page: n, version: last ? last.seq + 1 : lo, sealed: n < tailPage(s), messages};
  };

  const sessionsFrame = () =>
    JSON.stringify({
      t: 'sessions',
      list: [...byId.values()].map((s) => ({
        id: s.id,
        name: s.id,
        cwd: '/tmp/' + s.id,
        unread: unreadOf(s),
        muted: false,
        alive: true,
        status: s.status,
        heardTs: s.heard,
        displayAgent: 'claude',
        settings: {},
        lastActivity: s.log.length ? s.log[s.log.length - 1].ts : s.base,
        title: {text: s.id, detail: null as string | null}
      }))
    });
  const broadcast = (frame: string) => {
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(frame);
  };
  const broadcastSessions = () => broadcast(sessionsFrame());

  const httpHandler = (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    const m = url.match(/^\/session\/([^/]+)\/page\/(\d+)/);
    if (m && req.method === 'GET') {
      const s = byId.get(decodeURIComponent(m[1]));
      if (!s) {
        res.writeHead(404, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: 'no such session', known: false}));
        return;
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(buildPage(s, Math.max(0, parseInt(m[2], 10)))));
      return;
    }
    if (url.startsWith('/audio/') && req.method === 'GET') {
      res.writeHead(200, {'content-type': 'audio/wav'});
      res.end(SILENT_WAV);
      return;
    }
    res.writeHead(404);
    res.end('{}');
  };

  const server: Server = createServer(httpHandler);

  const httpSocks = new Set<import('net').Socket>();
  server.on('connection', (sock) => {
    httpSocks.add(sock);
    sock.on('close', () => httpSocks.delete(sock));
  });
  const wss = new WebSocketServer({server});
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('error', () => {});
    ws.send(JSON.stringify({t: 'host', user: 'test', host: 'gatebox'}));
    ws.send(sessionsFrame());
    ws.on('message', (raw) => {
      let f: any;
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      const s = byId.get(String(f.id ?? ''));
      if (f.t === 'attach') {
        if (!s) {
          ws.send(JSON.stringify({t: 'attach-ok', id: f.id, known: false}));
          return;
        }
        const tail = tailPage(s);
        const ptr = pointerSeq(s);
        const ptrPage = Math.min(tail, Math.max(0, pageOf(ptr)));
        const wanted = ptrPage === tail ? [tail] : [ptrPage, tail];
        ws.send(
          JSON.stringify({
            t: 'attach-ok',
            id: s.id,
            known: true,
            pointer: ptr,
            pointerPage: ptrPage,
            tailPage: tail,
            pageSize: PAGE_SIZE,
            total: s.log.length,
            pages: wanted.map((n) => buildPage(s, n))
          })
        );
        return;
      }
      if (f.t === 'progress' && s) {
        const seq = Math.floor(Number(f.seq));
        let ts = 0;
        for (const mm of s.log) {
          if (mm.seq > seq) break;
          ts = mm.ts;
        }
        if (ts) {
          if (f.explicit === true && ts < s.heard) s.heard = ts;
          else if (ts > s.heard) s.heard = ts;
          broadcastSessions();
        }
        return;
      }
      if (f.t === 'utterance' && s) {
        const m2 = mint(s, 'user');
        m2.text = String(f.text ?? m2.text);
        if (s.busy) m2.queued = true;
        broadcast(JSON.stringify({t: 'chat', id: s.id, ...m2, ...(f.cid ? {cid: f.cid} : {})}));
        broadcastSessions();
        return;
      }
    });
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as {port: number}).port,
        reply: (id: string, text: string) => {
          const s = byId.get(id);
          if (!s) throw new Error('no session ' + id);
          const m = mint(s, 'claude');
          m.text = text;
          broadcast(JSON.stringify({t: 'chat', id: s.id, ...m}));
          broadcastSessions();
          return m;
        },
        dequeue: (id: string) => {
          const s = byId.get(id);
          if (!s) throw new Error('no session ' + id);
          for (let i = s.log.length - 1; i >= 0; i--) {
            const m = s.log[i];
            if (m.role === 'user' && m.queued) {
              delete m.queued;
              broadcast(JSON.stringify({t: 'dequeued', id: s.id, ts: m.ts}));
              return;
            }
          }
          throw new Error('nothing queued in ' + id);
        },
        setStatus: (id: string, status: string) => {
          const s = byId.get(id);
          if (!s) throw new Error('no session ' + id);
          s.status = status;
          broadcastSessions();
        },
        unread: (id: string) => unreadOf(byId.get(id)!),
        newest: (id: string) => {
          const s = byId.get(id)!;
          return s.log[s.log.length - 1];
        },
        close: () =>
          new Promise<void>((done) => {
            for (const ws of sockets) ws.terminate();
            for (const sock of httpSocks) sock.destroy();
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            wss.close(() => server.close(() => done()));
          })
      })
    )
  );
}
