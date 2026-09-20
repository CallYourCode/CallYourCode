/* presence.ts: the away/grace clock, on fake sockets and a MANUAL clock.
 *
 * Everything this module does is timing: a 30 second grace, a 10 second
 * stability threshold, a heartbeat window measured per socket. presence.ts now
 * takes an optional `clock` in its deps bag (defaulting to realClock, so
 * production is unchanged), and this file drives the real production numbers
 * with manualClock() instead of shrinking them with env and then sleeping for a
 * third of a second. Nothing here waits on the wall clock at all.
 *
 * The two knobs are DELETED at file scope rather than set: with logical time the
 * test can afford the real 30s/10s, and clearing them means an ambient
 * NOTIFY_GRACE_MS in somebody's shell cannot change what this file proves.
 *
 *   bun test agent-engine/src/sessions/presence.test.ts
 */

import { expect, test, beforeEach, beforeAll, afterAll } from "bun:test";
import type { Sock } from "../transport/sock.ts";
import { manualClock, type ManualClock } from "../runtime/clock.ts";
import {
  initPresence, resetForTest, isAway, present, appConnected, onPresenceChange,
  expireGrace, clearGrace, armGrace, nextStableAt, graceMs, stableMs,
  BEAT_ASSUMED_MS, BEAT_SLACK_MS,
} from "./presence.ts";

const priorEnv = {
  NOTIFY_GRACE_MS: process.env.NOTIFY_GRACE_MS,
  NOTIFY_STABLE_MS: process.env.NOTIFY_STABLE_MS,
};
beforeAll(() => {
  delete process.env.NOTIFY_GRACE_MS;
  delete process.env.NOTIFY_STABLE_MS;
});
afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetForTest();
});

let clock: ManualClock;
let clients: Set<Sock>;
let awayFlushes = 0;

beforeEach(() => {
  resetForTest();
  clock = manualClock();
  clients = new Set<Sock>();
  awayFlushes = 0;
  initPresence({ clients: () => clients, onAway: () => { awayFlushes += 1; }, clock });
});

/** A page socket, alive and visible and old enough to count, unless overridden.
 *  Every timestamp is in the manual clock's time, not the wall clock's. */
const sock = (over: Record<string, unknown> = {}): Sock =>
  ({ data: { visible: true, visibleAt: clock.now(), beatMs: 0, gaps: [],
    lastFrame: clock.now(), pongAt: 0, probeAt: 0, openedAt: clock.now() - 60_000, cid: 1,
    role: "client", ...over } } as unknown as Sock);

test("the production knobs are the ones under test", () => {
  // the whole point of the manual clock: no shrunken window stands in for the
  // real one, so a change to either default is a change to this file
  expect(graceMs()).toBe(30_000);
  expect(stableMs()).toBe(10_000);
});

/* ------------------------------- present() -------------------------------- */

test("present: a page is alive while its last frame is inside its own beat plus slack", () => {
  const c = sock({ beatMs: 4_000, lastFrame: clock.now() });
  expect(present(c)).toBe(true);
  clock.setNow(clock.now() + 4_000 + BEAT_SLACK_MS - 1);
  expect(present(c)).toBe(true);
  clock.setNow(clock.now() + 2);
  expect(present(c)).toBe(false); // past its own next beat: it cannot be running
});

test("present: an unmeasured socket falls back to the assumed beat", () => {
  // beatMs is 0 until two visibility claims have arrived; a brand new page must
  // not be read as dead for want of a measurement
  const c = sock({ beatMs: 0, lastFrame: clock.now() });
  clock.setNow(clock.now() + BEAT_ASSUMED_MS + BEAT_SLACK_MS - 1);
  expect(present(c)).toBe(true);
  clock.setNow(clock.now() + 2);
  expect(present(c)).toBe(false);
});

test("present: a poked page that has said nothing since is frozen, not present", () => {
  /* The 25-second-flag bug rebuilt in a new place: a frozen page holds its
   * websocket open, so "the socket is there" is not proof. A probe with no frame
   * after it is the settled fact that its javascript is not running. */
  const c = sock({ lastFrame: clock.now(), probeAt: clock.now() + 1 });
  expect(present(c)).toBe(false);
  // and a frame after the poke revives it
  (c.data as { lastFrame: number }).lastFrame = clock.now() + 2;
  expect(present(c)).toBe(true);
});

/* ----------------------------- appConnected() ----------------------------- */

