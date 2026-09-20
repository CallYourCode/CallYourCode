/* CONTENT CANNOT RIDE THE TUNNEL BEFORE THE HANDSHAKE COMPLETES.
 *
 * onReq (tunnel-glue.ts) reassembles a sealed {t:"req"} frame into a Request,
 * marks it as the owner (markSealedTunnel), and hands it to routeRequest. That
 * owner mark is the WHOLE of the tunnel's authority, so it must never be minted
 * for a sock whose sealed handshake has not completed. The guard is one line:
 *
 *     if (!ws.data.sec) return;   // tunnel-glue.ts
 *
 * ws.data.sec is set only when the RtcSock is built for a sealed DataChannel
 * (rtc-glue.ts), and the EngineSecConn behind it forwards frames to the content
 * dispatch ONLY after `ready` (sec.ts). This proves the guard directly at the
 * glue layer: a `{t:"req"}` arriving on a sock with NO sec is a no-op -- the
 * router is never called and no reply frame is sent -- so a peer that has not
 * finished the handshake cannot reach a single content route.
 *
 * tunnel-glue.test.ts fakes `data: { sec: {} }` (a ready-looking sock) to
 * exercise the streaming paths; this file deliberately does the opposite and
 * drives a sock whose sec is falsy, so the refusal is proven, not assumed.
 *
 *   bun test agent-engine/src/transport/tunnel-onreq-sec.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { initTunnel, onReq, onReqAbort } from "./tunnel-glue.ts";
import { encodeReq, type ResFrame } from "./tunnel.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import type { Sock } from "./sock.ts";

const oldEnv = process.env.CYC_DATA_DIR;
let routed = 0;

beforeAll(async () => {
  process.env.CYC_DATA_DIR = await tmpDir("cyc-onreq-sec-");
  initTunnel({
    // a router that records any call: the guard must ensure it is NEVER reached
    // for an unauthenticated sock.
    routeRequest: async () => { routed++; return new Response("ROUTED", { status: 200 }); },
    server: {} as import("bun").Server,
    log: () => {},
  });
});
afterAll(() => {
  if (oldEnv === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = oldEnv;
});

/** A sock with NO completed sec (the handshake never finished). We do NOT fake
 * data.sec as ready -- that is the exact thing under test. Every field onReq
 * might touch AFTER the guard is present so that, if the guard regressed, the
 * test would fail on a real route call rather than a missing property. */
function unsealedSock() {
  const out: (ResFrame & Record<string, unknown>)[] = [];
  const ws = {
    data: { sec: undefined, cid: 7, terms: new Map(), pipeDrain: () => Promise.resolve() },
    send: (s: string) => { out.push(JSON.parse(s)); },
    close: () => {},
  } as unknown as Sock;
  return { ws, out };
}

/** A sealed-looking sock (sec present), the positive control: the SAME frame
 * that is refused above must route here, so the refusal is the guard's doing
 * and not some unrelated drop. */
function sealedSock() {
  const out: (ResFrame & Record<string, unknown>)[] = [];
  const ws = {
    data: { sec: {}, cid: 8, terms: new Map(), pipeDrain: () => Promise.resolve() },
    send: (s: string) => { out.push(JSON.parse(s)); },
    close: () => {},
  } as unknown as Sock;
  return { ws, out };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

test("a {t:req} on a sock with no completed sec is a no-op: router never called, no reply", async () => {
  routed = 0;
  const { ws, out } = unsealedSock();
  // a COMPLETE buffered request: were the guard gone, this would reassemble and
  // route in one frame. It carries a body so it is unmistakably content.
  for (const f of encodeReq("pre-handshake-1", "POST", "/session/sess1/rename",
    { "content-type": "application/json" }, new TextEncoder().encode(JSON.stringify({ name: "hijack" })))) {
    await onReq(ws, f);
  }
  await settle();
  expect(routed, "the router ran for a sock whose handshake never completed").toBe(0);
  expect(out, "a reply frame was sent for a pre-handshake request").toEqual([]);
});

test("even a multi-frame streamed upload is refused before the handshake", async () => {
  /* A streaming-route request (/upload) opens a spool file if it reaches onReq's
   * body; the guard must fire first, so no spool is opened and the router never
   * sees a file-backed content body from an unauthenticated sock. */
  routed = 0;
  const { ws, out } = unsealedSock();
  const big = new Uint8Array(4096).fill(7);
  for (const f of encodeReq("pre-handshake-2", "POST", "/upload", { "x-filename": "x.bin" }, big)) {
    await onReq(ws, f);
  }
  await settle();
  expect(routed).toBe(0);
  expect(out).toEqual([]);
});

test("onReqAbort is likewise inert before the handshake", async () => {
  // the abort path shares the same guard (tunnel-glue.ts): nothing to abort on a
  // sock that never authenticated, so it must not throw or touch state.
  const { ws } = unsealedSock();
  await onReqAbort(ws, { t: "req-abort", id: "pre-handshake-1" });
  // reaching here without throwing is the assertion; a stray reply is impossible
  // with no state.
  expect(true).toBe(true);
});

test("positive control: the SAME request DOES route once the sock carries a sec", async () => {
  /* Proves the refusals above are the sec guard's doing. A sealed-looking sock
   * (data.sec present, as tunnel-glue.test.ts uses) reassembles and routes the
   * identical frame the unsealed sock refused. */
  routed = 0;
  const { ws, out } = sealedSock();
  for (const f of encodeReq("post-handshake-1", "POST", "/session/sess1/rename",
    { "content-type": "application/json" }, new TextEncoder().encode(JSON.stringify({ name: "ok" })))) {
    await onReq(ws, f);
  }
  // wait for the reply to be sent
  const end = Date.now() + 5000;
  while (out.length === 0 && Date.now() < end) await settle();
  expect(routed, "a sealed sock did not reach the router").toBe(1);
  expect(out.length, "a sealed sock produced no reply frame").toBeGreaterThan(0);
});
