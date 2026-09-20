/* THE ENGINE SURVIVES A HARNESS SESSION-ID ROLLOVER. (#571, adapters lane 2.)
 *
 * WHY THIS FILE EXISTS
 *
 * A claude process can change its session uuid WITHOUT dying: /clear, a fork,
 * a --resume, auto-compaction. Same pid, same shells, same pane, a new
 * agent_session. herdr reports the same pane with a new uuid while the old one
 * is still alive. On 2026-08-16 at 11:47 the engine treated such a flip as a
 * brand-new session: it seeded the newcomer, delisted the old conversation
 * (4235 rows), and the row the user was looking at vanished mid-use.
 *
 * WHAT HOLDS NOW: the row is keyed by the AGENT id, and a harness session id
 * is an attribute of it. A roll changes the attribute and nothing else: the
 * Session object, its chat, its wire id and its on-disk record all stay; the
 * old id joins `pastSessions`, so a later --resume of it finds the same agent
 * through the session index; and a system row records the roll in the chat.
 * There is no re-key, no carry frame, no pin and no heal, because nothing is
 * ever moved. Identity is decided by session ids (the index) first, then by
 * the pane (an unknown id on a pane a live agent holds joins that agent), and
 * only a fresh id on an unbound pane is a new agent.
 *
 * NO ENGINE PROCESS. wireCore performs server.ts's own ordered boot in-process
 * over a FakeHerdr on a unix socket and a REAL MuxAdapter, so the reconcile
 * and carry.ts's adoptSession are the shipped code. `rollSession` flips a
 * pane's agent_session from one uuid to another with the pane never leaving
 * the snapshot; `respawnSession`, after the old session is marked dead by
 * setAgentGone, brings the pane back under a new uuid (a clean exit then a
 * fresh start); a reset() in the same dirs is a restart.
 *
 * THE NEGATIVES ARE THE POINT. A wrong answer here is silent -- a chat that
 * loses its history, or a new agent that inherits somebody else's -- so the
 * clean exit that must NOT inherit and the dead binding that must NOT join
 * are tested at least as hard as the joins.
 *
 *   bun test agent-engine/src/sessions/rollover.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";

import { wireCore, type WireCore, type FakeClient } from "../test-utils/wire-core.ts";
import { PANE, HARNESS_CWD } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { seedAgent, readChatLog, metaForSession, readAgentMetas } from "../test-utils/builders.ts";
import { onUtterance } from "../chat/deliver.ts";
import { dispatchClientFrame } from "../transport/frames.ts";

// Two distinct uuids on one pane: the conversation's id before and after the
// roll. Both differ from the pane id, as real ones always do.
const U1 = "347a76f6-1111-4aaa-8bbb-000000000001";
const U2 = "91b7380e-2222-4ccc-8ddd-000000000002";

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

/** The layers a rollover question needs: the session graph, the ONE delivery
 *  path (so a conversation exists to be kept or stolen) and the client frame
 *  surface (so "navigate away and back" is a real attach). */
const LAYERS = ["delivery", "frames"] as const;

/* WAITING FOR THE ENGINE TO HAVE SEEN SOMETHING AND DONE NOTHING.
 *
 * Every positive here has an observable (a row changed, a frame went out). The
 * negatives do not, and a negative asserted too early passes for the wrong
 * reason -- it is green while the snapshot is still in flight. So this
 * subscribes to the SAME adapter.onAgents the reconcile is on, registered after
 * it, which means a tick of this counter is proof the reconcile for that very
 * snapshot has already run to completion. */
function snapshots(c: WireCore) {
  let n = 0;
  c.adapter.onAgents(() => { n++; });
  return {
    get n() { return n; },
    async reach(target: number): Promise<void> {
      await until(() => n >= target, { what: `${target} reconciled herdr snapshots (saw ${n})` });
    },
  };
}

/** Get a real conversation going on `id`: the client frame, the delivery guard,
 *  the pane, and the chat row it writes back. */
async function converse(c: WireCore, id: string, text: string): Promise<void> {
  const client = c.clients[0] ?? c.client();
  // the wire id is the AGENT id; a test may name the row by either
  const wireId = c.sessionOf(id)!.id;
  await onUtterance(client.sock, { id: wireId, text });
  await until(() => (c.sessionOf(id)?.chat ?? []).some((m) => m.text === text),
    { what: `"${text}" to reach ${id}'s conversation log` });
}

