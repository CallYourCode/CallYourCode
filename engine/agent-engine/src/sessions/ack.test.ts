/* SPEAK/CHAT ARE ACKED ONLY WHEN THE ENGINE HAS THE MESSAGE DURABLY (#447).
 *
 * WHY THIS FILE EXISTS
 *
 * The speak/chat tools used to return "spoke"/"sent to the chat" the instant the
 * frame left the MCP's send buffer, before the engine had confirmed anything --
 * because the engine sent nothing to confirm. After a restart a socket could
 * hold a raw pane id with no session, every reply it carried died on onReply's
 * silent DROPPED return, and the agent's Stop hook was told it had spoken. That
 * is the memory "a tool ack is not delivery", verified at the engine tail page:
 * replies acked to the session that never reached the chat. Measured once at
 * ~25 minutes of his replies gone, 2026-08-09.
 *
 * The fix makes the ack mean THE ENGINE HAS LOGGED THE MESSAGE. onReply sends
 * {t:"said", ok, msgId, seq} after logChat and the broadcast; the tool waits for
 * it and errors with words that tell the agent to retry when it does not come.
 *
 * WHAT THIS FILE GUARDS, all at the engine's own socket, where the ack is minted
 * and where the ordering can be seen:
 *
 *   (a) THE ACK FOLLOWS THE LOG. The said ack carries msg.seq, and seq is
 *       stamped by logChat, so an ack with a number in it is proof the log write
 *       ran first. Move ackSaid above logChat and the seq is undefined.
 *   (b) THE DROP IS HONEST. A reply the engine has no session for is answered
 *       ok:false, not with silence, and NOTHING is persisted -- so the retry the
 *       failure asks for cannot double it.
 *   (c) THE ACK IS NOT BEHIND THE VOICE ENGINE (#speak-latency). It used to
 *       await synthesizeFirst, so the tool blocked on first-chunk TTS latency:
 *       seconds under load, ~80s on a backed-up kokoro.
 *
 * The bound the TOOL applies when no ack ever comes is a fact about the MCP
 * process, not about the engine, and lives in ack-tool.test.ts.
 *
 *   bun test agent-engine/src/sessions/ack.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { dispatchSessionFrame } from "../runtime/mcp.ts";
import { clients } from "../transport/wire.ts";
import type { Sock, SockData } from "../transport/sock.ts";
import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
/* The harness id the fake herdr reports for PANE: what the disk records
 * (meta.json sessionId, the chat log) are keyed by, never the pane id. */
const PANE_SID = defaultSessionIdOf(PANE);
import { readChatLog } from "../test-utils/builders.ts";
import { until, untilValue } from "../test-utils/wait.ts";

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

/* A SESSION SOCKET, WHICH IS NOT A CLIENT SOCKET.
 *
 * The MCP registers with role "session" and is deliberately NOT in wire.ts's
 * `clients` set: it is an output channel, not a device, so broadcasts do not go
 * to it. Building it here rather than reusing the rig's fakeClient() is the
 * point -- a session socket that received every broadcast would make "what did
 * the tool get back" unanswerable. */
function mcpSock(): { sock: Sock; frames: Record<string, any>[] } {
  const frames: Record<string, any>[] = [];
  const data = {
    role: "session", sessionId: null, attached: null, visible: false, visibleAt: 0,
    beatMs: 0, gaps: [], lastFrame: 0, pongAt: 0, probeAt: 0, probeSeq: 0, cid: 0,
    openedAt: 0, tailing: null, terms: new Map(), remoteAddr: "127.0.0.1",
  } as unknown as SockData;
  const sock = {
    data,
    readyState: 1,
    send(s: string) {
      try { frames.push(JSON.parse(s)); } catch { frames.push({ t: "<unparsable>", raw: s }); }
      return s.length;
    },
    close() {},
    remoteAddr: "127.0.0.1",
  } as unknown as Sock;
  return { sock, frames };
}

