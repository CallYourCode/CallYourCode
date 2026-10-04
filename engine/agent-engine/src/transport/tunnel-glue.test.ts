/* TUNNEL GLUE, hermetic: the streaming halves of
 * tunnel-glue.ts against a fake sock and a fake router -- no engine boot, no
 * sockets, per the testing doctrine. The pure codec is pinned in
 * tunnel.test.ts; the full sealed-wire path is e2e/tunnel-wire.test.ts.
 *
 * What this file proves:
 *  - the buffered req/res path emits the SAME wire it always did (reply now
 *    streams internally, but a buffered body's frames are byte-identical);
 *  - a STREAM_REQ_PATHS request spools to a temp file, reaches the router as
 *    a file-backed body past REASSEMBLE_MAX, and the spool is always deleted;
 *  - a streamed Response body goes out chunk by chunk, no buffering;
 *  - {t:"req-abort"} kills a half-spooled request (file deleted, later chunks
 *    swallowed, router never called) and stops an in-flight streamed reply;
 *  - closeTunnelClient deletes whatever a dying socket left half-spooled.
 *
 *   bun test agent-engine/src/transport/tunnel-glue.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { initTunnel, onReq, onReqAbort, closeTunnelClient, STREAM_REQ_PATHS } from "./tunnel-glue.ts";
import { CHUNK, REASSEMBLE_MAX, encodeReq, encodeRes, ReqStreamEncoder, ResReassembler,
  type ReqFrame, type ResFrame } from "./tunnel.ts";
import { MSG_MAX } from "./dcpipe.ts";
import { RPC_REPLY_MAX_BYTES } from "../plugins/platform/spec.ts";
import { tunnelTmpDir } from "../storage/datadir.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import type { Sock } from "./sock.ts";

const oldEnv = process.env.CYC_DATA_DIR;
let routeRequest: (req: Request) => Promise<Response> = async () => new Response("no route wired", { status: 599 });

/* OFF THE WALL CLOCK (gate 2 bans Bun.sleep outright). These are the two
 * real-async yields this hermetic file needs: file spooling and stream reads
 * complete on the event loop, not on logical time, so a fake clock cannot
 * stand in. A macrotask yield lets those settle; a setTimeout under the gate's
 * real-sleep floor is a yield, not a sleep, and that is exactly what the gate
 * permits. yieldTurn is the drain/poll turn; settle gives a stray async a beat
 * to (not) happen when a test asserts an ABSENCE (router never ran, flow
 * stopped) with nothing positive to poll toward. */
const yieldTurn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

beforeAll(async () => {
  process.env.CYC_DATA_DIR = await tmpDir("cyc-tunnel-glue-");
  initTunnel({
    routeRequest: (req) => routeRequest(req),
    server: {} as import("bun").Server,
    log: () => {},
  });
});
afterAll(() => {
  if (oldEnv === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = oldEnv;
});

function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 251;
  return b;
}

/** A sealed-looking sock: glue only touches data.sec / data.pipeDrain, and
 * wire.send only calls ws.send(JSON string). pipeDrain yields a REAL event
 * loop turn (like the dcpipe drain it stands in for): a reply streaming an
 * endless body must not starve the test's own timers. */
function fakeSock() {
  const out: (ResFrame & Record<string, unknown>)[] = [];
  const ws = {
    data: { sec: {}, cid: 1, terms: new Map(), pipeDrain: () => yieldTurn() },
    send: (s: string) => {
      out.push(JSON.parse(s));
    },
  } as unknown as Sock;
  return { ws, out };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition never held");
    await yieldTurn();
  }
}

/** Poll until the spool dir is empty (its deletes are fire-and-forget). */
async function untilSpoolEmpty(ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while ((await spoolFiles()).length > 0) {
    if (Date.now() > end) throw new Error("spool never emptied");
    await yieldTurn();
  }
}

function resFor(out: ResFrame[], id: string): ResFrame[] {
  return out.filter((f) => f.t === "res" && f.id === id);
}
function replied(out: ResFrame[], id: string): boolean {
  return resFor(out, id).some((f) => f.more !== true);
}
function reassemble(out: ResFrame[], id: string) {
  const rx = new ResReassembler();
  let done: ReturnType<ResReassembler["push"]> = null;
  for (const f of resFor(out, id)) {
    const r = rx.push(f);
    if (r) done = r;
  }
  return done!;
}

async function spoolFiles(): Promise<string[]> {
  return readdir(tunnelTmpDir()).catch(() => [] as string[]);
}

