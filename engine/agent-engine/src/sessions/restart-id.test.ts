/* A FRESH RESTART KEEPS ITS AGENT ID (restart-id consolidation).
 *
 * The shakedown: an opencode pane restarted `fresh` came back on a NEW
 * provisional agent id while /agents kept listing the OLD one. The cause is in
 * the timing of the restart, not in the resolution rule: restartPane waits for
 * the pane to leave the agent list (waitForAgentGone), which reconcile answers
 * by marking the row dead AND the pane binding dead (markBindingDead). The
 * fresh opencode then re-appears with no announce yet (it announces only at
 * session.idle) and, on herdr, no CYC_AGENT_ID evidence (PREMINT_SOURCE is a
 * tmux-only spawn-command parse). With no live row, no alive binding and no id,
 * carriedAgentOf finds nothing and resolvePane mints a PROVISIONAL twin.
 *
 * The fix: restartPane now re-adopts the pane to the SAME agent id after the
 * quit (adoptAgentId, the /new-session mechanism), re-recording the dead
 * binding alive so the silent fresh pane resolves back to that one agent.
 *
 * PURE UNIT over the shipped reconcile, the reconcile.test.ts harness: the
 * adopt is the one thing restartPane does that the reconciler sees, driven by
 * hand right where restartPane does it (after the gone-tick, before the fresh
 * pane's tick).
 *
 *   bun test agent-engine/src/sessions/restart-id.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { makeReconcile, resetReconcileForTest } from "./reconcile.ts";
import { restartPreflight } from "../routes/session-ops.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE, PREMINT_SOURCE, PARKED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { seedAgent } from "../test-utils/builders.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentSessionRef } from "../runtime/agents.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { root, data } = await tmpDataDir("cyc-restart-id-");
process.env.CYC_DATA_DIR = data;
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
});

const SES1 = "ses_" + "a".repeat(24);
const SES2 = "ses_" + "b".repeat(24);
const CWD = "/home/x/proj";
const PANE = "w2:p1";

const deps: S.SessionStateDeps = { noteMinted: () => {}, broadcastSessions: () => {}, lineageOf: () => undefined };
let clock = 1_000_000;

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
  sessionOf: (id) => S.sessions.get(id), sessions: () => S.sessions.values(),
  broadcastSessions: () => {}, subscribe: () => null,
  readTranscriptSpan: async () => ({ events: [], queueOps: [], consumed: [], delivered: [], offset: 0 }),
  subscribeStatus: () => null, transcriptFile: () => null, tailOf: () => undefined, setTail: () => {}, log: () => {},
});
const reconcile = makeReconcile({
  hasTranscript: () => false, canParseScreen: () => false, nativeDone: false, sweepTails: () => {}, broadcastSessions: () => {}, now: () => clock,
});

beforeEach(async () => {
  S.resetForTest();
  resetReconcileForTest();
  await S.chatStore.flush();
  await new Promise((r) => setTimeout(r, 50));
  await rm(join(data, "agents"), { recursive: true, force: true });
  await rm(join(data, "state"), { recursive: true, force: true });
  process.env.CYC_ANNOUNCE_GRACE_MS = "0";
  clock = 1_000_000;
});
const boot = async () => { await S.loadSessionState(deps); S.sessionStateReady(); };
const announced = (id: string): AgentSessionRef => ({ id, kind: "id", source: ANNOUNCED_SOURCE });

/** One opencode pane as herdr reports it. A silent pane (ref null) has no
 *  agent_session at all -- the fresh opencode before its session.idle. */
function pane(handle: string, ref: AgentSessionRef | null): MuxAgentInfo {
  return {
    handle, title: "proj", cwd: CWD, lifecycle: "running", kind: "opencode",
    harnessSessionId: ref && ref.kind === "id" && ref.source !== PREMINT_SOURCE && ref.source !== PARKED_SOURCE ? ref.id : null,
    agentSession: ref, workspace: "w", tab: null, displayAgent: null, stateChangeSeq: 0, statusHint: "idle",
  };
}
const rowOn = (handle: string) => S.sessionByHandle(handle)!;

