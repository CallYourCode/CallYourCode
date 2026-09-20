/* THE VOICE CONTRACT ON THE ENGINE'S OWN ORIGIN (voice-through-engine).
 *
 * The app used to be told the voice engine's URL by the app server and talk to
 * it directly for /stt, /tts and /voices. That change made the agent engine
 * expose those shapes at /voice/* on its own origin, forwarding to the
 * configured VOICE_URL, so the app stops needing a second host.
 *
 * THE MIC STREAM IS NOT HERE ANY MORE: /voice/stt-stream was removed
 * (a WS upgrade can never carry the sealed-tunnel mark). Streaming STT rides the sealed DataChannel as stt-open/stt-b/
 * stt-close frames, proven in voice-stt-bridge.test.ts.
 *
 * WHAT IS REAL HERE: routes/voice.ts, voice-proxy.ts (the pick + the HTTP
 * forwarding), body-limits.ts, all of it served over a real Bun.serve on PORT 0
 * by test-utils/serve-routes.ts. No engine is spawned and no real voice engine,
 * kokoro or whisper is touched: the upstream is always
 * test-utils/fake-voice.ts, an in-process stub on its own port 0.
 *
 * TIME. The per-route backstops are shortened through their environment
 * overrides at FILE SCOPE (they are read per call, so this is in force before
 * the first request and restored in afterAll). Nothing here sleeps: waits are
 * either a real answer arriving or `until()` on a real observable.
 *
 *   bun test agent-engine/src/voice/voice-through.test.ts
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { fakeVoice, silentVoice, deadVoiceBase, pointVoiceAt, restoreVoiceUrls,
  type FakeVoice } from "../test-utils/fake-voice.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { until } from "../test-utils/wait.ts";

import { voiceRoutes } from "../routes/voice.ts";
import { JSON_BODY_MAX_BYTES, UPLOAD_BODY_MAX_BYTES } from "../storage/body-limits.ts";

/* ------------------------------------------------------- the shortened clocks
 *
 * FILE SCOPE, before any test runs, restored in afterAll: the convention this
 * suite holds to. Each is small enough that the three "a silent upstream is
 * bounded" specs cost a few hundred milliseconds between them instead of the
 * eighty-five seconds the shipped defaults would.
 *
 * They are still MEANINGFULLY different from each other, because the fact
 * being proven is that each route carries its OWN backstop: a single shared
 * number would let a regression that used the list timeout for tts pass. */
const SAVED = {
  list: process.env.VOICE_PROXY_LIST_TIMEOUT_MS,
  tts: process.env.VOICE_PROXY_TTS_TIMEOUT_MS,
  stt: process.env.RESCUE_STT_TIMEOUT_MS,
};
const LIST_MS = 200;
const TTS_MS = 320;
const STT_MS = 440;
process.env.VOICE_PROXY_LIST_TIMEOUT_MS = String(LIST_MS);
process.env.VOICE_PROXY_TTS_TIMEOUT_MS = String(TTS_MS);
process.env.RESCUE_STT_TIMEOUT_MS = String(STT_MS);

afterAll(() => {
  const put = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  put("VOICE_PROXY_LIST_TIMEOUT_MS", SAVED.list);
  put("VOICE_PROXY_TTS_TIMEOUT_MS", SAVED.tts);
  put("RESCUE_STT_TIMEOUT_MS", SAVED.stt);
  restoreVoiceUrls();
});

let voice: FakeVoice;
let srv: ServedRoutes;

beforeEach(() => {
  voice = fakeVoice();
  pointVoiceAt(voice.base);
  srv = serveRoutes({ groups: [voiceRoutes] });
});

afterEach(() => {
  srv.stop();
  voice.stop();
});

/* ------------------------------------------------------------ /voice/stt */

