/* ROUTES: resumable transfers (Lane A). A blob of ANY size gets to the engine
 * as a sequence of chunk PUTs, each one tunnel CHUNK (256 KiB) and no more, so a
 * sealed pipe that flaps loses at most the chunk in flight and never the whole
 * upload. The finish step assembles the chunks in order, verifies the size and
 * sha256 the app declared at begin, then hands a file-backed Request to the
 * EXISTING /upload or /user-audio route through the same routeRequest, so the
 * reply the app gets is byte-identical to a direct upload of the same bytes.
 *
 * The chunks live one file each under <transfersDir>/<id>/, with a meta.json
 * beside them. The id is DERIVED from sessionId + sha256, so a second begin for
 * the same bytes (a reconnect, a reload, an engine restart) returns the SAME id
 * and its current `have` with no server-side index to keep -- the directory on
 * disk IS the state, and it survives a restart.
 *
 * AUTH: sealed-tunnel-or-host, exactly like the routes it fronts (requireOwner).
 * These paths are NOT in STREAM_REQ_PATHS: each chunk is already <= one CHUNK,
 * so the buffered reassembler holds one chunk at a time, never the whole file.
 *
 *   bun test agent-engine/src/routes/transfer.test.ts
 */

import type { RoutesCtx } from "./ctx.ts";
import { CHUNK } from "../transport/tunnel.ts";
import { UPLOAD_BODY_MAX_BYTES, readBodyCapped, readJsonCapped } from "../storage/body-limits.ts";
import { UPLOAD_MAX } from "../chat/uploads.ts";
import { cleanDuration } from "../chat/chatmsg.ts";
import { json, markSealedTunnel, requireOwner } from "../transport/httpx.ts";
import { transfersDir } from "../storage/datadir.ts";
import { mkdirPrivate, writePrivate } from "../../../shared/runfiles.ts";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/* The two ceilings the fronted routes enforce, applied at BEGIN so an oversize
 * transfer is refused (413) before a single byte moves. A voice note rides
 * user-audio (300 MB, his call 2026-08-09); an attachment rides upload (50 MB). */
const CAP: Record<TransferKind, number> = {
  "user-audio": UPLOAD_BODY_MAX_BYTES,
  upload: UPLOAD_MAX,
};

/* Abandoned chunk dirs older than this are swept at boot and daily: the app
 * walked away (a DELETE it never got to send, or a device that never came back)
 * and the bytes are dead weight. */
export const TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SYNTH_ORIGIN = "http://127.0.0.1";

export type TransferKind = "upload" | "user-audio";

type TransferMeta = {
  id: string;
  kind: TransferKind;
  sessionId: string;
  size: number;
  mime: string;
  name?: string;
  sha256: string;
  cid?: string;
  /* Seconds, for an audio attachment riding /upload: forwarded at finish as the
   * x-duration-s header so /upload mints durationS exactly as a direct POST. */
  durationS?: number;
  chunk: number;
  createdAt: number;
};

const HEX64 = /^[0-9a-f]{64}$/;

function isKind(v: unknown): v is TransferKind {
  return v === "upload" || v === "user-audio";
}

/** The stable id for these exact bytes in this session: sha256(sessionId \n
 *  sha256). Deterministic so begin is idempotent and a restart re-derives the
 *  same directory; hex so it is a safe path segment on its own. */
async function transferId(sessionId: string, sha256: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(sessionId + "\n" + sha256);
  return h.digest("hex");
}

function dirOf(id: string): string {
  return join(transfersDir(), id);
}

function metaPath(id: string): string {
  return join(dirOf(id), "meta.json");
}

async function readMeta(id: string): Promise<TransferMeta | null> {
  try {
    const j = await Bun.file(metaPath(id)).json();
    if (j && typeof j.id === "string" && isKind(j.kind)) return j as TransferMeta;
    return null;
  } catch {
    return null;
  }
}

/** Which chunk indices are on disk, ascending. A chunk file is named by its
 *  integer index; meta.json and any half-written tmp are ignored. */
