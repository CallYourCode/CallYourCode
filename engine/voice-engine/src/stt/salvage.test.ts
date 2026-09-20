/* A voice note whose WebM container broke around an engine restart is salvaged
 * (task 594).
 *
 * WHY THIS FILE EXISTS
 *
 * A note recorded around an engine restart arrives with its EBML head intact but
 * a CLUSTER whose timecode has jumped far into the future: tonight's specimen
 * 6f175999 held two comfort-noise frames at t=0, then a cluster at t=2068.98s
 * carrying 4.26s of real speech. ffprobe reports duration=N/A -- which EVERY
 * streaming MediaRecorder webm does, so it is no signal -- and `decodeWindow`'s
 * `-t <durS>` bound cuts by OUTPUT timestamp, so ffmpeg emitted only the 0.12s
 * before the jump and stopped. Whisper decoded 0.12s of near-silence and the note
 * shipped empty (audioS=0.12, chars=0), again and again on restarts.
 *
 * The fix (server.ts): when a decode recovers far less audio than the file could
 * hold, do ONE tolerant re-mux (`-err_detect ignore_err`, full transcode to PCM
 * so timestamps are regenerated) and window the repaired file, tagging the
 * response `mode: "salvaged"`.
 *
 * WHAT IS AND IS NOT REAL HERE. The clip is SYNTHETIC (an ffmpeg tone whose
 * cluster timecodes are rewritten to reproduce the specimen's jump) and the
 * decoder is a STUB returning an ordered token per request -- the same contract
 * as longnote.test.ts. Nothing here asserts transcript QUALITY against real
 * speech: what is under test is that a container which the windowed path reads as
 * 0.5s is re-muxed and re-read as its full ~4.2s and yields words. The real
 * specimen's 0.12s -> 4.26s recovery through actual ffmpeg is recorded in
 * LANE-DONE.md.
 *
 *   bun test src/stt/salvage.test.ts
 */
import { test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

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
async function startEngine(whisperUrl: string, windowS: number): Promise<Engine> {
  const port = 22000 + Math.floor(Number(process.hrtime.bigint() % 20000n));
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: {
      ...process.env,
      VOICE_PORT: String(port), VOICE_HOST: "127.0.0.1",
      VOICE_SHERPA_STUB_URL: whisperUrl,
      VOICE_SELFCHECK: "0",
      VOICE_WINDOW_S: String(windowS),
    },
    stdout: "pipe", stderr: "pipe",
  });
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

/** A plain loud sine, `durationS` long, as one webm/opus file. */
async function makeTone(durationS: number): Promise<Uint8Array> {
  const path = join(tmpdir(), `salvage-tone-${crypto.randomUUID()}.webm`);
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    `sine=frequency=330:duration=${durationS}`, "-c:a", "libopus", "-b:a", "24k",
    "-ac", "1", "-cluster_time_limit", "500", "-f", "webm", "-y", path], { stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error("ffmpeg tone gen failed: " + (await new Response(proc.stderr).text()));
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  try { unlinkSync(path); } catch {}
  return bytes;
}

/** Read the EBML varint length (number of bytes) from its leading byte. */
function vintLen(first: number): number {
  for (let m = 0x80, n = 1; m; m >>= 1, n++) if (first & m) return n;
  return 8;
}

/** Rewrite every Cluster except the first, adding `offsetMs` to its Timecode
 *  (0xE7 element) IN PLACE -- same byte width, so no size varints move. This is
 *  the specimen's shape: a clean head cluster, then a jump the `-t` window cannot
 *  cross. The offset is chosen to fit the existing timecode width so the value
 *  never overflows. */
function jumpClusters(src: Uint8Array, offsetMs: number): Uint8Array {
  const buf = new Uint8Array(src); // copy
  let clusterN = 0;
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75) {
      let p = i + 4;
      p += vintLen(buf[p]);                       // skip the cluster-size varint
      if (buf[p] !== 0xe7) continue;              // Timecode must lead the cluster
      p++;
      const tl = vintLen(buf[p]);
      const valStart = p + tl;
      // Timecode element data size (low bits of the size varint).
      let width = buf[p] & (0xff >> tl);
      for (let k = 1; k < tl; k++) width = (width << 8) | buf[p + k];
      let val = 0;
      for (let k = 0; k < width; k++) val = val * 256 + buf[valStart + k];
      clusterN++;
      if (clusterN >= 2) {
        let nv = val + offsetMs;
        for (let k = width - 1; k >= 0; k--) { buf[valStart + k] = nv & 0xff; nv = Math.floor(nv / 256); }
      }
      i = valStart + width - 1;
    }
  }
  if (clusterN < 2) throw new Error("fixture has fewer than 2 clusters; raise the tone duration");
  return buf;
}

async function postStt(eng: Engine, bytes: Uint8Array): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${eng.port}/stt`, {
    method: "POST", headers: { "Content-Type": "audio/webm" },
    body: bytes as unknown as ArrayBuffer,
  });
  return res.json();
}

let stub: Stub | null = null;
let engine: Engine | null = null;
afterEach(() => {
  engine?.stop(); engine = null;
  stub?.stop(); stub = null;
});

/* ------------------------------------------------------------------- proofs */

// THE SALVAGE PROOF. A container whose second cluster jumps past the decode
// window reads as ~0.5s through the plain `-t` path; the engine re-muxes it and
// re-reads its full ~4.2s, tags the response "salvaged", and returns words.
test("a jumped-cluster container is salvaged and yields words", async () => {
  stub = startStubWhisper();
  engine = await startEngine(stub.url, 5); // 15 s window; the jump is to ~30 s
  const tone = await makeTone(4.2);
  const broken = jumpClusters(tone, 30_000);

  const body = await postStt(engine, broken);

  // The salvage engaged, and said so on the wire and in the log.
  expect(body.mode).toBe("salvaged");
  expect(engine.stdout()).toContain("[stt] salvaged broken container");
  // The recovered audio is the whole clip, not the 0.5s before the jump.
  expect(body.timing.audioS).toBeGreaterThan(3.5);
  // ...and it produced words (stub tokens), rather than the empty chars=0 the
  // truncated read shipped before.
  expect(String(body.text ?? "").trim().length).toBeGreaterThan(0);
});

// A HEALTHY clip is untouched: no salvage, no mode tag, full audio in one pass.
test("a healthy clip decodes normally with no salvage", async () => {
  stub = startStubWhisper();
  engine = await startEngine(stub.url, 600);
  const tone = await makeTone(4.2);

  const body = await postStt(engine, tone);

  expect(body.mode).toBeUndefined();
  expect(engine.stdout()).not.toContain("salvaged broken container");
  expect(body.timing.audioS).toBeGreaterThan(3.5);
  expect(String(body.text ?? "").trim().length).toBeGreaterThan(0);
});
