/* THE PRESENCE GATE: a service whose model file is not on disk yet is HELD
 * DOWN, quietly, and starts the moment the file lands (services.ts
 * needsModel). This is the supervision half of the background model warm-up
 * (modelwarmup.ts): on a fresh install the engine boots instantly, the ~2 GB
 * of voice models download while it serves, and nothing crash-loops over a
 * missing .pth in the meantime.
 *
 * The promises, each proved against a real supervisor and real toy processes
 * (the rig services.test.ts and services-unit.test.ts share):
 *
 *   MISSING MODEL, NO START. Passes come and go and the spawn never happens;
 *   /health says why in words that name the file.
 *
 *   A PARTIAL TEMP FILE NEVER OPENS THE GATE. `.part` is the atomic
 *   downloader's in-flight name (voicemodels.ts download); only the rename
 *   that completes a download creates the gated path.
 *
 *   THE MODEL LANDS, THE SERVICE STARTS, on the next look and with no backoff
 *   debt from the held-down passes.
 *
 *   A WATCH-ONLY UNIT MEMBER WHOSE MODEL IS DOWNLOADING DOES NOT HOLD THE
 *   OTHERS DOWN. All-or-none read strictly would keep kokoro (330 MB, lands
 *   first) dead for the whole 1.6 GB whisper fetch; per-capability warm-up
 *   means the members whose own models are here get to serve, while the unit
 *   still honestly reports not-whole (the mic stays hidden).
 *
 *   A REQUESTED RESTART IS REFUSED with the same reason, not turned into a
 *   crash loop on demand.
 *
 *   bun test agent-engine/src/runtime/services-model-gate.test.ts
 */

import { expect, setDefaultTimeout, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { portOpen, type ServiceSpec } from "./services.ts";
import { row, services, startsFile, startsIn, toyCmd, toyCwd, toyPort, unitOf,
  untilPort, useServicesRig } from "../fixtures/services-rig.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

useServicesRig();

/* Same raise as the sibling services files: a spec here spawns real toys. */
setDefaultTimeout(30_000);

/** A gated toy: a spawn service that needs `modelPath` on disk to start. */
function gatedSpec(port: number, starts: string, modelPath: string,
  over: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    key: "kokoro", name: "kokoro toy", port, ceilingMb: 6000,
    revive: { how: "spawn", cwd: toyCwd, cmd: toyCmd(port, starts) },
    needsModel: { name: "kokoro-v1_0.pth", paths: [modelPath] },
    ...over,
  };
}

test("a spawn service is held down while its model file is missing, and starts when it lands", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const model = join(await tmpDir("cyc-model-"), "kokoro-v1_0.pth");

  const s = await services([gatedSpec(port, starts, model)]);
  for (let i = 0; i < 3; i++) await s.check();

  expect(await startsIn(starts),
    "the service was started over a model file that is not there").toBe(0);
  expect(await portOpen(port)).toBe(false);
  const held = row(s, "kokoro");
  expect(held.running).toBe(false);
  expect(held.note, "/health does not say the model is what it is waiting for")
    .toContain("kokoro-v1_0.pth");
  expect(held.note).toContain("downloading");

  /* The model lands (what modelwarmup.ts's atomic rename produces): the very
   * next look starts the service, with no backoff debt from the held passes. */
  await writeFile(model, "FAKE-MODEL-BYTES");
  await s.check();
  await untilPort(port, true);
  expect(await startsIn(starts), "the landed model did not start the service").toBe(1);
  expect(row(s, "kokoro").running || row(s, "kokoro").starting).toBe(true);
});

test("a partial .part temp file never opens the gate", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const model = join(await tmpDir("cyc-model-"), "kokoro-v1_0.pth");
  /* A download died mid-stream: the atomic downloader's temp file is on disk,
   * the model is not. The gate reads the FINAL path only. */
  await writeFile(`${model}.part`, "HALF-");

  const s = await services([gatedSpec(port, starts, model)]);
  await s.check();
  await s.check();

  expect(await startsIn(starts),
    "a .part temp file opened the gate: a partial model would have been loaded").toBe(0);
  expect(row(s, "kokoro").running).toBe(false);
});

