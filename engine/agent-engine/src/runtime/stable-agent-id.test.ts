/* THE STABLE AGENT ID.
 *
 * Every session gets one short, opaque, url-safe id minted ONCE, persisted in
 * its agent record, and it IS the key: the wire row's `id`, the Session map's
 * key, the directory every durable thing about the conversation lives in. It
 * also rides the sessions frame as `sessionAgentId` (the brief's `agentId`
 * name is taken on the row by #587, the coding agent's TYPE stamp). The
 * harness session uuid is an attribute of the row (`harnessSessionId`), and a
 * uuid roll changes that attribute and nothing else.
 *
 * WHY IT MATTERS: #405 and #571 are two proofs that a harness uuid is not
 * stable. Everything durable about a conversation -- its files, its photo, its
 * schedules, its chat log on disk -- hangs off THIS id instead. An id that
 * re-minted on a roll would leave every one of those pointing at a record
 * nothing answers to any more, silently.
 *
 * The invariants proven here:
 *
 *   - create: a first-seen session mints exactly one id and persists it
 *   - a rebuild (the same uuid reported again) mints nothing
 *   - a parked pane gets a provisional id; the uuid claude mints later joins
 *     that id (the row's key never changes, so there is no re-key frame)
 *   - a live uuid -> uuid roll keeps the id; the old uuid joins pastSessions
 *   - boot: a restored agent's id is ADOPTED, never re-minted
 *   - a roll while the engine was down joins on boot through the pane binding
 *   - uniqueness: no two sessions share one
 *   - two known ids never merge: an announced id moves the pane to ITS agent
 *
 * NO ENGINE PROCESS: wireCore performs server.ts's ordered boot in-process over
 * a FakeHerdr and a REAL MuxAdapter; a reset() in the same dirs is a restart.
 *
 *   bun test agent-engine/src/runtime/stable-agent-id.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";

import { wireCore, type WireCore, type FakeClient } from "../test-utils/wire-core.ts";
import { PANE, HARNESS_CWD } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { seedAgent, readAgentMetas } from "../test-utils/builders.ts";
import { onUtterance } from "../chat/deliver.ts";
import { agentMetas } from "../sessions/session-state.ts";

// Two distinct uuids on one pane, both different from the pane id.
const U1 = "347a76f6-1111-4aaa-8bbb-000000000001";
const U2 = "91b7380e-2222-4ccc-8ddd-000000000002";
const U3 = "91b7380e-3333-4ccc-8ddd-000000000003";

/** The shape every minted id has: `ag-` plus 16 base64url chars. */
const SHAPE = /^ag-[A-Za-z0-9_-]{16}$/;
/** A seeded value that cannot be a real mint, so "carried unchanged" is provable. */
const FIXED = "ag-AAAAAAAAAAAAAAAA";

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

const listOf = (client: FakeClient): any[] => (client.last("sessions")?.list as any[]) ?? [];
const rowOf = (client: FakeClient, id: string) => listOf(client).find((s) => s.id === id);

/** harness session id -> agentId AS PERSISTED, rebuilt the way boot does: from
 *  every live agent record on disk, current id and past ids alike. Reading the
 *  files rather than the memory map is the point -- a stable id that only
 *  lives in a Map is not stable at all. */
async function store(c: WireCore): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const meta of (await readAgentMetas(c.root)).values()) {
    if (meta.mergedInto) continue;
    if (meta.sessionId) out[meta.sessionId] = meta.agentId;
    for (const past of meta.pastSessions ?? []) out[past] = meta.agentId;
  }
  return out;
}
/** The live (non-merged) records on disk. */
async function records(c: WireCore) {
  return [...(await readAgentMetas(c.root)).values()].filter((m) => !m.mergedInto);
}

/** A live conversation, so a roll has something to keep. */
async function converse(c: WireCore, client: FakeClient, id: string, text: string): Promise<void> {
  await onUtterance(client.sock, { id: c.sessionOf(id)!.id, text });
  await until(() => (c.sessionOf(id)?.chat ?? []).some((m) => m.text === text),
    { what: `"${text}" to reach ${id}'s conversation log` });
}