/* The restart's three moments, as the reconciler sees them:
 *   1. the live opencode session on the pane, announced SES1  -> agent A
 *   2. the quit: waitForAgentGone -> A dead, binding dead      (reconcile([]))
 *   3. the fresh opencode back on the pane, no announce yet    (pane silent)
 * restartPane's adopt happens between 2 and 3. */
async function seedLive() {
  const { agentId } = await seedAgent(root, SES1,
    [{ id: "r", role: "user", text: "before restart", ts: 1 }], { harness: "opencode", cwd: CWD });
  await boot();
  reconcile([pane(PANE, announced(SES1))]);
  expect(rowOn(PANE).agentId).toBe(agentId);
  reconcile([]); // the quit
  expect(S.sessions.get(agentId)!.alive).toBe(false);
  expect(S.bindingOf(PANE)!.alive).toBe(false);
  return agentId;
}

test("WITHOUT the adopt, a silent fresh pane mints a provisional twin (the bug)", async () => {
  const a = await seedLive();
  // no adopt: the fresh silent pane re-appears
  reconcile([pane(PANE, null)]);
  // the pane is keyed by a NEW provisional, and A is left as a stale dead row:
  // /agents and the reconciler disagree
  expect(rowOn(PANE).agentId).not.toBe(a);
  expect([...S.sessions.values()].filter((s) => s.alive).map((s) => s.agentId)).toEqual([rowOn(PANE).agentId]);
  expect(S.sessions.get(a)!.alive).toBe(false); // the stale old id still listed
  expect(S.sessions.size).toBe(2); // the twin
});

test("a fresh restart keeps the agent id: one row, the original id, no provisional twin", async () => {
  const a = await seedLive();
  // restartPane re-adopts the pane to the SAME agent after the quit
  S.adoptAgentId(PANE, a);
  expect(S.bindingOf(PANE)).toMatchObject({ agentId: a, alive: true });
  // the fresh opencode re-appears with no announce yet
  reconcile([pane(PANE, null)]);
  // ONE row for the pane, the ORIGINAL id, no provisional twin
  expect(rowOn(PANE).agentId).toBe(a);
  expect(rowOn(PANE).alive).toBe(true);
  expect(S.sessions.size).toBe(1);
  // the old chat history is still attached to that id
  expect(rowOn(PANE).chat.map((m) => m.text)).toEqual(["before restart"]);
  // and the /agents-shaped listing (sessions.values) shows only it
  const listed = [...S.sessions.values()].map((s) => ({ agentId: s.agentId, alive: s.alive }));
  expect(listed).toEqual([{ agentId: a, alive: true }]);
});

test("a later id-capture rolls the kept id, and a resume against it works", async () => {
  const a = await seedLive();
  S.adoptAgentId(PANE, a);
  reconcile([pane(PANE, null)]);      // silent fresh pane keeps A
  expect(rowOn(PANE).agentId).toBe(a);
  // opencode reaches session.idle and announces its new id: A rolls to SES2
  reconcile([pane(PANE, announced(SES2))]);
  expect(rowOn(PANE).agentId).toBe(a);
  expect(S.metaFor(a).sessionId).toBe(SES2);
  expect(S.metaFor(a).pastSessions).toEqual([SES1]);
  // a subsequent restart in resume mode now has an id to resume, and it is the
  // captured one (restart-preflight, the pure mode/sid/command decision)
  const s = rowOn(PANE);
  const adapter = {
    launchCommand: () => "opencode",
    resumeCommand: (_kind: string, sid: string) => `opencode --resume ${sid}`,
  };
  const pre = restartPreflight(s, "resume", adapter);
  expect(pre.ok).toBe(true);
  if (pre.ok) {
    expect(pre.sid).toBe(SES2);
    expect(pre.cmd).toMatch(new RegExp(`^env CYC_AGENT_ID=${a} opencode --resume ${SES2}$`));
  }
});
