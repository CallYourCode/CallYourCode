/* CallYourCode voice engine (:10102).
 *
 * Pure voice, zero session knowledge: audio in -> text out (batch + streaming),
 * text in -> audio out. One of these runs wherever there is speech hardware;
 * the agent engine (:10101) talks to it over loopback HTTP/WS and is its only
 * intended caller (docs/contracts/01-engine-voice.md). The one browser page
 * allowed in is this engine's OWN test bench (/test.html, same-origin); every
 * other browser page, every proxied peer and every non-loopback peer is
 * refused at the request gate (gate.ts), the /stt-stream upgrade included.
 *
 *   POST /stt          audio bytes -> {text}            sherpa-onnx whisper (in-process)
 *   WS   /stt-stream   {t:start} + f32 PCM + {t:stop}   -> partial/final (emulated
 *                                                       streaming over offline whisper)
 *   POST /tts          {text, voice?, stream?, pcm?}    sherpa-onnx kokoro (in-process);
 *                                                       stream=true pipes chunks as they synth
 *   GET  /health       capabilities + measured throughput + current load
 *   GET  /test.html    the standing test bench
 *
 * THE BACKEND IS SHERPA-ONNX, IN-PROCESS (sherpa.ts). The python stack this
 * replaced (kokoro-FastAPI on :10104, the pywhispercpp venv on :10103/:10105)
 * is gone; the routes, request/response shapes and stream frames above are
 * byte-identical to what they were, because everything above this engine (the
 * agent engine's voice proxy, the sealed stt-* bridge, the app) speaks that
 * contract and none of it changed. Whisper is batch-only, so streaming
 * partials are EMULATED exactly the way the old python stt server emulated
 * them: the growing PCM is re-decoded and partials carry committed text plus
 * a live draft tail; the final decodes on stop.
 *
 * The /health capability block is the seed of V2 engine selection: every voice
 * engine advertises what it can do and how fast it actually is (measured, not
 * claimed), so a client with several engines on the tailnet can pick the least
 * loaded one that speaks its language.
 */