async function haveList(id: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(dirOf(id));
  } catch {
    return [];
  }
  const have: number[] = [];
  for (const n of names) {
    if (/^\d+$/.test(n)) have.push(Number(n));
  }
  return have.sort((a, b) => a - b);
}

function chunkCount(size: number): number {
  return size <= 0 ? 0 : Math.ceil(size / CHUNK);
}

/** The exact byte length chunk n must have: every chunk is one CHUNK except the
 *  last, which carries the remainder. A short middle chunk or a long last one is
 *  a framing bug the PUT refuses (400) instead of storing. */
function expectedChunkLen(size: number, n: number): number {
  const count = chunkCount(size);
  return n < count - 1 ? CHUNK : size - (count - 1) * CHUNK;
}

function allIndices(size: number): number[] {
  return Array.from({ length: chunkCount(size) }, (_, i) => i);
}

/* The fronted route's reply, cached beside meta.json once finish succeeded so a
 * repeat finish (the app lost the reply on a flap, or reloaded before it settled)
 * returns the SAME msgId/uploadId without a second upload. The chunks and the
 * assembled copy are gone by then; the sweeper removes the dir on the same
 * 7-day clock as an abandoned transfer. */
const FINISHED = "finished.json";

type FinishedRecord = {
  status: number;
  headers: Record<string, string>;
  bodyB64: string;
  cid?: string;
  at: number;
};

function finishedPath(id: string): string {
  return join(dirOf(id), FINISHED);
}