/** Navigate away and back: a FRESH page attaches to `id` and reads the pages
 *  the attach answer carries. The only honest way to ask whether a conversation
 *  survived, because it re-reads the log rather than the open chat. */
async function attachedTexts(c: WireCore, id: string): Promise<string[]> {
  const page = c.client();
  const wireId = c.sessionOf(id)?.id ?? id;
  await dispatchClientFrame(page.sock, { t: "attach", id: wireId, since: 0 });
  const ok = await until(() => page.last("attach-ok") !== undefined,
    { what: `an attach-ok for ${id}` }).then(() => page.last("attach-ok")!);
  return ((ok.pages as any[]) ?? []).flatMap((p) => (p.messages ?? []).map((m: any) => String(m.text)));
}

/** Every row a client's newest sessions frame holds, by id. */
const listOf = (client: FakeClient): any[] => (client.last("sessions")?.list as any[]) ?? [];

/** The system rows a chat holds (what the roll writes). */
const systemTexts = (c: WireCore, id: string): string[] =>
  (c.sessionOf(id)?.chat ?? []).filter((m) => m.kind === "system").map((m) => m.text);

test("a live pane whose uuid rolls keeps the whole conversation on the same row", async () => {
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: [...LAYERS] });
  await until(() => !!core!.sessionOf(U1), { what: "the U1 conversation to come up" });
  const client = core.client();
  await converse(core, U1, "keep this conversation across the roll");
  const row = core.sessionOf(U1)!;
  const agentId = row.agentId;
  expect(row.id, "the wire id IS the agent id").toBe(agentId);
  expect(row.harnessSessionId).toBe(U1);

  // The roll: same live pane, agent_session goes U1 -> U2, process never dies.
  await core.herdr.rollSession(PANE, U2);
  await until(() => core!.sessionOf(agentId)?.harnessSessionId === U2, { what: "the roll to be adopted" });

  // The SAME row (the reconcile mints a fresh Session object per poll, so
  // sameness is the key): the open chat rides across untouched, the pane is
  // still the same pane, and nothing changed on the wire but the attribute.
  const after = core.sessionOf(agentId)!;
  expect(after.id).toBe(agentId);
  expect(after.chat.some((m) => m.text === "keep this conversation across the roll")).toBe(true);
  expect(after.muxHandle).toBe(PANE);
  expect(after.alive).toBe(true);
  expect(core.sessions.size, "one row, no ghost under either uuid").toBe(1);
  expect(core.sessionOf(U1)?.id, "the old uuid still names the same conversation (a --resume of it must land here)").toBe(agentId);
  expect(core.sessionOf(U2)?.id).toBe(agentId);

  // The app sees one row under one id, before and after.
  const mine = listOf(client);
  expect(mine.map((s) => s.id)).toEqual([agentId]);
  expect(mine[0].harnessSessionId).toBe(U2);
  expect(mine[0].alive).toBe(true);
  expect(client.of("session-id-changed"), "there is no re-key frame: the id never changed").toEqual([]);

  // A plain rollover is same-conversation churn: no chat pill (owner call
  // 2026-09-08). The roll is still adopted and recorded in engine.log.
  expect(systemTexts(core, agentId)).toEqual([]);

  // NAVIGATE AWAY AND BACK: a fresh page on the agent id still finds the
  // message. This is the #571 data-loss bar, read back off the log.
  expect(await attachedTexts(core, agentId)).toContain("keep this conversation across the roll");
});

test("the rolled conversation keeps its identity on disk: one record, old uuid in pastSessions", async () => {
  /* A roll that produced the right rows under a BRAND NEW agent record would
   * look right on the wire for one session and then find no history at the
   * next boot, so the on-disk identity is asserted directly. */
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: [...LAYERS] });
  await until(() => !!core!.sessionOf(U1), { what: "the U1 conversation" });
  await converse(core, U1, "identity rides along");
  const before = core.sessionOf(U1)!.agentId;

  await core.herdr.rollSession(PANE, U2);
  await until(() => core!.sessionOf(before)?.harnessSessionId === U2, { what: "the roll" });

  // On disk: ONE agent record, now answering to U2, remembering U1. adoptSession
  // flushes at once, so this is on disk before the debounce would have fired.
  const meta = await until(async () => (await metaForSession(core!.root, U2))?.agentId === before,
    { what: "the rolled record to reach disk" })
    .then(() => metaForSession(core!.root, U2));
  expect(meta!.sessionId).toBe(U2);
  expect(meta!.pastSessions, "the rolled-from uuid was not remembered").toEqual([U1]);
  expect(meta!.harness).toBe("claude");
  expect(meta!.cwd).toBe(HARNESS_CWD);
  expect((await readAgentMetas(core.root)).size, "no second record was minted for the roll").toBe(1);
  expect(await readChatLog(core.root, U2)).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "identity rides along" })]));

  // And the next boot finds the same agent under BOTH ids.
  await core.reset({ sessionIds: { [PANE]: U2 } });
  await until(() => !!core!.sessionOf(U2), { what: "the row after a restart" });
  expect(core.sessionOf(U2)!.agentId).toBe(before);
  expect(core.sessionOf(U1)!.agentId, "the past id still indexes to the agent after a restart").toBe(before);
  expect(core.sessionOf(U2)!.chat.some((m) => m.text === "identity rides along")).toBe(true);
});

