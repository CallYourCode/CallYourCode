/* voicemodels.ts: which sherpa-onnx whisper model and which kokoro variant
 * this host runs, chosen from the `cyc model` CLI (agent-engine/src/runtime/model.ts).
 *
 *   cyc model whisper [size]
 *   cyc model kokoro [variant]
 *
 * No argument prints the CURRENT model plus every available option, one per
 * line, the current one marked. With an argument the choice is validated, the
 * model files are downloaded if missing (whisper ONNX exports from
 * csukuangfj's Hugging Face repos, the same ones sherpa-onnx's own docs
 * install; kokoro from the k2-fsa/sherpa-onnx release tarballs), the choice is
 * persisted, and the voice engine is restarted through the engine's own
 * supervision (POST /services/voice-engine/restart, services.ts).
 *
 * THE DEFAULTS ARE WHAT WE SHIP: whisper `turbo` (that repo IS openai's
 * large-v3-turbo -- "turbo" is upstream's name for it) and kokoro
 * `multi-lang-v1_0` (the FULL kokoro v1.0, 53 voices, the af_heart default
 * among them). Everything lands under voiceModelsDir()
 * (shared/voicepaths.ts), one directory per model, exactly the layout the
 * upstream assets ship -- the same paths the voice engine's sherpa backend
 * loads from, so the two can never name different files.
 *
 * The persisted choice lives in the data dir's `state/voice-models.json`
 * (datadir.ts; the design's engine-state class); an ABSENT file means today's
 * defaults, migration-free. Only an EXPLICIT choice stamps a model path onto
 * the service row: a missing chosen model then fails LOUDLY in /health's
 * services detail (services.ts), and nothing ever silently switches models.
 *
 * Tests never download real models (the fetch is injectable, and the source
 * base urls are overridable with CYC_WHISPER_BASE_URL / CYC_KOKORO_BASE_URL)
 * and never touch the live services (the restart goes to CYC_ENGINE_URL, which
 * a test points at a scratch engine walled off by CYC_SERVICES_FILE).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirPrivateSync, writeAtomicPrivateSync } from "../../../shared/runfiles.ts";
import { stateFile } from "../storage/datadir.ts";
import { voiceModelsDir, kokoroDirName, whisperDirName,
  kokoroPresencePaths, whisperPresencePaths } from "../../../shared/voicepaths.ts";

// ---------------------------------------------------------------- the store

/** Where the choice is persisted: the data dir's `state/voice-models.json`
 *  (a fact about this install's runtime, the design's state/ class), or a
 *  test's scratch via CYC_VOICE_MODELS_FILE. Resolved lazily so CYC_DATA_DIR
 *  set before boot wins, like every datadir helper. */
export function modelsFile(): string {
  const env = process.env.CYC_VOICE_MODELS_FILE;
  if (env) return env;
  return stateFile("voice-models.json");
}

/** What the file actually says: null for a choice it does not make. An absent
 *  or unreadable file is NOT an error, it is "today's defaults" (migration-
 *  free: no install has this file until someone runs the command). */
export function rawModelChoices(file = modelsFile()): { whisper: string | null; kokoro: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      whisper: typeof parsed?.whisper === "string" ? parsed.whisper : null,
      kokoro: typeof parsed?.kokoro === "string" ? parsed.kokoro : null,
    };
  } catch {
    return { whisper: null, kokoro: null };
  }
}

/** Persist one choice, keeping the other, atomically and 0600 like everything
 *  else in the data dir. */
export function saveModelChoice(kind: "whisper" | "kokoro", value: string, file = modelsFile()): void {
  const current = rawModelChoices(file);
  const next: Record<string, string> = {};
  if (current.whisper !== null) next.whisper = current.whisper;
  if (current.kokoro !== null) next.kokoro = current.kokoro;
  next[kind] = value;
  mkdirPrivateSync(dirname(file));
  writeAtomicPrivateSync(file, JSON.stringify(next, null, 2) + "\n");
}

// ---------------------------------------------------------------- files

/** One thing to fetch: a plain file, or an archive that unpacks into a model
 *  directory. `present` is what must exist for this entry to count as done
 *  (defaults to `dest`); for an archive the tarball itself is DELETED after a
 *  verified unpack, so presence is always asked of the extracted files. */
export type ModelFile = {
  url: string;
  dest: string;
  /** Unpack `dest` (a .tar.bz2) into this directory after download. */
  unpackInto?: string;
  /** The files whose existence means this entry is complete. */
  present?: string[];
};

/** The paths whose existence means this entry is done. */
export function presencePaths(f: ModelFile): string[] {
  return f.present ?? [f.dest];
}

export function filePresent(f: ModelFile): boolean {
  return presencePaths(f).every((p) => existsSync(p));
}

