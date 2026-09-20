/* THE SEALED REQUEST/RESPONSE TUNNEL, OVER A REAL BOOTED ENGINE.
 * The pure codec is pinned by ../tunnel.test.ts; this proves
 * the wiring: a {t:"req"} sealed onto the live DataChannel reaches the SAME
 * routeRequest the localhost server uses, and its answer comes back as chunked,
 * sealed {t:"res"} frames the app can reassemble byte-for-byte.
 *
 * Only a booted engine can prove this: the frame rides node-datachannel SCTP
 * over loopback, sealed by the engine's own keys.json, dispatched by the real
 * frames.ts, answered by the real routes. A fake pipe would agree with whatever
 * the code believes.
 *
 *   bun test --preload ./e2e/testpreload.ts e2e/tunnel.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { startEngine, openSealedClient, hasE2ETransport, PANE, type Engine } from "./harness.ts";
import { encodeReq, ResReassembler, type ResFrame } from "../transport/tunnel.ts";

/* The sealed-client specs need the DataChannel transport the e2e preload
 * installs (`bun run test:e2e`); under a bare `bun test` the native WebSocket is
 * in place, the engine refuses a raw hello (#579), and they can only time out.
 * They SKIP there instead. See hasE2ETransport in harness.ts. */
const sealedTest = test.skipIf(!hasE2ETransport);

let engine: Engine | null = null;
afterEach(async () => {
  await engine?.stop();
  engine = null;
});

type TunnelResult = { status: number; headers: Record<string, string>; body: Uint8Array; frames: number };

/* Send a request over the sealed shim (each encodeReq frame is one sealed
 * send()) and reassemble the {t:"res"} chunks that come back tagged with our id.
 * The shim delivers every opened frame into `frames`; we consume the ones for
 * this id in arrival order, which is the order the ordered channel guarantees. */
async function tunnelFetch(
  ws: WebSocket,
  frames: Record<string, any>[],
  req: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array },
  ms = 15_000,
): Promise<TunnelResult> {
  const id = "t-" + crypto.randomUUID();
  const rx = new ResReassembler();
  let next = frames.length; // only frames that arrive AFTER we send are ours
  let count = 0;
  for (const f of encodeReq(id, req.method, req.path, req.headers ?? {}, req.body ?? null)) {
    ws.send(JSON.stringify(f));
  }
  const end = Date.now() + ms;
  for (;;) {
    while (next < frames.length) {
      const m = frames[next++];
      if (m?.t === "res" && m.id === id) {
        count++;
        const done = rx.push(m as ResFrame);
        if (done) return { status: done.status, headers: done.headers, body: done.body, frames: count };
      }
    }
    if (Date.now() > end) throw new Error(`tunnel answer never completed for ${req.method} ${req.path}`);
    await Bun.sleep(20);
  }
}

sealedTest("a content route returns the same bytes direct and tunnelled, chunked both ways", async () => {
  engine = await startEngine();
  const e = engine;
  const { ws, frames } = await openSealedClient(e);

  /* A body that spans more than one 256KB chunk in BOTH directions, so the
   * request AND the response really fragment on the wire. Deterministic bytes so
   * the equality is exact. */
  const N = 300 * 1024;
  const payload = new Uint8Array(N);
  for (let i = 0; i < N; i++) payload[i] = (i * 7 + 13) % 251;

  // (1) store it by POSTing OVER THE TUNNEL: the request body chunks (2 frames),
  // onReq marks the request as owner-authenticated (the channel is the auth, no
  // cap header), and the route answers a small JSON.
  const post = await tunnelFetch(ws, frames, {
    method: "POST",
    path: "/upload",
    headers: { "x-filename": "tunnel.bin", "content-type": "application/octet-stream" },
    body: payload,
  });
  expect(post.status, "the tunnelled POST /upload was refused or errored").toBe(200);
  const rec = JSON.parse(new TextDecoder().decode(post.body)) as { uploadId: string; size: number };
  expect(rec.size, "the upload did not receive the whole chunked request body").toBe(N);
  expect(rec.uploadId).toBeTruthy();

  // (2) fetch it back OVER THE TUNNEL: the response body chunks (2+ frames) and
  // must reassemble to the exact bytes that went in.
  const got = await tunnelFetch(ws, frames, { method: "GET", path: `/upload/${rec.uploadId}` });
  expect(got.status).toBe(200);
  expect(got.frames, "a 300KB answer must arrive in more than one res chunk").toBeGreaterThan(1);
  expect(got.body.length).toBe(N);
  expect(Array.from(got.body.subarray(0, 64)), "the tunnelled body head differs")
    .toEqual(Array.from(payload.subarray(0, 64)));
  expect(Array.from(got.body.subarray(N - 64)), "the tunnelled body tail differs")
    .toEqual(Array.from(payload.subarray(N - 64)));

  // (3) direct HTTP GET of the same route (loopback, trusted-local) returns the
  // identical bytes: the tunnel changed the transport, not the answer.
  const direct = new Uint8Array(await (await fetch(`${e.http}/upload/${rec.uploadId}`)).arrayBuffer());
  expect(direct.length).toBe(N);
  expect(got.body.length).toBe(direct.length);
  // spot-check equality without a full 300KB compare in the reporter
  for (const off of [0, 1024, N - 1]) expect(got.body[off], `byte ${off}`).toBe(direct[off]);

  ws.close();
}, 120_000);

