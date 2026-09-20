/* THE SEALED REQUEST/RESPONSE TUNNEL. This is the SINGLE shared codec: both the engine
 * and the app bundle import it directly, so there is no twin to keep in sync.
 * The WIRE is the contract and is pinned by fixtures/tunnel-vectors.json,
 * exercised from both bundles. StreamEncoder.flush() (live TTS, #531) is used
 * only by engine response streaming; the app never calls it.
 *
 * It moves every content-bearing HTTP call between app and engine off plaintext
 * HTTP onto the already-sealed `cyc` DataChannel, reusing that channel's exact
 * frame shapes -- NO new protocol. A device sends `{t:"req", ...}`; the engine
 * answers one or more `{t:"res", ...}`. Bodies larger than CHUNK ride under one
 * `id`, `more:true` until the last chunk; every chunk is base64 of raw body
 * bytes. The meta (method/path/headers, or status/headers) rides the FIRST
 * frame only; continuations carry `id` + `b` + `more`.
 *
 * NOTHING HERE SEALS OR SENDS. Sealing is the EngineSecConn's / app SecClient's
 * job; the channel IS the auth. This module is a pure codec -- encode() yields
 * frames, a stateful reassembler takes them in -- so the frozen vectors pin
 * every byte independent of any socket, the same contract dcpipe has.
 */

/** Raw body bytes per frame. One 256 KB chunk base64s to ~350 KB
 * of UTF-8, which dcpipe fragments into 16 KB DataChannel writes on its own. */
export const CHUNK = 256 * 1024;

/** Per-id inbound reassembly cap. Plugin rpc (RPC_REPLY_MAX_BYTES 16 MB of
 * JSON) exceeds one chunk and, base64-inflated, needs > ~22 MB; 32 MB clears it
 * with headroom. /user-audio (up to 300 MB) NEVER rides this path: it streams
 * to disk, so nothing here has to hold it. A body past this is refused. */
export const REASSEMBLE_MAX = 32 * 1024 * 1024;

export type ReqFrame = {
  t: "req";
  id: string;
  m?: string; // METHOD, first frame only
  p?: string; // PATH + query, first frame only
  h?: Record<string, string>; // request headers, first frame only
  b?: string; // base64 of this body chunk (absent = an empty chunk)
  more?: boolean; // true = more chunks under this id follow
};

export type ResFrame = {
  t: "res";
  id: string;
  s?: number; // STATUS, first frame only
  h?: Record<string, string>; // response headers, first frame only
  b?: string;
  more?: boolean;
};

export type ReqComplete = {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
};

