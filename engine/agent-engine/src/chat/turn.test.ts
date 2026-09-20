/* #411: an engine restart must not reset every row's age to "<1m".
 *
 * The row's subtitle renders how long a session has been in its current state,
 * off the `turnSince` the engine stamps. `turnSince` was seeded from Date.now()
 * whenever there was no in-memory previous observation -- which is every
 * restored session on the FIRST herdr poll after a restart. So right after a
 * deploy every row read "<1m", and N minutes later every row read the restart
 * age, instead of the age of what actually last happened in that session (his
 * screenshot: every merged row showing the reconnect moment).
 *
 * The fix (turn.ts): on that first-poll-after-restart edge, seed from the
 * session's newest STORED message ts (chat.json), never from now. These tests
 * pin the boot behaviour and the reconnect stability, with `now` injected so
 * "now" is a fixed instant a full hour after the seeded activity.
 *
 *   bun test agent-engine/src/chat/turn.test.ts
 */

import { test, expect } from "bun:test";
import { turnSinceFor, turnPhase } from "./turn.ts";

const T = 1_000_000; // the session's real last-activity instant
const NOW = T + 3_600_000; // the engine boots/reconnects an hour later
const now = () => NOW;

test("#411 boot: a restored session seeds turnSince from its last message, not now", () => {
  // prev undefined = the first poll after a restart; the log's newest ts is T
  const since = turnSinceFor(undefined, "working", T, now);
  expect(since).toBe(T);
  // and it is NOT the restart moment, which is what read as "<1m"
  expect(since).not.toBe(NOW);
});

test("#411 an idle restored session gets the same honest seed", () => {
  expect(turnSinceFor(undefined, "idle", T, now)).toBe(T);
});

test("#411 reconnect does not reset the age: same phase keeps the stamp", () => {
  const prev = { status: "working", turnSince: T };
  // a later poll after reconnect, still working: the stretch never restarted
  expect(turnSinceFor(prev, "working", undefined, now)).toBe(T);
});

test("a real state transition still resets to now (unchanged behaviour)", () => {
  const prev = { status: "idle", turnSince: T };
  // idle -> working is a genuine new stretch that begins now
  expect(turnSinceFor(prev, "working", T, now)).toBe(NOW);
});

test("a brand-new session with no stored history begins its turn now", () => {
  // no prev AND no restored message: a genuinely new turn does start now
  expect(turnSinceFor(undefined, "working", undefined, now)).toBe(NOW);
});

// ------------------------------------------------------- the two phases

test("turnPhase folds five statuses into the two stretches the row renders", () => {
  /* The subtitle says "busy since" or "waiting since"; it never says "done
   * since". working and blocked are one stretch because a permission prompt
   * mid-turn is the same piece of work continuing, and idle and done are the
   * other because flipping between them is bookkeeping rather than an event. */
  expect(turnPhase("working")).toBe("busy");
  expect(turnPhase("blocked")).toBe("busy");
  expect(turnPhase("idle")).toBe("waiting");
  expect(turnPhase("done")).toBe("waiting");
  // a dead pane reports "unknown", and an absent status is the same non-answer:
  // neither is busy, so neither restarts a stretch on its own
  expect(turnPhase("unknown")).toBe("waiting");
  expect(turnPhase(undefined)).toBe("waiting");
});

test("working -> blocked does NOT restart the clock: one stretch, still busy", () => {
  /* The case the phase fold exists for. A tool asks for permission halfway
   * through a twenty minute run; if that reset the stamp the row would read
   * "<1m" for work that has been going since before lunch, which is the #411
   * symptom arriving by a different door. */
  const prev = { status: "working", turnSince: T };
  expect(turnSinceFor(prev, "blocked", undefined, now)).toBe(T);
  // and back again when he answers it
  expect(turnSinceFor({ status: "blocked", turnSince: T }, "working", undefined, now)).toBe(T);
});

test("done <-> idle does NOT restart the clock either", () => {
  // "waiting since" is how long he has been the one holding it up; the harness
  // settling from done to idle is not something that happened to him
  expect(turnSinceFor({ status: "done", turnSince: T }, "idle", undefined, now)).toBe(T);
  expect(turnSinceFor({ status: "idle", turnSince: T }, "done", undefined, now)).toBe(T);
});

test("busy -> waiting is a real transition and does begin now", () => {
  // the reply landed: the waiting stretch starts at this instant, and the
  // restored ts is NOT used, because there is a live previous observation
  expect(turnSinceFor({ status: "working", turnSince: T }, "idle", T, now)).toBe(NOW);
  expect(turnSinceFor({ status: "blocked", turnSince: T }, "done", T, now)).toBe(NOW);
});

test("a previous observation with no stamp at all falls back to now", () => {
  /* prev exists but carries turnSince 0 (or nothing): there is no honest
   * earlier instant to keep, and 0 would render as an age of 56 years. */
  expect(turnSinceFor({ status: "working", turnSince: 0 }, "working", undefined, now)).toBe(NOW);
  expect(turnSinceFor({ status: "working" }, "working", undefined, now)).toBe(NOW);
});

test("#411 the restored seed is used for BOTH phases, and only on the first poll", () => {
  // whichever phase a restored session comes back in, its age is the age of
  // what last happened in it, not of the process
  for (const status of ["working", "blocked", "idle", "done"]) {
    expect(turnSinceFor(undefined, status, T, now), `${status} reset to the restart moment`).toBe(T);
  }
  // once there IS a previous observation the restored ts stops mattering: an
  // hour later the same session must not be re-seeded back to T on every poll
  const prev = { status: "working", turnSince: NOW };
  expect(turnSinceFor(prev, "working", T, now)).toBe(NOW);
});
