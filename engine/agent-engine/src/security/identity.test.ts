/* A CONVERSATION IS ITS AGENT, FOUND BY ITS CLAUDE SESSION ID, NOT THE PANE IT
 * HAPPENS TO BE ON.
 *
 * WHY THIS FILE EXISTS
 *
 * The engine used to identify a session by the herdr pane id. A pane id is
 * ephemeral: restart a claude session (or let it be reopened on a new pane) and
 * herdr mints a new one. Keyed on that, the conversation came back as a BRAND
 * NEW contact -- no photo, no name, an empty chat -- while the old row lingered
 * as an offline ghost nobody could dismiss. `claude --resume` keeps the session
 * uuid across the restart, so the uuid finds the agent (the row's stable id and
 * key) and the pane is just the current address for keystrokes.
 *
 * WHAT THIS GUARDS, and each is a way the old shape went wrong:
 *
 *   ONE ROW ACROSS A RESTART. The same claude session id arriving on a different
 *   pane re-attaches to the single existing row and adopts the new pane. It does
 *   not duplicate, and the pane it left behind does not survive as a ghost.
 *
 *   DELIVERY FOLLOWS THE PANE. A message sent to the conversation after the
 *   restart is typed into the NEW pane, never the dead one. This is the critical
 *   correctness bar: the whole point of a stable id is undone if the keystrokes
 *   still go to the pane the conversation used to be on.
 *
 *   THE VOICE MCP STILL FINDS ITS SESSION. The MCP knows only HERDR_PANE_ID, so
 *   registration resolves the pane to the session keyed by its stable id. If it
 *   did not, speak/chat/show would attach to nothing on every session whose id
 *   differs from its pane -- which, with real uuids, is every session there is.
 *
 * NO ENGINE PROCESS. wireCore performs server.ts's ordered boot in-process; the
 * fake herdr carries a claude session id that differs from the pane id (a real
 * uuid does), and `becomePane` moves that id onto a fresh pane the way a restart
 * does. Everything lives in a throwaway tmp root.
 *
 *   bun test agent-engine/src/security/identity.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { wireCore, type WireCore, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { metaForSession, readChatLog } from "../test-utils/builders.ts";
import { onUtterance } from "../chat/deliver.ts";
import { onRegister, onInfo } from "../runtime/mcp.ts";
import { sessionByHandle } from "../sessions/session-state.ts";

const P1 = PANE;      // the pane the conversation starts on
const P2 = "w1:p9";   // the pane a restart lands it on
/* A stable claude session id, distinct from either pane id, the way a real uuid
 * always is. This is the PUBLIC id the app and every route address it by. */
const U = "9f2c1a44-0b7e-4e11-9a11-6d2f0c9b7e31";

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

const listOf = (client: FakeClient): any[] => (client.last("sessions")?.list as any[]) ?? [];

/** What the fake pane actually received, per pane: the only honest place to ask
 *  where the keystrokes went. */
const submittedTo = (c: WireCore, pane: string, needle: string) =>
  c.submitted.some((s) => s.pane === pane && s.text.includes(needle));

async function start(): Promise<WireCore> {
  core = await wireCore({ sessionIds: { [P1]: U }, with: ["delivery", "frames"] });
  await until(() => !!core!.sessionOf(U), { what: "the session to come up under its stable id" });
  return core;
}

test("a restart onto a new pane stays one session, and delivery follows the pane", async () => {
  const c = await start();
  const client = c.client();
  c.hello(client); // the opening burst a fresh page gets

  // The session exists under its STABLE id, not the pane it is on; the uuid
  // is the attribute the restart will carry.
  const agentId = c.sessionOf(U)!.agentId;
  expect(listOf(client).map((s) => s.id), "a row was keyed on the ephemeral pane id, which is the "
    + "ghost this change removes").toEqual([agentId]);
  expect(listOf(client)[0].harnessSessionId).toBe(U);
  expect(c.sessionOf(U)!.muxHandle).toBe(P1);

  // A message before the restart is typed into the live pane, P1.
  await onUtterance(client.sock, { id: agentId, text: "before restart" });
  await until(() => submittedTo(c, P1, "before restart"),
    { what: "the first message to reach the live pane" });

  // THE RESTART: the same claude session id comes back on a different pane.
  await c.herdr.becomePane(P1, P2);
  await until(() => c.sessionOf(U)?.muxHandle === P2,
    { what: "the session to adopt the pane the restart landed on" });

  // Still exactly one session: same id, alive, no ghost for either pane id.
  const list = listOf(client);
  expect(list.map((s) => s.id), "the conversation duplicated across the restart").toEqual([agentId]);
  expect(list[0].alive).toBe(true);
  expect(list[0].harnessSessionId).toBe(U);
  expect(c.sessionOf(U)!.agentId, "the restart minted a new identity").toBe(agentId);

  // AND DELIVERY FOLLOWS THE PANE: a message now types into P2, never the dead P1.
  await onUtterance(client.sock, { id: agentId, text: "after restart" });
  await until(() => submittedTo(c, P2, "after restart"),
    { what: "the message to follow to the new pane" });
  expect(submittedTo(c, P1, "after restart"),
    "the message was typed into the pane the conversation had already left").toBe(false);
});

