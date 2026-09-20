/* voicemodels store location and semantics (the data-dir move): pure path +
 * file logic, no engine, no downloads, no live services.
 *
 *   - the default store is <dataDir>/state/voice-models.json, resolved lazily
 *     from CYC_DATA_DIR like every datadir helper
 *   - CYC_VOICE_MODELS_FILE still wins outright (the test-scratch seam)
 *   - read/write semantics: an absent or unreadable file means "no choice, run
 *     today's defaults" rather than an error, and saveModelChoice keeps the
 *     other kind, writes 0600 and renames into place
 *
 * Everything below the path resolution takes an explicit `file`, so those tests
 * inject a real path instead of touching the environment at all. The two env
 * vars are set ONCE at file scope with restore in afterAll; the helpers read
 * them on every call and cache nothing, which is why the one test that has to
 * prove the override restores it in a finally.
 *
 *   bun test agent-engine/src/voice/voicemodels-store.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  modelsFile, rawModelChoices, saveModelChoice,
  currentWhisperSize, currentKokoroVariant,
  WHISPER_SIZES, DEFAULT_WHISPER_SIZE, KOKORO_VARIANTS, DEFAULT_KOKORO_VARIANT,
} from "./voicemodels.ts";
import { tmpDir } from "../test-utils/tmp.ts";

let dir = "";
const envBefore = {
  CYC_DATA_DIR: process.env.CYC_DATA_DIR,
  CYC_VOICE_MODELS_FILE: process.env.CYC_VOICE_MODELS_FILE,
};
beforeAll(async () => {
  dir = await tmpDir("vm-store-");
  process.env.CYC_DATA_DIR = join(dir, "data");
  delete process.env.CYC_VOICE_MODELS_FILE;
});
afterAll(() => {
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A store path of this test's own, so no two tests share a file. */
const storeIn = (name: string) => join(dir, "stores", name, "voice-models.json");

test("the default store is the data dir's state/voice-models.json", () => {
  expect(modelsFile()).toBe(join(dir, "data", "state", "voice-models.json"));
});

test("the path is resolved lazily, so a data dir set before boot wins", () => {
  // every datadir helper re-reads the env on each call; a modelsFile() that
  // captured it at import would point a test engine at the real ~/.callyourcode
  const prior = process.env.CYC_DATA_DIR;
  try {
    process.env.CYC_DATA_DIR = join(dir, "elsewhere");
    expect(modelsFile()).toBe(join(dir, "elsewhere", "state", "voice-models.json"));
  } finally {
    process.env.CYC_DATA_DIR = prior;
  }
});

test("CYC_VOICE_MODELS_FILE wins outright, and creates nothing under the data dir", () => {
  const scratch = join(dir, "scratch.json");
  try {
    process.env.CYC_VOICE_MODELS_FILE = scratch;
    expect(modelsFile()).toBe(scratch);
    expect(existsSync(join(dir, "data", "state", "voice-models.json"))).toBe(false);
  } finally {
    delete process.env.CYC_VOICE_MODELS_FILE;
  }
});

test("an empty CYC_VOICE_MODELS_FILE falls through to the data dir", () => {
  // an unset-but-exported env var is empty, not a path; treating "" as a
  // filename would put the store at the process cwd
  try {
    process.env.CYC_VOICE_MODELS_FILE = "";
    expect(modelsFile()).toBe(join(dir, "data", "state", "voice-models.json"));
  } finally {
    delete process.env.CYC_VOICE_MODELS_FILE;
  }
});

test("read/write semantics: absent = no choice; save keeps the other kind", () => {
  const file = storeIn("roundtrip");
  expect(rawModelChoices(file)).toEqual({ whisper: null, kokoro: null });
  saveModelChoice("whisper", "small", file);
  saveModelChoice("kokoro", "v1_0", file);
  expect(rawModelChoices(file)).toEqual({ whisper: "small", kokoro: "v1_0" });
});

test("absent store: no file is created by a read, defaults stand", () => {
  const file = storeIn("never-written");
  expect(rawModelChoices(file)).toEqual({ whisper: null, kokoro: null });
  expect(existsSync(file)).toBe(false);
  // the read must not make the directory either
  expect(existsSync(join(dir, "stores", "never-written"))).toBe(false);
});