sealedTest("the content route is TUNNEL-ONLY now: same route answers the tunnel, refuses remote HTTP", async () => {
  /* The app is tunnel-only, and the engine cut the content
   * routes to the sealed tunnel + localhost. This proves all three at once on a
   * real booted engine, over a real sealed DataChannel. */
  engine = await startEngine();
  const e = engine;
  const { ws, frames } = await openSealedClient(e);

  const payload = new Uint8Array(32);
  for (let i = 0; i < payload.length; i++) payload[i] = i;

  // store it over the tunnel (marked owner), then read it back over the tunnel.
  const post = await tunnelFetch(ws, frames, {
    method: "POST", path: "/upload",
    headers: { "x-filename": "cut.bin", "content-type": "application/octet-stream" },
    body: payload,
  });
  expect(post.status).toBe(200);
  const { uploadId } = JSON.parse(new TextDecoder().decode(post.body)) as { uploadId: string };

  // (a) TUNNEL: the content answers.
  const viaTunnel = await tunnelFetch(ws, frames, { method: "GET", path: `/upload/${uploadId}` });
  expect(viaTunnel.status, "the tunnel could not read a content route").toBe(200);
  expect(viaTunnel.body.length).toBe(payload.length);

  /* (b) REMOTE HTTP: the SAME route over plain HTTP with an x-forwarded-for
   * (the `tailscale serve` shape: a loopback TCP peer, a real client in XFF) is
   * refused -- even carrying a cap header, which the gate no longer reads. This
   * is the leak the step closes: a tailnet peer can no longer GET the bytes. */
  for (const headers of [
    { "x-forwarded-for": "100.64.0.9" },
    { "x-forwarded-for": "100.64.0.9", "x-cyc-cap": "anything-at-all" },
  ] as Record<string, string>[]) {
    const remote = await fetch(`${e.http}/upload/${uploadId}`, { headers });
    expect(remote.status, `a remote HTTP GET (${JSON.stringify(headers)}) was answered`).toBe(403);
  }

  /* (c) LOCALHOST / BOOT: a direct loopback GET (no XFF) still works, so the
   * cyc CLI, local scripts, and the pre-seal HTTP path are not bricked. */
  const local = await fetch(`${e.http}/upload/${uploadId}`);
  expect(local.status, "a direct localhost GET was refused").toBe(200);
  expect(new Uint8Array(await local.arrayBuffer()).length).toBe(payload.length);

  ws.close();
}, 120_000);

sealedTest("a 404 rides the tunnel as a 404, not a hang", async () => {
  engine = await startEngine();
  const e = engine;
  const { ws, frames } = await openSealedClient(e);
  const r = await tunnelFetch(ws, frames, { method: "GET", path: "/upload/00000000-0000-0000-0000-000000000000" });
  expect(r.status).toBe(404);
  ws.close();
}, 60_000);

