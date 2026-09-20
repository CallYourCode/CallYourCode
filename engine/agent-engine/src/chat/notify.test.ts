/* WOULD A NOTIFICATION ACTUALLY BE SENT, and when, and how many?
 *
 * The seam: initNotify + initPresence over a REAL pushSink standing in for the
 * app server, a REAL sealed identity, real sessions built by the real reconcile,
 * and a MANUAL clock. No engine process, no browser, no port but the sink's.
 *
 * The bug the file exists for: a page that FREEZES when the app closes keeps its
 * websocket open and its last "I am visible" claim is seconds old, so the engine
 * believed somebody was watching and sent nothing. It happened, it was reported
 * from the Android tablet, and nothing in the repo would have noticed. A socket
 * that stays open and stops sending heartbeats IS a frozen page as far as the
 * engine can tell, which is exactly why it needs no browser to reproduce;
 * e2e/freeze-probe.ts does the same thing to a real Chromium to confirm that a
 * real freeze looks like this.
 *
 * WHAT CHANGED HERE, and it is the whole point of the rewrite: the old file
 * booted an engine per test and spent SEVENTY-TWO SECONDS in literal Bun.sleep
 * waiting out ten second push windows, thirteen second proof deadlines and
 * ten minute ceilings for decisions the engine had made in the first
 * millisecond. notify.ts now takes a `clock` in its deps bag, so every one of
 * those windows is `await clock.advance(ms)` and NOTHING SLEEPS. The numbers
 * under test are the PRODUCTION ones -- the real 10s window, the real 10 minute
 * ceiling, the real 30s grace -- rather than env-shrunken stand-ins, which is
 * strictly more than the old file proved.
 *
 *   bun test agent-engine/src/chat/notify.test.ts
 */