/** A wiring with the frame surface up, and an MCP registered on a pane id. */
async function registered(id: string): Promise<{
  c: WireCore; mcp: ReturnType<typeof mcpSock>;
}> {
  const c = await wireCore({ with: ["frames"] });
  core = c;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  const mcp = mcpSock();
  await dispatchSessionFrame(mcp.sock, {
    t: "register", id, name: "ack-probe", channels: ["speak", "chat", "show"],
  });
  expect(mcp.frames.map((f) => f.t), "the engine never acknowledged the register")
    .toContain("registered");
  return { c, mcp };
}

const said = (mcp: { frames: Record<string, any>[] }, msgId: string) =>
  mcp.frames.find((f) => f.t === "said" && f.msgId === msgId);

// -------------------------------------------------- (a) the ack follows the log

test("a chat tool's ack arrives only after the message is in the engine's log", async () => {
  const { c, mcp } = await registered(PANE);
  const msgId = crypto.randomUUID();
  const text = "the ack means this is written, not that it was sent";

  await dispatchSessionFrame(mcp.sock, { t: "chat", msgId, text });

  const ack = said(mcp, msgId)!;
  expect(ack, "the engine answered nothing at all").toBeDefined();
  expect(ack.ok, "the engine acked a chat it did not accept").toBe(true);
  expect(ack.msgId, "the ack did not echo the wire msgId, so the tool cannot correlate it")
    .toBe(msgId);
  /* THE ORDERING, AND THE MUTATION TARGET. seq is stamped by logChat; an ack
   * that carries a number is an ack issued after the log write. Move ackSaid
   * above logChat (ack early) and this seq is undefined. */
  expect(typeof ack.seq,
    "the said ack carries no seq, so it was issued before logChat stamped one. The tool would " +
    "be reporting success for a message the engine had not yet logged, which is the early ack " +
    "this whole change removes.").toBe("number");

  // the message really is in the log the ack promised, and with THAT seq
  const row = await untilValue(async () =>
    (await readChatLog(c.root, PANE_SID)).find((r: any) => r.text === text),
    { what: "the reply to reach the persisted chat log" }) as any;
  expect(row.seq, "the persisted message's seq does not match the one the ack carried")
    .toBe(ack.seq);
  expect(row.role).toBe("claude");
});

test("the reply reaches every device before the tool is told it worked", async () => {
  /* The ordering the ack is the end of: log, then broadcast, THEN ack. A tool
   * told "sent" about a message no device has seen is the same lie one step
   * further along. */
  const { c, mcp } = await registered(PANE);
  const cl = c.client();
  const msgId = crypto.randomUUID();

  await dispatchSessionFrame(mcp.sock, { t: "chat", msgId, text: "look at this" });

  expect(cl.of("chat").map((f) => f.text), "no device was told before the tool was")
    .toEqual(["look at this"]);
  expect(said(mcp, msgId)!.ok).toBe(true);
  // and the session socket is not on the broadcast list: it got the ack, not the fanout
  expect(mcp.frames.filter((f) => f.t === "chat"),
    "the MCP socket is in wire.ts's client set, so it receives every device's traffic")
    .toEqual([]);
  expect(clients.size, "the register put the session socket on the broadcast list").toBe(1);
});

// ------------------------------------------------------------ (b) the honest drop

