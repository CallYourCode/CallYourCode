/* model.test.ts: the `cyc model` entrypoint's arg-parse contract.
 *
 * Only the parse/usage path is proved here: setting a model would download a
 * file and restart a service, which needs a live engine. Driving the real
 * command as its own process keeps it honest about argv and exit codes.
 *
 *   bun test agent-engine/src/runtime/model.test.ts
 */

import { test, expect } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

async function runModel(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([process.execPath, "run", "src/runtime/model.ts", ...args], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { out, err, code: await proc.exited };
}

test("an unknown model kind exits 2 with the usage line on stderr", async () => {
  const r = await runModel(["frobnicate"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("usage: cyc model <whisper|kokoro>");
});

test("no argument at all exits 2 with the usage line", async () => {
  const r = await runModel([]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("usage: cyc model <whisper|kokoro>");
});

/* The old `stt [prebuilt|gpu]` backend picker (planStt/runStt/sttListingLines)
 * is GONE with the python stt venv it rebuilt: sherpa-onnx is prebuilt on every
 * platform and has no build-time choice, so those tests were removed here. */
