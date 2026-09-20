/* PRESENCE (L3 feature): "is he at the app, right now", answered from proof
 * rather than from a flag, plus the away/grace clock that decides when the
 * held pushes are owed.
 *
 * Split out of notify.ts: notify asks presence
 * (appConnected / isAway) and never the other way around. The ONE thing the
 * grace clock must do to notify -- "the grace expired, flush everything
 * unread" -- arrives as the injected onAway seam, wired by the composition
 * root, so the import points inward and there is no cycle.
 *
 *   bun test agent-engine/src/sessions/presence.test.ts
 */

import type { Sock } from "../transport/sock.ts";
import { realClock, type Clock } from "../runtime/clock.ts";

export type PresenceDeps = {
  /** page sockets only (a herdr or an MCP registers instead) */
  clients(): Set<Sock>;
  /** the grace expired and he really is away: notify's flushUnread */
  onAway(): void;
  /* THE ONE TIME SEAM. Everything here is a clock: a 30 second grace, a 10
   * second stability threshold, a heartbeat window. Production leaves this
   * undefined and gets realClock, which is Date.now and the global timers, so
   * the behaviour is byte-identical to what it was before the seam existed. A
   * test passes a manualClock() and the whole ladder costs one advance() with
   * no sleeping. */
  clock?: Clock;
};

let cfg: PresenceDeps | null = null;
/* Read on every call rather than captured: `present()` and `nextStableAt()` are
 * exported and can run before initPresence, so the default has to be live. */
let clk: Clock = realClock;
export function initPresence(d: PresenceDeps): void {
  cfg = d;
  clk = d.clock ?? realClock;
}
const C = (): PresenceDeps => {
  if (!cfg) throw new Error("presence not initialised");
  return cfg;
};

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/* The page's own heartbeat cadence, MEASURED per socket rather than assumed,
 * plus slack: a live page cannot stay silent past its own next beat. Shared
 * with notify's proof-of-life wait, which computes its deadline from the same
 * two numbers, deliberately: one definition of "how long may a live page stay
 * silent". */
export const BEAT_ASSUMED_MS = 10_000; // what the page's visibility timer does today
export const BEAT_SLACK_MS = 2_500;    // timer jitter plus a phone's round trip

/* THE 30 SECOND GRACE, AND THE CLOCK IT ACTUALLY RUNS ON.
 *
 * Not a nicety. The logs of 2026-08-02 show all three sockets dropping together
 * with code=1006 when a screen goes off, and again on a network blip; pushing
 * the instant the last one goes would ping him while he is sitting at his desk.
 * A client arriving inside the window cancels it.
 *
 * That last sentence was the bug. MEASURED over 32 hours of the real engine log
 * (2026-08-02T00:00Z to 2026-08-03T08:00Z): 292 grace windows started, 244 were
 * cancelled by a reconnect, 168 of those within five seconds, and the flush at
 * the end ran 14 times. 1144 sockets opened in the same period with a median
 * life of 3.7 seconds. That is not a person opening the app, it is a page
 * reconnecting, and a grace restarted from zero by every reconnect can never
 * expire. The half of the design that suppresses did all the work; the half that
 * delivers never ran.
 *
 * So the timer is no longer the clock. `awaySince` is when the last app went,
 * and a reconnect does not move it. It is cleared only once an app has been
 * CONTINUOUSLY present for stableMs(), which is the one thing a page in
 * a reconnect loop cannot do and a person sitting in front of the app does
 * without noticing. The grace still expires 30 seconds after he really left.
 *
 * Note what this does NOT do: it never makes a message that would have been
 * announced stay silent. It only lets the announcement that was already owed
 * actually happen. */
export const graceMs = (): number => Number(process.env.NOTIFY_GRACE_MS) || 30_000;
/* How long a connection has to hold before it counts as him being back. Ten
 * seconds because the app's own visibility heartbeat is ten: a page that cannot
 * survive one beat is not delivering him anything either. (Both knobs are read
 * per call, not captured at import: the value never changes in production and
 * a test file no longer depends on which module loaded first.) */
export const stableMs = (): number => Number(process.env.NOTIFY_STABLE_MS) || 10_000;

let awaySince: number | null = null;    // when the last app really went
let graceTimer: unknown = null;

/** Whether the away/grace clock is running (notify's "holding" branch reads
 *  this, never the timer: a timer being armed no longer means a grace is
 *  running, see onPresenceChange). */
export function isAway(): boolean {
  return awaySince !== null;
}

/* CONNECTED AND RESPONSIVE, not merely connected, and the difference is the
 * whole reason notify's poke exists.
 *
 * A frozen page holds its websocket open. Presence read as "the socket is
 * there" would hand that page the silence it does not deserve, which is the
 * 25-second-flag bug rebuilt in a new place: the app is closed, the socket is
 * open, and nothing ever buzzes. So a client counts as present only while its
 * javascript is demonstrably running:
 *
 *   - it has been poked and has said nothing since: frozen, does not count.
 *     notifyUnlessWatched only reaches fire() after that wait is over, so by
 *     then this is a settled fact rather than a poke in flight;
 *   - otherwise its last frame must be younger than its OWN measured heartbeat
 *     plus slack, because a live page cannot stay silent past its next beat.
 *
 * Both halves fail closed: an uncertain client is absent, and being absent
 * only ever costs a notification he might not have needed. */
export function present(c: Sock): boolean {
  if (c.data.probeAt > c.data.lastFrame) return false;
  return clk.now() - c.data.lastFrame < (c.data.beatMs || BEAT_ASSUMED_MS) + BEAT_SLACK_MS;
}

