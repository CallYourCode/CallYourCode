/* tunnel.ts codec vectors + drift (the sibling of dcpipe.test.ts).
 *
 * The vectors are computed from FIXED inputs and frozen into the single shared
 * copy engine/shared/fixtures/tunnel-vectors.json. tunnel.ts is one shared
 * module (engine/shared/tunnel.ts) imported by both the engine and the app
 * bundle, and the app test asserts the SAME fixture, so a change to the req/res
 * chunking on either side fails a test instead of silently framing a request
 * the other end cannot reassemble. sha256 over the concatenated frame JSON pins every byte;
 * the shapes are kept for readability.
 *
 * This is the pure codec ONLY: the wiring (engine onReq -> routeRequest, app
 * engineCapFetch -> tunnel) is repo-specific and tested at its own seam.
 */

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  CHUNK,
  REASSEMBLE_MAX,
  TunnelError,
  encodeReq,
  encodeReqAbort,
  encodeRes,
  decodeChunk,
  ReqReassembler,
  ReqStreamEncoder,
  ResReassembler,
  ResStreamEncoder,
  type ReqFrame,
  type ResFrame,
} from "./tunnel";

const FIXTURE = new URL("../../../shared/fixtures/tunnel-vectors.json", import.meta.url).pathname;

/* Deterministic bodies as recipes so the file stays small for the big ones. The
 * set straddles the CHUNK boundary in both directions. Byte i = i % 251 (a prime
 * < 256, so the pattern never aligns to the 256 KB chunk edge). */
function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  return b;
}
type Recipe = { name: string; make: () => Uint8Array | null };
const BODIES: Recipe[] = [
  { name: "empty", make: () => null },
  { name: "tiny", make: () => bytes(5) },
  { name: "json-ish", make: () => new TextEncoder().encode(JSON.stringify({ ok: true, n: 3 })) },
  { name: "exactly-chunk", make: () => bytes(CHUNK) },
  { name: "one-over", make: () => bytes(CHUNK + 1) },
  { name: "two-and-a-bit", make: () => bytes(CHUNK * 2 + 100) },
];

const HDRS = { "content-type": "application/json", "x-cyc-cap": "CAP" };

async function sha256Hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

function wireOf(frames: (ReqFrame | ResFrame)[]): string {
  return frames.map((f) => JSON.stringify(f)).join("\n");
}

type Vec = { frames: number; more: boolean[]; blens: number[]; sha256: string };

async function vecOf(frames: (ReqFrame | ResFrame)[]): Promise<Vec> {
  return {
    frames: frames.length,
    more: frames.map((f) => f.more === true),
    blens: frames.map((f) => (f.b ? f.b.length : 0)),
    sha256: await sha256Hex(wireOf(frames)),
  };
}

/* Streaming: the same bodies drip-fed through the stream encoders in
 * CHUNK-misaligned pieces, so the streamed wire is pinned too. DRIP does not
 * divide CHUNK and CHUNK does not divide DRIP, so no push lands on a frame
 * boundary by accident. */
const DRIP = 100_000;

function dripReq(body: Uint8Array | null): ReqFrame[] {
  const enc = new ReqStreamEncoder("ID", "POST", "/upload?x=1", HDRS);
  const b = body ?? new Uint8Array(0);
  const out: ReqFrame[] = [];
  for (let off = 0; off < b.length; off += DRIP) out.push(...enc.push(b.subarray(off, off + DRIP)));
  out.push(...enc.end());
  return out;
}

function dripRes(body: Uint8Array | null): ResFrame[] {
  const enc = new ResStreamEncoder("ID", 200, HDRS);
  const b = body ?? new Uint8Array(0);
  const out: ResFrame[] = [];
  for (let off = 0; off < b.length; off += DRIP) out.push(...enc.push(b.subarray(off, off + DRIP)));
  out.push(...enc.end());
  return out;
}

async function computeVectors() {
  const req: Record<string, Vec> = {};
  const res: Record<string, Vec> = {};
  const reqStream: Record<string, Vec> = {};
  const resStream: Record<string, Vec> = {};
  for (const r of BODIES) {
    req[r.name] = await vecOf(encodeReq("ID", "POST", "/upload?x=1", HDRS, r.make()));
    res[r.name] = await vecOf(encodeRes("ID", 200, HDRS, r.make()));
    reqStream[r.name] = await vecOf(dripReq(r.make()));
    resStream[r.name] = await vecOf(dripRes(r.make()));
  }
  // the abort frame is one fixed shape; freeze its exact wire string
  const reqAbort = JSON.stringify(encodeReqAbort("ID"));
  return { req, res, reqStream, resStream, reqAbort };
}

test("tunnel constants are the frozen wire values", () => {
  expect(CHUNK).toBe(256 * 1024);
  expect(REASSEMBLE_MAX).toBe(32 * 1024 * 1024);
});

