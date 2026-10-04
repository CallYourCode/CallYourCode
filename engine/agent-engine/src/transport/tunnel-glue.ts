/* TUNNEL GLUE (L4 interface): a sealed `{t:"req"}` frame
 * becomes a routed request against this engine, answered as one or more
 * sealed `{t:"res"}` frames.
 *
 * There is NO new protocol and NO per-route rewrite. The engine has ONE request
 * router with two feeds: the localhost HTTP socket and this sealed tunnel.
 * onReq reassembles the frames (tunnel.ts), synthesizes a `Request` from them,
 * and hands it to the SAME routeRequest the localhost server uses, so every
 * route and body limit behaves identically. The device is already through the
 * sealed v2 sec handshake
 * (ws.data.sec is set only after enrolment), so the CHANNEL is the auth: onReq
 * marks the request (markSealedTunnel), and requireOwner treats a marked request
 * as the owner. There is no HTTP bearer at all now (the x-cyc-cap machinery is
 * deleted): a content route answers the sealed tunnel and the host only.
 * requireLocal routes (agent-message, debug, trim-log) stay refused --
 * they are local-only by design and the app never tunnels them.
 *
 * STREAMING. Three additions inside the same frames:
 *
 *  (a) STREAMED REQUESTS, for the fixed big-body routes in STREAM_REQ_PATHS
 *      (/upload, /user-audio): their chunks SPOOL to a temp file as they
 *      arrive instead of reassembling in memory, and the route gets a
 *      file-backed Request body once the last chunk lands. This retires the
 *      old "/user-audio stays on HTTP" exemption -- a 300MB voice note now
 *      rides the sealed channel without anything holding it whole.
 *  (b) STREAMED REPLIES: reply() streams res.body as it arrives rather than
 *      buffering via arrayBuffer(), so an answer has no 32MB ceiling and a
 *      GROWING body (a TTS mp3 still rendering) goes out chunk by chunk. The
 *      encoder's lookahead keeps a fully-buffered body's frames byte-identical
 *      to the old encodeRes wire.
 *  (c) {t:"req-abort", id}: the app walked away; the engine stops spooling
 *      (and deletes the spool file) and stops a reply still going out.
 *
 * The reply is chunked by tunnel.ts and each chunk is sealed + sent in order
 * with a pipe.drain() between them, so a large answer rides the backpressure
 * dcpipe already has. Replies are NOT awaited by the frame dispatch: a growing
 * body can stay open for minutes, and the dispatch loop must keep reading --
 * not least the {t:"req-abort"} that stops that very reply. Frames of
 * concurrent replies interleave on the wire; the app correlates by id.
 */

import { ReqReassembler, ResStreamEncoder, decodeChunk, encodeRes, TunnelError,
  type ReqAbortFrame, type ReqFrame } from "./tunnel.ts";
import { send } from "./wire.ts";
import { markSealedTunnel } from "./httpx.ts";
import { UPLOAD_BODY_MAX_BYTES } from "../storage/body-limits.ts";
import { tunnelTmpDir } from "../storage/datadir.ts";
import { mkdirPrivate } from "../../../shared/runfiles.ts";
import { open, readdir, rm, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Sock } from "./sock.ts";

export type TunnelDeps = {
  /** the engine's one request router, verbatim; the localhost server's
   * Bun.serve fetch() calls the same function */
  routeRequest: (req: Request, server: import("bun").Server) => Promise<Response>;
  /** the live server, for the handlers that read server.requestIP() */
  server: import("bun").Server;
  log: (event: string, fields: Record<string, unknown>) => void;
};

let deps: TunnelDeps | null = null;
export function initTunnel(d: TunnelDeps): void {
  deps = d;
  /* Spool files a previous run left behind (a crash mid-upload): the dir is
   * exclusively this module's, so anything in it is garbage now. */
  void (async () => {
    try {
      for (const f of await readdir(tunnelTmpDir())) {
        await rm(join(tunnelTmpDir(), f), { force: true });
      }
    } catch {
      // no dir yet: nothing was ever spooled
    }
  })();
}

