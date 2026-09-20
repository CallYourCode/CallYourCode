/* The voice-op record, the resource snapshot and the bounded ring (#575).
 *
 *   bun test agent-engine/src/voice/voicelog.test.ts
 *
 * All three are pure of any engine or voice engine: recordVoiceOp builds a
 * record, samples the host and pushes it on a ring, and recentVoiceLog serves
 * that ring -- exactly what the `[voice]` log lines and the GET /voice-log route
 * carry. The GPU half is made deterministic by pointing the sampler at a FAKE
 * sysfs the test writes, so it proves the amdgpu parsing on a host that has no
 * GPU at all (CI) the same as on the one that does.
 *
 * THE THREE ENV VARS ARE SET ONCE, HERE, BEFORE THE MODULE IS IMPORTED (the log
 * dir, the fake GPU root and a small ring cap are read at load), which is why
 * the import is dynamic and comes after the assignments. They are restored in
 * afterAll so a worker that runs another file after this one does not inherit a
 * five-entry ring or a GPU root that no longer exists.
 */
import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";
import type { VoiceLogRec } from "./voicelog.ts";

const ROOT = await tmpDir("voicelog-");
const LOG_DIR = join(ROOT, "logs");
const GPU_ROOT = join(ROOT, "drm");

// A fake amdgpu card: gpu_busy_percent + VRAM in bytes, the exact files
// /sys/class/drm/card0/device exposes on the real host.
const CARD0 = join(GPU_ROOT, "card0", "device");
mkdirSync(CARD0, { recursive: true });
writeFileSync(join(CARD0, "gpu_busy_percent"), "42\n");
writeFileSync(join(CARD0, "mem_info_vram_used"), String(1258291200)); // 1200 MB
writeFileSync(join(CARD0, "mem_info_vram_total"), String(3221225472)); // 3072 MB
// A non-render card with no busy file, to prove the scan skips it.
mkdirSync(join(GPU_ROOT, "card1", "device"), { recursive: true });

const priorEnv = {
  CYC_LOG_DIR: process.env.CYC_LOG_DIR,
  CYC_GPU_SYS_DIR: process.env.CYC_GPU_SYS_DIR,
  CYC_VOICE_LOG_RING: process.env.CYC_VOICE_LOG_RING,
};
process.env.CYC_LOG_DIR = LOG_DIR;
process.env.CYC_GPU_SYS_DIR = GPU_ROOT;
process.env.CYC_VOICE_LOG_RING = "5";
afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/* A CACHE-BUSTING import, not the bare "./voicelog.ts": that module reads its
 * three env vars into consts at load, and in the full suite a sibling file
 * imports it FIRST (with the real /sys GPU root and the default ring cap), so a
 * bare import here would hand back that already-frozen singleton and this file's
 * fake sysfs and small ring would be ignored. A distinct module URL forces a
 * fresh evaluation that reads the env set just above. (The per-test imports
 * below already do this for the same reason.) */
const { recordVoiceOp, recentVoiceLog, sampleResources, resetForTest } =
  await import(`./voicelog.ts?fresh=${Date.now()}`);

/* The ring AND the ~1s snapshot cache, both dropped per test. The snapshot is
 * the one that bites: this whole file runs inside a single 1000ms window, so a
 * cached reading would otherwise outlive every test in it. */
beforeEach(() => resetForTest());

test("a tts record carries the op fields it was given plus a resource snapshot", () => {
  recordVoiceOp({
    op: "tts", session: "w7:pB7", voice: "af_heart", chars: 42,
    queueWaitMs: 3, upstreamTtfbMs: 40, upstreamMs: 210, audioS: 2.8, rtf: 0.34,
    engineMs: 230, outcome: "ok",
  });
  const recs = recentVoiceLog();
  expect(recs.length).toBe(1);
  const r = recs[0];
  // the op fields, verbatim
  expect(r.op).toBe("tts");
  expect(r.session).toBe("w7:pB7");
  expect(r.voice).toBe("af_heart");
  expect(r.chars).toBe(42);
  expect(r.upstreamMs).toBe(210);
  expect(r.rtf).toBe(0.34);
  expect(r.outcome).toBe("ok");
  expect(typeof r.ts).toBe("number");
  // the resource snapshot, attached here so no caller has to
  expect(typeof r.load1).toBe("number");
  expect(typeof r.freeRamMb).toBe("number");
  // the fake GPU, parsed: percent as-is, bytes -> MB
  expect(r.gpuUtil).toBe(42);
  expect(r.gpuMemMb).toBe(1200);
  expect(r.gpuMemTotalMb).toBe(3072);
});

