/* ONE READ MARKER PER SESSION, AND THE COUNT IS A VIEW OF IT.
 *
 * The bug this exists to keep dead: `unread` was a counter of its own, bumped by
 * the notification decision and zeroed on attach, while `heardMsgId` was a
 * separate marker moved only by audio finishing. Two states, so the row, the
 * badge and read-aloud could each hold a different answer, and did.
 *
 * The seam: readstate + chatlog + notify over a real push sink and a MANUAL
 * clock, with the sessions frame as the wire. The old file booted an engine per
 * test and slept FORTY-TWO SECONDS waiting out grace windows, ceilings and push
 * windows; every one of those is now an advance() and nothing sleeps, at the
 * PRODUCTION numbers rather than env-shrunken ones.
 *
 * Every question is asked the same way -- what does the sessions frame say
 * `unread` is -- because if marking unread needed its own question asked a
 * different way, it would be the second state it is not.
 *
 *   bun test agent-engine/src/chat/unread.test.ts
 */

import { test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { wireCore, sessionsFrame, broadcastSessions, type WireCore, type WireCoreOpts,
  type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
/* The harness id the fake herdr reports for PANE: what the disk records
 * (meta.json sessionId, the chat log) are keyed by, never the pane id. */
const PANE_SID = defaultSessionIdOf(PANE);
import { metaForSession, readChatLog } from "../test-utils/builders.ts";
import { until, settle } from "../test-utils/wait.ts";
import { onChat, onHeard } from "./reply.ts";
import { onAttach, onProgress } from "./attach.ts";
import { markUnread, markAllRead } from "../sessions/readstate.ts";
import { batchMs, ceilingMs, ceilingTickMs } from "./notify.ts";
import { onPresenceChange, graceMs, stableMs } from "../sessions/presence.ts";
import { setNameOverride } from "../sessions/session-state.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import type { Sock } from "../transport/sock.ts";

/* The notify clocks are DELETED at file scope, not shrunk: with logical time
 * this file can afford the real 30s grace and the real 10 minute ceiling, and
 * clearing them means an ambient override cannot change what it proves. */
const priorEnv = {
  NOTIFY_BATCH_MS: process.env.NOTIFY_BATCH_MS,
  NOTIFY_CEILING_MS: process.env.NOTIFY_CEILING_MS,
  NOTIFY_CEILING_TICK_MS: process.env.NOTIFY_CEILING_TICK_MS,
  NOTIFY_GRACE_MS: process.env.NOTIFY_GRACE_MS,
  NOTIFY_STABLE_MS: process.env.NOTIFY_STABLE_MS,
};
for (const k of Object.keys(priorEnv)) delete process.env[k];

/* The engine's decision lines, swallowed unless SHOW_NOTIFY=1: this file makes
 * a lot of replies, and "which branch fired" is what you need when one fails. */
const lines: string[] = [];
const real = { log: console.log, warn: console.warn, error: console.error };
const grab = (through: (...a: unknown[]) => void) => (...a: unknown[]) => {
  lines.push(a.map((x) => String(x)).join(" "));
  if (process.env.SHOW_NOTIFY) through(...a);
};
const saidSomething = (needle: string) => lines.some((l) => l.includes(needle));

let core: WireCore;
const HOUR = 60 * 60_000;
/* delivery is in because one of the questions is what HIS OWN message does to
 * the marker, and the honest way to ask that is the real utterance path into the
 * real pane. The ask and context polls are pushed an hour out: this file
 * advances ten minutes of logical time and neither has an assertion here. */
const BASE: WireCoreOpts = {
  with: ["notify", "delivery", "frames"], askPollMs: HOUR, contextPollMs: HOUR,
};

beforeAll(() => {
  console.log = grab(real.log);
  console.warn = grab(real.warn);
  console.error = grab(real.error);
});
afterAll(() => {
  console.log = real.log;
  console.warn = real.warn;
  console.error = real.error;
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
/* A WIRING OF ITS OWN PER TEST, in its own tmp data dir. reset() re-boots over
 * the SAME dir, which is exactly what a restart is and what two tests below
 * want -- and exactly what the others must not have, because a restored chat log
 * and a restored marker from the previous test are the two things every count
 * here is computed from. */
beforeEach(async () => {
  core = await wireCore(BASE);
  await until(() => core.sessions.size === 1, { what: "the pane to reconcile" });
  lines.length = 0;
});
afterEach(async () => { await core.stop(); });

const sink = () => core.pushSink!;
const session = () => core.byHandle(PANE)!;

/* THE SESSIONS LIST AS A PAGE RECEIVES IT. The wire is the contract: a count
 * that only agrees with the marker inside the engine has not fixed anything.
 * This is the same projection broadcastSessions puts on every socket, and one
 * test below proves it really reaches a device that asked for nothing. */
function row(): Record<string, any> {
  const list = sessionsFrame().list as Array<Record<string, any>>;
  return list.find((s) => s.id === wireId(PANE))!;
}

function sessionSock(id = wireId(PANE)): Sock {
  return {
    data: {
      role: "session", sessionId: id, attached: null, visible: false, visibleAt: 0,
      beatMs: 0, gaps: [], lastFrame: 0, pongAt: 0, probeAt: 0, probeSeq: 0, cid: 0,
      openedAt: 0, tailing: null, terms: new Map(), remoteAddr: "127.0.0.1",
    },
    readyState: 1,
    send() {}, close() {}, remoteAddr: "127.0.0.1",
  } as unknown as Sock;
}

/** The agent answers, through the real reply path. Returns its wire msgId. */
async function say(text: string): Promise<string> {
  const msgId = crypto.randomUUID();
  await onChat(sessionSock(), { text, msgId });
  return msgId;
}

/** Read the chat the way a user who opens it and scrolls the bottom does, then
 *  go away again. Opening no longer marks read on its own (the pointer-pages
 *  brief, DECISIONS.md #3); the marker advances as the app REPORTS progress, and
 *  a seq far past the last clamps to the newest message. */
function openAndLeave(c: FakeClient): void {
  onAttach(c.sock, { id: wireId(PANE) });
  onProgress({ id: wireId(PANE), seq: 1e9 });
  c.attached(null);
}

async function holdOpen(c: FakeClient): Promise<void> {
  await core.clock.advance(stableMs());
  c.setVisible(true, core.clock.now());
}

/** The page ANSWERS the poke a reply triggers. Any frame stamped after the
 *  reply proves its javascript is running, which is the one thing a frozen page
 *  cannot fake, and it is what a real attached page does within milliseconds.
 *  Without it the decision stays parked in its proof wait and lands minutes
 *  later, in the middle of whatever the test does next. */
async function proves(c: FakeClient): Promise<void> {
  c.sock.data.lastFrame = core.clock.now() + 1;
  await core.clock.advance(200);
}

async function flushWindow(): Promise<void> {
  const before = sink().batches.length;
  await core.clock.advance(batchMs());
  await until(() => sink().batches.length > before, { what: "the window to reach the sink" });
}

/** Wait until this session's agent record AND its chat log are on disk, which
 *  is what a restart reads. Real files written by real timers: no logical time
 *  to advance, so this polls. */
async function onDisk(o: { heardTsAbove?: number } = {}): Promise<void> {
  await until(async () => {
    const meta = await metaForSession(core.root, PANE_SID);
    if (!meta?.read) return false;
    if (o.heardTsAbove !== undefined && !(meta.read.heardTs > o.heardTsAbove)) return false;
    const log = await readChatLog(core.root, PANE_SID);
    return log.length === session().chat.length;
  }, { what: "the agent record and its chat log to reach disk" });
}

/** Past every clock that could produce a push -- the grace, the ceiling and its
 *  sweep, and the window a push would ride out on -- with nothing expected to
 *  leave. The grace and the ceiling run CONCURRENTLY from the same message, so
 *  this is the longer of them rather than the sum. */
async function pastEveryClock(): Promise<void> {
  await core.clock.advance(Math.max(graceMs(), ceilingMs()) + ceilingTickMs() + batchMs());
  await settle();
}

/* ----------------------------------------------- the count IS the marker --- */

test("the count is the agent's messages after the marker, and nothing else", async () => {
  await say("one");
  await say("two");
  expect(row().unread).toBe(2);

  /* A DEVICE REPORTS PROGRESS through the first message. The marker moved, so
   * the count is what is LEFT after it, computed rather than stored. */
  const c = core.client({ attach: wireId(PANE) });
  onAttach(c.sock, { id: wireId(PANE) });
  onProgress({ id: wireId(PANE), seq: 0 });
  expect(row().unread).toBe(1);

  onProgress({ id: wireId(PANE), seq: 1e9 });
  expect(row().unread).toBe(0);
});

test("his own message is not something he has to read", async () => {
  /* Only the agent's messages count. His own are his, and session activity
   * (doneSeq) is a different signal that must never be added in. The utterance
   * goes through the REAL delivery path into the fake pane, so the row it writes
   * is the row the engine really writes. */
  const c = core.client({ attach: null });
  const { onUtterance } = await import("./deliver.ts");
  await onUtterance(c.sock, { id: wireId(PANE), text: "a question" });
  await until(() => core.submitted.length === 1, { what: "the pane to take the message" });
  expect(session().chat.some((m) => m.role === "user")).toBe(true);
  expect(row().unread).toBe(0);

  await say("an answer");
  expect(row().unread).toBe(1);
});

test("two replies in the same millisecond are both counted", async () => {
  /* The marker is a timestamp, so if two messages can share one, the second is
   * `ts > heardTs` false the moment the first is read: never counted, never
   * spoken, silently gone. No wait between the sends, which is the point. */
  await say("first");
  await say("second");
  const ts = session().chat.map((m) => m.ts);
  expect(new Set(ts).size).toBe(ts.length); // stampTs is strictly monotonic
  expect(row().unread).toBe(2);
});

test("the marker never rewinds: an old ack after a read does not re-light the row", async () => {
  const first = await say("older");
  await say("newer");
  const c = core.client({ attach: wireId(PANE) });
  onAttach(c.sock, { id: wireId(PANE) });
  onProgress({ id: wireId(PANE), seq: 1e9 }); // read through the end
  expect(row().unread).toBe(0);

  // a device that only NOW finishes playing the first reply
  onHeard({ id: wireId(PANE), msgId: first });
  expect(row().unread).toBe(0);
});

test("a session with unread waiting persists its marker, and a restart honours it", async () => {
  /* A session that has never been read must still be ON DISK, or the next boot
   * has no marker for it, takes the first-sight branch, and marks the backlog
   * read. The marker is written when the session is created, not when it moves. */
  await say("still waiting for you");
  expect(row().unread).toBe(1);

  /* Both halves have to be ON DISK before a restart can honour them, and both
   * are written by real timers of the engine's own (the meta save is debounced
   * 150ms; the chat log is appended on its own promise chain), so this waits on
   * the files rather than advancing logical time. The marker means nothing
   * without the log it points into, and they live together now. */
  await onDisk();
  const meta = await metaForSession(core.root, PANE_SID);
  expect(meta!.read!.heardTs).toBe(0); // never read: level, and said so on disk

  // A SECOND WIRING OVER THE SAME DATA DIR, which is what a restart is.
  await core.reset(BASE);
  await until(() => core.sessions.size === 1, { what: "the restarted pane" });
  expect(row().unread).toBe(1);
});

test("the count the engine puts on a push is the same count the row shows", async () => {
  await say("buzz");
  await say("buzz again");
  await flushWindow();

  const last = sink().hits.at(-1)!;
  expect(last.unread).toBe(row().unread);
  expect(last.unread).toBe(2);
});

test("one push per window, one row per chat: the push count EQUALS the row count", async () => {
  /* Three replies, one window, one buzz, and the number on it is the number on
   * the row. The app server never counts for itself: its own tally was a per-chat
   * +1 that only cleared on an explicit read, so the badge could only go up. */
  await say("a"); await say("b"); await say("c");
  await flushWindow();
  expect(sink().batches).toHaveLength(1);
  expect(sink().hits).toHaveLength(1);
  expect(sink().hits[0].unread).toBe(3);
  expect(row().unread).toBe(3);
});

test("marking it unread brings the count back, and the next broadcast keeps it", async () => {
  await say("the thing you have to come back to");
  const c = core.client({ attach: wireId(PANE) });
  openAndLeave(c);
  expect(row().unread).toBe(0);

  expect(markUnread(session())).toBe(true);
  broadcastSessions();
  expect(row().unread).toBe(1);

  /* AND IT SURVIVES THE NEXT LIST BROADCAST, which is the whole reason this
   * lives on the engine. A badge the page drew for itself is gone the moment
   * anything else makes the engine send the list again -- and something always
   * does. A rename is the cheapest way to make it send one. */
  setNameOverride(wireId(PANE), "still unread");
  broadcastSessions();
  expect(row().name).toBe("still unread"); // the broadcast really did happen
  expect(row().unread).toBe(1);
});

test("his other device is told, without asking", async () => {
  await say("read this on the phone");
  const phone = core.client({ attach: wireId(PANE) });
  openAndLeave(phone);

  // a device that is not doing anything: it holds a socket and keeps whatever
  // the engine broadcasts at it. "His tablet, in his pocket."
  const tablet = core.client({ attach: null });
  /* Its opening burst, the way a device that has just connected gets one.
   * broadcastSessions dedupes a payload that has not changed since the last one,
   * deliberately (herdr resnapshots on a poll), so a fresh socket learns the
   * current list from the hello burst rather than from the next broadcast. */
  core.hello(tablet);
  expect(tablet.last("sessions")!.list.find((s: any) => s.id === wireId(PANE)).unread).toBe(0);
  tablet.clear();

  markUnread(session());
  broadcastSessions();
  /* Nothing was sent from that socket between those two lines. The count on it
   * changed because the marker is one fact, held in one place. */
  expect(tablet.of("sessions")).toHaveLength(1);
  expect(tablet.last("sessions")!.list.find((s: any) => s.id === wireId(PANE)).unread).toBe(1);
});

test("it survives a restart, because it is the same marker in the same file", async () => {
  await say("come back to this one");
  openAndLeave(core.client({ attach: wireId(PANE) }));
  expect(markUnread(session())).toBe(true);

  await onDisk({ heardTsAbove: 0 });
  const meta = await metaForSession(core.root, PANE_SID);
  expect(meta!.read!.heardTs).toBeGreaterThan(0); // not "never read"

  await core.reset(BASE);
  await until(() => core.sessions.size === 1, { what: "the restarted pane" });
  expect(row().unread).toBe(1);
});

test("opening it clears it again, exactly like a real unread", async () => {
  await say("one more time");
  openAndLeave(core.client({ attach: wireId(PANE) }));
  markUnread(session());
  expect(row().unread).toBe(1);

  openAndLeave(core.client({ attach: wireId(PANE) }));
  expect(row().unread).toBe(0);
});

test("a message arriving in a chat he marked unread makes it two, not one and a flag", async () => {
  /* WHAT A NEW MESSAGE DOES, and the answer is "nothing special", which is the
   * point of there being no second fact: the new reply is simply the next
   * message after the marker, and the count says so. */
  await say("the first one");
  openAndLeave(core.client({ attach: wireId(PANE) }));
  markUnread(session());
  expect(row().unread).toBe(1);

  await say("and one that arrived after you marked it");
  expect(row().unread).toBe(2);
});

test("mark as read is the same marker, and it clears without opening the chat", async () => {
  await say("one");
  await say("two");
  expect(row().unread).toBe(2);
  expect(markAllRead(session())).toBe(true);
  expect(row().unread).toBe(0);
  // and it is idempotent: nothing moved, so the route would answer ok:false
  expect(markAllRead(session())).toBe(false);
});

test("a chat with nothing from the agent cannot be marked unread", async () => {
  /* Nothing of the agent's in the log means nothing the count could count, so
   * the route says it did not move rather than pretending. The app hides the
   * menu item on that answer instead of leaving one that looks broken. */
  expect(session().chat.filter((m) => m.role === "claude")).toHaveLength(0);
  expect(markUnread(session())).toBe(false);
  expect(row().unread).toBe(0);
});

test("marking it unread twice does nothing the second time", async () => {
  await say("filed");
  openAndLeave(core.client({ attach: wireId(PANE) }));
  expect(markUnread(session())).toBe(true);
  expect(markUnread(session())).toBe(false); // it is unread already
  expect(row().unread).toBe(1);
});

/* ------------------------------------------- mark unread meets the announce */

test("marking it unread never notifies, not even when his screen goes off", async () => {
  /* He is looking at the row he just tapped, and a banner about it would be the
   * app telling him news he made.
   *
   * AND THE TEST HAS TO PUT THE PHONE DOWN, which the first version of this did
   * not: it kept a page attached for the whole wait, and an attached page is the
   * one condition under which no push path can fire at all, so it passed with
   * the fix removed. The trigger is his screen going off, and the engine's own
   * logs record all three sockets dropping together with code=1006 when that
   * happens, so the socket is CLOSED here rather than merely backgrounded.
   *
   * There are TWO paths and the wait below is past both: the ceiling
   * (sweepCeiling, which needs silentSince) and the disconnect flush
   * (flushUnread, which needs only the count to be non-zero -- and that is the
   * one that fires). */
  const page = core.client({ attach: wireId(PANE), visible: true });
  await holdOpen(page);
  await say("the reply he read on his phone");
  await proves(page); // he is looking at it: suppressed, and marked read
  openAndLeave(page);
  expect(row().unread).toBe(0);
  const before = sink().hits.length;

  markUnread(session());
  page.close();
  onPresenceChange(); // the screen goes off, and every socket goes with it
  await pastEveryClock();

  expect(saidSomething("[notify] flush")).toBe(false);
  expect(saidSomething("[notify] ceiling")).toBe(false);
  expect(sink().hits).toHaveLength(before);
  // and it is still unread: nothing above cost him the badge either
  expect(row().unread).toBe(1);
});

test("a reply landing after the mark is announced, inside the grace", async () => {
  /* ...AND THE VERY NEXT REPLY MUST STILL GET THROUGH. The suppression has to
   * cover the message he filed and NOTHING ELSE. The first fix set the
   * notification flag, which has no expiry and which nothing clears when a
   * message arrives, so it went on silencing the chat for as long as it stayed
   * unread -- and the reply it silenced is the one he is waiting for.
   *
   * filedTs is a TIMESTAMP rather than a flag for exactly this: a later reply is
   * news again by arithmetic, with nothing to clear. */
  const laptop = core.client({ attach: wireId(PANE), visible: true });
  await holdOpen(laptop);
  await say("the one he read and filed");
  await proves(laptop);
  openAndLeave(laptop);
  markUnread(session());

  laptop.close();
  onPresenceChange(); // he puts the phone down: the grace starts
  await say("the answer he is actually waiting for");
  expect(saidSomething("[notify] holding")).toBe(true);

  await core.clock.advance(graceMs() + 1);
  expect(saidSomething("[notify] flush")).toBe(true);
  await flushWindow();
  const hit = sink().hits.at(-1)!;
  // it counts BOTH: the one he filed and the new one
  expect(hit.unread).toBe(2);
});

test("a reply landing after the mark is announced, with an app connected", async () => {
  /* The other arrangement: his laptop stays open on this chat's row but he is
   * not watching, so presence holds the reply and only the CEILING can save it.
   * The ceiling deliberately has no filed guard -- it cannot reach a filed chat
   * except after a new reply has been held for it, and that reply is past the
   * mark, which is exactly when it should fire. */
  const laptop = core.client({ attach: wireId(PANE), visible: true });
  await holdOpen(laptop);
  await say("the one he read and filed");
  await proves(laptop);
  openAndLeave(laptop); // and it leaves the chat: still at the app, not here
  markUnread(session());
  const before = sink().hits.length;

  await say("the answer he is actually waiting for");
  expect(saidSomething("[notify] present")).toBe(true);
  expect(session().silentSince).toBeDefined();

  await core.clock.advance(ceilingMs() + ceilingTickMs());
  await until(() => sink().hits.length > before, { what: "the ceiling to announce it" });
  expect(sink().hits.at(-1)!.unread).toBe(2);
});

const routeHttp: { srv: ServedRoutes | null } = { srv: null };
afterEach(() => { routeHttp.srv?.stop(); routeHttp.srv = null; });

function unreadRoute(): ServedRoutes {
  return (routeHttp.srv ??= serveRoutes({
    groups: [sessionOpsRoutes], ctx: { adapter: core.adapter },
  }));
}

async function post(id: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await unreadRoute().post(`/session/${encodeURIComponent(id)}/unread`, body);
  return { status: res.status, body: await res.json() as any };
}

test("the unread route: an id nobody has is a 404, and it says so in the envelope", async () => {
  const r = await post("w9:p9", { read: false });
  expect(r.status, "an unknown session answered as though it had moved something").toBe(404);
  expect(r.body.ok).toBe(false);
  expect(String(r.body.error)).toContain("no such session");
});

test("the unread route: a chat with nothing to file answers ok:false and broadcasts nothing",
  async () => {
    /* A session whose agent has never said anything cannot be marked unread --
     * there is no message to be unread OF -- and `ok: false` is how the app is
     * told that the row it just tapped did nothing. The broadcast is the other
     * half: a frame sent here would rearrange every other device for a change
     * that did not happen. */
    const page = core.client({ attach: wireId(PANE), visible: true });
    core.hello(page);
    const before = page.of("sessions").length;

    const r = await post(wireId(PANE), { read: false });
    expect(r.status).toBe(200);
    expect(r.body.ok, "an empty chat reported that it had been marked unread").toBe(false);
    expect(page.of("sessions").length,
      "nothing moved, and a sessions frame went out anyway").toBe(before);
    page.close();
  });

test("the unread route: filing a chat he has read moves the count and reaches the other device",
  async () => {
    /* THE REAL PATH, END TO END: two replies, read to the bottom, then the menu
     * row. What must come back is the count the row will show, and what must
     * reach the OTHER page is a sessions frame carrying the same number -- that
     * second page asked for nothing and is the whole reason this lives on the
     * engine. */
    const reader = core.client({ attach: wireId(PANE), visible: true });
    await holdOpen(reader);
    await say("the first answer");
    await say("the second answer");
    await proves(reader);
    openAndLeave(reader);
    expect(row().unread, "the chat was not actually read before it was filed").toBe(0);

    // a second device, watching the list and attached to nothing
    const other = core.client();
    core.hello(other);
    const before = other.of("sessions").length;

    const r = await post(wireId(PANE), { read: false });
    expect(r.body.ok, "a read chat with two answers in it could not be marked unread").toBe(true);
    expect(r.body.unread, "the route answers with the count the row is about to show").toBe(1);
    expect(typeof r.body.heardTs, "the route answers with the marker it just moved").toBe("number");
    expect(row().unread, "the sessions projection disagrees with what the route answered").toBe(1);

    const sent = other.of("sessions").slice(before);
    expect(sent.length,
      "the mark moved and no sessions frame reached the second device: the badge is on one " +
      "phone only").toBeGreaterThan(0);
    const seen = (sent.at(-1)!.list as any[]).find((s) => s.id === wireId(PANE));
    expect(seen.unread, "the broadcast carried a different count than the route answered").toBe(1);

    /* AND MARKING IT READ AGAIN MOVES IT BACK, through the same one route: `read`
     * is the only difference between the two menu rows. */
    const back = await post(wireId(PANE), { read: true });
    expect(back.body.ok, "marking a filed chat read moved nothing").toBe(true);
    expect(back.body.unread).toBe(0);

    // ...and doing it twice is honest about having done nothing the second time
    const again = await post(wireId(PANE), { read: true });
    expect(again.status).toBe(200);
    expect(again.body.ok,
      "a chat already read reported that reading it again had changed something").toBe(false);
    reader.close();
    other.close();
  });
