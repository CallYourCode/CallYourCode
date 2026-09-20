/* HOOK-ANNOUNCED IDENTITY THROUGH THE FULL CORE, herdr lane.
 *
 * The constitution under test (adapters lane 2):
 *   - an ANNOUNCEMENT (hook:announce) is the strongest identity evidence and
 *     overrides the mux's own guess immediately, with no grace and no gate;
 *   - a session RESUMED in a brand-new pane reattaches to its EXISTING agent
 *     and history through the session index -- the owner's named corner case;
 *   - an announce carrying a LINK (`clear`, `fork`, `resume`, `compact` with
 *     the prior id) joins the linked agent by a direct index lookup, before
 *     any pane matching, and the rollover row names the harness's own word.
 *
 * NO ENGINE PROCESS: wireCore boots server.ts's own wiring over a FakeHerdr
 * and a REAL HerdrClient + MuxAdapter, so the announce store, the herdr-lane
 * bind resolution and the reconcile are all shipped code.
 *
 *   bun test agent-engine/src/terminal/announce-resume.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { wireCore, type WireCore } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { seedAgent, metaForSession, readAgentMetas } from "../test-utils/builders.ts";
import { onUtterance } from "../chat/deliver.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { handleAnnounce } from "./hook-announce.ts";
import type { SessionLink } from "../runtime/agents.ts";

const U1 = "5efab001-1111-4aaa-8bbb-000000000001";
const U2 = "5efab002-2222-4ccc-8ddd-000000000002";
const NEW_PANE = "w2:p9"; // the brand-new pane a resume lands in

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

const LAYERS = ["delivery", "frames"] as const;

/** The hook's word, resolved the herdr way (no pids on herdr; the pane env id
 *  the announcing claude carries is the witness). */
const announce = (sessionId: string, herdrPane: string, link?: SessionLink) =>
  handleAnnounce({ sessionId, pid: 4321, cwd: "/tmp/x", herdrPane, harness: "claude", ...(link ? { link } : {}) },
    { resolveAgentPid: async () => null });

async function converse(c: WireCore, id: string, text: string): Promise<void> {
  const client = c.clients[0] ?? c.client();
  await onUtterance(client.sock, { id: c.sessionOf(id)!.id, text });
  await until(() => (c.sessionOf(id)?.chat ?? []).some((m) => m.text === text),
    { what: `"${text}" to reach ${id}'s conversation log` });
}

async function attachedTexts(c: WireCore, id: string): Promise<string[]> {
  const page = c.client();
  await dispatchClientFrame(page.sock, { t: "attach", id: c.sessionOf(id)?.id ?? id, since: 0 });
  const ok = await until(() => page.last("attach-ok") !== undefined,
    { what: `an attach-ok for ${id}` }).then(() => page.last("attach-ok")!);
  return ((ok.pages as any[]) ?? []).flatMap((p) => (p.messages ?? []).map((m: any) => String(m.text)));
}

const systemTexts = (c: WireCore, id: string): string[] =>
  (c.sessionOf(id)?.chat ?? []).filter((m) => m.kind === "system").map((m) => m.text);

test("RESUME ACCEPTANCE: a session resumed in a brand-new pane reattaches to its agent via the announce", async () => {
  /* The owner's corner case. uuidX lived in a pane, said things, the pane (and
   * its whole server generation) died, the engine restarted. Then `claude
   * --resume uuidX` starts in a NEW pane with a NEW pid: the SessionStart hook
   * announces uuidX, and the SAME agent must come back alive with its chat
   * intact, through the session index. Seeded ON DISK, the way a real restart
   * finds it: an agent record answering to U1 with its chat log, and NO pane
   * binding left (the whole mux generation died with the pane). */
  core = await wireCore({ with: [], start: false });
  const { agentId } = await seedAgent(core.root, U1, [
    { id: "r-0", role: "user", text: "history that must survive the resume", ts: 1000, seq: 0 },
  ]);

  /* The engine boots against the new mux generation: its only pane is a
   * brand-new one that has minted NOTHING yet (agent_session null: parked).
   * Same data dir, so U1 exists only in the restored stores. */
  await core.reset({ with: [...LAYERS], start: true, panes: [NEW_PANE], noSession: [NEW_PANE] });
  await until(() => !!core!.byHandle(NEW_PANE), { what: "the new pane to park" });
  const provisional = core.byHandle(NEW_PANE)!.agentId;
  expect(provisional, "the parked pane was put on the dead agent by its folder").not.toBe(agentId);
  expect(core.sessionOf(agentId)!.alive, "the resumable agent is listed, dead, before the resume").toBe(false);

  // claude --resume U1 announces itself from inside the new pane
  const r = await announce(U1, NEW_PANE, { kind: "resume" });
  expect(r.ok).toBe(true);

  // the SAME agent reattaches: alive again, on the new pane, chat intact
  await until(() => core!.sessionOf(U1)?.alive === true,
    { what: "the resumed session to reattach alive under U1" });
  const s = core.sessionOf(U1)!;
  expect(s.agentId).toBe(agentId);
  expect(s.muxHandle).toBe(NEW_PANE);
  expect(s.harnessSessionId).toBe(U1);
  expect(core.sessions.size, "the parked pane's provisional row must have folded, not duplicated").toBe(1);
  expect(core.sessionOf(provisional), "the provisional survived as a ghost").toBeUndefined();
  expect(s.chat.some((m) => m.text === "history that must survive the resume"),
    "the resumed session lost its history").toBe(true);
  // a resume of the agent's CURRENT id is not a roll: no divider
  expect(systemTexts(core, agentId)).toEqual([]);
  // same stable agent identity on disk, and no record was minted for the
  // provisional (it had no session id and said nothing)
  expect((await metaForSession(core.root, U1))?.agentId).toBe(agentId);
  expect((await readAgentMetas(core.root)).size).toBe(1);
  expect(await attachedTexts(core, U1)).toContain("history that must survive the resume");
});

