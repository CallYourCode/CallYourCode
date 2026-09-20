/* THE RESUMABLE TRANSFER ROUTE (Lane A), against the real route code.
 *
 * serveRoutes gives a Bun.serve on the loopback that dispatches [transferRoutes,
 * mediaRoutes] exactly the way server.ts does; ctx.routeRequest is wired to walk
 * the same two groups, so finish hands its assembled bytes to the real
 * /user-audio handler and we can prove the reply matches a direct upload.
 *
 *   bun test agent-engine/src/routes/transfer.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { transferRoutes, sweepTransfers, TRANSFER_TTL_MS } from "./transfer.ts";
import { mediaRoutes } from "./media.ts";
import { CHUNK } from "../transport/tunnel.ts";
import { UPLOAD_MAX, makeUploads } from "../chat/uploads.ts";
import { transfersDir } from "../storage/datadir.ts";
import { initClips, audioFromDisk, resetForTest as resetClips } from "../chat/clips.ts";
import { writePrivate } from "../../../shared/runfiles.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";

let http: ServedRoutes;
let dataRoot: string;

const SID = "ws://box/ws|pane1";

function sha256hex(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  // deterministic-ish fill; content only has to be stable within a test
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

async function begin(body: Record<string, unknown>): Promise<Response> {
  return http.post("/transfer/begin", body);
}

async function putChunk(id: string, n: number, bytes: Uint8Array): Promise<Response> {
  return http.fetch(`/transfer/${id}/${n}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: bytes as unknown as BodyInit,
  });
}

/** Begin + PUT every chunk of these bytes for a user-audio transfer. */
async function upload(bytes: Uint8Array, cid: string): Promise<string> {
  const sha256 = sha256hex(bytes);
  const b = await begin({ kind: "user-audio", sessionId: SID, size: bytes.byteLength, mime: "audio/webm", sha256, cid });
  const { id } = (await b.json()) as { id: string };
  for (let off = 0, n = 0; off < bytes.byteLength; off += CHUNK, n++) {
    await putChunk(id, n, bytes.subarray(off, Math.min(off + CHUNK, bytes.byteLength)));
  }
  return id;
}

beforeAll(async () => {
  const { root, data } = await tmpDataDir("cyc-transfer-");
  dataRoot = root;
  process.env.CYC_DATA_DIR = data;
  await initClips({
    blobOwner: () => new Map(),
    agentIdFor: () => { throw new Error("no session in this test"); },
    stagingDir: join(data, "staging-audio") + "/",
  });
  const uploads = await makeUploads({
    stagingDir: join(data, "staging-uploads") + "/",
    blobOwner: () => new Map(),
    agentIdFor: () => { throw new Error("no session in this test"); },
    referencedIds: () => new Set(),
    log: () => {},
  });
  http = serveRoutes({ groups: [transferRoutes, mediaRoutes], ctx: { uploads } });
  const fakeSrv = { requestIP: () => null } as unknown as import("bun").Server;
  http.ctx.routeRequest = async (req) => {
    const url = new URL(req.url);
    for (const g of [transferRoutes, mediaRoutes]) {
      const r = await g(http.ctx, req, url, url.pathname, fakeSrv);
      if (r) return r;
    }
    return new Response("not found", { status: 404 });
  };
});

afterAll(async () => {
  http?.stop();
  resetClips();
  delete process.env.CYC_DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
});

test("begin is idempotent on sha256+sessionId: same id and current have", async () => {
  const bytes = randomBytes(CHUNK + 1000); // two chunks
  const sha256 = sha256hex(bytes);
  const first = await begin({ kind: "user-audio", sessionId: SID, size: bytes.byteLength, mime: "audio/webm", sha256, cid: "c-idem" });
  expect(first.status).toBe(200);
  const j1 = (await first.json()) as { id: string; chunk: number; have: number[] };
  expect(j1.chunk).toBe(CHUNK);
  expect(j1.have).toEqual([]);

  // one chunk lands
  await putChunk(j1.id, 0, bytes.subarray(0, CHUNK));

  const second = await begin({ kind: "user-audio", sessionId: SID, size: bytes.byteLength, mime: "audio/webm", sha256, cid: "c-idem" });
  const j2 = (await second.json()) as { id: string; have: number[] };
  expect(j2.id).toBe(j1.id); // SAME id for the same bytes
  expect(j2.have).toEqual([0]); // and its current progress
});

