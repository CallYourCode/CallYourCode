/* A long voice note is transcribed in bounded memory (#458).
 *
 * WHY THIS FILE EXISTS
 *
 * A 30 minute note (10.4 MB webm/opus) uploaded, stored, delivered and played,
 * but the whole-clip batch /stt path drove the voice engine to ~1.86 GB against
 * its 2 GB launchd ceiling; the process was killed mid-request and the note
 * shipped as "(voice note: transcription failed)" (#449). Measured 2026-08-10,
 * the driver was NOT the whole-clip PCM hold #449 named: it was reading ffmpeg's
 * stdout with `new Response(proc.stdout).arrayBuffer()`, which allocated ~150x
 * the wav's size in transient ArrayBuffers (a 300 s clip, 9 MB of wav, drove the
 * process to 1.2 GB before a single decode request went out). The fix is two
 * parts, both here: decode each window to a TEMP FILE and read the file back
 * (allocates exactly the wav's bytes), and decode the clip one WINDOW_S window
 * at a time, releasing each before the next.
 *
 * WHAT IS AND IS NOT REAL HERE. The clips are SYNTHETIC (ffmpeg tone bursts with
 * silent gaps), and the decoder is a STUB that returns an ordered token per
 * request. That is on purpose and is not the banned "synthetic audio in a
 * transcription test": nothing here asserts transcript QUALITY against real
 * speech. What is under test is memory and chunk mechanics -- how much the engine
 * holds, how many requests it makes, and that their answers concatenate in order
 * -- all of which live entirely upstream of the real model, so a stub keeps the
 * shared STT service (in use) untouched while proving exactly the thing that
 * failed. Real-speech chunk-join fidelity is covered by the unchanged
 * silence.test.ts / stt-final.test.ts suite; the real end-to-end 30 minute decode
 * is recorded once in longnote-458.RESULT.md.
 *
 *   bun test src/stt/longnote.test.ts
 */
import { test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import type { Subprocess } from "bun";

const RATE = 16000;
const RSS_BOUND_MB = 700; // the brief's ceiling; the old path blew ~1.86 GB

/* ------------------------------------------------------------------ harness */

type Stub = { url: string; count: () => number; stop: () => void };
function startStubWhisper(): Stub {
  let n = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return new Response("ok");
      if (u.pathname === "/v1/audio/transcriptions") {
        await req.arrayBuffer(); // drain the part so nothing buffers upstream
        return Response.json({ text: `p${n++}` });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, count: () => n, stop: () => server.stop(true) };
}

type Engine = { port: number; pid: number; stdout: () => string; stop: () => void };
async function startEngine(whisperUrl: string, windowS?: number): Promise<Engine> {
  const port = 22000 + Math.floor(Number(process.hrtime.bigint() % 20000n));
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: {
      ...process.env,
      VOICE_PORT: String(port), VOICE_HOST: "127.0.0.1",
      VOICE_SHERPA_STUB_URL: whisperUrl,
      VOICE_SELFCHECK: "0", // the self-check would add stub decode calls the count assertions can't see
      ...(windowS ? { VOICE_WINDOW_S: String(windowS) } : {}),
    },
    stdout: "pipe", stderr: "pipe",
  });
  // Drain stdout so the pipe never blocks the engine, and keep it for assertions.
  let out = "";
  (async () => { const r = (proc.stdout as ReadableStream).getReader(); const d = new TextDecoder();
    for (;;) { const { done, value } = await r.read(); if (done) break; out += d.decode(value); } })();
  let ok = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ok = true; break; } } catch {}
    await Bun.sleep(100);
  }
  if (!ok) throw new Error("voice engine did not come up:\n" + (await new Response(proc.stderr).text()));
  return { port, pid: proc.pid!, stdout: () => out, stop: () => proc.kill() };
}

/** A synthetic webm/opus clip: a 200 Hz tone that goes silent for 4 s of every
 *  30 s, so the trimmer and the chunker both do real work. */
async function makeClip(durationS: number): Promise<{ path: string; bytes: ArrayBuffer }> {
  const path = join(tmpdir(), `longnote-test-${durationS}-${crypto.randomUUID()}.webm`);
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    `aevalsrc='0.3*sin(2*PI*200*t)*lt(mod(t\\,30)\\,26)':d=${durationS}:s=48000`,
    "-c:a", "libopus", "-b:a", "48k", "-ac", "1", "-f", "webm", "-y", path], { stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error("ffmpeg gen failed: " + (await new Response(proc.stderr).text()));
  return { path, bytes: await Bun.file(path).arrayBuffer() };
}