export type ResComplete = {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

export class TunnelError extends Error {
  constructor(
    readonly code: number,
    reason: string,
  ) {
    super(reason);
  }
}

/* base64 <-> bytes, inline so this file stays byte-identical across the two
 * repos (importing e2e's helpers would spell a different path in each). btoa /
 * atob are global in both Bun and the browser. */
function b64encode(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000; // fromCharCode arg-count safe window
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Split a body into CHUNK-sized pieces. An empty/absent body is ONE piece with
 * no bytes, so a request or response always produces at least one frame. */
function chunkBody(body: Uint8Array | null): Uint8Array[] {
  if (!body || body.length === 0) return [new Uint8Array(0)];
  const out: Uint8Array[] = [];
  for (let off = 0; off < body.length; off += CHUNK) {
    out.push(body.subarray(off, Math.min(off + CHUNK, body.length)));
  }
  return out;
}

/** Encode a request into ordered frames. Keys are inserted in the frozen order
 * (t, id, m, p, h, b, more) so the vectors pin every byte. The first frame
 * carries the meta; continuations carry only id/b/more. */
export function encodeReq(
  id: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Uint8Array | null,
): ReqFrame[] {
  const parts = chunkBody(body);
  return parts.map((part, i) => {
    const f: ReqFrame = { t: "req", id };
    if (i === 0) {
      f.m = method;
      f.p = path;
      f.h = headers;
    }
    if (part.length > 0) f.b = b64encode(part);
    if (i < parts.length - 1) f.more = true;
    return f;
  });
}

/** Encode a response into ordered frames, mirror of encodeReq. */
export function encodeRes(
  id: string,
  status: number,
  headers: Record<string, string>,
  body: Uint8Array | null,
): ResFrame[] {
  const parts = chunkBody(body);
  return parts.map((part, i) => {
    const f: ResFrame = { t: "res", id };
    if (i === 0) {
      f.s = status;
      f.h = headers;
    }
    if (part.length > 0) f.b = b64encode(part);
    if (i < parts.length - 1) f.more = true;
    return f;
  });
}

type Buf = {
  meta: { m?: string; p?: string; h?: Record<string, string>; s?: number } | null;
  parts: Uint8Array[];
  size: number;
  lastAt: number;
};

/** Accumulates the chunks of one direction, keyed by id, and yields the whole
 * request/response on the frame that clears `more`. Rejects an oversize body or
 * a continuation with no live id (a chunk after its own `more:false`). Pure
 * except for `lastAt`, stamped from the `now` push() is given, so sweep() can
 * drop a half-sent id whose sender vanished. */
abstract class Reassembler<F extends { id: string; b?: string; more?: boolean }, C> {
  protected bufs = new Map<string, Buf>();

  protected abstract meta(f: F): Buf["meta"];
  protected abstract assemble(id: string, meta: NonNullable<Buf["meta"]>, body: Uint8Array): C;

  push(f: F, now = Date.now()): C | null {
    let buf = this.bufs.get(f.id);
    if (!buf) {
      buf = { meta: this.meta(f), parts: [], size: 0, lastAt: now };
      this.bufs.set(f.id, buf);
    }
    buf.lastAt = now;
    if (f.b) {
      const bytes = b64decode(f.b);
      buf.size += bytes.length;
      if (buf.size > REASSEMBLE_MAX) {
        this.bufs.delete(f.id);
        throw new TunnelError(1009, "oversize");
      }
      buf.parts.push(bytes);
    }
    if (f.more) return null;
    this.bufs.delete(f.id);
    if (!buf.meta) throw new TunnelError(1002, "no-meta");
    return this.assemble(f.id, buf.meta, concat(buf.parts, buf.size));
  }

  /** Drop every half-assembled id last touched before `cutoff` (an idle-timeout
   * sweep the caller runs on a timer: a sender that died mid-body leaves a
   * buffer nothing will ever finish). Returns how many were dropped. */
  sweep(cutoff: number): number {
    let n = 0;
    for (const [id, buf] of this.bufs) {
      if (buf.lastAt < cutoff) {
        this.bufs.delete(id);
        n++;
      }
    }
    return n;
  }

  get pending(): number {
    return this.bufs.size;
  }
}

export class ReqReassembler extends Reassembler<ReqFrame, ReqComplete> {
  protected meta(f: ReqFrame) {
    return f.m !== undefined || f.p !== undefined || f.h !== undefined
      ? { m: f.m, p: f.p, h: f.h }
      : null;
  }
  protected assemble(id: string, meta: NonNullable<Buf["meta"]>, body: Uint8Array): ReqComplete {
    return {
      id,
      method: meta.m ?? "GET",
      path: meta.p ?? "/",
      headers: meta.h ?? {},
      body,
    };
  }
}

export class ResReassembler extends Reassembler<ResFrame, ResComplete> {
  protected meta(f: ResFrame) {
    return f.s !== undefined || f.h !== undefined ? { s: f.s, h: f.h } : null;
  }
  protected assemble(id: string, meta: NonNullable<Buf["meta"]>, body: Uint8Array): ResComplete {
    return {
      id,
      status: meta.s ?? 200,
      headers: meta.h ?? {},
      body,
    };
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* ---- STREAMING ----------------------------------
 *
 * ADDITIVE capabilities inside the SAME frame shapes; nothing above changed,
 * and the buffered vectors still pin the exact bytes they always did.
 *
 *  - Stream ENCODERS: the same {t:"req"}/{t:"res"} chunk frames, produced as
 *    the body ARRIVES instead of from a whole buffer, for bodies too large or
 *    too slow to hold whole (a 300MB upload, a TTS mp3 still rendering).
 *    Pushed bytes AGGREGATE to exact CHUNK-sized parts, and a part is only
 *    emitted once a LATER byte (or end()) proves whether it is the last, so
 *    the final frame clears `more` with no terminator frame. The invariant
 *    the parity test pins: for ANY complete body, however its pushes were
 *    sliced, the emitted frames are BYTE-IDENTICAL to encodeReq/encodeRes --
 *    the buffered wire stays frozen even when the sender streams. The cost is
 *    granularity: a growing body goes out in CHUNK steps (one part held back
 *    until the next is proven), which streaming consumers accept for losing
 *    the 32MB reassembly ceiling.
 *  - decodeChunk: one frame's body bytes, for a consumer that hands chunks
 *    onward (to a spool file, into a ReadableStream) instead of reassembling.
 *  - {t:"req-abort", id}: the requester walks away from an in-flight
 *    exchange; the answerer stops streaming and cleans up whatever it spooled.
 */

export type ReqAbortFrame = {
  t: "req-abort";
  id: string; // the in-flight request to stop
};

/** Encode an abort for an in-flight request id. Key order frozen (t, id). */
export function encodeReqAbort(id: string): ReqAbortFrame {
  return { t: "req-abort", id };
}

/** One frame's body chunk as raw bytes (absent b = an empty chunk). */
export function decodeChunk(b: string | undefined): Uint8Array {
  return b ? b64decode(b) : new Uint8Array(0);
}

/** Emits wire frames for a body that arrives in pieces. Pushed bytes carve
 * into exact CHUNK-sized parts; push(chunk) returns the parts now PROVEN
 * non-final (bytes exist after them), each `more:true`; end() flushes the
 * rest with `more` cleared on the last frame. An empty body emits the one
 * bare meta frame, exactly like the buffered encoders. push() after end() is
 * a caller bug and throws. */
abstract class StreamEncoder<F> {
  private parts: Uint8Array[] = []; // carved CHUNK-sized parts, not yet emitted
  private tail: Uint8Array[] = []; // < CHUNK bytes after the last carved part
  private tailLen = 0;
  private begun = false;
  private ended = false;

  protected abstract frame(part: Uint8Array, first: boolean, more: boolean): F;

  /** Whether any frame has been emitted yet (the meta frame is out). */
  get started(): boolean {
    return this.begun;
  }

  push(chunk: Uint8Array): F[] {
    if (this.ended) throw new TunnelError(1002, "push-after-end");
    if (chunk.length > 0) {
      this.tail.push(chunk);
      this.tailLen += chunk.length;
    }
    while (this.tailLen >= CHUNK) {
      const all = concat(this.tail, this.tailLen);
      this.parts.push(all.subarray(0, CHUNK));
      const rest = all.subarray(CHUNK);
      this.tail = rest.length ? [rest] : [];
      this.tailLen = rest.length;
    }
    // Emit every part that provably has bytes after it. With an empty tail the
    // last carved part could be the body's exact end: hold it for end().
    const n = this.tailLen > 0 ? this.parts.length : this.parts.length - 1;
    if (n <= 0) return [];
    return this.parts.splice(0, n).map((p) => this.emit(p, true));
  }

  /* Emit everything held so far as continuation frames, WITHOUT waiting for a
   * later byte to prove the last one non-final. reply() calls this after each
   * read for a LIVE stream (a TTS mp3 rendered sentence by sentence): the bytes
   * reach the app as they are produced, instead of sitting in `tail` under the
   * CHUNK threshold until end() -- which for a reply smaller than CHUNK (256 KB,
   * i.e. most spoken replies) meant the whole clip buffered on the wire and
   * played only when generation finished. Framing is no longer CHUNK-exact for
   * a flushed body, which a consumer that just concatenates the stream does not
   * care about; the buffered parity path (no flush) is untouched. */
  flush(): F[] {
    const out = this.parts.splice(0);
    if (this.tailLen > 0) {
      out.push(concat(this.tail, this.tailLen));
      this.tail = [];
      this.tailLen = 0;
    }
    if (out.length === 0) return [];
    return out.map((p) => this.emit(p, true));
  }

  end(): F[] {
    if (this.ended) return [];
    this.ended = true;
    const parts = this.parts.splice(0);
    if (this.tailLen > 0) {
      parts.push(concat(this.tail, this.tailLen));
      this.tail = [];
      this.tailLen = 0;
    }
    if (parts.length === 0) {
      // Nothing held: an empty body (emit the bare meta frame), or --
      // unreachable by construction -- terminate an already-started body.
      return [this.emit(new Uint8Array(0), false)];
    }
    return parts.map((p, i) => this.emit(p, i < parts.length - 1));
  }

  private emit(part: Uint8Array, more: boolean): F {
    const first = !this.begun;
    this.begun = true;
    return this.frame(part, first, more);
  }
}

/** Streaming encoder for one request body; frame shape and key order are
 * exactly encodeReq's (t, id, m, p, h, b, more). */
export class ReqStreamEncoder extends StreamEncoder<ReqFrame> {
  constructor(
    private readonly id: string,
    private readonly method: string,
    private readonly path: string,
    private readonly headers: Record<string, string>,
  ) {
    super();
  }
  protected frame(part: Uint8Array, first: boolean, more: boolean): ReqFrame {
    const f: ReqFrame = { t: "req", id: this.id };
    if (first) {
      f.m = this.method;
      f.p = this.path;
      f.h = this.headers;
    }
    if (part.length > 0) f.b = b64encode(part);
    if (more) f.more = true;
    return f;
  }
}

/** Streaming encoder for one response body, mirror of ReqStreamEncoder. */
export class ResStreamEncoder extends StreamEncoder<ResFrame> {
  constructor(
    private readonly id: string,
    private readonly status: number,
    private readonly headers: Record<string, string>,
  ) {
    super();
  }
  protected frame(part: Uint8Array, first: boolean, more: boolean): ResFrame {
    const f: ResFrame = { t: "res", id: this.id };
    if (first) {
      f.s = this.status;
      f.h = this.headers;
    }
    if (part.length > 0) f.b = b64encode(part);
    if (more) f.more = true;
    return f;
  }
}
