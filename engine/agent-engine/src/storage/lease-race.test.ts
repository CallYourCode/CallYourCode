/* THE READING LEASE, RACED BY REAL PROCESSES.
 *
 * WHY THIS IS ITS OWN FILE, and why it sits in the process annex beside
 * lock.test.ts rather than in limits.test.ts. limits.test.ts races the lease
 * too, and races it well: eight logical engines, twenty rounds each, and an
 * `overlaps` list that is checked EXACTLY, because one event loop means one
 * `holder` variable and a second claimant arriving while the first still holds
 * it is seen the instant it happens. That test is worth having and stays.
 *
 * What it cannot see is what its own comment says it cannot see: REAL OS
 * PARALLELISM. Every contender in it shares a pid, so they share the `.claim`
 * temp name too, and two kernel threads never sit inside one syscall together.
 * The bug this file exists for lives exactly there:
 *
 *   `open(path, "wx")` followed by a write leaves the name EXISTING AND EMPTY
 *   for the length of that write. A reader landing in that window parses
 *   nothing, concludes the holder is dead, unlinks a live claim, and takes it.
 *
 * That window is a couple of instructions wide and cannot be scheduled by one
 * event loop. The measurement that condemned the old code was made with real
 * processes: SIXTY-EIGHT overlapping holds out of a few hundred claims, against
 * zero on the code that links a file which already has the pid in it. So the
 * multi-process form is the one that goes on watching the fix, and it is the
 * same argument lock.test.ts makes about the schedule lock, one directory over.
 *
 * AND THE DIFFERENCE IS MEASURED, not argued. With `link()` replaced by the
 * open-wx-then-write pair AND the `!held` guard removed (mutations I and S of
 * e2e/mutation/limits-run.sh, together, which is the state the code was
 * actually in):
 *
 *   limits.test.ts     67 pass, 0 fail -- three runs out of three
 *   this file           1 fail          -- five runs out of five
 *
 * One event loop cannot see it; eight processes see it every time.
 *
 * WHAT IS ASSERTED IS OVERLAP, not request counts. Two processes holding one
 * lease is the defect; both of them then fetching is a consequence, and
 * asserting the consequence would need them to reach an upstream. Each child
 * reports the interval it believed it held (fixtures/lease-runner.ts) and two
 * intervals from different pids may not overlap.
 *
 * There is no `Bun.sleep` here: the runners hold (they are the contending
 * processes, and a fixture is not a test file), and this file only waits on
 * their exit.
 *
 *   bun test agent-engine/src/storage/lease-race.test.ts
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";

const RUNNER = join(import.meta.dir, "..", "fixtures", "lease-runner.ts");

type Hold = { pid: number; from: number; to: number };

test("no two processes ever hold the lease at once", async () => {
  /* EIGHT AND TWENTY, and the numbers came DOWN rather than up. What finds this
   * race is CLAIM ATTEMPTS, and the runner's retry loop makes thousands of them
   * out of a couple of hundred successful holds, so the extra processes an
   * earlier version spent (twelve, thirty rounds) bought detection nothing and
   * cost the heaviest test in the suite. It was hitting its ceiling during
   * mutation runs, where the box has been running the whole suite twenty times
   * over, and a timeout there reads as this test catching something. */
  const share = await tmpDir("cyc-lease-race-");
  const procs = Array.from({ length: 8 }, () => Bun.spawn({
    cmd: ["bun", "run", RUNNER, "20"],
    /* The share directory is named through the engine's own env override, which
     * is what an engine on this machine really reads, so the children are
     * pointed at this test's throwaway directory and never at the one his real
     * engines share. */
    env: { ...process.env, CYC_LIMITS_SHARE_DIR: share },
    stdout: "pipe", stderr: "pipe",
  }));

  const holds: Hold[] = [];
  const stderrs: string[] = [];
  for (const p of procs) {
    const [out, err] = await Promise.all([
      new Response(p.stdout as ReadableStream).text(),
      new Response(p.stderr as ReadableStream).text(),
    ]);
    await p.exited;
    if (err.trim()) stderrs.push(err.trim());
    for (const line of out.split("\n")) {
      const m = line.match(/^HELD (\d+) (\d+) (\d+)$/);
      if (m) holds.push({ pid: Number(m[1]), from: Number(m[2]), to: Number(m[3]) });
    }
  }

  /* IT HAS TO HAVE ACTUALLY RACED. An empty list satisfies "no overlaps"
   * perfectly, so a runner that failed to import, or a share directory the
   * children could not create, would pass this test while proving nothing. The
   * floor is well under what eight processes of twenty rounds produce (160) and
   * well over anything a broken run reaches. */
  expect(holds.length,
    `only ${holds.length} holds were recorded, so the lease was never contended` +
    (stderrs.length ? `:\n${stderrs.join("\n")}` : "")).toBeGreaterThan(100);

  holds.sort((a, b) => a.from - b.from);
  const overlaps: string[] = [];
  for (let i = 1; i < holds.length; i++) {
    const prev = holds[i - 1], cur = holds[i];
    if (cur.pid !== prev.pid && cur.from < prev.to) {
      overlaps.push(`${prev.pid} held ${prev.from}-${prev.to}, ${cur.pid} took it at ${cur.from}`);
    }
  }
  expect(overlaps, "two processes held one account's lease at the same moment").toEqual([]);
  /* THE BUDGET IS THIS FILE'S WHOLE POINT, and it is generous on purpose: eight
   * processes and several hundred claims, where every other test in the default
   * run is one process. It takes about three seconds when nothing is wrong, and
   * a timeout here would be reported as this test catching something. */
}, 30_000);
