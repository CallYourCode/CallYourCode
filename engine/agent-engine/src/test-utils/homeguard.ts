/* THE TEST HOME GUARD: no test process can reach the real ~/.callyourcode.
 *
 * Loaded first in every `bun test` process of this package (bunfig.toml
 * `[test] preload`, and imported by the e2e preload as well), before any
 * module reads the environment. It points HOME, the XDG roots and the engine's
 * own data-dir variables at a throwaway directory made for this process, so
 * the DEFAULT of dataDir() (`join(homedir(), ".callyourcode")`, read lazily
 * per call) and everything that hangs off it resolve under that directory
 * for the whole run, whatever a test sets, deletes or restores in the env.
 *
 * Why it exists: every disk test already runs under its own CYC_DATA_DIR,
 * and still records reached the host (2026-09-02, defect A): a write that
 * resolved one path, awaited, and resolved the next landed under whatever
 * root the env named by then, and the seam rig swaps the env at stop(). The
 * write sites were fixed; this is the fence that makes the next such slip
 * land in a temp dir instead of the user's data. homeguard.test.ts is the
 * tripwire that proves the fence holds in the running process.
 *
 * What the swap reaches: everything that reads $HOME per call, which is
 * dataDir() (shared/cycdir.ts reads $HOME before homedir() for exactly this
 * reason) and so the whole ~/.callyourcode layout, plus limits.ts's
 * credentials path. What it does not: bun freezes os.homedir() at process
 * start (checked 2026-09-02 on bun 1.4.0: setting process.env.HOME later
 * does not move it), so the homedir()-based READ paths (~/.claude/projects,
 * ~/.codex, ~/.pi, the herdr socket default, server.ts's ENGINE_HOME) still
 * name the real home inside the test process. None of them writes.
 *
 * Child processes inherit process.env, so an engine an e2e spec spawns gets
 * a fake home that its own homedir() honours too (a fresh process reads
 * $HOME at start); the e2e harness sets an explicit one per engine as well.
 * The directory is removed when this process exits.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

/** The name under which the process's real HOME is kept, for the tripwire. */
export const REAL_HOME_VAR = "CYC_TEST_REAL_HOME";
/** The fake home this process runs under. */
export const FAKE_HOME_VAR = "CYC_TEST_FAKE_HOME";

const already = process.env[FAKE_HOME_VAR];
if (!already) {
  const realHome = process.env.HOME ?? "";
  const home = mkdtempSync(join(tmpdir(), "cyc-test-home-"));
  process.env[REAL_HOME_VAR] = realHome;
  process.env[FAKE_HOME_VAR] = home;
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = join(home, ".local", "share");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_CACHE_HOME = join(home, ".cache");
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  /* The engine's own roots: a shell that exports these at the real data
   * would otherwise hand every test that does not set its own the user's
   * files. Under the fake home, and off the default path so a write that
   * reaches `<home>/.callyourcode` is visibly a write that ignored the env. */
  process.env.CYC_DATA_DIR = join(home, "cyc-data");
  delete process.env.CYC_LOG_DIR;
  delete process.env.CYC_PROJECTS_DIR;
  /* Removed when the test run in this process is over. A hook registered
   * from a preload applies to the whole run of the process (each worker
   * under --parallel runs the preload and cleans its own); the exit handler
   * is the fallback for a process that stops without finishing its run. */
  const cleanup = () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } };
  afterAll(cleanup);
  process.on("exit", cleanup);
}
