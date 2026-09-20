/* THE ROTATION TICK SEES THE ID THE ROW ANSWERED TO LAST TICK.
 *
 * reconcile keys every row by agent id, so a harness rolling its session
 * (/clear, fork, resume) keeps the row; what has to change on that tick is
 * the transcript-bound state: the ingest tail (an fs watch bound to the OLD
 * jsonl path at subscribe time, mux-adapter.ts subscribe), and the
 * transcript's working/idle verdict (jsonlStatus, the old file's last edge).
 * What does NOT change is the agent's own log: the records the old tail
 * appended stay on the row (they are the agent's history, not the file's),
 * and the old transcript's read pointer stays in the meta (it names where a
 * re-read of THAT file resumes).
 *
 * THE BUG (found 2026-09-02 while fixing the 7m turn age): reconcile read
 * `prev = sessions.get(key)` and then called adoptSession, which rewrites
 * harnessSessionId ON THAT SAME LIVE ROW (carry.ts). By the
 * time `rotated` compared prev's claude tail id to the new id they were
 * already equal, so on the one tick a rollover is adopted nothing rotated:
 * the old tail stayed attached to transcript A, and the file-bound state
 * (then: the loaded event backlog; now: jsonlStatus) was carried into
 * transcript B. Every later tick compared B to B and agreed. The pre-adopt
 * id is now read before adoptSession runs.
 *
 * SEAM: the shipped reconcile + carry + ingest over session-state in a
 * throwaway data dir; the mux snapshot driven by hand, the adapter's
 * subscribe replaced by a recorder that binds the path the way the real one
 * does (at subscribe time, from the pane's reported id).
 *
 *   bun test agent-engine/src/sessions/rollover-tail.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { makeReconcile, resetReconcileForTest } from "./reconcile.ts";
import { initChatlog, logSession } from "../chat/chatlog.ts";
import { initIngest, hasIngest, resetForTest as resetIngest } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { seedAgent } from "../test-utils/builders.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentStatus } from "../terminal/mux.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { root, data } = await tmpDataDir("cyc-rollover-tail-");
process.env.CYC_DATA_DIR = data;
afterAll(async () => {
  await S.chatStore.flush(); // the divider's append lands before the tmp dir goes
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
  resetIngest();
});

const A = "5efab001-1111-4aaa-8bbb-00000000000a";
const B = "5efab001-2222-4aaa-8bbb-00000000000b";
const PANE = "w2:p6";
const deps: S.SessionStateDeps = { noteMinted: () => {}, broadcastSessions: () => {}, lineageOf: () => undefined };

const at = (h: number, m: number, s: number) => Date.UTC(2026, 8, 2, h, m, s);
let clock = at(10, 0, 0);

/* The pane's reported id, what the adapter's subscribe/transcriptFile read at
 * call time (infoFor(handle) in mux-adapter.ts). */
let paneId = A;
const pathOf = (id: string) => `/fake/projects/cyc/${id}.jsonl`;

/* The recorder standing in for the adapter's transcript subscribe: the path
 * is bound when the watch is made, exactly as the real one binds it, and
 * stays until the returned stop runs. The fake files are empty (at: 0), so
 * no backfill is ever owed. */
type Watch = { path: string; open: boolean };
let watches: Watch[] = [];
const statusCbs = new Map<string, (edge: "working" | "idle") => void>();

initIngest({
  sessionOf: (id) => S.sessions.get(id),
  sessions: () => S.sessions.values(),
  broadcastSessions: () => {},
  subscribe: () => {
    const w: Watch = { path: pathOf(paneId), open: true };
    watches.push(w);
    return { stop: () => { w.open = false; }, at: 0 };
  },
  readTranscriptSpan: async () => ({ events: [], queueOps: [], consumed: [], delivered: [], offset: 0 }),
  subscribeStatus: (handle, cb) => {
    statusCbs.set(handle, cb);
    return () => { statusCbs.delete(handle); };
  },
  transcriptFile: () => ({ path: pathOf(paneId), sessionId: paneId }),
  tailOf: (aid, sid) => S.agentMetas.get(aid)?.tails?.[sid],
  setTail: (aid, sid, ptr) => {
    const meta = S.metaFor(aid);
    if (ptr) (meta.tails ??= {})[sid] = ptr;
    else if (meta.tails) delete meta.tails[sid];
  },
  log: () => {},
  now: () => clock,
});
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
const reconcile = makeReconcile({
  hasTranscript: () => true,
  canParseScreen: () => false,
  sweepTails: () => {},
  broadcastSessions: () => {},
  now: () => clock,
});

beforeEach(async () => {
  S.resetForTest();
  resetReconcileForTest();
  for (const [h] of statusCbs) statusCbs.delete(h);
  await S.chatStore.flush();
  await new Promise((r) => setTimeout(r, 50));
  await rm(join(data, "agents"), { recursive: true, force: true });
  await rm(join(data, "state"), { recursive: true, force: true });
  process.env.CYC_ANNOUNCE_GRACE_MS = "0";
  clock = at(10, 0, 0);
  paneId = A;
  watches = [];
});

const boot = async () => { await S.loadSessionState(deps); S.sessionStateReady(); };

