/* The sherpa-onnx backend: kokoro TTS + offline whisper STT, in-process.
 *
 * This is what replaced the python voice stack (kokoro-FastAPI on :10104 and
 * the pywhispercpp venv on :10103/:10105). The voice engine's OUTWARD contract
 * (server.ts: /tts, /stt, /stt-stream, /voices, /health) is unchanged; only
 * the backend behind it moved from python-over-HTTP to sherpa-onnx-node, the
 * prebuilt node addon (no venv, no compile, models are plain downloads).
 *
 * The native calls are synchronous and CPU-heavy, so they run in two Workers
 * (backend/sherpa-worker.ts): one for TTS, one for ASR, so a long whisper decode can
 * never stall speech synthesis or the event loop. Each worker serializes its
 * own requests; deadlines are enforced here (a request past its deadline
 * rejects loudly; the worker finishes the stale decode and the late answer is
 * dropped).
 *
 * MODELS ARRIVE IN THE BACKGROUND (agent-engine modelwarmup.ts): on a fresh
 * install this process boots before the model files exist. The backend polls
 * for them and brings each worker up the moment its files land, so readiness
 * flips without a restart; /health reports each capability honestly meanwhile.
 *
 * HERMETIC TESTS: VOICE_SHERPA_STUB_URL short-circuits the whole native path.
 * With it set, no worker is spawned and no model is read; transcribe() POSTs
 * the wav to `<url>/v1/audio/transcriptions` (answering {text}) and
 * synthesize() POSTs to `<url>/v1/audio/speech` (answering raw s16le PCM, or
 * any bytes -- they are interpreted as PCM). The stub is an HTTP server so a
 * test can make it hang, delay, count, or answer canned text from outside the
 * engine process -- the same seam the old stub-whisper/stub-kokoro tests used.
 *
 *   bun test src/backend/sherpa-contract.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../../shared/cycdir.ts";
import { voiceModelsDir, kokoroDirName, whisperDirName,
  kokoroPresencePaths, whisperPresencePaths } from "../../../shared/voicepaths.ts";
import { writeWav } from "../audio/silence";

/* kokoro-multi-lang-v1_0's speaker table: integer sid <-> the voice names the
 * whole product already uses (af_heart is the shipped default). From sherpa's
 * own docs for this exact model (53 speakers, ids 0-52). */
export const KOKORO_VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica",
  "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah",
  "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir",
  "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel",
  "bm_fable", "bm_george", "bm_lewis", "ef_dora", "em_alex",
  "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
  "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune",
  "jf_nezumi", "jf_tebukuro", "jm_kumo",
  "pf_dora", "pm_alex", "pm_santa", "zf_xiaobei", "zf_xiaoni",
  "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi",
  "zm_yunxia", "zm_yunyang",
] as const;

export function voiceId(name: string): number {
  const i = (KOKORO_VOICES as readonly string[]).indexOf(name);
  return i >= 0 ? i : 3; // af_heart, the shipped default
}

export type TtsClip = { samples: Float32Array; sampleRate: number };

/* WHICH MODELS, in precedence order: env (tests, one-off runs) > the choice
 * `cyc model` persisted in the data dir's state/voice-models.json (the same
 * store the agent engine's voicemodels.ts writes; a model change restarts
 * this process, which re-reads it here) > the shipped defaults. */
function storedChoice(kind: "whisper" | "kokoro"): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir(), "state", "voice-models.json"), "utf8"));
    const v = parsed?.[kind];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
const KOKORO_VARIANT = process.env.VOICE_KOKORO_VARIANT ?? storedChoice("kokoro") ?? "multi-lang-v1_0";
const WHISPER_SIZE = process.env.VOICE_WHISPER_SIZE ?? storedChoice("whisper") ?? "turbo";
const WHISPER_LANGUAGE = process.env.VOICE_STT_LANGUAGE ?? "en";
const MODEL_POLL_MS = Number(process.env.VOICE_MODEL_POLL_MS ?? 5_000);
const TTS_THREADS = Math.max(1, Number(process.env.VOICE_TTS_THREADS ?? 2));
const ASR_THREADS = Math.max(1, Number(process.env.VOICE_ASR_THREADS ?? 4));

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null };

