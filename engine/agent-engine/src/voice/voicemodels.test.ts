/* WHICH WHISPER MODEL AND WHICH KOKORO VARIANT THIS HOST RUNS.
 *
 * The two commands (`bun run agent-engine/src/security/pairkey.ts whisper-model [size]` and
 * `kokoro-model [variant]`) are the only way this choice is made, and the whole
 * value of them is that they are LOUD:
 *
 *   - the no-arg listing shows the REAL current default, one option per line,
 *     the current one marked, so "what is this box running" is answerable
 *   - an argument is validated, downloaded, PERSISTED, and just the one service
 *     restarted, in that order: a model that failed to download must never
 *     become the persisted choice
 *   - a failure at any step says which step, and leaves the state that step had
 *     not reached alone
 *   - the service table picks a persisted choice up and stamps NOTHING without
 *     one, so no existing install changes what it runs
 *   - a chosen model that is not on disk is loud in /health, with the service
 *     still watched, and never a silent substitute
 *   - POST /services/<key>/restart bounces JUST that service, refuses one this
 *     engine cannot bring back, and 409s an unknown key
 *
 * NOTHING HERE DOWNLOADS A REAL MODEL OR TOUCHES A REAL SERVICE. The download
 * source is a local Bun.serve on port 0 (or an injected fetch for the failure
 * shapes), the restart target is a local stub, the store is a scratch file, and
 * the routes run through test-utils/serve-routes.ts over the REAL
 * routes/health.ts. No engine is spawned; the only subprocess is one `--help`
 * to prove the CLI dispatches to these commands at all.
 *
 *   bun test agent-engine/src/voice/voicemodels.test.ts
 */

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { fakeVoice, deadVoiceBase, pointVoiceAt, restoreVoiceUrls } from "../test-utils/fake-voice.ts";

import { healthRoutes } from "../routes/health.ts";
import { Services, defaultServices, type ServiceSpec, type ServiceState, type UnitState }
  from "../runtime/services.ts";
import {
  DEFAULT_KOKORO_VARIANT, DEFAULT_WHISPER_SIZE, KOKORO_KIND, KOKORO_VARIANTS,
  WHISPER_KIND, WHISPER_SIZES, kokoroModelDir, kokoroModelName, modelPresencePaths,
  rawModelChoices, runModelCommand, saveModelChoice, whisperModelName, whisperModelDir,
} from "./voicemodels.ts";

/* ------------------------------------------------------------ file-scope rig
 *
 * Every path and URL these commands read comes from the environment, resolved
 * lazily per call. They are set ONCE, here, before any test runs, and restored
 * in afterAll: the convention this suite holds to. Per-test variation comes
 * from the CONTENTS of the scratch dir and from the stub servers' modes, never
 * from moving the environment underneath a module that has already read it. */
const ROOT = mkdtempSync(join(tmpdir(), "cyc-voicemodels-"));
const MODELS_FILE = join(ROOT, "state", "voice-models.json");
/* WHISPER_DIR / KOKORO_DIR are DERIVED from the functions under a faked HOME
 * (below), not env knobs any more: the model dirs are hardcoded to pywhispercpp's
 * cache and the voicemode checkout, so the test fakes HOME (and pins XDG_DATA_HOME
 * so Linux is deterministic) and asks the same functions the code does. */

/** A stub model source. Answers `payload` for any path, or refuses when told
 *  to, and records every path it was asked for. Never the real Hugging Face or
 *  the real GitHub releases. */