test("the buffered path still answers with byte-identical frames (reply streams internally now)", async () => {
  const body = bytes(CHUNK + 50);
  routeRequest = async (req) => {
    const got = new Uint8Array(await req.arrayBuffer());
    return new Response(got, { status: 200, headers: { "content-type": "application/octet-stream" } });
  };
  const { ws, out } = fakeSock();
  for (const f of encodeReq("buf1", "POST", "/echo", { "content-type": "application/octet-stream" }, body)) {
    await onReq(ws, f);
  }
  await until(() => replied(out, "buf1"));
  const done = reassemble(out, "buf1");
  expect(done.status).toBe(200);
  expect(Array.from(done.body)).toEqual(Array.from(body));
  // BYTE-IDENTICAL to the old arrayBuffer()-then-encodeRes wire: harvest the
  // headers the way reply() does (from an identical Response) and compare.
  const headers: Record<string, string> = {};
  new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } })
    .headers.forEach((v, k) => { headers[k] = v; });
  const expected = encodeRes("buf1", 200, headers, body).map((f) => JSON.stringify(f));
  expect(resFor(out, "buf1").map((f) => JSON.stringify(f))).toEqual(expected);
});

test("a live stream flushes each read to the app instead of holding sub-CHUNK bytes until close", async () => {
  /* The streaming-TTS regression (#531/#543): a growing clip is served as a
   * held-open stream, but the encoder held bytes under CHUNK (256 KB, i.e. a
   * whole spoken reply) until the body closed, so the reply reached the app
   * only when finalize closed the stream and played only when done. The
   * x-cyc-stream marker makes reply() flush what push() held after each read. */
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const streamBody = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
  routeRequest = async () => new Response(streamBody, {
    status: 200,
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-cyc-stream": "live" },
  });
  const { ws, out } = fakeSock();
  for (const f of encodeReq("live1", "GET", "/audio/x.mp3", { range: "bytes=0-" }, null)) {
    await onReq(ws, f);
  }
  // a first sub-CHUNK read lands: the app SEES it before the stream is closed
  const firstRead = bytes(1000);
  ctrl.enqueue(firstRead);
  await until(() => resFor(out, "live1").some((f) => f.b !== undefined));
  expect(replied(out, "live1"),
    "the answer closed already; a live stream must stay open between reads").toBe(false);
  expect(resFor(out, "live1").some((f) => f.more === true),
    "the early frame was not marked as a continuation").toBe(true);
  // it grows, then closes: the whole body reassembles and the control header
  // was stripped rather than handed to the app as part of the answer
  const secondRead = bytes(1500);
  ctrl.enqueue(secondRead);
  ctrl.close();
  await until(() => replied(out, "live1"));
  const done = reassemble(out, "live1");
  expect(done.status).toBe(200);
  expect(done.body.length).toBe(firstRead.length + secondRead.length);
  expect(Object.keys(done.headers).map((k) => k.toLowerCase()),
    "the x-cyc-stream control header leaked into the answer").not.toContain("x-cyc-stream");
});

