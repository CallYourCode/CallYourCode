/* WHERE THIS MACHINE KEEPS ITS CallYourCode DATA -- the root, and the one
 * directory more than one service writes into.
 *
 * The engine's per-feature paths (agents, uploads, plugin data, the two-axis
 * plugin rule) stay in agent-engine/src/storage/datadir.ts, which is still the single
 * authority for them and re-exports these two so no engine call site moved.
 * Only the ROOT and the LOG directory are here, because they are the parts that
 * are not the engine's alone: shared/logbook.ts writes the structured log, and
 * the engine, the app server and the browser all write that same format into
 * that same directory on purpose, so `scripts/cyclog.sh <cid>` can follow one
 * recording across all three (CYC_LOG_DIR still wins per service).
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The base dir: CYC_DATA_DIR (trailing slashes stripped), else ~/.callyourcode.
 *
 *  `~` is $HOME when the environment has one, homedir() (the passwd entry)
 *  only when it does not. The two agree for a person at a shell; they part
 *  where $HOME was set on purpose, and there $HOME is the intent: a test
 *  process that fenced its home off (agent-engine/src/test-utils/homeguard.ts)
 *  must not see this fall back to the user's real one. Bun freezes homedir()
 *  at process start, so only $HOME, read per call, can follow such a swap. */
export function dataDir(): string {
  const env = process.env.CYC_DATA_DIR;
  if (env && env.trim()) return env.trim().replace(/\/+$/, "");
  const home = process.env.HOME;
  return join(home && home.trim() ? home : homedir(), ".callyourcode");
}

/** The structured-log mirror. CYC_LOG_DIR overrides it, per service. */
export const logsDir = (): string => join(dataDir(), "logs");