test("req/res chunking matches the frozen vectors (drift pin, shared with the app repo)", async () => {
  const computed = await computeVectors();
  if (!existsSync(FIXTURE)) {
    mkdirSync(new URL("../fixtures/", import.meta.url).pathname, { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(computed, null, 2) + "\n");
  }
  const frozen = JSON.parse(readFileSync(FIXTURE, "utf8"));
  expect(computed).toEqual(frozen);
});

test("meta rides the first frame only; continuations carry id/b/more", () => {
  const frames = encodeReq("ID", "POST", "/p", HDRS, bytes(CHUNK * 2 + 1));
  expect(frames.length).toBe(3);
  expect(frames[0].m).toBe("POST");
  expect(frames[0].p).toBe("/p");
  expect(frames[0].h).toEqual(HDRS);
  for (const f of frames.slice(1)) {
    expect(f.m).toBeUndefined();
    expect(f.p).toBeUndefined();
    expect(f.h).toBeUndefined();
  }
  expect(frames.map((f) => f.more === true)).toEqual([true, true, false]);
});

test("a request round-trips through the reassembler, whole and chunked", () => {
  const rx = new ReqReassembler();
  for (const r of BODIES) {
    const body = r.make();
    let done: ReturnType<ReqReassembler["push"]> = null;
    for (const f of encodeReq("ID", "POST", "/upload?x=1", HDRS, body)) {
      const out = rx.push(f);
      if (out) done = out;
    }
    expect(done, r.name).not.toBeNull();
    expect(done!.method, r.name).toBe("POST");
    expect(done!.path, r.name).toBe("/upload?x=1");
    expect(done!.headers, r.name).toEqual(HDRS);
    expect(Array.from(done!.body), r.name).toEqual(Array.from(body ?? new Uint8Array(0)));
  }
});

test("a response round-trips through the reassembler", () => {
  const rx = new ResReassembler();
  const body = bytes(CHUNK + 7);
  let done: ReturnType<ResReassembler["push"]> = null;
  for (const f of encodeRes("R", 201, HDRS, body)) {
    const out = rx.push(f);
    if (out) done = out;
  }
  expect(done).not.toBeNull();
  expect(done!.status).toBe(201);
  expect(done!.headers).toEqual(HDRS);
  expect(Array.from(done!.body)).toEqual(Array.from(body));
});

test("two ids interleave without crossing chunks", () => {
  const rx = new ReqReassembler();
  const a = encodeReq("A", "POST", "/a", {}, bytes(CHUNK + 1)); // 2 frames
  const b = encodeReq("B", "POST", "/b", {}, bytes(CHUNK + 1)); // 2 frames
  expect(rx.push(a[0])).toBeNull();
  expect(rx.push(b[0])).toBeNull();
  const ra = rx.push(a[1])!;
  const rb = rx.push(b[1])!;
  expect(ra.path).toBe("/a");
  expect(rb.path).toBe("/b");
  expect(ra.body.length).toBe(CHUNK + 1);
  expect(rb.body.length).toBe(CHUNK + 1);
});

test("a body past REASSEMBLE_MAX is refused with 1009", () => {
  const rx = new ReqReassembler();
  const big = encodeReq("ID", "POST", "/p", {}, bytes(REASSEMBLE_MAX + 1));
  let code = 0;
  try {
    for (const f of big) rx.push(f);
  } catch (e) {
    code = (e as TunnelError).code;
  }
  expect(code).toBe(1009);
  expect(rx.pending).toBe(0); // the oversize buffer is dropped, not leaked
});

test("sweep drops a half-sent id whose sender vanished", () => {
  const rx = new ReqReassembler();
  const frames = encodeReq("ID", "POST", "/p", {}, bytes(CHUNK + 1));
  rx.push(frames[0], 1000); // first chunk only, more:true, at t=1000
  expect(rx.pending).toBe(1);
  expect(rx.sweep(500)).toBe(0); // cutoff before it: kept
  expect(rx.sweep(2000)).toBe(1); // cutoff after it: dropped
  expect(rx.pending).toBe(0);
});

/* ---- streaming additions ------------------------ */

test("a whole body pushed once then ended emits BYTE-IDENTICAL frames to the buffered encoders", () => {
  /* This is what keeps the buffered wire frozen even though the engine's
   * reply() now always streams: a fully-buffered Response body arrives as one
   * read, and one push + end must be indistinguishable from encodeRes. */
  for (const r of BODIES) {
    const body = r.make();
    const reqEnc = new ReqStreamEncoder("ID", "POST", "/upload?x=1", HDRS);
    const reqFrames = [...(body ? reqEnc.push(body) : []), ...reqEnc.end()];
    expect(wireOf(reqFrames), `req ${r.name}`).toBe(wireOf(encodeReq("ID", "POST", "/upload?x=1", HDRS, body)));
    const resEnc = new ResStreamEncoder("ID", 200, HDRS);
    const resFrames = [...(body ? resEnc.push(body) : []), ...resEnc.end()];
    expect(wireOf(resFrames), `res ${r.name}`).toBe(wireOf(encodeRes("ID", 200, HDRS, body)));
  }
});

test("a drip-fed streamed request round-trips through the unchanged reassembler", () => {
  const rx = new ReqReassembler();
  for (const r of BODIES) {
    const body = r.make();
    let done: ReturnType<ReqReassembler["push"]> = null;
    for (const f of dripReq(body)) {
      const out = rx.push(f);
      if (out) done = out;
    }
    expect(done, r.name).not.toBeNull();
    expect(done!.method, r.name).toBe("POST");
    expect(done!.path, r.name).toBe("/upload?x=1");
    expect(done!.headers, r.name).toEqual(HDRS);
    expect(Array.from(done!.body), r.name).toEqual(Array.from(body ?? new Uint8Array(0)));
  }
  expect(rx.pending).toBe(0);
});

test("a drip-fed streamed response round-trips, and only its LAST frame clears more", () => {
  const body = bytes(CHUNK * 2 + 100);
  const frames = dripRes(body);
  expect(frames[0].s).toBe(200); // meta on the first frame only
  expect(frames[0].h).toEqual(HDRS);
  for (const f of frames.slice(1)) {
    expect(f.s).toBeUndefined();
    expect(f.h).toBeUndefined();
  }
  expect(frames.map((f) => f.more === true)).toEqual(frames.map((_, i) => i < frames.length - 1));
  const rx = new ResReassembler();
  let done: ReturnType<ResReassembler["push"]> = null;
  for (const f of frames) {
    const out = rx.push(f);
    if (out) done = out;
  }
  expect(Array.from(done!.body)).toEqual(Array.from(body));
});

test("stream encoder mechanics: carve to CHUNK, hold the possible last part, empty body, push-after-end", () => {
  // small pushes aggregate: nothing is emitted below a full CHUNK
  const enc = new ResStreamEncoder("ID", 200, {});
  expect(enc.started).toBe(false);
  expect(enc.push(bytes(10))).toEqual([]);
  expect(enc.push(bytes(10))).toEqual([]);
  const tailOnly = enc.end();
  expect(tailOnly.length).toBe(1);
  expect(decodeChunk(tailOnly[0].b).length).toBe(20);
  expect(tailOnly[0].more).toBeUndefined();

  // an exact-CHUNK part is HELD until a later byte proves it non-final
  const hold = new ResStreamEncoder("ID", 200, {});
  expect(hold.push(bytes(CHUNK))).toEqual([]); // could be the body's end
  const flushed = hold.push(bytes(1)); // now it provably is not
  expect(flushed.length).toBe(1);
  expect(decodeChunk(flushed[0].b).length).toBe(CHUNK);
  expect(flushed[0].more).toBe(true);
  expect(hold.started).toBe(true);
  const last = hold.end();
  expect(last.length).toBe(1);
  expect(decodeChunk(last[0].b).length).toBe(1);
  expect(last[0].more).toBeUndefined();

  // a push far past CHUNK is re-sliced so no frame carries more than CHUNK
  const big = new ResStreamEncoder("ID", 200, {});
  const bigOut = [...big.push(bytes(CHUNK * 2 + 5)), ...big.end()];
  expect(bigOut.length).toBe(3);
  expect(bigOut.every((f) => decodeChunk(f.b).length <= CHUNK)).toBe(true);

  // an empty body emits the one bare meta frame
  const empty = new ReqStreamEncoder("ID", "GET", "/p", {});
  const ef = empty.end();
  expect(ef.length).toBe(1);
  expect(ef[0].m).toBe("GET");
  expect(ef[0].b).toBeUndefined();
  expect(ef[0].more).toBeUndefined();

  // push after end is a caller bug
  expect(() => empty.push(bytes(1))).toThrow(TunnelError);
  // end twice is a safe no-op
  expect(empty.end()).toEqual([]);
});

test("stream encoding equals buffered encoding for ANY push slicing (the wire never forks)", () => {
  const body = bytes(CHUNK * 2 + 100);
  const buffered = wireOf(encodeRes("ID", 200, HDRS, body));
  for (const step of [1000, 100_000, CHUNK, CHUNK + 1, body.length]) {
    const enc = new ResStreamEncoder("ID", 200, HDRS);
    const frames: ResFrame[] = [];
    for (let off = 0; off < body.length; off += step) frames.push(...enc.push(body.subarray(off, off + step)));
    frames.push(...enc.end());
    expect(wireOf(frames), `step ${step}`).toBe(buffered);
  }
});

test("decodeChunk inverts a frame's body chunk", () => {
  const body = bytes(CHUNK + 3);
  const frames = encodeReq("ID", "POST", "/p", {}, body);
  const back = frames.flatMap((f) => Array.from(decodeChunk(f.b)));
  expect(back).toEqual(Array.from(body));
  expect(decodeChunk(undefined).length).toBe(0);
});

test("the req-abort frame is the frozen wire shape", () => {
  expect(JSON.stringify(encodeReqAbort("X1"))).toBe('{"t":"req-abort","id":"X1"}');
});
