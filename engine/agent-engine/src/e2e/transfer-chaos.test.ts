/* THE RESUMABLE TRANSFER UNDER A FLAPPING PIPE, OVER A REAL BOOTED ENGINE
 * (Lane A, the incident's failure mode). A 4 MiB voice note goes to the real
 * engine through the sealed tunnel while CYC_CHAOS_DROP_AFTER_BYTES=614400
 * kills the DataChannel every ~2.3 chunks. The client does what the app's
 * transfer worker does: reconnect, ask the engine what it has, send only the
 * missing chunks, finish once. What must hold at the end:
 *
 *   - the clip on the engine's disk is hash-equal to the bytes that went in;
 *   - exactly ONE msgId was minted (one transfer.finish.ok, one clip file);
 *   - the chaos really fired (at least one tunnel.chaos-drop, so a reconnect
 *     really happened and a chunk in flight really was lost).
 *
 * Only a booted engine can prove this: the drop is the real tunnel-glue closing
 * the real RtcSock, the resume is the real transfer route reading its own chunk
 * dir, and finish hands the assembled file to the real /user-audio. One test,
 * not a suite (testing doctrine: engine-boot E2E stays in the low single
 * digits); the rest of Lane A is pinned by routes/transfer.test.ts and the
 * app's worker unit tests.
 *
 *   bun test --preload ./src/e2e/testpreload.ts src/e2e/transfer-chaos.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { startEngine, openSealedClient, hasE2ETransport, type Engine } from "./harness.ts";
import { encodeReq, ResReassembler, CHUNK, type ResFrame } from "../transport/tunnel.ts";

const sealedTest = test.skipIf(!hasE2ETransport);

let engine: Engine | null = null;
afterEach(async () => {
  await engine?.stop();
  engine = null;
});

/** The pipe died under a request: the chunk in flight is lost and the caller
 *  must reconnect and resume. */
class PipeClosed extends Error {
  constructor(public code: number) {
    super(`sealed pipe closed (${code})`);
  }
}

type Client = { ws: WebSocket; frames: Record<string, any>[]; closed: () => number | null };

/** A sealed client that also remembers WHEN the engine hung up on it. */
async function connect(e: Engine): Promise<Client> {
  const { ws, frames } = await openSealedClient(e);
  let code: number | null = null;
  ws.onclose = (ev: any) => { code = typeof ev?.code === "number" ? ev.code : 0; };
  return { ws, frames, closed: () => code };
}

type TunnelResult = { status: number; body: Uint8Array };

/* One request over the sealed shim; throws PipeClosed the moment the socket
 * closes under it instead of waiting out the deadline. */
async function tunnelFetch(
  c: Client,
  req: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array },
  ms = 15_000,
): Promise<TunnelResult> {
  if (c.closed() !== null) throw new PipeClosed(c.closed()!);
  const id = "t-" + crypto.randomUUID();
  const rx = new ResReassembler();
  let next = c.frames.length;
  for (const f of encodeReq(id, req.method, req.path, req.headers ?? {}, req.body ?? null)) {
    c.ws.send(JSON.stringify(f));
  }
  const end = Date.now() + ms;
  for (;;) {
    while (next < c.frames.length) {
      const m = c.frames[next++];
      if (m?.t === "res" && m.id === id) {
        const done = rx.push(m as ResFrame);
        if (done) return { status: done.status, body: done.body };
      }
    }
    if (c.closed() !== null) throw new PipeClosed(c.closed()!);
    if (Date.now() > end) throw new Error(`tunnel answer never completed for ${req.method} ${req.path}`);
    await Bun.sleep(10);
  }
}

function sha256hex(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
}

function jsonOf<T>(r: TunnelResult): T {
  return JSON.parse(new TextDecoder().decode(r.body)) as T;
}