import { test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { wireCore, type WireCore, type WireCoreOpts, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until, settle } from "../test-utils/wait.ts";
import { onChat } from "./reply.ts";
import { batchMs, ceilingMs, ceilingTickMs, sendDismissal } from "./notify.ts";
import { onPresenceChange, graceMs, stableMs } from "../sessions/presence.ts";
import { unreadOf } from "../sessions/readstate.ts";
import { deriveSessionKey, openPush } from "../../../shared/e2e";
import { newestGen } from "../security/sec";
import type { Sock } from "../transport/sock.ts";

/* THE THREE NOTIFY KNOBS ARE DELETED AT FILE SCOPE rather than set, exactly as
 * presence.test.ts deletes its two. With logical time this file can afford the
 * real ten seconds and the real ten minutes, and clearing the overrides means an
 * ambient NOTIFY_BATCH_MS in somebody's shell cannot quietly change what these
 * tests prove. notify.ts reads all three per call, so deleting them here (before
 * any wiring) is enough. */
const priorEnv = {
  NOTIFY_BATCH_MS: process.env.NOTIFY_BATCH_MS,
  NOTIFY_CEILING_MS: process.env.NOTIFY_CEILING_MS,
  NOTIFY_CEILING_TICK_MS: process.env.NOTIFY_CEILING_TICK_MS,
  NOTIFY_GRACE_MS: process.env.NOTIFY_GRACE_MS,
  NOTIFY_STABLE_MS: process.env.NOTIFY_STABLE_MS,
};
for (const k of Object.keys(priorEnv)) delete process.env[k];
afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/* THE DECISION LOG IS PART OF THE FEATURE, not decoration: "it was delivered",
 * "the engine suppressed it on purpose" and "the engine never tried" used to be
 * indistinguishable after the fact, and telling them apart meant buzzing a real
 * phone. The old file read them off a booted engine's stdout; in process they
 * are console.log, captured the way agents.test.ts already does it.
 *
 * Swallowed rather than forwarded, because a notify seam test writes a decision
 * line per reply and this file makes a lot of replies. SHOW_NOTIFY=1 prints them
 * anyway, which is how you find out WHICH branch fired when one of these fails. */
const lines: string[] = [];
const real = { log: console.log, warn: console.warn, error: console.error };
const grab = (through: (...a: unknown[]) => void) => (...a: unknown[]) => {
  lines.push(a.map((x) => String(x)).join(" "));
  if (process.env.SHOW_NOTIFY) through(...a);
};
/** every captured line that is a notify decision */
const said = () => lines.filter((l) => l.includes("[notify]"));
const saidSomething = (needle: string) => said().some((l) => l.includes(needle));
/** the ONE line that says what was decided about a reply */
const decision = () => said().find((l) => l.includes("[notify] send") || l.includes("[notify] suppress")) ?? "";

let core: WireCore;

/* ONE WIRING, RESET PER TEST. Notify's state is unusually cross-cutting -- a
 * queued window, a notified flag on the session, a silentSince clock, presence's
 * awaySince -- so a test inheriting the previous one's would be a test whose
 * result depends on file order. reset() re-runs the same boot over the same tmp
 * dir and a fresh push sink, which is a restart, and it is cheap.
 *
 * The ask and context polls are pushed an hour out. Nothing in this file is
 * about either, and the ceiling tests advance TEN MINUTES of logical time, which
 * would otherwise fire two hundred pane reads and seventy-five transcript reads
 * against the fake herdr for no assertion at all. */
const HOUR = 60 * 60_000;
const BASE: WireCoreOpts = { with: ["notify", "frames"], askPollMs: HOUR, contextPollMs: HOUR };

beforeAll(() => {
  console.log = grab(real.log);
  console.warn = grab(real.warn);
  console.error = grab(real.error);
});
afterAll(() => {
  console.log = real.log;
  console.warn = real.warn;
  console.error = real.error;
});
/* WHAT THE SESSION GRAPH ITSELF LEAVES ARMED (the ask poll and the context
 * poll, both pushed an hour out above). A leak assertion has to be stated
 * against this rather than against zero, or it would only be measuring the
 * layers this file never asked about. */
let idlePending = 0;

beforeEach(async () => {
  core = await wireCore(BASE);
  await until(() => core.sessions.size === 1, { what: "the pane to reconcile" });
  idlePending = core.clock.pending;
  lines.length = 0;
});
afterEach(async () => { await core.stop(); });

const sink = () => core.pushSink!;
const session = (id = PANE) => core.sessionOf(id)!;
/** every push item the sink has recorded, flattened out of its batches */
const hits = () => sink().hits;

/* THE MCP'S END OF A SESSION: the socket a `chat` frame arrives on. Not a page
 * and deliberately not in wire.ts's client set, so an agent replying can never
 * itself be mistaken for somebody being at the app. */
function sessionSock(id = PANE): Sock {
  return {
    data: {
      role: "session", sessionId: id, attached: null, visible: false, visibleAt: 0,
      beatMs: 0, gaps: [], lastFrame: 0, pongAt: 0, probeAt: 0, probeSeq: 0, cid: 0,
      openedAt: 0, tailing: null, terms: new Map(), remoteAddr: "127.0.0.1",
    },
    readyState: 1,
    send() {},
    close() {},
    remoteAddr: "127.0.0.1",
  } as unknown as Sock;
}

/** The agent answers. The REAL reply path: reply.ts -> chatlog -> the notify
 *  decision, exactly as an MCP `chat` frame drives it. */
async function say(text: string, id = PANE): Promise<void> {
  await onChat(sessionSock(id), { text, msgId: crypto.randomUUID() });
}

/** Let a page HOLD its socket long enough to count as him being at the app.
 *  appConnected ignores anything younger than stableMs(); ten seconds is also
 *  inside a page's own beat window (12.5s), so it is still demonstrably alive,
 *  and the beat at the end is the visibility frame the app sends anyway. */
async function holdOpen(c: FakeClient): Promise<void> {
  await core.clock.advance(stableMs());
  c.setVisible(true, core.clock.now());
}

/** Advance to the next wall boundary and wait on the real fetch the flush makes.
 *  A window is logical time; the POST to the sink is real I/O. */
async function flushWindow(): Promise<void> {
  const before = sink().batches.length;
  await core.clock.advance(batchMs());
  await until(() => sink().batches.length > before, { what: "the window to reach the sink" });
}

/** A whole window in which nothing is expected to leave. Proving a negative
 *  costs the window plus a drain, and no more. */
async function quietWindow(): Promise<void> {
  await core.clock.advance(batchMs());
  await settle();
}

/* Open a captured wire item's `enc` with this engine's own content key, to prove
 * the real preview rides ONLY inside the sealed blob (task 527). The session id
 * is whatever the item carried -- the engine keys a push by `host:pane`, and the
 * seal is derived from that same string. */
async function openSealed(hit: { sessionId: string; enc?: string }) {
  const kS = await deriveSessionKey(newestGen(core.e2e!).key, hit.sessionId);
  return openPush(kS, hit.enc ?? "") as Promise<{ title: string; body: string; count: number }>;
}

/* --------------------------------------------------------- watched or not -- */

test("a page that is really watching gets no notification, and the row goes read", async () => {
  const c = core.client({ attach: wireId(PANE), visible: true });
  await say("still here");

  /* THE PROOF, and it is the one thing a frozen page cannot fake: a frame from
   * that socket stamped after the reply. The engine poked it the moment the
   * reply landed; this is the page answering. */
  expect(c.sock.data.probeAt).toBe(core.clock.now());
  expect(c.of("ping")).toHaveLength(1);
  c.sock.data.lastFrame = core.clock.now() + 1;
  await core.clock.advance(200);

  expect(decision()).toContain("is watching");
  await quietWindow();
  expect(hits()).toHaveLength(0);
  /* AND THE MARKER MOVED. Without this the suppressed notification and the row
   * disagree: no banner, but a count of 1 on a chat open in front of you. */
  expect(unreadOf(session())).toBe(0);
});

test("a page that freezes still gets the notification, late rather than never", async () => {
  /* Its socket is still open, so "connected" would say he is at the app and send
   * nothing at all, for ever. Presence is connected AND responsive: it was
   * poked, it never answered, so it is absent and this notification goes. */
  const c = core.client({ attach: wireId(PANE), visible: true });
  c.sock.data.beatMs = 1_500; // the app uses 10s; the engine measures what it is told
  await say("the run finished");

  // one beat plus slack is the longest a live page can stay silent
  await core.clock.advance(1_500 + 2_500);
  expect(decision()).toContain("no proof of life");
  expect(decision()).toContain("late="); // it arrives late, which is the trade

  await flushWindow();
  expect(hits()).toHaveLength(1);
  expect(hits()[0].unread).toBe(1);
});

test("a page that comes back DURING the wait is not notified", async () => {
  // reconnecting or opening the chat mid-wait means somebody IS looking now, and
  // a banner for a message already on screen is the noise this avoids
  const c = core.client({ attach: wireId(PANE), visible: true });
  c.sock.data.beatMs = 4_000;
  await say("thawing");
  await core.clock.advance(1_000); // silent so far: no proof yet
  expect(decision()).toBe("");

  c.sock.data.lastFrame = core.clock.now(); // and here it thaws
  await core.clock.advance(200);
  expect(decision()).toContain("is watching");
  await quietWindow();
  expect(hits()).toHaveLength(0);
});

test("a page that says it is backgrounded does not silence his phone, and waits for nothing", async () => {
  /* HIS BUG, 2026-08-03: "not getting any notifications now". The engine log said
   * it in one line -- "why=1 client(s) on this chat, all say backgrounded ... so
   * no new-message push". The decision had already concluded nobody was watching,
   * and then the presence branch overrode it using the same fact.
   *
   * And it goes out AT ONCE, with no grace and no proof dance. The thirty seconds
   * exist for the ambiguous case, where every socket dropped together and the
   * engine cannot tell a screen going off from a network blip. This is not that:
   * the page is connected and has told us in words that he cannot see it. */
  const c = core.client({ attach: wireId(PANE), visible: false });
  await holdOpen(c);
  c.setVisible(false, core.clock.now());
  await say("you left");

  expect(decision()).toContain("all say backgrounded");
  expect(c.of("ping")).toHaveLength(0); // nothing was asked to prove anything
  expect(saidSomething("[notify] holding")).toBe(false);
  expect(saidSomething("[notify] present")).toBe(false);
  await flushWindow();
  expect(hits()).toHaveLength(1);
});

test("a claim already older than that page's own beat is stale, and is not waited on", async () => {
  /* The wait is the page's OWN cadence plus slack, measured per socket. A claim
   * that has already outlived it cannot be a page that is running, so there is
   * nothing to prove and nothing to wait for: fire immediately. */
  const c = core.client({ attach: wireId(PANE), visible: true });
  c.sock.data.beatMs = 1_000;
  await core.clock.advance(20_000); // twenty seconds of silence from a 1s beat
  await say("you went quiet");

  expect(decision()).toContain("stale claim");
  expect(c.of("ping")).toHaveLength(0);
  await flushWindow();
  expect(hits()).toHaveLength(1);
});

test("a socket that closes mid-wait is notified, and says so", async () => {
  const c = core.client({ attach: wireId(PANE), visible: true });
  c.sock.data.beatMs = 2_000;
  await say("gone");
  c.close(); // the screen went off; the socket went with it
  await core.clock.advance(2_000 + 2_500);

  expect(decision()).toContain("socket closed");
  await flushWindow();
  expect(hits()).toHaveLength(1);
});

/* ------------------------------------------------------------- presence ---- */

test("an app connected to this engine silences new-message pushes", async () => {
  /* This REVERSES what this file used to assert. A page open on
   * another chat used to be notified ("the case the jump bar exists for"); his
   * complaint is pings while he is working, and a page open anywhere means he is
   * working. Which chat is on screen is not the question. */
  const c = core.client({ attach: null, visible: true });
  await holdOpen(c);
  await say("over here");

  expect(saidSomething("[notify] present")).toBe(true);
  await quietWindow();
  expect(hits()).toHaveLength(0);
  // held, not settled: the ceiling clock is running on this chat
  expect(session().silentSince).toBeDefined();
});

test("a page that keeps reconnecting is not somebody working", async () => {
  /* MEASURED on the live engine, 12:26:09 to 12:27:31: fifteen sockets opened and
   * closed against TEST-SINK, each living about 1.7s, all of them Playwright
   * pages from my own test lanes. Every one of them silenced a reply on a chat it
   * had never touched. My test runs were his mute button.
   *
   * The socket below is visible and answering, so it passes every other test.
   * Only the holding rule separates it from a person. */
  core.client({ attach: null, visible: true }); // opened this instant
  await say("while a test browser was up");

  expect(saidSomething("[notify] present")).toBe(false);
  expect(decision()).toContain("[notify] send");
  await flushWindow();
  expect(hits()).toHaveLength(1);
});

test("the last app leaving waits out the grace, then pushes what is unread", async () => {
  /* The engine's own logs record all three sockets dropping
   * together with code=1006 when a screen goes off, so an instant push is a ping
   * at his own desk. The full THIRTY SECONDS is under test here, not a shrunken
   * one: it costs an advance(). */
  const c = core.client({ attach: null, visible: true });
  await holdOpen(c);
  await say("while you were here");
  await quietWindow();
  expect(hits()).toHaveLength(0); // connected: nothing went out

  c.close();
  onPresenceChange(); // what the socket close handler does
  await core.clock.advance(graceMs() - 1);
  await settle();
  expect(hits()).toHaveLength(0); // still inside the grace: he may be right there

  await core.clock.advance(2);
  expect(saidSomething("[notify] grace expired")).toBe(true);
  expect(saidSomething("[notify] flush")).toBe(true);
  await flushWindow();
  expect(hits()).toHaveLength(1);
  expect(hits()[0].unread).toBe(1);
});

test("a reconnect that holds is him coming back, and it cancels the grace with nothing owed", async () => {
  // the other side of the same rule, and the reason the grace exists at all: a
  // screen going off drops every socket at once, and coming back must not cost
  // him a banner for something he is about to look at.
  const first = core.client({ attach: null, visible: true });
  await holdOpen(first);
  await say("held while he steps away");
  first.close();
  onPresenceChange();
  expect(saidSomething("[notify] last app gone")).toBe(true);

  await core.clock.advance(1_000); // inside the grace
  const back = core.client({ attach: null, visible: true });
  onPresenceChange();
  await holdOpen(back); // and it STAYS, which is the whole difference

  expect(saidSomething("[notify] grace cancelled")).toBe(true);
  await core.clock.advance(graceMs() + batchMs());
  await settle();
  expect(saidSomething("[notify] flush")).toBe(false);
  expect(hits()).toHaveLength(0);
});

/* ------------------------------------------------------------- the window -- */

test("one push carries every session that moved in the window", async () => {
  // one buzz for the window, not one per chat
  await say("first");
  await say("second");
  // the DECISION is immediate; only the sending waits for the window
  expect(said().filter((l) => l.includes("[notify] send"))).toHaveLength(2);
  expect(sink().batches).toHaveLength(0);

  await flushWindow();
  expect(sink().batches).toHaveLength(1);
  expect(sink().batches[0].sessions).toBe(1); // two replies, one chat, one entry
  expect(hits()).toHaveLength(1);
  expect(hits()[0].unread).toBe(2);           // and the count is both
});

test("two chats moving in one window ride ONE push, not two", async () => {
  await core.reset({ ...BASE, panes: [PANE, "w2:p7"] });
  await until(() => core.sessions.size === 2, { what: "both panes to reconcile" });
  lines.length = 0;

  await say("one chat");
  await say("the other chat", "w2:p7");
  await flushWindow();

  expect(sink().batches).toHaveLength(1);
  expect(sink().batches[0].sessions).toBe(2);
  expect(hits()).toHaveLength(2);
  // one buzz, and the device is told about both in the same order it must apply
  expect(new Set(hits().map((h) => h.sessionId)).size).toBe(2);
});

test("the window is the WALL CLOCK's, not one started by the message", async () => {
  /* The reason the alignment matters at all: the app
   * server batches on the SAME boundary, so an aligned engine lands INSIDE its
   * window instead of starting a wait after it. Stacked waits cost twenty
   * seconds; aligned ones cost about ten.
   *
   * Sent at MID-window on purpose, because that is the only arrangement where
   * the two are distinguishable. A timer started by the message fires half a
   * window PAST the next boundary; an aligned one fires ON it. The old form of
   * this test sent at an arbitrary moment and passed by luck whenever the reply
   * happened to land near a boundary itself. */
  const period = batchMs();
  /* Stand exactly halfway through a window, wherever the previous test left the
   * clock: it is one clock for the whole file, so the phase is not assumed. */
  await core.clock.advance((period * 1.5 - (core.clock.now() % period)) % period);
  const sentAt = core.clock.now();
  expect(sentAt % period).toBe(period / 2);
  await say("nobody here");

  await core.clock.advance(period / 2 - 1); // one millisecond short of the boundary
  await settle();
  expect(sink().batches,
    "the window fired before its wall boundary").toHaveLength(0);

  await core.clock.advance(1); // and now we are standing on it
  await until(() => sink().batches.length === 1, { what: "the aligned window" });
  expect(core.clock.now() % period,
    `the flush landed ${core.clock.now() % period}ms into a ${period}ms window; ` +
    `the reply went out at ${sentAt % period}ms, so a timer started by the message ` +
    "would land about there and an aligned window lands on the boundary").toBe(0);
});

test("an empty window is not posted at all", async () => {
  // scheduleBatch is only armed by something being queued, and a flush with
  // nothing in it returns before it can spend a request on the app server
  await core.clock.advance(batchMs() * 3);
  await settle();
  expect(sink().batches).toHaveLength(0);
  expect(core.clock.pending).toBe(idlePending); // and no window timer is spinning
});

/* --------------------------------------------------------------- the ceiling */

test("a message held back by presence is announced once it passes the ceiling", async () => {
  /* THE 222. Measured over 32 hours of the real engine log (2026-08-02T00:00Z to
   * 2026-08-03T08:00Z): 222 messages were not pushed because "an app socket is
   * connected", 22 of them were never announced at all, and the median wait for
   * any push on the same chat was 27.7 minutes. Every one of those sockets was
   * UP, so no amount of fixing the disconnect path reaches them. This is what
   * reaches them, and it is the real TEN MINUTES, not a four second stand-in. */
  const c = core.client({ attach: null, visible: true });
  await holdOpen(c);
  await say("you never heard about this");
  expect(saidSomething("[notify] present")).toBe(true);
  await quietWindow();
  expect(hits()).toHaveLength(0); // suppressed, as his design says

  await core.clock.advance(ceilingMs() + ceilingTickMs());
  await until(() => sink().batches.length > 0, { what: "the ceiling's window" });
  expect(hits()).toHaveLength(1);
  // and the new decision says so, in one greppable line with its numbers
  const line = said().find((l) => l.includes("[notify] ceiling")) ?? "";
  expect(line).toContain("unread=1");
  expect(line).toContain("silent=");
});

test("the ceiling never fires for a chat he is looking at", async () => {
  /* The half of this that must not break. A backstop that buzzes him about the
   * message on his screen trades a silent miss for noise, and he would report
   * that within the hour. It cannot happen by construction: a chat he provably
   * watches is marked read, and a chat with no unread is not one the sweep can
   * fire for. This is that construction, asserted. */
  const c = core.client({ attach: wireId(PANE), visible: true });
  await say("he is reading this one");
  c.sock.data.lastFrame = core.clock.now() + 1;
  await core.clock.advance(200);
  expect(decision()).toContain("is watching");

  await core.clock.advance(ceilingMs() * 2);
  await settle();
  expect(saidSomething("[notify] ceiling")).toBe(false);
  expect(hits()).toHaveLength(0);
});

test("the sweep stops itself once nothing is waiting, so an idle engine keeps no timer", async () => {
  const c = core.client({ attach: null, visible: true });
  await holdOpen(c);
  await say("held");
  expect(core.clock.pending).toBeGreaterThan(idlePending); // the ceiling is armed

  await core.clock.advance(ceilingMs() + ceilingTickMs());
  await until(() => sink().batches.length > 0, { what: "the ceiling's window" });
  /* It fired, so nothing is being held any more, so the interval cancelled
   * itself. A ceiling timer that outlives its reason is a timer for every
   * session for ever. */
  await core.clock.advance(ceilingTickMs() * 2);
  await settle();
  expect(core.clock.pending).toBe(idlePending);
});

test("a sweep that SKIPS a chat with a banner up does not destroy its ceiling", async () => {
  /* SKIPPED, NOT SETTLED, and the difference is the whole of a bug. The sweep
   * used to clear silentSince as it skipped a chat whose banner already stood --
   * which DESTROYS the held message's ceiling, because the reason to skip goes
   * away (he reads it, the banner is dismissed) and by then the clock the
   * message was waiting on is gone and it can never be announced at all. */
  await say("the first one");          // nobody there: this one goes out
  await flushWindow();
  expect(hits()).toHaveLength(1);
  expect(session().notified).toBe(true); // a banner stands on the devices

  const c = core.client({ attach: null, visible: true }); // he opens the laptop
  await holdOpen(c);
  await say("held while a banner already stood");
  expect(session().silentSince).toBeDefined();
  const armedAt = session().silentSince!;

  // sweeps happen while the banner still stands: they must skip and keep looking
  await core.clock.advance(ceilingTickMs() * 3);
  expect(session().silentSince).toBe(armedAt);

  // he reads it on the phone, so the banner comes down. Nothing was settled.
  sendDismissal(session());
  expect(session().notified).toBe(false);
  expect(session().silentSince).toBe(armedAt);

  // ...and the held reply is still announced when ITS ceiling arrives
  const before = hits().length;
  await core.clock.advance(ceilingMs() + ceilingTickMs());
  await until(() => hits().length > before, { what: "the held message's ceiling" });
  expect(hits().at(-1)!.unread).toBe(2);
});

/* ----------------------------------------------------------- the decisions -- */

test("every decision is in the log, with a reason, and never a secret", async () => {
  // the reason this is a test and not a nicety: a notification that did not
  // arrive was undiagnosable, and diagnosing it meant buzzing a real phone
  const c = core.client({ attach: wireId(PANE), visible: true });
  c.sock.data.beatMs = 1_000;
  await say("explain yourself");
  await core.clock.advance(1_000 + 2_500);
  await flushWindow();

  // held, then sent, then what the app server said about the window it rode in
  expect(saidSomething("[notify] hold")).toBe(true);
  expect(said().some((l) => l.includes("[notify] send") && l.includes("why="))).toBe(true);
  expect(said().some((l) => l.includes("[notify] batch") && l.includes("accepted"))).toBe(true);
  // and the pong is recorded on every decision, trusted or not: it is the field
  // that answers "could a protocol pong be used as proof"
  expect(decision()).toContain("pong=");
  for (const l of said()) {
    expect(l).not.toContain("push.apple.com");
    expect(l).not.toContain("fcm.googleapis.com");
    expect(l).not.toContain(sink().enrolls[0] ?? "cyt_sink_never");
  }
});

test("the push bears the enrolled engine token", async () => {
  // a push without the token would be refused by the app server anyway, so the
  // batch path enrols rather than peeking: the bearer is the sink's own issue
  await say("with papers");
  await flushWindow();
  expect(sink().enrolls).toHaveLength(1);
  expect(sink().batches[0].auth).toBe(sink().enrolls[0]);
});

/* ------------------------------------------------------------ the sealed wire */

test("a sealed push wire body/title are the generic fallback, not the input text", async () => {
  /* A SEALED PUSH NEVER PUTS THE INPUT TEXT ON THE WIRE. The visible title/body
   * are the generic fallback the app already uses for a keyless push; the real
   * title/body/count are recoverable ONLY by opening `enc` with the session key. */
  const secret = `leak-check-${crypto.randomUUID()}`;
  await say(secret);
  await flushWindow();

  const hit = hits()[0];
  expect(hit).toBeDefined();
  expect(hit.body).toBe("New message");
  expect(hit.title).toBe("CallYourCode");
  expect(hit.body).not.toContain("leak-check");
  expect(hit.title).not.toContain("leak-check");
  expect(hit.kid).toBeTruthy();
  expect(hit.enc).toBeTruthy();

  // the input text really is inside the seal, and nowhere else
  const opened = await openSealed(hit);
  expect(opened.body).toBe(secret);
  expect(opened.count).toBe(1);
  // ...and the sealed TITLE is the resolved session name, not the fallback
  expect(opened.title).toBe("notify-harness");
});

test("a long reply is bounded INSIDE enc; the wire body stays the generic fallback", async () => {
  /* #537 F1. A notification body is a preview, not the whole reply: the app only
   * ever shows slice(0, 2000) and the lock screen far less, so a full assistant
   * message (a file dump can be tens of KB) is bytes nobody reads and, batched,
   * would cross the app server's POST cap and lose the window. The bound now
   * applies inside the seal, because the wire's visible body is the fallback. */
  const long = "L".repeat(5_000);
  await say(long);
  await flushWindow();

  const hit = hits()[0];
  expect(hit.body).toBe("New message");
  const opened = await openSealed(hit);
  expect(opened.body,
    "the sealed preview was not the bounded head of the reply").toBe(long.slice(0, 2_000));
});

test("a failed seal sends NOTHING AT ALL, never the reply in plaintext", async () => {
  /* Every engine mints a content generation at first boot, so the seal only fails
   * when the engine's own E2E state has been emptied. It must log it and send no
   * push: neither the reply text nor any fallback text may leave the wire. */
  const saved = core.e2e!.content;
  const secret = `seal-fail-${crypto.randomUUID()}`;
  try {
    core.e2e!.content = [];
    await say(secret);
    await flushWindow(); // the window IS attempted, even though nothing rides in it

    expect(hits()).toHaveLength(0);
    // the window carried no session at all: the item was dropped, not sent
    expect(sink().batches.every((b) => b.sessions === 0)).toBe(true);
    // and the failure was loud, not swallowed into a plaintext fallback
    expect(said().some((l) => l.includes("NOT SENT"))).toBe(true);
    for (const h of hits()) expect(h.body).not.toContain(secret);
  } finally {
    core.e2e!.content = saved;
  }
});

/* --------------------------------------------------------------- dismissal -- */

test("a chat read here takes its banner down there, and only if one is up", async () => {
  // The dismissal goes out even while an app is connected,
  // because a notification he read on the laptop must not sit on his phone.
  await say("read me");
  await flushWindow();
  expect(hits()).toHaveLength(1);
  expect(session().notified).toBe(true);

  sendDismissal(session());
  await flushWindow();
  expect(sink().dismissals).toHaveLength(1);
  expect(session().notified).toBe(false);

  // dismissing again has nothing standing on the phone to remove
  const before = sink().dismissals.length;
  await quietWindow();
  expect(sink().dismissals).toHaveLength(before);
});

test("a chat read INSIDE the window never buzzes at all", async () => {
  /* The queued banner and the dismissal for the same chat cancel: he read it
   * before the window closed, so there is nothing to show and nothing to take
   * down. One entry would be a buzz followed immediately by its own removal. */
  await say("read before the window closed");
  sendDismissal(session());
  await flushWindow();

  expect(hits()).toHaveLength(0);
  expect(sink().dismissals.map((d) => d.sessionId)).toEqual([`seam-host:${wireId(PANE)}`]);
});