test("PUT is idempotent: re-PUT of the same chunk leaves have unchanged and bytes correct", async () => {
  const bytes = randomBytes(CHUNK + 500);
  const sha256 = sha256hex(bytes);
  const b = await begin({ kind: "user-audio", sessionId: SID + "-put", size: bytes.byteLength, mime: "audio/webm", sha256, cid: "c-put" });
  const { id } = (await b.json()) as { id: string };
  const c0 = bytes.subarray(0, CHUNK);
  const r1 = await putChunk(id, 0, c0);
  expect(((await r1.json()) as { have: number[] }).have).toEqual([0]);
  const r2 = await putChunk(id, 0, c0); // again
  expect(((await r2.json()) as { have: number[] }).have).toEqual([0]);
  // the chunk on disk is still the right bytes
  const onDisk = new Uint8Array(await Bun.file(join(transfersDir(), id, "0")).arrayBuffer());
  expect(onDisk).toEqual(c0);
});

test("size cap at begin: an oversize transfer is 413 and nothing is written", async () => {
  const before = await readdir(transfersDir()).catch(() => [] as string[]);
  const sha256 = sha256hex(randomBytes(32));
  const r = await begin({ kind: "upload", sessionId: SID, size: UPLOAD_MAX + 1, mime: "application/octet-stream", sha256, cid: "c-big" });
  expect(r.status).toBe(413);
  const after = await readdir(transfersDir()).catch(() => [] as string[]);
  // no new transfer directory was created for the refused begin
  expect(after.length).toBe(before.length);
});

test("finish hash mismatch: 4xx and the chunks are kept", async () => {
  const bytes = randomBytes(CHUNK + 700);
  const sha256 = sha256hex(bytes); // declare the RIGHT hash
  const b = await begin({ kind: "user-audio", sessionId: SID + "-mm", size: bytes.byteLength, mime: "audio/webm", sha256, cid: "c-mm" });
  const { id } = (await b.json()) as { id: string };
  // PUT a WRONG first chunk, correct second
  const wrong = bytes.subarray(0, CHUNK).slice();
  wrong[0] = wrong[0] ^ 0xff;
  await putChunk(id, 0, wrong);
  await putChunk(id, 1, bytes.subarray(CHUNK));

  const fin = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });
  expect(fin.status).toBe(422);
  expect(((await fin.json()) as { ok: boolean }).ok).toBe(false);
  // the chunks are still there for a re-PUT + re-finish
  const get = await http.get(`/transfer/${id}`);
  expect(((await get.json()) as { have: number[] }).have).toEqual([0, 1]);
});

/* The one thing both fronted routes mint per call is a fresh random id (msgId,
 * uploadId; /upload's `path` embeds the uploadId). Everything else in the reply
 * must be byte-identical, so the comparison swaps ONLY that id for a marker
 * and then compares the raw body bytes. */
function bodyWithIdMasked(raw: string, id: string): Uint8Array {
  return new TextEncoder().encode(raw.split(id).join("<ID>"));
}

