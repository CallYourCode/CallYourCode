/* NO DUPLICATE DECODE, AND A GIVEN-UP DECODE STOPS (#stt-busy).
 *
 *   bun test src/stt/inflight-decode.test.ts
 *
 * THE INCIDENT. On 2026-09-28 one 166.6 s voice note was decoded THREE times at
 * once -- the agent engine's deferred-words POST plus the app's own batch
 * fallback POSTing its local copy (and retrying it) -- each holding one of the
 * three batch slots for the ~166 s the clip takes, so the seven- and ten-second
 * notes behind them found no slot and shipped "(voice note: transcription
 * failed)". Two properties close that, both proved here against a REAL engine:
 *
 *   1. Two identical concurrent POSTs decode ONCE. The stub whisper is asked
 *      once, not twice, and both callers get the one transcript.
 *   2. A caller that gives up (closes the socket, as the agent engine does when
 *      its deadline passes) stops the decode instead of letting it burn the
 *      decoder to the end -- so the slot comes back and the parts it never
 *      needed are never sent to whisper.
 *
 * WHAT IS REAL: a real voice engine (server.ts) on a private port, its real
 * ffmpeg windowing and part-splitting, talking to a STUB whisper the test can
 * make slow and can count. No real speech and no shared :10103/:10105 services;
 * the mechanics are the whole point, the same footing stt-deadlock.test.ts uses.
 */
import { afterEach, expect, test } from "bun:test";
import { writeWav } from "../audio/silence";

/* ----------------------------------------------------------- stub whisper */

type Ctl = { delayMs: number; count: number };
function startStub(ctl: Ctl) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return new Response("ok");
      if (u.pathname === "/v1/audio/transcriptions") {
        await req.arrayBuffer();
        ctl.count++;
        if (ctl.delayMs > 0) await Bun.sleep(ctl.delayMs);
        return Response.json({ text: "part" });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/* ------------------------------------------------------------- the engine */

type Engine = { port: number; stop: () => void; stderr: () => Promise<string>; proc: import("bun").Subprocess };
async function startEngine(whisperUrl: string, env: Record<string, string>): Promise<Engine> {
  const port = 8371 + Math.floor(Number(process.hrtime.bigint() % 8n)); // 8371-8378, private
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: {
      ...process.env,
      VOICE_PORT: String(port), VOICE_HOST: "127.0.0.1",
      VOICE_SHERPA_STUB_URL: whisperUrl,
      VOICE_SELFCHECK: "0",
      VOICE_TTS_WATCHDOG: "0",
      ...env,
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

/** A real WAV of `s` seconds of a steady tone: uniformly loud, so chunkAtQuiet
 *  cuts it into whisper-window parts (one stub call each). */
function tone(seconds: number): Uint8Array {
  const n = Math.round(seconds * 16000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  return writeWav(pcm);
}
// Over the 2 s salvage probe (SALVAGE_PROBE_S) so a single decode is a single
// stub call: a sub-2 s clip looks like a broken container and gets a second,
// salvage re-mux decode, which would make "decoded once" ambiguous.
const SHORT = tone(3);   // one part, one stub call
const LONG = tone(100);  // several whisper-window parts

async function postStt(port: number, body: Uint8Array, opts: { signal?: AbortSignal } = {}):
  Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/stt`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: body as unknown as ArrayBuffer,
    signal: opts.signal,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let stub: ReturnType<typeof startStub> | null = null;
let engine: Engine | null = null;
afterEach(() => { engine?.stop(); engine = null; stub?.stop(); stub = null; });

/* --------------------------------------------------------------- proofs */

// Two identical concurrent POSTs are ONE decode. With a single slot and a slow
// stub, the old code would have 503'd the second (no slot) or, with more slots,
// decoded the same clip twice; now the second JOINS the first and both win with
// one stub call.
test("two identical concurrent decodes collapse into one", async () => {
  const ctl: Ctl = { delayMs: 800, count: 0 };
  stub = startStub(ctl);
  engine = await startEngine(stub.url, { VOICE_BATCH_MAX: "1", VOICE_BATCH_QUEUE_WAIT_MS: "200" });

  const [a, b] = await Promise.all([postStt(engine.port, SHORT), postStt(engine.port, SHORT)]);
  expect(a.status, "the first identical request did not succeed").toBe(200);
  expect(b.status,
    "the second identical request was refused or ran its own decode instead of joining the first")
    .toBe(200);
  expect(a.body.text).toBe(b.body.text);
  expect(ctl.count, "the same clip was decoded twice instead of once").toBe(1);
}, 30_000);

// A distinct clip is NOT joined: the concurrency bound still bites, so a second
// DIFFERENT clip against a single busy slot is refused with 503. This is the
// dedup's boundary -- only identical clips share.
test("a different clip against a full engine still gets a clean 503", async () => {
  const ctl: Ctl = { delayMs: 1500, count: 0 };
  stub = startStub(ctl);
  engine = await startEngine(stub.url, { VOICE_BATCH_MAX: "1", VOICE_BATCH_QUEUE_WAIT_MS: "300" });

  const [a, b] = await Promise.all([postStt(engine.port, SHORT), postStt(engine.port, tone(3.5))]);
  const statuses = [a.status, b.status].sort();
  expect(statuses, "two distinct clips did not contend for the one slot").toEqual([200, 503]);
}, 30_000);

// A caller that gives up mid-decode stops it. First measure how many parts the
// long clip decodes to when left alone; then abort a fresh decode of it partway
// and show FEWER parts reached whisper -- the decode stopped instead of burning
// the decoder to the end -- and the slot came back for the next request.
test("a decode the caller gave up on stops early and frees the slot", async () => {
  const ctl: Ctl = { delayMs: 1000, count: 0 };
  stub = startStub(ctl);
  engine = await startEngine(stub.url, { VOICE_BATCH_MAX: "1", VOICE_BATCH_QUEUE_WAIT_MS: "5000" });

  // How many parts the long clip is, decoded to the end and left alone.
  const full = await postStt(engine.port, LONG);
  expect(full.status).toBe(200);
  const fullParts = ctl.count;
  expect(fullParts, "the long clip did not split into several whisper-window parts")
    .toBeGreaterThan(2);

  // Now abort a fresh decode of the same clip partway through.
  ctl.count = 0;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500); // after ~part 1, during part 2
  await expect(postStt(engine.port, LONG, { signal: ac.signal }),
    "the aborted request did not reject on the client side").rejects.toThrow();

  // Give the engine a moment to notice the disconnect and unwind.
  await Bun.sleep(600);
  expect(ctl.count,
    "the decode kept running every part after the caller gave up, burning the decoder for " +
    "nobody").toBeLessThan(fullParts);

  // The slot came back: the next request is served rather than 503'd or wedged.
  const after = await postStt(engine.port, SHORT);
  expect(after.status, "the slot was not freed when the decode was cancelled").toBe(200);
}, 40_000);