test("a watch-only unit member whose model is missing does not hold the startable members down", async () => {
  const [pk, pw] = [await toyPort(), await toyPort()];
  const fk = await startsFile();
  const kokoroModel = join(await tmpDir("cyc-model-"), "kokoro-v1_0.pth");
  await writeFile(kokoroModel, "FAKE-MODEL-BYTES"); // kokoro's model is HERE
  const whisperModel = join(await tmpDir("cyc-model-"), "ggml-large-v3-turbo.bin");
  // whisper's 1.6 GB is still downloading: the file does not exist

  const s = await services([
    gatedSpec(pk, fk, kokoroModel, { unit: "voice" }),
    { key: "whisper", name: "whisper toy (watch)", port: pw, ceilingMb: 8000,
      unit: "voice", revive: { how: "watch" },
      needsModel: { name: "ggml-large-v3-turbo.bin", paths: [whisperModel] } },
  ]);
  await s.check();
  await untilPort(pk, true);
  await s.check();

  /* Per-capability warm-up: tts serves while stt still downloads. */
  expect(await startsIn(fk),
    "kokoro was held down for the whole whisper download").toBe(1);
  expect(row(s, "kokoro").running).toBe(true);
  /* ...and the unit still tells the truth: it is NOT whole (the mic stays
   * hidden), because whisper is not up. Readiness is per capability; the unit
   * never pretends. */
  expect(unitOf(s, "voice").healthy,
    "a unit with whisper still downloading claimed to be whole").toBe(false);
});

test("a unit member with its model PRESENT but not listening still blocks (the carve-out is only for missing models)", async () => {
  const [pk, pw] = [await toyPort(), await toyPort()];
  const fk = await startsFile();
  const kokoroModel = join(await tmpDir("cyc-model-"), "kokoro-v1_0.pth");
  await writeFile(kokoroModel, "FAKE-MODEL-BYTES");
  const whisperModel = join(await tmpDir("cyc-model-"), "ggml-large-v3-turbo.bin");
  await writeFile(whisperModel, "FAKE-MODEL-BYTES"); // whisper's model is HERE...
  // ...but nothing ever listens on pw: whisper is down for a REAL reason.

  const s = await services([
    gatedSpec(pk, fk, kokoroModel, { unit: "voice" }),
    { key: "whisper", name: "whisper toy (watch)", port: pw, ceilingMb: 8000,
      unit: "voice", revive: { how: "watch" },
      needsModel: { name: "ggml-large-v3-turbo.bin", paths: [whisperModel] } },
  ]);
  for (let i = 0; i < 3; i++) await s.check();

  /* All-or-none stands wherever the carve-out does not apply: a member that
   * COULD be up and is not forces the unit down, exactly as before. */
  expect(await startsIn(fk),
    "kokoro was started into a unit whose watch member is down with its model present").toBe(0);
  expect(await portOpen(pk)).toBe(false);
});

test("a requested restart is refused while the model is missing, with the reason", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const model = join(await tmpDir("cyc-model-"), "kokoro-v1_0.pth");

  const s = await services([gatedSpec(port, starts, model)]);
  await s.check();
  const got = await s.restart("kokoro");
  expect(got.ok).toBe(false);
  expect(got.message).toContain("kokoro-v1_0.pth");
  expect(await startsIn(starts), "the refused restart started it anyway").toBe(0);
});

test("onCheck fires after every settled pass, so readiness can be re-read without polling", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const model = join(await tmpDir("cyc-model-"), "kokoro-v1_0.pth");
  let passes = 0;
  const s = await services([gatedSpec(port, starts, model)], { onCheck: () => { passes += 1; } });
  await s.check();
  expect(passes).toBe(1);
  await writeFile(model, "FAKE-MODEL-BYTES");
  await s.check();
  await until(() => passes === 2);
});
