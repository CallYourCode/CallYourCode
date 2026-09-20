/* THE TRIPWIRE for homeguard.ts: this process cannot reach the real home.
 *
 * Runs in the same process as every other test file, after the `[test]
 * preload` in bunfig.toml, and asserts what the guard promised: HOME is a
 * temp dir of this process, apart from the passwd home, and the DEFAULT data
 * dir (CYC_DATA_DIR unset) resolves under it, so no write in this suite can
 * land in the user's ~/.callyourcode whatever the env does mid-test.
 *
 *   bun test agent-engine/src/test-utils/homeguard.test.ts
 */

import { test, expect } from "bun:test";
import { tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { existsSync } from "node:fs";
import { dataDir, agentsDir, logsDir } from "../storage/datadir.ts";

/* Spelled out rather than imported from homeguard.ts: importing it would run
 * the guard from this file, late, and the first test would pass with no
 * preload at all. */
const REAL_HOME_VAR = "CYC_TEST_REAL_HOME";
const FAKE_HOME_VAR = "CYC_TEST_FAKE_HOME";

const under = (path: string, root: string) => path === root || path.startsWith(root + sep);

/** dataDir() with CYC_DATA_DIR unset, the env restored before anyone can see the swap. */
function defaultDataDir(): string {
  const saved = process.env.CYC_DATA_DIR;
  delete process.env.CYC_DATA_DIR;
  try { return dataDir(); } finally {
    if (saved === undefined) delete process.env.CYC_DATA_DIR;
    else process.env.CYC_DATA_DIR = saved;
  }
}

test("the preload ran first: HOME is this process's own temp dir, apart from the real home", () => {
  const fake = process.env[FAKE_HOME_VAR];
  expect(fake, "homeguard.ts did not run (bunfig.toml [test] preload)").toBeTruthy();
  expect(process.env.HOME).toBe(fake!);
  expect(under(fake!, tmpdir()), `${fake} is not under ${tmpdir()}`).toBe(true);
  expect(existsSync(fake!)).toBe(true);
  const real = process.env[REAL_HOME_VAR];
  if (real) expect(fake).not.toBe(real);
  // the passwd home is the one the guard exists to keep out of reach
  const passwd = userInfo().homedir;
  expect(fake).not.toBe(passwd);
  expect(under(join(fake!, ".callyourcode"), join(passwd, ".callyourcode"))).toBe(false);
  /* bun freezes homedir() at process start, so it still names the real home
   * here; that is why dataDir() reads $HOME (cycdir.ts) and why this file
   * proves the DATA DIR below rather than homedir(). A fresh child process
   * reads the swapped $HOME at its own start. */
  const child = Bun.spawnSync(["bun", "-e", "console.log(require('node:os').homedir())"], { env: process.env });
  expect(child.stdout.toString().trim(), "a spawned engine's homedir() follows the fake HOME").toBe(fake!);
});

test("the default data dir, and everything off it, resolve under the fake home", () => {
  const fake = process.env[FAKE_HOME_VAR]!;
  const real = process.env[REAL_HOME_VAR];
  const dflt = defaultDataDir();
  expect(dflt).toBe(join(fake, ".callyourcode"));
  expect(under(dflt, fake)).toBe(true);
  if (real && real !== fake) expect(under(dflt, real), `${dflt} reaches the real home ${real}`).toBe(false);
  // and the guard's own CYC_DATA_DIR, the root a test inherits when it sets none
  expect(under(dataDir(), fake), `CYC_DATA_DIR=${process.env.CYC_DATA_DIR} escapes the fake home`).toBe(true);
  expect(under(agentsDir(), fake)).toBe(true);
  expect(under(logsDir(), fake)).toBe(true);
  for (const v of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    expect(under(process.env[v] ?? "", fake), `${v}=${process.env[v]}`).toBe(true);
  }
});