/* PRESENCE.
 *
 * "Is an app connected to THIS engine", and NOT "is it attached to this chat":
 * his complaint is pings while he is working, and a page open on another chat
 * means he is at the app. Each engine answers for itself; his app holds a socket
 * to all three, so all three go quiet together with nothing to coordinate.
 *
 * AND IT MUST ALSO BE A PAGE HE COULD BE LOOKING AT. Two more tests, both put
 * here because the engine got them wrong on the live laptop, 2026-08-03, and he
 * reported it as "not getting any notifications now".
 *
 *   VISIBLE. A socket that has just told us `visible:false` is a page he cannot
 *   see, and reading it as "he is at the app, stay quiet" is the app's own
 *   report of being invisible used as the reason to show him nothing. That is
 *   the exact inversion the suppress path exists to avoid. The engine log has it
 *   in one line: "why=1 client(s) on this chat, all say backgrounded ... so no
 *   new-message push". The decision above had already concluded nobody was
 *   watching; this branch then overrode it with the same fact.
 *
 *   HELD. A page that opened two seconds ago is not somebody working, it is a
 *   page reconnecting -- or a headless browser. Measured on this engine between
 *   12:26:09 and 12:27:31: fifteen sockets opened and closed against TEST-SINK,
 *   each living about 1.7s, every one of them a Playwright page from a test
 *   lane. While any one was up, replies to w9:p4 logged "present ... so no
 *   new-message push". My own test runs were his mute button.
 *
 * stableMs() is the same threshold the grace clock already uses for the
 * same judgement, deliberately: "has this connection held long enough to be a
 * person" is one question and deserves one number.
 *
 * What this does NOT change is his rule: a page open on
 * ANOTHER chat still silences the push, because that is him at the app. */
export function appConnected(): boolean {
  const now = clk.now();
  for (const c of C().clients()) {
    if (!present(c)) continue;
    if (!c.data.visible) continue;
    if (now - c.data.openedAt < stableMs()) continue;
    return true;
  }
  return false;
}

export function clearGrace() {
  if (!graceTimer) return;
  clk.clearTimeout(graceTimer);
  graceTimer = null;
}

export function armGrace(ms: number) {
  clearGrace();
  // never 0: a timer that fires in the same tick it was armed in would spin
  graceTimer = clk.setTimeout(() => { graceTimer = null; onPresenceChange(); }, Math.max(50, ms));
}

/** TEST ONLY: cancel the grace timer, forget that anybody ever went away, and
 *  drop the deps, so a second in-process wiring does not inherit a timer that
 *  fires flushUnread() into the previous wiring's notify. No-op in production,
 *  which never re-wires. */
export function resetForTest(): void {
  clearGrace();
  awaySince = null;
  cfg = null;
  clk = realClock;
}

export function expireGrace(why: string) {
  clearGrace();
  const away = awaySince === null ? 0 : clk.now() - awaySince;
  awaySince = null;
  console.log(`[notify] grace expired after ${secs(away)} (${why})`);
  C().onAway();
}

/* WHEN THE SOONEST PAGE THAT IS UP WOULD START COUNTING AS PRESENCE, or null if
 * none would. `appConnected` turns true with the passage of time rather than on
 * any event, so something has to say when to ask it again. */
export function nextStableAt(): number | null {
  let soonest: number | null = null;
  for (const c of C().clients()) {
    if (!present(c) || !c.data.visible) continue;
    const at = c.data.openedAt + stableMs();
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

/* Called when a socket arrives or goes, and by the timer re-asking. It is an
 * evaluator rather than an edge handler on purpose: presence can also lapse
 * with no event at all (a page that stops beating), and the timer re-entering
 * here is what notices.
 *
 * It asks appConnected and does NOT re-derive stability itself. It used to: it
 * kept a `presentSince` and applied stableMs() here, while the push
 * path applied only "is a socket connected". Those two answers to "is he there"
 * then drifted, which is how a headless browser could be presence enough to
 * silence a push while not being presence enough to cancel a grace. One
 * question, one function. */
export function onPresenceChange() {
  const now = clk.now();
  if (appConnected()) {
    clearGrace();
    if (awaySince !== null) {
      console.log(`[notify] grace cancelled: an app is back (away was ${secs(now - awaySince)})`);
      awaySince = null;
    }
    return;
  }
  /* Nothing counts as presence yet. A page that is UP but too young is not the
   * same as an empty engine: he has not gone anywhere, so no grace clock starts
   * and no push is held. Just come back when it would count. */
  const stable = nextStableAt();
  if (awaySince === null && stable !== null) { armGrace(stable - now); return; }
  if (awaySince === null) {
    awaySince = now;
    console.log(`[notify] last app gone, holding pushes for ${secs(graceMs())}`);
  }
  const deadline = awaySince + graceMs();
  if (now >= deadline) { expireGrace("no app connected"); return; }
  /* He IS away, and a page is up that has not held long enough to say otherwise.
   * The away clock KEEPS RUNNING -- this is the reconnect loop that used to
   * cancel it every few seconds and so could hold the flush off for ever. Come
   * back at whichever arrives first: that page becoming presence, or the
   * deadline. */
  if (stable !== null && stable < deadline) {
    console.log(`[notify] grace held: a page is up but not yet presence, ` +
      `${secs(deadline - now)} left on the clock`);
    armGrace(stable - now);
    return;
  }
  armGrace(deadline - now);
}
