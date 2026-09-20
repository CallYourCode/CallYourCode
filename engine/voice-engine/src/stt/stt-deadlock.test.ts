/* The batch /stt deadlock and the honest health probe (#551).
 *
 *   bun test src/stt/stt-deadlock.test.ts
 *
 * THE INCIDENT. The voice engine was up ~10 days when every POST /stt began to
 * hang 120s+, while whisper on :10103 answered the same file directly in 1.2s: a
 * wedge INSIDE the engine's batch path, not in whisper. Restarting the engine
 * fixed it instantly. Through the whole wedge /health said ok, because /health
 * did no real work. The exact leak: `decodeWindow`'s ffmpeg had no timeout and
 * the batch path had no concurrency bound, so a hung decode held its child, fds
 * and buffers for ever and, unbounded, the hung ones piled up until a shared
 * resource ran out and every later request wedged.
 *
 * WHAT IS REAL HERE. A real voice engine (server.ts) on a private port, talking
 * to a STUB whisper the test can make hang, delay, or answer fast. No real
 * speech is transcribed and the shared :10103 / :10105 services are never touched;
 * what is under test is the queue/timeout mechanics, not transcript quality (the
 * same rule longnote.test.ts states). Clips are tiny in-process WAVs.
 */
import { afterEach, expect, test } from "bun:test";
import { writeWav } from "../audio/silence";

/* ----------------------------------------------------------- stub whisper */

type Ctl = { mode: "fast" | "hang" | number; count: number };
function startStub(ctl: Ctl) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return new Response("ok");
      if (u.pathname === "/v1/audio/transcriptions") {
        await req.arrayBuffer(); // drain so nothing buffers
        ctl.count++;
        if (ctl.mode === "hang") await new Promise(() => {}); // never resolves
        else if (typeof ctl.mode === "number") await Bun.sleep(ctl.mode);
        return Response.json({ text: "ok" });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/* ------------------------------------------------------------- the engine */

type Engine = { port: number; stop: () => void; stderr: () => Promise<string>; proc: import("bun").Subprocess };
async function startEngine(whisperUrl: string, env: Record<string, string>): Promise<Engine> {
  const port = 8381 + Math.floor(Number(process.hrtime.bigint() % 8n)); // 8381-8388, per the brief
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: {
      ...process.env,
      VOICE_PORT: String(port), VOICE_HOST: "127.0.0.1",
      VOICE_SHERPA_STUB_URL: whisperUrl, // stub answers /v1/audio/transcriptions; 404s /speech so the TTS probe fails on its own counter
      VOICE_SELFCHECK: "0", // default is ON now; opt out so tests stay isolated
      VOICE_TTS_WATCHDOG: "0", // never spawn systemctl against a live unit from these tests
      ...env, // a test that enables the self-check (VOICE_SELFCHECK: "1") overrides this
    },
    stdout: "ignore", stderr: "pipe",
  });
  let ok = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ok = true; break; } } catch {}
    await Bun.sleep(100);
  }
  if (!ok) throw new Error("voice engine did not come up:\n" + (await new Response(proc.stderr).text()));
  return { port, proc, stop: () => proc.kill(), stderr: () => new Response(proc.stderr).text() };
}

/** A tiny real WAV (a 0.5 s tone): a decodable clip that is not silence. */
function clip(): Uint8Array {
  const n = 8000;
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(2000 * Math.sin((2 * Math.PI * 200 * i) / 16000));
  return writeWav(s);
}
const CLIP = clip();

async function postStt(port: number, timeoutMs = 30_000): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/stt`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: CLIP as unknown as ArrayBuffer,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function getHealth(port: number): Promise<any> {
  return (await fetch(`http://127.0.0.1:${port}/health`)).json();
}

let stub: ReturnType<typeof startStub> | null = null;
let engine: Engine | null = null;
afterEach(() => { engine?.stop(); engine = null; stub?.stop(); stub = null; });

/* --------------------------------------------------------------- proofs */

// THE CORE PROPERTY. A hung upstream fails the ONE request within a bounded time
// and the very next request succeeds: a single bad request cannot wedge later
// ones. Before the fix the whisper fetch had a timeout but ffmpeg did not and
// nothing was bounded; the point here is the request path fails fast and frees.
test("a hung upstream fails one request fast and never wedges the next", async () => {
  const ctl: Ctl = { mode: "hang", count: 0 };
  stub = startStub(ctl);
  engine = await startEngine(stub.url, { VOICE_WHISPER_TIMEOUT_MS: "1200", VOICE_FFMPEG_TIMEOUT_MS: "5000" });

  const t0 = performance.now();
  const bad = await postStt(engine.port, 10_000);
  const badMs = performance.now() - t0;
  expect(bad.status).toBe(502); // failed loudly, not hung
  expect(badMs).toBeLessThan(6_000); // bounded by the whisper timeout, not 120s+

  // The engine is NOT wedged: flip the upstream healthy and the next request wins.
  ctl.mode = "fast";
  const good = await postStt(engine.port, 10_000);
  expect(good.status).toBe(200);
  expect(good.body.text).toBe("ok");
}, 30_000);

