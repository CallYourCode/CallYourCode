import {WebSocketServer, type WebSocket as WS} from 'ws';
import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'http';
import {Readable} from 'stream';
import {
  b64decode,
  b64encode,
  newIdentity,
  SecureChannel,
  secTranscript,
  verifyId,
  importSpkiVerify,
  fpOfSpki,
  importEngineKey,
  derivePairKey,
  verifySecPairTag,
  keyId,
  type EngineIdentity
} from '../../src/engine/e2e';
import {Reassembler, fragment} from '../../src/engine/dcpipe';
import {ReqReassembler, encodeRes, TunnelError, type ReqComplete} from '../../src/engine/tunnel';

const te = new TextEncoder();

export type SeenFrame = {sealed: boolean; t: string};

export type RegisteredEngine = {
  contentKeyB64: string;
  user: string;
  host: string;
  userHost: string;
};

export type TunnelReply = {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
};

export type TestEngine = RegisteredEngine & {
  port: number;

  send(frame: Record<string, unknown>): void;

  close(): Promise<void>;

  stop(): Promise<void>;

  start(): Promise<void>;

  dropSockets(): void;

  dropChannel(): void;

  holdHandshake(): void;
  releaseHandshake(): void;

  setIdentity(id: EngineIdentity): void;
  seen: SeenFrame[];
  offers: number;
  rawHellos: number;
  connections: number;
  secOkCount: number;
  secFailCount: number;
  attachCount: number;
  enrolledCount: number;

  tunnelReqs: number;

  // The app's liveness probe is a `ping`; the rig answers `pong` unless muted
  // (a connected-but-frozen engine), and counts them.
  pingCount: number;
  mutePings(): void;
};

export type EngineOptions = {
  onConnect: (ws: WS) => void;

  onMessage?: (ws: WS, frame: {t?: string; id?: string; [k: string]: unknown}) => void;

  onRequest?: (req: IncomingMessage, res: ServerResponse) => boolean;

  onReq?: (req: ReqComplete) => TunnelReply | undefined | Promise<TunnelReply | undefined>;

  onUpgrade?: (ws: WS, req: IncomingMessage) => boolean;

  port?: number;

  user?: string;

  host?: string;

  skipKey?: boolean;

  paired?: boolean;

  cap?: string;

  identity?: EngineIdentity;
};

type Conn = {
  ws: WS;
  rawSend: (data: Buffer | string) => void;
  rx: Reassembler;

  rxReq: ReqReassembler;
  chan: SecureChannel | null;
  write: Promise<void>;
};

const live = new Map<number, RegisteredEngine>();

export function registeredEngine(port: number): RegisteredEngine | undefined {
  return live.get(port);
}