// ---------------------------------------------------------------- whisper

/* The whisper exports csukuangfj hosts for sherpa-onnx (checked 2026-08-23
 * against huggingface.co/csukuangfj): one repo per size, each carrying
 * <size>-encoder.int8.onnx, <size>-decoder.int8.onnx and <size>-tokens.txt.
 * `turbo` IS openai's whisper-large-v3-turbo (upstream's release name for it)
 * and is what we ship. int8 on purpose: the fp weights of the large nets
 * exceed onnx's 2 GB protobuf bound and ship as external-data files; int8 is
 * one self-contained file per net and what sherpa's own examples load. */
export const WHISPER_SIZES = [
  "tiny", "tiny.en", "base", "base.en", "small", "small.en",
  "medium", "medium.en", "large-v3", "turbo",
] as const;

/* `turbo` IS whisper-large-v3-turbo. "turbo" is openai/whisper's OWN official
 * alias for large-v3-turbo (its model registry defines it), and the sherpa
 * export ships under that name; a repo literally named large-v3-turbo does
 * not exist upstream. The CLI accepts the long name too (WHISPER_ALIASES). */
export const DEFAULT_WHISPER_SIZE = "turbo";

/** Long-form names accepted by the CLI, mapped to the upstream asset name. */
export const WHISPER_ALIASES: Record<string, string> = {
  "large-v3-turbo": "turbo",
};

/** The official source: csukuangfj's per-size HF repos, the ones sherpa's
 *  docs install. Overridable so a test can point it at a local stub and never
 *  download a real model. */
export function whisperBaseUrl(): string {
  return (process.env.CYC_WHISPER_BASE_URL ??
    "https://huggingface.co/csukuangfj").replace(/\/+$/, "");
}

/** Where one whisper size lives: its own directory under the models root,
 *  named exactly as the upstream repo/tarball names it. */
export function whisperModelDir(size: string): string {
  return join(voiceModelsDir(), whisperDirName(size));
}

/** The model's display name (the /health claim and every printed line). */
export function whisperModelName(size: string): string {
  return whisperDirName(size);
}

/** The size the whisper decode runs right now: the persisted choice, or
 *  today's default when nothing was ever chosen. */
export function currentWhisperSize(file = modelsFile()): string {
  return rawModelChoices(file).whisper ?? DEFAULT_WHISPER_SIZE;
}

/** Every file a whisper size needs, with the url it comes from. */
export function whisperFiles(size: string): ModelFile[] {
  const base = whisperBaseUrl();
  const repo = `${base}/${whisperDirName(size)}/resolve/main`;
  return whisperPresencePaths(size, voiceModelsDir()).map((dest) => ({
    url: `${repo}/${dest.split("/").pop()}`,
    dest,
  }));
}

// ---------------------------------------------------------------- kokoro

/* The kokoro exports the k2-fsa/sherpa-onnx release hosts under the
 * tts-models tag (checked 2026-08-23). multi-lang-v1_0 is the FULL kokoro
 * v1.0 (53 voices, af_heart included); its tarball carries model.onnx,
 * voices.bin, tokens.txt, the lexicons, espeak-ng-data/ and dict/. */
export const KOKORO_VARIANTS = ["multi-lang-v1_0"] as const;

export const DEFAULT_KOKORO_VARIANT = "multi-lang-v1_0";