async function readFinished(id: string): Promise<FinishedRecord | null> {
  try {
    const j = await Bun.file(finishedPath(id)).json();
    if (j && typeof j.status === "number" && typeof j.bodyB64 === "string") {
      return j as FinishedRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/** Marks the reply as the fronted route's own (verbatim), so the app can tell a
 *  definitive refusal by /upload or /user-audio (gone) from a transfer-route
 *  status that only means "try again" (401/403/429 from the tunnel or owner
 *  check). Set on the live reply and on the cached one alike. */
const FRONTED_HEADER = "x-cyc-fronted";

function frontedResponse(status: number, headers: Record<string, string>,
  body: Uint8Array): Response {
  const outHeaders: Record<string, string> = { ...headers };
  outHeaders[FRONTED_HEADER] = "1";
  return new Response(body, { status, headers: outHeaders });
}

export async function transferRoutes(ctx: RoutesCtx, req: Request, url: URL, path: string,
  server: import("bun").Server): Promise<Response | null> {

  if (!path.startsWith("/transfer")) return null;

  // POST /transfer/begin -> {id, chunk, have}. Idempotent on sha256+sessionId.
  if (path === "/transfer/begin" && req.method === "POST") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const got = await readJsonCapped(req, 8 * 1024);
    if (!got.ok) return got.response;
    const b = (got.value ?? {}) as Record<string, unknown>;
    const kind = b.kind;
    const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
    const size = Number(b.size);
    const mime = typeof b.mime === "string" && b.mime ? b.mime : "application/octet-stream";
    const sha256 = typeof b.sha256 === "string" ? b.sha256.toLowerCase() : "";
    const name = typeof b.name === "string" ? b.name : undefined;
    const cid = typeof b.cid === "string" ? b.cid : undefined;
    const durationS = cleanDuration(b.durationS);
    if (!isKind(kind) || !sessionId || !HEX64.test(sha256) ||
      !Number.isSafeInteger(size) || size <= 0) {
      return json({ error: "bad begin: need kind, sessionId, size>0, sha256(hex64)" }, 400);
    }
    if (size > CAP[kind]) {
      /* Refused BEFORE any bytes move, and nothing is written for it. This is the
       * 413 an oversize file must get up front rather than after uploading it. */
      ctx.log("transfer.begin.too-large", { kind, sessionId, size, cap: CAP[kind], cid,
        why: "the declared size is over the cap this transfer's route enforces; nothing is stored" });
      return json({ error: "too large", max: CAP[kind] }, 413);
    }
    const id = await transferId(sessionId, sha256);
    const meta: TransferMeta = { id, kind, sessionId, size, mime, name, sha256, cid,
      ...(durationS ? { durationS } : {}), chunk: CHUNK, createdAt: Date.now() };
    /* A finished transfer for these bytes under a DIFFERENT cid is a new message
     * that happens to carry identical bytes (the same photo sent twice): it must
     * get its own upload, not the first message's cached msgId. Same cid (or no
     * cid on either side) is the same message re-sending after a flap or reload
     * and keeps the cache, so begin reports every chunk present and finish
     * returns the reply already minted. */
    const prior = await readFinished(id);
    if (prior && prior.cid !== cid) {
      await rm(dirOf(id), { recursive: true, force: true });
      ctx.log("transfer.begin.fresh", { id, kind, sessionId, cid, priorCid: prior.cid,
        why: "same bytes under a new cid: the finished reply cached for the old cid is dropped" });
    }
    await mkdirPrivate(dirOf(id));
    /* Only (re)write meta when it is not already there: an idempotent begin must
     * not reset createdAt (the sweeper reads it) or clobber a live transfer. */
    if (!(await readMeta(id))) {
      await writePrivate(metaPath(id), JSON.stringify(meta));
    }
    const have = (await readFinished(id)) ? allIndices(size) : await haveList(id);
    ctx.log("transfer.begin", { id, kind, sessionId, size, chunks: chunkCount(size),
      have: have.length, cid });
    return json({ id, chunk: CHUNK, have });
  }

  // PUT /transfer/:id/:n  raw chunk bytes -> {have}. Idempotent, atomic.
  const put = path.match(/^\/transfer\/([0-9a-f]{64})\/(\d+)$/);
  if (put && req.method === "PUT") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const id = put[1];
    const n = Number(put[2]);
    const meta = await readMeta(id);
    if (!meta) return json({ error: "no such transfer" }, 404);
    if (!Number.isSafeInteger(n) || n < 0 || n >= chunkCount(meta.size)) {
      return json({ error: "chunk index out of range" }, 400);
    }
    // Already finished: every chunk was consumed and the reply is cached. A
    // late re-PUT (the app never saw the earlier {have}) is a no-op that reports
    // the full set so the app proceeds to finish.
    if (await readFinished(id)) {
      return json({ have: allIndices(meta.size) });
    }
    // Every chunk is EXACTLY one CHUNK except the last, which is exactly the
    // remainder. readBodyCapped refuses anything over CHUNK; the length check
    // refuses a short or a wrong-sized chunk, both framing bugs, before storing.
    const got = await readBodyCapped(req, CHUNK);
    if (!got.ok) return got.response;
    const bytes = got.value;
    const want = expectedChunkLen(meta.size, n);
    if (bytes.byteLength !== want) {
      ctx.log("transfer.put.bad-length", { id, n, want, got: bytes.byteLength,
        why: "chunk n must be exactly CHUNK bytes (the last one exactly the remainder); refused" });
      return json({ error: "chunk length mismatch", want, got: bytes.byteLength }, 400);
    }
    const tmp = join(dirOf(id), `.${n}.${crypto.randomUUID()}.tmp`);
    await writePrivate(tmp, bytes as unknown as ArrayBuffer);
    await rename(tmp, join(dirOf(id), String(n)));
    const have = await haveList(id);
    ctx.log("transfer.put", { id, n, bytes: bytes.byteLength, have: have.length,
      chunks: chunkCount(meta.size) });
    return json({ have });
  }

  const idm = path.match(/^\/transfer\/([0-9a-f]{64})$/);
  if (idm) {
    const id = idm[1];
    // GET /transfer/:id -> {have, size, chunk, done}
    if (req.method === "GET") {
      const denied = await requireOwner(req, server);
      if (denied) return denied;
      const meta = await readMeta(id);
      if (!meta) return json({ error: "no such transfer" }, 404);
      // Finished: the chunks are gone but the reply is cached, so the app sees
      // "everything is here" and goes straight to finish for the cached reply.
      const have = (await readFinished(id)) ? allIndices(meta.size) : await haveList(id);
      const done = have.length === chunkCount(meta.size);
      return json({ have, size: meta.size, chunk: meta.chunk, done });
    }
    // DELETE /transfer/:id -> {ok:true}. The app walked away.
    if (req.method === "DELETE") {
      const denied = await requireOwner(req, server);
      if (denied) return denied;
      await rm(dirOf(id), { recursive: true, force: true });
      ctx.log("transfer.deleted", { id, why: "the app walked away from this transfer" });
      return json({ ok: true });
    }
  }

  // POST /transfer/:id/finish -> assemble, verify, hand to the fronted route.
  const fin = path.match(/^\/transfer\/([0-9a-f]{64})\/finish$/);
  if (fin && req.method === "POST") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const id = fin[1];
    const meta = await readMeta(id);
    if (!meta) return json({ error: "no such transfer" }, 404);
    /* Already finished: return the cached fronted reply, byte-for-byte, with no
     * second upload. This is what makes a lost finish reply (a flap on the way
     * back, a reload mid-finish) converge on ONE msgId instead of two clips. */
    const cached = await readFinished(id);
    if (cached) {
      ctx.log("transfer.finish.cached", { id, kind: meta.kind, status: cached.status,
        why: "finish repeated after success; the cached reply is returned, nothing re-uploaded" });
      return frontedResponse(cached.status, cached.headers,
        new Uint8Array(Buffer.from(cached.bodyB64, "base64")));
    }
    const count = chunkCount(meta.size);
    const have = await haveList(id);
    if (have.length !== count) {
      // Not every chunk is here yet; the chunks that ARE here are kept so the
      // app can fill the gap and finish again.
      ctx.log("transfer.finish.incomplete", { id, have: have.length, chunks: count,
        why: "finish called before every chunk landed; chunks kept for the app to resume" });
      return json({ ok: false, error: "incomplete", have }, 409);
    }

    // Assemble in order into one file, hashing and counting as we go: this loop
    // holds one chunk at a time. What DOES buffer whole is downstream: the
    // fronted route reads its body with readBodyCapped, which materialises the
    // entire assembled file in memory (up to that route's cap, 300 MB for
    // user-audio) before persisting it; and the app hashed the whole blob in
    // memory at begin. The transfer buys resumability over a flapping pipe, not
    // a smaller peak on the engine.
    const assembled = join(dirOf(id), ".assembled");
    const hasher = new Bun.CryptoHasher("sha256");
    let total = 0;
    const sink = Bun.file(assembled).writer();
    try {
      for (let i = 0; i < count; i++) {
        const buf = new Uint8Array(await Bun.file(join(dirOf(id), String(i))).arrayBuffer());
        hasher.update(buf);
        total += buf.byteLength;
        sink.write(buf);
      }
      await sink.end();
    } catch (e) {
      await Promise.resolve(sink.end()).catch(() => {});
      await rm(assembled, { force: true });
      ctx.log("transfer.finish.assemble-failed", { id, err: String(e) });
      return json({ ok: false, error: "assemble failed" }, 500);
    }
    const gotSha = hasher.digest("hex");
    if (total !== meta.size || gotSha !== meta.sha256) {
      /* The bytes on disk are not the bytes the app promised. Keep the chunks
       * (something re-sent one wrong; a re-PUT + finish can still succeed) and
       * refuse; this is the definitive "could not send" the bubble draws. */
      await rm(assembled, { force: true });
      ctx.log("transfer.finish.mismatch", { id, wantSize: meta.size, gotSize: total,
        wantSha: meta.sha256, gotSha,
        why: "the assembled bytes do not match the declared size/sha256; chunks kept, refused" });
      return json({ ok: false, error: "hash mismatch" }, 422);
    }

    // Hand the assembled bytes to the route this transfer fronts, through the
    // SAME routeRequest the sealed tunnel and localhost use, so the reply is
    // byte-identical to a direct upload. Marked sealed because this synthetic
    // in-process Request never touched a socket (see httpx.markSealedTunnel).
    const target = meta.kind === "user-audio"
      ? "/user-audio" + (meta.cid ? `?cid=${encodeURIComponent(meta.cid)}` : "")
      : "/upload";
    const headers = new Headers();
    headers.set("content-type", meta.mime);
    headers.set("content-length", String(total));
    if (meta.kind === "upload" && meta.name) {
      headers.set("x-filename", encodeURIComponent(meta.name));
    }
    if (meta.kind === "upload" && meta.durationS) {
      headers.set("x-duration-s", String(meta.durationS));
    }
    const subReq = new Request(SYNTH_ORIGIN + target, {
      method: "POST",
      headers,
      body: Bun.file(assembled),
    });
    markSealedTunnel(subReq);
    let res: Response;
    try {
      res = await ctx.routeRequest(subReq, server);
    } catch (e) {
      await rm(assembled, { force: true });
      ctx.log("transfer.finish.route-threw", { id, target, err: String(e) });
      return json({ ok: false, error: "handoff failed" }, 500);
    }

    const bodyBytes = new Uint8Array(await res.arrayBuffer());
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });

    if (res.ok) {
      // The fronted route has the bytes now: the chunks and the assembled copy
      // are dead weight and go. meta.json stays, with the reply cached beside it
      // in finished.json, so a repeat finish returns this same reply (one msgId,
      // never a second upload) until the sweeper removes the dir.
      const chunks = await haveList(id);
      await Promise.all(chunks.map((i) => rm(join(dirOf(id), String(i)), { force: true })));
      await rm(assembled, { force: true });
      const rec: FinishedRecord = { status: res.status, headers: resHeaders,
        bodyB64: Buffer.from(bodyBytes).toString("base64"), cid: meta.cid, at: Date.now() };
      await writePrivate(finishedPath(id), JSON.stringify(rec));
      ctx.log("transfer.finish.ok", { id, kind: meta.kind, size: total, status: res.status });
    } else {
      // The route refused (its own cap, a persist failure). Drop the assembled
      // copy but KEEP the chunks; the status is returned to the app verbatim.
      await rm(assembled, { force: true });
      ctx.log("transfer.finish.route-refused", { id, kind: meta.kind, status: res.status });
    }
    /* Verbatim: the same status, headers and body the direct route produced, so
     * the app's uploadAudio/uploadFile parsing sees exactly what it sees today.
     * A fresh Response because the original body stream is single-use once read
     * by the caller, plus x-cyc-fronted: 1 so the app knows this status is the
     * fronted route's verdict. */
    return frontedResponse(res.status, resHeaders, bodyBytes);
  }

  return null;
}