export async function startEngine(o: EngineOptions): Promise<TestEngine> {
  const user = o.user ?? 'test';
  const host = o.host ?? 'testbox';
  const userHost = `${user}@${host}`;
  let identity: EngineIdentity = o.identity ?? (await newIdentity(true));
  const contentBytes = new Uint8Array(32);
  crypto.getRandomValues(contentBytes);
  const contentKey = await importEngineKey(contentBytes);
  const contentKeyB64 = b64encode(contentBytes as Uint8Array<ArrayBuffer>);
  const contentKid = await keyId(contentBytes as Uint8Array<ArrayBuffer>);
  const requirePair = !o.skipKey;
  const paired = !!o.paired;

  const conns = new Set<Conn>();
  const devices = new Set<string>();
  const seen: SeenFrame[] = [];
  let offers = 0;
  let rawHellos = 0;
  let connections = 0;
  let secOkCount = 0;
  let secFailCount = 0;
  let attachCount = 0;
  let pingCount = 0;
  let pingsMuted = false;
  let enrolledCount = 0;
  let tunnelReqs = 0;
  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;

  let server: Server;
  let wss: WebSocketServer;
  let boundPort = o.port ?? 0;

  const info: RegisteredEngine = {contentKeyB64, user, host, userHost};

  function sendPipe(conn: Conn, s: string) {
    for (const f of fragment(s)) conn.rawSend(Buffer.from(f));
  }

  function enqueue(conn: Conn, job: () => Promise<void>) {
    conn.write = conn.write.then(job, job);
  }

  function sendSealed(conn: Conn, inner: unknown) {
    enqueue(conn, async () => {
      if (!conn.chan || conn.ws.readyState !== conn.ws.OPEN) return;
      sendPipe(conn, JSON.stringify(await conn.chan.seal(inner)));
    });
  }

  async function serveReq(conn: Conn, frame: {id?: string}) {
    let done: ReqComplete | null;
    try {
      done = conn.rxReq.push(frame as any);
    } catch (e) {
      const id = typeof frame?.id === 'string' ? frame.id : '';
      if (id && e instanceof TunnelError)
        sendRes(conn, id, 413, {}, te.encode('tunnel body too large'));
      return;
    }
    if (!done) return;
    tunnelReqs++;
    let reply: TunnelReply | undefined;
    try {
      reply = o.onReq ? await o.onReq(done) : await serveViaHttp(done);
    } catch {
      sendRes(conn, done.id, 500, {}, te.encode('tunnel handler error'));
      return;
    }
    if (!reply) {
      sendRes(conn, done.id, 404, {'access-control-allow-origin': '*'}, te.encode('{}'));
      return;
    }
    const body =
      reply.body == null
        ? null
        : typeof reply.body === 'string'
          ? te.encode(reply.body)
          : reply.body;
    sendRes(conn, done.id, reply.status ?? 200, reply.headers ?? {}, body);
  }

  function serveViaHttp(done: ReqComplete): Promise<TunnelReply | undefined> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {...done.headers};
      if (o.cap) headers['x-cyc-cap'] = o.cap;

      headers['host'] = `127.0.0.1:${boundPort}`;
      const req = Readable.from(
        done.body.length ? [Buffer.from(done.body)] : []
      ) as unknown as IncomingMessage;
      (req as any).url = done.path;
      (req as any).method = done.method;
      (req as any).headers = headers;
      let status = 200;
      const outHeaders: Record<string, string> = {};
      const chunks: Buffer[] = [];
      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;

        resolve({
          status,
          headers: outHeaders,
          body: chunks.length
            ? new Uint8Array(Buffer.concat(chunks as unknown as Uint8Array[]))
            : undefined
        });
      };
      const res = {
        statusCode: 200,
        writeHead(s: number, h?: Record<string, string>) {
          status = s;
          (res as any).statusCode = s;
          if (h) for (const [k, v] of Object.entries(h)) outHeaders[k.toLowerCase()] = String(v);
          return res;
        },
        write(c?: Buffer | string) {
          if (c != null) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          return true;
        },
        end(c?: Buffer | string) {
          if (c != null) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          status = (res as any).statusCode ?? status;
          finish();
        }
      } as unknown as ServerResponse;
      let handled = false;
      try {
        handled = !!o.onRequest?.(req, res);
      } catch {}

      if (!handled && !ended) resolve(undefined);
    });
  }

  function sendRes(
    conn: Conn,
    id: string,
    status: number,
    headers: Record<string, string>,
    body: Uint8Array | null
  ) {
    for (const f of encodeRes(id, status, headers, body)) sendSealed(conn, f);
  }

  function wrapSend(conn: Conn) {
    conn.ws.send = ((data: Buffer | string) => {
      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : String(data);
      let inner: unknown;
      try {
        inner = JSON.parse(text);
      } catch {
        return;
      }
      sendSealed(conn, inner);
    }) as typeof conn.ws.send;
  }

  function handleBinary(conn: Conn, data: Buffer | ArrayBuffer | Buffer[]) {
    const bytes = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data.map((c) => new Uint8Array(c)))
        : Buffer.from(new Uint8Array(data));
    let s: string | null;
    try {
      s = conn.rx.push(new Uint8Array(bytes));
    } catch {
      conn.ws.close(1002, 'protocol');
      return;
    }
    if (s === null) return;
    let f: any;
    try {
      f = JSON.parse(s);
    } catch {
      return;
    }
    if (f?.t === 'hello' && f?.sec && !conn.chan) {
      seen.push({sealed: false, t: 'hello'});
      void (async () => {
        if (gate) await gate;
        const {sec, chan} = await SecureChannel.answer(f.sec, identity, user, host);
        conn.chan = chan;
        sendPipe(conn, JSON.stringify({t: 'sec', ...sec}));
      })();
      return;
    }
    if (f?.t === 'x' && conn.chan) {
      const chan = conn.chan;
      void chan
        .open(f)
        .then(async (inner) => {
          const t = String(inner?.t ?? '');
          seen.push({sealed: true, t});
          if (inner?.t === 'sec-ok') {
            secOkCount++;
            const tr = chan.transcript();
            const transcript = secTranscript('c', tr.ce, tr.ee, tr.cn, tr.en, tr.id);
            const sigOk = await verifyId(
              await importSpkiVerify(inner.dev),
              te.encode(transcript) as Uint8Array<ArrayBuffer>,
              b64decode(inner.sig)
            );
            const devFp = await fpOfSpki(inner.dev);
            if (!sigOk) {
              conn.ws.close(4401, 'sec:bad-sig');
              return;
            }
            if (!devices.has(devFp)) {
              if (requirePair) {
                const pairOk = await verifySecPairTag(
                  await derivePairKey(contentKey),
                  transcript,
                  String(inner.pair ?? '')
                );
                if (!pairOk) {
                  secFailCount++;
                  sendSealed(conn, {t: 'sec-fail', reason: 'unknown-device'});
                  enqueue(conn, async () => {
                    conn.ws.close(4403, 'sec:unknown-device');
                  });
                  return;
                }
              }
              devices.add(devFp);
              enrolledCount++;
            }
            sendSealed(conn, {
              t: 'sec-done',
              fp: identity.fp,
              dev: devFp,
              paired,
              content: [{gen: 1, kid: contentKid, key: contentKeyB64}],
              devices: [],
              ...(o.cap ? {cap: o.cap} : {})
            });
            enqueue(conn, async () => {
              o.onConnect(conn.ws);
            });
            return;
          }
          if (inner?.t === 'req') {
            void serveReq(conn, inner as any);
            return;
          }
          if (inner?.t === 'attach') attachCount++;
          if (inner?.t === 'ping') {
            pingCount++;
            if (!pingsMuted) sendSealed(conn, {t: 'pong', n: inner.n});
          }
          o.onMessage?.(conn.ws, inner);

          conn.ws.emit('message', JSON.stringify(inner), false);
        })
        .catch(() => {});
      return;
    }
    seen.push({sealed: false, t: String(f?.t ?? 'unknown')});
  }

  function handleText(conn: Conn, data: Buffer | string) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let f: any;
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    if (f?.t === 'rtc-offer') {
      offers++;
      conn.rawSend(JSON.stringify({t: 'rtc-answer', id: f.id, sdp: 'loopback-answer'}));
      return;
    }
    if (f?.t === 'rtc-cand') return;
    if (f?.t === 'hello') {
      rawHellos++;
      conn.rawSend(JSON.stringify({t: 'transport-required', transport: 'rtc'}));
      conn.ws.close(4426, 'transport-required');
    }
  }

  function wire() {
    server = createServer((req, res) => {
      if (o.onRequest && o.onRequest(req, res)) return;
      res.writeHead(404, {'access-control-allow-origin': '*'});
      res.end('{}');
    });
    wss = new WebSocketServer({server});
    wss.on('connection', (ws, req) => {
      if (o.onUpgrade && o.onUpgrade(ws, req)) return;
      connections++;
      const rawSend = ws.send.bind(ws) as (data: Buffer | string) => void;
      const conn: Conn = {
        ws,
        rawSend,
        rx: new Reassembler(),
        rxReq: new ReqReassembler(),
        chan: null,
        write: Promise.resolve()
      };
      conns.add(conn);
      wrapSend(conn);
      ws.on('close', () => conns.delete(conn));
      ws.on('error', () => {});
      ws.on('message', (data, isBinary) => {
        if (isBinary) handleBinary(conn, data as Buffer);
        else handleText(conn, data as Buffer | string);
      });
    });
  }

  function listen(): Promise<void> {
    return new Promise((resolve) =>
      server.listen(boundPort, '127.0.0.1', () => {
        boundPort = (server.address() as {port: number}).port;
        live.set(boundPort, info);
        resolve();
      })
    );
  }

  async function stop(): Promise<void> {
    // ws 8 only calls the close callback once every tracked client is gone:
    // sockets an onUpgrade hook claimed are not in `conns`, so all clients go.
    for (const c of conns) c.ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    conns.clear();
    live.delete(boundPort);
    await new Promise<void>((done) => wss.close(() => server.close(() => done())));
  }

  async function start(): Promise<void> {
    wire();
    await listen();
  }

  function dropSockets() {
    for (const c of conns) c.ws.terminate();
    conns.clear();
  }

  function dropChannel() {
    const body = te.encode(JSON.stringify({code: 4001, reason: 'test-drop'}));
    const frame = new Uint8Array(1 + body.length);
    frame[0] = 0x04;
    frame.set(body, 1);
    const buf = Buffer.from(frame);
    for (const c of conns) if (c.ws.readyState === c.ws.OPEN) c.rawSend(buf);
  }

  wire();
  await listen();

  return {
    get port() {
      return boundPort;
    },
    get contentKeyB64() {
      return contentKeyB64;
    },
    get user() {
      return user;
    },
    get host() {
      return host;
    },
    get userHost() {
      return userHost;
    },
    get seen() {
      return seen;
    },
    get offers() {
      return offers;
    },
    get rawHellos() {
      return rawHellos;
    },
    get connections() {
      return connections;
    },
    get secOkCount() {
      return secOkCount;
    },
    get secFailCount() {
      return secFailCount;
    },
    get attachCount() {
      return attachCount;
    },
    get enrolledCount() {
      return enrolledCount;
    },
    get pingCount() {
      return pingCount;
    },
    mutePings() {
      pingsMuted = true;
    },
    get tunnelReqs() {
      return tunnelReqs;
    },
    send: (frame: Record<string, unknown>) => {
      for (const c of conns) if (c.ws.readyState === c.ws.OPEN) sendSealed(c, frame);
    },
    close: stop,
    stop,
    start,
    dropSockets,
    dropChannel,
    holdHandshake() {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    releaseHandshake() {
      releaseGate?.();
      releaseGate = null;
      gate = null;
    },
    setIdentity(id: EngineIdentity) {
      identity = id;
      devices.clear();
    }
  };
}