export function kokoroBaseUrl(): string {
  return (process.env.CYC_KOKORO_BASE_URL ??
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models").replace(/\/+$/, "");
}

/** Where a variant's files live: its own directory under the models root,
 *  exactly as its tarball extracts. */
export function kokoroModelDir(variant: string): string {
  return join(voiceModelsDir(), kokoroDirName(variant));
}

export function kokoroModelName(variant: string): string {
  return kokoroDirName(variant);
}

export function currentKokoroVariant(file = modelsFile()): string {
  return rawModelChoices(file).kokoro ?? DEFAULT_KOKORO_VARIANT;
}

/** A kokoro variant is ONE tarball, unpacked into the models root (the
 *  archive's own top directory is kokoro-<variant>/). The espeak-ng-data and
 *  dict trees ride inside, which is why this is an archive and not the
 *  file-by-file list whisper gets. */
export function kokoroFiles(variant: string): ModelFile[] {
  const dir = voiceModelsDir();
  return [{
    url: `${kokoroBaseUrl()}/${kokoroDirName(variant)}.tar.bz2`,
    dest: join(dir, `${kokoroDirName(variant)}.tar.bz2`),
    unpackInto: dir,
    present: kokoroPresencePaths(variant, dir),
  }];
}

// ---------------------------------------------------------------- download

const mb = (n: number) => (n / 1_048_576).toFixed(1);

/** Stream one file to disk, loudly. Progress goes to `print` (and, when given,
 *  to `onProgress`, which is how the background warm-up publishes a percent);
 *  any failure (non-2xx, no body, a broken stream, fewer bytes than the source
 *  declared) throws with the url in the message and leaves no partial file
 *  behind. The bytes land in `<dest>.part` and are RENAMED into place only
 *  once complete, so `dest` existing always means a whole file. The fetch is
 *  injectable so a test never reaches the network with the real
 *  implementation. */
export async function download(url: string, dest: string,
  opts: { fetchImpl?: typeof fetch; print?: (line: string) => void;
    onProgress?: (got: number, total: number | null) => void } = {}): Promise<number> {
  const f = opts.fetchImpl ?? fetch;
  const print = opts.print ?? console.log;
  print(`downloading ${url} -> ${dest}`);
  let res: Response;
  try {
    res = await f(url);
  } catch (e) {
    throw new Error(`download failed: ${url}: ${String(e)}`);
  }
  if (!res.ok) throw new Error(`download failed: ${url} answered HTTP ${res.status}`);
  if (!res.body) throw new Error(`download failed: ${url} returned no body`);
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const total = Number(res.headers.get("content-length") ?? "") || null;
  rmSync(part, { force: true });
  const sink = Bun.file(part).writer();
  let got = 0;
  let lastPct = 0;
  let lastMark = 0;
  try {
    for await (const chunk of res.body) {
      sink.write(chunk);
      got += chunk.byteLength;
      opts.onProgress?.(got, total);
      if (total !== null) {
        const pct = Math.floor((got / total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct - (pct % 10);
          print(`  ${lastPct}% (${mb(got)} of ${mb(total)} MB)`);
        }
      } else if (got - lastMark >= 32 * 1_048_576) {
        lastMark = got;
        print(`  ${mb(got)} MB so far`);
      }
    }
    await sink.end();
  } catch (e) {
    try { await sink.end(); } catch { /* already closed */ }
    rmSync(part, { force: true });
    throw new Error(`download failed: ${url}: ${String(e)}`);
  }
  /* FEWER BYTES THAN DECLARED IS A FAILURE, not a model. A truncated stream
   * that ended cleanly (proxy cut, disk hiccup upstream) would otherwise be
   * renamed into place and loaded as if it were the whole file. */
  if (total !== null && got !== total) {
    rmSync(part, { force: true });
    throw new Error(`download failed: ${url}: got ${got} of the declared ${total} bytes`);
  }
  renameSync(part, dest);
  print(`saved ${dest} (${got} bytes)`);
  return got;
}

/** Unpack a downloaded model tarball and verify what it promised. The archive
 *  is DELETED only after every `present` path exists, so a half-extracted
 *  model never counts as installed and a re-run picks up where it left off
 *  (the tarball is still there to try again). */
export async function unpackModelFile(f: ModelFile,
  opts: { print?: (line: string) => void } = {}): Promise<void> {
  if (!f.unpackInto) return;
  const print = opts.print ?? console.log;
  print(`unpacking ${f.dest} -> ${f.unpackInto}`);
  const proc = Bun.spawn(["tar", "xjf", f.dest, "-C", f.unpackInto],
    { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`unpack failed: tar exited ${code}: ${err.trim() || "no output"}`);
  const missing = presencePaths(f).find((p) => !existsSync(p));
  if (missing !== undefined) {
    throw new Error(`unpack failed: ${f.dest} extracted but ${missing} is still missing`);
  }
  try { unlinkSync(f.dest); } catch { /* keeping the archive is harmless */ }
  print(`unpacked ${f.unpackInto} (archive removed)`);
}

/** The whole life of one model file: skip when present, download, unpack when
 *  it is an archive. What both the CLI and the background warm-up call, so
 *  they can never disagree about what "installed" means. */
export async function fetchModelFile(f: ModelFile,
  opts: { fetchImpl?: typeof fetch; print?: (line: string) => void;
    onProgress?: (got: number, total: number | null) => void } = {}): Promise<void> {
  if (filePresent(f)) return;
  // A tarball already on disk (a previous run died between download and
  // unpack) is not re-downloaded, just unpacked.
  if (!existsSync(f.dest)) await download(f.url, f.dest, opts);
  await unpackModelFile(f, { print: opts.print });
}

// ---------------------------------------------------------------- restart

/** The engine whose supervision does the restart: this host's own, on its
 *  agent port. CYC_ENGINE_URL is how a test points this at a scratch engine. */
export function engineUrl(): string {
  return (process.env.CYC_ENGINE_URL ??
    `http://127.0.0.1:${process.env.AGENT_PORT ?? 10101}`).replace(/\/+$/, "");
}

/** Ask the running engine to restart one service through services.ts. The
 *  engine being unreachable is a distinct, loud outcome: the choice is already
 *  persisted, and pretending the restart happened would be a hidden fallback. */
export async function restartViaEngine(key: string,
  fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  const url = `${engineUrl()}/services/${encodeURIComponent(key)}/restart`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    return { ok: false, message: `the engine at ${engineUrl()} was not reachable (${String(e)})` };
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
  if (body && typeof body.message === "string") return { ok: body.ok === true, message: body.message };
  return { ok: false, message: `the engine answered HTTP ${res.status} with no detail` };
}

// ---------------------------------------------------------------- the CLI

type ModelKind = {
  /** The subcommand, and the word used in every printed line. */
  command: "whisper-model" | "kokoro-model";
  noun: string;
  options: readonly string[];
  current: () => string;
  files: (choice: string) => ModelFile[];
  /** The services.ts table key of the ONE service this model belongs to. */
  serviceKey: string;
  persist: (choice: string) => void;
};

export const WHISPER_KIND: ModelKind = {
  command: "whisper-model",
  noun: "whisper model size",
  options: WHISPER_SIZES,
  current: () => currentWhisperSize(),
  files: whisperFiles,
  /* Both models are served by the ONE voice engine now (the sherpa backend),
   * so a size change restarts it; it re-reads the choice on start. */
  serviceKey: "voice-engine",
  persist: (size) => saveModelChoice("whisper", size),
};

export const KOKORO_KIND: ModelKind = {
  command: "kokoro-model",
  noun: "kokoro variant",
  options: KOKORO_VARIANTS,
  current: () => currentKokoroVariant(),
  files: kokoroFiles,
  serviceKey: "voice-engine",
  persist: (variant) => saveModelChoice("kokoro", variant),
};

/** Every file the CURRENT (chosen-or-default) model of one kind needs, with
 *  the url it comes from. What the boot-time background warm-up
 *  (modelwarmup.ts) downloads and what the service presence-gate
 *  (services.ts needsModel) waits on: one list, so the two can never name
 *  different files. */
export function requiredModelFiles(kind: "whisper" | "kokoro"): ModelFile[] {
  return kind === "whisper"
    ? whisperFiles(currentWhisperSize())
    : kokoroFiles(currentKokoroVariant());
}

/** The on-disk paths whose presence means the CURRENT model of one kind is
 *  installed and loadable: the gate paths (services.ts needsModel) and the
 *  per-capability readiness answer (server.ts voiceReady). */
export function modelPresencePaths(kind: "whisper" | "kokoro"): string[] {
  return requiredModelFiles(kind).flatMap(presencePaths);
}

/** The whole subcommand, returning the exit code so pairkey.ts stays a thin
 *  dispatcher and a test can drive this in-process with a stubbed fetch. */
export async function runModelCommand(kind: ModelKind, arg: string | undefined,
  opts: { fetchImpl?: typeof fetch; print?: (line: string) => void;
    error?: (line: string) => void } = {}): Promise<number> {
  const print = opts.print ?? console.log;
  const error = opts.error ?? console.error;

  if (arg === undefined) {
    // The current model, then every option one per line, the current one marked.
    const current = kind.current();
    print(`current: ${current}`);
    for (const o of kind.options) print(o === current ? `* ${o}` : `  ${o}`);
    return 0;
  }

  // The long-form names map to the upstream asset name (large-v3-turbo IS turbo).
  if (kind.command === "whisper-model" && WHISPER_ALIASES[arg]) arg = WHISPER_ALIASES[arg];

  if (!kind.options.includes(arg)) {
    error(`unknown ${kind.noun}: ${arg}`);
    error(`options: ${kind.options.join(", ")}`);
    return 2;
  }

  // Download first, persist second, restart third: a model that failed to
  // download must never become the persisted choice.
  for (const file of kind.files(arg)) {
    if (filePresent(file)) {
      print(`already downloaded: ${presencePaths(file)[0]}`);
      continue;
    }
    try {
      await fetchModelFile(file, { fetchImpl: opts.fetchImpl, print });
    } catch (e) {
      error((e as Error).message);
      error(`${kind.command} ${arg}: NOT persisted, the download failed`);
      return 1;
    }
  }

  kind.persist(arg);

  const restarted = await restartViaEngine(kind.serviceKey, opts.fetchImpl);
  if (!restarted.ok) {
    error(`${kind.command} ${arg}: persisted to ${modelsFile()}, but the ${kind.serviceKey} ` +
      `service was NOT restarted: ${restarted.message}`);
    return 1;
  }
  print(`${kind.command} ${arg}: persisted to ${modelsFile()}; ${restarted.message}`);
  return 0;
}