test("a reply the engine has no session for is acked as failed, and nothing is logged", async () => {
  /* THE INCIDENT, at the tool's own seam. A socket that registered with a pane
   * herdr does not know is held open with no session; onReply used to drop its
   * replies on a silent return, and the tool reported success. Now the drop is
   * an ok:false ack, so the tool errors and the agent retries -- and nothing is
   * written, so a retry cannot double it. */
  const { c, mcp } = await registered("w9:not-a-real-pane");
  const msgId = crypto.randomUUID();
  const text = "this reply has nowhere durable to go";

  await dispatchSessionFrame(mcp.sock, { t: "chat", msgId, text });

  const ack = said(mcp, msgId)!;
  expect(ack, "the engine dropped the reply in silence, which is the exact failure this " +
    "change is about").toBeDefined();
  expect(ack.ok, "the engine acked a reply it dropped as if it had kept it").toBe(false);
  expect(String(ack.message), "the failure ack does not tell the agent to retry")
    .toMatch(/retry/i);
  expect(ack.seq, "a dropped reply was given a log sequence number").toBeUndefined();

  // NO GHOST: not under the pane it claimed, not under the real one, not on the wire
  for (const pane of ["w9:not-a-real-pane", PANE]) {
    expect((await readChatLog(c.root, pane)).some((r: any) => r.text === text),
      `the dropped reply was persisted under ${pane} anyway, so it IS half-present: a retry ` +
      "would now double it").toBe(false);
  }
  expect(c.byHandle(PANE)!.chat, "the dropped reply landed in the live session's log")
    .toEqual([]);
});

test("a reply addressed to a past session id routes to the agent that rolled", async () => {
  /* THE ROLLOVER DROP (2026-08-23, tmux lane). Claude mints a NEW session uuid
   * on the first message (and again on /clear); the voice MCP socket registered
   * under the OLD uuid and keeps addressing it. The row is keyed by the agent
   * id and the old uuid stays in the agent's index (pastSessions), so both a
   * socket that registered before the roll and a stale process registering with
   * the old uuid after it reach the same conversation, and nothing is dropped. */
  const uuidA = crypto.randomUUID();
  const uuidB = crypto.randomUUID();
  const c = await wireCore({ with: ["frames"], sessionIds: { [PANE]: uuidA } });
  core = c;
  await until(() => !!c.sessionOf(uuidA), { what: "the pane to reconcile" });
  const agentId = c.sessionOf(uuidA)!.id;
  // the MCP registers against the uuid claude gave it, exactly as on the Mac
  const mcp = mcpSock();
  await dispatchSessionFrame(mcp.sock, {
    t: "register", id: uuidA, name: "ack-probe", channels: ["speak", "chat"],
  });
  expect(mcp.frames.map((f) => f.t)).toContain("registered");
  expect(mcp.sock.data.sessionId, "the socket is held on the wire id, the agent id").toBe(agentId);
  const first = crypto.randomUUID();
  await dispatchSessionFrame(mcp.sock, { t: "chat", msgId: first, text: "before the roll" });
  expect(said(mcp, first)!.ok).toBe(true);

  // the rollover: a second fresh uuid on the same pane, socket still holds uuidA
  await c.herdr.rollSession(PANE, uuidB);
  await until(() => c.sessionOf(agentId)?.harnessSessionId === uuidB, { what: "the roll" });
  const msgId = crypto.randomUUID();
  const text = "spoken to the old uuid, owed to the same agent";
  await dispatchSessionFrame(mcp.sock, { t: "chat", msgId, text });

  const ack = said(mcp, msgId)!;
  expect(ack, "the engine answered nothing at all").toBeDefined();
  expect(ack.ok, "the reply from before the roll was dropped instead of routed").toBe(true);
  expect(typeof ack.seq, "the routed reply was acked without a log seq").toBe("number");
  expect(c.sessionOf(uuidB)!.chat.filter((m) => m.kind !== "system").map((m) => m.text),
    "the reply never reached the agent's conversation").toEqual(["before the roll", text]);

  // a STALE process (still reading its old env) registers with the past uuid
  const late = mcpSock();
  await dispatchSessionFrame(late.sock, {
    t: "register", id: uuidA, name: "ack-probe", channels: ["speak", "chat"],
  });
  expect(late.sock.data.sessionId, "a past session id did not resolve to its agent").toBe(agentId);
  const lateId = crypto.randomUUID();
  await dispatchSessionFrame(late.sock, { t: "chat", msgId: lateId, text: "late, by the old uuid" });
  expect(said(late, lateId)!.ok).toBe(true);
  expect(c.sessionOf(agentId)!.chat.filter((m) => m.kind !== "system").map((m) => m.text))
    .toEqual(["before the roll", text, "late, by the old uuid"]);
});

