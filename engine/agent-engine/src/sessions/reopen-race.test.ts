/* THE REOPEN RACE: a reconcile tick lists the reopened pane BEFORE the
 * /new-session route binds the agent's id to it.
 *
 * k8plus, 2026-10-08, after a power reboot (herdr, pi): the owner pressed +
 * and started a NEW claude session in /home/shikher/shaluai (pane w1:pE), then
 * pressed + and reopened the dead pi agent ag-fOoN6 (resume=true) in the same
 * folder. Its pane w1:pF landed on a fresh PROVISIONAL ag-Jb8 instead:
 *
 *   11:04:16 [session] w1:pF -> ag-Jb8 (provisional)
 *   11:04:17 [new-session] w1:pF in /home/shikher/shaluai (ag-fOoN6, pi)
 *   11:04:19 [session-poll] + 01a0cb5c ... ingest.start session=ag-Jb8
 *
 * The order of events that does it:
 *   1. the route awaits adapter.spawn; herdr's newTab returns only once the
 *      agent has painted, so the poll can list w1:pF first. With no binding on
 *      the handle yet, reconcile keys it by a provisional and binds the handle
 *      to that provisional (alive).
 *   2. the route's adoptAgentId(w1:pF, ag-fOoN6) is a no-op: it never takes a
 *      live binding, so the reopen's id never reaches the pane.
 *   3. pi's socket delivers its session id; the direct carry follows the
 *      binding to the provisional and adopts the id there, re-indexing it away
 *      from ag-fOoN6. The provisional now has a session id, so reconcile never
 *      absorbs it, and ag-fOoN6 stays dead.
 *
 * Driven through the REAL /new-session route with an adapter stub whose spawn
 * runs the reconcile tick mid-flight, the way herdr's poll does.
 *
 *   bun test agent-engine/src/sessions/reopen-race.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { makeReconcile, resetReconcileForTest } from "./reconcile.ts";
import { carryDirectHandleBind } from "./carry.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { seedAgent } from "../test-utils/builders.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentSessionRef } from "../runtime/agents.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { root, data } = await tmpDataDir("cyc-reopen-race-");
process.env.CYC_DATA_DIR = data;
let http: ServedRoutes | null = null;
afterAll(() => {
  http?.stop();
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
});

const PI_SID = "01a0cb5c-5c03-758d-a146-b663e6970c94";   // the dead pi agent's session
const PI_FRESH = "7e1d0c2b-3a49-4f58-9b6a-c7d8e9f0a1b2"; // a fresh pi session (no resume)
const CLAUDE_SID = "bd69fb2f-abdc-4b65-abf7-d0be8cf9c9a0";
const CWD = "/home/x/shaluai";
const PE = "w1:pE"; // the new claude pane, same folder, seconds earlier
const PF = "w1:pF"; // the reopened pi pane

const deps: S.SessionStateDeps = { noteMinted: () => {}, broadcastSessions: () => {}, lineageOf: () => undefined };

initChatlog({
  chatOf: (id) => S.sessions.get(id)?.chat ?? S.restoredChats.get(id),
  restoredChats: () => S.restoredChats,
  persistPatch: (id, mts, set, unset) => S.persistPatch(id, mts, set, unset),
  broadcast: () => {},
  chatRefFor: (id) => S.chatRefFor(id),
  indexMsgBlobs: (aid, m) => S.indexMsgBlobs(aid, m),
  appendMsg: (aid, chatId, m) => S.chatStore.appendMsg(aid, chatId, m),
  appendRec: (aid, chatId, rec) => S.chatStore.appendRec(aid, chatId, rec),
});
initIngest({
  sessionOf: (id) => S.sessions.get(id),
  sessions: () => S.sessions.values(),
  broadcastSessions: () => {},
  subscribe: () => null,
  readTranscriptSpan: async () => ({ events: [], queueOps: [], consumed: [], delivered: [], offset: 0 }),
  subscribeStatus: () => null,
  transcriptFile: () => null,
  tailOf: () => undefined,
  setTail: () => {},
  log: () => {},
});

const reconcile = makeReconcile({
  hasTranscript: () => false, canParseScreen: () => false, nativeDone: false,
  sweepTails: () => {}, broadcastSessions: () => {}, now: () => 1_000_000,
});

const announced = (id: string): AgentSessionRef => ({ id, kind: "id", source: ANNOUNCED_SOURCE });

/** A pane as the herdr lane reports it: claude lifts its announced id into
 *  harnessSessionId, pi's rides agentSession alone. */
function pane(handle: string, kind: string, ref: AgentSessionRef | null): MuxAgentInfo {
  return {
    handle, title: "shaluai", cwd: CWD, lifecycle: "running", kind,
    harnessSessionId: kind === "claude" && ref ? ref.id : null,
    agentSession: ref, workspace: "w1", tab: null, displayAgent: null, stateChangeSeq: 0, statusHint: "idle",
  };
}

/* The adapter the route spawns through. `spawn` hands back the next queued
 * handle, and runs `during` first: whatever the poll and pi's socket do while
 * the route is still awaiting newTab. */
let nextHandle = "";
let during: () => void = () => {};
const adapter = {
  launchCommand: (k: string) => k,
  resumeCommand: (k: string, sid: string) => `${k} --session ${sid}`,
  knownCwds: () => [CWD],
  spawn: async () => { during(); return { handle: nextHandle }; },
};
http = serveRoutes({
  groups: [sessionOpsRoutes],
  ctx: { adapter: adapter as never, claudeCommand: "claude", binaryOnPath: () => true },
});