test("a /upload request STREAMS to a spool file, reaches the router file-backed, and the spool is deleted", async () => {
  const N = CHUNK * 2 + 123;
  const body = bytes(N);
  let seen: { size: number; first: number; last: number; declared: string | null } | null = null;
  routeRequest = async (req) => {
    const got = new Uint8Array(await req.arrayBuffer());
    seen = { size: got.length, first: got[0], last: got[got.length - 1],
      declared: req.headers.get("content-length") };
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { ws, out } = fakeSock();
  const enc = new ReqStreamEncoder("up1", "POST", "/upload?x=1", { "x-filename": "a.bin" });
  for (let off = 0; off < N; off += CHUNK) {
    for (const f of enc.push(body.subarray(off, Math.min(off + CHUNK, N)))) await onReq(ws, f);
  }
  for (const f of enc.end()) await onReq(ws, f);
  await until(() => replied(out, "up1"));
  expect(reassemble(out, "up1").status).toBe(200);
  expect(seen).not.toBeNull();
  expect(seen!.size).toBe(N);
  expect(seen!.first).toBe(body[0]);
  expect(seen!.last).toBe(body[N - 1]);
  // the glue stamps the SPOOLED size, whatever the client declared
  expect(seen!.declared).toBe(String(N));
  expect(await spoolFiles()).toEqual([]); // cleaned on success
});

test("a continuation frame racing the spool open is held, not misrouted (openStream registration race)", async () => {
  /* THE DUPLICATE-PASTE UPLOAD BUG. Production does NOT serialise frame dispatch:
   * rtc-glue feeds every sealed frame with `void dispatchClientFrame`, so a
   * multi-frame /upload's continuation chunk can reach onReq while the FIRST
   * frame's openStream is still awaiting mkdirPrivate + open. If the stream is
   * not registered until after those awaits, the continuation (no meta) falls
   * through to the buffered reassembler, throws no-meta, and the id is answered
   * 413 -- the upload fails. The two same-named screenshots the user pasted just
   * made the overlap likely; the name never mattered.
   *
   * Every other test here awaits each onReq in turn, which hides the race (the
   * open always finishes first). This one dispatches the frames WITHOUT awaiting
   * between them, exactly as the void dispatch does. */
  const N = CHUNK + 5000; // two frames: meta + full CHUNK (more:true), then a tail (more:false)
  const body = bytes(N);
  let seen: { size: number; first: number; last: number } | null = null;
  routeRequest = async (req) => {
    const got = new Uint8Array(await req.arrayBuffer());
    seen = { size: got.length, first: got[0], last: got[got.length - 1] };
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { ws, out } = fakeSock();
  const enc = new ReqStreamEncoder("race1", "POST", "/upload", { "x-filename": "image.png" });
  const frames: ReqFrame[] = [];
  for (let off = 0; off < N; off += CHUNK) frames.push(...enc.push(body.subarray(off, Math.min(off + CHUNK, N))));
  frames.push(...enc.end());
  expect(frames.length).toBeGreaterThan(1); // there IS a continuation to race
  // fire them all without awaiting between: the continuation reaches onReq while
  // the first frame's openStream is still opening the spool file
  await Promise.all(frames.map((f) => onReq(ws, f)));
  await until(() => replied(out, "race1"));
  const done = reassemble(out, "race1");
  expect(done.status).toBe(200); // was 413 before the fix (no-meta misroute)
  expect(seen).not.toBeNull();
  expect(seen!.size).toBe(N); // the whole body reached the route, nothing dropped
  expect(seen!.first).toBe(body[0]);
  expect(seen!.last).toBe(body[N - 1]);
  await untilSpoolEmpty();
  expect(await spoolFiles()).toEqual([]);
});

test("a streamed request rides PAST the in-memory reassembly cap (the old /user-audio exemption is dead)", async () => {
  expect(STREAM_REQ_PATHS.has("/user-audio")).toBe(true);
  expect(STREAM_REQ_PATHS.has("/upload")).toBe(true);
  const N = REASSEMBLE_MAX + CHUNK; // would throw 1009 in the buffered path
  let got = 0;
  routeRequest = async (req) => {
    // stream-count the body rather than buffering 33MB into the test
    const reader = req.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value?.length ?? 0;
    }
    return new Response("ok", { status: 200 });
  };
  const { ws, out } = fakeSock();
  const enc = new ReqStreamEncoder("big1", "POST", "/user-audio?cid=c1", {});
  const piece = bytes(CHUNK);
  for (let off = 0; off < N; off += CHUNK) {
    // same deterministic piece re-pushed: contents do not matter here, size does
    for (const f of enc.push(piece.subarray(0, Math.min(CHUNK, N - off)))) await onReq(ws, f);
  }
  for (const f of enc.end()) await onReq(ws, f);
  await until(() => replied(out, "big1"), 30_000);
  expect(reassemble(out, "big1").status).toBe(200);
  expect(got).toBe(N);
  expect(await spoolFiles()).toEqual([]);
}, 60_000);

test("a streamed Response goes out chunk by chunk: meta first, growing body, clean final frame", async () => {
  /* CHUNK-sized enqueues: the encoder aggregates to CHUNK parts, so smaller
   * pieces would coalesce; what matters is that the frames go out WHILE the
   * stream is still open (no arrayBuffer(), no 32MB ceiling). */
  const parts = [bytes(CHUNK), bytes(CHUNK), bytes(3000)];
  routeRequest = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(c) {
          for (const p of parts) {
            c.enqueue(p);
            await yieldTurn(); // separate reads: forces the streaming shape
          }
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "audio/mpeg" } },
    );
  const { ws, out } = fakeSock();
  for (const f of encodeReq("st1", "GET", "/audio/x.mp3", {}, null)) await onReq(ws, f);
  await until(() => replied(out, "st1"));
  const frames = resFor(out, "st1");
  expect(frames.length).toBe(3); // one-push lookahead: 3 reads -> 3 frames
  expect(frames[0].s).toBe(200);
  expect(frames[0].h?.["content-type"]).toBe("audio/mpeg");
  expect(frames.map((f) => f.more === true)).toEqual([true, true, false]);
  const done = reassemble(out, "st1");
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  expect(Array.from(done.body)).toEqual(Array.from(all));
});

