import {createHash} from 'node:crypto';
import {startEngine, type TestEngine} from './engine';
import type {ReqComplete} from '../../src/engine/tunnel';

// A resumable-transfer engine for the offline rig. It speaks the real sealed
// tunnel (startEngine) and serves the /transfer/* routes the app's worker drives,
// in memory, matching the real engine's contract: an id derived from
// sessionId+sha256 (so begin is idempotent and a restart resumes), a file per
// chunk, and a finish that assembles + verifies sha256 before handing back what
// the fronted route would: a /user-audio-shaped {msgId} for kind user-audio, an
// /upload-shaped {uploadId,name,mime,size,path,image,durationS?} for kind
// upload. The chunk store lives in this closure, so it survives a
// stop()/start() on the same port -- the mid-transfer-restart case.
//
// Optional chaos: after `chaos` request-body bytes on a connection, drop every
// socket, reproducing the roaming-4G flap. The counter resets on reconnect, so a
// big upload takes several windows (and several drops) to get through.

export const CHUNK = 262144;
export const CHAT = 'xferchat';

const CAP: Record<string, number> = {
  'user-audio': 300 * 1024 * 1024,
  upload: 50 * 1024 * 1024
};

export type TransferEngine = {
  port: number;
  stop(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
  // the sequence of PUT chunk indices the engine has seen (across reconnects)
  putLog(): number[];
  putCount(): number;
  // sha256 (hex) of the LAST finished transfer's assembled bytes, or null
  finishedSha(): string | null;
  // sha256 (hex) of the assembled bytes behind a finished upload's uploadId
  finishedShaOf(uploadId: string): string | null;
  finishes(): number;
  // every utterance frame the app sent over the pipe, oldest first
  utterances(): Utterance[];
  // how many times chaos dropped the pipe
  dropCount(): number;
  setChaos(n: number): void;
  // every GET /upload/<id> the app made through the tunnel, oldest first (the
  // engine-side count of media fetches; a bubble painted from the app's own
  // image cache adds nothing here)
  uploadGets(): string[];
  // the engine URL the app resolves an uploadId to (what the image cache keys on)
  uploadUrl(uploadId: string): string;
  holdHandshake(): void;
  releaseHandshake(): void;
  // The agent shows a picture (the `show` tool): a claude chat frame carrying
  // a file ref of fileKind image goes out on the pipe (and into history when
  // serveUploads), and GET /doc/<id>/raw serves the bytes. Returns the docId.
  showImage(name: string, bytes: Uint8Array, mime: string): string;
  // every GET /doc/<id>/raw the app made through the tunnel, oldest first
  docGets(): string[];
  // the engine URL the app resolves a shown image's raw bytes to
  docRawUrl(docId: string): string;
};

type Entry = {
  meta: {kind: string; size: number; mime: string; name?: string; sha256: string; cid?: string; durationS?: number};
  chunks: Map<number, Uint8Array>;
};

export type Utterance = {
  id: string;
  text: string;
  cid?: string;
  msgId?: string;
  upload?: {uploadId: string};
  uploads?: {uploadId: string}[];
  words?: string[];
};

export function sessionIdFor(port: number): string {
  return `ws://127.0.0.1:${port}/ws|${CHAT}`;
}

export async function startTransferEngine(
  opts: {
    chaos?: number;
    putDelayMs?: number;
    capOverride?: Partial<Record<string, number>>;
    // echo each utterance back as the user chat frame the real engine sends
    // once it has accepted the message (the app's delivered edge)
    echoUtterances?: boolean;
    // keep the finished uploads and serve them back on GET /upload/<id>, and
    // answer attach with the echoed messages as history, the way the real
    // engine does: a reload then finds the sent message in history and its
    // image behind its uploadId
    serveUploads?: boolean;
  } = {}
): Promise<TransferEngine> {
  const capOf = (kind: string) => opts.capOverride?.[kind] ?? CAP[kind] ?? 0;
  const putDelayMs = opts.putDelayMs ?? 0;
  const store = new Map<string, Entry>();
  const putSeq: number[] = [];
  let finishedSha: string | null = null;
  const uploadShas = new Map<string, string>();
  const uploadBytes = new Map<string, {bytes: Uint8Array; mime: string}>();
  const uploadGets: string[] = [];
  const docBytes = new Map<string, {bytes: Uint8Array; mime: string}>();
  const docGets: string[] = [];
  let docN = 0;
  const echoed: Record<string, unknown>[] = [];
  const utterances: Utterance[] = [];
  let finishes = 0;
  let msgN = 0;
  let upN = 0;
  let chaos = opts.chaos ?? 0;
  let bodySeen = 0;
  let droppedThisConn = false;
  let dropCount = 0;

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const idFor = (sessionId: string, sha: string) =>
    createHash('sha256').update(sessionId + '\n' + sha).digest('hex');
  const chunkCount = (size: number) => (size <= 0 ? 0 : Math.ceil(size / CHUNK));
  const CORS = {'access-control-allow-origin': '*'};
  const jsonReply = (status: number, body: unknown, extra: Record<string, string> = {}) => ({
    status,
    headers: {'content-type': 'application/json', ...CORS, ...extra},
    body: enc.encode(JSON.stringify(body))
  });
  // The reply a finish hands back verbatim from the route it fronts (/upload,
  // /user-audio) carries x-cyc-fronted: 1, exactly as the real engine stamps
  // it; the transfer route's own refusals (404/409/413/422) do not.
  const frontedReply = (status: number, body: unknown) => jsonReply(status, body, {'x-cyc-fronted': '1'});

  let eng: TestEngine;

  const onReq = async (req: ReqComplete) => {
    const [path, query] = req.path.split('?');
    const q = new URLSearchParams(query || '');

    // Chaos: count body bytes on this connection; once past the threshold, drop
    // every socket and stop answering, so the chunk in flight is lost and the
    // app must reconnect and resume.
    if (chaos > 0 && req.body.length > 0) {
      bodySeen += req.body.length;
      if (!droppedThisConn && bodySeen > chaos) {
        droppedThisConn = true;
        dropCount++;
        eng.dropSockets();
        return undefined;
      }
    }

    const get = path.match(/^\/upload\/([^/]+)$/);
    if (get && req.method === 'GET') {
      const id = decodeURIComponent(get[1]);
      uploadGets.push(id);
      const u = opts.serveUploads ? uploadBytes.get(id) : undefined;
      if (!u) return jsonReply(404, {error: 'no such upload'});
      return {status: 200, headers: {'content-type': u.mime, ...CORS}, body: u.bytes};
    }

    const raw = path.match(/^\/doc\/([^/]+)\/raw$/);
    if (raw && req.method === 'GET') {
      const id = decodeURIComponent(raw[1]);
      docGets.push(id);
      const d = docBytes.get(id);
      if (!d) return jsonReply(404, {error: 'no such doc'});
      return {status: 200, headers: {'content-type': d.mime, ...CORS}, body: d.bytes};
    }

    if (path === '/transfer/begin' && req.method === 'POST') {
      const b = JSON.parse(dec.decode(req.body)) as {
        kind: string;
        sessionId: string;
        size: number;
        mime: string;
        name?: string;
        sha256: string;
        cid?: string;
        durationS?: number;
      };
      if (b.size > capOf(b.kind)) return jsonReply(413, {error: 'too large', max: capOf(b.kind)});
      const id = idFor(b.sessionId, b.sha256);
      if (!store.has(id)) store.set(id, {meta: b, chunks: new Map()});
      const have = [...store.get(id)!.chunks.keys()].sort((a, c) => a - c);
      return jsonReply(200, {id, chunk: CHUNK, have});
    }

    const put = path.match(/^\/transfer\/([0-9a-f]{64})\/(\d+)$/);
    if (put && req.method === 'PUT') {
      const e = store.get(put[1]);
      if (!e) return jsonReply(404, {error: 'no such transfer'});
      const n = Number(put[2]);
      if (putDelayMs > 0) await new Promise((r) => setTimeout(r, putDelayMs));
      e.chunks.set(n, req.body);
      putSeq.push(n);
      return jsonReply(200, {have: [...e.chunks.keys()].sort((a, c) => a - c)});
    }

    const idm = path.match(/^\/transfer\/([0-9a-f]{64})$/);
    if (idm) {
      const e = store.get(idm[1]);
      if (req.method === 'GET') {
        if (!e) return jsonReply(404, {error: 'no such transfer'});
        const have = [...e.chunks.keys()].sort((a, c) => a - c);
        return jsonReply(200, {have, size: e.meta.size, chunk: CHUNK, done: have.length === chunkCount(e.meta.size)});
      }
      if (req.method === 'DELETE') {
        store.delete(idm[1]);
        return jsonReply(200, {ok: true});
      }
    }

    const fin = path.match(/^\/transfer\/([0-9a-f]{64})\/finish$/);
    if (fin && req.method === 'POST') {
      const e = store.get(fin[1]);
      if (!e) return jsonReply(404, {error: 'no such transfer'});
      const count = chunkCount(e.meta.size);
      if (e.chunks.size !== count) return jsonReply(409, {ok: false, error: 'incomplete'});
      const parts: Uint8Array[] = [];
      for (let i = 0; i < count; i++) parts.push(e.chunks.get(i)!);
      const total = parts.reduce((n, p) => n + p.length, 0);
      const buf = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        buf.set(p, o);
        o += p.length;
      }
      const sha = createHash('sha256').update(buf).digest('hex');
      if (total !== e.meta.size || sha !== e.meta.sha256) {
        return jsonReply(422, {ok: false, error: 'hash mismatch'});
      }
      finishedSha = sha;
      finishes++;
      store.delete(fin[1]);
      if (e.meta.kind === 'upload') {
        const uploadId = `srv-up-${++upN}`;
        uploadShas.set(uploadId, sha);
        if (opts.serveUploads) uploadBytes.set(uploadId, {bytes: buf, mime: e.meta.mime});
        const name = e.meta.name ?? 'upload';
        return frontedReply(200, {
          uploadId,
          name,
          mime: e.meta.mime,
          size: total,
          path: `/tmp/uploads/${uploadId}-${name}`,
          image: e.meta.mime.startsWith('image/'),
          ...(e.meta.durationS ? {durationS: e.meta.durationS} : {})
        });
      }
      return frontedReply(200, {msgId: `srv-audio-${++msgN}`});
    }

    // The route a finished user-audio transfer fronts, for a direct-POST parity
    // check if a spec wants it.
    if (path === '/user-audio' && req.method === 'POST') {
      finishedSha = createHash('sha256').update(req.body).digest('hex');
      return jsonReply(200, {msgId: `srv-audio-${++msgN}`});
    }
    void q;
    return undefined; // 404
  };

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
          heardTs: 0,
          title: {text: CHAT, detail: null as string | null}
        }
      ]
    });

  // With serveUploads the echoed messages are the chat's history (one page,
  // seq in echo order), as the real engine answers an attach after a reload.
  const attachOk = () =>
    JSON.stringify({
      t: 'attach-ok',
      id: CHAT,
      known: true,
      pointer: echoed.length,
      pointerPage: 0,
      tailPage: 0,
      pageSize: 100,
      total: echoed.length,
      pages: [{page: 0, version: echoed.length, sealed: false, messages: [...echoed]}]
    });

  const echoFrame = (u: Utterance): Record<string, unknown> => ({
    t: 'chat',
    id: u.id,
    role: 'user',
    text: u.text,
    ts: Date.now(),
    cid: u.cid,
    msgId: u.msgId,
    upload: u.upload,
    uploads: u.uploads,
    ...(opts.serveUploads ? {seq: echoed.length} : {})
  });

  eng = await startEngine({
    onReq,
    onConnect: (ws) => {
      // A fresh connection: the chaos window restarts here.
      bodySeen = 0;
      droppedThisConn = false;
      ws.send(JSON.stringify({t: 'host', user: 'test', host: 'testbox'}));
      ws.send(sessionsFrame());
    },
    onMessage: (ws, inner) => {
      const f = inner as {t?: string; id?: string};
      if (f.t === 'attach' && f.id === CHAT && ws.readyState === ws.OPEN) ws.send(attachOk());
      if (f.t === 'utterance') {
        const u = inner as Utterance;
        utterances.push(u);
        if (opts.echoUtterances && ws.readyState === ws.OPEN) {
          const frame = echoFrame(u);
          if (opts.serveUploads) echoed.push(frame);
          ws.send(JSON.stringify(frame));
        }
      }
    }
  });

  return {
    port: eng.port,
    stop: () => eng.stop(),
    start: () => eng.start(),
    close: () => eng.close(),
    putLog: () => [...putSeq],
    putCount: () => putSeq.length,
    finishedSha: () => finishedSha,
    finishedShaOf: (uploadId: string) => uploadShas.get(uploadId) ?? null,
    finishes: () => finishes,
    utterances: () => [...utterances],
    dropCount: () => dropCount,
    setChaos: (n: number) => {
      chaos = n;
    },
    uploadGets: () => [...uploadGets],
    uploadUrl: (uploadId: string) =>
      `http://127.0.0.1:${eng.port}/upload/${encodeURIComponent(uploadId)}`,
    holdHandshake: () => eng.holdHandshake(),
    releaseHandshake: () => eng.releaseHandshake(),
    showImage: (name: string, bytes: Uint8Array, mime: string) => {
      const docId = `srv-doc-${++docN}`;
      docBytes.set(docId, {bytes, mime});
      const frame: Record<string, unknown> = {
        t: 'chat',
        id: CHAT,
        role: 'claude',
        text: '',
        ts: Date.now(),
        file: {docId, name, fileKind: 'image', size: bytes.length},
        ...(opts.serveUploads ? {seq: echoed.length} : {})
      };
      if (opts.serveUploads) echoed.push(frame);
      eng.send(frame);
      return docId;
    },
    docGets: () => [...docGets],
    docRawUrl: (docId: string) =>
      `http://127.0.0.1:${eng.port}/doc/${encodeURIComponent(docId)}/raw`
  };
}