test("create: a first-seen session mints one id, keys the row by it, and persists it", async () => {
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: ["delivery", "frames"] });
  const client = core.client();
  await until(() => !!core!.sessionOf(U1), { what: "the U1 session to come up" });
  core.hello(client);

  const s = core.sessionOf(U1)!;
  const row = rowOf(client, s.agentId);
  expect(row, "the row is not keyed by the agent id").toBeDefined();
  // In the short opaque url-safe shape, alongside -- never instead of -- the
  // existing `agentId`, which is the coding agent's TYPE stamp (#587).
  expect(row.sessionAgentId, "the row carries no stable id").toMatch(SHAPE);
  expect(row.id, "the wire id IS the stable id").toBe(row.sessionAgentId);
  expect(row.harnessSessionId, "the harness uuid is an attribute of the row").toBe(U1);
  expect(row.agentId, "the existing coding-agent type stamp was disturbed").toBe("claude");
  expect(row.sessionAgentId, "the stable id must not equal the harness uuid").not.toBe(U1);
  expect(row.sessionAgentId, "the stable id must not equal the pane id").not.toBe(PANE);

  // Persisted exactly once, answering to the session id.
  await until(async () => (await store(core!))[U1] === row.sessionAgentId,
    { what: "the minted id to reach disk" });
  expect((await records(core)).length, "more than one id was minted").toBe(1);
});

test("a rebuild reuses the id rather than minting a second one", async () => {
  /* The reconcile mints a fresh Session object on EVERY herdr snapshot, seconds
   * apart. The session index answers the same agent for the same uuid every
   * time; nothing on the rebuild path mints. */
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: ["delivery", "frames"] });
  await until(() => !!core!.sessionOf(U1), { what: "the U1 session" });
  const first = core.sessionOf(U1)!.agentId;

  // Report the SAME uuid again: herdr fires agent_detected, the engine
  // resnapshots, and the reconcile rebuilds the row from scratch.
  await core.herdr.rollSession(PANE, U1);
  await core.herdr.rollSession(PANE, U1);
  await until(() => core!.sessionOf(U1)!.agentId === first, { what: "the rebuilt row" });

  expect(core.sessionOf(U1)!.agentId, "the id changed across a rebuild").toBe(first);
  expect(core.sessions.size).toBe(1);
  await until(async () => (await store(core!))[U1] === first, { what: "the record on disk" });
  expect((await records(core)).length, "a rebuild persisted a second id").toBe(1);
  expect([...agentMetas.keys()], "a rebuild minted an in-memory record").toEqual([first]);
});

test("a parked pane's provisional id is the id the minted uuid joins; no re-key, no second record",
  async () => {
    // The pane has no claude session id yet: the row is keyed by a provisional
    // agent id, and the record is NOT written (no session id, no chat: nothing
    // to name it by).
    core = await wireCore({ agentStatus: "idle", noSession: [PANE], with: ["delivery", "frames"] });
    const client = core.client();
    await until(() => !!core!.byHandle(PANE), { what: "the parked pane to come up" });
    core.hello(client);

    const A = core.byHandle(PANE)!.agentId;
    expect(A, "the parked session has no stable id").toMatch(SHAPE);
    expect(rowOf(client, A), "the parked row is not keyed by its agent id").toBeDefined();
    expect(rowOf(client, A).harnessSessionId).toBeNull();
    expect((await records(core)).length, "a parked pane wrote a nameless record").toBe(0);

    // claude mints its uuid at last: agent_session flips null -> U1.
    await core.herdr.mintSession(PANE, U1);
    await until(() => !!core!.sessionOf(U1), { what: "the joined session" });

    expect(core.sessionOf(U1)!.agentId, "the minted uuid did not join the pane's agent").toBe(A);
    expect(rowOf(client, A).harnessSessionId).toBe(U1);
    expect(core.sessions.size, "the mint left a second row").toBe(1);
    expect(client.of("session-id-changed"), "there is no re-key: the key never changed").toEqual([]);

    // Now it has a name: ONE record, answering to U1.
    await until(async () => (await store(core!))[U1] === A, { what: "the record on disk" });
    expect((await records(core)).length, "the mint left two records behind").toBe(1);
  });