export function attachSeal(wss: WebSocketServer, opts?: {server?: Server}): void {
  const user = 'test';
  const host = 'testbox';
  const devices = new Set<string>();
  const state: {
    identity: EngineIdentity | null;
    contentKey: CryptoKey | null;
    contentKid: string;
    contentKeyB64: string;
    info: RegisteredEngine | null;
    port: number;
  } = {identity: null, contentKey: null, contentKid: '', contentKeyB64: '', info: null, port: 0};

  const ready = (async () => {
    state.identity = await newIdentity(true);
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    state.contentKey = await importEngineKey(bytes);
    state.contentKeyB64 = b64encode(bytes as Uint8Array<ArrayBuffer>);
    state.contentKid = await keyId(bytes as Uint8Array<ArrayBuffer>);
    state.info = {
      contentKeyB64: state.contentKeyB64,
      user,
      host,
      userHost: `${user}@${host}`
    };
    if (state.port) live.set(state.port, state.info);
  })();

  const notePort = (port: number) => {
    if (!port) return;
    state.port = port;
    if (state.info) live.set(port, state.info);
  };
  wss.on('listening', () => {
    const addr = wss.address();
    if (addr && typeof addr === 'object') notePort(addr.port);
  });
  const http = opts?.server;
  if (http) {
    const mark = () => {
      const addr = http.address();
      if (addr && typeof addr === 'object') notePort(addr.port);
    };
    http.on('listening', mark);
    if (http.listening) mark();
  }
  wss.on('close', () => {
    if (state.port) live.delete(state.port);
  });

  const wrapHandler =
    (fn: (ws: WS, req: IncomingMessage) => void) => (ws: WS, req: IncomingMessage) => {
      const url = req?.url ?? '';
      if (url.includes('stt-stream')) {
        fn(ws, req);
        return;
      }
      void ready.then(() =>
        bindHandrolled(
          ws,
          state.identity!,
          state.contentKey!,
          state.contentKid,
          state.contentKeyB64,
          user,
          host,
          devices,
          () => fn(ws, req),
          http
        )
      );
    };

  const origOn = wss.on.bind(wss);
  const origOnce = wss.once.bind(wss);
  (wss as any).on = (ev: string | symbol, fn: any) => {
    if (ev === 'connection') return origOn(ev, wrapHandler(fn));
    return origOn(ev, fn);
  };
  (wss as any).addListener = (wss as any).on;
  (wss as any).once = (ev: string | symbol, fn: any) => {
    if (ev === 'connection') return origOnce(ev, wrapHandler(fn));
    return origOnce(ev, fn);
  };
}