test("/voice/stt forwards the body through byte for byte and returns the upstream transcript", async () => {
  const bytes = new Uint8Array(256).fill(9);
  const res = await srv.fetch("/voice/stt", {
    method: "POST", headers: { "content-type": "audio/webm" }, body: bytes,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).text).toBe("hello from fake");

  // the SAME bytes the client sent reached the upstream, not re-shaped
  expect(voice.stt.length).toBe(1);
  expect(voice.stt[0].bytes.byteLength).toBe(256);
  expect([...voice.stt[0].bytes]).toEqual([...bytes]);
  /* AND THE TYPE THE CLIENT DECLARED. The upstream decoder picks its container
   * from this header; forwarding octet-stream instead is how a webm clip
   * arrives at whisper as "some bytes". */
  expect(voice.stt[0].contentType).toBe("audio/webm");
});

test("/voice/stt with no content-type still declares one to the voice engine", async () => {
  await srv.fetch("/voice/stt", { method: "POST", body: new Uint8Array([1, 2]) });
  /* fetch stamps its own type on a raw body, so the real proof is the fallback
   * branch: the route must never forward an EMPTY content-type, because the
   * upstream would then have nothing to pick a demuxer from. */
  expect(voice.stt[0].contentType).not.toBe("");
});

test("/voice/stt passes the whole query string through, ?offset included", async () => {
  const res = await srv.fetch("/voice/stt?offset=3.5&trace=abc", {
    method: "POST", body: new Uint8Array([1, 2, 3]),
  });
  expect(res.status).toBe(200);
  // the offset is what a resumed decode is keyed on; dropping it silently
  // re-transcribes the clip from zero and duplicates every word already sent
  expect(voice.stt[0].offset).toBe("3.5");
});

test("/voice/stt streams the body upstream before the client has finished sending", async () => {
  const first = new Uint8Array(16 * 1024).fill(7);
  const second = new Uint8Array(8 * 1024).fill(8);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      ctrl.enqueue(first);
      await gate; // the tail is held until the upstream has seen the head
      ctrl.enqueue(second);
      ctrl.close();
    },
  });

  const resP = srv.fetch("/voice/stt", {
    method: "POST", headers: { "content-type": "audio/webm" },
    body, duplex: "half",
  } as RequestInit);

  /* THE POINT: the first 16KB reach the voice engine while the client is still
   * sending. A proxy that buffered the clip before opening the upstream would
   * sit at zero here until release() below, and a long note would then start
   * decoding only after the last byte of a five minute recording. */
  await until(() => voice.sttBytesSoFar >= first.byteLength,
    { what: "the upstream to receive the head of the clip while the tail was held" });
  release();

  const res = await resP;
  expect(res.status).toBe(200);
  expect(voice.stt.length).toBe(1);
  expect(voice.stt[0].bytes.byteLength).toBe(first.byteLength + second.byteLength);
});

/* ------------------------------------------------------------ /voice/tts */

test("/voice/tts forwards the json and hands the upstream's audio back", async () => {
  const res = await srv.post("/voice/tts", { text: "hi", voice: "am_onyx" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/mpeg");
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xff, 0xfb, 0x90, 0x64]);
  expect(voice.tts.length).toBe(1);
  expect(voice.tts[0].text).toBe("hi");
  expect(voice.tts[0].voice).toBe("am_onyx");
});

test("/voice/tts stream:true passes the chunked audio straight through", async () => {
  const res = await srv.post("/voice/tts", { text: "hi", stream: true });
  expect(res.status).toBe(200);
  expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("FAKE-TTS");
  expect(voice.tts[0].stream).toBe(true);
});

test("/voice/tts stream:true delivers the first chunk before the upstream finishes", async () => {
  const release = voice.holdTts();
  const res = await srv.post("/voice/tts", { text: "hi", stream: true });
  expect(res.status).toBe(200);

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(dec.decode(first.value)).toBe("FAKE");

  /* THE UPSTREAM HAS STARTED AND NOT FINISHED. This is the whole of streamed
   * speech: a reply that takes ten seconds to generate has to start playing in
   * one. A proxy that collected the body before answering would give the same
   * bytes and the wrong product. */
  expect(voice.ttsStarted).toBe(true);
  expect(voice.ttsDone).toBe(false);

  release();
  expect(dec.decode((await reader.read()).value)).toBe("-TTS");
  expect((await reader.read()).done).toBe(true);
  expect(voice.ttsDone).toBe(true);
});

