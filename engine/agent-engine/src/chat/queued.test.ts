/* WHAT A "not read yet" DIVIDER PROMISES, ACROSS A RESTART.
 *
 * WHY THIS FILE EXISTS
 *
 * `queued: true` on a user message means the message is sitting in claude's
 * input queue: typed into the pane, not yet taken into context. The app draws
 * one divider above the first such message and it reads "not read yet".
 *
 * The flag is persisted with the message. Everything that could clear it was
 * not: the awaitingQueue map is in-process, and the five-minute safety net was
 * a setTimeout closed over the send that armed it. Both die with the process.
 * So an engine restart within five minutes of a queued send stranded that flag
 * FOREVER, on a message the user had already been answered about, and no later
 * event could take the divider down again.
 *
 * That is not hypothetical. The real log carried four of them (message indexes
 * 254, 277, 412 and 587 of 1058 in one session), the youngest 2.7 days old.
 * The app was right; the data was wrong.
 *
 * WHAT IS ASSERTED. There are three ways a flag comes down and this file guards
 * all of them:
 *
 *   - LIVE (#456): a real reply for the session clears every earlier queued flag
 *     and pushes one `dequeued` per message, because claude cannot answer what it
 *     has not read. This is the fix for the report: a "Queued for" strip sitting
 *     ABOVE a newer reply, and two of them piled up in one chat.
 *   - THE DEADLINE, still armed: the safety net is a deadline rather than a
 *     closure now, so it fires and clears and tells the clients.
 *   - AT BOOT: the deadline and only the deadline, in both directions, because
 *     the cheap fix for a stuck flag is a vanishing one:
 *       - a queued message older than the safety net comes back NOT queued: the
 *         deadline the dead timer held still ran out. These are the four real ones.
 *       - a queued message inside that window comes back STILL queued: it is
 *         genuinely waiting, and the restart is not evidence about it.
 *
 * The BOOT sweep still does NOT infer from a later claude row, and that has a
 * test of its own: at boot the rapid-double-queue shape (a reply to the FIRST of
 * two while the SECOND still waits) is indistinguishable from a stale flag, so
 * it leans on the deadline. The LIVE path decides the other way ON PURPOSE.
 *
 * A restart here is what a restart is on the machine: the same agent record on
 * the same disk, a fresh wiring over it. Nothing about the flag is stubbed --
 * every one of them below was written by the real delivery path, into a real
 * chat log, through the real dispatcher.
 *
 * WHY THE OLD VERSION OF THIS FILE FAILED (three tests, 10s timeouts each): it
 * opened a plain WebSocket and sent `{t:"hello"}`, waiting for the sessions
 * frame that used to come back. Since #579 a raw-WS hello is answered
 * `transport-required` and the socket is closed -- the sealed DataChannel is the
 * only client wire -- so the frame could never arrive. The engine was right and
 * the test was speaking a retired transport. Here a client is a recorded Sock in
 * wire.ts's own client set, so the transport question does not arise.
 *
 *   bun test agent-engine/src/chat/queued.test.ts
 */

import { test, expect, afterAll, afterEach } from "bun:test";