test("a uuid -> uuid roll keeps the id; the old uuid joins pastSessions", async () => {
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: ["delivery", "frames"] });
  const client = core.client();
  await until(() => !!core!.sessionOf(U1), { what: "the U1 session" });
  await converse(core, client, U1, "keep this conversation across the roll");
  const A = core.sessionOf(U1)!.agentId;
  expect(A, "no stable id on the pre-roll row").toMatch(SHAPE);

  await core.herdr.rollSession(PANE, U2);
  await until(() => core!.sessionOf(A)?.harnessSessionId === U2, { what: "the roll to be adopted" });

  expect(core.sessionOf(U2)!.agentId, "the id changed across the uuid roll").toBe(A);
  expect(core.sessionOf(U1)!.agentId, "the past uuid no longer names the agent").toBe(A);
  expect(rowOf(client, A).harnessSessionId).toBe(U2);

  await until(async () => (await store(core!))[U2] === A, { what: "the rolled record on disk" });
  const s = await store(core);
  expect(s[U1], "the rolled-from uuid was forgotten (a --resume of it would mint a stranger)").toBe(A);
  expect((await records(core)).length).toBe(1);
  expect((await records(core))[0].pastSessions).toEqual([U1]);
});

test("boot: a restored agent's id is ADOPTED, not re-minted", async () => {
  /* Under the agent-record layout a chat cannot exist without an agent dir, so
   * "restored from an earlier life" is an agent record on disk whose id the boot
   * must adopt. Re-minting here would orphan every file in that directory. */
  core = await wireCore({ with: [], start: false });
  const { agentId } = await seedAgent(core.root, U1, [
    { id: "old-0", role: "user", text: "restored from an earlier life", ts: 1000, seq: 0 },
  ]);
  expect(agentId).toMatch(SHAPE);

  await core.reset({ with: ["delivery", "frames"], sessionIds: { [PANE]: U1 }, start: true });
  const client = core.client();
  await until(() => !!core!.sessionOf(U1), { what: "the restored session" });
  core.hello(client);

  expect(rowOf(client, agentId)?.sessionAgentId, "the restored agent's id was re-minted").toBe(agentId);
  const s = await store(core);
  expect(s[U1]).toBe(agentId);
  expect((await records(core)).length, "the boot path minted a second record").toBe(1);
});

test("a roll while the engine was down joins on boot: the seeded id is kept unchanged", async () => {
  /* FIXED cannot be a real mint, so an id that comes back as FIXED was kept and
   * not re-derived. The pane binding (alive, under FIXED) is what says the
   * unknown uuid on that pane is FIXED rolling. */
  core = await wireCore({ with: [], start: false });
  await seedAgent(core.root, U1, [
    { id: "old-0", role: "user", text: "rolled while the engine was down", ts: 1000, seq: 0 },
  ], { agentId: FIXED, seeded: true, cwd: HARNESS_CWD });
  await Bun.write(join(core.dir, "state", "pane-bindings.json"),
    JSON.stringify({ [PANE]: { agentId: FIXED, sessionId: U1, cwd: HARNESS_CWD, alive: true, ts: 1 } }));

  await core.reset({ with: ["delivery", "frames"], sessionIds: { [PANE]: U2 }, start: true });
  const client = core.client();
  await until(() => core!.sessionOf(FIXED)?.harnessSessionId === U2, { what: "the pane to join FIXED under U2" });
  core.hello(client);

  expect(rowOf(client, FIXED).sessionAgentId, "the seeded id was not kept").toBe(FIXED);
  expect(core.sessions.size, "the boot minted a stranger for the rolled pane").toBe(1);
  expect(client.of("session-id-changed")).toEqual([]);

  await until(async () => (await store(core!))[U2] === FIXED, { what: "the rolled record on disk" });
  expect((await store(core))[U1], "the old uuid was forgotten by the roll").toBe(FIXED);
  expect((await records(core)).length).toBe(1);
});

