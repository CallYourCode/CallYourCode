/* THE WHOLE RETRY WINDOW, WALKED, and it is a file of its own for a reason
 * worth writing down.
 *
 * #377: the backoff doubled past the deadline and the give-up branch fired AT
 * the deadline, so the last attempt landed at +106 minutes and nothing at all
 * was tried in the fourteen minutes after it. A pane that came back at +110 --
 * inside the window, by the record's own account -- got nothing, while the row
 * it left claimed "the 2 hours it was worth retrying for". Proving that is
 * gone means walking the ENTIRE two hours at the engine's real tick cadence,
 * for a pane that comes back at each of the interesting minutes, and asserting
 * that every one of them gets the message exactly once.
 *
 * That is seven two-hour walks at fifteen seconds a step. The ticks themselves
 * are free; what costs is the lock HEARTBEAT, which fsyncs once a minute of
 * logical time and so lands about eight hundred real fsyncs in here. Two and a
 * half seconds of them, which is the whole of this file's runtime and would be
 * most of schedules.test.ts's if it lived there. The suite's rule for a file
 * that busts its budget is to split it rather than to raise the cap, and this
 * is the split: one claim, the expensive one, on its own.
 *
 *   bun test agent-engine/src/plugins/crons/retry-window.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { manualClock } from "../../runtime/clock.ts";
import { tmpDir } from "../../test-utils/tmp.ts";
import { until } from "../../test-utils/wait.ts";
import {
  singleFileLayout, Schedules, instantOf, GRACE_MS, TICK_MS, type Deliver,
} from "./schedules.ts";

const UTC = "UTC";
const AGENT = "ag-w1p1";
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  instantOf({ y, mo, d, h, mi }, UTC);

/* An instance dropped with its lock FileHandle open is closed by GC, which bun
 * 1.4 raises as an unhandled error that fails whichever test is running when it
 * happens. Every store here is stopped. */
let stores: Schedules[] = [];
afterEach(async () => {
  for (const st of stores.splice(0)) st.stop();
  await until(() => true); // let the fire-and-forget release land
});

/** One store on a clock the test moves by hand, over its own scratch file. */
async function store(startMs: number, reachable: () => boolean) {
  const dir = await tmpDir("cyc-retry-");
  const clock = manualClock(startMs);
  const sent: string[] = [];
  const deliver: Deliver = async (sc) => {
    if (!reachable()) return { ok: false, why: "the session is offline", retriable: true };
    sent.push(sc.body);
    return { ok: true };
  };
  const s = new Schedules({ files: singleFileLayout(join(dir, "schedules.json")), deliver, clock });
  stores.push(s);
  await s.load();
  return { s, sent, set: (ms: number) => clock.setNow(ms) };
}

test("the retry window has no dead stretch at the end of it", async () => {
  /* Every minute of the window is either after an attempt that has already
   * carried the message, or before one still to come. There is nowhere left to
   * fall through. The values are the ones that decide it: before the old last
   * attempt (95, 100), on it (106), inside the stretch it left dead (110, 115,
   * 119), and on the deadline itself (120). */
  const due = at(2026, 8, 4, 7, 0);
  for (const back of [95, 100, 106, 110, 115, 119, 120]) {
    let free = false;
    const t = await store(at(2026, 8, 4, 6, 0), () => free);
    await t.s.create({ agent: AGENT, name: "nudge", body: "stop working",
      kind: "once", at: due, tz: UTC });
    for (let ms = due; ms <= due + GRACE_MS + 60_000; ms += TICK_MS) {
      if (ms >= due + back * 60_000) free = true;
      t.set(ms);
      await t.s.tick();
    }
    expect(t.sent.length, `a pane back at +${back} min got nothing`).toBe(1);
  }
});

/* The other end of the same claim -- a pane that never comes back gets the
 * message zero times and the row says it gave up -- is cheap, because it needs
 * two ticks rather than a walk: "a retry gives up at the grace" and "a retry
 * probes often but broadcasts only when the answer changes", both in
 * schedules.test.ts. */
