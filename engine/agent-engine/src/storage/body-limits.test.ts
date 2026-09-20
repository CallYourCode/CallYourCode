/* EVERY REQUEST BODY HAS A CEILING, and the ceiling is enforced BEFORE the
 * bytes are kept.
 *
 * SECURITY-REVIEW #11: the routes used to call req.json() / req.text() /
 * req.arrayBuffer() with no cap. Those read the whole stream into memory, so
 * one POST from a tailnet peer (or from a page inside the show sandbox) could
 * hold gigabytes of engine RSS before anything looked at it. The fix is two
 * halves, and both are tested here:
 *
 *   THE READERS (unit): a declared Content-Length over the cap is refused with
 *   the stream untouched; a body with no Content-Length is refused the instant
 *   the running count would pass the cap, and the overflowing chunk is dropped
 *   rather than stored; a body of EXACTLY the cap is kept.
 *
 *   THE ROUTES (seam): the three classes are actually wired, per route, at the
 *   real HTTP boundary. serveRoutes runs the engine's own RouteGroups over a
 *   Bun.serve on port 0, so this is the same code server.ts dispatches, with no
 *   engine process anywhere.
 *
 * The load-bearing seam test is the raw-socket one: it sends only the REQUEST
 * HEAD, declares a body far over the cap, and never sends a byte of it. A 413
 * coming back proves the refusal happened on the header. If that check ever
 * regresses to "read it, then measure it", this test does not fail with a wrong
 * status; it HANGS, because the engine would still be waiting for the body it
 * promised to buffer. Bun's per-test timeout is what turns that into a failure.
 *
 *   bun test agent-engine/src/storage/body-limits.test.ts
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  JSON_BODY_MAX_BYTES,
  STATE_BODY_MAX_BYTES,
  UPLOAD_BODY_MAX_BYTES,
  bodyTooLarge,
  declaredBodyTooLarge,
  readBodyCapped,
  readJsonCapped,
  readTextCapped,
} from "./body-limits.ts";
import { DOC_STATE_MAX_BYTES } from "./docstate.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { mediaRoutes } from "../routes/media.ts";
import { pluginRoutes } from "../routes/plugin.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { initClips, resetForTest as resetClips } from "../chat/clips.ts";
import { sessions, settingsOf, type Session } from "../sessions/session-state.ts";
import type { PluginSpec } from "../plugins/platform/spec.ts";

/* ======================================================================= UNIT
 * The readers, straight against body-limits.ts. No server, no route.        */

const CAP = 64;

function reqOf(init: RequestInit): Request {
  return new Request("http://engine.local/x", { method: "POST", ...init });
}

async function tooLarge(r: { ok: false; response: Response } | { ok: true; value: unknown }, max: number) {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.response.status).toBe(413);
  expect(r.response.headers.get("content-type")).toBe("application/json");
  // no CORS grant, like every other answer now (H1 fix: the engine stopped
  // advertising cross-origin access entirely)
  expect(r.response.headers.get("access-control-allow-origin")).toBeNull();
  expect(await r.response.json()).toEqual({ error: "body too large", max });
}

test("the three class caps are the numbers the routes will use", () => {
  expect(JSON_BODY_MAX_BYTES).toBe(80 * 1024);
  expect(STATE_BODY_MAX_BYTES).toBe(DOC_STATE_MAX_BYTES);
  expect(UPLOAD_BODY_MAX_BYTES).toBe(300 * 1024 * 1024);
  /* The JSON cap is deliberately NOT a round 64KB: /agent-message may legally
   * carry SEND_MSG_MAX (64k CHARACTERS) plus its JSON envelope, and a 64KB BYTE
   * cap would refuse a send this engine documents as legal. */
  expect(JSON_BODY_MAX_BYTES).toBeGreaterThan(64 * 1024);
});

test("Content-Length over the cap is 413 and the body is not read", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(8));
    },
  });
  const r = await readBodyCapped(
    reqOf({ headers: { "content-length": String(CAP + 1) }, body }),
    CAP,
  );
  await tooLarge(r, CAP);
  expect(pulled, "the stream was pulled at all: the cap is being measured after the read").toBe(0);
});

test("a stream with no Content-Length is 413 as soon as it would pass the cap", async () => {
  let pulled = 0;
  const chunk = 16;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
  const r = await readBodyCapped(reqOf({ body }), CAP);
  await tooLarge(r, CAP);
  /* At most ONE chunk past the cap: the read stops on the chunk that would
   * cross it, and that chunk is dropped rather than appended. A lying (or
   * absent) Content-Length must not buy a client more memory than an honest
   * one, which is the whole reason the running count exists beside the header
   * check. */
  expect(pulled).toBeLessThanOrEqual(CAP + chunk);
  expect(pulled).toBeGreaterThan(CAP);
});