test("a guessed id is held for the announce grace, and adopted by the SAME row when it passes", async () => {
  /* herdr's `herdr:claude` source is a guess (the newest transcript in the
   * cwd), not an announce. A guess is not identity: for ANNOUNCE_GRACE_MS from
   * first sight the pane's id is treated as unknown, so a transient claude
   * born in the same cwd cannot become the pane's identity before the hook
   * speaks. When the grace passes with no announce, the guess is adopted by
   * the row that was already there, never by a second agent. */
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: [...LAYERS], announceGraceMs: 10_000 });
  const snaps = snapshots(core);
  await snaps.reach(snaps.n + 1);
  await until(() => !!core!.byHandle(PANE), { what: "the pane's row" });
  const row = core.byHandle(PANE)!;
  expect(row.harnessSessionId, "a guess inside the grace is not adopted").toBeNull();
  expect(core.sessionOf(U1), "the guessed uuid names nobody yet").toBeUndefined();

  core.clock.advance(10_001);
  await core.herdr.rollSession(PANE, U1); // the same snapshot again, past the grace
  await until(() => core!.byHandle(PANE)?.harnessSessionId === U1, { what: "the guess to be adopted" });
  expect(core.byHandle(PANE)?.id, "the same row adopted it").toBe(row.id);
  expect(core.sessions.size).toBe(1);
  expect(systemTexts(core, row.id), "a first id is not a roll").toEqual([]);
});

test("a fresh uuid on the SAME live pane joins that agent, and flipping back is the same agent again", async () => {
  /* The pane rule. A flip to an id nobody has seen, on a pane a live agent
   * holds, is that agent rolling: it joins. The 11:47 shape (a transient claude
   * in the same cwd making herdr's guess flip) is why the guess is held for
   * the grace above; a flip that survives the grace IS the pane's session. */
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: [...LAYERS] });
  await until(() => !!core!.sessionOf(U1), { what: "the U1 conversation" });
  const client = core.client();
  await converse(core, U1, "written under U1");
  const agentId = core.sessionOf(U1)!.agentId;

  await core.herdr.rollSession(PANE, U2);
  await until(() => core!.sessionOf(agentId)?.harnessSessionId === U2, { what: "the first roll" });
  await converse(core, U2, "written under U2");

  await core.herdr.rollSession(PANE, U1);
  await until(() => core!.sessionOf(agentId)?.harnessSessionId === U1, { what: "the flip back" });

  // one row, under the agent id, no ghost under either uuid.
  expect(listOf(client).map((s) => s.id), "repeated flips did not converge on one row").toEqual([agentId]);
  expect(core.sessions.size).toBe(1);
  // both messages present, EACH EXACTLY ONCE.
  const texts = await attachedTexts(core, agentId);
  expect(texts.filter((t) => t === "written under U1").length).toBe(1);
  expect(texts.filter((t) => t === "written under U2").length).toBe(1);
  // the record remembers both ids, each once, with the current one current.
  const meta = await until(async () => (await metaForSession(core!.root, U1))?.sessionId === U1,
    { what: "the flip back to reach disk" }).then(() => metaForSession(core!.root, U1));
  expect(meta!.pastSessions).toEqual([U2]);
  // rollover then resume are both same-conversation churn: no chat pills
  expect(systemTexts(core, agentId)).toEqual([]);
});