test("a pane handle reused by a fresh tmux server resolves to the new session, never the exited one", async () => {
  /* THE HANDLE-REUSE MISROUTE (2026-08-23, tmux lane). tmux hands out pane
   * handles per server generation: session A exits, the server dies with it,
   * and the NEXT server's first pane is %0 again. A's session is kept dead so
   * its history survives, but it still remembers the handle it died on, and
   * the late-resolve repaired a fresh pane's socket onto the EXITED session:
   * session B's replies rendered in A's conversation. Handle-keyed
   * resolutions must die with their pane; the dead record stays reachable by
   * its own id only. */
  const uuidA = crypto.randomUUID();
  const uuidB = crypto.randomUUID();
  const c = await wireCore({ with: ["frames"], sessionIds: { [PANE]: uuidA } });
  core = c;
  await until(() => !!c.sessionOf(uuidA), { what: "the pane to reconcile" });

  // A says something, so its session is KEPT (dead, history intact) later
  const mcpA = mcpSock();
  await dispatchSessionFrame(mcpA.sock, {
    t: "register", id: uuidA, name: "ack-probe", channels: ["speak", "chat"],
  });
  const lastWords = crypto.randomUUID();
  await dispatchSessionFrame(mcpA.sock, { t: "chat", msgId: lastWords, text: "session A's last words" });
  expect(said(mcpA, lastWords)!.ok).toBe(true);

  // the tmux server exits: the pane is gone, A stays listed dead
  await c.herdr.setAgentGone(PANE, true);
  await until(() => c.sessionOf(uuidA)?.alive === false, { what: "A to be marked dead" });

  // a voice-out socket registers while no such pane exists: held on the raw id
  const mcpB = mcpSock();
  await dispatchSessionFrame(mcpB.sock, {
    t: "register", id: wireId(PANE), name: "ack-probe", channels: ["speak", "chat"],
  });
  expect(mcpB.frames.map((f) => f.t)).toContain("registered");

  /* With the pane dead and not yet reused, its handle must resolve NOWHERE:
   * a handle names only the LIVE session on it, and A is dead (its binding was
   * marked dead with the pane). An honest drop, so the tool retries; routing
   * it would put the reply in an exited conversation. */
  const probe = crypto.randomUUID();
  await dispatchSessionFrame(mcpB.sock, { t: "chat", msgId: probe, text: "nobody's pane yet" });
  expect(said(mcpB, probe)!.ok,
    "a reply on a DEAD pane's handle was routed anyway, so a stale handle-keyed " +
    "resolution survived the pane").toBe(false);
  expect(c.sessionOf(uuidA)!.chat.map((m) => m.text),
    "the dead pane's reply landed in the exited session").toEqual(["session A's last words"]);

  // a fresh tmux server reuses the handle: a brand-new claude, same pane id
  await c.herdr.respawnSession(PANE, uuidB);
  await until(() => !!c.sessionOf(uuidB), { what: "B to reconcile onto the reused handle" });

  const msgId = crypto.randomUUID();
  const text = "spoken on the reused handle, owed to session B";
  await dispatchSessionFrame(mcpB.sock, { t: "chat", msgId, text });

  const ack = said(mcpB, msgId)!;
  expect(ack, "the engine answered nothing at all").toBeDefined();
  expect(ack.ok, "the reused handle's reply was dropped instead of routed to B").toBe(true);
  expect(c.sessionOf(uuidB)!.chat.map((m) => m.text),
    "the reply never reached the session that actually owns the handle now").toEqual([text]);
  expect(c.sessionOf(uuidA)!.chat.map((m) => m.text),
    "the reused handle late-resolved to the EXITED session: B's reply rendered in A's " +
    "conversation, which is the user-visible bug").toEqual(["session A's last words"]);
  expect(mcpB.sock.data.sessionId,
    "the repaired id was not cached on the socket").toBe(c.sessionOf(uuidB)!.id);
  expect(c.sessionOf(uuidB)!.id, "the reused handle joined the exited agent").not.toBe(c.sessionOf(uuidA)!.id);

  /* And the other direction: a reply still addressed to DEAD A's uuid must not
   * surface in B. It lands on A's own dead record (an exact-id lookup still
   * finds the kept history); B's conversation stays untouched. */
  const toDead = crypto.randomUUID();
  await dispatchSessionFrame(mcpA.sock, { t: "chat", msgId: toDead, text: "addressed to the dead uuid" });
  expect(c.sessionOf(uuidB)!.chat.map((m) => m.text),
    "a reply addressed to the exited session's uuid surfaced in the new session")
    .toEqual([text]);
});

