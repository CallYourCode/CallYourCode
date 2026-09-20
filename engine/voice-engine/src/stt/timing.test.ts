/* The per-request timing the engine logs come from (#575).
 *
 *   bun test src/stt/timing.test.ts
 *
 * The voice engine already kept a rolling rtf for /health; this proves it now
 * also hands each REQUEST its own split, so agent-engine can log queue vs synth
 * vs decode instead of only its own wall time. /tts carries the timings in
 * response HEADERS (the body is binary mp3 every reader wants whole); /stt
 * carries them in a `timing` block added to its JSON (an additive field its two
 * existing readers ignore).
 *
 * WHAT IS REAL. A real voice engine (server.ts) on a private port, talking to a
 * STUB that stands in for both kokoro and whisper, the same shape
 * stt-deadlock.test.ts uses. No real speech and none of the shared :10103/:10104
 * services are touched: what is under test is the timing plumbing, not audio.
 */
import { afterEach, expect, test } from "bun:test";
import { writeWav } from "../audio/silence";

/* One stub for both upstreams: kokoro's speech endpoint (returns mp3-ish bytes)
 * and whisper's transcription endpoint (returns a fixed transcript). */
function startStub() {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return new Response("ok");
      if (u.pathname === "/v1/audio/speech") {
        await req.arrayBuffer();
        // a few bytes standing in for an mp3; the engine buffers and returns them
        return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02]),
          { headers: { "content-type": "audio/mpeg" } });
      }
      if (u.pathname === "/v1/audio/transcriptions") {
        await req.arrayBuffer();
        return Response.json({ text: "hello there" });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

type Engine = { port: number; stop: () => void; stderr: () => Promise<string> };
async function startEngine(stubUrl: string): Promise<Engine> {
  const port = 8371 + Math.floor(Number(process.hrtime.bigint() % 8n)); // 8371-8378
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: {
      ...process.env,
      VOICE_PORT: String(port), VOICE_HOST: "127.0.0.1",
      VOICE_SHERPA_STUB_URL: stubUrl, // one stub answers both /v1/audio/speech and /transcriptions
      VOICE_SELFCHECK: "0",
    },
    stdout: "ignore", stderr: "pipe",
  });
  let ok = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ok = true; break; } } catch {}
    await Bun.sleep(100);
  }
  if (!ok) throw new Error("voice engine did not come up:\n" + (await new Response(proc.stderr).text()));
  return { port, stop: () => proc.kill(), stderr: () => new Response(proc.stderr).text() };
}

/** A tiny real WAV (0.5 s tone): a decodable clip that is not silence. */
function clip(): Uint8Array {
  const n = 8000;
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(2000 * Math.sin((2 * Math.PI * 200 * i) / 16000));
  return writeWav(s);
}
const CLIP = clip();

let stub: ReturnType<typeof startStub> | null = null;
let engine: Engine | null = null;
afterEach(() => { engine?.stop(); engine = null; stub?.stop(); stub = null; });

test("/tts carries the per-request timing in response headers", async () => {
  stub = startStub();
  engine = await startEngine(stub.url);

  const res = await fetch(`http://127.0.0.1:${engine.port}/tts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello world" }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("x-voice-op")).toBe("tts");
  expect(res.headers.get("x-voice-chars")).toBe("11"); // "hello world"
  // every timing header is present and parses to a finite number
  for (const h of ["x-voice-ttfb-ms", "x-voice-synth-ms", "x-voice-audio-s", "x-voice-rtf"]) {
    const v = res.headers.get(h);
    expect(v).not.toBeNull();
    expect(Number.isFinite(Number(v))).toBe(true);
  }
  // synth includes the transfer, so it is >= first byte
  expect(Number(res.headers.get("x-voice-synth-ms"))).toBeGreaterThanOrEqual(
    Number(res.headers.get("x-voice-ttfb-ms")));
  // the body is a non-empty mp3 the engine encoded from the stub's PCM
  expect(res.headers.get("content-type")).toContain("audio/mpeg");
  expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
}, 30_000);

test("/stt carries the queue/decode split in a timing block", async () => {
  stub = startStub();
  engine = await startEngine(stub.url);

  const res = await fetch(`http://127.0.0.1:${engine.port}/stt`, {
    method: "POST", headers: { "Content-Type": "audio/wav" },
    body: CLIP as unknown as ArrayBuffer,
    signal: AbortSignal.timeout(10_000),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  // the transcript is unchanged from before
  expect(body.text).toBe("hello there");
  // and the new, additive timing block is present and numeric
  expect(body.timing).toBeDefined();
  expect(typeof body.timing.queueMs).toBe("number");
  expect(typeof body.timing.decodeMs).toBe("number");
  expect(typeof body.timing.audioS).toBe("number");
  expect(body.timing.audioS).toBeGreaterThan(0);
  expect(typeof body.timing.rtf).toBe("number");
}, 30_000);
