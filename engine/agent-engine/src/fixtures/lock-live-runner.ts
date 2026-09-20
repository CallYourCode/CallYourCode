/* A LIVING ENGINE: it keeps ticking, and it writes down what it thinks it owns
 * on every pass. Run as a real `bun` child by lock.test.ts.
 *
 * The question these specs ask is never "did it ever own the lock", it is "does
 * it still think so after something took it away", and only a process that goes
 * on asking can answer that. So this ticks in a loop and keeps a running count
 * of the passes on which `refuse()` said the file was not its to write.
 *
 *   bun run lock-live-runner.ts <file> <run-ms> <skew-ms> <beat-ms> <slow-ms>
 *                              <slow-for> <status-file> <stop-file>
 *
 * `skew-ms` moves THIS process's idea of the time without moving anyone else's,
 * which is what an NTP correction or a wake-from-sleep step looks like from
 * inside one engine.
 *
 * `slow-ms` is HOW LONG A DELIVERY TAKES, and it has to be settable. A delivery
 * is the only step here that can outlive the stale window -- `deliverToPane`
 * chains onto a global queue with no timeout -- and everything the losing
 * process does wrong it does AFTER coming back from one.
 *
 * THE STATUS FILE IS HOW THE SPEC WATCHES WITHOUT WAITING. stdout only arrives
 * at EOF, so a spec that wanted to know "has it noticed yet" had to wait for the
 * process to finish, which is why every one of these tests used to be sized by
 * the longest fixed sleep in it rather than by what it was proving. Each pass
 * rewrites one small JSON file, and the spec polls that; the marker files say
 * the same thing about a delivery that is currently in flight.
 *
 * THE STOP FILE IS THE OTHER HALF: the spec ends the run the moment its
 * assertions can be made, so `run-ms` is only the cap that stops a spec that
 * died from leaving children behind.
 */

import { existsSync, writeFileSync } from "node:fs";
import { Schedules, singleFileLayout } from "../plugins/crons/schedules.ts";

const file = process.argv[2];
const runMs = Number(process.argv[3] ?? 5000);
const skewMs = Number(process.argv[4] ?? 0);
const beatMs = Number(process.argv[5] ?? 50);
const slowMs = Number(process.argv[6] ?? 0);
const slowFor = process.argv[7] ?? "";
const statusFile = process.argv[8] ?? "";
const stopFile = process.argv[9] ?? "";

let ticks = 0;
let notMine = 0;
let delivering: string | null = null;

function writeStatus(): void {
  if (!statusFile) return;
  try {
    writeFileSync(statusFile,
      JSON.stringify({ pid: process.pid, ticks, notMine, delivering }));
  } catch { /* the spec's dir went away; it is finished with us */ }
}

const s = new Schedules({
  files: singleFileLayout(file),
  now: () => Date.now() + skewMs,
  deliver: async (sc) => {
    if (slowMs > 0 && (!slowFor || sc.id === slowFor)) {
      /* Announced through the status file as well as stdout: the spec starts the
       * rival engine the instant this one is stuck inside a delivery, and it
       * cannot read stdout until this process exits. */
      delivering = sc.id;
      writeStatus();
      console.log("DELIVER_ENTER " + process.pid + " " + sc.id + " at=" + Date.now());
      await Bun.sleep(slowMs);
      console.log("DELIVER_EXIT " + process.pid + " " + sc.id + " at=" + Date.now());
      delivering = null;
      writeStatus();
    }
    console.log("DELIVERED " + process.pid + " " + sc.id);
    return { ok: true };
  },
});

await s.load();
writeStatus();

const deadline = Date.now() + runMs;
while (Date.now() < deadline && !(stopFile && existsSync(stopFile))) {
  await s.tick();
  ticks++;
  if (s.refuse() !== null) notMine++;
  writeStatus();
  await Bun.sleep(beatMs);
}
console.log("TICKS " + process.pid + " " + ticks + " notMine=" + notMine);
s.stop();
// the status file outlives the process, so a spec can read the final counts
writeStatus();
