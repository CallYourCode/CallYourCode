/* PER-TEST TEMP DIRECTORIES, removed for you.
 *
 * Every unit and seam test that touches disk gets its own mkdtemp under
 * os.tmpdir(). Nothing in the suite may reach the real ~/.callyourcode,
 * ~/.claude or /Users/Shared; the guardrails in ./guardrails.ts say why, and
 * this is the other half of it: if a directory is always a fresh one, no test
 * can inherit another's state and no test can leave anything behind.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const made: string[] = [];

/* THE CLEANUP IS REGISTERED AT MODULE SCOPE, ONCE, AND THAT IS LOAD BEARING.
 *
 * It used to be registered lazily, inside the first tmpDir() call, which looks
 * thriftier and is a trap: bun runs a hook registered from INSIDE a running
 * hook as soon as that hook returns. So a file whose first tmpDir() came from
 * beforeAll got its afterAll fired the moment beforeAll finished, and every
 * directory was deleted BEFORE the first test ran.
 *
 * It failed loudly in one file (23 failures at once) and silently in another,
 * where the store under test simply re-created the directory on demand: the
 * tests passed while leaking the dir and proving nothing about it. A hook that
 * is sometimes registered at the wrong time is worse than no hook. */
afterAll(async () => {
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** A fresh empty directory, removed when this test FILE finishes.
 *
 * Per-file rather than per-test on purpose: a seam file wires once in
 * beforeAll and its dir has to outlive the first test. A test that wants a
 * clean dir of its own just calls this again; they are cheap. */
export async function tmpDir(prefix = "cyc-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A tmp dir laid out the way the engine's CYC_DATA_DIR is: <dir>/data exists
 *  and is what you hand the engine, <dir> is where a test puts everything else
 *  (its projects dir, its credentials file, its lease dir). */
export async function tmpDataDir(prefix = "cyc-data-"): Promise<{ root: string; data: string }> {
  const root = await tmpDir(prefix);
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  return { root, data };
}

/** A unix socket PATH inside a tmp dir. Never a port: two test files running in
 *  parallel workers cannot collide on a path nobody else knows. */
export function sockPath(dir: string, name = "herdr.sock"): string {
  return join(dir, name);
}
