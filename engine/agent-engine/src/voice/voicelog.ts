/* One line per voice op, with the resources the host had at the time (#575).
 *
 * WHY THIS EXISTS
 *
 * "When I feel that the TTS is slow, we can actually look at the logs." Until
 * now a spoken reply's only trace was `[speak] tts failed` on an error and
 * nothing at all on a slow-but-successful one, so "the voice got sluggish
 * around nine" was unanswerable. This records EVERY tts and stt op the engine
 * asks the voice engine for: how long it took (split into the wait before the
 * upstream started, the upstream's own time, and this engine's wall total), the
 * voice engine's reported rtf, and the host's load / free RAM / GPU at that
 * instant. So `journalctl | grep '\[voice\]'` is the whole story of a slow spell.
 *
 * TWO SINKS, ONE RECORD. Each op is written as a `[voice] <op> k=v...` line
 * through the shared engine logbook (openLog, idempotent, so this is the SAME
 * book server.ts writes every other line to) AND pushed to a bounded ring the
 * `GET /voice-log` route serves as JSON. The ring and the log line carry the
 * same fields, so his future self (or a plugin) can read the recent history
 * without journalctl.
 *
 * THE SAMPLER IS SHARED AND CHEAP. loadavg and free RAM come from `os`; the GPU
 * from /sys (amdgpu on this host). A whole burst of chunks synthesised back to
 * back should not stat /sys once per chunk, so the snapshot is cached ~1s: the
 * first op in a burst pays for it and the rest read the cache. This is the ONLY
 * host-resource sampler; services.ts reads a per-pid macOS footprint for its
 * ceiling, which is a different question and stays where it is.
 */

import { readFileSync, readdirSync } from "node:fs";
import { loadavg, freemem } from "node:os";
import { openLog } from "../../../shared/logbook.ts";

const LOG = openLog("engine");

/** What the host had when an op ran. A field is null when it could not be read,
 *  which is not the same as zero: a GPU that is genuinely idle reads 0, a GPU
 *  this host does not expose reads null. */
export type ResourceSnapshot = {
  /** 1-minute load average. */
  load1: number;
  /** Free RAM in MB. */
  freeRamMb: number;
  /** GPU busy percent, or null when no card exposes it. */
  gpuUtil: number | null;
  /** GPU VRAM in use, in MB, or null. */
  gpuMemMb: number | null;
  /** GPU VRAM total, in MB, or null. */
  gpuMemTotalMb: number | null;
};

/** One voice op, exactly as it lands both in the log line and in the ring. */
export type VoiceLogRec = {
  /** When the op finished, epoch ms. */
  ts: number;
  op: "tts" | "stt";
  /** The session this op is for, when the call site has one (tts does; the stt
   *  decode path keys on `cid` instead, the correlation id that survives it). */
  session?: string;
  cid?: string;
  /** tts: input characters. stt: output characters. */
  chars?: number;
  /** stt: decoded audio seconds. tts: the voice engine's approx synth seconds. */
  audioS?: number;
  /** tts only: the voice chosen. */
  voice?: string;
  /** Time from the op being requested to the upstream fetch starting (ms). */
  queueWaitMs?: number;
  /** Upstream first byte, ms (tts, where the response streams). */
  upstreamTtfbMs?: number;
  /** The voice engine's own reported time for the op, ms (its synth or decode). */
  upstreamMs?: number;
  /** This engine's wall total for the op, ms. */
  engineMs: number;
  /** The voice engine's reported rtf (compute / audio; lower is faster). */
  rtf?: number;
  /** stt only: "salvaged" when the voice engine re-muxed a broken container to
   *  recover its audio, "broken" when it read broken and nothing could be
   *  salvaged (task 594). Absent on the ordinary decode. Makes a restart-corrupt
   *  note visible in the log rather than lost as a silent chars=0. */
  mode?: "salvaged" | "broken";
  outcome: "ok" | "timeout" | "error";
  err?: string;
} & ResourceSnapshot;

/** The bounded history the /voice-log route serves. 200 is a few minutes of a
 *  busy conversation, enough to look back at "it just got slow" without
 *  becoming a second unbounded writer (logbook.ts already carries the durable
 *  copy). */
const RING_MAX = Number(process.env.CYC_VOICE_LOG_RING ?? 200);
const ring: VoiceLogRec[] = [];

// ------------------------------------------------------------ the sampler