test("a Content-Length that is not a number is ignored, and the count still catches it", async () => {
  /* A header of "abc", "12x", "-1" or "1e9" is not a length; declaredLength
   * answers null and the stream is counted instead. The failure this guards is
   * a parse that returns NaN and compares false against the cap, which would
   * turn a garbage header into a bypass of the cheap check AND, if the count
   * were ever removed, of the cap itself. */
  for (const bogus of ["abc", "12x", "-1", "1e9", " ", "999999999999999999999999"]) {
    const r = await readBodyCapped(
      reqOf({ headers: { "content-length": bogus }, body: "x".repeat(CAP + 8) }),
      CAP,
    );
    await tooLarge(r, CAP);
  }
});

test("an honest under-cap Content-Length is not refused on the header alone", async () => {
  const r = await readBodyCapped(
    reqOf({ headers: { "content-length": String(CAP) }, body: "x".repeat(CAP) }),
    CAP,
  );
  expect(r.ok).toBe(true);
});

test("declaredBodyTooLarge refuses a streaming forward on the header, and only then", async () => {
  /* The voice proxy never buffers: it hands the body straight upstream. So its
   * only chance to refuse a 4GB note is the declared length, before a single
   * byte is forwarded. Under the cap (and with no header at all) it must answer
   * null so the stream may pass. */
  const over = declaredBodyTooLarge(
    reqOf({ headers: { "content-length": String(CAP + 1) }, body: "x" }), CAP);
  expect(over?.status).toBe(413);
  expect(await over!.json()).toEqual({ error: "body too large", max: CAP });

  expect(declaredBodyTooLarge(reqOf({ headers: { "content-length": String(CAP) }, body: "x" }), CAP)).toBeNull();
  expect(declaredBodyTooLarge(reqOf({ body: "x" }), CAP)).toBeNull();
  expect(declaredBodyTooLarge(reqOf({}), CAP)).toBeNull();
});

test("json under the cap parses; invalid JSON is {}", async () => {
  const ok = await readJsonCapped(reqOf({ body: '{"a":1}' }), CAP);
  expect(ok).toEqual({ ok: true, value: { a: 1 } });
  /* Invalid JSON is {} rather than a throw, because that is exactly what the
   * control routes did before the cap existed (`req.json().catch(() => ({}))`).
   * Changing it here would turn a 400-shaped refusal into a 500. */
  const bad = await readJsonCapped(reqOf({ body: "not-json" }), CAP);
  expect(bad).toEqual({ ok: true, value: {} });
  const empty = await readJsonCapped(reqOf({}), CAP);
  expect(empty).toEqual({ ok: true, value: {} });
  const blank = await readJsonCapped(reqOf({ body: "" }), CAP);
  expect(blank).toEqual({ ok: true, value: {} });
});

test("an over-cap json body is a 413, never a parse", async () => {
  const r = await readJsonCapped(reqOf({ body: JSON.stringify({ pad: "x".repeat(CAP) }) }), CAP);
  await tooLarge(r, CAP);
});

test("text under the cap is the same string", async () => {
  const r = await readTextCapped(reqOf({ body: "hello" }), CAP);
  expect(r).toEqual({ ok: true, value: "hello" });
});

test("the cap counts BYTES, not characters", async () => {
  /* A multi-byte character must not buy extra room. Ten emoji are ten
   * characters and forty bytes; with a 32-byte cap that is a refusal, and a
   * length check on the decoded string would have let it through. */
  const emoji = "\u{1F680}".repeat(10);
  expect(emoji.length).toBe(20);          // JS length: surrogate pairs
  expect(new TextEncoder().encode(emoji).byteLength).toBe(40);
  await tooLarge(await readTextCapped(reqOf({ body: emoji }), 32), 32);
  const under = await readTextCapped(reqOf({ body: emoji }), 40);
  expect(under).toEqual({ ok: true, value: emoji });
});

test("bytes under the cap are unchanged", async () => {
  const bytes = new Uint8Array([1, 2, 3, 250]);
  const r = await readBodyCapped(reqOf({ body: bytes }), CAP);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect([...r.value]).toEqual([1, 2, 3, 250]);
});