import { join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";
import { watch } from "node:fs";
import { correct, type VocabEntry } from "./stt/vocabulary";
import {
  chunkAtQuiet,
  outerWindowCut,
  parseWav,
  trimLongSilences,
  VoicedMeter,
  WINDOW_S,
  WINDOW_SEARCH_S,
  writeWav,
} from "./audio/silence";
import { unbackedStock, unbackedStockAfter } from "./stt/stock";
import { flattenTranscript } from "./stt/transcript";
import { BatchGate } from "./stt/batch-gate";
import { defaultTtsSelfCheck, resolveTtsRestartCooldownMs, runTtsSelfCheck } from "./tts/tts-watchdog";
import { SherpaBackend } from "./backend/sherpa";
import { refuseOutsider } from "./gate";
import { resolvePorts } from "../../shared/ports.ts";

/* The port scheme (CYC_PORT_BASE) lives in shared/ports.ts so all four
 * services move together under one knob; VOICE_PORT still wins when set. */
const PORT = resolvePorts(process.env).VOICE_PORT;
const HOST = process.env.VOICE_HOST ?? "127.0.0.1";

/* LOOPBACK-ONLY BY ENFORCEMENT (sealed-transport plan): this service has zero
 * auth, so its whole security story is "only this machine can reach it". The
 * agent engine bridges to it over 127.0.0.1; the app stopped dialling :10102.
 * Two layers:
 *   1. a boot assertion that VOICE_HOST is loopback, so a modifier cannot
 *      quietly publish an unauthenticated STT/TTS engine to the network;
 *   2. the per-request gate (gate.ts), applied to EVERY request at the top of
 *      handleHttp, the /stt-stream websocket upgrade included: non-loopback
 *      peers, forwarded requests (x-forwarded-for present), and browser pages
 *      other than this engine's own test bench (any other Origin) are all
 *      refused before any route runs. The gate's whole policy and its WHY
 *      live in gate.ts.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(HOST)) {
  throw new Error(
    `VOICE_HOST=${HOST} is not loopback. The voice engine has no auth and must ` +
    "bind 127.0.0.1/::1 only; the agent engine bridges to it over loopback.");
}
const KOKORO_VOICE = "af_heart";
/* kokoro's output rate: sherpa's kokoro synthesizes mono at 24kHz, exactly the
 * rate the old kokoro-FastAPI "pcm" answer carried. The /tts pcm answer keeps
 * carrying it as x-pcm-rate so the caller never hardcodes it. */
const KOKORO_PCM_RATE = 24000;

/* THE BACKEND: kokoro TTS + offline whisper, in two workers (sherpa.ts). On a
 * fresh install the model files are still downloading (the agent engine's
 * modelwarmup.ts); the backend polls and each capability flips ready the
 * moment its files land, no restart needed. */
const backend = new SherpaBackend({ log: (line) => console.log(line) });
backend.start();

// --------------------------------------------------------- batch /stt bounds
// The three bounds that keep one bad request from wedging the whole engine
// (#551). All overridable so the tests can prove the leak is closed in seconds
// rather than minutes.
//
// FFMPEG_TIMEOUT_MS: a decode that runs longer than this is killed (decodeWindow).
// BATCH_MAX / BATCH_QUEUE_WAIT_MS: at most BATCH_MAX transcriptions decode at
//   once; a request that cannot get a slot within the wait fails LOUDLY with 503
//   rather than queueing for ever. A generous default because a real 30 minute
//   note legitimately holds a slot for minutes.
// WHISPER_TIMEOUT_MS: when set, overrides the per-part whisper fetch budget
//   (the scaled default stays in transcribeWav); the tests use it to make a hung
//   upstream fail fast.
const FFMPEG_TIMEOUT_MS = Number(process.env.VOICE_FFMPEG_TIMEOUT_MS ?? 60_000);
const BATCH_MAX = Math.max(1, Number(process.env.VOICE_BATCH_MAX ?? 3));
const BATCH_QUEUE_WAIT_MS = Number(process.env.VOICE_BATCH_QUEUE_WAIT_MS ?? 2_000);
const WHISPER_TIMEOUT_MS = Number(process.env.VOICE_WHISPER_TIMEOUT_MS ?? 0); // 0 = use the scaled budget
// --------------------------------------------------- broken-container salvage
// A voice note recorded around an engine restart arrives with its WebM Segment
// intact at the head but a CLUSTER whose timecode has jumped far into the future
// (tonight's specimen 6f175999: two comfort-noise frames at t=0, then a cluster
// at t=2068.98s carrying 4.26s of real speech). ffprobe reports duration=N/A --
// which every streaming MediaRecorder webm does, so it is no signal at all -- and
// `decodeWindow`'s `-t <durS>` bound cuts by OUTPUT timestamp, so ffmpeg emits
// only the 0.12s before the jump and stops. Whisper then decodes 0.12s of near
// silence and the note ships empty (audioS=0.12, chars=0), again and again on
// restarts.
//
// The salvage: when a decode returns far less audio than the file could hold, do
// ONE tolerant re-mux (`-err_detect ignore_err`, full transcode to PCM so the
// timestamps are regenerated monotonically) and window the repaired file. That
// recovered the full 4.26s of tonight's specimen; verified 2026-08-17 across the
// ~30 corrupt clips in .run/uploads that all decoded to exactly 0.119s.
//
// SALVAGE_MIN_BYTES: below this a genuinely tiny note; never salvage it.
// SALVAGE_PROBE_S: a first decode shorter than this is a candidate.
// SALVAGE_BYTES_PER_S: opus in webm is a few KB/s; a file holding far more bytes
//   per decoded second than this has undecoded audio behind a broken container.
const SALVAGE_MIN_BYTES = Number(process.env.VOICE_SALVAGE_MIN_BYTES ?? 4096);
const SALVAGE_PROBE_S = Number(process.env.VOICE_SALVAGE_PROBE_S ?? 2);
const SALVAGE_BYTES_PER_S = Number(process.env.VOICE_SALVAGE_BYTES_PER_S ?? 12_000);

const batchGate = new BatchGate(BATCH_MAX);

// ------------------------------------------------------------- self-check
// A real inference round trip through the batch path, so /health stops lying
// (#551). ON by default: a normal deploy delivers code, not the un-synced unit
// edits an env gate would have depended on, so gating it shipped it dark. Set
// VOICE_SELFCHECK=0 to opt out. The tests set the opt-out so their stub-whisper
// call counts stay exact; the self-check test turns it back on. See
// runSelfCheck / the /health block below.
const SELFCHECK_ON = process.env.VOICE_SELFCHECK !== "0";
// 5 min, not 60s: each self-check runs a TTS+STT probe on Metal, so a tight
// interval spikes the GPU every minute on an otherwise-idle machine. The proper
// fix (skip the probe entirely when voice has been idle) is a follow-up; this
// cuts the idle spikes 5x with zero change to the voice path. Tests override it.
const SELFCHECK_INTERVAL_MS = Number(process.env.VOICE_SELFCHECK_INTERVAL_MS ?? 300_000);
const SELFCHECK_DEADLINE_MS = Number(process.env.VOICE_SELFCHECK_DEADLINE_MS ?? 15_000);
const SELFCHECK_FAIL_LIMIT = Math.max(1, Number(process.env.VOICE_SELFCHECK_FAIL_LIMIT ?? 3));
// Self-recovery is the SAME pattern every service here uses: exit and let the
// supervisor respawn. The macOS plist is KeepAlive=true (ThrottleInterval 10)
// and the linux unit is Restart=always (RestartSec 3), so process.exit(1) after
// a sustained wedge is a supervised restart, not a new mechanism. On by default
// when the self-check is on; set VOICE_SELFCHECK_EXIT=0 to only report degraded.
const SELFCHECK_EXIT = process.env.VOICE_SELFCHECK_EXIT !== "0";
// TTS probe: same deadline as STT unless VOICE_SELFCHECK_TTS_DEADLINE_MS is set.
// A wedged TTS worker is respawned in-process, not this process exited. Opt
// out with VOICE_TTS_WATCHDOG=0. Cooldown stops a restart loop.
const SELFCHECK_TTS_DEADLINE_MS = Number(process.env.VOICE_SELFCHECK_TTS_DEADLINE_MS ?? SELFCHECK_DEADLINE_MS);
const TTS_WATCHDOG = process.env.VOICE_TTS_WATCHDOG !== "0";
const TTS_RESTART_COOLDOWN_MS = resolveTtsRestartCooldownMs(process.env.VOICE_TTS_RESTART_COOLDOWN_MS);
const SELFCHECK_TTS_TEXT = "ok";

const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;

// ------------------------------------------------------------- vocabulary
// Custom vocabulary correction (stt/vocabulary.ts): every transcript that leaves
// this engine (batch /stt, stream partials AND finals) is post-corrected
// against stt/vocabulary.json. Measured ~1.7ms on a 200-word transcript, so
// partials get it too. The file hot-reloads: add a term, no restart.

const VOCAB_DIR = new URL("./stt/", import.meta.url).pathname;
const VOCAB_FILE = "vocabulary.json";
let vocab: VocabEntry[] = [];

async function loadVocab() {
  try {
    const v = await Bun.file(join(VOCAB_DIR, VOCAB_FILE)).json();
    if (!Array.isArray(v)) throw new Error("not an array");
    vocab = v as VocabEntry[];
    console.log(`[vocab] ${vocab.length} terms loaded`);
  } catch (e) {
    console.error(`[vocab] load failed, keeping ${vocab.length} previous terms:`, e);
  }
}

await loadVocab();
{
  // watch the directory, not the file: editors replace-on-save and a file
  // watch dies with the old inode
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(VOCAB_DIR, (_event, filename) => {
    if (filename !== VOCAB_FILE) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(loadVocab, 200);
  });
}

// ---------------------------------------------------------------- metrics
// Rolling, measured throughput: what /health advertises. RTF = compute time /
// audio duration (lower is better; 0.1 = 10x faster than real time).

type Rolling = { n: number; rtf: number };
const metrics = {
  batch: { n: 0, rtf: 0 } as Rolling,
  tts: { n: 0, rtf: 0 } as Rolling, // rtf here = synth seconds per output second (approx by chars/15)
  activeStreams: 0,
};

function rollRtf(r: Rolling, computeS: number, audioS: number) {
  if (audioS <= 0) return;
  const rtf = computeS / audioS;
  r.rtf = r.n === 0 ? rtf : r.rtf * 0.8 + rtf * 0.2; // EWMA, recent-biased
  r.n++;
}

// ---------------------------------------------------------------- speech

/** Decode ONE window of the source clip to 16k mono PCM wav.
 *
 * `-ss` before `-i` is an input seek, so ffmpeg never decodes the head it skips;
 * `-t` bounds the tail it produces. The window is [startS, startS + durS) in
 * ORIGINAL-container seconds -- the same clock `offsetS` and the stream's `end`
 * timestamps (committedS) are measured in -- so the deferred-words seam and the
 * window seams both land where the caller expects.
 *
 * THE WAV GOES TO A FILE, NOT A PIPE, and that is the other half of the #449
 * fix. Reading ffmpeg's stdout with `new Response(proc.stdout).arrayBuffer()`
 * allocated ~150x the wav's size in transient ArrayBuffers -- measured 2026-08-10
 * on this exact path: a 300 s clip whose wav is 9 MB drove the process to
 * 1.2 GB, all of it in `arrayBuffers`, before a single whisper request went out.
 * That, not the whole-clip hold #449 named, is what put a 30 minute note over
 * the 2 GB ceiling. Decoding to a temp file and reading the file back allocates
 * exactly the wav's bytes (measured: 9 MB, rss flat), so the decoder's own
 * memory is the audio and nothing more. */
async function decodeWindow(tmp: string, startS: number, durS: number): Promise<Uint8Array> {
  const out = join(tmpdir(), `voice-engine-win-${crypto.randomUUID()}.wav`);
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel", "error",
      ...(startS > 0 ? ["-ss", String(startS)] : []),
      "-i", tmp,
      "-t", String(durS),
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      "-f", "wav",
      out,
    ],
    // stdout is IGNORED, not piped: ffmpeg writes the wav to `out`, so a piped
    // stdout would only ever be an undrained fd we leak on every window (#551).
    { stdout: "ignore", stderr: "pipe" },
  );
  // KILL a hung ffmpeg (#551). `await proc.exited` had no bound, so an ffmpeg
  // that never exits -- a truncated container it waits on, a codec it stalls in
  // -- hung the request FOR EVER, and with nothing capping concurrency the dead
  // children and their fds piled up until the engine wedged every later request.
  // The kill makes `exited` resolve, the non-zero code below turns it into a
  // loud failure of the ONE request, and the child is reaped instead of leaked.
  let killed = false;
  const killTimer = setTimeout(() => {
    killed = true;
    try { proc.kill(9); } catch {}
  }, FFMPEG_TIMEOUT_MS);
  try {
    const [err, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (killed) {
      throw new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms and was killed`);
    }
    if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${err.trim() || "no output"}`);
    return new Uint8Array(await Bun.file(out).arrayBuffer());
  } finally {
    clearTimeout(killTimer);
    // Ensure the child is dead on EVERY exit path, including a throw from
    // reading the file back: a live ffmpeg outliving its request is the leak.
    try { proc.kill(9); } catch {}
    await unlink(out).catch(() => {});
  }
}