function stubHost() {
  const paths: string[] = [];
  const st: { payload: string | Uint8Array; status: number } =
    { payload: "FAKE-MODEL-BYTES", status: 200 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      paths.push(new URL(req.url).pathname);
      if (st.status !== 200) return new Response("no such model", { status: st.status });
      return new Response(st.payload, {
        headers: { "content-length": String(Buffer.byteLength(st.payload)) },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    paths,
    set payload(v: string | Uint8Array) { st.payload = v; },
    get payload() { return st.payload; },
    set status(v: number) { st.status = v; },
    stop: () => server.stop(true),
  };
}

/** A REAL kokoro tarball (kokoro-<variant>/{model.onnx,voices.bin,tokens.txt}),
 *  built with tar so `unpackModelFile`'s `tar xjf` has something valid to
 *  extract. The upstream kokoro asset is one .tar.bz2 now, not the loose
 *  weights+config pair the old test faked, so a meaningful success test has to
 *  serve bytes tar can actually open. */
function buildKokoroTarball(variant: string): Uint8Array {
  const dirName = kokoroModelName(variant);
  const stage = mkdtempSync(join(tmpdir(), "cyc-kokoro-tar-"));
  const top = join(stage, dirName);
  mkdirSync(top, { recursive: true });
  writeFileSync(join(top, "model.onnx"), "FAKE-ONNX");
  writeFileSync(join(top, "voices.bin"), "FAKE-VOICES");
  writeFileSync(join(top, "tokens.txt"), "FAKE-TOKENS");
  const tarPath = join(stage, `${dirName}.tar.bz2`);
  const r = Bun.spawnSync(["tar", "cjf", tarPath, "-C", stage, dirName]);
  if (r.exitCode !== 0) throw new Error(`could not build test tarball: ${r.stderr}`);
  const bytes = readFileSync(tarPath);
  rmSync(stage, { recursive: true, force: true });
  return bytes;
}

/** A stub engine: records the restart POSTs and answers what it is told to. */
function stubEngine() {
  const posts: string[] = [];
  const st = { ok: true, message: "restarted it: stopped pid 1 and started a new one" };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (req.method === "POST") posts.push(new URL(req.url).pathname);
      return Response.json({ ok: st.ok, message: st.message }, { status: st.ok ? 200 : 409 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    posts,
    set ok(v: boolean) { st.ok = v; },
    set message(v: string) { st.message = v; },
    get message() { return st.message; },
    stop: () => server.stop(true),
  };
}

const HOST = stubHost();
const ENGINE = stubEngine();

const SAVED: Record<string, string | undefined> = {};
const put = (k: string, v: string) => { SAVED[k] = process.env[k]; process.env[k] = v; };
put("CYC_VOICE_MODELS_FILE", MODELS_FILE);
put("HOME", ROOT);
put("XDG_DATA_HOME", join(ROOT, ".local", "share"));
put("CYC_WHISPER_BASE_URL", HOST.url);
put("CYC_KOKORO_BASE_URL", HOST.url);
put("CYC_ENGINE_URL", ENGINE.url);

/* Now HOME is faked, resolve the model dirs the way the code does. */
const WHISPER_DIR = whisperModelDir(DEFAULT_WHISPER_SIZE);
const KOKORO_DIR = kokoroModelDir(DEFAULT_KOKORO_VARIANT);
/* The setting tests exercise a NON-default size ("small") so persisting really
 * changes the choice; its files land in their own per-size dir, not WHISPER_DIR
 * (the default `turbo` dir). MODELS_ROOT is the parent both share, wiped whole
 * each test below so no size's leftover dir reads as "already downloaded". */
const SMALL_DIR = whisperModelDir("small");
const MODELS_ROOT = dirname(WHISPER_DIR);

/* THE VOICE ENGINE /health PROBES. Pointed at a base nothing is listening on by
 * default, so a stray probe is a fast connect-refused instead of a request at
 * whatever is on this box's real voice port. */
const DEAD_VOICE = deadVoiceBase();
pointVoiceAt(DEAD_VOICE);

/* A port number for the service rows below. Nothing ever connects to it (every
 * supervision control here is a fake or a real Services asked only the two
 * questions it answers without looking at a process), so what matters is that
 * it is not a number written into this file: no test in this suite may name a
 * port, because a sweep that started thirty engines once found two of them on
 * the same one. */
const NO_ONE_LISTENS = Number(new URL(DEAD_VOICE).port);

afterAll(() => {
  HOST.stop();
  ENGINE.stop();
  restoreVoiceUrls();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

/** Run a model command exactly as pairkey.ts's dispatch does, capturing what a
 *  person at the terminal would have seen. */
async function cli(kind: typeof WHISPER_KIND, arg?: string, fetchImpl?: typeof fetch): Promise<{
  code: number; out: string; err: string;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runModelCommand(kind, arg, {
    fetchImpl,
    print: (l) => out.push(l),
    error: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeEach(() => {
  // a fresh install: no choice on record, no model on disk, nothing restarted
  rmSync(join(ROOT, "state"), { recursive: true, force: true });
  rmSync(MODELS_ROOT, { recursive: true, force: true });
  HOST.paths.length = 0;
  HOST.payload = "FAKE-MODEL-BYTES";
  HOST.status = 200;
  ENGINE.posts.length = 0;
  ENGINE.ok = true;
  ENGINE.message = "restarted it: stopped pid 1 and started a new one";
  pointVoiceAt(DEAD_VOICE);
});

/* ---------------------------------------------------------------- listing */

test("whisper-model with no arg lists the real current default, marked", async () => {
  const { code, out } = await cli(WHISPER_KIND);
  expect(code).toBe(0);
  const lines = out.trim().split("\n");
  expect(lines[0]).toBe(`current: ${DEFAULT_WHISPER_SIZE}`);
  // every option is there, one per line, and ONLY the current one is marked
  for (const size of WHISPER_SIZES) {
    expect(lines).toContain(size === DEFAULT_WHISPER_SIZE ? `* ${size}` : `  ${size}`);
  }
  expect(lines.filter((l) => l.startsWith("* "))).toEqual([`* ${DEFAULT_WHISPER_SIZE}`]);
});

test("kokoro-model with no arg lists the real current default, marked", async () => {
  const { code, out } = await cli(KOKORO_KIND);
  expect(code).toBe(0);
  const lines = out.trim().split("\n");
  expect(lines[0]).toBe(`current: ${DEFAULT_KOKORO_VARIANT}`);
  for (const v of KOKORO_VARIANTS) {
    expect(lines).toContain(v === DEFAULT_KOKORO_VARIANT ? `* ${v}` : `  ${v}`);
  }
  expect(lines.filter((l) => l.startsWith("* "))).toEqual([`* ${DEFAULT_KOKORO_VARIANT}`]);
});

test("a persisted choice is what the listing calls current, for each kind alone", async () => {
  saveModelChoice("whisper", "small");
  const w = await cli(WHISPER_KIND);
  expect(w.out.split("\n")[0]).toBe("current: small");
  expect(w.out).toContain("* small");
  expect(w.out).toContain(`  ${DEFAULT_WHISPER_SIZE}`);

  /* kokoro is UNTOUCHED by a whisper choice. The two live in one file and a
   * write that dropped the other key would silently revert a model the box has
   * been running for months. */
  const k = await cli(KOKORO_KIND);
  expect(k.out.split("\n")[0]).toBe(`current: ${DEFAULT_KOKORO_VARIANT}`);
});

test("persisting one kind keeps the other", () => {
  saveModelChoice("whisper", "small");
  saveModelChoice("kokoro", "v0_19");
  expect(rawModelChoices()).toEqual({ whisper: "small", kokoro: "v0_19" });
  saveModelChoice("whisper", "medium");
  expect(rawModelChoices()).toEqual({ whisper: "medium", kokoro: "v0_19" });
});

test("an unreadable or absent store is today's defaults, not an error", async () => {
  // no file at all: the migration-free case every existing install is in
  expect(rawModelChoices()).toEqual({ whisper: null, kokoro: null });
  // and a file that is not json: still the defaults, still no crash
  saveModelChoice("whisper", "small");     // makes the directory the store lives in
  writeFileSync(MODELS_FILE, "{ not json");
  expect(rawModelChoices()).toEqual({ whisper: null, kokoro: null });
  expect((await cli(WHISPER_KIND)).out.split("\n")[0]).toBe(`current: ${DEFAULT_WHISPER_SIZE}`);
});

test("an unknown size is refused with the options listed, and nothing is persisted", async () => {
  const { code, err } = await cli(WHISPER_KIND, "humongous");
  expect(code).toBe(2);
  expect(err).toContain("unknown whisper model size: humongous");
  expect(err).toContain(`options: ${WHISPER_SIZES.join(", ")}`);
  expect(existsSync(MODELS_FILE)).toBe(false);
  // and it never went near the network
  expect(HOST.paths).toEqual([]);
  expect(ENGINE.posts).toEqual([]);
});

test("an unknown kokoro variant is refused the same way", async () => {
  const { code, err } = await cli(KOKORO_KIND, "v9_9");
  expect(code).toBe(2);
  expect(err).toContain("unknown kokoro variant: v9_9");
  expect(err).toContain(`options: ${KOKORO_VARIANTS.join(", ")}`);
  expect(existsSync(MODELS_FILE)).toBe(false);
});

/* ---------------------------------------------------------------- setting */

test("whisper-model <size> downloads the sherpa-onnx export, persists, and restarts the voice engine", async () => {
  ENGINE.message = "restarted voice engine (sherpa tts+stt): stopped pid 1 and started a new one";
  const { code, out } = await cli(WHISPER_KIND, "small");
  expect(code).toBe(0);

  /* A sherpa-onnx whisper size is THREE files (int8 encoder, int8 decoder,
   * tokens) under its own sherpa-onnx-whisper-<size> dir, each pulled from the
   * csukuangfj HF repo layout (/<repo>/resolve/main/<file>). All three land, or
   * the model cannot load. */
  const repo = "/sherpa-onnx-whisper-small/resolve/main";
  expect(HOST.paths).toEqual([
    `${repo}/small-encoder.int8.onnx`,
    `${repo}/small-decoder.int8.onnx`,
    `${repo}/small-tokens.txt`,
  ]);
  const encoder = join(SMALL_DIR, "small-encoder.int8.onnx");
  expect(readFileSync(encoder, "utf8")).toBe("FAKE-MODEL-BYTES");
  expect(readFileSync(join(SMALL_DIR, "small-decoder.int8.onnx"), "utf8")).toBe("FAKE-MODEL-BYTES");
  expect(readFileSync(join(SMALL_DIR, "small-tokens.txt"), "utf8")).toBe("FAKE-MODEL-BYTES");
  expect(out).toContain(`downloading ${HOST.url}${repo}/small-encoder.int8.onnx -> ${encoder}`);
  expect(out).toContain(`saved ${encoder} (16 bytes)`);
  // no half-written file left beside it
  expect(existsSync(`${encoder}.part`)).toBe(false);

  // persisted in the store the service table reads
  expect(JSON.parse(readFileSync(MODELS_FILE, "utf8"))).toEqual({ whisper: "small" });

  // JUST the one voice-engine service was restarted, through the engine (the
  // sherpa backend serves both whisper and kokoro now, so a size change bounces it)
  expect(ENGINE.posts).toEqual(["/services/voice-engine/restart"]);
  expect(out).toContain(`whisper-model small: persisted to ${MODELS_FILE}; ` +
    "restarted voice engine (sherpa tts+stt): stopped pid 1 and started a new one");
});

test("kokoro-model <variant> downloads the tarball, unpacks it, persists, and restarts the voice engine", async () => {
  ENGINE.message = "restarted voice engine (sherpa tts+stt): stopped pid 1 and started a new one";
  const variant = DEFAULT_KOKORO_VARIANT; // "multi-lang-v1_0", the one sherpa-onnx ships
  // the source serves ONE .tar.bz2; the command must unpack it into place
  HOST.payload = buildKokoroTarball(variant);
  const { code, out } = await cli(KOKORO_KIND, variant);
  expect(code).toBe(0);

  /* ONE archive, fetched from the sherpa-onnx tts-models release layout, then
   * expanded into kokoro-<variant>/. The espeak-ng-data and dict trees ride
   * inside, which is why this is a tarball and not the loose weights+config
   * pair kokoro used to ship; model.onnx + voices.bin + tokens.txt landing is
   * how we know the extraction completed. */
  expect(HOST.paths).toEqual([`/${kokoroModelName(variant)}.tar.bz2`]);
  expect(readFileSync(join(KOKORO_DIR, "model.onnx"), "utf8")).toBe("FAKE-ONNX");
  expect(readFileSync(join(KOKORO_DIR, "voices.bin"), "utf8")).toBe("FAKE-VOICES");
  expect(readFileSync(join(KOKORO_DIR, "tokens.txt"), "utf8")).toBe("FAKE-TOKENS");
  // the archive is removed once the unpack is verified: it is not left to rot
  expect(existsSync(join(dirname(KOKORO_DIR), `${kokoroModelName(variant)}.tar.bz2`))).toBe(false);

  expect(JSON.parse(readFileSync(MODELS_FILE, "utf8"))).toEqual({ kokoro: variant });
  expect(ENGINE.posts).toEqual(["/services/voice-engine/restart"]);
  expect(out).toContain(`kokoro-model ${variant}: persisted to ${MODELS_FILE}; ` +
    "restarted voice engine (sherpa tts+stt): stopped pid 1 and started a new one");
});

test("a model already on disk is not downloaded again", async () => {
  await cli(WHISPER_KIND, "small");
  HOST.paths.length = 0;
  const { code, out } = await cli(WHISPER_KIND, "small");
  expect(code).toBe(0);
  /* A 3GB re-download because someone ran the command twice would be its own
   * incident. The file on disk is the answer. */
  expect(HOST.paths).toEqual([]);
  expect(out).toContain(`already downloaded: ${join(SMALL_DIR, "small-encoder.int8.onnx")}`);
});

test("a failed download is loud, persists nothing, and restarts nothing", async () => {
  HOST.status = 404;
  const { code, err } = await cli(WHISPER_KIND, "small");
  expect(code).toBe(1);
  expect(err).toContain(
    `download failed: ${HOST.url}/sherpa-onnx-whisper-small/resolve/main/small-encoder.int8.onnx answered HTTP 404`);
  expect(err).toContain("whisper-model small: NOT persisted, the download failed");
  /* THE ORDER IS THE POINT: download, then persist, then restart. A choice
   * persisted against a model that is not there is a service that will not
   * start after the next reboot, and nothing would say why. */
  expect(existsSync(MODELS_FILE)).toBe(false);
  expect(existsSync(join(SMALL_DIR, "small-encoder.int8.onnx"))).toBe(false);
  expect(ENGINE.posts).toEqual([]);
});

test("a source that cannot be reached at all is loud in the same shape", async () => {
  const refuse: typeof fetch = async () => { throw new Error("connection refused"); };
  const { code, err } = await cli(WHISPER_KIND, "small", refuse);
  expect(code).toBe(1);
  expect(err).toContain("download failed:");
  expect(err).toContain("connection refused");
  expect(err).toContain("NOT persisted");
  expect(existsSync(MODELS_FILE)).toBe(false);
});

test("a stream that breaks mid-download leaves no partial file and persists nothing", async () => {
  /* The half-file is the dangerous outcome: `already downloaded` would then
   * skip it forever and the service would load a truncated model. download()
   * writes to <dest>.part and renames, so a break must leave neither. */
  const broken: typeof fetch = async () => new Response(
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("half a model"));
        ctrl.error(new Error("the connection dropped"));
      },
    }),
    { headers: { "content-length": "999999" } },
  );
  const { code, err } = await cli(WHISPER_KIND, "small", broken);
  expect(code).toBe(1);
  expect(err).toContain("download failed:");
  const dest = join(SMALL_DIR, "small-encoder.int8.onnx");
  expect(existsSync(dest)).toBe(false);
  expect(existsSync(`${dest}.part`)).toBe(false);
  expect(existsSync(MODELS_FILE)).toBe(false);
});

test("an unreachable engine is loud: persisted, but says the service was NOT restarted", async () => {
  const noEngine: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/services/")) throw new Error("connection refused");
    return new Response("FAKE-MODEL-BYTES", { headers: { "content-length": "16" } });
  };
  const { code, err } = await cli(WHISPER_KIND, "small", noEngine);
  expect(code).toBe(1);
  /* THE CHOICE IS PERSISTED, because the download really happened; the failure
   * names the half that did not. Pretending the restart happened would be a
   * hidden fallback, and the box would go on serving the old model with the
   * file saying otherwise. */
  expect(JSON.parse(readFileSync(MODELS_FILE, "utf8"))).toEqual({ whisper: "small" });
  expect(err).toContain(`whisper-model small: persisted to ${MODELS_FILE}, but the voice-engine ` +
    "service was NOT restarted:");
  expect(err).toContain("was not reachable");
});

test("an engine that refuses the restart is loud, and carries its reason back", async () => {
  ENGINE.ok = false;
  ENGINE.message = "this engine cannot start voice engine (sherpa tts+stt): nothing on this engine starts it";
  const { code, err } = await cli(WHISPER_KIND, "small");
  expect(code).toBe(1);
  expect(JSON.parse(readFileSync(MODELS_FILE, "utf8"))).toEqual({ whisper: "small" });
  // the engine's own sentence, not a summary of it
  expect(err).toContain("nothing on this engine starts it");
});

/* ---------------------------------------------------------------- the table */

test("defaultServices picks a persisted choice up, and stamps nothing without one", () => {
  // no choice on record: NO row claims a model, so no existing install changes
  for (const s of defaultServices()) expect(s.model).toBeUndefined();

  /* One consolidated voice-engine row serves BOTH models now (the sherpa
   * backend), so a whisper choice stamps that single row. The stamped `model`
   * is the loud /health claim; its path is the first presence path of the
   * chosen model, exactly what modelPresencePaths reports. */
  saveModelChoice("whisper", "small");
  const table = defaultServices();
  const ve = table.find((s) => s.key === "voice-engine")!;
  expect(ve.model).toEqual({
    name: whisperModelName("small"),
    path: modelPresencePaths("whisper")[0],
  });

  // a kokoro choice joins the SAME row, both names carried side by side
  saveModelChoice("kokoro", DEFAULT_KOKORO_VARIANT);
  const both = defaultServices().find((s) => s.key === "voice-engine")!;
  expect(both.model?.name).toBe(
    `${whisperModelName("small")} + ${kokoroModelName(DEFAULT_KOKORO_VARIANT)}`);
});

/* ------------------------------------------------- /health and the restart */

/** A supervision control that answers what it is told and records what it was
 *  asked to do. The real Services is used below for the two refusals it decides
 *  without touching a process; everything that would need a lease, an lsof or a
 *  child belongs to services.test.ts (the process annex). */
function fakeServices(rows: ServiceState[], units: UnitState[] = []) {
  const restarts: string[] = [];
  const answer = { ok: true, message: "restarted toy service: stopped pid 41 and started a new one" };
  return {
    restarts,
    answer,
    ctl: {
      health: () => rows,
      units: () => units,
      restart: async (key: string) => { restarts.push(key); return { ...answer }; },
    } as unknown as import("../runtime/services.ts").Services,
  };
}

const row = (over: Partial<ServiceState> = {}): ServiceState => ({
  key: "toy", name: "toy service", port: NO_ONE_LISTENS, ceilingMb: 6000,
  running: true, pid: 41, owned: false, starting: false, footprintMb: 12,
  restarts: 0, lastExit: null, checkedAt: 1,
  supervisor: { holder: true, pid: 41, since: 1, note: "this engine supervises it" },
  note: "up",
  ...over,
});

function health(services: import("../runtime/services.ts").Services, rev = "test-rev"): ServedRoutes {
  return serveRoutes({ groups: [healthRoutes], ctx: { services, rev } });
}

test("/health is TRIMMED to {ok, rev}: service, unit and voice telemetry ride the sealed channel now", async () => {
  /* Sealed-transport enforcement. /health once carried the supervised-service
   * table, the unit list and the voice probe (URL + up/down) -- host telemetry
   * a bare tailnet peer could read off an ungated route. It now answers ok + rev
   * only; those readings ride the sessions frame + the {t:"voice"} frame. The
   * service-row shape (including the missing-model note) is proven against the
   * real Services in services.test.ts + modelwarmup.test.ts, and the voice
   * capability in voiceframe.test.ts, not through /health any more. */
  const sv = fakeServices([row()], [{
    name: "voice", healthy: true, members: ["toy"],
    note: "whole: all 1 members are listening",
  }]);
  const srv = health(sv.ctl, "deadbeef");
  try {
    const body = await (await srv.get("/health")).json();
    expect(Object.keys(body).sort()).toEqual(["ok", "rev"]);
    expect(body.ok).toBe(true);
    expect(body.rev).toBe("deadbeef");
    // none of the host telemetry the leak-audit named survives on /health
    for (const gone of ["services", "units", "voice", "voiceUrl", "voiceReady", "sessions"]) {
      expect(gone in body, `/health still leaks '${gone}'`).toBe(false);
    }
  } finally { srv.stop(); }
});

test("the restart route bounces JUST the named service and answers its message", async () => {
  const sv = fakeServices([row()]);
  const srv = health(sv.ctl);
  try {
    const res = await srv.fetch("/services/toy/restart", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe("restarted toy service: stopped pid 41 and started a new one");
    // ONE service, named exactly once: a model change must not bounce the stack
    expect(sv.restarts).toEqual(["toy"]);
  } finally { srv.stop(); }
});

test("the restart route decodes the key rather than passing the URL through", async () => {
  const sv = fakeServices([row()]);
  const srv = health(sv.ctl);
  try {
    await srv.fetch(`/services/${encodeURIComponent("voice engine")}/restart`, { method: "POST" });
    expect(sv.restarts).toEqual(["voice engine"]);
  } finally { srv.stop(); }
});

test("a service the engine cannot restart answers 409 with the reason", async () => {
  /* THE REAL Services for this one. Both refusals below are decided before any
   * lease, lsof or child process is touched, so the shipped code can answer
   * them in a seam test: what is being proven is the sentence a person reads,
   * and the route's 409 for it. */
  const specs: ServiceSpec[] = [
    { key: "watchy", name: "watch-only service", port: NO_ONE_LISTENS, ceilingMb: 6000,
      revive: { how: "watch" } },
  ];
  const real = new Services(specs, { leaseDir: join(ROOT, "leases"), logDir: join(ROOT, "logs") });
  const srv = health(real);
  try {
    const watch = await srv.fetch("/services/watchy/restart", { method: "POST" });
    expect(watch.status).toBe(409);
    // this engine must never kill what it cannot bring back
    expect((await watch.json()).message).toBe(
      "this engine cannot start watch-only service: nothing on this engine starts it");

    const nope = await srv.fetch("/services/nope/restart", { method: "POST" });
    expect(nope.status).toBe(409);
    expect((await nope.json()).message)
      .toBe('no service named "nope" in this engine\'s table');
  } finally { srv.stop(); real.stop(); }
});

test("a proxied request cannot bounce a service", async () => {
  /* Behind `tailscale serve` every peer arrives from loopback, so the header is
   * the gate: a tailnet peer may READ /health and may not restart anything on
   * the host. */
  const sv = fakeServices([row()]);
  const srv = health(sv.ctl);
  try {
    const res = await srv.fetch("/services/toy/restart", {
      method: "POST", headers: { "x-forwarded-for": "100.64.0.9" },
    });
    expect(res.status).toBe(403);
    expect(sv.restarts).toEqual([]);
    // and reading stays open to the same caller
    expect((await srv.get("/health", { headers: { "x-forwarded-for": "100.64.0.9" } })).status)
      .toBe(200);
  } finally { srv.stop(); }
});

/* --------------------------------------------------------------- the CLI */

test("the CLI dispatches to both model commands", async () => {
  /* The ONE subprocess in this file: everything above drives runModelCommand in
   * process, which proves what the command DOES but not that the `cyc model`
   * entrypoint (model.ts) routes a person's argv to it. This is that link, for
   * both model subcommands. (pairkey.ts is the Local/Cloud chooser now; the
   * model CLI moved to `cyc model <whisper|kokoro|stt>`. The stt subcommand and
   * the usage/exit-code contract are proved in model.test.ts.) */
  async function listing(sub: string): Promise<string> {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "runtime", "model.ts"), sub], {
      cwd: join(import.meta.dir, "..", ".."),
      env: { ...process.env },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out;
  }
  // no-arg dispatch to each command prints its current model and its options,
  // one per line (the option lists always carry the built-in defaults).
  const whisper = await listing("whisper");
  expect(whisper).toContain("current:");
  expect(whisper).toContain(DEFAULT_WHISPER_SIZE);
  const kokoro = await listing("kokoro");
  expect(kokoro).toContain("current:");
  expect(kokoro).toContain(DEFAULT_KOKORO_VARIANT);
  // and the two kinds the dispatch hands to runModelCommand are these commands
  expect(WHISPER_KIND.command).toBe("whisper-model");
  // both kinds restart the ONE consolidated service now (the sherpa voice engine)
  expect(WHISPER_KIND.serviceKey).toBe("voice-engine");
  expect(KOKORO_KIND.command).toBe("kokoro-model");
  expect(KOKORO_KIND.serviceKey).toBe("voice-engine");
}, 20_000);