test("a clean exit then a brand-new claude in the reused pane does NOT inherit the old chat", async () => {
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: [...LAYERS] });
  await until(() => !!core!.sessionOf(U1), { what: "the U1 conversation" });
  const client = core.client();
  await converse(core, U1, "this belongs to the old conversation");
  const oldAgent = core.sessionOf(U1)!.agentId;

  // That claude EXITS cleanly: pane.exited, and the U1 session is marked dead.
  await core.herdr.setAgentGone(PANE, true);
  await until(() => core!.sessionOf(U1)?.alive === false,
    { what: "the exited session to be marked dead" });

  // A brand-new claude starts in the same pane, minting a fresh uuid U2.
  await core.herdr.respawnSession(PANE, U2);
  await until(() => !!core!.sessionOf(U2), { what: "the newcomer to come up" });

  // NO join: the dead binding is not a live agent's pane.
  expect(core.sessionOf(U2)!.chat, "the newcomer started with somebody else's chat").toEqual([]);
  expect(core.sessionOf(U2)!.alive).toBe(true);
  /* THE IDENTITY CHECK, which is the one that would still catch this if the
   * chat happened to be empty for another reason: a stranger gets its OWN
   * stable agent id, never the dead predecessor's. */
  expect(core.sessionOf(U2)!.agentId,
    "the newcomer was handed the dead predecessor's stable identity").not.toBe(oldAgent);
  expect(await attachedTexts(core, U2)).toEqual([]);

  // The old conversation is untouched: its own row, dead, still holding its chat.
  const u1 = core.sessionOf(U1);
  expect(u1, "the old conversation was delisted by the newcomer").toBeDefined();
  expect(u1!.alive).toBe(false);
  expect(u1!.chat.some((m) => m.text === "this belongs to the old conversation")).toBe(true);
  expect(listOf(client).map((s) => s.id).sort()).toEqual([oldAgent, core.sessionOf(U2)!.agentId].sort());
});

test("a roll while the engine was DOWN joins on boot through the pane binding, losing nothing", async () => {
  /* The engine went down before the roll and came back after it: the pane
   * reports a uuid no record holds, and the binding says the pane was ALIVE
   * under agent A. That is A rolling (rule 2), so the pane joins A and the new
   * id is adopted; A's rows are all still there. */
  const rows = (texts: string[]) => texts.map((t, i) => ({
    id: "x", role: "user" as const, text: t, ts: 1000 + i, seq: i,
  }));
  const A = ["alpha one from U1", "alpha two from U1", "alpha three from U1"];

  // A wiring with NO session graph: the dirs exist, nothing has been loaded, so
  // this is honestly "before the engine booted".
  core = await wireCore({ with: [], start: false });
  const { agentId } = await seedAgent(core.root, U1, rows(A), { seeded: true, cwd: HARNESS_CWD });
  await Bun.write(join(core.dir, "state", "pane-bindings.json"),
    JSON.stringify({ [PANE]: { agentId, sessionId: U1, cwd: HARNESS_CWD, alive: true, ts: 1 } }));

  // NOW boot, with the pane reporting the NEW uuid.
  await core.reset({ with: [...LAYERS], sessionIds: { [PANE]: U2 }, start: true });
  await until(() => core!.sessionOf(agentId)?.harnessSessionId === U2, { what: "the pane to join its agent" });

  expect(core.sessions.size, "a second agent was minted for the roll").toBe(1);
  const texts = await attachedTexts(core, agentId);
  for (const t of A) expect(texts.filter((x) => x === t).length, `"${t}" was lost or duplicated`).toBe(1);
  const meta = await until(async () => (await metaForSession(core!.root, U2))?.agentId === agentId,
    { what: "the adopted id to reach disk" }).then(() => metaForSession(core!.root, U2));
  expect(meta!.seeded, "the joined conversation was treated as a newcomer").toBe(true);
  expect(meta!.pastSessions).toEqual([U1]);
  // a rollover join is same-conversation churn: no chat pill
  expect(systemTexts(core, agentId)).toEqual([]);
});