class WorkerHost {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  ready = false;
  lastError: string | null = null;
  meta: { numSpeakers?: number; sampleRate?: number } = {};

  constructor(private readonly role: "tts" | "asr",
    private readonly initMsg: () => Record<string, unknown>,
    private readonly log: (line: string) => void) {}

  start(): void {
    if (this.worker) return;
    const w = new Worker(new URL("./sherpa-worker.ts", import.meta.url).href);
    this.worker = w;
    w.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
    w.onerror = (ev: ErrorEvent) => {
      this.lastError = String(ev.message ?? "worker error");
      this.log(`[sherpa] ${this.role} worker error: ${this.lastError}`);
    };
    w.postMessage({ t: "init", role: this.role, ...this.initMsg() });
  }

  /** Kill and respawn: the TTS watchdog's restart, and nothing else's. Every
   *  in-flight request rejects loudly rather than hanging. */
  restart(): void {
    const w = this.worker;
    this.worker = null;
    this.ready = false;
    if (w) { try { w.terminate(); } catch {} }
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`${this.role} worker restarted mid-request`));
    }
    this.pending.clear();
    this.start();
  }

  private onMessage(m: any): void {
    if (m?.t === "ready") {
      this.ready = true;
      this.lastError = null;
      this.meta = { numSpeakers: m.numSpeakers, sampleRate: m.sampleRate };
      this.log(`[sherpa] ${this.role} model loaded` +
        (m.numSpeakers ? ` (${m.numSpeakers} speakers, ${m.sampleRate} Hz)` : ""));
      return;
    }
    if (m?.t === "init-error") {
      this.lastError = String(m.error);
      this.log(`[sherpa] ${this.role} model failed to load: ${this.lastError}`);
      return;
    }
    if (m?.t === "done") {
      const p = this.pending.get(m.id);
      if (!p) return; // past its deadline; the late answer is dropped
      this.pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String(m.error)));
      else p.resolve(m);
    }
  }

  request(msg: Record<string, unknown>, deadlineMs: number, transfer: Transferable[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.ready) {
        reject(new Error(`${this.role} engine not ready` +
          (this.lastError ? ` (${this.lastError})` : "")));
        return;
      }
      const id = this.nextId++;
      const timer = deadlineMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${this.role} request exceeded ${deadlineMs}ms`));
          }, deadlineMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }
}

export class SherpaBackend {
  readonly stubUrl: string | null;
  readonly kokoroDir: string;
  readonly whisperDir: string;
  readonly whisperSize = WHISPER_SIZE;
  readonly kokoroVariant = KOKORO_VARIANT;
  private ttsHost: WorkerHost | null = null;
  private asrHost: WorkerHost | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly log: (line: string) => void;

  constructor(opts: { log?: (line: string) => void } = {}) {
    this.log = opts.log ?? console.log;
    this.stubUrl = (process.env.VOICE_SHERPA_STUB_URL ?? "").replace(/\/$/, "") || null;
    const dir = voiceModelsDir();
    this.kokoroDir = join(dir, kokoroDirName(KOKORO_VARIANT));
    this.whisperDir = join(dir, whisperDirName(WHISPER_SIZE));
  }

  /** Bring up whatever can come up now, and keep looking for the rest: on a
   *  fresh install the model files land in the background (modelwarmup.ts)
   *  and each capability flips ready the poll after its files arrive. */
  start(): void {
    if (this.stubUrl) {
      this.log(`[sherpa] stub mode: ${this.stubUrl} (no native models loaded)`);
      return;
    }
    const tick = () => {
      if (!this.ttsHost && kokoroPresencePaths(KOKORO_VARIANT).every((p) => existsSync(p))) {
        this.ttsHost = new WorkerHost("tts",
          () => ({ numThreads: TTS_THREADS, kokoro: { dir: this.kokoroDir } }), this.log);
        this.ttsHost.start();
      }
      if (!this.asrHost && whisperPresencePaths(WHISPER_SIZE).every((p) => existsSync(p))) {
        this.asrHost = new WorkerHost("asr",
          () => ({ numThreads: ASR_THREADS,
            whisper: { dir: this.whisperDir, size: WHISPER_SIZE, language: WHISPER_LANGUAGE } }),
          this.log);
        this.asrHost.start();
      }
      if (this.ttsHost && this.asrHost && this.poll) {
        clearInterval(this.poll);
        this.poll = null;
      }
    };
    tick();
    if (!this.ttsHost || !this.asrHost) {
      this.log("[sherpa] some model files are not on disk yet; " +
        "polling until the background download lands them");
      this.poll = setInterval(tick, MODEL_POLL_MS);
      if (typeof this.poll.unref === "function") this.poll.unref();
    }
  }

  get ttsReady(): boolean { return this.stubUrl !== null || this.ttsHost?.ready === true; }
  get asrReady(): boolean { return this.stubUrl !== null || this.asrHost?.ready === true; }
  get ttsError(): string | null { return this.ttsHost?.lastError ?? null; }
  get asrError(): string | null { return this.asrHost?.lastError ?? null; }

  /** The TTS watchdog's restart: respawn the TTS worker (the in-process
   *  successor of `systemctl restart cyc-kokoro.service`). */
  restartTts(): void {
    this.ttsHost?.restart();
  }

  /** Mono f32 PCM -> text, bounded. The one decoder both the batch windows
   *  and the stream emulation call. */
  async transcribe(samples: Float32Array, sampleRate: number, deadlineMs: number): Promise<string> {
    if (this.stubUrl) {
      const s16 = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        s16[i] = Math.round(v * 32767);
      }
      const res = await fetch(`${this.stubUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: writeWav(s16),
        signal: deadlineMs > 0 ? AbortSignal.timeout(deadlineMs) : undefined,
      });
      if (!res.ok) throw new Error(`stub stt ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { text?: string };
      return j.text ?? "";
    }
    // The buffer is COPIED for transfer: callers reuse their accumulation
    // buffers and a transferred buffer is detached from the sender.
    const copy = samples.slice();
    const r = await this.asrRequest({ t: "asr", samples: copy, sampleRate }, deadlineMs, [copy.buffer]);
    return String(r.text ?? "");
  }

  private asrRequest(msg: Record<string, unknown>, deadlineMs: number, transfer: Transferable[]): Promise<any> {
    if (!this.asrHost) return Promise.reject(new Error("asr engine not ready (model not on disk yet)"));
    return this.asrHost.request(msg, deadlineMs, transfer);
  }

  /** Text -> one PCM clip (mono f32 at the model's rate, 24k for kokoro). */
  async synthesize(text: string, voice: string, speed: number, deadlineMs: number): Promise<TtsClip> {
    if (this.stubUrl) {
      const res = await fetch(`${this.stubUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: text, voice }),
        signal: deadlineMs > 0 ? AbortSignal.timeout(deadlineMs) : undefined,
      });
      if (!res.ok) throw new Error(`stub tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error("stub tts returned no audio");
      const n = Math.floor(bytes.byteLength / 2);
      const s16 = new Int16Array(bytes.buffer, bytes.byteOffset, n);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = s16[i] / 32768;
      return { samples, sampleRate: 24000 };
    }
    if (!this.ttsHost) throw new Error("tts engine not ready (model not on disk yet)");
    const r = await this.ttsHost.request(
      { t: "tts", text, sid: voiceId(voice), speed }, deadlineMs);
    return { samples: r.samples as Float32Array, sampleRate: Number(r.sampleRate) };
  }

  voices(): string[] {
    return [...KOKORO_VOICES];
  }
}