/** Remove chunk dirs whose meta.createdAt (or dir mtime, if meta is gone) is
 *  older than TRANSFER_TTL_MS. Runs at boot and daily. Returns how many were
 *  removed, for the boot log and the sweeper test. */
export async function sweepTransfers(now = Date.now()): Promise<number> {
  let ids: string[];
  try {
    ids = await readdir(transfersDir());
  } catch {
    return 0; // nothing was ever transferred
  }
  let removed = 0;
  for (const id of ids) {
    const dir = join(transfersDir(), id);
    let at: number;
    const meta = await readMeta(id);
    if (meta) {
      at = meta.createdAt;
    } else {
      try {
        at = (await stat(dir)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - at > TRANSFER_TTL_MS) {
      await rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Boot the sweeper: once now, then daily. The engine calls this at start-up;
 *  a test calls sweepTransfers() directly and never this. */
export function startTransferSweeper(log: (e: string, f: Record<string, unknown>) => void): void {
  const run = () => {
    void sweepTransfers().then((n) => {
      if (n > 0) log("transfer.swept", { removed: n, why: "chunk dirs older than 7 days removed" });
    }).catch(() => {});
  };
  run();
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(run, 24 * 60 * 60 * 1000);
  // Do not keep the process alive for the sweep alone.
  (sweepTimer as unknown as { unref?: () => void }).unref?.();
}