test("appConnected wants present AND visible AND held long enough", () => {
  expect(appConnected()).toBe(false); // an empty engine

  // a page that says it is backgrounded is not a page he is looking at
  const hidden = sock({ visible: false });
  clients.add(hidden);
  expect(appConnected()).toBe(false);
  clients.clear();

  // a page that opened two seconds ago is reconnect churn or a headless browser
  const young = sock({ openedAt: clock.now() - 2_000 });
  clients.add(young);
  expect(appConnected()).toBe(false);
  clients.clear();

  // a page that has gone silent past its beat is not running
  const silent = sock({ lastFrame: clock.now() - 60_000 });
  clients.add(silent);
  expect(appConnected()).toBe(false);
  clients.clear();

  clients.add(sock());
  expect(appConnected()).toBe(true);
});

test("appConnected turns true with the passage of time alone, no event needed", () => {
  const c = sock({ openedAt: clock.now() });
  clients.add(c);
  expect(appConnected()).toBe(false);
  // the socket said nothing; only the clock moved. Keep the page beating so the
  // liveness half stays satisfied while the stability half matures.
  clock.setNow(clock.now() + stableMs());
  (c.data as { lastFrame: number }).lastFrame = clock.now();
  expect(appConnected()).toBe(true);
});

test("appConnected is about THIS engine, not this chat", () => {
  // his rule: a page open on another conversation is still him
  // at the app, and must silence the push
  clients.add(sock({ attached: "w9:p4" }));
  expect(appConnected()).toBe(true);
});

/* -------------------------------- the clock ------------------------------- */

test("no clients: the away clock starts; a stable app coming back cancels it", () => {
  expect(isAway()).toBe(false);
  onPresenceChange();
  expect(isAway()).toBe(true);
  expect(awayFlushes).toBe(0); // held, not flushed: the grace is still running
  clients.add(sock()); // opened 60s ago: continuously present, stable
  onPresenceChange();
  expect(isAway()).toBe(false);
  expect(awayFlushes).toBe(0); // cancelled, nothing owed
  clearGrace();
});

test("a too-young page does not count as him being back", () => {
  onPresenceChange(); // away
  expect(isAway()).toBe(true);
  clients.add(sock({ openedAt: clock.now() - 5 })); // reconnect churn
  onPresenceChange();
  expect(isAway()).toBe(true); // the away clock KEEPS RUNNING
});

test("nextStableAt: when the soonest young page would start counting", () => {
  expect(nextStableAt()).toBe(null);
  const opened = clock.now() - 10;
  clients.add(sock({ openedAt: opened }));
  expect(nextStableAt()).toBe(opened + stableMs());
});

test("nextStableAt takes the SOONEST of several, and ignores pages that never will", () => {
  const early = clock.now() - 9_000;
  const late = clock.now() - 1_000;
  clients.add(sock({ openedAt: late }));
  clients.add(sock({ openedAt: early }));
  clients.add(sock({ openedAt: clock.now(), visible: false }));           // never counts
  clients.add(sock({ openedAt: clock.now(), lastFrame: clock.now() - 60_000 })); // not alive
  expect(nextStableAt()).toBe(early + stableMs());
});

test("nextStableAt is null when nothing is up that could ever become presence", () => {
  clients.add(sock({ visible: false }));
  clients.add(sock({ lastFrame: clock.now() - 60_000 }));
  expect(nextStableAt()).toBeNull();
});

test("expireGrace flushes what is owed and settles the clock", () => {
  onPresenceChange();
  expect(isAway()).toBe(true);
  expireGrace("test");
  expect(isAway()).toBe(false);
  expect(awayFlushes).toBe(1);
  expect(clock.pending).toBe(0); // and it cancelled its own timer
});

test("the timer path: an empty engine expires the grace on its own", async () => {
  onPresenceChange(); // no clients: away, timer armed for the grace
  expect(isAway()).toBe(true);
  expect(clock.pending).toBe(1);

  await clock.advance(graceMs() - 1);
  expect(isAway()).toBe(true);   // one millisecond short: still holding
  expect(awayFlushes).toBe(0);

  await clock.advance(2);
  expect(isAway()).toBe(false);  // the deadline passed and the flush ran
  expect(awayFlushes).toBe(1);
  expect(clock.pending).toBe(0); // nothing left armed
});

test("a page that is UP but too young starts no grace at all", () => {
  /* He has not gone anywhere: a page is right there, it just has not held long
   * enough to say so. Starting an away clock here would hold his pushes for a
   * page he is actually looking at. */
  clients.add(sock({ openedAt: clock.now() }));
  onPresenceChange();
  expect(isAway()).toBe(false);
  expect(clock.pending).toBe(1); // it just comes back when the page would count
});