test("an stt error record records the outcome and omits the fields it has no value for", () => {
  recordVoiceOp({ op: "stt", cid: "s-abc", engineMs: 90, outcome: "timeout", err: "TimeoutError" });
  const r = recentVoiceLog()[0];
  expect(r.op).toBe("stt");
  expect(r.cid).toBe("s-abc");
  expect(r.outcome).toBe("timeout");
  expect(r.err).toBe("TimeoutError");
  // no upstream timing was known, so those fields are simply absent
  expect(r.upstreamMs).toBeUndefined();
  expect(r.rtf).toBeUndefined();
  expect(r.chars).toBeUndefined();
});

test("the salvaged/broken mode survives onto the record (task 594)", () => {
  // a restart-corrupt note used to be lost as a silent chars=0; the mode is what
  // makes it greppable
  recordVoiceOp({ op: "stt", cid: "s-1", engineMs: 10, outcome: "ok", mode: "salvaged", chars: 12 });
  recordVoiceOp({ op: "stt", cid: "s-2", engineMs: 10, outcome: "ok", mode: "broken", chars: 0 });
  expect(recentVoiceLog().map((r: VoiceLogRec) => r.mode)).toEqual(["salvaged", "broken"]);
  // chars: 0 is a real reading and must not be dropped as falsy
  expect(recentVoiceLog()[1].chars).toBe(0);
});

test("recordVoiceOp hands back the same record it pushed", () => {
  // the call sites use the return value for their own logging; a copy would
  // drift from the ring
  const got = recordVoiceOp({ op: "tts", chars: 1, engineMs: 1, outcome: "ok" });
  expect(recentVoiceLog()[0]).toBe(got);
});

test("the ring keeps only the last N, newest last", () => {
  for (let i = 0; i < 12; i++) {
    recordVoiceOp({ op: "tts", chars: i, engineMs: i, outcome: "ok" });
  }
  const recs = recentVoiceLog();
  expect(recs.length).toBe(5); // CYC_VOICE_LOG_RING
  // the five that survived are the five most recent, in order
  expect(recs.map((r: VoiceLogRec) => r.chars)).toEqual([7, 8, 9, 10, 11]);
});

test("the ring is exact at the cap: N entries, then N+1 evicts exactly one", () => {
  for (let i = 0; i < 5; i++) recordVoiceOp({ op: "tts", chars: i, engineMs: 0, outcome: "ok" });
  expect(recentVoiceLog().map((r: VoiceLogRec) => r.chars)).toEqual([0, 1, 2, 3, 4]); // at the cap, nothing dropped
  recordVoiceOp({ op: "tts", chars: 5, engineMs: 0, outcome: "ok" });
  expect(recentVoiceLog().map((r: VoiceLogRec) => r.chars)).toEqual([1, 2, 3, 4, 5]); // one in, one out
});

test("recentVoiceLog is a copy: mutating it cannot corrupt the ring", () => {
  recordVoiceOp({ op: "tts", chars: 1, engineMs: 1, outcome: "ok" });
  const first = recentVoiceLog();
  first.push({} as never);
  first.length = 0;
  expect(recentVoiceLog().length).toBe(1);
});

test("an empty ring answers an empty array, not undefined", () => {
  expect(recentVoiceLog()).toEqual([]);
});

test("the resource snapshot is cached across a burst", () => {
  const a = sampleResources();
  const b = sampleResources();
  expect(b).toBe(a); // same object within the ~1s window: a burst samples once
  expect(Number.isFinite(a.load1)).toBe(true);
  expect(Number.isFinite(a.freeRamMb)).toBe(true);
  expect(a.gpuUtil).toBe(42);
});

test("a whole burst of records shares one snapshot object", () => {
  // the reason the cache exists: 20 chunks synthesised back to back must not
  // stat /sys 20 times
  const recs = Array.from({ length: 20 }, (_v, i) =>
    recordVoiceOp({ op: "tts", chars: i, engineMs: 1, outcome: "ok" }));
  const first = recs[0];
  for (const r of recs) {
    expect(r.gpuUtil).toBe(first.gpuUtil);
    expect(r.freeRamMb).toBe(first.freeRamMb);
  }
});

test("resetForTest drops the snapshot, so a stale host reading cannot leak forward", () => {
  /* THE KNOWN ORDER-DEPENDENCE, pinned. The snapshot lives ~1s and this whole
   * file runs well inside one, so without the reset in beforeEach the FIRST
   * test's GPU reading would be the answer every later test got, and a test that
   * changed the fake sysfs would silently assert against the old numbers. */
  const stale = sampleResources();
  expect(stale.gpuUtil).toBe(42);

  writeFileSync(join(CARD0, "gpu_busy_percent"), "91\n");
  expect(sampleResources().gpuUtil).toBe(42); // still cached: the TTL is real

  resetForTest();
  expect(sampleResources().gpuUtil).toBe(91); // and the reset really drops it
  writeFileSync(join(CARD0, "gpu_busy_percent"), "42\n");
});