sealedTest("a 4 MiB voice note survives chaos drops mid-transfer: hash-equal bytes on the engine, exactly one msgId", async () => {
  engine = await startEngine({ env: { CYC_CHAOS_DROP_AFTER_BYTES: "614400" } });
  const e = engine;

  const N = 4 * 1024 * 1024;
  const payload = new Uint8Array(N);
  for (let i = 0; i < N; i++) payload[i] = (i * 7 + 13) % 251;
  const sha256 = sha256hex(payload);
  const count = Math.ceil(N / CHUNK);
  const chunkOf = (n: number) => payload.subarray(n * CHUNK, Math.min((n + 1) * CHUNK, N));
  const beginBody = new TextEncoder().encode(JSON.stringify({
    kind: "user-audio", sessionId: "e2e-chaos|pane1", size: N, mime: "audio/webm", sha256, cid: "chaos-1",
  }));

  /* The worker's loop, in miniature: (re)connect, begin (idempotent; returns
   * `have`), PUT every missing chunk, finish. Any PipeClosed sends it back to
   * the top; nothing else is caught, so a real refusal fails the test. */
  let c = await connect(e);
  let id = "";
  let have = new Set<number>();
  let reconnects = 0;
  let finishCalls = 0;
  let result: { msgId: string } | null = null;
  const deadline = Date.now() + 50_000;
  while (!result) {
    if (Date.now() > deadline) throw new Error(`transfer did not finish in time; have ${have.size}/${count}`);
    try {
      if (c.closed() !== null) {
        reconnects++;
        c = await connect(e);
      }
      const b = await tunnelFetch(c, { method: "POST", path: "/transfer/begin",
        headers: { "content-type": "application/json" }, body: beginBody });
      expect(b.status, "begin refused").toBe(200);
      const bj = jsonOf<{ id: string; chunk: number; have: number[] }>(b);
      expect(bj.chunk).toBe(CHUNK);
      if (id) expect(bj.id, "begin must be idempotent on sessionId+sha256").toBe(id);
      id = bj.id;
      have = new Set(bj.have);
      for (let n = 0; n < count; n++) {
        if (have.has(n)) continue;
        const r = await tunnelFetch(c, { method: "PUT", path: `/transfer/${id}/${n}`,
          headers: { "content-type": "application/octet-stream" }, body: chunkOf(n) });
        expect(r.status, `PUT chunk ${n} refused`).toBe(200);
        have = new Set(jsonOf<{ have: number[] }>(r).have);
      }
      finishCalls++;
      const f = await tunnelFetch(c, { method: "POST", path: `/transfer/${id}/finish` });
      expect(f.status, "finish refused").toBe(200);
      result = jsonOf<{ msgId: string }>(f);
    } catch (err) {
      if (!(err instanceof PipeClosed)) throw err;
      // the incident: the pipe died under a chunk; go round and resume
    }
  }
  try { c.ws.close(); } catch { /* already gone */ }

  // The chaos really fired, and the transfer really resumed across it.
  const drops = e.lines.filter((l) => l.includes("tunnel.chaos-drop")).length;
  expect(drops, "CYC_CHAOS_DROP_AFTER_BYTES never fired; nothing was resumed").toBeGreaterThan(0);
  expect(reconnects, "no reconnect happened").toBeGreaterThan(0);

  // Exactly one msgId: finish ran once, the engine finished once, one clip landed.
  expect(finishCalls).toBe(1);
  expect(typeof result!.msgId).toBe("string");
  expect(e.lines.filter((l) => l.includes("transfer.finish.ok")).length).toBe(1);
  expect(e.lines.filter((l) => l.includes("user-audio.stored")).length).toBe(1);

  // Hash-equal bytes on the engine's own disk (its data dir is <dir>/data; the
  // clip is written under the msgId, whatever the owner-or-staging dir is).
  const glob = new Bun.Glob(`**/${result!.msgId}.*`);
  const files: string[] = [];
  for await (const p of glob.scan({ cwd: join(e.dir, "data"), dot: true })) files.push(p);
  expect(files, "one clip file for the one msgId").toHaveLength(1);
  const onDisk = new Uint8Array(await Bun.file(join(e.dir, "data", files[0])).arrayBuffer());
  expect(onDisk.byteLength).toBe(N);
  expect(sha256hex(onDisk)).toBe(sha256);

  // and the chunk dir is spent: only meta.json + the cached reply remain
  const left = (await readdir(join(e.dir, "data", "transfers", id))).sort();
  expect(left).toEqual(["finished.json", "meta.json"]);
}, 60_000);