// The bounded concurrency gate: with one slot and a slow upstream, a second
// concurrent request FAILS with 503 within the queue wait instead of piling up.
test("a full engine fails extra requests with 503, not an unbounded queue", async () => {
  const ctl: Ctl = { mode: 1500, count: 0 }; // each decode holds its slot ~1.5s
  stub = startStub(ctl);
  engine = await startEngine(stub.url, { VOICE_BATCH_MAX: "1", VOICE_BATCH_QUEUE_WAIT_MS: "300" });

  const [a, b] = await Promise.all([postStt(engine.port, 10_000), postStt(engine.port, 10_000)]);
  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([200, 503]); // one served, one refused loudly
  const busy = a.status === 503 ? a : b;
  expect(String(busy.body.error)).toContain("busy");
}, 30_000);

// THE LEAK ITSELF, with teeth. The whole lane exists to guarantee the batch
// slot is RETURNED after every request. With a single slot and a fast upstream,
// four requests run STRICTLY one after another: each finishes (and must free its
// slot) before the next starts, so all four win. Remove the `finally`
// release in the /stt handler and this goes red at the second request: the first
// leaks the only slot, inFlight stays 1, and every follow-up 503s within the
// queue wait. The earlier tests never send a follow-up that needs the slot back,
// so they stay green with the leak; this one bites.
test("a returned slot serves the next request: sequential /stt never runs out of slots", async () => {
  const ctl: Ctl = { mode: "fast", count: 0 };
  stub = startStub(ctl);
  engine = await startEngine(stub.url, { VOICE_BATCH_MAX: "1", VOICE_BATCH_QUEUE_WAIT_MS: "300" });

  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await postStt(engine.port, 10_000); // awaited: at most one in flight at a time
    statuses.push(r.status);
  }
  // All four served: the single slot was returned after each request. If the
  // release is leaked, this is [200, 503, 503, 503].
  expect(statuses).toEqual([200, 200, 200, 200]);
}, 30_000);

// /health STOPS LYING. With the self-check on and the upstream hung, /health
// flips to degraded; when the upstream recovers it flips back to ok. Exit is
// disabled so the engine stays up for the assertions.
test("the health self-check flips to degraded on a wedged path and back on recovery", async () => {
  const ctl: Ctl = { mode: "hang", count: 0 };
  stub = startStub(ctl);
  engine = await startEngine(stub.url, {
    VOICE_SELFCHECK: "1", VOICE_SELFCHECK_INTERVAL_MS: "400",
    VOICE_SELFCHECK_DEADLINE_MS: "1200", VOICE_SELFCHECK_EXIT: "0",
    VOICE_WHISPER_TIMEOUT_MS: "900", VOICE_FFMPEG_TIMEOUT_MS: "5000",
  });

  // Boots healthy (no self-check has failed yet), then degrades once the first
  // real round trip against the hung upstream fails.
  let degraded = false;
  for (let i = 0; i < 40; i++) {
    const h = await getHealth(engine.port);
    if (h.degraded === true && h.ok === false && h.selfcheck?.ok === false) { degraded = true; break; }
    await Bun.sleep(200);
  }
  expect(degraded).toBe(true);
  {
    const h = await getHealth(engine.port);
    // The stub 404s /v1/audio/speech, so the TTS probe fails on its own counter.
    expect(h.selfcheck.tts.ok).toBe(false);
    expect(h.selfcheck.ttsConsecutiveFail).toBeGreaterThan(0);
  }

  // Recover the upstream: the next self-check succeeds and /health returns to ok.
  ctl.mode = "fast";
  let recovered = false;
  for (let i = 0; i < 40; i++) {
    const h = await getHealth(engine.port);
    if (h.ok === true && h.degraded === false && h.selfcheck?.ok === true) {
      expect(typeof h.selfcheck.lastLatencyMs).toBe("number");
      expect(h.selfcheck.lastSuccessAt).toBeGreaterThan(0);
      // STT recovered; TTS is still a separate failing counter.
      expect(h.selfcheck.tts.ok).toBe(false);
      expect(h.selfcheck.ttsConsecutiveFail).toBeGreaterThan(0);
      recovered = true;
      break;
    }
    await Bun.sleep(200);
  }
  expect(recovered).toBe(true);
}, 30_000);