test("that young page becoming stable cancels the pending re-ask, silently", async () => {
  const c = sock({ openedAt: clock.now() });
  clients.add(c);
  onPresenceChange();
  // keep it beating so it is still alive when the stability threshold arrives
  const beat = clock.setInterval(() => { (c.data as { lastFrame: number }).lastFrame = clock.now(); }, 1_000);
  await clock.advance(stableMs() + 100);
  clock.clearInterval(beat);
  expect(isAway()).toBe(false);
  expect(awayFlushes).toBe(0); // nothing was ever owed
});

test("a reconnect loop cannot hold the flush off for ever", async () => {
  /* THE BUG THIS MODULE EXISTS FOR, measured over 32 real hours: 292 grace
   * windows, 244 cancelled by a reconnect, the flush ran 14 times. `awaySince`
   * is when the last app went and a reconnect does not move it, so a page that
   * churns every few seconds burns the grace down exactly like an empty engine. */
  onPresenceChange();
  const awayAt = clock.now();
  for (let i = 0; i < 10; i++) {
    const c = sock({ openedAt: clock.now() });
    clients.add(c);
    onPresenceChange();
    await clock.advance(2_000); // dies before it could ever be stable
    clients.delete(c);
    onPresenceChange();
    await clock.advance(1_000);
  }
  expect(clock.now() - awayAt).toBeGreaterThanOrEqual(graceMs());
  expect(isAway()).toBe(false);
  expect(awayFlushes).toBe(1); // once, at the deadline, not once per reconnect
});

test("a page that finally holds inside the grace cancels it with nothing owed", async () => {
  onPresenceChange();
  expect(isAway()).toBe(true);
  const c = sock({ openedAt: clock.now() });
  clients.add(c);
  onPresenceChange();
  const beat = clock.setInterval(() => { (c.data as { lastFrame: number }).lastFrame = clock.now(); }, 1_000);
  await clock.advance(stableMs() + 100);
  clock.clearInterval(beat);
  expect(isAway()).toBe(false);
  expect(awayFlushes).toBe(0); // he came back before the grace ran out
});

test("armGrace never arms a zero timer, however negative the gap", async () => {
  // a timer that fires in the same tick it was armed in would spin the loop
  armGrace(-5_000);
  expect(clock.pending).toBe(1);
  expect(isAway()).toBe(false); // arming is not being away
  await clock.advance(49);
  expect(isAway()).toBe(false); // still armed at 49ms: the floor is 50
  await clock.advance(1);
  // it fired at the floor and the re-ask found an empty engine, so the away
  // clock started then rather than in the tick armGrace ran in
  expect(isAway()).toBe(true);
});

test("armGrace replaces the armed timer rather than stacking a second one", () => {
  armGrace(1_000);
  armGrace(2_000);
  armGrace(3_000);
  expect(clock.pending).toBe(1);
  clearGrace();
  expect(clock.pending).toBe(0);
});

test("isAway reads the away clock, never the timer", async () => {
  /* They came apart on purpose: a timer can be armed for "come back when that
   * page would count" while nobody is away at all, and notify's holding branch
   * must not read that as a grace. */
  clients.add(sock({ openedAt: clock.now() }));
  onPresenceChange();
  expect(clock.pending).toBe(1);
  expect(isAway()).toBe(false);
});

test("resetForTest cancels the armed timer, so no test inherits another's flush", async () => {
  onPresenceChange();
  expect(clock.pending).toBe(1);
  resetForTest();
  expect(clock.pending).toBe(0);
  expect(isAway()).toBe(false);
  // and the deps really are gone: presence refuses rather than calling a stale onAway
  expect(() => onPresenceChange()).toThrow("presence not initialised");
});

test("the default clock is the real one, so production is unchanged", () => {
  /* The seam is optional. An engine that wires presence without a clock has to
   * behave exactly as it did before the seam existed, which means reading the
   * wall clock rather than a manual one frozen at 2023. */
  resetForTest();
  const c = sock({ openedAt: Date.now() - 60_000, lastFrame: Date.now() });
  initPresence({ clients: () => new Set([c]), onAway: () => {} });
  expect(present(c)).toBe(true);
  expect(appConnected()).toBe(true);
  expect(nextStableAt()).toBe(c.data.openedAt + stableMs());
});