test("/voice/tts with a body that is not json is a 400 and nothing is forwarded", async () => {
  const res = await srv.fetch("/voice/tts", {
    method: "POST", headers: { "content-type": "application/json" }, body: "not json at all",
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("expected json");
  // a malformed control body must not become a request against the voice engine
  expect(voice.tts.length).toBe(0);
});

test("/voice/tts with an empty body is a 400, not an empty utterance", async () => {
  const res = await srv.fetch("/voice/tts", { method: "POST", body: "" });
  expect(res.status).toBe(400);
  expect(voice.tts.length).toBe(0);
});

/* ---------------------------------------------------------- /voice/voices */

test("/voice/voices returns the upstream's list unchanged", async () => {
  const res = await srv.get("/voice/voices");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ voices: ["af_heart", "am_onyx"], current: "af_heart" });
  expect(voice.voicesCalls).toBe(1);
});

/* ------------------------------------------- an upstream that answers badly */

test("an upstream error status is passed through, not dressed up as the proxy's own", async () => {
  voice.mode = "ERRORING";
  voice.errorStatus = 503;
  const res = await srv.get("/voice/voices");
  /* 503 IS THE TRUTH: the voice engine is up and refusing. Turning it into the
   * proxy's 502 ("I could not reach it") would send whoever is debugging to
   * the wrong machine. */
  expect(res.status).toBe(503);
});

/* ------------------------------------------------------ an upstream that is down */

test("a down voice engine is a clean 502 on /voice/voices, with an empty list to render", async () => {
  pointVoiceAt(deadVoiceBase());
  const res = await srv.get("/voice/voices");
  expect(res.status).toBe(502);
  const body = await res.json();
  // the app renders this list; an absent field is a crash where [] is a blank
  expect(body.voices).toEqual([]);
  expect(body.current).toBe("");
  expect(String(body.error)).not.toBe("");
});

test("a down voice engine is a clean 502 on /voice/stt", async () => {
  pointVoiceAt(deadVoiceBase());
  const res = await srv.fetch("/voice/stt", { method: "POST", body: new Uint8Array([1]) });
  // 502, not 504: connect-refused is "not there", which is a different thing to
  // tell the user than "there and too slow"
  expect(res.status).toBe(502);
});

test("a down voice engine is a clean 502 on /voice/tts", async () => {
  pointVoiceAt(deadVoiceBase());
  const res = await srv.post("/voice/tts", { text: "hi" });
  expect(res.status).toBe(502);
});

/* ------------------------- the model is still downloading (first install) */

