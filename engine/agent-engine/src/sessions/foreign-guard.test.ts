/* THE FOREIGN-STEAL GUARD, the seam (foreign-guard.ts + hook-announce.ts +
 * reconcile.ts). The 2026-09-18 aiusage-grok bug: a grok cron's claude-compat
 * layer ran claude's SessionStart hook and POSTed grok's session id with a
 * STALE HERDR_PANE_ID it inherited, and the pane's live claude binding rolled
 * to a session whose transcript does not exist (the "Ctx n/a" flap).
 *
 * A witness placement onto a pane that holds a LIVE binding, by a DIFFERENT
 * process, of an id the agent does not know, must be REFUSED; the live bind
 * stays. A genuine claude /clear on the same pane (same process) still rolls.
 *
 * PURE UNIT over the shipped reconcile and the shipped hook-announce store:
 * session-state's maps in a throwaway data dir, the witness placement driven by
 * hand through takePending, the wired guard from foreign-guard.ts.
 *
 *   bun test agent-engine/src/sessions/foreign-guard.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { makeReconcile, resetReconcileForTest } from "./reconcile.ts";
import { liveBindGuard } from "./foreign-guard.ts";
import {
  handleAnnounce, hookBindFor, pendingAnnounces, recordHookBind, resetHookAnnounce,
  setLiveBindGuard, takePending,
} from "../terminal/hook-announce.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE, PREMINT_SOURCE, PARKED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentSessionRef } from "../runtime/agents.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { root, data } = await tmpDataDir("cyc-foreign-guard-");
process.env.CYC_DATA_DIR = data;
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
  setLiveBindGuard(null);
});

const U1 = "5efab001-1111-4aaa-8bbb-000000000001"; // the pane's real claude session
const U2 = "5efab002-2222-4ccc-8ddd-000000000002"; // a genuine /clear id
const GROK = "9dead999-9999-4fff-8aaa-000000000099"; // the foreign grok session
const PANE = "w3:p1";
const CWD = "/home/x/proj";
const CLAUDE_PID = 573000; // the pane's live claude
const GROK_PID = 573764; // the grok cron, a DIFFERENT process

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
  hasTranscript: () => false,
  canParseScreen: () => false,
  nativeDone: true,
  sweepTails: () => {},
  broadcastSessions: () => {},
  now: () => clock,
});

beforeEach(async () => {
  S.resetForTest();
  resetReconcileForTest();
  resetHookAnnounce();
  setLiveBindGuard(liveBindGuard);
  await S.chatStore.flush();
  await new Promise((r) => setTimeout(r, 50));
  await rm(join(data, "agents"), { recursive: true, force: true });
  await rm(join(data, "state"), { recursive: true, force: true });
  process.env.CYC_ANNOUNCE_GRACE_MS = "0";
  clock = 1_000_000;
});

const boot = async () => { await S.loadSessionState(deps); S.sessionStateReady(); };

function pane(handle: string, ref: AgentSessionRef | null, over: Partial<MuxAgentInfo> = {}): MuxAgentInfo {
  return {
    handle, title: "proj", cwd: CWD, lifecycle: "running", kind: "claude",
    harnessSessionId: ref && ref.kind === "id" && ref.source !== PREMINT_SOURCE && ref.source !== PARKED_SOURCE ? ref.id : null,
    agentSession: ref, workspace: "w", tab: null, displayAgent: null, stateChangeSeq: 0, statusHint: "idle",
    ...over,
  };
}
const announced = (id: string): AgentSessionRef => ({ id, kind: "id", source: ANNOUNCED_SOURCE });
const rowOn = (handle: string) => S.sessionByHandle(handle)!;

/** Stand up a LIVE claude session on PANE: its hook-bind (so the guard sees the
 *  pane's own pid) and its reconciled row + pane binding. Returns the agent id. */
async function liveClaudeOnPane(): Promise<string> {
  recordHookBind(PANE, U1, CLAUDE_PID); // the pane's real claude announced first
  await boot();
  reconcile([pane(PANE, announced(U1))]);
  const a = rowOn(PANE).agentId;
  expect(S.bindingOf(PANE)).toMatchObject({ agentId: a, sessionId: U1, alive: true });
  expect(S.sessions.get(a)!.alive).toBe(true);
  return a;
}

/** Drive the grok cron's witness announce onto PANE, exactly as the herdr lane
 *  would (park by handleAnnounce, place by takePending "witness"). */
async function grokWitnessAnnounce(sessionId = GROK, agentPid = GROK_PID): Promise<void> {
  await handleAnnounce(
    { sessionId, pid: 999999, herdrPane: PANE, cwd: "/some/grok/home" },
    { resolveAgentPid: async () => agentPid },
  );
  const p = pendingAnnounces().find((x) => x.sessionId === sessionId)!;
  takePending(p, PANE, "witness");
}