test("the session-metadata GET routes refuse a remote peer but answer localhost (step-4 leak closed)", async () => {
  /* THE LEAK THIS CLOSES. Session-metadata GETs once answered a remote tailnet
   * peer (a loopback TCP peer carrying x-forwarded-for, the `tailscale serve`
   * shape) with 200, leaking session ids, names, cwds, the voice map, and host
   * telemetry. Three (/session/<id>/settings, /chat-sizes, /voices) have since
   * been REMOVED entirely -- the app never fetched them; that data rides the ws
   * sessions frame + cyc now. Only /voice-log survives, and it is gated:
   * requireOwner admits only the sealed tunnel and the engine host, so a
   * remote-shaped HTTP GET is 403 while a direct loopback GET (the cyc CLI, local
   * scripts, the pre-seal path) still answers.
   *
   * Mirrors the content-route proof above: a remote XFF GET (bare AND carrying a
   * cap header the gate no longer reads) must be 403, and a direct loopback GET
   * must NOT be 403 and NOT leak. */
  engine = await startEngine();
  const e = engine;

  const routes = [
    `/voice-log`,
  ];

  for (const path of routes) {
    // (a) REMOTE HTTP: the `tailscale serve` shape (loopback TCP peer + XFF), both
    // bare and carrying a cap header, is refused. The cap is no longer a key.
    for (const headers of [
      { "x-forwarded-for": "100.64.0.9" },
      { "x-forwarded-for": "100.64.0.9", "x-cyc-cap": "anything-at-all" },
    ] as Record<string, string>[]) {
      const remote = await fetch(`${e.http}${path}`, { headers });
      expect(remote.status, `a remote HTTP GET of ${path} (${JSON.stringify(headers)}) was answered`).toBe(403);
    }

    // (b) LOCALHOST: a direct loopback GET (no XFF) is NOT refused. It answers
    // the metadata (200), or the route's normal non-403 upstream-down status;
    // either way it is never a 403 and never the leak.
    const local = await fetch(`${e.http}${path}`);
    expect(local.status, `a direct localhost GET of ${path} was refused`).not.toBe(403);
  }
}, 120_000);

sealedTest("a local-only route stays refused over the sealed channel (the cap is not a skeleton key)", async () => {
  /* onReq stamps the OWNER cap, which is exactly what requireOwner accepts. A
   * requireLocal route (agent-message, debug, trim-log) has NO cap path: it is
   * this-machine-only by design, and the app never tunnels it. Proving the
   * tunnel does not smuggle past that gate is the point. */
  engine = await startEngine();
  const e = engine;
  const { ws, frames } = await openSealedClient(e);
  const r = await tunnelFetch(ws, frames, {
    method: "POST",
    path: `/session/${PANE}/agent-message`,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify({ text: "hi" })),
  });
  expect(r.status, "a local-only route must refuse a tunnelled request").toBe(403);
  ws.close();
}, 60_000);

test("the browser Origin gate holds on a real booted engine (H1/H2)", async () => {
  /* THE DRIVE-BY SHAPE, over the real Bun.serve. A web page open in a browser
   * ON the engine host fetches 127.0.0.1:<port>: the TCP peer is loopback with
   * no x-forwarded-for, which the local gates used to trust wholesale. The
   * page names itself in the Origin header, and the engine refuses a
   * disallowed one BEFORE the router (refuseForbiddenOrigin on the TCP feed),
   * so even the deliberately ungated /health is closed to it. A caller with NO
   * Origin (the cyc CLI, hooks, the MCP, the app-server's health poll) is
   * untouched, and a loopback-hosted page (the machine's own served app, a dev
   * page) still passes. */
  engine = await startEngine();
  const e = engine;

  const EVIL = { origin: "https://evil.example.com" };
  const TS_NET = { origin: "https://evil-box.attacker-tailnet.ts.net" };
  const LOCAL_PAGE = { origin: "http://localhost:5173" };

  // (a) a gated content route: refused for the drive-by page, in both layers.
  for (const headers of [EVIL, TS_NET]) {
    const r = await fetch(`${e.http}/voice-log`, { headers });
    expect(r.status, `a drive-by Origin (${headers.origin}) reached /voice-log`).toBe(403);
  }

  // (b) even the ungated bootstrap read is closed to a disallowed Origin
  // (the pre-router refusal covers the whole surface, /health included) ...
  expect((await fetch(`${e.http}/health`, { headers: EVIL })).status).toBe(403);
  // ... while the no-Origin caller the route exists for still gets it.
  const health = await fetch(`${e.http}/health`);
  expect(health.status, "the open /health bootstrap read broke for local callers").toBe(200);
  // and no answer advertises a CORS grant any more (the old wildcard is gone).
  expect(health.headers.get("access-control-allow-origin")).toBeNull();

  // (c) a loopback-hosted page is still allowed through the origin policy.
  const localPage = await fetch(`${e.http}/voice-log`, { headers: LOCAL_PAGE });
  expect(localPage.status, "a loopback-origin page was refused").not.toBe(403);

  // (d) the /ws upgrade (H2): a disallowed Origin is 403 at the gate; with no
  // Origin the gate passes and only the missing upgrade headers answer 400,
  // which is exactly the difference between "refused" and "not a websocket".
  expect((await fetch(`${e.http}/ws`, { headers: EVIL })).status).toBe(403);
  expect((await fetch(`${e.http}/ws`)).status).toBe(400);
}, 120_000);