function bindHandrolled(
  ws: WS,
  identity: EngineIdentity,
  contentKey: CryptoKey,
  contentKid: string,
  contentKeyB64: string,
  user: string,
  host: string,
  devices: Set<string>,
  onReady: () => void,
  http?: Server
): void {
  const rawSend = ws.send.bind(ws) as (data: Buffer | string) => void;
  const conn: Conn = {
    ws,
    rawSend,
    rx: new Reassembler(),
    rxReq: new ReqReassembler(),
    chan: null,
    write: Promise.resolve()
  };
  const sendPipe = (s: string) => {
    for (const f of fragment(s)) rawSend(Buffer.from(f));
  };
  const enqueue = (job: () => Promise<void>) => {
    conn.write = conn.write.then(job, job);
  };
  const sendSealed = (inner: unknown) => {
    enqueue(async () => {
      if (!conn.chan || ws.readyState !== ws.OPEN) return;
      sendPipe(JSON.stringify(await conn.chan.seal(inner)));
    });
  };
  ws.send = ((data: Buffer | string) => {
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data);
    let inner: unknown;
    try {
      inner = JSON.parse(text);
    } catch {
      return;
    }
    sendSealed(inner);
  }) as typeof ws.send;

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      let f: any;
      try {
        f = JSON.parse(text);
      } catch {
        return;
      }
      if (f?.t === 'rtc-offer') {
        rawSend(JSON.stringify({t: 'rtc-answer', id: f.id, sdp: 'loopback-answer'}));
        return;
      }
      if (f?.t === 'hello') {
        rawSend(JSON.stringify({t: 'transport-required', transport: 'rtc'}));
        ws.close(4426, 'transport-required');
      }
      return;
    }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    let s: string | null;
    try {
      s = conn.rx.push(new Uint8Array(bytes));
    } catch {
      ws.close(1002, 'protocol');
      return;
    }
    if (s === null) return;
    let f: any;
    try {
      f = JSON.parse(s);
    } catch {
      return;
    }
    if (f?.t === 'hello' && f?.sec && !conn.chan) {
      void (async () => {
        const {sec, chan} = await SecureChannel.answer(f.sec, identity, user, host);
        conn.chan = chan;
        sendPipe(JSON.stringify({t: 'sec', ...sec}));
      })();
      return;
    }
    if (f?.t === 'x' && conn.chan) {
      const chan = conn.chan;
      void chan
        .open(f)
        .then(async (inner) => {
          if (inner?.t === 'sec-ok') {
            const tr = chan.transcript();
            const transcript = secTranscript('c', tr.ce, tr.ee, tr.cn, tr.en, tr.id);
            const sigOk = await verifyId(
              await importSpkiVerify(inner.dev),
              te.encode(transcript) as Uint8Array<ArrayBuffer>,
              b64decode(inner.sig)
            );
            const devFp = await fpOfSpki(inner.dev);
            if (!sigOk) {
              ws.close(4401, 'sec:bad-sig');
              return;
            }
            if (!devices.has(devFp)) {
              const pairOk = await verifySecPairTag(
                await derivePairKey(contentKey),
                transcript,
                String(inner.pair ?? '')
              );
              if (!pairOk) {
                sendSealed({t: 'sec-fail', reason: 'unknown-device'});
                enqueue(async () => {
                  ws.close(4403, 'sec:unknown-device');
                });
                return;
              }
              devices.add(devFp);
            }
            sendSealed({
              t: 'sec-done',
              fp: identity.fp,
              dev: devFp,
              paired: false,
              content: [{gen: 1, kid: contentKid, key: contentKeyB64}],
              devices: []
            });
            enqueue(async () => {
              onReady();
            });
            return;
          }
          if (inner?.t === 'req') {
            serveTunnelReq(http, conn, inner as {id?: string}, sendSealed);
            return;
          }
          ws.emit('message', JSON.stringify(inner), false);
        })
        .catch(() => {});
    }
  });
}