import { wireCore, type WireCore, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { chatStore } from "../sessions/session-state.ts";
import { readChatLog, seedAgent } from "../test-utils/builders.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
/* The harness id the fake herdr reports for PANE: what the disk records
 * (meta.json sessionId, the chat log) are keyed by, never the pane id. */
const PANE_SID = defaultSessionIdOf(PANE);
import { until } from "../test-utils/wait.ts";
import { armQueueClear, QUEUE_STUCK_MS } from "./chatlog.ts";
import { onUtterance } from "./deliver.ts";
import { dispatchSessionFrame } from "../runtime/mcp.ts";
import type { ChatMsg } from "./chatmsg.ts";
import type { Sock } from "../transport/sock.ts";

/* THE PAUSE BETWEEN A BODY AND ITS ENTER, shortened for this file. 250ms is the
 * measured settle a real pane needs between send_text and the enter that
 * submits it; the fake pane needs none, and paying it per delivery is seconds
 * of wall clock for a number nothing here asserts. (delivery-guard.test.ts owns
 * the settle itself.) */
const priorSettle = process.env.DELIVER_SETTLE_MS;
process.env.DELIVER_SETTLE_MS = "5";
afterAll(() => {
  if (priorSettle === undefined) delete process.env.DELIVER_SETTLE_MS;
  else process.env.DELIVER_SETTLE_MS = priorSettle;
});

let core: WireCore | null = null;
afterEach(async () => {
  /* Every queued chat append on disk before the tmp tree goes: an append still
   * in flight when the directory is removed prints an ENOENT nobody can act on. */
  await chatStore.flush();
  await core?.stop();
  core = null;
});

/** The session's own MCP socket: how a real agent reply enters the log. */
function mcpSock(sessionId: string): Sock {
  return {
    data: { role: "session", sessionId, terms: new Map() },
    readyState: 1, remoteAddr: "127.0.0.1",
    send(s: string) { return s.length; }, close() { /* nothing holds it */ },
  } as unknown as Sock;
}

type Seeded = Record<string, unknown>;

/* A wiring on a WORKING pane, because "working" is the only state in which a
 * message really waits in claude's input queue: an idle pane takes it straight
 * into context and logs no queue-operation record at all (measured -- marking
 * everything queued left the divider up forever).
 *
 * `seed` writes an agent record BEFORE the wiring that reads it, which is what
 * a boot onto an existing log is. */
async function boot(seed?: Seeded[]): Promise<WireCore> {
  core = await wireCore({ agentStatus: "working", with: ["delivery", "frames"], start: !seed });
  if (seed) {
    await seedAgent(core.root, PANE_SID, seed);
    await core.reset({ start: true });
  }
  await until(() => !!core!.byHandle(PANE), { what: "the pane to reconcile" });
  return core;
}

/** The live chat row for a message, by its ts. */
const rowAt = (c: WireCore, ts: number): ChatMsg | undefined =>
  c.byHandle(PANE)!.chat.find((m) => m.ts === ts);

/** Send as the app does, and hand back the row it wrote (queued, on a busy pane). */
async function sendQueued(c: WireCore, client: FakeClient, text: string): Promise<ChatMsg> {
  await onUtterance(client.sock, { id: wireId(PANE), text });
  const msg = c.byHandle(PANE)!.chat.find((m) => m.role === "user" && m.text === text);
  if (!msg) throw new Error(`"${text}" never reached the chat log`);
  expect(msg.queued, `"${text}" was delivered to a BUSY pane and not marked queued`).toBe(true);
  return msg;
}

/** A restart: the same disk, a fresh wiring. Waits for the log to be persisted
 *  first, because a flag that never reached disk proves nothing about a boot. */
async function restart(c: WireCore, expectRows: number): Promise<void> {
  await until(async () => (await readChatLog(c.root, PANE_SID)).length >= expectRows,
    { what: `${expectRows} row(s) to reach the chat log on disk` });
  await c.reset({ start: true });
  await until(() => !!c.byHandle(PANE), { what: "the pane after the restart" });
}

/* PROOF (a) of the #456 build brief: a reply drains the strip LIVE.
 *
 * This is the report turned into a test. A queued user message, then a reply for
 * that session: the flag clears at once (not in five minutes), one `dequeued`
 * frame goes out so an open chat takes the strip down, and the cleared state is
 * on disk, so a restart brings back no flag. */
test("a reply clears the queued flag live and pushes one dequeued (#456)", async () => {
  const c = await boot();
  const watcher = c.client(); // an open chat: the dequeued frame is what it acts on
  const sent = await sendQueued(c, watcher, "does the divider ever come down");

  // the pane replies -- proof it read what was queued before the reply
  await dispatchSessionFrame(mcpSock(PANE), { t: "chat", text: "yes, and here is the answer" });

  expect(rowAt(c, sent.ts)!.queued,
    "a reply for this session did not clear the queued flag on the message it was " +
    "answering; the 'not read yet' strip lives on above a reply that proves it was " +
    "read -- his #456 screenshot 1").toBeUndefined();

  // and exactly one dequeued frame, naming that message, reached the open page
  const deqs = watcher.of("dequeued").filter((f) => f.id === wireId(PANE) && f.ts === sent.ts);
  expect(deqs.length,
    "the engine cleared the flag but sent no dequeued frame for it, so an app with this " +
    "chat open keeps the strip drawn until it reloads").toBe(1);

  // it stays cleared across a restart: the on-disk log carries no flag
  await restart(c, 2);
  expect(rowAt(c, sent.ts)?.queued,
    "the flag the reply cleared came back on the next boot, so the fix healed only the " +
    "running process and not the record").toBeUndefined();
});

/* PROOF (b): two queued, one reply after both -> both cleared, two dequeued
 * frames, in ts order. This is the never-two case at the source: the reply
 * drains the whole run in front of it, oldest first. */
test("a reply after two queued messages clears both, in ts order (#456)", async () => {
  const c = await boot();
  const watcher = c.client();
  const first = await sendQueued(c, watcher, "first: one of two in the queue");
  const second = await sendQueued(c, watcher, "second: the other one");

  await dispatchSessionFrame(mcpSock(PANE), { t: "chat", text: "answering both of these now" });

  expect(rowAt(c, first.ts)!.queued).toBeUndefined();
  expect(rowAt(c, second.ts)!.queued).toBeUndefined();
  expect(watcher.of("dequeued").filter((f) => f.id === wireId(PANE)).map((f) => f.ts),
    "a reply after two queued messages did not push exactly two dequeued frames in ts " +
    "order (oldest first)").toEqual([first.ts, second.ts]);
});

test("a reply does not clear a message queued AFTER it", async () => {
  /* The bound on the live clear, and the reason it is keyed on ts rather than
   * on "everything outstanding": a reply is evidence about what was in the
   * queue BEFORE it. A message typed a moment later is still genuinely
   * waiting, and clearing it would be the vanishing divider -- the same bug
   * facing the other way. */
  const c = await boot();
  const watcher = c.client();
  const before = await sendQueued(c, watcher, "asked before the reply");
  await dispatchSessionFrame(mcpSock(PANE), { t: "chat", text: "an answer" });
  const after = await sendQueued(c, watcher, "asked after the reply");

  expect(rowAt(c, before.ts)!.queued).toBeUndefined();
  expect(rowAt(c, after.ts)!.queued, "a reply cleared a message that arrived after it").toBe(true);
  expect(watcher.of("dequeued").map((f) => f.ts)).toEqual([before.ts]);
});

test("a message still waiting in the queue survives a restart", async () => {
  const c = await boot();
  const client = c.client();
  const sent = await sendQueued(c, client, "this one is genuinely still waiting");
  // no reply, and it is seconds old: the restart says nothing about it

  await restart(c, 1);
  expect(rowAt(c, sent.ts)?.queued,
    "a message that IS still sitting in claude's input queue lost its flag to the boot " +
    "sweep. The restart is not evidence about a message nothing has answered and nothing " +
    "has aged out, and the user is now told a message was read when it was not. A " +
    "vanishing divider is the same bug as a stuck one, facing the other way.").toBe(true);
});

test("the safety net's deadline survives the process that armed it", async () => {
  const now = Date.now();
  /* Two messages nothing ever answered, on either side of the five-minute
   * window. Only the timestamps differ, so anything that clears both or neither
   * is deciding on something other than the deadline. */
  const stale = { id: wireId(PANE), role: "user", text: "queued ten minutes before the crash",
    ts: now - 10 * 60_000, queued: true };
  const fresh = { id: wireId(PANE), role: "user", text: "queued moments before the crash",
    ts: now - 5_000, queued: true };
  const c = await boot([stale, fresh]);

  expect(rowAt(c, stale.ts)?.queued,
    "a message queued ten minutes ago, that nothing answered, came back queued. The " +
    "five-minute safety net had already expired for it; the only reason it did not fire " +
    "is that the process holding the timer went away, which is not a fact about the " +
    "message.").toBeUndefined();
  expect(rowAt(c, fresh.ts)?.queued,
    "a message queued five seconds ago was expired by the boot sweep. Its deadline has " +
    "four and a half minutes left to run and a restart does not consume it.").toBe(true);

  // and the clear reached DISK, or the next boot decides it all over again
  await until(async () => {
    const m = (await readChatLog(c.root, PANE_SID)).find((x) => x.ts === stale.ts);
    return m !== undefined && m.queued === undefined;
  }, { what: "the sweep's clear to be persisted as a patch line" });
});

/* THE BOOT RULE THAT ISN'T, still. The LIVE path clears on a reply (proofs a/b
 * above), but the BOOT sweep must NOT: "a later claude message means the queue
 * handed this one over" is false at boot, where the rapid-double-queue shape (a
 * reply to the FIRST of two while the SECOND still waits) cannot be told from a
 * genuinely-waiting message, and #456's live clear has already run for anything
 * that got a reply while the engine was up. So a flag that reaches disk WITH a
 * later claude row and is still inside its window is left to the deadline.
 * Seeded directly rather than sent, because sending a reply would trip the live
 * path this test exists to keep OUT of the boot sweep. */
test("the boot sweep does not clear a fresh queued flag under a later claude row", async () => {
  const now = Date.now();
  const waiting = { id: wireId(PANE), role: "user", text: "still genuinely waiting in the queue",
    ts: now - 5_000, queued: true };
  const later = { id: wireId(PANE), role: "claude", text: "a reply to something ELSE, mid-turn",
    ts: now - 2_000 };
  const c = await boot([waiting, later]);

  expect(rowAt(c, waiting.ts)?.queued,
    "the boot sweep cleared a five-second-old queued flag because a claude row existed " +
    "after it. That is the rapid-double-queue shape, and at boot it is indistinguishable " +
    "from a message genuinely still waiting: the deadline decides, not a later row. The " +
    "live #456 clear is a fact about a reply happening NOW, which the boot sweep never " +
    "saw.").toBe(true);
});

test("a queued message with no usable ts is kept, and the sweep says so", async () => {
  /* The engine always writes `ts`, so this is a log from another version or a
   * hand edit. It still may not lose a flag by accident: `now - undefined` is
   * NaN, which is not >= the deadline (so it counts as kept) and then used to
   * make setTimeout fire immediately (so it was cleared anyway). Both halves
   * were wrong, and the second one was silent because the first one had already
   * printed the reassuring number. */
  const dated = { id: wireId(PANE), role: "user", text: "an ordinary waiting message",
    ts: Date.now() - 5_000, queued: true };
  const undated = { id: wireId(PANE), role: "user", text: "no ts at all", queued: true };

  const said: string[] = [];
  const real = console.log;
  let c: WireCore;
  try {
    console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
    c = await boot([dated, undated]);
  } finally {
    console.log = real;
  }

  const kept = c!.byHandle(PANE)!.chat.find((m) => m.text === "no ts at all");
  expect(kept?.queued,
    "a queued message with no ts was unqueued at boot. Its age is unknowable, which is " +
    "not the same as expired, and NaN is not a reason to throw away the one piece of " +
    "state the user can see.").toBe(true);

  /* The LAST sweep line, not the first: seeding needs a wiring to own the tmp
   * tree, so the empty first boot sweeps an empty log before the seeded one
   * runs. The sweep under test is the one that read the seeded record. */
  const line = said.filter((l) => l.includes("[chat] queue sweep:")).at(-1);
  expect(line, "the boot sweep did not log at all").toBeDefined();
  expect(line,
    "the sweep counted the undated message as kept and then cleared it anyway, or counted " +
    `it as cleared. The log line is the only account of a boot-time decision on persisted ` +
    `user-visible state, so it has to match what happened: ${line}`)
    .toContain("cleared 0 past the deadline, kept 2 still waiting");
});

test("the re-armed deadline really fires: a stuck flag clears itself and says so", async () => {
  /* The half a boot-time assertion cannot reach. sweepRestoredQueued re-arms
   * the REMAINDER of a live deadline, and armQueueClear is what it re-arms; if
   * that path stopped clearing, a flag inside its window at every restart would
   * live forever and every test above would still be green. Armed with no delay
   * so the deadline is now rather than in five minutes -- the clamp is what
   * makes that legal (`[0, QUEUE_STUCK_MS]`).
   *
   * The deadline is armed on wireCore's MANUAL clock, so it fires when this
   * test says so rather than when the machine gets round to it. That is the
   * point of the seam: the real window is five minutes and no test may wait
   * one, and a clock that has to be advanced also proves the timer was armed
   * at all, which a real timer firing on its own does not. */
  const c = await boot();
  const watcher = c.client();
  const sent = await sendQueued(c, watcher, "nothing will ever answer this");
  watcher.clear();

  armQueueClear(wireId(PANE), sent.ts, 0);
  await c.clock.advance(0);
  await until(() => rowAt(c, sent.ts)!.queued === undefined,
    { what: "the safety net to clear the flag it was armed for" });
  expect(watcher.of("dequeued").map((f) => f.ts),
    "the deadline cleared the flag without telling the open chat, so the strip stays " +
    "drawn until a reload").toEqual([sent.ts]);

  // ...and a deadline for a message that is not queued any more changes nothing
  watcher.clear();
  armQueueClear(wireId(PANE), sent.ts, 0);
  await c.clock.advance(0);
  await until(() => true);
  expect(watcher.of("dequeued"), "a second firing pushed a dequeued for an unqueued row")
    .toEqual([]);
  expect(QUEUE_STUCK_MS, "the safety net's window is the five minutes the app was told about")
    .toBe(5 * 60 * 1000);
});

test("an IDLE pane's message is never marked queued at all", async () => {
  /* The other end of the lifecycle, and the reason `willQueue` reads s.busy. An
   * idle pane takes a message straight into context: there is no queue record
   * to match, so a flag set here would have nothing to clear it and would sit
   * over the message until the deadline. Measured on a real pane. */
  core = await wireCore({ agentStatus: "idle", with: ["delivery", "frames"] });
  const c = core;
  await until(() => !!c.byHandle(PANE), { what: "the pane to reconcile" });
  const client = c.client();
  await onUtterance(client.sock, { id: wireId(PANE), text: "straight into context" });
  await until(() => c.byHandle(PANE)!.chat.length === 1, { what: "the chat row" });
  expect(c.byHandle(PANE)!.chat[0].queued,
    "a message delivered to an IDLE pane was marked queued; nothing will ever dequeue it")
    .toBeUndefined();
  expect(client.of("chat").at(-1)!.queued).toBeUndefined();
});
