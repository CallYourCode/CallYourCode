/* ONE ENGINE, ONE CLAIM: the smallest process that can contend for the schedule
 * file, run as a real `bun` child by lock.test.ts.
 *
 * WHY IT IS A FILE AND NOT A STRING IN THE TEST. It used to be a template
 * literal that the spec wrote into a tmp dir. That put `Bun.sleep(` inside
 * lock.test.ts, which the suite's own gate (gates.test.ts, rule 2) greps for and
 * cannot tell apart from a test that really sleeps. A fixture is not a test
 * file, so the runner may sleep here exactly as a real engine does, and the spec
 * stays honest about never sleeping itself.
 *
 *   bun run lock-runner.ts <schedules-file> <hold-ms> [ready-file] [release-file]
 *
 * It loads the store, ticks once (which is where the lock is taken), prints one
 * line saying whether it got it, and then HOLDS.
 *
 * THE HOLD IS A BARRIER, NOT A SLEEP, and that is the whole of what makes the
 * twenty-engine round mean anything. The first version of the spec let every
 * process release the moment it was done, so twenty of them passed the lock
 * along in an orderly queue and seven "owned" it, one after another, entirely
 * correctly: it looked like the bug and was the test. The fix was a fixed
 * 1500ms hold, which only works while the hold is longer than however long the
 * OS takes to get twenty bun processes to this line -- a bound nobody measured
 * and a loaded box can beat. So each process now says READY and waits for the
 * spec to say RELEASE: overlap is guaranteed rather than hoped for, and the
 * round costs process startup instead of a second and a half. `hold-ms` remains
 * as the cap, so a spec that dies never leaves twenty children behind.
 */

import { existsSync, writeFileSync } from "node:fs";
import { Schedules, singleFileLayout } from "../plugins/crons/schedules.ts";

const file = process.argv[2];
const holdMs = Number(process.argv[3] ?? 0);
const readyFile = process.argv[4] ?? "";
const releaseFile = process.argv[5] ?? "";

const s = new Schedules({
  files: singleFileLayout(file),
  deliver: async (sc) => {
    // one line per delivery, with the pid that made it: the double-fire signal
    console.log("DELIVERED " + process.pid + " " + sc.id);
    return { ok: true };
  },
});
await s.load();
await s.tick();
console.log((s.refuse() === null ? "OWNER " : "LOSER ") + process.pid);

if (readyFile) {
  try { writeFileSync(readyFile, String(process.pid)); } catch { /* the spec's dir went */ }
}

if (holdMs > 0) {
  const deadline = Date.now() + holdMs;
  // Held until the spec releases everyone at once, or the cap runs out.
  while (Date.now() < deadline && !(releaseFile && existsSync(releaseFile))) {
    await Bun.sleep(10);
  }
}
s.stop();