// -------------------------------------------------------------- the refusal

test("a foreign witness announce does NOT roll a live binding; the pane keeps its real session", async () => {
  const a = await liveClaudeOnPane();

  await grokWitnessAnnounce(); // the aiusage-grok cron fires

  // the steal was refused: the pane's hook-bind is untouched
  expect(hookBindFor(PANE)).toEqual({ sessionId: U1 });
  expect(S.sessionIndex.has(GROK), "grok's id never entered the index").toBe(false);

  // and reconcile, seeing the pane still report U1, keeps the live row intact:
  // no roll, ctx/model (harnessSessionId) preserved
  reconcile([pane(PANE, announced(U1))]);
  expect(rowOn(PANE).agentId).toBe(a);
  expect(rowOn(PANE).harnessSessionId).toBe(U1);
  expect(S.metaFor(a).sessionId).toBe(U1);
  expect(S.metaFor(a).pastSessions).toBeUndefined();
  expect(S.sessions.size).toBe(1);
});

test("the real session's next re-announce keeps working after a refused steal", async () => {
  const a = await liveClaudeOnPane();
  await grokWitnessAnnounce();
  // UserPromptSubmit re-announces U1 from the same claude: idempotent, still U1
  recordHookBind(PANE, U1, CLAUDE_PID);
  reconcile([pane(PANE, announced(U1))]);
  expect(rowOn(PANE).agentId).toBe(a);
  expect(rowOn(PANE).harnessSessionId).toBe(U1);
  expect(S.sessions.size).toBe(1);
});

test("a genuine claude /clear on the SAME pane (same process) still rolls", async () => {
  const a = await liveClaudeOnPane();
  // /clear: the pane's OWN claude re-announces a fresh id from the same pid
  const p = { sessionId: U2, pid: 999998, agentPid: CLAUDE_PID, herdrPane: PANE, tmuxPane: null,
    cwd: CWD, at: clock, harness: null, link: null };
  takePending(p as never, PANE, "witness");
  expect(hookBindFor(PANE), "same-process rollover is allowed").toEqual({ sessionId: U2 });
  reconcile([pane(PANE, announced(U2))]);
  expect(rowOn(PANE).agentId, "the same agent, rolled").toBe(a);
  expect(S.metaFor(a).sessionId).toBe(U2);
  expect(S.metaFor(a).pastSessions).toEqual([U1]);
  expect(S.sessions.size).toBe(1);
});

// ------------------------------------------------------- what is NOT refused

test("a --resume from a fresh process of an id the agent KNOWS is allowed (not a steal)", async () => {
  // the agent's current id is U2, with U1 in its past; a reopen (fresh pid)
  // announces U1 by witness. U1 is known: allowed.
  recordHookBind(PANE, U2, CLAUDE_PID);
  await boot();
  reconcile([pane(PANE, announced(U2))]);
  const a = rowOn(PANE).agentId;
  reconcile([pane(PANE, announced(U2))]); // settle
  // give the agent a past id via a genuine same-process roll first
  const roll = { sessionId: U2, pid: 1, agentPid: CLAUDE_PID, herdrPane: PANE, tmuxPane: null, cwd: CWD, at: clock, harness: null, link: null };
  takePending(roll as never, PANE, "witness");
  S.metaFor(a).pastSessions = [U1];
  const resume = { sessionId: U1, pid: 2, agentPid: 999001, herdrPane: PANE, tmuxPane: null, cwd: CWD, at: clock, harness: null, link: null };
  takePending(resume as never, PANE, "witness");
  expect(hookBindFor(PANE), "a known past id is a genuine resume, allowed").toEqual({ sessionId: U1 });
});

test("a witness announce onto a DEAD pane binding is allowed (a legit takeover)", async () => {
  const a = await liveClaudeOnPane();
  S.sessions.get(a)!.chat.push({ id: a, role: "user", text: "said", ts: 5 } as never);
  reconcile([]); // the pane closed: its binding goes dead (kept: it has history)
  expect(S.bindingOf(PANE)!.alive).toBe(false);
  // a fresh, different process announces an unknown id on the reused handle
  await grokWitnessAnnounce(GROK, 888888);
  expect(hookBindFor(PANE), "no live session to steal: the new id binds").toEqual({ sessionId: GROK });
});

test("the PID lane is never gated: a pid-matched placement always binds", async () => {
  await liveClaudeOnPane();
  // a placement on the pid lane means the announcer IS the pane's own process,
  // so it is never foreign even with an unknown id.
  await handleAnnounce(
    { sessionId: GROK, pid: 999999, herdrPane: PANE, cwd: CWD },
    { resolveAgentPid: async () => GROK_PID },
  );
  const p = pendingAnnounces().find((x) => x.sessionId === GROK)!;
  takePending(p, PANE, "pid");
  expect(hookBindFor(PANE)).toEqual({ sessionId: GROK });
});