test("a finished user-audio transfer produces the same response as a direct /user-audio POST", async () => {
  const bytes = randomBytes(CHUNK * 2 + 4096); // three chunks
  // direct upload of the same bytes
  const direct = await http.fetch("/user-audio?cid=direct-1", {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: bytes as unknown as BodyInit,
  });
  expect(direct.status).toBe(200);
  const dRaw = await direct.text();
  const dj = JSON.parse(dRaw) as { msgId: string };
  expect(typeof dj.msgId).toBe("string");

  // the same bytes, over the transfer contract, then finish
  const id = await upload(bytes, "xfer-1");
  const fin = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });
  // SAME status, SAME content-type, SAME body bytes (minus the minted msgId)
  expect(fin.status).toBe(direct.status);
  expect(fin.headers.get("content-type")).toBe(direct.headers.get("content-type"));
  const fRaw = await fin.text();
  const fj = JSON.parse(fRaw) as { msgId: string };
  expect(typeof fj.msgId).toBe("string");
  expect(fj.msgId).not.toBe(dj.msgId);
  expect(bodyWithIdMasked(fRaw, fj.msgId)).toEqual(bodyWithIdMasked(dRaw, dj.msgId));

  // and the engine-side bytes are hash-equal: the clip stored under each msgId
  // is byte-for-byte the input, so the two uploads deposited identical audio.
  const viaDirect = await audioFromDisk(dj.msgId);
  const viaXfer = await audioFromDisk(fj.msgId);
  expect(viaXfer).not.toBeNull();
  expect(sha256hex(viaXfer!.bytes)).toBe(sha256hex(bytes));
  expect(sha256hex(viaXfer!.bytes)).toBe(sha256hex(viaDirect!.bytes));

  // the reply is the fronted route's own, and says so
  expect(fin.headers.get("x-cyc-fronted")).toBe("1");
  expect(direct.headers.get("x-cyc-fronted")).toBeNull();

  // finish removed the chunks + assembled copy on success; meta.json stays with
  // the cached reply beside it (the sweeper removes both on its 7-day clock)
  const left = (await readdir(join(transfersDir(), id))).sort();
  expect(left).toEqual(["finished.json", "meta.json"]);
});

test("repeat finish returns the cached fronted reply: same msgId, no second clip, x-cyc-fronted set", async () => {
  const bytes = randomBytes(CHUNK + 2222);
  const id = await upload(bytes, "xfer-repeat");
  const dir = join(transfersDir(), id);

  const first = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });
  expect(first.status).toBe(200);
  const fRaw = await first.text();
  const { msgId } = JSON.parse(fRaw) as { msgId: string };
  const clipsAfterFirst = (await readdir(join(process.env.CYC_DATA_DIR!, "staging-audio"))).length;

  // GET reports every chunk present and done, though the chunk files are gone
  const get = await http.get(`/transfer/${id}`);
  expect(await get.json()).toMatchObject({ have: [0, 1], done: true });
  // a late re-PUT is a no-op that reports the full set
  const rePut = await putChunk(id, 0, bytes.subarray(0, CHUNK));
  expect(((await rePut.json()) as { have: number[] }).have).toEqual([0, 1]);
  expect(await Bun.file(join(dir, "0")).exists()).toBe(false);
  // begin for the same bytes + same cid reports the full set too
  const again = await begin({ kind: "user-audio", sessionId: SID, size: bytes.byteLength,
    mime: "audio/webm", sha256: sha256hex(bytes), cid: "xfer-repeat" });
  expect(((await again.json()) as { have: number[] }).have).toEqual([0, 1]);

  // and finish again: byte-identical reply, same msgId, nothing re-uploaded
  const second = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });
  expect(second.status).toBe(200);
  expect(second.headers.get("x-cyc-fronted")).toBe("1");
  expect(second.headers.get("content-type")).toBe(first.headers.get("content-type"));
  expect(await second.text()).toBe(fRaw);
  const clipsAfterSecond = (await readdir(join(process.env.CYC_DATA_DIR!, "staging-audio"))).length;
  expect(clipsAfterSecond).toBe(clipsAfterFirst);
  expect((await audioFromDisk(msgId))?.bytes.byteLength).toBe(bytes.byteLength);
});