/** The request paths whose bodies STREAM to a spool file instead of
 * reassembling in memory. A fixed set: exactly the
 * two big-body uploads; everything else keeps the buffered path unchanged. */
export const STREAM_REQ_PATHS: ReadonlySet<string> = new Set(["/upload", "/user-audio"]);

type ReqStream = {
  meta: { m?: string; p?: string; h?: Record<string, string> };
  tmp: string;
  /** null only while the spool file is still opening: openStream registers the
   * stream BEFORE that async open so a continuation frame racing it is held in
   * `queue` rather than misrouted to the buffered reassembler. */
  fh: FileHandle | null;
  size: number;
  /** false while the spool file is still opening; onReq queues continuation
   * frames until openStream has written the first frame and drained them. */
  ready: boolean;
  /** continuation frames that arrived during the async open, in arrival order */
  queue: ReqFrame[];
};

/* TEST-ONLY CHAOS (Lane A proof). When CYC_CHAOS_DROP_AFTER_BYTES is set, the
 * sealed pipe is closed after that many request-body bytes have arrived on THIS
 * connection, simulating the roaming-4G flap from the incident: the DataChannel
 * dies mid-upload and the app must reconnect and resume. Inert (0) unless the
 * env var is a positive number, and read lazily so a test can set it per case. */