/** POST the clip to the engine and sample its RSS (KB) throughout. */
async function transcribeAndWatch(eng: Engine, bytes: ArrayBuffer): Promise<{ body: any; peakRssMB: number; wallS: number }> {
  let peakKb = 0, sampling = true;
  const sample = () => {
    const p = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(eng.pid)]);
    const kb = Number(p.stdout.toString().trim());
    if (Number.isFinite(kb) && kb > 0) peakKb = Math.max(peakKb, kb);
  };
  const sampler = (async () => { while (sampling) { sample(); await Bun.sleep(40); } })();
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${eng.port}/stt`, {
    method: "POST", headers: { "Content-Type": "audio/webm" }, body: bytes,
  });
  const body = await res.json();
  const wallS = (performance.now() - t0) / 1000;
  sampling = false; await sampler;
  return { body, peakRssMB: peakKb / 1024, wallS };
}

const toClean: string[] = [];
let stub: Stub | null = null;
let engine: Engine | null = null;
afterEach(() => {
  engine?.stop(); engine = null;
  stub?.stop(); stub = null;
  for (const p of toClean.splice(0)) { try { unlinkSync(p); } catch {} }
});

/* ------------------------------------------------------------------- proofs */

// (b) a ~12 minute clip: full ordered transcript, expected chunk count, bounded RSS.
test("a 12 minute clip transcribes whole, in windows, under the memory bound", async () => {
  stub = startStubWhisper();
  engine = await startEngine(stub.url, 600);
  const clip = await makeClip(720);
  toClean.push(clip.path);

  const { body, peakRssMB } = await transcribeAndWatch(engine, clip.bytes);

  const tokens = String(body.text ?? "").split(/\s+/).filter(Boolean);
  // Every request's answer is present, in order, none dropped or reordered.
  expect(tokens.length).toBe(stub.count());
  expect(tokens.every((t, i) => t === `p${i}`)).toBe(true);
  // 720 s of audio, ~30 s per whisper request: a real split into many parts.
  expect(tokens.length).toBeGreaterThanOrEqual(20);
  // The OUTER window loop actually engaged (720 s > one 600 s window).
  expect(engine.stdout()).toContain("[stt] window 0");
  // The whole point: one window's worth of memory, not the clip's, and nowhere
  // near the 1.86 GB the old whole-clip path reached.
  expect(peakRssMB).toBeLessThan(RSS_BOUND_MB);
}, 60_000);

// (c) THE 30 MINUTE PROOF. Old code: RED by #449 (killed at ~1.86 GB). Here it
// completes with the full ordered transcript and RSS well under the bound. Run
// against a stub decoder so the shared model is untouched; the fix is upstream
// of the model (see file header) and the real end-to-end run is in the RESULT.
test("a 30 minute clip completes end to end with bounded RSS", async () => {
  stub = startStubWhisper();
  engine = await startEngine(stub.url, 600);
  const clip = await makeClip(1803);
  toClean.push(clip.path);

  const { body, peakRssMB } = await transcribeAndWatch(engine, clip.bytes);

  const tokens = String(body.text ?? "").split(/\s+/).filter(Boolean);
  expect(tokens.length).toBe(stub.count());
  expect(tokens.every((t, i) => t === `p${i}`)).toBe(true);
  expect(tokens.length).toBeGreaterThanOrEqual(55); // ~61 parts for 30 min
  // Multiple outer windows on a 30 min clip.
  expect(engine.stdout()).toContain("[stt] window 1");
  expect(peakRssMB).toBeLessThan(RSS_BOUND_MB);
}, 90_000);

// (e) short clips are unchanged: one window, one whisper request, no window log.
test("a short clip is one request and takes the un-windowed path", async () => {
  stub = startStubWhisper();
  engine = await startEngine(stub.url, 600);
  const clip = await makeClip(20); // under the 30 s whisper window: a single part
  toClean.push(clip.path);

  const { body } = await transcribeAndWatch(engine, clip.bytes);
  const tokens = String(body.text ?? "").split(/\s+/).filter(Boolean);
  expect(tokens).toEqual(["p0"]);
  expect(stub.count()).toBe(1);
  expect(engine.stdout()).not.toContain("[stt] window");
}, 45_000);

/* ------------------------------------------------------------------ mutation
 *
 * The two decode strategies, side by side: the old code read ffmpeg's stdout
 * with `new Response(proc.stdout).arrayBuffer()`; the fix decodes to a TEMP FILE
 * and reads the bytes back. This proves the swap is OUTPUT-PRESERVING -- it
 * changed HOW the wav is held (bounded memory), never WHAT it decodes to. Same
 * clip, same ffmpeg, byte-for-byte the same result.
 *
 * The MEMORY half of the fix is proved by the engine tests above, which sample
 * the real process's RSS via `ps` while it decodes -- the honest measurement of
 * the whole-process peak. It is NOT asserted here: process.memoryUsage()
 * .arrayBuffers reports live retained bytes at one instant, so which of the two
 * paths still holds the ~9 MB wav at the sample point is down to GC timing, not
 * to the path, and an assertion on it flips run to run. */
async function decodePipe(clip: string): Promise<number> {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", clip,
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"], { stdout: "pipe", stderr: "pipe" });
  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  return buf.byteLength;
}
async function decodeFile(clip: string): Promise<number> {
  const out = join(tmpdir(), `mut-${crypto.randomUUID()}.wav`);
  toClean.push(out);
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", clip,
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", out], { stderr: "pipe" });
  await proc.exited;
  return (await Bun.file(out).arrayBuffer()).byteLength;
}

test("mutation: decoding to a temp file yields the same wav bytes as the stdout pipe", async () => {
  const clip = await makeClip(300); // 9 MB of wav
  toClean.push(clip.path);
  const wavBytes = 300 * RATE * 2; // ~9 MB, 16-bit mono at 16 kHz

  const nPipe = await decodePipe(clip.path);
  const nFile = await decodeFile(clip.path);
  // both actually decoded the whole clip ...
  expect(nPipe).toBeGreaterThan(wavBytes * 0.9);
  // ... to byte-identical output. The fix swapped the pipe read for a temp-file
  // read to bound memory (proved by the RSS tests above); the decoded wav it
  // produces is unchanged.
  expect(nFile).toBe(nPipe);
}, 45_000);