test("a body of exactly the cap is kept, and one byte more is not", async () => {
  const at = await readBodyCapped(reqOf({ body: "x".repeat(CAP) }), CAP);
  expect(at.ok, "an exactly-at-cap body was refused: the comparison is off by one").toBe(true);
  if (at.ok) expect(at.value.byteLength).toBe(CAP);

  await tooLarge(await readBodyCapped(reqOf({ body: "x".repeat(CAP + 1) }), CAP), CAP);
});

test("a multi-chunk body that lands exactly on the cap is reassembled in order", async () => {
  /* The reader copies chunks into one output buffer at a running offset. An
   * offset bug is invisible on a single-chunk body (every fetch in this file)
   * and corrupts every real upload, so the boundary case is authored by hand. */
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  const r = await readBodyCapped(reqOf({ body }), 6);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect([...r.value]).toEqual([1, 2, 3, 4, 5, 6]);
});

test("an empty chunk does not count against the cap", async () => {
  // a zero-length enqueue is legal on a stream and must not consume budget
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(0));
      controller.enqueue(new Uint8Array([7]));
      controller.enqueue(new Uint8Array(0));
      controller.close();
    },
  });
  const r = await readBodyCapped(reqOf({ body }), 1);
  expect(r.ok).toBe(true);
  if (r.ok) expect([...r.value]).toEqual([7]);
});

test("a request with no body at all is an empty value, not a refusal", async () => {
  const r = await readBodyCapped(new Request("http://engine.local/x"), CAP);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.byteLength).toBe(0);
});

test("bodyTooLarge always names the cap it enforced", async () => {
  // the agent (or the app) reading this has to know what to shrink to
  const res = bodyTooLarge(JSON_BODY_MAX_BYTES);
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: "body too large", max: JSON_BODY_MAX_BYTES });
});

/* ======================================================================= SEAM
 * The same caps, wired per route, over real HTTP against the real RouteGroups.
 * No engine: serveRoutes is a Bun.serve on port 0 with a hand-built RoutesCtx.
 */

const PANE = "w9:p9";
const PHOTO_MAX = 8 * 1024 * 1024;   // routes/media.ts, tighter than the upload class
const OLD_DATA_DIR = process.env.CYC_DATA_DIR;

let srv: ServedRoutes;

/** One live session, enough for the routes that look one up before reading a
 *  body. Nothing here is persisted: session-state's meta saves stay unarmed
 *  until boot enables them, so this never touches disk. */
function seedSession(id: string, cwd: string): Session {
  const s = {
    id, agentId: "ag-bodylimits", muxHandle: "w9:p9", name: "body-limits",
    cwd, ws: null, alive: true, busy: false, viaMux: false,
    agent: { id: "claude", name: "Claude" }, hasTranscript: false, agentSession: null,
    harnessSessionId: null, status: "idle", workspace: "w9", tab: null,
    displayAgent: null, stateChangeSeq: 0, turnSince: 0, channels: [],
    doneSeq: 0, seenDoneSeq: 0, heardTs: 0, notified: false, filedTs: 0,
    order: 0, chat: [],
  } as unknown as Session;
  sessions.set(id, s);
  return s;
}

/* A plugin whose only job is to EXIST, so /plugin/<id>/state gets past its
 * "is this plugin loaded" gate and reaches the capped read. */
const fixturePlugin = { id: "fixture", version: "1" } as unknown as PluginSpec;

beforeAll(async () => {
  const dir = await tmpDir("cyc-bodylimits-");
  process.env.CYC_DATA_DIR = dir;      // datadir.ts reads it lazily, per call
  seedSession(PANE, dir);
  /* The one clip this file stores goes to a scratch staging dir of its own.
   * Uninitialised, clips.ts has an EMPTY staging path and writes relative to
   * the process cwd, which for a test run is the engine source tree. */
  await initClips({ blobOwner: () => new Map(), agentIdFor: () => "ag-bodylimits",
    stagingDir: `${dir}/staging-audio/` });
  srv = serveRoutes({
    groups: [sessionOpsRoutes, mediaRoutes, pluginRoutes],
    ctx: { plugins: () => [fixturePlugin], pluginById: (id) => id === "fixture" ? fixturePlugin : undefined },
  });
});

