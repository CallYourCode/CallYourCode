/* Data-dir files are owner-only after a write, and a boot repair fixes the old ones.
 *
 *   VOICE_URL=http://127.0.0.1:1 bun test agent-engine/src/storage/runfiles.test.ts
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIR_MODE, FILE_MODE, appendPrivate, mkdirPrivate, repairRunTree, writePrivate,
} from "../../../shared/runfiles.ts";

const modeOf = (p: string) => statSync(p).mode & 0o777;

let scratch: string | null = null;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  scratch = null;
});

test("writePrivate leaves the file 0600 and mkdirPrivate leaves the dir 0700", async () => {
  scratch = await mkdtemp(join(tmpdir(), "cyc-runfiles-"));
  const dir = join(scratch, "nested");
  const file = join(dir, "secret.json");
  await mkdirPrivate(dir);
  await writePrivate(file, JSON.stringify({ k: "v" }));
  expect(modeOf(dir)).toBe(DIR_MODE);
  expect(modeOf(file)).toBe(FILE_MODE);
  await appendPrivate(file, "\n");
  expect(modeOf(file)).toBe(FILE_MODE);
});

test("repairRunTree chmods an already-written tree without crashing on a missing path", async () => {
  scratch = await mkdtemp(join(tmpdir(), "cyc-runfiles-"));
  const run = join(scratch, ".run");
  const logs = join(run, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o775 });
  writeFileSync(join(run, "chat.json"), "{}", { mode: 0o664 });
  writeFileSync(join(logs, "engine.log"), "x", { mode: 0o664 });
  chmodSync(run, 0o775);
  chmodSync(logs, 0o775);

  await repairRunTree(join(scratch, "no-such-tree"));
  await repairRunTree(run);

  expect(modeOf(run)).toBe(DIR_MODE);
  expect(modeOf(logs)).toBe(DIR_MODE);
  expect(modeOf(join(run, "chat.json"))).toBe(FILE_MODE);
  expect(modeOf(join(logs, "engine.log"))).toBe(FILE_MODE);
});

/* The third test that used to live here BOOTED A WHOLE ENGINE to prove that a
 * world-readable data dir already on disk is repaired on the way up. That is a
 * fact about server.ts's startup and cannot be stated without one, so it moved
 * to e2e/roundtrip.test.ts rather than being weakened into a call to
 * repairRunTree that would have proven only what the test above already does.
 * The two here are the pure ones: the modes writePrivate and mkdirPrivate
 * leave, and that repairRunTree survives a path that is not there. */