// The app reaches an engine's HTTP surface (chat pages, docs, uploads) only over
// the sealed tunnel, never directly. attachSeal-wrapped engines expose that HTTP
// on the same node server, so a tunnel `req` frame is served by handing a fake
// request/response to that server's own request listener and sealing the reply.
function serveTunnelReq(
  http: Server | undefined,
  conn: Conn,
  frame: {id?: string},
  sendSealed: (inner: unknown) => void
): void {
  let done: ReqComplete | null;
  try {
    done = conn.rxReq.push(frame as never);
  } catch (e) {
    const id = typeof frame?.id === 'string' ? frame.id : '';
    if (id && e instanceof TunnelError)
      for (const f of encodeRes(id, 413, {}, te.encode('tunnel body too large'))) sendSealed(f);
    return;
  }
  if (!done) return;
  const req = done;
  void serveViaServer(http, req).then((r) => {
    for (const f of encodeRes(req.id, r.status, r.headers, r.body)) sendSealed(f);
  });
}

function serveViaServer(
  http: Server | undefined,
  done: ReqComplete
): Promise<{status: number; headers: Record<string, string>; body: Uint8Array | null}> {
  return new Promise((resolve) => {
    if (!http || http.listenerCount('request') === 0) {
      resolve({status: 404, headers: {'access-control-allow-origin': '*'}, body: te.encode('{}')});
      return;
    }
    const req = Readable.from(
      done.body.length ? [Buffer.from(done.body)] : []
    ) as unknown as IncomingMessage;
    (req as unknown as {url: string}).url = done.path;
    (req as unknown as {method: string}).method = done.method;
    (req as unknown as {headers: Record<string, string>}).headers = {...done.headers};
    let status = 200;
    const outHeaders: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      resolve({
        status,
        headers: outHeaders,
        body: chunks.length
          ? new Uint8Array(Buffer.concat(chunks as unknown as Uint8Array[]))
          : null
      });
    };
    const res = {
      statusCode: 200,
      writeHead(s: number, h?: Record<string, string>) {
        status = s;
        (res as unknown as {statusCode: number}).statusCode = s;
        if (h) for (const [k, v] of Object.entries(h)) outHeaders[k.toLowerCase()] = String(v);
        return res;
      },
      setHeader(k: string, v: string) {
        outHeaders[String(k).toLowerCase()] = String(v);
      },
      write(c?: Buffer | string) {
        if (c != null) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        return true;
      },
      end(c?: Buffer | string) {
        if (c != null) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        status = (res as unknown as {statusCode: number}).statusCode ?? status;
        finish();
      }
    } as unknown as ServerResponse;
    http.emit('request', req, res);
  });
}