test("an announcement overrides the mux's guess at once, and joins the pane's own agent", async () => {
  /* The guess (herdr's transcript locator) said U1; claude's own word is U2, an
   * id nobody has seen, on the pane the agent already holds. That is the agent
   * rolling: it joins, immediately, no grace, and the guess is superseded. */
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: [...LAYERS] });
  await until(() => !!core!.sessionOf(U1), { what: "the U1 conversation" });
  await converse(core, U1, "carried by claude's own word");
  const agentId = core.sessionOf(U1)!.agentId;

  const r = await announce(U2, PANE);
  expect(r.ok).toBe(true);

  await until(() => core!.sessionOf(agentId)?.harnessSessionId === U2, { what: "the announced id to be adopted" });
  const s = core.sessionOf(U2)!;
  expect(s.agentId).toBe(agentId);
  expect(s.alive).toBe(true);
  expect(s.chat.some((m) => m.text === "carried by claude's own word")).toBe(true);
  expect(core.sessions.size).toBe(1);
  expect(core.sessionOf(U1)?.agentId, "the superseded id still names the agent (pastSessions)").toBe(agentId);
  // the wire row carries the announced source, not a guess
  expect(s.agentSession).toEqual({ id: U2, kind: "id", source: "hook:announce" });
  // a plain rollover is same-conversation churn: no chat pill (owner call 2026-09-08)
  expect(systemTexts(core, agentId)).toEqual([]);
});

test("a LINKED announce joins the linked agent through the index, even from a new pane", async () => {
  /* `claude --resume U1 --fork-session` in a brand-new pane: the new session
   * U2 has never been seen and the pane is bound to nobody, so without the
   * link this would be a new agent. The hook says where it came from, and
   * `link.from` is looked up in the index before any pane matching. */
  core = await wireCore({ with: [], start: false });
  const { agentId } = await seedAgent(core.root, U1, [
    { id: "f-0", role: "user", text: "said in the session that was forked", ts: 1000, seq: 0 },
  ]);
  await core.reset({ with: [...LAYERS], start: true, panes: [NEW_PANE], noSession: [NEW_PANE] });
  await until(() => !!core!.byHandle(NEW_PANE), { what: "the new pane to park" });

  const r = await announce(U2, NEW_PANE, { kind: "fork", from: U1 });
  expect(r.ok).toBe(true);

  await until(() => core!.sessionOf(agentId)?.harnessSessionId === U2, { what: "the fork to join its agent" });
  const s = core.sessionOf(U2)!;
  expect(s.agentId, "the linked announce minted a stranger").toBe(agentId);
  expect(s.muxHandle).toBe(NEW_PANE);
  expect(s.alive).toBe(true);
  expect(core.sessions.size).toBe(1);
  expect(await attachedTexts(core, agentId)).toContain("said in the session that was forked");
  // the divider names the harness's own word for the roll
  expect(systemTexts(core, agentId)).toEqual(["new session (fork)"]);
  const meta = await until(async () => (await metaForSession(core!.root, U2))?.agentId === agentId,
    { what: "the forked id on disk" }).then(() => metaForSession(core!.root, U2));
  expect(meta!.pastSessions).toEqual([U1]);
});

test("a /clear announce on the live pane rolls the agent and names the reason", async () => {
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: [...LAYERS] });
  await until(() => !!core!.sessionOf(U1), { what: "the U1 conversation" });
  await converse(core, U1, "before the clear");
  const agentId = core.sessionOf(U1)!.agentId;

  // claude's SessionStart after /clear: source "clear", a new session id
  const r = await announce(U2, PANE, { kind: "clear", from: U1 });
  expect(r.ok).toBe(true);
  await until(() => core!.sessionOf(agentId)?.harnessSessionId === U2, { what: "the clear to be adopted" });

  expect(core.sessions.size).toBe(1);
  expect(systemTexts(core, agentId)).toEqual(["new session (clear)"]);
  expect(await attachedTexts(core, agentId)).toContain("before the clear");
});

test("a child session (opencode parentID) is acknowledged and never becomes a row", async () => {
  core = await wireCore({ agentStatus: "idle", sessionIds: { [PANE]: U1 }, with: [...LAYERS] });
  await until(() => !!core!.sessionOf(U1), { what: "the U1 conversation" });
  const agentId = core.sessionOf(U1)!.agentId;

  const r = await handleAnnounce(
    { sessionId: U2, pid: 4321, cwd: "/tmp/x", herdrPane: PANE, harness: "opencode", link: { kind: "parent", from: U1 } },
    { resolveAgentPid: async () => null });
  expect(r).toEqual({ ok: true, parked: false });

  // the pane's agent is untouched: same id, same session, no roll
  await core.herdr.rollSession(PANE, U1); // one more snapshot through the reconcile
  expect(core.sessionOf(agentId)!.harnessSessionId).toBe(U1);
  expect(core.sessionOf(U2), "a subagent's id became a session").toBeUndefined();
  expect(core.sessions.size).toBe(1);
  expect(systemTexts(core, agentId)).toEqual([]);
});