function chaosDropAfterBytes(): number {
  const n = Number(process.env.CYC_CHAOS_DROP_AFTER_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

type TunnelState = {
  /** buffered reassembly, exactly as before, for every non-streaming request */
  rx: ReqReassembler;
  /** request-body bytes seen on this connection, for the chaos drop only */
  chaosBytes: number;
  /** streamed request bodies mid-spool, keyed by id */
  streams: Map<string, ReqStream>;
  /** ids whose stream was killed (abort, oversize, write error): their
   * remaining chunks are swallowed until the frame that clears `more` */
  dead: Set<string>;
  /** in-flight streamed replies, keyed by id: call the fn to stop sending */
  replies: Map<string, () => void>;
};

/* One tunnel state per connection, dropped with the socket (a WeakMap so
 * closeClient needs no extra teardown for the memory; closeTunnelClient below
 * cleans the DISK half, which no WeakMap can). A sealed DC client only; a
 * frame on anything without a sec state machine is ignored. */
const stateOf = new WeakMap<Sock, TunnelState>();

function state(ws: Sock): TunnelState {
  let st = stateOf.get(ws);
  if (!st) {
    st = { rx: new ReqReassembler(), chaosBytes: 0, streams: new Map(), dead: new Set(), replies: new Map() };
    stateOf.set(ws, st);
  }
  return st;
}

/** The origin every synthesized tunnel request is built against (a `Request`
 * needs an absolute URL). routeRequest only reads url.pathname + url.search,
 * so the host is cosmetic; keeping it loopback means a route that inspects the
 * origin sees "this machine". */
const SYNTH_ORIGIN = "http://127.0.0.1";

/** Send one Response back over the sealed channel as chunked {t:"res"} frames,
 * streaming res.body AS IT ARRIVES: a fully-buffered body emits the
 * exact frames the old arrayBuffer() path did (the stream encoder's lookahead
 * pins that), a growing body goes out chunk by chunk with no size ceiling.
 * Drains between chunks so a big or slow answer respects dcpipe backpressure;
 * a {t:"req-abort"} for this id stops the stream mid-body. */
async function reply(ws: Sock, id: string, res: Response, st?: TunnelState): Promise<void> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  /* A route can mark a response as a LIVE stream (a still-rendering TTS mp3, the
   * growing-clip follow stream): its bytes are flushed to the app as each read
   * lands, instead of aggregating to CHUNK-sized parts that would hold a
   * sub-CHUNK reply on the wire until the body closes (routes/media.ts #531).
   * The header is a control signal, stripped before it becomes the answer. */
  const liveStream = headers["x-cyc-stream"] === "live";
  delete headers["x-cyc-stream"];
  const enc = new ResStreamEncoder(id, res.status, headers);
  let aborted = false;
  st?.replies.set(id, () => {
    aborted = true;
  });
  try {
    const body = res.body;
    if (body) {
      const reader = body.getReader();
      try {
        for (;;) {
          if (aborted) {
            await reader.cancel().catch(() => {});
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;
          for (const f of enc.push(value)) {
            // seal + send in order; the RtcSock's send() seals through its
            // EngineSecConn.
            send(ws, f);
            await ws.data.pipeDrain?.();
          }
          // A live stream flushes what push() held back, so a sub-CHUNK reply
          // goes out as it is produced rather than waiting for end().
          if (liveStream) {
            for (const f of enc.flush()) {
              send(ws, f);
              await ws.data.pipeDrain?.();
            }
          }
        }
      } catch (e) {
        deps?.log("tunnel.res-stream-threw", { id, err: String(e) });
        if (!enc.started) {
          // nothing on the wire yet: the answer can still be a clean 500
          for (const f of encodeRes(id, 500, {}, new TextEncoder().encode("tunnel body stream error"))) {
            send(ws, f);
            await ws.data.pipeDrain?.();
          }
          return;
        }
        // The meta frame is out: close the body truncated (fall through to
        // end()) rather than leave the caller's stream hanging forever.
      }
    }
    if (aborted) return;
    for (const f of enc.end()) {
      send(ws, f);
      await ws.data.pipeDrain?.();
    }
  } finally {
    st?.replies.delete(id);
  }
}

export async function onReq(ws: Sock, m: ReqFrame): Promise<void> {
  if (!deps) return;
  // Tunnel rides the sealed DataChannel only; without a sec state machine there
  // is no proven device behind this frame, so there is nothing to authorise.
  if (!ws.data.sec) return;
  const d = deps;
  const id = typeof m?.id === "string" ? m.id : "";
  if (!id) return;
  const st = state(ws);

  /* TEST-ONLY: kill the pipe once this connection has carried enough body bytes,
   * BEFORE this frame is processed, so the chunk in flight is lost and the app
   * has to reconnect and resume it (exactly the incident's failure mode). */
  const chaos = chaosDropAfterBytes();
  if (chaos > 0 && typeof m.b === "string") {
    const before = st.chaosBytes;
    st.chaosBytes += decodeChunk(m.b).length;
    if (before <= chaos && st.chaosBytes > chaos) {
      deps.log("tunnel.chaos-drop", { bytes: st.chaosBytes, after: chaos,
        why: "CYC_CHAOS_DROP_AFTER_BYTES: closing the sealed pipe mid-transfer" });
      try { ws.close(4009, "chaos-drop"); } catch { /* already gone */ }
      return;
    }
    if (st.chaosBytes > chaos) return; // already dropped: swallow the rest
  }

  // A continuation of a killed stream (aborted, oversize, write error):
  // swallow its chunks until the frame that clears `more`.
  if (st.dead.has(id)) {
    if (!m.more) st.dead.delete(id);
    return;
  }

  // An id already spooling: feed it. While its spool file is still opening
  // (ready=false), hold this continuation in arrival order -- openStream drains
  // the queue once the file is ready. Without this the frame would fall through
  // to the buffered reassembler below, which throws no-meta and answers the id
  // a spurious 413, failing an upload whose first frame merely lost the race to
  // its own async file open (dispatch is not serialised: rtc-glue feeds every
  // sealed frame with `void dispatchClientFrame`).
  const s = st.streams.get(id);
  if (s) {
    if (!s.ready) { s.queue.push(m); return; }
    return feedStream(ws, st, id, s, m);
  }

  // The first frame of a streaming-route request opens a spool instead of the
  // reassembler. Only a frame CARRYING the meta can open one, and only for the
  // fixed big-body routes; everything else is the buffered path, unchanged.
  const isFirst = m.m !== undefined || m.p !== undefined || m.h !== undefined;
  if (isFirst && STREAM_REQ_PATHS.has((m.p ?? "/").split("?")[0])) {
    return openStream(ws, st, id, m);
  }

  let done: ReturnType<ReqReassembler["push"]>;
  try {
    done = st.rx.push(m);
  } catch (e) {
    // Oversize: the app framed a body past the reassembly cap. Answer 413 on
    // the id so the caller's promise rejects rather than hanging.
    if (e instanceof TunnelError) {
      await reply(ws, id, new Response("tunnel body too large", { status: 413 }), st);
    }
    return;
  }
  if (!done) return; // more chunks under this id still to come

  // The request synthesized from the reassembled sealed frames; it exists only
  // in this process and never touched an HTTP socket.
  const url = SYNTH_ORIGIN + (done.path.startsWith("/") ? done.path : "/" + done.path);
  const headers = new Headers(done.headers);
  const method = done.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && done.body.length > 0;
  const synthReq = new Request(url, {
    method,
    headers,
    body: hasBody ? done.body : undefined,
  });
  // The channel IS the auth: this request came through the sealed DataChannel,
  // which already proved the device (ws.data.sec). Mark it so requireOwner
  // treats it as the owner, WITHOUT a forgeable cap header. A remote HTTP caller
  // never gets this mark (it is keyed on the in-process Request object), so the
  // content routes answer the tunnel and localhost only. requireLocal routes
  // (agent-message, debug) are unmarked and stay this-machine-only by design.
  markSealedTunnel(synthReq);

  let res: Response;
  try {
    res = await d.routeRequest(synthReq, d.server);
  } catch (e) {
    d.log("tunnel.threw", { path: done.path, err: String(e) });
    res = new Response("tunnel handler error", { status: 500 });
  }
  /* NOT AWAITED (see the header): a streamed reply can stay open for minutes,
   * and this dispatch is awaited by the sock's frame loop. */
  void reply(ws, done.id, res, st).catch((e) =>
    d.log("tunnel.reply-threw", { path: done.path, err: String(e) }));
}

/** {t:"req-abort", id}: the app walked away from an in-flight
 * request. Stop spooling its body and delete the spool file; stop a streamed
 * reply still going out. An id that already finished is a no-op. */
export async function onReqAbort(ws: Sock, m: ReqAbortFrame): Promise<void> {
  if (!ws.data.sec) return;
  const st = stateOf.get(ws);
  if (!st) return;
  const id = typeof m?.id === "string" ? m.id : "";
  if (!id) return;
  const s = st.streams.get(id);
  if (s) {
    deps?.log("tunnel.req-aborted", { id, spooled: s.size });
    await killStream(st, id, s);
    st.dead.add(id); // whatever chunks of the aborted body still arrive are swallowed
  }
  st.replies.get(id)?.();
}

/** The socket died: the WeakMap entry goes with it, but half-spooled bodies on
 * DISK do not. Called from closeClient (frames.ts). */
export function closeTunnelClient(ws: Sock): void {
  const st = stateOf.get(ws);
  if (!st) return;
  for (const [id, s] of [...st.streams]) {
    void killStream(st, id, s);
  }
  for (const stop of st.replies.values()) stop();
  st.dead.clear();
}

async function killStream(st: TunnelState, id: string, s: ReqStream): Promise<void> {
  st.streams.delete(id);
  // fh is null for a stream killed while its spool file was still opening
  // (closeTunnelClient over a mid-open stream); there is nothing to close then.
  await s.fh?.close().catch(() => {});
  await unlink(s.tmp).catch(() => {});
}

async function openStream(ws: Sock, st: TunnelState, id: string, m: ReqFrame): Promise<void> {
  const tmp = join(tunnelTmpDir(), `req-${crypto.randomUUID()}`);
  /* REGISTERED BEFORE THE AWAIT. Frame dispatch is not serialised (rtc-glue
   * feeds every sealed frame with `void dispatchClientFrame`), so a continuation
   * chunk of this same upload can reach onReq while the two awaits below are
   * still opening the spool file. It must find this stream and be held in its
   * queue; if it does not, onReq routes it to the buffered reassembler, which
   * throws no-meta and answers the id 413 -- the whole upload fails for having
   * lost a race with its own file open. */
  const s: ReqStream = { meta: { m: m.m, p: m.p, h: m.h }, tmp, fh: null, size: 0, ready: false, queue: [] };
  st.streams.set(id, s);
  try {
    await mkdirPrivate(tunnelTmpDir());
    s.fh = await open(tmp, "w", 0o600);
  } catch (e) {
    deps?.log("tunnel.spool-open-failed", { id, err: String(e) });
    st.streams.delete(id);
    if (m.more || s.queue.some((q) => q.more)) st.dead.add(id);
    await reply(ws, id, new Response("tunnel spool failed", { status: 500 }), st);
    return;
  }
  // The first frame, then every continuation that raced the open, in the order
  // they arrived. feedStream clears the stream from st.streams on the last frame
  // (more:false), so stop the moment that happens rather than feed a closed fh.
  await feedStream(ws, st, id, s, m);
  while (s.queue.length && st.streams.get(id) === s) {
    await feedStream(ws, st, id, s, s.queue.shift()!);
  }
  // No await between the emptiness check above and this flip, so no further
  // continuation can slip in unqueued: from here onReq feeds them directly.
  if (st.streams.get(id) === s) s.ready = true;
}

async function feedStream(ws: Sock, st: TunnelState, id: string, s: ReqStream, m: ReqFrame): Promise<void> {
  try {
    const bytes = decodeChunk(m.b);
    if (bytes.length > 0) {
      s.size += bytes.length;
      if (s.size > UPLOAD_BODY_MAX_BYTES) {
        // past the largest legit body this engine accepts at all: stop the
        // spool now instead of letting a client fill the disk.
        await killStream(st, id, s);
        if (m.more) st.dead.add(id);
        await reply(ws, id, new Response("tunnel body too large", { status: 413 }), st);
        return;
      }
      // fh is non-null here by construction: feedStream is only ever reached
      // once openStream has opened the spool file (the first frame and drained
      // racers) or once ready=true (later frames via onReq).
      await s.fh!.write(bytes);
    }
  } catch (e) {
    deps?.log("tunnel.spool-write-failed", { id, err: String(e) });
    await killStream(st, id, s);
    if (m.more) st.dead.add(id);
    await reply(ws, id, new Response("tunnel spool failed", { status: 500 }), st);
    return;
  }
  if (m.more) return; // more chunks still to come
  st.streams.delete(id);
  await s.fh!.close().catch(() => {});
  await dispatchStreamed(ws, st, id, s);
}

/** The whole streamed body is on disk: run the route against a file-backed
 * Request, answer, then delete the spool file whatever happened. */
async function dispatchStreamed(ws: Sock, st: TunnelState, id: string, s: ReqStream): Promise<void> {
  const d = deps!;
  const path = s.meta.p ?? "/";
  const url = SYNTH_ORIGIN + (path.startsWith("/") ? path : "/" + path);
  const headers = new Headers(s.meta.h ?? {});
  // the spooled size is the truth; whatever length the client declared is
  // replaced, so the route's declared-length cap sees real bytes
  headers.set("content-length", String(s.size));
  const method = (s.meta.m ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && s.size > 0;
  let res: Response;
  try {
    const synthReq = new Request(url, {
      method,
      headers,
      // file-backed: the route streams it off disk (readBodyCapped), nothing
      // holds the body whole here
      body: hasBody ? Bun.file(s.tmp) : undefined,
    });
    markSealedTunnel(synthReq);
    res = await d.routeRequest(synthReq, d.server);
  } catch (e) {
    d.log("tunnel.threw", { path, err: String(e) });
    res = new Response("tunnel handler error", { status: 500 });
  }
  try {
    await reply(ws, id, res, st);
  } finally {
    await unlink(s.tmp).catch(() => {});
  }
}