afterAll(() => {
  srv?.stop();
  sessions.clear();
  resetClips();
  if (OLD_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = OLD_DATA_DIR;
});

// requireOwner has no per-test state to reset: the x-cyc-cap machinery is
// DELETED (sealed-transport plan) and the sealed-tunnel mark lives in a
// self-cleaning WeakSet, so nothing carries between tests here.

/* SEND ONLY THE REQUEST HEAD. The body is declared and never written, so an
 * answer at all proves the refusal was taken on Content-Length. `connection:
 * close` is what makes the socket end after the response instead of parking on
 * keep-alive; without it this helper would never resolve even on success. */
async function headOnlyPost(path: string, headers: Record<string, string>):
    Promise<{ status: number; body: string }> {
  const head = [
    `POST ${path} HTTP/1.1`,
    "host: 127.0.0.1",
    "connection: close",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "", "",
  ].join("\r\n");

  let raw = "";
  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      hostname: "127.0.0.1",
      port: srv.port,
      socket: {
        open(sock) { sock.write(head); },
        data(_sock, d) { raw += new TextDecoder().decode(d); },
        close() { resolve(); },
        error(_sock, e) { reject(e); },
      },
    }).catch(reject);
  });
  const status = Number(/^HTTP\/1\.\d (\d+)/.exec(raw)?.[1] ?? 0);
  const sep = raw.indexOf("\r\n\r\n");
  return { status, body: sep < 0 ? "" : raw.slice(sep + 4) };
}

test("settings POST over the JSON cap is 413; a small one still 200s", async () => {
  const url = `/session/${encodeURIComponent(PANE)}/settings`;
  const small = await srv.post(url, { muted: true });
  expect(small.status).toBe(200);
  expect((await small.json()).ok).toBe(true);

  const big = await srv.post(url, { muted: true, pad: "x".repeat(JSON_BODY_MAX_BYTES) });
  expect(big.status).toBe(413);
  expect(await big.json()).toEqual({ error: "body too large", max: JSON_BODY_MAX_BYTES });
});

test("a refused settings body changes nothing: the 413 is not a half-apply", async () => {
  const url = `/session/${encodeURIComponent(PANE)}/settings`;
  await srv.post(url, { muted: false });
  // Read the persisted override straight from the store: the GET read route is
  // gone (settings ride the ws frame + cyc), so a half-apply is caught in-process.
  const before = { ...settingsOf(PANE) };

  const big = await srv.post(url, { muted: true, pad: "x".repeat(JSON_BODY_MAX_BYTES) });
  expect(big.status).toBe(413);

  const after = { ...settingsOf(PANE) };
  expect(after, "the over-cap body was parsed and applied anyway").toEqual(before);
});

test("the rename and order routes carry the same JSON cap", async () => {
  /* PER-ROUTE ENFORCEMENT is the point: the cap lives at each call site, so a
   * route added without one is the regression. These two share the JSON class
   * with settings and each has to prove it for itself. */
  const rename = await srv.post(`/session/${encodeURIComponent(PANE)}/rename`,
    { name: "x".repeat(JSON_BODY_MAX_BYTES) });
  expect(rename.status).toBe(413);
  expect(await rename.json()).toEqual({ error: "body too large", max: JSON_BODY_MAX_BYTES });

  const order = await srv.post("/sessions/order", { order: [PANE], pad: "x".repeat(JSON_BODY_MAX_BYTES) });
  expect(order.status).toBe(413);

  const unread = await srv.post(`/session/${encodeURIComponent(PANE)}/unread`,
    { read: true, pad: "x".repeat(JSON_BODY_MAX_BYTES) });
  expect(unread.status).toBe(413);
});

test("plugin state POST over the state cap is 413; a small one still 200s", async () => {
  const small = await srv.post("/plugin/fixture/state", { note: "ok" });
  expect(small.status).toBe(200);
  expect((await small.json()).ok).toBe(true);

  const big = await srv.post("/plugin/fixture/state", { blob: "x".repeat(STATE_BODY_MAX_BYTES) });
  expect(big.status).toBe(413);
  expect(await big.json()).toEqual({ error: "body too large", max: STATE_BODY_MAX_BYTES });

  // and the refusal did not overwrite what was already stored
  const back = await (await srv.get("/plugin/fixture/state")).json();
  expect(back.data).toEqual({ note: "ok" });
});

test("photo POST over its own tighter cap is 413, and it is the ROUTE's number", async () => {
  /* /photo does not use a body-limits class constant: 8MB is its own, well
   * under the 300MB voice-note ceiling, so a face upload can never buffer up to
   * the audio class. The number in the refusal is what proves which cap ran. */
  const big = await srv.fetch(`/session/${encodeURIComponent(PANE)}/photo`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(PHOTO_MAX + 1),
  });
  expect(big.status).toBe(413);
  expect(await big.json()).toEqual({ error: "body too large", max: PHOTO_MAX });
  expect(PHOTO_MAX).toBeLessThan(UPLOAD_BODY_MAX_BYTES);
});