test("an id another record holds moves the pane to THAT agent; nothing is merged", async () => {
  /* Both ids are known (rows were written under both while the engine was
   * down, or the user ran `claude --resume` of another conversation in this
   * pane). The index decides: the pane is the agent whose id it reports. The
   * other record stays its own conversation, dead until a pane hosts it. */
  const row = (text: string) => [{ id: "x", role: "user" as const, text, ts: 1000, seq: 0 }];
  core = await wireCore({ with: [], start: false });
  const a1 = await seedAgent(core.root, U1, row("alpha from U1"), { cwd: HARNESS_CWD });
  const a2 = await seedAgent(core.root, U2, row("beta from U2"), { cwd: HARNESS_CWD });
  await Bun.write(join(core.dir, "state", "pane-bindings.json"),
    JSON.stringify({ [PANE]: { agentId: a1.agentId, sessionId: U1, cwd: HARNESS_CWD, alive: true, ts: 1 } }));

  await core.reset({ with: [...LAYERS], sessionIds: { [PANE]: U2 }, start: true });
  await until(() => core!.sessionOf(U2)?.alive === true, { what: "the pane under U2's agent" });

  expect(core.sessionOf(U2)!.agentId, "the announced id names its own agent, not the pane's last one").toBe(a2.agentId);
  expect(core.sessionOf(U2)!.muxHandle).toBe(PANE);
  expect(await attachedTexts(core, a2.agentId)).toEqual(["beta from U2"]);
  const u1 = core.sessionOf(U1)!;
  expect(u1.agentId).toBe(a1.agentId);
  expect(u1.alive, "the pane's previous agent is listed, dead, with its own chat").toBe(false);
  expect(await attachedTexts(core, a1.agentId)).toEqual(["alpha from U1"]);
  expect((await readAgentMetas(core.root)).size).toBe(2);
  expect(systemTexts(core, a2.agentId), "moving a pane is not a roll").toEqual([]);
});

test("a clean exit before the engine went down does NOT join a new claude on boot", async () => {
  /* `alive:false` on the binding is the whole discriminator. Same shape as the
   * join above in every other respect, so what is being tested is that one
   * flag and not some accident of the setup. */
  core = await wireCore({ with: [], start: false });
  const { agentId } = await seedAgent(core.root, U1, [
    { id: "old-0", role: "user", text: "the exited conversation", ts: 1000, seq: 0 },
  ], { cwd: HARNESS_CWD });
  await Bun.write(join(core.dir, "state", "pane-bindings.json"),
    JSON.stringify({ [PANE]: { agentId, sessionId: U1, cwd: HARNESS_CWD, alive: false, ts: 1 } }));

  await core.reset({ with: [...LAYERS], sessionIds: { [PANE]: U2 }, start: true });
  await until(() => !!core!.sessionOf(U2), { what: "the newcomer to come up" });

  expect(core.sessionOf(U2)!.agentId, "a dead binding handed its agent to a stranger").not.toBe(agentId);
  expect(core.sessionOf(U2)!.chat, "the newcomer inherited the exited conversation").toEqual([]);
  expect(await attachedTexts(core, U2)).toEqual([]);
  expect(core.sessionOf(U1)!.alive, "the exited conversation is still its own, dead, row").toBe(false);
});

test("a rolled session whose pane then exits leaves ONE dead row holding the whole chat", async () => {
  /* What used to need a reactive heal. The chat never moved, so the pane
   * exiting after a roll strands nothing: the agent's one row goes dead with
   * everything said under both ids. */
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: [...LAYERS] });
  await until(() => !!core!.sessionOf(U1), { what: "the U1 conversation" });
  const client = core.client();
  await converse(core, U1, "belongs to the real session");
  const agentId = core.sessionOf(U1)!.agentId;

  await core.herdr.rollSession(PANE, U2);
  await until(() => core!.sessionOf(agentId)?.harnessSessionId === U2, { what: "the roll" });
  await converse(core, U2, "said after the roll");

  await core.herdr.setAgentGone(PANE, true);
  await until(() => core!.sessionOf(agentId)?.alive === false, { what: "the pane's exit to be reconciled" });

  expect(core.sessions.size).toBe(1);
  expect(listOf(client).map((s) => ({ id: s.id, alive: s.alive }))).toEqual([{ id: agentId, alive: false }]);
  const texts = await attachedTexts(core, agentId);
  expect(texts).toContain("belongs to the real session");
  expect(texts).toContain("said after the roll");
});

test("a roll on a pane with no conversation yet is the same agent, and no second row", async () => {
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: [...LAYERS] });
  await until(() => !!core!.sessionOf(U1), { what: "the empty U1 pane" });
  const client = core.client();
  const agentId = core.sessionOf(U1)!.agentId;

  await core.herdr.rollSession(PANE, U2);
  await until(() => core!.sessionOf(agentId)?.harnessSessionId === U2, { what: "the new uuid to be adopted" });

  expect([...core.sessions.keys()]).toEqual([agentId]);
  expect(listOf(client).map((s) => s.id)).toEqual([agentId]);
  expect(HARNESS_CWD).toBe(core.sessionOf(U2)!.cwd); // still the same pane's work
});