test("a model-missing /voice/stt is a 503 with the reason, above the merely-down 502", async () => {
  /* server.ts's voiceGate returns this sentence when the whisper model files
   * are not on disk yet (needsModel && missingModelPath !== null); the route
   * must refuse with a 503 BEFORE it ever reaches the proxy, so the first
   * install sees "still downloading" instead of an opaque 502. */
  const message =
    "voice not ready: the transcription model ggml-large-v3-turbo.bin is still " +
    "downloading (42%); it is fetched in the background and this capability comes up when it lands";
  const gated = serveRoutes({
    groups: [voiceRoutes],
    ctx: { voiceGate: (cap) => (cap === "stt" ? message : null) },
  });
  try {
    /* The upstream is DOWN as well, so a route that proxied would answer 502.
     * The gate takes precedence: this proves the 503 is the model-missing case,
     * distinct from the merely-down 502 the section above asserts. */
    pointVoiceAt(deadVoiceBase());
    const res = await gated.fetch("/voice/stt", { method: "POST", body: new Uint8Array([1]) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe(message);
    expect(body.error).toContain("still downloading");
    // nothing reached the upstream: the refusal happened above the proxy
    expect(voice.stt.length).toBe(0);
  } finally { gated.stop(); }
});

/* ------------------------------- an upstream that is reachable and silent */

test("a silent voice engine ends /voice/voices on the LIST backstop, never a hang", async () => {
  const silent = silentVoice();
  pointVoiceAt(silent.base);
  try {
    const t0 = Date.now();
    const res = await srv.get("/voice/voices");
    const ms = Date.now() - t0;
    /* /voice/voices answers 502 for BOTH failures on purpose: the app needs a
     * renderable empty list either way, and there is no useful difference
     * between "no voice engine" and "a voice engine that will not list" for a
     * picker. The elapsed check is what says the backstop really ran rather
     * than something else giving up early. */
    expect(res.status).toBe(502);
    expect((await res.json()).voices).toEqual([]);
    expect(ms).toBeGreaterThanOrEqual(LIST_MS - 40);
    expect(ms).toBeLessThan(LIST_MS + 2_000);
  } finally { silent.stop(); }
});

test("a silent voice engine ends /voice/tts in a 504 on the TTS backstop", async () => {
  const silent = silentVoice();
  pointVoiceAt(silent.base);
  try {
    const t0 = Date.now();
    const res = await srv.post("/voice/tts", { text: "hi" });
    const ms = Date.now() - t0;
    expect(res.status).toBe(504);
    /* AND ON ITS OWN CLOCK. If tts had been given the list backstop it would
     * have answered by LIST_MS, which is why the two numbers differ. */
    expect(ms).toBeGreaterThanOrEqual(TTS_MS - 40);
    expect(ms).toBeLessThan(TTS_MS + 2_000);
  } finally { silent.stop(); }
});

test("a silent voice engine ends /voice/stt in a 504 on the stt backstop", async () => {
  const silent = silentVoice();
  pointVoiceAt(silent.base);
  try {
    const t0 = Date.now();
    const res = await srv.fetch("/voice/stt", { method: "POST", body: new Uint8Array([1]) });
    const ms = Date.now() - t0;
    expect(res.status).toBe(504);
    expect(ms).toBeGreaterThanOrEqual(STT_MS - 40);
    expect(ms).toBeLessThan(STT_MS + 2_000);
  } finally { silent.stop(); }
});

test("a HANGING voice engine that read the whole clip is still bounded", async () => {
  /* Different from silent: this upstream completed the HTTP exchange far enough
   * to swallow the entire body and then wedged. A backstop that only covered
   * connect would never fire here. */
  voice.mode = "HANGING";
  const t0 = Date.now();
  const res = await srv.fetch("/voice/stt", {
    method: "POST", headers: { "content-type": "audio/webm" },
    body: new Uint8Array(4096).fill(3),
  });
  expect(res.status).toBe(504);
  expect(Date.now() - t0).toBeLessThan(STT_MS + 2_000);
});

/* --------------------------------------------------------------- body caps */

const USER_AUDIO_CAP = UPLOAD_BODY_MAX_BYTES;
const JSON_CAP = JSON_BODY_MAX_BYTES;

/** A raw HTTP request with EXACTLY the headers given, so a test can declare a
 *  Content-Length it will not actually send. That is the only way to prove a
 *  refusal happened before the body was read: an honest 300MB upload would
 *  prove the same thing and cost 300MB. */
function rawHttp(port: number, reqLine: string, headers: Record<string, string>,
                 body?: Uint8Array): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let buf = "";
    void Bun.connect({
      hostname: "127.0.0.1", port,
      socket: {
        open(s) {
          const hdr = [`${reqLine} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            "Connection: close", "", ""].join("\r\n");
          s.write(hdr);
          if (body) s.write(body);
        },
        data(_s, chunk) { buf += chunk.toString(); },
        close() {
          const m = buf.match(/HTTP\/1\.1 (\d+)/);
          resolve({ status: m ? Number(m[1]) : -1, body: buf.slice(buf.indexOf("\r\n\r\n") + 4) });
        },
        error(_s, e) { reject(e); },
      },
    });
  });
}

test("an oversize /voice/stt body is a 413 and not one byte is forwarded", async () => {
  const r = await rawHttp(srv.port, "POST /voice/stt",
    { "content-type": "audio/webm", "content-length": String(USER_AUDIO_CAP + 1) },
    new Uint8Array([1, 2, 3]));
  expect(r.status).toBe(413);
  /* BEFORE FORWARDING is the load-bearing half. A proxy that opened the
   * upstream first and refused afterwards would push a 300MB stream at the
   * voice engine on every hostile request. */
  expect(voice.stt.length).toBe(0);
  expect(voice.sttBytesSoFar).toBe(0);
  /* The SENTENCE is not asserted here on purpose: at this size Bun's own
   * maxRequestBodySize answers its canned bodyless 413 before the handler is
   * ever entered (server.ts raises that ceiling to 320MB so the engine's own
   * cap is the one that speaks; serveRoutes keeps Bun's default). Which of the
   * two refused does not matter to the property being proven here -- nothing
   * reached the voice engine -- and the route's OWN refusal is proven exactly,
   * one test down. */
});

test("the /voice/stt cap is the route's own, with the cap in the answer", async () => {
  /* Called directly rather than over HTTP, because the only way to declare a
   * length larger than the cap without also tripping the server's ceiling is
   * to skip the server. This is the branch that runs in production, where
   * server.ts's 320MB maxRequestBodySize leaves room for the 300MB cap to be
   * the thing that speaks. */
  const req = new Request("http://127.0.0.1/voice/stt", {
    method: "POST",
    headers: { "content-type": "audio/webm", "content-length": String(USER_AUDIO_CAP + 1) },
    body: new Uint8Array([1, 2, 3]),
  });
  /* A loopback server shim: requireOwner runs at the route head now (content
   * rides the sealed channel or the host), so the direct call must present a
   * this-machine peer to reach the route's OWN body-cap 413 past the gate. */
  const localServer = { requestIP: () => ({ address: "127.0.0.1" }) } as unknown as import("bun").Server;
  const res = await voiceRoutes(
    {} as never, req, new URL(req.url), "/voice/stt", localServer);
  expect(res).not.toBeNull();
  expect(res!.status).toBe(413);
  const body = await res!.json();
  expect(body.error).toBe("body too large");
  // the cap is IN the answer: a client that gets a bare 413 cannot tell the
  // user how long a note this engine will take
  expect(body.max).toBe(USER_AUDIO_CAP);
  expect(voice.stt.length).toBe(0);
});

/* The exact-cap boundary (a clip of precisely USER_AUDIO_CAP bytes must NOT be
 * refused) is body-limits' row, proven there against declaredBodyTooLarge
 * directly. Proving it here would mean either moving 300MB or declaring a
 * length and never sending it, and the second one leaves the socket waiting
 * for a body that never comes, which is a hung test rather than a proof. */

test("an oversize /voice/tts json is a 413 and nothing is forwarded", async () => {
  const big = JSON.stringify({ text: "x".repeat(JSON_CAP + 1) });
  const r = await rawHttp(srv.port, "POST /voice/tts",
    { "content-type": "application/json", "content-length": String(Buffer.byteLength(big)) },
    Buffer.from(big));
  expect(r.status).toBe(413);
  expect(r.body).toContain("body too large");
  expect(voice.tts.length).toBe(0);
});

/* ----------------------------------------------- the sealed-channel gate */

test("an unsealed content GET/POST to /voice/* is a uniform 403, and nothing reaches the voice engine", async () => {
  /* User speech, reply audio and the voice list are CONTENT: they ride the
   * sealed tunnel or come from the engine host itself (requireOwner). A
   * cross-host HTTP request -- the `tailscale serve` shape, a loopback TCP peer
   * carrying x-forwarded-for -- is refused at the route head, BEFORE the proxy
   * dials the voice engine, with the same body every content route gives. */
  const XFF = { "x-forwarded-for": "100.64.0.9" };
  const calls: [string, RequestInit][] = [
    ["/voice/stt", { method: "POST", headers: { "content-type": "audio/webm", ...XFF }, body: new Uint8Array([1, 2, 3]) }],
    ["/voice/tts", { method: "POST", headers: { "content-type": "application/json", ...XFF }, body: JSON.stringify({ text: "hi" }) }],
    ["/voice/voices", { method: "GET", headers: { ...XFF } }],
  ];
  for (const [path, init] of calls) {
    const res = await srv.fetch(path, init);
    expect(res.status, `${path} answered an unsealed cross-host request`).toBe(403);
    expect((await res.json()).error).toContain("sealed channel");
  }
  expect(voice.stt.length, "a refused /voice/stt still reached the voice engine").toBe(0);
  expect(voice.tts.length, "a refused /voice/tts still reached the voice engine").toBe(0);
});