test("a 413 is answered on the HEADER: the body is never sent, and the answer still arrives", async () => {
  /* THE SECURITY PROPERTY, at the real socket. Nothing but the request head is
   * written; the declared length is far over the cap. A refusal coming back
   * means Content-Length was read and the stream cancelled before a byte was
   * kept. A regression to "buffer, then measure" does not fail this with a
   * wrong status: it HANGS waiting for a body that never comes, and the test
   * timeout is the failure. */
  const r = await headOnlyPost(`/session/${encodeURIComponent(PANE)}/settings`, {
    "content-type": "application/json",
    "content-length": String(JSON_BODY_MAX_BYTES * 8),
  });
  expect(r.status).toBe(413);
  expect(JSON.parse(r.body)).toEqual({ error: "body too large", max: JSON_BODY_MAX_BYTES });
});

test("the 300MB upload class refuses one byte over, without moving 300MB", async () => {
  /* THE VOICE-NOTE CEILING, proven on the reader rather than through a socket,
   * and the reason is worth writing down: a 300MB declared length never reaches
   * a route handler at all under a default Bun.serve, whose own
   * maxRequestBodySize is 128MB and which answers its own bodyless 413 first.
   * server.ts raises that to 320MB precisely so USER_AUDIO_MAX is the cap that
   * decides; serveRoutes does not, so the route half of THIS class is asserted
   * below by showing /user-audio is not on the JSON class, and the exact
   * boundary is asserted here, where no bytes have to move at all. */
  const over = await readBodyCapped(
    reqOf({ headers: { "content-length": String(UPLOAD_BODY_MAX_BYTES + 1) }, body: "x" }),
    UPLOAD_BODY_MAX_BYTES);
  await tooLarge(over, UPLOAD_BODY_MAX_BYTES);

  const at = declaredBodyTooLarge(
    reqOf({ headers: { "content-length": String(UPLOAD_BODY_MAX_BYTES) }, body: "x" }),
    UPLOAD_BODY_MAX_BYTES);
  expect(at, "a note of exactly 300MB was refused: the voice-note ceiling is off by one").toBeNull();
});

test("/user-audio is on the upload class, not the JSON one", async () => {
  /* PER-ROUTE ENFORCEMENT, from the other direction. Every capped route in this
   * file so far proves it REFUSES; this one proves it does not refuse what its
   * own class allows. A clip 100KB long is over JSON_BODY_MAX_BYTES (80KB) and
   * nowhere near USER_AUDIO_MAX, so a 413 here would mean somebody wired the
   * wrong constant and silenced every voice note longer than a sentence. */
  const clip = new Uint8Array(100 * 1024).fill(7);
  expect(clip.byteLength).toBeGreaterThan(JSON_BODY_MAX_BYTES);
  const res = await srv.fetch("/user-audio", {
    method: "POST", headers: { "content-type": "audio/webm" }, body: clip,
  });
  expect(res.status, "a 100KB voice note was refused: /user-audio is on the JSON cap").toBe(200);
  expect(typeof (await res.json()).msgId).toBe("string");
});

test("the plugin-state and photo routes refuse on the header too", async () => {
  const state = await headOnlyPost("/plugin/fixture/state", {
    "content-type": "application/json",
    "content-length": String(STATE_BODY_MAX_BYTES + 1),
  });
  expect(state.status).toBe(413);
  expect(JSON.parse(state.body)).toEqual({ error: "body too large", max: STATE_BODY_MAX_BYTES });

  const photo = await headOnlyPost(`/session/${encodeURIComponent(PANE)}/photo`, {
    "content-type": "image/png",
    "content-length": String(PHOTO_MAX + 1),
  });
  expect(photo.status).toBe(413);
  expect(JSON.parse(photo.body)).toEqual({ error: "body too large", max: PHOTO_MAX });
});

test("a body one byte under the class cap is still served by the route", async () => {
  /* The other side of the boundary, over real HTTP: the cap must refuse what is
   * over it and NOTHING else. A cap that measured the envelope rather than the
   * body, or that compared >= instead of >, would fail here and nowhere else. */
  const pad = "y".repeat(JSON_BODY_MAX_BYTES - '{"muted":true,"pad":""}'.length);
  const body = JSON.stringify({ muted: true, pad });
  expect(new TextEncoder().encode(body).byteLength).toBe(JSON_BODY_MAX_BYTES);
  const res = await srv.post(`/session/${encodeURIComponent(PANE)}/settings`, body);
  expect(res.status, "an exactly-at-cap request body was refused at the route").toBe(200);
});