test("the conversation, its name-resolution inputs and its stable identity all cross the restart",
  async () => {
    /* One row on the wire is not the whole claim. The chat has to be the same
     * chat, the stable agent id has to be the same id, and the agent record on
     * disk has to be the same record: a restart that produced a fresh identity
     * would look right until the next boot and then find nothing. */
    const c = await start();
    const client = c.client();
    await onUtterance(client.sock, { id: c.sessionOf(U)!.id, text: "said before the restart" });
    await until(() => c.sessionOf(U)!.chat.some((m) => m.text === "said before the restart"),
      { what: "the message to reach the conversation log" });
    const agentId = c.sessionOf(U)!.agentId;

    await c.herdr.becomePane(P1, P2);
    await until(() => c.sessionOf(U)?.muxHandle === P2, { what: "the pane move" });

    const s = c.sessionOf(U)!;
    expect(s.agentId, "the restart minted a new stable identity").toBe(agentId);
    expect(s.chat.some((m) => m.text === "said before the restart"),
      "the restart emptied the conversation").toBe(true);
    expect(s.harnessSessionId, "the stable id and the claude session id parted company").toBe(U);
    expect(s.cwd, "the restarted pane reports the conversation's own working directory")
      .toBe(c.sessionOf(U)!.cwd);

    await until(async () => (await metaForSession(c.root, U))?.agentId === agentId,
      { what: "the agent record on disk" });
    expect((await metaForSession(c.root, U))!.sessionId).toBe(U);
    await until(async () =>
      (await readChatLog(c.root, U)).some((m) => m.text === "said before the restart"),
      { what: "the conversation log on disk" });
  });

test("the voice MCP registers by its PANE id and is resolved to the stable session, before and after",
  async () => {
    /* The MCP is born inside the pane and knows HERDR_PANE_ID and nothing else.
     * With a uuid-keyed session that pane id matches no session key at all, so
     * the resolution has to go through the mux handle. If it did not, speak /
     * chat / show would attach to nothing on every real session there is. */
    const c = await start();
    const mcp = c.client();

    onRegister(mcp.sock, { id: P1, name: "probe", channels: ["speak", "chat"] });
    expect(mcp.last("registered"), "the MCP was never acked").toBeDefined();
    expect(mcp.sock.data.sessionId,
      "the MCP registered by its pane id but was not resolved to its session").toBe(c.sessionOf(U)!.id);
    expect(c.sessionOf(U)!.ws, "the session did not adopt the MCP's socket").toBe(mcp.sock);
    expect(c.sessionOf(U)!.channels).toEqual(["speak", "chat"]);

    // After the restart the MCP is a NEW process in a NEW pane, and the same
    // resolution has to land it on the same conversation.
    await c.herdr.becomePane(P1, P2);
    await until(() => c.sessionOf(U)?.muxHandle === P2, { what: "the pane move" });

    const mcp2 = c.client();
    onRegister(mcp2.sock, { id: P2, name: "probe", channels: ["speak"] });
    expect(mcp2.sock.data.sessionId,
      "the restarted MCP's pane id did not resolve to its conversation").toBe(c.sessionOf(U)!.id);
    expect(c.sessionOf(U)!.ws).toBe(mcp2.sock);
    // and the handle lookup the resolution rides on agrees
    expect(sessionByHandle(P2)!.id).toBe(c.sessionOf(U)!.id);
    expect(sessionByHandle(P1), "the abandoned pane still resolves to a session").toBeUndefined();
  });