test("uniqueness: no two sessions share one, and each keeps exactly one", async () => {
  core = await wireCore({
    panes: ["w1:p1", "w1:p2", "w1:p3"],
    sessionIds: { "w1:p1": U1, "w1:p2": U2, "w1:p3": U3 },
    with: ["delivery", "frames"],
  });
  const client = core.client();
  await until(() => core!.sessions.size === 3, { what: "all three sessions to come up" });
  core.hello(client);

  const list = listOf(client);
  expect(list.length).toBe(3);
  const ids = list.map((s) => s.sessionAgentId);
  expect(new Set(ids).size, "two sessions share one stable id").toBe(ids.length);
  for (const id of ids) expect(id, "a minted id broke the url-safe shape").toMatch(SHAPE);
  expect(list.map((s) => s.id).sort(), "the wire ids are the stable ids").toEqual([...ids].sort());

  // The persisted store holds one entry per session, all distinct.
  await until(async () => Object.keys(await store(core!)).length === 3,
    { what: "all three records on disk" });
  const s = await store(core);
  const vals = Object.values(s);
  expect(new Set(vals).size, "the store shares an id across two sessions").toBe(vals.length);
  expect([s[U1], s[U2], s[U3]].every(Boolean), "a session's id is missing from the store").toBe(true);
});

test("two known ids never merge: an announced id moves the pane to ITS agent and both records stay",
  async () => {
    /* A pane bound to FIXED (under U1) comes up reporting U2, and U2 is an id
     * ANOTHER record already holds. Identity is decided on session ids, never
     * on the pane: the pane is U2's agent now, FIXED goes dead with its own
     * chat, and nothing is merged or retired. (The merge that once lived here
     * was how a re-keyed row met a record it had already written; rows do not
     * re-key any more, so two established records never meet.) */
    core = await wireCore({ with: [], start: false });
    await seedAgent(core.root, U1, [
      { id: "a-0", role: "user", text: "written under U1", ts: 1000, seq: 0 },
    ], { agentId: FIXED, cwd: HARNESS_CWD });
    const other = await seedAgent(core.root, U2, [
      { id: "b-0", role: "user", text: "written under U2", ts: 1001, seq: 0 },
    ], { cwd: HARNESS_CWD });
    await Bun.write(join(core.dir, "state", "pane-bindings.json"),
      JSON.stringify({ [PANE]: { agentId: FIXED, sessionId: U1, cwd: HARNESS_CWD, alive: true, ts: 1 } }));

    await core.reset({ with: ["delivery", "frames"], sessionIds: { [PANE]: U2 }, start: true });
    await until(() => core!.sessionOf(U2)?.alive === true, { what: "the pane under U2's agent" });

    expect(core.sessionOf(U2)!.agentId, "the pane's old binding overrode the announced id").toBe(other.agentId);
    expect(core.sessionOf(U2)!.chat.map((m) => m.text)).toEqual(["written under U2"]);
    expect(core.sessionOf(U1)!.agentId).toBe(FIXED);
    expect(core.sessionOf(U1)!.alive, "the pane's previous agent is listed dead with its own chat").toBe(false);
    expect(core.sessionOf(U1)!.chat.map((m) => m.text)).toEqual(["written under U1"]);

    // both records live on, neither merged, each answering to its own id
    const metas = await readAgentMetas(core.root);
    expect(metas.get(FIXED)!.mergedInto).toBeUndefined();
    expect(metas.get(other.agentId)!.mergedInto).toBeUndefined();
    const s = await store(core);
    expect(s[U1]).toBe(FIXED);
    expect(s[U2]).toBe(other.agentId);
  });