/* ---- THE RPC REPLY CAP RIDES THE SEALED TUNNEL (contracts FINDINGS #5) -----
 *
 * spec.ts once warned that a plugin rpc reply NEAR RPC_REPLY_MAX_BYTES (16 MB)
 * plus its JSON envelope "will not fit one sealed frame" (dcpipe MSG_MAX is
 * also 16 MB). That fear assumed the reply rides ONE frame. It does not: the
 * glue's reply() streams every Response body through ResStreamEncoder, which
 * carves it into CHUNK (256 KB) parts, one sealed frame each, so no frame ever
 * approaches MSG_MAX no matter how large the reply. These two tests pin that
 * with rpc-shaped answers, the exact Response routes/plugin.ts produces:
 * a JSON body under content-type application/json. */

/** An rpc wire string of exactly `total` bytes, shaped like routes/plugin.ts
 * line 206 builds it: {"ok":true,"result":"xxx..."} in pure ASCII, so string
 * length equals byte length. */
function rpcWire(total: number): string {
  const shell = '{"ok":true,"result":""}';
  return `{"ok":true,"result":"${"x".repeat(total - shell.length)}"}`;
}

/** Drive one rpc-shaped reply of `wire` through the glue and return the frames
 * it emitted for `id`, having proven the reassembled answer is intact. */
async function rpcRoundTrip(id: string, wire: string): Promise<ResFrame[]> {
  routeRequest = async () =>
    new Response(wire, { headers: { "content-type": "application/json" } });
  const { ws, out } = fakeSock();
  for (const f of encodeReq(id, "POST", "/plugin/files/rpc/read", { "content-type": "application/json" }, new TextEncoder().encode('{"args":{}}'))) {
    await onReq(ws, f);
  }
  await until(() => replied(out, id), 60_000);
  const done = reassemble(out, id);
  expect(done.status).toBe(200);
  expect(done.body.length).toBe(wire.length);
  const text = new TextDecoder().decode(done.body);
  expect(text.slice(0, 21)).toBe('{"ok":true,"result":"');
  expect(text.slice(-2)).toBe('"}');
  expect((JSON.parse(text) as { ok: boolean }).ok).toBe(true);
  return resFor(out, id);
}

test("an rpc reply of a few MB transits the sealed glue chunked and intact", async () => {
  const frames = await rpcRoundTrip("rpc-mid", rpcWire(4 * 1024 * 1024));
  expect(frames.length).toBe(Math.ceil((4 * 1024 * 1024) / CHUNK)); // 16 frames, not one
}, 60_000);

test("an rpc reply AT RPC_REPLY_MAX_BYTES transits: many small frames, none anywhere near dcpipe MSG_MAX", async () => {
  // The largest reply the 413 gate lets through: byteLen(wire) == the cap.
  const wire = rpcWire(RPC_REPLY_MAX_BYTES);
  expect(wire.length).toBe(RPC_REPLY_MAX_BYTES);
  const frames = await rpcRoundTrip("rpc-cap", wire);
  expect(frames.length).toBe(Math.ceil(RPC_REPLY_MAX_BYTES / CHUNK)); // 64 chunk frames
  // Each frame's serialized form IS the string dcpipe fragments and the far
  // side reassembles under MSG_MAX. All ASCII (base64 + envelope), so length
  // is bytes. The bound that matters is MSG_MAX; the tight bound shows the
  // headroom is ~46x, not luck: 256 KB of body base64s to ~350 KB.
  let biggest = 0;
  for (const f of frames) biggest = Math.max(biggest, JSON.stringify(f).length);
  expect(biggest).toBeLessThan(MSG_MAX);
  expect(biggest).toBeLessThan(2 * CHUNK);
}, 120_000);