test("begin for the same bytes under a NEW cid drops the cached reply and uploads afresh", async () => {
  const bytes = randomBytes(CHUNK + 3333);
  const sha256 = sha256hex(bytes);
  const id = await upload(bytes, "cid-one");
  const first = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });
  const { msgId: m1 } = (await first.json()) as { msgId: string };

  // a second message carrying identical bytes: a fresh transfer for it
  const b = await begin({ kind: "user-audio", sessionId: SID, size: bytes.byteLength,
    mime: "audio/webm", sha256, cid: "cid-two" });
  const j = (await b.json()) as { id: string; have: number[] };
  expect(j.id).toBe(id);
  expect(j.have).toEqual([]);
  expect(await Bun.file(join(transfersDir(), id, "finished.json")).exists()).toBe(false);
  // an early finish is 409 incomplete, not the old cached reply
  const early = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });
  expect(early.status).toBe(409);
  expect(early.headers.get("x-cyc-fronted")).toBeNull();

  await putChunk(id, 0, bytes.subarray(0, CHUNK));
  await putChunk(id, 1, bytes.subarray(CHUNK));
  const second = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });
  expect(second.status).toBe(200);
  const { msgId: m2 } = (await second.json()) as { msgId: string };
  expect(m2).not.toBe(m1);
  expect((await audioFromDisk(m1))).not.toBeNull();
  expect((await audioFromDisk(m2))).not.toBeNull();
});

test("PUT requires the exact chunk length: short middle chunk and long last chunk are 400 and not stored", async () => {
  const bytes = randomBytes(CHUNK + 100); // chunk 0 = CHUNK, chunk 1 = 100
  const sha256 = sha256hex(bytes);
  const b = await begin({ kind: "user-audio", sessionId: SID + "-len", size: bytes.byteLength,
    mime: "audio/webm", sha256, cid: "c-len" });
  const { id } = (await b.json()) as { id: string };

  const short = await putChunk(id, 0, bytes.subarray(0, CHUNK - 1));
  expect(short.status).toBe(400);
  expect(await short.json()).toMatchObject({ want: CHUNK, got: CHUNK - 1 });
  expect(await Bun.file(join(transfersDir(), id, "0")).exists()).toBe(false);

  const long = await putChunk(id, 1, bytes.subarray(CHUNK - 50)); // 150 bytes, want 100
  expect(long.status).toBe(400);
  expect(await long.json()).toMatchObject({ want: 100, got: 150 });
  expect(await Bun.file(join(transfersDir(), id, "1")).exists()).toBe(false);

  // over CHUNK is refused by the body cap before the length check
  const over = await putChunk(id, 0, randomBytes(CHUNK + 1));
  expect(over.status).toBe(413);

  // the right lengths land, and finish succeeds
  expect((await putChunk(id, 0, bytes.subarray(0, CHUNK))).status).toBe(200);
  expect((await putChunk(id, 1, bytes.subarray(CHUNK))).status).toBe(200);
  const fin = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });
  expect(fin.status).toBe(200);
});

test("the transfer route's own 422 (hash mismatch) carries no x-cyc-fronted header", async () => {
  const bytes = randomBytes(300);
  const b = await begin({ kind: "user-audio", sessionId: SID + "-nf", size: bytes.byteLength,
    mime: "audio/webm", sha256: sha256hex(bytes), cid: "c-nf" });
  const { id } = (await b.json()) as { id: string };
  const wrong = bytes.slice();
  wrong[5] ^= 0xff;
  await putChunk(id, 0, wrong);
  const fin = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });
  expect(fin.status).toBe(422);
  expect(fin.headers.get("x-cyc-fronted")).toBeNull();
});