const GPU_ROOT = process.env.CYC_GPU_SYS_DIR ?? "/sys/class/drm";
const SNAPSHOT_TTL_MS = 1000;
let cached: { at: number; snap: ResourceSnapshot } | null = null;

function readIntFile(path: string): number | null {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** The first drm card that exposes gpu_busy_percent, and its VRAM figures. All
 *  null when no such card is present (a headless host, a Mac). Reads three tiny
 *  sysfs files; the ~1s cache keeps a burst from doing it per chunk. */
function readGpu(): Pick<ResourceSnapshot, "gpuUtil" | "gpuMemMb" | "gpuMemTotalMb"> {
  let cards: string[];
  try {
    cards = readdirSync(GPU_ROOT).filter((n) => /^card\d+$/.test(n));
  } catch {
    return { gpuUtil: null, gpuMemMb: null, gpuMemTotalMb: null };
  }
  for (const card of cards) {
    const dev = `${GPU_ROOT}/${card}/device`;
    const util = readIntFile(`${dev}/gpu_busy_percent`);
    if (util === null) continue; // not the render node, or not amdgpu
    const usedB = readIntFile(`${dev}/mem_info_vram_used`);
    const totalB = readIntFile(`${dev}/mem_info_vram_total`);
    return {
      gpuUtil: util,
      gpuMemMb: usedB === null ? null : Math.round(usedB / 1048576),
      gpuMemTotalMb: totalB === null ? null : Math.round(totalB / 1048576),
    };
  }
  return { gpuUtil: null, gpuMemMb: null, gpuMemTotalMb: null };
}

/** The host's load, free RAM and GPU right now, cached ~1s so a burst of chunks
 *  samples once. Never throws: a snapshot that could not read a field carries
 *  null for it rather than failing the op it was decorating. */
export function sampleResources(): ResourceSnapshot {
  const now = Date.now();
  if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.snap;
  const snap: ResourceSnapshot = {
    load1: Number(loadavg()[0].toFixed(2)),
    freeRamMb: Math.round(freemem() / 1048576),
    ...readGpu(),
  };
  cached = { at: now, snap };
  return snap;
}

// ------------------------------------------------------------ the record

/** The fields a call site supplies; ts and the resource snapshot are attached
 *  here so no caller has to remember to. */
export type VoiceOp = Omit<VoiceLogRec, keyof ResourceSnapshot | "ts">;

/* The k=v tail of the log line, in a fixed order so a human reading a column of
 * them can scan down one field. Undefined values are dropped by the logbook, so
 * a tts record simply omits stt-only fields and vice versa. */
function logFields(rec: VoiceLogRec): Record<string, unknown> {
  return {
    session: rec.session,
    cid: rec.cid,
    voice: rec.voice,
    chars: rec.chars,
    audioS: rec.audioS,
    queueMs: rec.queueWaitMs,
    ttfbMs: rec.upstreamTtfbMs,
    upstreamMs: rec.upstreamMs,
    engineMs: rec.engineMs,
    rtf: rec.rtf,
    mode: rec.mode,
    load: rec.load1,
    freeRamMb: rec.freeRamMb,
    gpuUtil: rec.gpuUtil,
    gpuMemMb: rec.gpuMemMb,
    outcome: rec.outcome,
    err: rec.err,
  };
}

/** Record one voice op: sample the host, build the record, write the `[voice]`
 *  line and push it on the ring. Never throws (a logger that can fail a voice
 *  note is worse than no logger, same rule as logbook.ts). */
export function recordVoiceOp(op: VoiceOp): VoiceLogRec {
  const rec: VoiceLogRec = { ...op, ts: Date.now(), ...sampleResources() };
  try {
    LOG.line(`[voice] ${rec.op}`, logFields(rec));
  } catch {
    /* the ring still gets it */
  }
  ring.push(rec);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  return rec;
}

/** The recent history, newest last, a shallow copy so a reader cannot mutate
 *  the ring. */
export function recentVoiceLog(): VoiceLogRec[] {
  return ring.slice();
}

/** TEST ONLY: empty the ring and drop the ~1s resource snapshot, so one test
 *  cannot read another's history or another's host reading. The snapshot cache
 *  is the sharper of the two: a whole test FILE usually runs inside one 1000ms
 *  window, so without this every test after the first would be handed the first
 *  test's load / GPU numbers no matter what the host did in between. No-op in
 *  production, which wants exactly that caching. */
export function resetForTest(): void {
  ring.length = 0;
  cached = null;
}
