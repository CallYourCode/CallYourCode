/* THE ROW'S AGE FOLLOWS THE STRETCH THE COMBINED STATUS IS IN.
 *
 * The owner's report (2026-09-02 10:36Z, agent ag-QJ3ejK6TIDB_s5Gr, herdr
 * pane w2:p6, Claude Code): the list row read "thinking · 7m" seconds after
 * his message went in. engine.log for that pane:
 *
 *   10:29:08 status.edge from=working to=working source=jsonl
 *   10:29:10 status.edge from=working to=idle    source=jsonl
 *   10:36:09 status.edge from=working to=working source=jsonl   <- his turn
 *   10:36:26 status.edge from=working to=idle    source=jsonl
 *   10:36:37 status.edge from=working to=working source=jsonl   <- "why 7m?"
 *
 * Every jsonl working edge logs from=working, even the one right after an
 * idle edge. Only two things write a session's status: applyJsonlStatus
 * (tails.ts, which logs) and the herdr snapshot rebuild (reconcile.ts, which
 * did not). So between 10:29:10 and 10:36:09 a herdr snapshot put the row
 * back to working on herdr's own `agent_status` (herdr's claude detector
 * reports working for a spinner, a background shell, waiting background
 * agents, MCP tasks still running: ~/.local/state/herdr/agent-detection/
 * remote/claude.toml) and restarted the stretch at that poll. The transcript
 * was silent for those seven minutes (any record would have logged an edge);
 * when his prompt landed at 10:36:09 the jsonl working edge found the row
 * already working and, same phase, kept the poll's stamp: "thinking · 7m".
 *
 * THE RULE (tails.ts header, #490): the mux is the only source of `blocked`;
 * a jsonl edge owns working<->idle. reconcile re-applied only the jsonl's
 * WORKING across polls ("herdr 0.8.0 does not report working at all", no
 * longer true) and let herdr's working stamp over a jsonl idle. Now the
 * jsonl's IDLE holds too: once the transcript closed the turn, the mux's
 * working is not a turn until the transcript says so, and that edge restarts
 * the stretch. A session with no transcript verdict yet still follows herdr
 * from either direction, and every mux-driven status change is logged.
 *
 * SEAM: the shipped reconcile + tails + sessions-frame over session-state in
 * a throwaway data dir; the herdr snapshot and the jsonl edges driven by hand
 * with the clock pinned to the real instants.
 *
 *   bun test agent-engine/src/sessions/turn-age.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { makeReconcile, resetReconcileForTest } from "./reconcile.ts";
import { initSessionsFrame, sessionList, resetForTest as resetSessionsFrame } from "./sessions-frame.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest, resetForTest as resetIngest } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { seedAgent } from "../test-utils/builders.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentStatus } from "../terminal/mux.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { root, data } = await tmpDataDir("cyc-turn-age-");
process.env.CYC_DATA_DIR = data;
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
  resetIngest();
  resetSessionsFrame();
});

const U1 = "5efab001-1111-4aaa-8bbb-000000000001";
const PANE = "w2:p6";
const deps: S.SessionStateDeps = { noteMinted: () => {}, broadcastSessions: () => {}, lineageOf: () => undefined };

/** 2026-09-02 hh:mm:ss UTC as epoch ms, the instants from engine.log. */
const at = (h: number, m: number, s: number) => Date.UTC(2026, 8, 2, h, m, s);
let clock = at(10, 28, 0);

type Edge = { from: string; to: string; source: string };
let edges: Edge[] = [];
const log = (event: string, f: Record<string, unknown>) => {
  if (event === "status.edge") edges.push({ from: String(f.from), to: String(f.to), source: String(f.source) });
};

/* The status tail: one subscription per handle, the edge callback captured so
 * a test fires the jsonl's verdict through the real applyJsonlStatus. */