test("a finished upload transfer produces the same response as a direct /upload POST (name + duration carried)", async () => {
  const bytes = randomBytes(CHUNK + 4096); // two chunks
  const name = "note clip.webm";
  const headers = {
    "content-type": "audio/webm",
    "x-filename": encodeURIComponent(name),
    "x-duration-s": "42",
  };
  const direct = await http.fetch("/upload", { method: "POST", headers, body: bytes as unknown as BodyInit });
  expect(direct.status).toBe(200);
  const dRaw = await direct.text();
  const dj = JSON.parse(dRaw) as { uploadId: string; path: string; durationS?: number; name: string };
  expect(dj.durationS).toBe(42);

  // the same bytes over the transfer contract: begin carries name + durationS
  const sha256 = sha256hex(bytes);
  const b = await begin({ kind: "upload", sessionId: SID + "-up", size: bytes.byteLength,
    mime: "audio/webm", name, sha256, durationS: 42 });
  expect(b.status).toBe(200);
  const { id } = (await b.json()) as { id: string };
  await putChunk(id, 0, bytes.subarray(0, CHUNK));
  await putChunk(id, 1, bytes.subarray(CHUNK));
  const fin = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });

  expect(fin.status).toBe(direct.status);
  expect(fin.headers.get("content-type")).toBe(direct.headers.get("content-type"));
  const fRaw = await fin.text();
  const fj = JSON.parse(fRaw) as { uploadId: string; path: string; durationS?: number; name: string };
  expect(fj.uploadId).not.toBe(dj.uploadId);
  expect(bodyWithIdMasked(fRaw, fj.uploadId)).toEqual(bodyWithIdMasked(dRaw, dj.uploadId));
  expect(fj.durationS).toBe(42);
  expect(fj.name).toBe(dj.name);

  // engine-side bytes hash-equal for both stored files
  const viaDirect = new Uint8Array(await Bun.file(dj.path).arrayBuffer());
  const viaXfer = new Uint8Array(await Bun.file(fj.path).arrayBuffer());
  expect(sha256hex(viaXfer)).toBe(sha256);
  expect(sha256hex(viaDirect)).toBe(sha256);
  expect(fin.headers.get("x-cyc-fronted")).toBe("1");
  // chunks + assembled copy gone; meta.json + finished.json kept for a repeat finish
  expect((await readdir(join(transfersDir(), id))).sort()).toEqual(["finished.json", "meta.json"]);
});

test("begin ignores a garbage durationS and finish sends no x-duration-s for it", async () => {
  const bytes = randomBytes(100);
  const sha256 = sha256hex(bytes);
  const b = await begin({ kind: "upload", sessionId: SID + "-nodur", size: bytes.byteLength,
    mime: "application/octet-stream", name: "blob.bin", sha256, durationS: -3 });
  const { id } = (await b.json()) as { id: string };
  await putChunk(id, 0, bytes);
  const fin = await http.fetch(`/transfer/${id}/finish`, { method: "POST" });
  expect(fin.status).toBe(200);
  const fj = (await fin.json()) as { durationS?: number };
  expect(fj.durationS).toBeUndefined();
});

test("GET reports done and DELETE removes the transfer", async () => {
  const bytes = randomBytes(CHUNK + 10);
  const sha256 = sha256hex(bytes);
  const b = await begin({ kind: "user-audio", sessionId: SID + "-del", size: bytes.byteLength, mime: "audio/webm", sha256, cid: "c-del" });
  const { id } = (await b.json()) as { id: string };
  await putChunk(id, 0, bytes.subarray(0, CHUNK));
  let get = await http.get(`/transfer/${id}`);
  expect(((await get.json()) as { done: boolean }).done).toBe(false);
  await putChunk(id, 1, bytes.subarray(CHUNK));
  get = await http.get(`/transfer/${id}`);
  expect(((await get.json()) as { done: boolean }).done).toBe(true);

  const del = await http.fetch(`/transfer/${id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  const gone = await http.get(`/transfer/${id}`);
  expect(gone.status).toBe(404);
});

test("the sweeper removes chunk dirs older than 7 days and keeps fresh ones", async () => {
  const stale = randomBytes(CHUNK + 1);
  const staleId = await upload(stale, "c-stale");
  // backdate this transfer past the TTL by rewriting its meta.createdAt
  const mp = join(transfersDir(), staleId, "meta.json");
  const meta = await Bun.file(mp).json();
  meta.createdAt = Date.now() - TRANSFER_TTL_MS - 60_000;
  await writePrivate(mp, JSON.stringify(meta));

  const fresh = randomBytes(CHUNK + 2);
  const freshId = await upload(fresh, "c-fresh");

  const removed = await sweepTransfers(Date.now());
  expect(removed).toBeGreaterThanOrEqual(1);
  expect(await Bun.file(join(transfersDir(), staleId, "meta.json")).exists()).toBe(false);
  expect(await Bun.file(join(transfersDir(), freshId, "meta.json")).exists()).toBe(true);
});