test("req-abort mid-spool: file deleted, later chunks swallowed, the router never runs", async () => {
  let routed = 0;
  routeRequest = async () => {
    routed++;
    return new Response("ok");
  };
  const { ws, out } = fakeSock();
  const enc = new ReqStreamEncoder("ab1", "POST", "/upload", {});
  // two pushes so the first CHUNK is flushed with more:true
  const frames: ReqFrame[] = [...enc.push(bytes(CHUNK)), ...enc.push(bytes(10))];
  for (const f of frames) await onReq(ws, f);
  expect((await spoolFiles()).length).toBe(1); // mid-spool: the file exists
  await onReqAbort(ws, { t: "req-abort", id: "ab1" });
  expect(await spoolFiles()).toEqual([]); // deleted on abort
  for (const f of enc.end()) await onReq(ws, f); // the tail still arrives
  await settle();
  expect(routed).toBe(0); // swallowed, never dispatched
  expect(resFor(out, "ab1")).toEqual([]); // and no answer invented
});

test("req-abort stops an in-flight streamed reply and cancels its body stream", async () => {
  let cancelled = false;
  routeRequest = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(bytes(1000)); // grows forever until cancelled
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
  const { ws, out } = fakeSock();
  for (const f of encodeReq("ab2", "GET", "/audio/grow.mp3", {}, null)) await onReq(ws, f);
  await until(() => resFor(out, "ab2").length >= 5);
  await onReqAbort(ws, { t: "req-abort", id: "ab2" });
  await until(() => cancelled);
  const len = resFor(out, "ab2").length;
  await settle();
  expect(resFor(out, "ab2").length).toBe(len); // the flow stopped
  expect(replied(out, "ab2")).toBe(false); // stopped, not "finished"
});

test("closeTunnelClient deletes what a dying socket left half-spooled", async () => {
  const { ws } = fakeSock();
  const enc = new ReqStreamEncoder("dead1", "POST", "/user-audio", {});
  for (const f of [...enc.push(bytes(CHUNK)), ...enc.push(bytes(5))]) await onReq(ws, f);
  expect((await spoolFiles()).length).toBe(1);
  closeTunnelClient(ws);
  await untilSpoolEmpty();
  expect(await spoolFiles()).toEqual([]);
});

test("initTunnel sweeps spool files a previous run left behind", async () => {
  await mkdir(tunnelTmpDir(), { recursive: true });
  const stray = join(tunnelTmpDir(), "req-leftover");
  await writeFile(stray, "orphan");
  initTunnel({ routeRequest: (req) => routeRequest(req), server: {} as import("bun").Server, log: () => {} });
  await untilSpoolEmpty();
  expect(await spoolFiles()).toEqual([]);
});

test("CYC_CHAOS_DROP_AFTER_BYTES closes the pipe mid-transfer and stops the request", async () => {
  // A sock whose close() is observable; body bytes arrive as separate frames.
  const closes: { code?: number; reason?: string }[] = [];
  const ws = {
    data: { sec: {}, cid: 9, terms: new Map(), pipeDrain: () => yieldTurn() },
    send: () => {},
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
  } as unknown as Sock;

  let routed = 0;
  const prev = routeRequest;
  routeRequest = async () => { routed++; return new Response("ok", { status: 200 }); };
  const oldChaos = process.env.CYC_CHAOS_DROP_AFTER_BYTES;
  process.env.CYC_CHAOS_DROP_AFTER_BYTES = String(CHUNK + 1);
  try {
    // three body chunks under one buffered id: the second pushes cumulative
    // bytes past the threshold, so the pipe is closed before the request ever
    // reassembles or reaches the router.
    const frames = encodeReq("chaos1", "POST", "/echo", { "content-type": "application/octet-stream" }, bytes(CHUNK * 3));
    for (const f of frames) await onReq(ws, f);
    await settle();
    expect(closes.length).toBe(1);
    expect(closes[0].code).toBe(4009);
    expect(routed).toBe(0); // the request never completed, so the app must resume it
  } finally {
    if (oldChaos === undefined) delete process.env.CYC_CHAOS_DROP_AFTER_BYTES;
    else process.env.CYC_CHAOS_DROP_AFTER_BYTES = oldChaos;
    routeRequest = prev;
  }
});

test("CYC_CHAOS_DROP_AFTER_BYTES unset (or 0) is inert: a whole request goes through", async () => {
  const { ws, out } = fakeSock();
  let routed = 0;
  const prev = routeRequest;
  routeRequest = async () => { routed++; return new Response("ok", { status: 200 }); };
  delete process.env.CYC_CHAOS_DROP_AFTER_BYTES;
  try {
    for (const f of encodeReq("calm1", "POST", "/echo", {}, bytes(CHUNK * 3))) await onReq(ws, f);
    await until(() => replied(out, "calm1"));
    expect(routed).toBe(1);
  } finally {
    routeRequest = prev;
  }
});