test("an MCP on a pane herdr does not know is acked but creates no session", async () => {
  /* The negative that keeps the pane id from being a back door into the session
   * list. A stale MCP process, a claude running outside herdr, a subagent that
   * inherited HERDR_PANE_ID: each registers with an id nothing lists, and each
   * gets an ack so its speak still resolves -- and none of them may conjure a
   * row. herdr is the source of truth about what a session is. */
  const c = await start();
  const stray = c.client();
  const before = [...c.sessions.keys()];

  onRegister(stray.sock, { id: wireId("w7:p7"), name: "a stray", channels: ["speak"] });

  expect(stray.last("registered"), "a stray MCP was left unanswered").toBeDefined();
  expect([...c.sessions.keys()], "an unlisted pane id created a session row").toEqual(before);
  expect(stray.sock.data.sessionId, "the stray holds its own raw id, not somebody else's session")
    .toBe("w7:p7");
});

test("the info frame answers the registered connection's stable agent id", async () => {
  /* The MCP `info` tool: the engine, not env, says WHO the agent on a
   * connection is. The socket registered with only its pane id; the answer
   * carries the stable agent id every explicit-id cyc command takes. */
  const c = await start();
  const mcp = c.client();
  onRegister(mcp.sock, { id: P1, name: "probe", channels: ["speak", "chat"] });

  onInfo(mcp.sock, { reqId: "r1" });

  const m = mcp.last("info") as any;
  expect(m, "the info frame was never answered").toBeDefined();
  expect(m.reqId).toBe("r1");
  expect(m.ok).toBe(true);
  expect(m.agentId, "the answer must carry the session's stable agent id")
    .toBe(c.sessionOf(U)!.agentId);
  expect(m.cwd).toBe(c.sessionOf(U)!.cwd);
  expect(m.harness).toBe(c.sessionOf(U)!.agent.id);
});

test("info resolves FRESH: a socket that registered before its pane was a session", async () => {
  /* A hand-started pane's MCP can register while herdr has not reported the
   * pane yet; the socket then holds its raw pane id. Once the pane IS a live
   * session, info must still find the agent by re-running the pane -> handle
   * resolution, not answer from the stale register-time miss. */
  const c = await start();
  const early = c.client();
  onRegister(early.sock, { id: P2, name: "early", channels: ["speak"] });
  expect(early.sock.data.sessionId, "precondition: the register was a miss").toBe(P2);

  onInfo(early.sock, { reqId: "r0" });
  expect((early.last("info") as any).ok, "an unresolvable connection must say so").toBe(false);

  await c.herdr.becomePane(P1, P2); // now P2 IS the conversation's pane
  await until(() => c.sessionOf(U)?.muxHandle === P2, { what: "the pane move" });

  onInfo(early.sock, { reqId: "r2" });
  const m = early.last("info") as any;
  expect(m.reqId).toBe("r2");
  expect(m.ok).toBe(true);
  expect(m.agentId).toBe(c.sessionOf(U)!.agentId);
});

test("two panes carrying two uuids are two conversations, and a restart moves only one", async () => {
  /* The isolation check. Pane identity is not identity, but neither is it
   * nothing: with two live conversations, a restart that resolved by "the pane
   * that changed" rather than by the uuid could move the wrong row, and the
   * symptom would be one chat's messages appearing in the other. */
  const OTHER = "1b4d3f9a-5555-4eee-8fff-000000000005";
  core = await wireCore({
    panes: [P1, "w1:p2"], sessionIds: { [P1]: U, "w1:p2": OTHER }, with: ["delivery", "frames"],
  });
  const c = core;
  await until(() => !!c.sessionOf(U) && !!c.sessionOf(OTHER), { what: "both conversations" });
  const client = c.client();

  await onUtterance(client.sock, { id: c.sessionOf(OTHER)!.id, text: "belongs to the other conversation" });
  await until(() => c.sessionOf(OTHER)!.chat.length > 0, { what: "the other conversation's row" });

  await c.herdr.becomePane(P1, P2);
  await until(() => c.sessionOf(U)?.muxHandle === P2, { what: "the restart" });

  expect(c.sessionOf(OTHER)!.muxHandle, "the restart moved the wrong conversation's pane")
    .toBe("w1:p2");
  expect(c.sessionOf(U)!.chat, "the restarted conversation adopted its neighbour's chat")
    .toEqual([]);
  expect(c.sessionOf(OTHER)!.chat.map((m) => m.text))
    .toEqual(["belongs to the other conversation"]);
  expect(listOf(client).map((s) => s.id).sort())
    .toEqual([c.sessionOf(OTHER)!.id, c.sessionOf(U)!.id].sort());
  expect(listOf(client).map((s) => s.harnessSessionId).sort()).toEqual([OTHER, U].sort());
});