test("a reply with no text at all is not logged and not acked as delivered", async () => {
  /* An empty reply is nothing to put in front of anybody. It must not become a
   * blank bubble, and it must not be counted as the reply the Stop hook was
   * waiting for. */
  const { c, mcp } = await registered(PANE);
  const msgId = crypto.randomUUID();

  await dispatchSessionFrame(mcp.sock, { t: "chat", msgId, text: "   " });

  expect(said(mcp, msgId), "an empty reply was acked as though it had been delivered")
    .toBeUndefined();
  expect(c.byHandle(PANE)!.chat, "an empty reply was written into the chat").toEqual([]);
});

// ---------------------------------------- (c) the ack is not behind the voice

test("a spoken reply is acked after the log and NOT after the voice engine", async () => {
  /* THE LATENCY FIX (#speak-latency). onReply used to await synthesizeFirst
   * before ackSaid, so the MCP speak tool blocked on first-chunk TTS latency --
   * seconds under load, and up to ~80s on a backed-up kokoro.
   *
   * The proof here is the wiring itself: wireCore's voice engine THROWS the
   * moment anything reaches for it. Under the old ordering the ack was parked
   * behind that call, so this reply would have been acked late, wrongly, or not
   * at all. It comes back ok, with a seq, and the row is on disk -- which can
   * only be true of an ack issued before synthesis was attempted.
   *
   * The run prints a loud "[speak] tts failed" from the background synthesis.
   * That is the refusal being demonstrated, not a fault: a speak whose TTS fails
   * still counts as a speak, because the words reached the app either way. */
  const { c, mcp } = await registered(PANE);
  const msgId = crypto.randomUUID();
  const text = "spoken, and confirmed only once it is in the log";

  await dispatchSessionFrame(mcp.sock, { t: "speak", msgId, text });

  const ack = said(mcp, msgId)!;
  expect(ack.ok, "the engine did not confirm a spoken reply it logged").toBe(true);
  expect(typeof ack.seq, "the spoken reply's ack carried no seq").toBe("number");

  const rows = await untilValue(async () => {
    const r = await readChatLog(c.root, PANE_SID);
    return r.some((x: any) => x.text === text) ? r : undefined;
  }, { what: "the spoken reply to reach the log" });
  expect(rows.some((r: any) => r.text === text), "the spoken reply never reached the log")
    .toBe(true);
});

test("a reply whose socket never registered is answered rather than ignored", async () => {
  /* The socket held open with no id at all. It is the same drop as the unknown
   * pane and it must be as loud: silence here is how a reply disappears while
   * the tool reports success. */
  const c = await wireCore({ with: ["frames"] });
  core = c;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  const mcp = mcpSock();
  const msgId = crypto.randomUUID();

  await dispatchSessionFrame(mcp.sock, { t: "chat", msgId, text: "nobody knows who I am" });

  const ack = said(mcp, msgId)!;
  expect(ack, "an unregistered socket's reply vanished in silence").toBeDefined();
  expect(ack.ok).toBe(false);
  expect(String(ack.message)).toMatch(/retry/i);
  expect(c.byHandle(PANE)!.chat).toEqual([]);
});