test("an unreadable or malformed store is 'today's defaults', never a crash", () => {
  /* Migration-free is the whole design: no install has this file until someone
   * runs the command, and a torn one must not stop the engine from serving the
   * models it is already running. */
  const file = storeIn("malformed");
  mkdirSync(join(dir, "stores", "malformed"), { recursive: true });
  for (const junk of ["", "{not json", "null", "[]", '"small"', "42"]) {
    writeFileSync(file, junk);
    expect(rawModelChoices(file)).toEqual({ whisper: null, kokoro: null });
  }
  // and a directory where the file should be is the same kind of nothing
  expect(rawModelChoices(join(dir, "stores"))).toEqual({ whisper: null, kokoro: null });
});

test("a non-string choice reads as no choice rather than as a model name", () => {
  // the file is hand-editable; a number or an object must not become a path
  // segment on a service row
  const file = storeIn("wrongtypes");
  mkdirSync(join(dir, "stores", "wrongtypes"), { recursive: true });
  writeFileSync(file, JSON.stringify({ whisper: 3, kokoro: { v: "1" } }));
  expect(rawModelChoices(file)).toEqual({ whisper: null, kokoro: null });
  // a valid neighbour still reads
  writeFileSync(file, JSON.stringify({ whisper: "small", kokoro: null }));
  expect(rawModelChoices(file)).toEqual({ whisper: "small", kokoro: null });
});

test("the store is written 0600 into a 0700 dir, with no tmp file left behind", () => {
  // it is a fact about this host's runtime, kept like everything else in state/
  const file = storeIn("modes");
  saveModelChoice("whisper", "medium", file);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "stores", "modes")).mode & 0o777).toBe(0o700);
  expect(readdirSync(join(dir, "stores", "modes"))).toEqual(["voice-models.json"]);
});

test("a re-save of the same kind replaces it rather than appending", () => {
  const file = storeIn("replace");
  saveModelChoice("whisper", "small", file);
  saveModelChoice("whisper", "large-v3-turbo", file);
  expect(rawModelChoices(file)).toEqual({ whisper: "large-v3-turbo", kokoro: null });
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["whisper"]);
});

test("the file carries ONLY the kinds actually chosen", () => {
  /* An explicit choice is what stamps a model path onto a service row, and a
   * missing chosen model then fails loudly in /health. Writing a null kokoro
   * would turn "never chose one" into "chose nothing", which is a different
   * and much louder thing. */
  const file = storeIn("only-chosen");
  saveModelChoice("kokoro", "v1_1-zh", file);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ kokoro: "v1_1-zh" });
});

test("the store is valid JSON with a trailing newline (it is hand-edited)", () => {
  const file = storeIn("shape");
  saveModelChoice("whisper", "base.en", file);
  const text = readFileSync(file, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(() => JSON.parse(text)).not.toThrow();
});

test("saving over a malformed store repairs it instead of inheriting the junk", () => {
  const file = storeIn("repair");
  mkdirSync(join(dir, "stores", "repair"), { recursive: true });
  writeFileSync(file, "{half a rec");
  saveModelChoice("whisper", "tiny", file);
  expect(rawModelChoices(file)).toEqual({ whisper: "tiny", kokoro: null });
});

test("the current model is the persisted choice, else today's default", () => {
  /* An ABSENT file means what this host runs right now, so an install that
   * never ran the command keeps running exactly what it ran before. */
  const file = storeIn("current");
  expect(currentWhisperSize(file)).toBe(DEFAULT_WHISPER_SIZE);
  expect(currentKokoroVariant(file)).toBe(DEFAULT_KOKORO_VARIANT);
  saveModelChoice("whisper", "small.en", file);
  expect(currentWhisperSize(file)).toBe("small.en");
  expect(currentKokoroVariant(file)).toBe(DEFAULT_KOKORO_VARIANT); // untouched
  saveModelChoice("kokoro", "v0_19", file);
  expect(currentKokoroVariant(file)).toBe("v0_19");
});

test("the defaults are themselves offered options", () => {
  // a default the CLI would refuse to set is a default nobody can get back to
  expect(WHISPER_SIZES).toContain(DEFAULT_WHISPER_SIZE);
  expect(KOKORO_VARIANTS).toContain(DEFAULT_KOKORO_VARIANT);
});