/** The pane as the mux snapshot reports it, on whatever id it announces now. */
function pane(statusHint: AgentStatus): MuxAgentInfo {
  return {
    handle: PANE, title: "cyc", cwd: "/home/x/cyc", lifecycle: "running", kind: "claude",
    harnessSessionId: paneId, agentSession: { id: paneId, kind: "id", source: ANNOUNCED_SOURCE },
    workspace: "w2", tab: null, displayAgent: null, stateChangeSeq: 0, statusHint,
  };
}
const herdr = (t: number, statusHint: AgentStatus) => { clock = t; reconcile([pane(statusHint)]); };
const jsonl = (t: number, edge: "working" | "idle") => {
  clock = t;
  const cb = statusCbs.get(PANE);
  if (!cb) throw new Error("no status tail on " + PANE);
  cb(edge);
};

/** Bring the agent up on transcript A with the ingest tail attached, one
 *  record the tail appended on the row and the transcript's idle verdict
 *  recorded. */
async function onTranscriptA(): Promise<string> {
  const { agentId } = await seedAgent(root, A, [{ id: "r", role: "user", text: "hi", ts: at(9, 0, 0) }]);
  await boot();
  herdr(at(10, 0, 0), "working");
  const s = S.sessions.get(agentId)!;
  expect(s.harnessSessionId).toBe(A);
  expect(hasIngest(agentId)).toBe(true);
  expect(watches).toEqual([{ path: pathOf(A), open: true }]);
  expect(S.metaFor(agentId).tails?.[A]).toMatchObject({ h: "claude", off: 0 });
  // the tail appended A's first record onto the row's log; the tail closed A's last turn
  logSession(s, { ts: at(10, 0, 1), kind: "prompt", text: "hi", src: { h: "claude", sid: A, rid: "u1", off: 0 } });
  expect(s.log.map((r) => r.text)).toEqual(["hi"]);
  jsonl(at(10, 0, 5), "idle");
  expect(S.sessions.get(agentId)).toMatchObject({ jsonlStatus: "idle", status: "idle", turnSince: at(10, 0, 5) });
  return agentId;
}

test("the tick that adopts the rollover stops A's tail, starts B's, keeps the log and drops A's verdict", async () => {
  const agentId = await onTranscriptA();

  // one tick later the pane announces B (/clear): the row stays, the file changed
  paneId = B;
  herdr(at(10, 0, 20), "working");

  const s = S.sessions.get(agentId)!;
  expect(s.harnessSessionId).toBe(B);
  // the rollover was adopted: B is current, A is a past id of the same agent
  expect(S.metaFor(agentId).sessionId).toBe(B);
  expect(S.metaFor(agentId).pastSessions).toEqual([A]);
  // a plain rollover is same-conversation churn: adopted, but no chat pill
  // (owner call 2026-09-08)
  expect(s.chat.some((m) => m.kind === "system" && m.text.startsWith("new session"))).toBe(false);

  // THE BUG: A's watch stayed open and no watch was ever made for B
  expect(watches).toEqual([{ path: pathOf(A), open: false }, { path: pathOf(B), open: true }]);
  expect(hasIngest(agentId)).toBe(true);
  // B has its own read pointer now; A's stays (where a re-read of A resumes)
  expect(S.metaFor(agentId).tails?.[B]).toMatchObject({ h: "claude", off: 0 });
  expect(S.metaFor(agentId).tails?.[A]).toMatchObject({ h: "claude", off: 0 });
  // the agent's log is the agent's: A's records stay, and the status edges
  // (A's idle verdict, this tick's working) are records beside them
  expect(s.log.map((r) => r.text)).toEqual(["hi", "status: idle", "status: working"]);
  expect(s.log[0]).toMatchObject({ text: "hi", src: { sid: A } });
  // ...and A's verdict rode into B
  expect(s.jsonlStatus).toBeUndefined();
  // with no verdict on the new file, herdr's working is the turn: a new busy
  // stretch, stamped at this tick (the existing rule, turn.ts)
  expect(s.status).toBe("working");
  expect(s.turnSince).toBe(at(10, 0, 20));
});

test("a rollover into the same phase keeps the stretch's stamp (#411's rule, unchanged)", async () => {
  const agentId = await onTranscriptA();
  herdr(at(10, 0, 10), "idle");
  expect(S.sessions.get(agentId)!.turnSince).toBe(at(10, 0, 5));
  paneId = B;
  herdr(at(10, 0, 20), "idle");
  const s = S.sessions.get(agentId)!;
  expect(s.harnessSessionId).toBe(B);
  expect(s.jsonlStatus).toBeUndefined();
  expect(s.log[0]).toMatchObject({ text: "hi", src: { sid: A } });
  expect(watches).toEqual([{ path: pathOf(A), open: false }, { path: pathOf(B), open: true }]);
  // idle before, idle after: the waiting stretch began when A's turn closed
  expect(s).toMatchObject({ status: "idle", turnSince: at(10, 0, 5) });
});

test("a steady tick after the rollover rotates nothing", async () => {
  const agentId = await onTranscriptA();
  paneId = B;
  herdr(at(10, 0, 20), "working");
  const s = S.sessions.get(agentId)!;
  logSession(s, { ts: at(10, 0, 21), kind: "prompt", text: "again", src: { h: "claude", sid: B, rid: "u2", off: 0 } });
  const logBefore = s.log;
  jsonl(at(10, 0, 25), "working");
  herdr(at(10, 0, 30), "working");
  const s2 = S.sessions.get(agentId)!;
  expect(s2.log).toBe(logBefore);
  expect(s2.log.map((r) => r.text)).toEqual(["hi", "status: idle", "status: working", "again"]);
  expect(s2.jsonlStatus).toBe("working");
  expect(watches).toEqual([{ path: pathOf(A), open: false }, { path: pathOf(B), open: true }]);
});