const statusCbs = new Map<string, (edge: "working" | "idle") => void>();
let tailable = true;
initIngest({
  sessionOf: (id) => S.sessions.get(id),
  sessions: () => S.sessions.values(),
  broadcastSessions: () => {},
  subscribe: () => null,
  readTranscriptSpan: async () => ({ events: [], queueOps: [], consumed: [], delivered: [], offset: 0 }),
  subscribeStatus: (handle, cb) => {
    statusCbs.set(handle, cb);
    return () => { statusCbs.delete(handle); };
  },
  transcriptFile: () => (tailable ? { path: "/fake/transcript.jsonl", sessionId: U1 } : null),
  tailOf: () => undefined,
  setTail: () => {},
  log,
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
initSessionsFrame({
  engineCan: [], pluginDecls: () => [], voiceHealthy: () => true,
  voicePublicUrl: "", engineUser: "tester", engineHost: "homebox",
  tabs: "off", replyLevel: () => 1, hasSessionEvents: (k) => k === "claude",
});
const reconcile = makeReconcile({
  hasTranscript: () => true,
  canParseScreen: () => false, nativeDone: false,
  sweepTails: () => {},
  broadcastSessions: () => {},
  now: () => clock,
  log,
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
  edges = [];
  tailable = true;
  clock = at(10, 28, 0);
});

const boot = async () => { await S.loadSessionState(deps); S.sessionStateReady(); };

/** The pane as herdr's snapshot reports it, with herdr's own agent_status. */
function pane(statusHint: AgentStatus): MuxAgentInfo {
  return {
    handle: PANE, title: "cyc", cwd: "/home/x/cyc", lifecycle: "running", kind: "claude",
    harnessSessionId: U1, agentSession: { id: U1, kind: "id", source: ANNOUNCED_SOURCE },
    workspace: "w2", tab: null, displayAgent: null, stateChangeSeq: 0, statusHint,
  };
}
/** A herdr snapshot at `t`, i.e. one reconcile poll (or a status event). */
const herdr = (t: number, statusHint: AgentStatus) => { clock = t; reconcile([pane(statusHint)]); };
/** The transcript tail's verdict at `t`, through the real subscription. */
const jsonl = (t: number, edge: "working" | "idle") => {
  clock = t;
  const cb = statusCbs.get(PANE);
  if (!cb) throw new Error("no status tail on " + PANE);
  cb(edge);
};
/** What the sessions frame carries for the one row: the thinking flag the app
 *  renders and the stamp its age ticks from. */
const row = () => {
  const r = sessionList().find((x) => x.sessionAgentId === S.sessionByHandle(PANE)?.id) as
    { thinking: boolean; turnSince: number; status: string } | undefined;
  if (!r) throw new Error("row missing");
  return { thinking: r.thinking, turnSince: r.turnSince, status: r.status };
};
const lastEdge = () => edges.at(-1);

// ---------------------------------------------------------- the replay

test("the owner's 7m: a jsonl idle holds over the mux's working, and his prompt restarts the stretch", async () => {
  await boot();
  // the turn before his: herdr saw the spinner first, the tail attached on that poll
  herdr(at(10, 28, 0), "working");
  expect(row()).toEqual({ thinking: true, turnSince: at(10, 28, 0), status: "working" });
  expect(statusCbs.has(PANE)).toBe(true);

  // 10:29:08 the transcript agrees (a record landed): same stretch, same stamp
  jsonl(at(10, 29, 8), "working");
  expect(row()).toEqual({ thinking: true, turnSince: at(10, 28, 0), status: "working" });
  expect(lastEdge()).toEqual({ from: "working", to: "working", source: "jsonl" });

  // 10:29:10 turn_duration: the turn is over, waiting since now
  jsonl(at(10, 29, 10), "idle");
  expect(row()).toEqual({ thinking: false, turnSince: at(10, 29, 10), status: "idle" });
  expect(lastEdge()).toEqual({ from: "working", to: "idle", source: "jsonl" });

  /* 10:29:12 .. 10:36:00 herdr keeps reporting working (a background shell,
   * a spinner it still sees) while the transcript writes nothing. THE BUG
   * WAS HERE: the rebuild took herdr's working over the jsonl's idle and
   * restarted the stretch at 10:29:12, silently. The transcript closed the
   * turn, so the row stays waiting since 10:29:10. */
  for (let t = at(10, 29, 12); t <= at(10, 36, 0); t += 15_000) herdr(t, "working");
  expect(row()).toEqual({ thinking: false, turnSince: at(10, 29, 10), status: "idle" });
  expect(edges.length).toBe(2); // nothing changed, nothing logged

  // 10:36:09 his prompt landed: a NEW turn, thinking since now, from=idle
  jsonl(at(10, 36, 9), "working");
  expect(row()).toEqual({ thinking: true, turnSince: at(10, 36, 9), status: "working" });
  expect(lastEdge()).toEqual({ from: "idle", to: "working", source: "jsonl" });
  // and the age the row renders at 10:36:30 is 21s, not the poll's 7m
  expect(at(10, 36, 30) - row().turnSince).toBe(21_000);

  // 10:36:26 the reply landed; 10:36:30 herdr still says working; 10:36:37 his next prompt
  jsonl(at(10, 36, 26), "idle");
  expect(row()).toEqual({ thinking: false, turnSince: at(10, 36, 26), status: "idle" });
  herdr(at(10, 36, 30), "working");
  expect(row()).toEqual({ thinking: false, turnSince: at(10, 36, 26), status: "idle" });
  jsonl(at(10, 36, 37), "working");
  expect(row()).toEqual({ thinking: true, turnSince: at(10, 36, 37), status: "working" });
  expect(lastEdge()).toEqual({ from: "idle", to: "working", source: "jsonl" });
});

// ------------------------------------------------- the rule around it

test("the mux's working restarts the stretch when the transcript has not spoken, and is logged", async () => {
  await boot();
  herdr(at(10, 28, 0), "idle");
  expect(row()).toEqual({ thinking: false, turnSince: at(10, 28, 0), status: "idle" });
  // no jsonl verdict yet: herdr's working is the turn, and the poll logs the edge
  herdr(at(10, 28, 20), "working");
  expect(row()).toEqual({ thinking: true, turnSince: at(10, 28, 20), status: "working" });
  expect(lastEdge()).toEqual({ from: "idle", to: "working", source: "mux" });
  // the transcript's user record lands half a second later: same stretch
  jsonl(at(10, 28, 20) + 450, "working");
  expect(row().turnSince).toBe(at(10, 28, 20));
  expect(lastEdge()).toEqual({ from: "working", to: "working", source: "jsonl" });
  // an unchanged poll logs nothing
  const n = edges.length;
  herdr(at(10, 28, 35), "working");
  expect(edges.length).toBe(n);
});

test("herdr's own idle/done flavour still lands after a jsonl idle; herdr's working does not", async () => {
  await boot();
  herdr(at(10, 28, 0), "working");
  jsonl(at(10, 28, 5), "working");
  jsonl(at(10, 28, 9), "idle");
  // herdr settles to done: the waiting stretch keeps its stamp (done<->idle is bookkeeping)
  herdr(at(10, 28, 15), "done");
  expect(row()).toEqual({ thinking: false, turnSince: at(10, 28, 9), status: "done" });
  expect(lastEdge()).toEqual({ from: "idle", to: "done", source: "mux" });
  // herdr flips to working on a spinner: not a turn until the transcript says so
  herdr(at(10, 28, 30), "working");
  expect(row()).toEqual({ thinking: false, turnSince: at(10, 28, 9), status: "idle" });
  // a jsonl idle while herdr already says done is recorded without an edge
  jsonl(at(10, 28, 40), "idle");
  expect(row()).toEqual({ thinking: false, turnSince: at(10, 28, 9), status: "idle" });
});

test("blocked stays herdr's alone: it interrupts nothing and the answered turn keeps its stamp", async () => {
  await boot();
  herdr(at(10, 28, 0), "working");
  jsonl(at(10, 28, 1), "working");
  // a permission dialog mid-turn: one busy stretch, no restart (#411 by another door)
  herdr(at(10, 28, 30), "blocked");
  expect(row()).toEqual({ thinking: false, turnSince: at(10, 28, 0), status: "blocked" });
  expect(lastEdge()).toEqual({ from: "working", to: "blocked", source: "mux" });
  // a jsonl edge cannot touch blocked
  jsonl(at(10, 28, 31), "idle");
  expect(row().status).toBe("blocked");
  // he answers it: herdr says working again, the same stretch continues
  herdr(at(10, 28, 45), "working");
  expect(row()).toEqual({ thinking: true, turnSince: at(10, 28, 0), status: "working" });
  jsonl(at(10, 28, 46), "working");
  expect(row().turnSince).toBe(at(10, 28, 0));
});

test("#411 a restart keeps the row's age: the seed is the last stored message, and the polls after keep it", async () => {
  const T = at(9, 0, 0);
  const { agentId } = await seedAgent(root, U1, [{ id: "r", role: "user", text: "hi", ts: T }]);
  await boot();
  // first poll after the restart, an hour later: not now
  herdr(at(10, 0, 0), "idle");
  expect(S.sessions.get(agentId)!.turnSince).toBe(T);
  herdr(at(10, 0, 15), "idle");
  expect(S.sessions.get(agentId)!.turnSince).toBe(T);
  // the transcript's verdict on the restored session works the same way
  jsonl(at(10, 0, 20), "idle");
  expect(S.sessions.get(agentId)!.turnSince).toBe(T);
  herdr(at(10, 0, 30), "working");
  expect(S.sessions.get(agentId)!.turnSince).toBe(T);
  expect(S.sessions.get(agentId)!.status).toBe("idle");
  jsonl(at(10, 0, 31), "working");
  expect(S.sessions.get(agentId)!.turnSince).toBe(at(10, 0, 31));
});
