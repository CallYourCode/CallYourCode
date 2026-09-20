/* THE BACKGROUND MODEL WARM-UP NEVER BLOCKS AND NEVER LIES (modelwarmup.ts).
 *
 * The promises under test, each the reason a first install is snappy:
 *
 *   START RETURNS AT ONCE. The whole point: boot kicks the download and goes
 *   on serving. Proven with a fetch that never resolves until the spec says
 *   so; start() has returned and status says downloading long before.
 *
 *   A LANDED MODEL FLIPS present AND SETTLES. The bytes arrive via the
 *   atomic downloader (temp `.part` -> rename), the destination appears whole,
 *   the `.part` is gone, onSettled fires once per kind.
 *
 *   A PARTIAL TEMP FILE IS NEVER THE MODEL. `dest.part` on disk leaves
 *   present() false: only the atomic rename makes a model.
 *
 *   A FAILURE RETRIES WITH BACKOFF, and a short body against a declared
 *   length is a FAILURE (download() verifies the size), not a model.
 *
 * Hermetic: the fetch is injected, every path is a fresh tmp dir, no test
 * ever reaches the network or a real model directory.
 *
 *   bun test agent-engine/src/runtime/modelwarmup.test.ts
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelWarmup, type WarmupKind } from "./modelwarmup.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

const BYTES = "FAKE-MODEL-BYTES"; // 16 bytes

/** A fetch that answers every url with the fake model bytes, counting calls. */
function servingFetch(counter: { calls: number }, body = BYTES,
  declaredLength?: number): typeof fetch {
  return (async () => {
    counter.calls += 1;
    return new Response(body, {
      headers: { "content-length": String(declaredLength ?? body.length) },
    });
  }) as unknown as typeof fetch;
}

function warm(kinds: { kind: WarmupKind; files: { url: string; dest: string }[] }[],
  opts: ConstructorParameters<typeof ModelWarmup>[1] = {}) {
  const w = new ModelWarmup(kinds, { baseMs: 5, maxMs: 20, ...opts });
  return w;
}

test("start() returns at once while the download is still in flight, and marks the kind downloading", async () => {
  const dir = await tmpDir("cyc-warm-");
  const dest = join(dir, "ggml-large-v3-turbo.bin");
  /* A fetch parked on a promise the SPEC releases: if start() awaited the
   * download, this test would hang instead of passing. */
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const parked = (async () => {
    await gate;
    return new Response(BYTES, { headers: { "content-length": String(BYTES.length) } });
  }) as unknown as typeof fetch;

  const settled: string[] = [];
  const w = warm([{ kind: "whisper", files: [{ url: "http://stub/model.bin", dest }] }],
    { fetchImpl: parked, onSettled: (k) => settled.push(k) });

  w.start(); // returned: nothing was awaited
  expect(w.status("whisper").downloading,
    "the kind is not marked downloading while its fetch is in flight").toBe(true);
  expect(w.present("whisper"), "present before any byte landed").toBe(false);
  expect(settled, "settled before the download finished").toEqual([]);

  release();
  await until(() => w.present("whisper"));
  expect(settled, "the landed model did not settle its kind").toEqual(["whisper"]);
  expect(w.status("whisper").downloading).toBe(false);
  expect(existsSync(`${dest}.part`), "the temp file survived the rename").toBe(false);
  expect(await Bun.file(dest).text(), "the landed file does not hold the downloaded bytes")
    .toBe(BYTES);
  w.stop();
});

test("a model already on disk downloads nothing and is present from the first look", async () => {
  const dir = await tmpDir("cyc-warm-");
  const dest = join(dir, "kokoro-v1_0.pth");
  await writeFile(dest, BYTES);
  const counter = { calls: 0 };
  const settled: string[] = [];
  const w = warm([{ kind: "kokoro", files: [{ url: "http://stub/k.pth", dest }] }],
    { fetchImpl: servingFetch(counter), onSettled: (k) => settled.push(k) });
  w.start();
  /* start() skipped the kind synchronously (its files are all present), so no
   * download loop exists to ever call the fetch: calls stays 0 by
   * construction, not by winning a race. */
  expect(w.present("kokoro")).toBe(true);
  expect(w.status("kokoro").downloading).toBe(false);
  expect(counter.calls, "a present model was downloaded again").toBe(0);
  /* No download happened, so nothing NEW settled either: readiness was already
   * readable from the disk, and a spurious settle would re-kick the
   * supervisor for nothing. */
  expect(settled).toEqual([]);
  w.stop();
});

