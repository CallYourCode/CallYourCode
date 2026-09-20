/* DONE SYNTHESIS ON TMUX (fix 3, TMUXPARITY).
 *
 * tmux has no native `done`: its mux statusHint is only ever idle/blocked
 * (terminal/tmux.ts), so a completed turn never lights the finished-while-away
 * activity dot the way herdr's own done does. The engine synthesizes it, tmux
 * only, from the jsonl turn edge: when the tail closes a turn (working->idle)
 * and the mux is not nativeDone, reconcile holds the row at `done` as a LEVEL
 * so doneSeqFor sees the idle->done edge and bumps, exactly as herdr's native
 * done bumps it.
 *
 * This is the fail-before pair: on tmux (nativeDone:false) the closed turn
 * produces status "done" and a bumped doneSeq where the pre-fix path left
 * "idle" and doneSeq unchanged; the SAME edge on a herdr (nativeDone:true)
 * session is untouched (the regression guard).
 *
 * PURE UNIT over the shipped reconcile + applyJsonlStatus: session-state's
 * maps in a throwaway data dir, the poll driven by hand, the jsonl edge fed
 * through the real applyJsonlStatus.
 *
 *   bun test agent-engine/src/sessions/done-synth.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { makeReconcile, resetReconcileForTest } from "./reconcile.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest, applyJsonlStatus } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { seedAgent } from "../test-utils/builders.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentSessionRef } from "../runtime/agents.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { root, data } = await tmpDataDir("cyc-done-synth-");
process.env.CYC_DATA_DIR = data;
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
});

const U1 = "5efab001-1111-4aaa-8bbb-000000000001";
const CWD = "/home/x/proj";

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
  now: () => clock,
});

// tmux: no native done, so the synthesis is armed. herdr: native done, off.
const tmuxReconcile = makeReconcile({
  hasTranscript: () => false, canParseScreen: () => false, nativeDone: false,
  sweepTails: () => {}, broadcastSessions: () => {}, now: () => clock,
});
const herdrReconcile = makeReconcile({
  hasTranscript: () => false, canParseScreen: () => false, nativeDone: true,
  sweepTails: () => {}, broadcastSessions: () => {}, now: () => clock,
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
function pane(handle: string): MuxAgentInfo {
  return {
    handle, title: "proj", cwd: CWD, lifecycle: "running", kind: "claude",
    harnessSessionId: U1, agentSession: announced(U1), workspace: "w", tab: null,
    displayAgent: null, stateChangeSeq: 0, statusHint: "idle",
  };
}
const rowOn = (handle: string) => S.sessionByHandle(handle)!;

test("tmux: a jsonl turn working->idle synthesizes done and bumps doneSeq", async () => {
  // a real agent on disk so the announced id resolves stably across polls
  await seedAgent(root, U1, [{ id: "r", role: "user", text: "hi", ts: 1 }]);
  await boot();

  // first poll: the mux reports idle, the row is idle, nothing done yet
  tmuxReconcile([pane("w1:p1")]);
  const id = rowOn("w1:p1").id;
  expect(rowOn("w1:p1").status).toBe("idle");
  const doneSeq0 = rowOn("w1:p1").doneSeq;

  // the turn opens (jsonl tail), then the next poll carries it as working
  applyJsonlStatus(id, "working");
  expect(rowOn("w1:p1").status).toBe("working");
  tmuxReconcile([pane("w1:p1")]);
  expect(rowOn("w1:p1").status).toBe("working");
  expect(rowOn("w1:p1").doneSeq).toBe(doneSeq0); // a live turn is not done

  // the turn CLOSES: the tail sees working->idle. applyJsonlStatus records the
  // idle verdict (jsonlStatus) and drops the live row to idle...
  applyJsonlStatus(id, "idle");
  expect(rowOn("w1:p1").status).toBe("idle");
  expect(rowOn("w1:p1").jsonlStatus).toBe("idle");

  // ...and the next poll SYNTHESIZES done from that closed turn and bumps the
  // activity seq, where the pre-fix path left the row idle at doneSeq0.
  tmuxReconcile([pane("w1:p1")]);
  expect(rowOn("w1:p1").status).toBe("done");
  expect(rowOn("w1:p1").doneSeq).toBe(doneSeq0 + 1);

  // held as a LEVEL: a quiet poll keeps done at the same seq (no churn)
  tmuxReconcile([pane("w1:p1")]);
  expect(rowOn("w1:p1").status).toBe("done");
  expect(rowOn("w1:p1").doneSeq).toBe(doneSeq0 + 1);
});

test("herdr guard: the SAME closed turn is unchanged on a nativeDone mux", async () => {
  await seedAgent(root, U1, [{ id: "r", role: "user", text: "hi", ts: 1 }]);
  await boot();

  herdrReconcile([pane("w1:p1")]);
  const id = rowOn("w1:p1").id;
  const doneSeq0 = rowOn("w1:p1").doneSeq;

  applyJsonlStatus(id, "working");
  herdrReconcile([pane("w1:p1")]);
  expect(rowOn("w1:p1").status).toBe("working");

  applyJsonlStatus(id, "idle");
  herdrReconcile([pane("w1:p1")]);
  // no synthesis on a native-done mux: the row keeps herdr's own idle/done
  // value (here plain idle, since the mux statusHint is idle) and doneSeq is
  // left for herdr's own done to move.
  expect(rowOn("w1:p1").status).toBe("idle");
  expect(rowOn("w1:p1").doneSeq).toBe(doneSeq0);
});