beforeEach(async () => {
  S.resetForTest();
  resetReconcileForTest();
  await S.chatStore.flush();
  await new Promise((r) => setTimeout(r, 50));
  await rm(join(data, "agents"), { recursive: true, force: true });
  await rm(join(data, "state"), { recursive: true, force: true });
  process.env.CYC_ANNOUNCE_GRACE_MS = "0";
  during = () => {};
});

/** Boot with the dead pi agent on disk, then the owner's first step: a NEW
 *  claude session in the same folder, whose pane the poll lists (announced)
 *  before the route's bind lands, exactly as w1:pE did. */
async function bootWithClaudeNeighbour(): Promise<{ dead: string; claudeRow: string }> {
  const { agentId: dead } = await seedAgent(root, PI_SID,
    [{ id: "r", role: "user", text: "the old conversation", ts: 1 }],
    { harness: "pi", cwd: CWD, name: "Shalu AI" });
  await S.loadSessionState(deps);
  S.sessionStateReady();
  expect(S.agentIdFor(PI_SID)).toBe(dead);
  nextHandle = PE;
  during = () => reconcile([pane(PE, "claude", announced(CLAUDE_SID))]);
  const res = await http!.post("/new-session", { cwd: CWD, harness: "claude" });
  expect(res.status).toBe(200);
  const claudeRow = S.sessionByHandle(PE)!.agentId;
  return { dead, claudeRow };
}

/** The reopened pane, listed by the poll with no id yet (pi has not spoken). */
const listedSilent = () => reconcile([pane(PE, "claude", announced(CLAUDE_SID)), pane(PF, "pi", null)]);

async function reopen(dead: string, resume: boolean): Promise<void> {
  nextHandle = PF;
  const res = await http!.post("/new-session", { agentId: dead, resume });
  const body = (await res.json()) as { ok: boolean; agentId?: string };
  expect(body.ok, JSON.stringify(body)).toBe(true);
  expect(body.agentId).toBe(dead);
}

/** What must hold once the reopened pane reports its session: the pane is the
 *  OLD agent, alive, the id indexed to it, no provisional left holding it, and
 *  the claude neighbour untouched. */
function expectReopened(dead: string, claudeRow: string, sid: string): void {
  const row = S.sessionByHandle(PF)!;
  expect(row.agentId, "the reopened pane is the OLD agent, not a provisional").toBe(dead);
  expect(S.sessions.get(dead)!.alive).toBe(true);
  expect(S.metaFor(dead).sessionId).toBe(sid);
  expect(S.agentIdFor(sid), "the session id is indexed to the old agent").toBe(dead);
  const holders = [...S.agentMetas.values()].filter((m) => m.sessionId === sid).map((m) => m.agentId);
  expect(holders, "no second agent carries the session id").toEqual([dead]);
  expect(S.sessions.get(dead)!.chat.map((m) => m.text)).toContain("the old conversation");
  expect([...S.sessions.values()].filter((s) => s.alive).map((s) => s.agentId).sort())
    .toEqual([claudeRow, dead].sort());
  expect(S.sessionByHandle(PE)!.agentId, "the claude pane in the same folder keeps its agent").toBe(claudeRow);
  expect(S.metaFor(claudeRow).sessionId).toBe(CLAUDE_SID);
}

test("FIELD: the poll lists the reopened pane before the bind, then pi reports the resumed id", async () => {
  const { dead, claudeRow } = await bootWithClaudeNeighbour();
  during = listedSilent; // 11:04:16, the provisional
  await reopen(dead, true); // 11:04:17, the route's bind
  carryDirectHandleBind(PF, PI_SID); // 11:04:19, pi's socket
  reconcile([pane(PE, "claude", announced(CLAUDE_SID)), pane(PF, "pi", announced(PI_SID))]);
  expectReopened(dead, claudeRow, PI_SID);
});

test("the same race when pi's socket speaks before the route's bind lands", async () => {
  const { dead, claudeRow } = await bootWithClaudeNeighbour();
  during = () => { listedSilent(); carryDirectHandleBind(PF, PI_SID); };
  await reopen(dead, true);
  reconcile([pane(PE, "claude", announced(CLAUDE_SID)), pane(PF, "pi", announced(PI_SID))]);
  expectReopened(dead, claudeRow, PI_SID);
});

test("a reopen WITHOUT resume races the same way: the fresh id joins the old agent", async () => {
  const { dead, claudeRow } = await bootWithClaudeNeighbour();
  during = listedSilent;
  await reopen(dead, false);
  carryDirectHandleBind(PF, PI_FRESH);
  reconcile([pane(PE, "claude", announced(CLAUDE_SID)), pane(PF, "pi", announced(PI_FRESH))]);
  expectReopened(dead, claudeRow, PI_FRESH);
  expect(S.metaFor(dead).pastSessions).toContain(PI_SID);
});

test("no race: the bind lands before the poll lists the pane (unchanged)", async () => {
  const { dead, claudeRow } = await bootWithClaudeNeighbour();
  await reopen(dead, true);
  listedSilent();
  expect(S.sessionByHandle(PF)!.agentId).toBe(dead);
  carryDirectHandleBind(PF, PI_SID);
  reconcile([pane(PE, "claude", announced(CLAUDE_SID)), pane(PF, "pi", announced(PI_SID))]);
  expectReopened(dead, claudeRow, PI_SID);
});