test("resetForTest empties the ring, so a count assertion cannot inherit history", () => {
  recordVoiceOp({ op: "tts", chars: 1, engineMs: 1, outcome: "ok" });
  expect(recentVoiceLog()).toHaveLength(1);
  resetForTest();
  expect(recentVoiceLog()).toHaveLength(0);
});

test("a GPU that exposes nothing reads null, which is not the same as zero", async () => {
  /* A headless host or a Mac: the fields are null so a reader can tell "no card
   * here" from "a card that is genuinely idle at 0%". Pointed at an empty tree
   * rather than the fake card, through a fresh module registry so the root is
   * re-read at load. */
  const empty = join(await tmpDir("voicelog-nogpu-"), "drm");
  mkdirSync(empty, { recursive: true });
  const prior = process.env.CYC_GPU_SYS_DIR;
  process.env.CYC_GPU_SYS_DIR = empty;
  try {
    const mod = await import(`./voicelog.ts?nogpu=${Date.now()}`);
    const snap = mod.sampleResources();
    expect(snap.gpuUtil).toBeNull();
    expect(snap.gpuMemMb).toBeNull();
    expect(snap.gpuMemTotalMb).toBeNull();
    // load and RAM still read: a missing GPU does not blank the whole snapshot
    expect(Number.isFinite(snap.load1)).toBe(true);
    expect(Number.isFinite(snap.freeRamMb)).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.CYC_GPU_SYS_DIR;
    else process.env.CYC_GPU_SYS_DIR = prior;
  }
});

test("a card with no gpu_busy_percent is skipped rather than read as 0", () => {
  // card1 in the fake tree has a device dir and no files at all; the scan must
  // fall through to card0 rather than stopping at the first directory it sees
  resetForTest();
  expect(sampleResources().gpuUtil).toBe(42);
});

test("unreadable VRAM files leave the memory fields null while the percent stands", async () => {
  const root = join(await tmpDir("voicelog-partial-"), "drm");
  mkdirSync(join(root, "card0", "device"), { recursive: true });
  writeFileSync(join(root, "card0", "device", "gpu_busy_percent"), "7\n");
  // no mem_info_vram_* at all: the card reports busy but not memory
  const prior = process.env.CYC_GPU_SYS_DIR;
  process.env.CYC_GPU_SYS_DIR = root;
  try {
    const mod = await import(`./voicelog.ts?partial=${Date.now()}`);
    const snap = mod.sampleResources();
    expect(snap.gpuUtil).toBe(7);
    expect(snap.gpuMemMb).toBeNull();
    expect(snap.gpuMemTotalMb).toBeNull();
  } finally {
    if (prior === undefined) delete process.env.CYC_GPU_SYS_DIR;
    else process.env.CYC_GPU_SYS_DIR = prior;
  }
});

test("a garbage sysfs value reads null rather than NaN", async () => {
  const root = join(await tmpDir("voicelog-junk-"), "drm");
  mkdirSync(join(root, "card0", "device"), { recursive: true });
  writeFileSync(join(root, "card0", "device", "gpu_busy_percent"), "not a number\n");
  const prior = process.env.CYC_GPU_SYS_DIR;
  process.env.CYC_GPU_SYS_DIR = root;
  try {
    const mod = await import(`./voicelog.ts?junk=${Date.now()}`);
    // an unparseable busy file is treated as "not the render node", so the scan
    // moves on and the snapshot carries null, never NaN into the JSON route
    expect(mod.sampleResources().gpuUtil).toBeNull();
  } finally {
    if (prior === undefined) delete process.env.CYC_GPU_SYS_DIR;
    else process.env.CYC_GPU_SYS_DIR = prior;
  }
});

test("recording never throws, whatever the record carries", () => {
  // a logger that can fail a voice note is worse than no logger
  expect(() => recordVoiceOp({ op: "tts", engineMs: 0, outcome: "error", err: "x".repeat(10_000) })).not.toThrow();
  expect(() => recordVoiceOp({ op: "stt", engineMs: Number.NaN, outcome: "error" })).not.toThrow();
  expect(recentVoiceLog()).toHaveLength(2);
});

afterAll(() => {
  // the fake sysfs tree; tmpDir() removes ROOT itself, this just makes the
  // intent explicit for the dirs the test wrote into by hand
  rmSync(GPU_ROOT, { recursive: true, force: true });
});