/** ONE tolerant re-mux of a broken container into a clean 16k mono wav.
 *
 * The input has a valid EBML head and real Opus behind a cluster whose timecode
 * jumped (see the salvage note up top). `-err_detect ignore_err` tells ffmpeg to
 * keep decoding past the corrupt element instead of stopping, and transcoding to
 * PCM (rather than `-c copy`) REGENERATES the output timestamps monotonically
 * from sample count -- a plain remux would carry the broken timecodes straight
 * through, and `-t` windowing over the result would still cut at 0.12s. There is
 * NO `-t` here: the whole clip is repaired in one pass, and the caller then
 * windows the repaired wav (whose timestamps are now clean) as usual.
 *
 * Returns the repaired temp file's path, or null if the re-mux produced nothing.
 * The caller owns the returned file and must unlink it. */
async function salvageContainer(tmp: string): Promise<string | null> {
  const out = join(tmpdir(), `voice-engine-salvage-${crypto.randomUUID()}.wav`);
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel", "error",
      "-err_detect", "ignore_err",
      "-i", tmp,
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      "-f", "wav",
      out,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  let killed = false;
  const killTimer = setTimeout(() => {
    killed = true;
    try { proc.kill(9); } catch {}
  }, FFMPEG_TIMEOUT_MS);
  try {
    const [, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (killed || code !== 0) return null;
    const size = Bun.file(out).size;
    // a header-only wav (44 bytes) means nothing was recovered
    return size > 44 ? out : (await unlink(out).catch(() => {}), null);
  } catch {
    return null;
  } finally {
    clearTimeout(killTimer);
    try { proc.kill(9); } catch {}
  }
}

/** Trim silence, split into whisper-window parts, decode each. The body that
 * used to be all of `transcribe()`; now it runs once per outer window (see
 * `transcribe`), and its own memory -- the trim copy and the parts -- is bounded
 * by one window rather than by the clip. */
async function transcribeWav(wav: Uint8Array): Promise<{ texts: string[]; dropped: string[]; audioS: number }> {
  // Never hand the decoder silence. Whisper loops on it: the user's own
  // 94.2 s capture with a 25 s pause in it decodes correctly up to the pause
  // and then says "and" eighty-odd times, losing everything he said after
  // it. Cutting runs of 3 s or more under -45 dBFS decodes the same clip
  // clean and complete. Only silence is removed and a clip with none is
  // passed through byte-identical; see silence.ts for why that cannot eat a
  // short note, and for the measurement that says the temperature ladder is
  // a mitigator rather than the cause.
  const { wav: audio, cutS } = trimLongSilences(wav);
  if (cutS > 0) console.log(`[stt] cut ${cutS.toFixed(1)}s of silence before decoding`);

  // ...and never hand it more than one window's worth in one request either.
  // A 212 s clip posted whole comes back with sixty seconds of speech replaced
  // by "I don't know what I'm doing" repeated, because whisper carries each
  // 30 s window's tokens into the next as context and temperature_inc=0 below
  // has taken away its own repetition fallback. The two windows that looped
  // decode perfectly when posted on their own. This is the bound the streaming
  // path has always had; see chunkAtQuiet in silence.ts for the measurement.
  // A clip of 30 s or less is one part, and one part is exactly the request
  // this code made before.
  const parts = chunkAtQuiet(audio);
  const audioS = audio.byteLength / 2 / 16000;
  if (parts.length > 1) {
    console.log(`[stt] ${audioS.toFixed(1)}s split into ${parts.length} decoder-sized parts`);
  }

  const texts: string[] = [];
  const dropped: string[] = [];
  for (const part of parts) {
    // Bound the decode. The retry-ladder bound (temperature_inc=0) used to
    // ride this request as a form field for the retired python whisper server,
    // which applied it on every batch call. The WHY survives that stack:
    // whisper's default 0.20 decodes a repetition-loop clip six times
    // (t = 0, 0.2 ... 1.0), and one whisper_full call was measured parked over
    // ten minutes under greedy decoding; one attempt, not six.
    // ...and bound the wait as well as the retries. temperature_inc stops one
    // runaway decode becoming six; it cannot stop one. That needs max_tokens,
    // which the decoder exposes neither as a flag nor as a request field, so
    // the only place left to put a bound is here. This fetch had no timeout at
    // all, which is why a ten-minute decode became a ten-minute hang.
    // Scaled by audio length, because a real long note legitimately takes a
    // while: measured rtf on this hardware is 0.10 to 0.41, so 4x realtime is
    // roughly ten times the honest cost.
    // ...measured on what is actually SENT, not on what was recorded: after a
    // trim the decode is proportional to the audio that survived it, and after
    // a split each request is bounded by ITS OWN part rather than the clip.
    const partS = part.byteLength / 2 / 16000;
    const budgetMs = WHISPER_TIMEOUT_MS > 0
      ? WHISPER_TIMEOUT_MS
      : Math.min(240_000, Math.max(30_000, partS * 4000));
    // The part is PCM s16le mono 16k wav (the only thing decodeWindow/salvage
    // emit); sherpa's recognizer takes mono f32, so convert and hand it over.
    // The budget that used to bound the whisper HTTP fetch now bounds the
    // in-process decode the same way (backend.transcribe rejects past it).
    const pcm = parseWav(part);
    if (!pcm) throw new Error("decoder produced a wav this engine cannot parse");
    const f32 = new Float32Array(pcm.samples.length);
    for (let i = 0; i < pcm.samples.length; i++) f32[i] = pcm.samples[i] / 32768;
    const text = await backend.transcribe(f32, 16000, budgetMs);
    /* A stock phrase over a request with no speech in it is a claim with
     * nothing behind it, not a transcript (stock.ts). This engine decides
     * that something was not said in exactly two places -- here and
     * `sttFinish`, the streaming path's own final -- and it never does it
     * silently in either: the phrase goes back to the caller in `dropped` and
     * into the log with the length of the request it came from. */
    if (unbackedStock(text, part)) {
      console.log(`[stt] dropped "${text.trim()}": no speech anywhere in this ${partS.toFixed(1)}s request`);
      dropped.push(text.trim());
      continue;
    }
    texts.push(text);
  }
  return { texts, dropped, audioS };
}

/** The window loop, over ONE source file (the raw upload, or a salvaged copy).
 *
 * ffmpeg cannot seek stdin, and MediaRecorder mp4 puts the moov atom at the end,
 * so the source is always a real file on disk. Decodes WINDOW_S windows from
 * `startFrom`, trims/splits/transcribes each and releases it before the next, so
 * peak memory is one window (see the #449 note on `transcribe`). */
async function runWindows(source: string, startFrom: number):
  Promise<{ texts: string[]; dropped: string[]; audioS: number }> {
  const winSamples = (WINDOW_S + WINDOW_SEARCH_S) * 16000;
  const texts: string[] = [];
  const dropped: string[] = [];
  let start = startFrom > 0 ? startFrom : 0;
  let audioS = 0;
  for (let win = 0; ; win++) {
    const wav = await decodeWindow(source, start, WINDOW_S + WINDOW_SEARCH_S);
    const pcm = parseWav(wav);
    // Nothing decodable past here: either the clean end of the clip, or a wav
    // this engine does not touch (which the whole-clip path passed through
    // untouched too). On the very first window a null means "not a shape we
    // decode", so hand the raw bytes to the trim/split path exactly as before.
    if (!pcm) {
      if (win === 0) {
        const r = await transcribeWav(wav);
        texts.push(...r.texts); dropped.push(...r.dropped); audioS += r.audioS;
      }
      break;
    }
    // FULL window means more audio remains, so cut the seam at the quietest
    // frame past WINDOW_S and carry nothing over. A SHORT window is the tail
    // of the clip: transcribe it whole and stop. The one-second slack is on
    // the safe side on purpose -- a window ffmpeg returns a hair short (opus
    // seek priming can drop a few samples) is still treated as full, so the
    // failure mode is one extra tiny window, never a truncated clip.
    const more = pcm.samples.length >= winSamples - 16000;
    if (!more) {
      // The tail of the clip (and, for a clip that fits in one window, the
      // whole of it). No seam to cut, so hand the decoded bytes straight to
      // the trim/split path -- byte-for-byte the request the old code made.
      const r = await transcribeWav(wav);
      texts.push(...r.texts); dropped.push(...r.dropped); audioS += r.audioS;
      break;
    }
    // A full window: more audio remains, so cut the seam at the quietest frame
    // past WINDOW_S and carry nothing over into the next window.
    const cut = outerWindowCut(pcm.samples);
    const r = await transcribeWav(writeWav(pcm.samples.subarray(0, cut)));
    texts.push(...r.texts); dropped.push(...r.dropped); audioS += r.audioS;
    console.log(`[stt] window ${win} decoded ${(cut / 16000).toFixed(1)}s from ${start.toFixed(1)}s`);
    start += cut / 16000;
  }
  return { texts, dropped, audioS };
}

/** Does a decode that recovered `audioS` seconds from a `bytes`-byte file look
 *  like it hit a broken container rather than a short note? A file holding far
 *  more bytes per decoded second than Opus can occupy has audio behind a jumped
 *  cluster timecode that `-t` windowing never reached (see the salvage note). */
function looksBroken(audioS: number, bytes: number): boolean {
  if (bytes < SALVAGE_MIN_BYTES) return false;      // a genuinely tiny note
  if (audioS >= SALVAGE_PROBE_S) return false;      // plenty decoded already
  return bytes / Math.max(audioS, 0.05) > SALVAGE_BYTES_PER_S;
}

/** Raw webm/mp4/wav bytes -> 16k mono wav -> Whisper -> text.
 *
 * `dropped` is every stock phrase this engine refused to believe (stock.ts). It
 * comes back rather than disappearing because it is the one thing here that
 * decides something was NOT said, and a caller that is told "" learns nothing,
 * while a caller told `dropped: ["Thank you."]` can say `ignored: "Thank you."`
 * the way the app already does for its own list.
 *
 * `mode` is "normal" on the ordinary path, "salvaged" when a broken container
 * was re-muxed to recover its audio, and "broken" when it was detected broken
 * but nothing more could be read -- so a chars=0 note is told apart from a
 * genuinely silent one in the caller's log (task 594).
 *
 * ONE WINDOW AT A TIME, and that is the whole of the #449 fix. This used to
 * decode the ENTIRE clip to one PCM wav, full-copy trim it, and split it into
 * every 30 s part at once, holding all of it: a 30 minute note drove RSS to
 * ~1.86 GB against a 2 GB ceiling and launchd killed the process mid-request, so
 * the note shipped as "(voice note: transcription failed)". Now the clip is
 * decoded in WINDOW_S windows, each trimmed, split, transcribed and RELEASED
 * before the next is decoded, so peak memory is one window (~19 MB of PCM at 10
 * min) and the transcript is the windows concatenated in order. A clip that fits
 * in one window takes exactly the path -- and produces exactly the bytes -- it
 * did before. */
async function transcribe(bytes: Uint8Array, offsetS = 0):
  Promise<{ text: string; dropped: string[]; audioS: number; computeMs: number;
    mode: "normal" | "salvaged" | "broken" }> {
  const tmp = join(tmpdir(), `voice-engine-${crypto.randomUUID()}`);
  await Bun.write(tmp, bytes);
  const t0 = performance.now();
  try {
    let result = await runWindows(tmp, offsetS);
    let mode: "normal" | "salvaged" | "broken" = "normal";

    /* A BROKEN CONTAINER GETS ONE TOLERANT RE-MUX (task 594). The ordinary
     * decode returned far less audio than the file could hold, which is the
     * jumped-cluster corruption a note recorded around an engine restart
     * carries. Re-mux the whole clip with regenerated timestamps and window the
     * repair; keep it only if it recovered MORE audio, so a salvage that finds
     * nothing new never overwrites the honest first read. */
    if (looksBroken(result.audioS, bytes.byteLength)) {
      const repaired = await salvageContainer(tmp);
      if (repaired) {
        try {
          const salv = await runWindows(repaired, offsetS);
          if (salv.audioS > result.audioS) {
            console.log(`[stt] salvaged broken container: ${result.audioS.toFixed(2)}s -> ${salv.audioS.toFixed(2)}s`);
            result = salv;
            mode = "salvaged";
          } else {
            mode = "broken";
          }
        } finally {
          await unlink(repaired).catch(() => {});
        }
      } else {
        mode = "broken";
      }
    }

    const computeMs = performance.now() - t0;
    rollRtf(metrics.batch, computeMs / 1000, result.audioS);
    // whisper-server hands back its segments already joined with "\n", so a
    // plain trim shipped decoder window boundaries as line breaks: into the
    // bubble, and into the session's context. Flatten them the way the
    // streaming path has always flattened its own segments (transcript.ts).
    // Parts join the same way for the same reason, and so do windows.
    return { text: flattenTranscript(result.texts.join("\n")), dropped: result.dropped,
      audioS: result.audioS, computeMs, mode };
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ------------------------------------------------------------- self-check
//
// /health used to do no real work: it pinged the sub-services and reported the
// rolling metrics, so it stayed "ok" for ten days while every POST /stt hung
// (#551). This runs a REAL decode -- a tiny bundled clip through the same
// `transcribe()` the batch path uses, ffmpeg and whisper and all -- on a timer
// and on demand, records its latency and last success, and marks the engine
// degraded when the round trip fails or blows a hard deadline. When it stays
// degraded across SELFCHECK_FAIL_LIMIT runs, the process exits so the supervisor
// respawns it (the same self-recovery the memory ceiling already uses).
//
// The same round also synths a tiny string through the TTS backend. That
// counter is separate: a wedged TTS worker is respawned in-process
// (VOICE_TTS_WATCHDOG), it does not exit this process.

/** A ~0.4 s 16 kHz mono clip with a real tone in it: enough to exercise the
 *  whole batch path (ffmpeg decode window + whisper fetch + parse) without
 *  tripping the silence trimmer, and small enough to bundle in code. */
function selfCheckClip(): Uint8Array {
  const n = 6400; // 0.4 s @ 16k
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(2000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  return writeWav(s);
}
const SELFCHECK_CLIP = selfCheckClip();

const selfCheck = {
  lastRunAt: 0,
  lastSuccessAt: 0,
  lastLatencyMs: null as number | null,
  lastError: null as string | null,
  ok: true, // healthy until proven otherwise; the first run settles it
  running: false,
  consecutiveFail: 0,
};
const ttsCheck = defaultTtsSelfCheck();

/** Tiny kokoro synth under the TTS deadline. Success is audio samples in time. */
async function probeTts(): Promise<void> {
  const clip = await backend.synthesize(SELFCHECK_TTS_TEXT, KOKORO_VOICE, 1.0, SELFCHECK_TTS_DEADLINE_MS);
  if (clip.samples.length === 0) throw new Error("tts self-check empty audio");
}

/** The TTS watchdog's restart target: the in-process TTS worker, respawned.
 *  The successor of `systemctl restart cyc-kokoro.service`, which restarted a
 *  python service this product no longer has. */
function restartTtsBackend(): void {
  backend.restartTts();
}

/** One self-check round: decode the bundled clip through `transcribe()` under a
 *  hard deadline. Success is "the path answered in time", empty text included
 *  (an empty transcript of a short tone is a working path, not a failure).
 *  The TTS probe runs in the same round against a separate counter; a wedge
 *  there restarts kokoro instead of this process. */
async function runSelfCheck(): Promise<void> {
  if (selfCheck.running) return; // a stuck previous run counts as a failure via the deadline
  /* A model still downloading is WARMING, not degraded: probing a backend that
   * has honestly said "not ready yet" would count the download's whole
   * duration as consecutive failures and exit a healthy process. /health
   * already reports the capability down through `backend.asrReady`. */
  if (!backend.asrReady && !backend.ttsReady) return;
  selfCheck.running = true;
  selfCheck.lastRunAt = Date.now();
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`self-check exceeded ${SELFCHECK_DEADLINE_MS}ms`)), SELFCHECK_DEADLINE_MS);
    });
    // Bypasses the batch gate on purpose: the self-check asks "does the decode
    // path WORK", not "is there a free slot"; a busy engine is loaded, not
    // degraded, and would falsely trip the exit otherwise. An ASR model still
    // warming is skipped, not probed: not-ready is already reported honestly.
    if (backend.asrReady) await Promise.race([transcribe(SELFCHECK_CLIP), deadline]);
    selfCheck.lastLatencyMs = Math.round(performance.now() - t0);
    selfCheck.lastSuccessAt = Date.now();
    selfCheck.lastError = null;
    selfCheck.ok = true;
    selfCheck.consecutiveFail = 0;
  } catch (e) {
    selfCheck.lastLatencyMs = Math.round(performance.now() - t0);
    selfCheck.lastError = String(e);
    selfCheck.ok = false;
    selfCheck.consecutiveFail++;
    console.error(`[selfcheck] degraded (${selfCheck.consecutiveFail}/${SELFCHECK_FAIL_LIMIT}): ${selfCheck.lastError}`);
    if (SELFCHECK_EXIT && selfCheck.consecutiveFail >= SELFCHECK_FAIL_LIMIT) {
      console.error(`[selfcheck] batch path wedged across ${selfCheck.consecutiveFail} checks; exiting for the supervisor to respawn`);
      // Give the log line a tick to flush before the supervisor takes over.
      setTimeout(() => process.exit(1), 50);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  try {
    if (backend.ttsReady) {
      await runTtsSelfCheck(ttsCheck, {
        probe: probeTts,
        restart: restartTtsBackend,
        failLimit: SELFCHECK_FAIL_LIMIT,
        cooldownMs: TTS_RESTART_COOLDOWN_MS,
        watchdogOn: TTS_WATCHDOG,
      });
    }
  } finally {
    selfCheck.running = false;
  }
}

/** Kick a self-check if one is warranted (enabled, not already running, and the
 *  last one is older than the interval). Never awaited by /health: the probe
 *  reports the LAST known result and the round trip runs in the background. */
function maybeSelfCheck(): void {
  if (!SELFCHECK_ON || selfCheck.running) return;
  if (Date.now() - selfCheck.lastRunAt < SELFCHECK_INTERVAL_MS) return;
  void runSelfCheck();
}

/* --------------------------------------------------------------- synthesis
 *
 * Text -> kokoro via sherpa, answered in the SAME response shapes the old
 * kokoro-FastAPI proxy produced: mp3 by default (the sealed MediaSource
 * playback consumes it as a growing clip), raw s16le mono at KOKORO_PCM_RATE
 * with `pcm` (the call-mode downlink Opus-encodes PCM and must not carry an
 * mp3 decoder). The text is synthesized SENTENCE BY SENTENCE and each piece's
 * audio goes out as it lands, so streamed playback still starts before the
 * whole reply is spoken -- the chunk-by-chunk behavior kokoro-FastAPI's
 * stream=true had. mp3 encoding is ffmpeg (libmp3lame), the dependency this
 * engine already requires for every batch decode. */

/** Deadline for ONE piece's synth: kokoro runs faster than realtime, so a
 *  sentence that takes this long is a wedged worker, not a long sentence. */
const TTS_PIECE_DEADLINE_MS = Number(process.env.VOICE_TTS_PIECE_DEADLINE_MS ?? 60_000);

/** Sentence-ish pieces, merged so tiny fragments do not synth one by one. */
export function ttsPieces(text: string): string[] {
  const parts = text.split(/(?<=[.!?;])\s+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur} ${p}` : p;
    if (cur.length >= 200) { out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
}

function f32ToS16Bytes(samples: Float32Array): Uint8Array {
  const s16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    s16[i] = Math.round(v * 32767);
  }
  return new Uint8Array(s16.buffer);
}

/** Text -> audio Response. Streams in both modes (the /tts handler buffers it
 *  whole when the caller did not ask to stream, exactly as it buffered the
 *  old upstream response). The FIRST piece is synthesized before the Response
 *  exists, so a backend that is down or not warm fails here and the handler
 *  answers 502 -- the same first-byte failure semantics the kokoro fetch had. */
async function synthesize(text: string, voice: string, _stream: boolean, pcm = false): Promise<Response> {
  const pieces = ttsPieces(text);
  const first = await backend.synthesize(pieces[0], voice, 1.0, TTS_PIECE_DEADLINE_MS);
  const rate = first.sampleRate;

  if (pcm) {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(f32ToS16Bytes(first.samples));
          for (const piece of pieces.slice(1)) {
            const clip = await backend.synthesize(piece, voice, 1.0, TTS_PIECE_DEADLINE_MS);
            controller.enqueue(f32ToS16Bytes(clip.samples));
          }
          controller.close();
        } catch (e) {
          console.error("[tts] mid-stream synth failed:", e);
          controller.error(e);
        }
      },
    });
    return new Response(body);
  }

  // mp3: pipe the pcm through ffmpeg as pieces land; its stdout is the body.
  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", "pipe:0",
      "-f", "mp3", "-b:a", "128k", "pipe:1"],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  void (async () => {
    try {
      proc.stdin.write(f32ToS16Bytes(first.samples));
      await proc.stdin.flush();
      for (const piece of pieces.slice(1)) {
        const clip = await backend.synthesize(piece, voice, 1.0, TTS_PIECE_DEADLINE_MS);
        proc.stdin.write(f32ToS16Bytes(clip.samples));
        await proc.stdin.flush();
      }
    } catch (e) {
      console.error("[tts] mid-stream synth failed:", e);
      try { proc.kill(9); } catch {}
    } finally {
      try { await proc.stdin.end(); } catch {}
    }
  })();
  return new Response(proc.stdout as ReadableStream<Uint8Array>);
}

// ---------------------------------------------------------- streaming stt
//
// WS /stt-stream: browser sends {t:"start",sampleRate:16000}, then binary
// float32 PCM frames, then {t:"stop"}. Transcripts come back as {t:"partial"}
// while audio flows and one {t:"final"} after stop. Any failure becomes
// {t:"error"} so the page can fall back to batch POST /stt. The frame shapes
// are EXACTLY what the old python stt relay carried; the decoder behind them
// is now sherpa's offline whisper, in-process.
//
// EMULATED STREAMING, the same emulation the python stt server ran: whisper
// is batch-only, so the growing PCM is re-decoded as it arrives. The tail
// past `committedS` is decoded each pass; once the tail grows past
// STT_COMMIT_TAIL_S its text is COMMITTED (it will never be re-decoded or
// change again) and committedS advances to the decoded end -- which is what
// makes `committed`/`committedS` on the partial frames mean exactly what they
// always did: a finalized prefix in chars and in source seconds, monotonic,
// absent until the first commit. The final decodes the remaining tail on
// stop, so nothing is ever answered from a draft.

/** Decode a partial pass only once this much NEW audio arrived: re-decoding
 *  per 100ms frame would burn the CPU for identical text. */
const STT_PARTIAL_MIN_NEW_S = Number(process.env.VOICE_STT_PARTIAL_MIN_NEW_S ?? 1.2);
/** Commit the tail once it reaches this many seconds: whisper's window is
 *  30s, and committing well before it keeps every pass fast and the committed
 *  prefix growing the way the old decoder's segment commits did. */
const STT_COMMIT_TAIL_S = Number(process.env.VOICE_STT_COMMIT_TAIL_S ?? 15);
/** A stream cannot grow without bound: at this length it is finalized as if
 *  the client had sent stop, the same stream-lifetime cap the old stt server
 *  enforced with its final-then-DISCONNECT. */
const STT_STREAM_MAX_S = Number(process.env.VOICE_STT_STREAM_MAX_S ?? 900);

type SockData = { stt: SttStream | null };
type Sock = import("bun").ServerWebSocket<SockData>;

type SttStream = {
  browser: Sock;
  /* The stream's PCM (mono f32 16k), in arrival order. Held whole because the
   * emulation re-decodes the uncommitted tail; the committed head is released
   * as commits advance (sttCollectTail drops spent chunks). */
  chunks: Float32Array[];
  /** Samples dropped from the head of `chunks` as commits released them. */
  droppedSamples: number;
  totalSamples: number;
  committed: string[]; // texts the emulation has finalized (never re-decoded)
  current: string; // the live draft tail from the last pass (raw)
  lastSent: string; // last partial text sent, to skip repeats
  /* HOW FAR INTO THE AUDIO THE COMMITTED WORDS REACH, in source seconds. It
   * is the char offset's twin in the audio domain, and the deferred-words
   * path needs it: when the app hands a partial to the agent engine, this is
   * the point from which the batch decoder finishes the tail rather than
   * re-reading the whole clip (agent-engine transcribeUpload). Monotonic, and
   * 0 until the first commit. */
  committedS: number;
  /** Seconds of audio the last decode pass consumed, to gate the next one. */
  lastPassS: number;
  decoding: boolean;
  /* Speech in the WHOLE stream, counted as the frames go past: the final's
   * hallucination refusal (unbackedStockAfter) asks it. */
  voiced: VoicedMeter;
  stopping: boolean;
  done: boolean;
};

function send(ws: Sock, msg: unknown) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

function sttText(st: SttStream): string {
  return [...st.committed, st.current].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function sttTeardown(st: SttStream) {
  if (!st.done) metrics.activeStreams = Math.max(0, metrics.activeStreams - 1);
  st.done = true;
  st.chunks.length = 0;
}

function sttFinish(st: SttStream) {
  if (st.done) return;
  const raw = sttText(st);
  /* THE SAME RULE THE BATCH PATH HAS, on the path it actually matters on.
   *
   * `stock.ts` was wired into POST /stt only, and POST /stt is the FALLBACK:
   * the app takes the stream's answer when there is one and decodes the clip
   * only when the stream had nothing to say (its pipeline.ts says so in as many
   * words). So the guarded path was the one reached least, and the streaming
   * decoder is not a different family of model that would excuse it -- the
   * retired python stt server answered /health with `"engine": "whisper.cpp",
   * "model": "ggml-large-v3-turbo.bin"` and served 18603 passes with the same
   * whisper family this in-process backend runs. The same model, inventing the
   * same sentences, with nothing in front of it.
   *
   * Asked of the RAW text, before correct(), because that is where the batch
   * path asks it: the vocabulary repairer must not be able to turn a phrase
   * into or out of a stock one on one path and not the other.
   *
   * And it is reported, never silent -- same contract as POST /stt. `text` is
   * empty and `dropped` says what was refused, so a client can tell "the engine
   * threw away a hallucination" from "the decoder heard nothing", which are the
   * same empty string and want opposite things from the reader. */
  if (unbackedStockAfter(raw, st.voiced.seconds)) {
    console.log(`[stt-stream] dropped "${raw.trim()}": ` +
      `${st.voiced.seconds.toFixed(3)}s of speech in the whole stream`);
    sttTeardown(st);
    send(st.browser, { t: "final", text: "", corrections: [], dropped: [raw.trim()] });
    try {
      st.browser.close(1000);
    } catch {}
    return;
  }
  const { text, corrections } = correct(raw, vocab);
  sttTeardown(st);
  send(st.browser, { t: "final", text, corrections, dropped: [] });
  try {
    st.browser.close(1000);
  } catch {}
}

function sttFail(st: SttStream, message: string) {
  if (st.done) return;
  sttTeardown(st);
  console.error(`[stt-stream] ${message}`);
  send(st.browser, { t: "error", message });
  try {
    st.browser.close(1000);
  } catch {}
}

/** The uncommitted tail of the stream's audio as ONE f32 buffer, and the
 *  seconds mark its end sits at. Spent head chunks (fully behind committedS)
 *  are RELEASED here, so a long stream's memory is the tail, not the clip. */
function sttCollectTail(st: SttStream): { tail: Float32Array; endS: number } {
  const startSample = Math.floor(st.committedS * 16000);
  // Drop whole chunks the commit point has moved past.
  while (st.chunks.length > 0 && st.droppedSamples + st.chunks[0].length <= startSample) {
    st.droppedSamples += st.chunks[0].length;
    st.chunks.shift();
  }
  const tail = new Float32Array(st.totalSamples - startSample);
  let at = 0;
  let pos = st.droppedSamples;
  for (const c of st.chunks) {
    const from = Math.max(0, startSample - pos);
    if (from < c.length) {
      tail.set(from === 0 ? c : c.subarray(from), at);
      at += c.length - from;
    }
    pos += c.length;
  }
  return { tail: tail.subarray(0, at) as Float32Array, endS: st.totalSamples / 16000 };
}

/** The same decode budget the batch path scales: 4x realtime, floored so a
 *  short tail is not starved, capped so a wedge cannot hang the stream. */
function sttBudgetMs(tailS: number): number {
  return Math.min(240_000, Math.max(30_000, tailS * 4000));
}

/** One decode pass over the uncommitted tail. A partial pass sends a
 *  {t:"partial"} and may COMMIT the tail (never re-decoded after that); the
 *  final pass hands its text to sttFinish, so the final is always the
 *  decoder's own answer over real audio, never a draft. One pass runs at a
 *  time per stream; audio keeps accumulating while it does, and the next
 *  pass (or the final) picks it up. */
async function sttPass(st: SttStream, isFinal: boolean): Promise<void> {
  if (st.done || st.decoding) return;
  st.decoding = true;
  const { tail, endS } = sttCollectTail(st);
  const tailS = tail.length / 16000;
  let text = "";
  try {
    // Under a quarter-second of tail decodes to nothing but expense (and the
    // empty-stream final must not hand the decoder zero samples at all).
    if (tail.length >= 4000) {
      text = await backend.transcribe(tail, 16000, sttBudgetMs(tailS));
    }
  } catch (e) {
    st.decoding = false;
    // A failed FINAL is the stream failing: the client is owed its terminal
    // frame either way, and text it cannot trust is worse than the error that
    // lets it fall back to batch POST /stt. A failed partial is the same
    // stream in the same state, so it fails the same way rather than limping
    // on and answering a final over a decoder that just proved broken.
    sttFail(st, `stt decode failed: ${e}`);
    return;
  }
  if (st.done) return; // torn down while the decode ran
  st.lastPassS = endS;
  const trimmed = flattenTranscript(text).trim();
  if (isFinal) {
    st.current = trimmed;
    st.decoding = false;
    sttFinish(st);
    return;
  }
  if (tailS > STT_COMMIT_TAIL_S && trimmed) {
    /* COMMIT: this text is final now. committedS advances to the decoded end,
     * which is exactly what the partial's committedS field promises -- the
     * finalized audio reach in source seconds, monotonic. */
    st.committed.push(trimmed);
    st.committedS = endS;
    st.current = "";
  } else {
    st.current = trimmed;
  }
  const text2 = sttText(st);
  if (text2 && text2 !== st.lastSent) {
    st.lastSent = text2;
    // committed = chars of `text` this engine has finalized; the rest is the
    // live draft tail. Vocabulary correction runs on the committed part and
    // the tail separately so the committed char offset stays true; merges
    // across that boundary are caught by the final, which corrects the whole.
    const done = st.committed.join(" ").replace(/\s+/g, " ").trim();
    const cDone = correct(done, vocab).text;
    const cCur = st.current ? correct(st.current, vocab).text : "";
    const out = [cDone, cCur].filter(Boolean).join(" ");
    // committedS rides beside committed: the same finalized prefix, told once
    // in characters (for the caption's two-tone render) and once in audio
    // seconds (for the deferred-words tail decode). 0 until the first commit,
    // and omitted then so an old client reads exactly what it always did.
    send(st.browser, { t: "partial", text: out, committed: cCur ? cDone.length : out.length,
      ...(st.committedS > 0 ? { committedS: st.committedS } : {}) });
  }
  st.decoding = false;
  if (st.stopping) {
    void sttPass(st, true); // stop arrived while this pass decoded
    return;
  }
  sttMaybeDecode(st); // audio kept arriving during the decode
}

/** Kick a partial pass when enough NEW audio has arrived since the last one.
 *  Called on every audio frame; almost always returns without decoding. */
function sttMaybeDecode(st: SttStream): void {
  if (st.done || st.decoding || st.stopping) return;
  const totalS = st.totalSamples / 16000;
  if (totalS - st.lastPassS < STT_PARTIAL_MIN_NEW_S) return;
  void sttPass(st, false);
}

function sttStart(ws: Sock, m: any) {
  if (ws.data.stt) return; // duplicate start
  const st: SttStream = {
    browser: ws,
    chunks: [],
    droppedSamples: 0,
    totalSamples: 0,
    committed: [],
    current: "",
    lastSent: "",
    committedS: 0,
    lastPassS: 0,
    decoding: false,
    voiced: new VoicedMeter(),
    stopping: false,
    done: false,
  };
  ws.data.stt = st;
  metrics.activeStreams++;

  const rate = Number(m.sampleRate ?? m.rate ?? 16000);
  if (rate !== 16000) return sttFail(st, `sampleRate must be 16000 (got ${rate})`);
  if (!backend.asrReady) {
    return sttFail(st, "stt engine not ready" +
      (backend.asrError ? ` (${backend.asrError})` : " (model still warming up)"));
  }
}

function sttMessage(ws: Sock, raw: string | Buffer) {
  const st = ws.data.stt ?? null;

  if (typeof raw !== "string") {
    if (!st || st.done || st.stopping) return;
    const bytes = new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) as Uint8Array<ArrayBuffer>;
    /* Every frame is measured the moment it arrives, because the question at
     * the end (was there speech at all?) is about the whole request. */
    st.voiced.addFloat32Bytes(bytes);
    const f32 = new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
    if (f32.length === 0) return;
    st.chunks.push(f32);
    st.totalSamples += f32.length;
    /* The stream-lifetime cap: finalize what we have rather than grow without
     * bound, exactly the final-then-DISCONNECT the old stt server sent. */
    if (st.totalSamples / 16000 > STT_STREAM_MAX_S) {
      console.log(`[stt-stream] stream reached ${STT_STREAM_MAX_S}s; finalizing`);
      st.stopping = true;
      if (!st.decoding) void sttPass(st, true);
      return;
    }
    sttMaybeDecode(st);
    return;
  }

  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.t === "start") return sttStart(ws, m);
  if (m.t === "stop") {
    if (!st || st.done || st.stopping) return;
    st.stopping = true;
    // The final decodes the uncommitted tail; if a partial pass is mid-decode
    // it hands off to the final the moment it lands (sttPass's stopping tail).
    if (!st.decoding) void sttPass(st, true);
  }
}

// ---------------------------------------------------------------- http
//
// CORS IS GONE (voice-origin fix, the agent engine's H1 twin). This section
// used to answer EVERY response with the allow-origin wildcard and served an
// OPTIONS preflight for it, which let any web page a browser on this host
// visited read STT/TTS responses cross-origin. Nothing legitimate ever needed
// it: the agent engine is a server-side caller (CORS-exempt by nature) and the
// test bench is same-origin (a same-origin fetch never preflights). So no
// response carries any CORS grant header now, the preflight handler is
// deleted, and the gate refuses the cross-origin request itself before any
// route runs (gate.ts; gate.test.ts scans this source tree for the header as
// a static tripwire).

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });

async function serveStatic(pathname: string): Promise<Response> {
  const rel = normalize(pathname === "/" ? "/test.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const path = join(PUBLIC_DIR, rel);
  if (!path.startsWith(PUBLIC_DIR)) return new Response("forbidden", { status: 403 });
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file);
}

async function handleHttp(req: Request, server: import("bun").Server): Promise<Response> {
  /* EVERY request passes the gate first, the websocket upgrade included: the
   * /stt-stream upgrade used to run entirely ungated, so a proxied peer (a
   * loopback TCP peer carrying x-forwarded-for) could open streaming STT and
   * any host page could dial it cross-origin. One gate, before any routing,
   * closes every route and the upgrade with the same policy (gate.ts). */
  const refused = refuseOutsider(req, server);
  if (refused) return refused;

  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/stt-stream") {
    const ok = server.upgrade(req, { data: { stt: null } satisfies SockData });
    return ok ? undefined as unknown as Response : new Response("expected websocket", { status: 400 });
  }

  if (path === "/health") {
    maybeSelfCheck(); // background; this response reports the LAST known result
    // The engine is degraded when its own batch path fails its self-check. Only
    // a self-check that has actually run can say so; until the first one lands
    // (or when the self-check is off) the engine is reported healthy as before.
    const degraded = SELFCHECK_ON && selfCheck.lastRunAt > 0 && !selfCheck.ok;
    return json({
      ok: !degraded,
      degraded,
      selfcheck: SELFCHECK_ON
        ? {
            ok: selfCheck.ok,
            lastRunAt: selfCheck.lastRunAt || null,
            lastSuccessAt: selfCheck.lastSuccessAt || null,
            lastLatencyMs: selfCheck.lastLatencyMs,
            lastError: selfCheck.lastError,
            consecutiveFail: selfCheck.consecutiveFail,
            deadlineMs: SELFCHECK_DEADLINE_MS,
            tts: { ok: ttsCheck.ok },
            ttsConsecutiveFail: ttsCheck.consecutiveFail,
          }
        : { enabled: false },
      load: { active_streams: metrics.activeStreams, batch_in_flight: batchGate.inFlight, batch_queued: batchGate.queued },
      capabilities: {
        stream: {
          up: backend.asrReady,
          engine: "sherpa-onnx-whisper",
          model: backend.whisperSize,
          active_streams: metrics.activeStreams,
          ...(backend.asrError ? { error: backend.asrError } : {}),
        },
        batch: {
          up: backend.asrReady,
          engine: "sherpa-onnx-whisper",
          model: backend.whisperSize,
          languages: "multilingual",
          rtf: metrics.batch.n ? Number(metrics.batch.rtf.toFixed(3)) : null,
          measured_n: metrics.batch.n,
        },
        tts: {
          up: backend.ttsReady,
          engine: "kokoro (sherpa-onnx)",
          voice: KOKORO_VOICE,
          rtf: metrics.tts.n ? Number(metrics.tts.rtf.toFixed(3)) : null,
          measured_n: metrics.tts.n,
          ...(backend.ttsError ? { error: backend.ttsError } : {}),
        },
      },
      vocabulary: { terms: vocab.length },
    });
  }

  /* Transcription, and ONE thing that is not transcription, named here because
   * this comment used to say "no silence filtering -- the caller decides what
   * counts as speech" and that stopped being true.
   *
   * It is still true of the audio: nothing is discarded for being quiet, a
   * silent clip is still decoded, and no routing happens. What changed is that
   * a decode of a request with NO speech in it, whose whole text is one of
   * whisper's stock tells, is not returned as a transcript (stock.ts). That is
   * a claim the audio contradicts rather than a judgement about what counts as
   * speech, and the caller is told: the phrase comes back in `dropped`, so a
   * client can show "ignored: Thank you." instead of silently receiving a
   * shorter transcript than the one whisper produced.
   *
   * Two other clients read this route (P5 `transcribe.sh`, P6 Vector) and both
   * keep working unchanged: `dropped` is a new field and `text` is what it
   * always was on every clip that has a voice in it. */
  if (path === "/stt" && req.method === "POST") {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength === 0) return json({ error: "empty body" }, 400);
    /* `?offset=<seconds>` decodes ONLY the tail past that point (deferred
     * words, agent-engine transcribeUpload). Absent or non-positive means the
     * whole clip, which is every other caller unchanged. NaN and negatives are
     * treated as absent rather than errored: a bad offset should decode more,
     * never crash a transcription. */
    const rawOffset = Number(url.searchParams.get("offset"));
    const offsetS = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    /* BOUND THE CONCURRENCY (#551). At most BATCH_MAX decodes run at once; a
     * request that cannot get a slot within BATCH_QUEUE_WAIT_MS fails LOUDLY
     * with 503 instead of queueing behind a wedge for ever. The slot is
     * released on EVERY exit path below (the finally), so a request that throws
     * between acquire and release cannot leak one -- which is the shape that let
     * the old unbounded path pile up hung decodes until the engine wedged. */
    /* The wait for a decode slot is part of "why was stt slow", so it is
     * measured from the request arriving to the slot being granted and handed
     * back to the caller (agent-engine logs the split, #575). */
    const tReq = performance.now();
    const got = await batchGate.acquire(BATCH_QUEUE_WAIT_MS);
    const queueMs = performance.now() - tReq;
    if (!got) {
      return json({ error: `voice engine busy: ${batchGate.inFlight} decoding, ${batchGate.queued} queued` }, 503);
    }
    try {
      const raw = await transcribe(bytes, offsetS);
      const { text, corrections } = correct(raw.text, vocab);
      /* Additive timing so the caller can log queue vs decode rather than only
       * its own wall time. `rtf` is null when nothing decodable was found
       * (audioS 0), the same guard rollRtf uses. Existing readers take `text`
       * and `dropped` and never look here, so the shape is safe. */
      const rtf = raw.audioS > 0 ? raw.computeMs / 1000 / raw.audioS : null;
      return json({
        text, corrections, dropped: raw.dropped,
        // "salvaged" when a broken container was re-muxed to recover its audio,
        // "broken" when it read broken and nothing more could be salvaged; the
        // caller logs it so restart-corrupt notes are visible (task 594). Omitted
        // on the ordinary path so existing readers see the shape unchanged.
        mode: raw.mode === "normal" ? undefined : raw.mode,
        timing: {
          queueMs: Math.round(queueMs),
          decodeMs: Math.round(raw.computeMs),
          audioS: Number(raw.audioS.toFixed(2)),
          rtf: rtf === null ? null : Number(rtf.toFixed(3)),
        },
      });
    } catch (e) {
      console.error("[stt]", e);
      return json({ error: String(e) }, 502);
    } finally {
      batchGate.release();
    }
  }

  /* Which voices this host speaks in: kokoro's own speaker table (sherpa.ts),
   * the same fifty-odd names kokoro-FastAPI served, same response shape. */
  if (path === "/voices" && req.method === "GET") {
    return json({ voices: backend.voices(), current: KOKORO_VOICE });
  }

  if (path === "/tts" && req.method === "POST") {
    let body: { text?: string; voice?: string; stream?: boolean; pcm?: boolean };
    try {
      body = await req.json();
    } catch {
      return json({ error: "expected json" }, 400);
    }
    const text = (body.text ?? "").trim();
    if (!text) return json({ error: "text required" }, 400);
    try {
      const t0 = performance.now();
      const pcm = body.pcm === true;
      const up = await synthesize(text, body.voice || KOKORO_VOICE, body.stream === true, pcm);
      /* The upstream fetch resolves when kokoro's headers arrive, so this is
       * first byte; reading the body below is the rest of the transfer. Both go
       * out as response headers the caller logs (#575) -- headers, not the body,
       * because the body is binary mp3 and every existing reader wants it whole. */
      const ttfbMs = performance.now() - t0;
      const chars = text.length;
      const audioS = Math.max(1, chars / 15);
      if (body.stream === true && up.body) {
        // chunked pass-through: playback can start before synthesis finishes
        return new Response(up.body, { headers: {
          "content-type": pcm ? "application/octet-stream" : "audio/mpeg",
          ...(pcm ? { "x-pcm-rate": String(KOKORO_PCM_RATE) } : {}),
          "x-voice-op": "tts", "x-voice-chars": String(chars),
          "x-voice-ttfb-ms": ttfbMs.toFixed(1) } });
      }
      const audio = new Uint8Array(await up.arrayBuffer());
      const synthMs = performance.now() - t0;
      rollRtf(metrics.tts, synthMs / 1000, audioS);
      const rtf = synthMs / 1000 / audioS;
      return new Response(audio, {
        headers: {
          "content-type": pcm ? "application/octet-stream" : "audio/mpeg",
          "content-length": String(audio.byteLength),
          ...(pcm ? { "x-pcm-rate": String(KOKORO_PCM_RATE) } : {}),
          "x-voice-op": "tts", "x-voice-chars": String(chars),
          "x-voice-audio-s": audioS.toFixed(2),
          "x-voice-ttfb-ms": ttfbMs.toFixed(1),
          "x-voice-synth-ms": synthMs.toFixed(1),
          "x-voice-rtf": rtf.toFixed(3),
        },
      });
    } catch (e) {
      console.error("[tts]", e);
      return json({ error: String(e) }, 502);
    }
  }

  if (req.method === "GET") {
    return serveStatic(path);
  }
  return new Response("not found", { status: 404 });
}

// ---------------------------------------------------------------- boot

const server = Bun.serve<SockData>({
  port: PORT,
  hostname: HOST,
  fetch: handleHttp,
  websocket: {
    open() {},
    message(ws, raw) {
      sttMessage(ws, raw as string | Buffer);
    },
    close(ws) {
      if (ws.data.stt) sttTeardown(ws.data.stt);
    },
  },
});

console.log(`voice-engine  http://${server.hostname}:${server.port}`);
console.log(`  backend  sherpa-onnx in-process` +
  (backend.stubUrl ? ` (STUBBED: ${backend.stubUrl})` : ""));
console.log(`  stt      whisper-${backend.whisperSize} (${backend.whisperDir})`);
console.log(`  tts      kokoro-${backend.kokoroVariant} (${backend.kokoroDir}, voice ${KOKORO_VOICE})`);
console.log(`  batch    max ${BATCH_MAX} concurrent, ${BATCH_QUEUE_WAIT_MS}ms queue wait, ffmpeg kill ${FFMPEG_TIMEOUT_MS}ms`);

// The batch-path self-check (#551): a real decode on a timer so /health cannot
// report ok while /stt is wedged. On by default (VOICE_SELFCHECK=0 opts out);
// the first run fires shortly after boot, once whisper is likely up.
if (SELFCHECK_ON) {
  console.log(`  selfcheck every ${SELFCHECK_INTERVAL_MS}ms, deadline ${SELFCHECK_DEADLINE_MS}ms, ` +
    `exit-after ${SELFCHECK_EXIT ? SELFCHECK_FAIL_LIMIT : "off"}, ` +
    `tts-deadline ${SELFCHECK_TTS_DEADLINE_MS}ms, ` +
    `tts-watchdog ${TTS_WATCHDOG ? `on cooldown ${TTS_RESTART_COOLDOWN_MS}ms` : "off"}`);
  setTimeout(() => void runSelfCheck(), Math.min(5_000, SELFCHECK_INTERVAL_MS));
  const iv = setInterval(() => void runSelfCheck(), SELFCHECK_INTERVAL_MS);
  // Don't let the interval hold the process open on its own.
  if (typeof iv.unref === "function") iv.unref();
}