test("a partial .part temp file is never the model", async () => {
  const dir = await tmpDir("cyc-warm-");
  const dest = join(dir, "ggml-large-v3-turbo.bin");
  await writeFile(`${dest}.part`, BYTES.slice(0, 4)); // a download died mid-stream
  const w = warm([{ kind: "whisper", files: [{ url: "http://stub/m.bin", dest }] }]);
  expect(w.present("whisper"),
    "a .part temp file counted as the model: a partial file would be loaded").toBe(false);
});

test("every file of a kind must land before it is present (kokoro ships weights + config)", async () => {
  const dir = await tmpDir("cyc-warm-");
  const pth = join(dir, "kokoro-v1_0.pth");
  const cfg = join(dir, "config.json");
  await writeFile(pth, BYTES); // the weights are here, the config is not
  const counter = { calls: 0 };
  const w = warm([{ kind: "kokoro", files: [
    { url: "http://stub/k.pth", dest: pth },
    { url: "http://stub/config.json", dest: cfg },
  ] }], { fetchImpl: servingFetch(counter) });
  expect(w.present("kokoro"), "half a kind's files counted as present").toBe(false);
  w.start();
  await until(() => w.present("kokoro"));
  expect(counter.calls, "the already-present weights were downloaded again").toBe(1);
  w.stop();
});

test("a failed attempt retries with backoff until the model lands", async () => {
  const dir = await tmpDir("cyc-warm-");
  const dest = join(dir, "ggml-large-v3-turbo.bin");
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls < 3) return new Response("upstream unhappy", { status: 503 });
    return new Response(BYTES, { headers: { "content-length": String(BYTES.length) } });
  }) as unknown as typeof fetch;
  const incidents: string[] = [];
  const w = warm([{ kind: "whisper", files: [{ url: "http://stub/m.bin", dest }] }],
    { fetchImpl: flaky, incident: (line) => incidents.push(line) });
  w.start();
  await until(() => w.present("whisper"));
  expect(calls, "the download did not retry past its failures").toBe(3);
  expect(w.status("whisper").attempts).toBe(3);
  expect(incidents.filter((l) => l.includes("retrying")).length,
    "the failures left no record").toBe(2);
  w.stop();
});

test("fewer bytes than the declared length is a failure, never a model", async () => {
  const dir = await tmpDir("cyc-warm-");
  const dest = join(dir, "ggml-large-v3-turbo.bin");
  let calls = 0;
  /* First answer declares 100 bytes and sends 16 (a stream cut mid-way that
   * ended cleanly); the second answers whole. */
  const truncating = (async () => {
    calls += 1;
    return calls === 1
      ? new Response(BYTES, { headers: { "content-length": "100" } })
      : new Response(BYTES, { headers: { "content-length": String(BYTES.length) } });
  }) as unknown as typeof fetch;
  const w = warm([{ kind: "whisper", files: [{ url: "http://stub/m.bin", dest }] }],
    { fetchImpl: truncating });
  w.start();
  await until(() => w.present("whisper"));
  expect(calls, "the truncated body was accepted as the model").toBe(2);
  expect(await Bun.file(dest).text()).toBe(BYTES);
  w.stop();
});

test("stop() stands a retrying loop down instead of leaving it waiting for ever", async () => {
  const dir = await tmpDir("cyc-warm-");
  const dest = join(dir, "ggml-large-v3-turbo.bin");
  let calls = 0;
  const failing = (async () => {
    calls += 1;
    return new Response("no", { status: 503 });
  }) as unknown as typeof fetch;
  /* A LONG backoff, so the loop is parked in its between-attempts wait when
   * stop() lands; without the wake-on-stop this test would time out. */
  const w = warm([{ kind: "whisper", files: [{ url: "http://stub/m.bin", dest }] }],
    { fetchImpl: failing, baseMs: 60_000, maxMs: 60_000 });
  w.start();
  await until(() => calls >= 1);
  w.stop();
  /* The wake-on-stop: the loop was parked in a 60s backoff, and stop() must
   * resolve that wait and stand the loop down. Without it, `downloading` stays
   * true until the backoff fires (this poll would time out at 2s, a 30th of
   * the wait). One attempt, and never another. */
  await until(() => !w.status("whisper").downloading,
    { what: "the stopped loop to stand down" });
  expect(calls, "a stopped warm-up fired another attempt").toBe(1);
});

test("a kind this engine is not warming answers inert, never present", () => {
  const w = warm([]);
  expect(w.present("whisper")).toBe(false);
  expect(w.status("kokoro")).toEqual({ present: false, downloading: false, pct: null, attempts: 0 });
});
