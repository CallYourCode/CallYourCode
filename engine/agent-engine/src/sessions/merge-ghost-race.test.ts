/* THE MULTI-PANE GHOST RACE: a provisional must fold into its established
 * agent EVEN when that agent is already live in a second pane.
 *
 * merge-ghost.test.ts proves the simple case: the provisional's own pane is
 * the only one reporting the survivor's id, so that pane wins the single-row
 * holder election and reconcile's absorb runs on it. This file proves the
 * RACE the owner hit with two panes open at once (BZ Builder, multi-pane):
 *
 *   - an established agent E is already LIVE in pane w2 (announcing its id U1),
 *   - a second pane w1 arrives parked inside the announce grace and is given a
 *     PROVISIONAL agent P; a line is said under P,
 *   - w1 then announces U1 -- the id the index already maps to E.
 *
 * Now BOTH panes resolve to E, so E gets ONE row and one holder. When the mux
 * lists E's own live pane (w2) first, w2 wins the holder election and w1
 * returns early -- so the absorb, which only ever ran for the holder pane's
 * own prior row, never fires for w1's provisional. P is orphaned: a dead row
 * with NO `mergedInto`, its line lost, that a reload does NOT fix (nothing on
 * disk points P at E). Case (b): P was only ever a placeholder for U1, so it
 * MUST absorb into E, exactly as the single-pane case does.
 *
 * Case (a) -- two DIFFERENT established sessions genuinely live at once, or an
 * established pane that announces another established agent's id -- must keep
 * the "live elsewhere" protection: no merge, no steal. The last test guards it.
 *
 *   bun test agent-engine/src/sessions/merge-ghost-race.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { makeReconcile, resetReconcileForTest } from "./reconcile.ts";
import { initSessionsFrame, broadcastSessions, resetForTest as resetSessionsFrame } from "./sessions-frame.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest, resetForTest as resetIngest } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE, PARKED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { seedAgent } from "../test-utils/builders.ts";
import { resetForTest as resetWire } from "../transport/wire.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentSessionRef } from "../runtime/agents.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { root, data } = await tmpDataDir("cyc-merge-ghost-race-");
process.env.CYC_DATA_DIR = data;
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
  resetIngest();
  resetSessionsFrame();
  resetWire();
});

const U1 = "5efab001-1111-4aaa-8bbb-000000000001";
const U2 = "5efab002-2222-4ccc-8ddd-000000000002";
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
});
const initFrame = () => initSessionsFrame({
  engineCan: [], pluginDecls: () => [], voiceHealthy: () => true,
  voicePublicUrl: "", engineUser: "tester", engineHost: "homebox", tabs: "off", replyLevel: () => 1,
  hasSessionEvents: (k) => k === "claude",
});
initFrame();
const reconcile = makeReconcile({
  hasTranscript: () => false, canParseScreen: () => false, sweepTails: () => {},
  broadcastSessions, now: () => clock,
});

beforeEach(async () => {
  S.resetForTest();
  resetReconcileForTest();
  resetSessionsFrame();
  resetWire();
  initFrame();
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
    harnessSessionId: ref && ref.kind === "id" && ref.source === ANNOUNCED_SOURCE ? ref.id : null,
    agentSession: ref, workspace: "w", tab: null, displayAgent: null, stateChangeSeq: 0, statusHint: "idle",
    ...over,
  };
}
const announced = (id: string): AgentSessionRef => ({ id, kind: "id", source: ANNOUNCED_SOURCE });
const parked: AgentSessionRef = { id: "", kind: "id", source: PARKED_SOURCE };

test("case (b): the provisional absorbs into an agent that is live in ANOTHER pane", async () => {
  const { agentId } = await seedAgent(root, U1, [{ id: "r", role: "user", text: "kept", ts: 1 }]);
  await boot();
  // E comes live in its own pane, announcing U1
  reconcile([pane("w2:p2", announced(U1))]);
  expect(S.sessionByHandle("w2:p2")!.agentId).toBe(agentId);

  // a SECOND pane arrives parked (no announce inside the grace) -> a provisional,
  // while E stays live in w2
  reconcile([pane("w2:p2", announced(U1)), pane("w1:p1", parked)]);
  const prov = S.sessionByHandle("w1:p1")!.agentId;
  expect(prov).not.toBe(agentId);
  // a line is said under the provisional
  S.sessions.get(prov)!.chat.push({ id: prov, role: "user", text: "said while parked", ts: 2000 } as never);

  // w1 now announces U1 -- E's id -- WHILE E is still live in w2. The mux lists
  // E's own pane FIRST, so w2 wins the single-row holder election; w1's absorb
  // must still fire even though its pane is not the holder.
  reconcile([pane("w2:p2", announced(U1)), pane("w1:p1", announced(U1))]);

  // the provisional is gone from the roster and left a tombstone (no ghost)
  expect(S.sessions.has(prov)).toBe(false);
  expect(S.agentMetas.has(prov)).toBe(false);
  expect([...S.sessions.keys()]).toEqual([agentId]);
  // the survivor holds BOTH rows, unioned, and its id resolves through the index
  expect(S.sessions.get(agentId)!.chat.map((m) => m.text)).toEqual(["kept", "said while parked"]);
  expect(S.agentIdFor(U1)).toBe(agentId);
  // and E is still live (on whichever pane won the holder election)
  expect(S.sessions.get(agentId)!.alive).toBe(true);
});

test("case (b): the same absorb when the mux lists the provisional's pane first", async () => {
  const { agentId } = await seedAgent(root, U1, [{ id: "r", role: "user", text: "kept", ts: 1 }]);
  await boot();
  reconcile([pane("w2:p2", announced(U1))]);
  reconcile([pane("w2:p2", announced(U1)), pane("w1:p1", parked)]);
  const prov = S.sessionByHandle("w1:p1")!.agentId;
  S.sessions.get(prov)!.chat.push({ id: prov, role: "user", text: "said while parked", ts: 2000 } as never);

  // list order flipped: w1 first. The result must be identical -- no orphan.
  reconcile([pane("w1:p1", announced(U1)), pane("w2:p2", announced(U1))]);

  expect(S.sessions.has(prov)).toBe(false);
  expect(S.agentMetas.has(prov)).toBe(false);
  expect([...S.sessions.keys()]).toEqual([agentId]);
  expect(S.sessions.get(agentId)!.chat.map((m) => m.text)).toEqual(["kept", "said while parked"]);
  expect(S.agentIdFor(U1)).toBe(agentId);
});

test("case (a): an ESTABLISHED pane announcing another live agent's id is NOT merged or stolen", async () => {
  // two real, established agents, each with its own session and its own chat
  const { agentId: e1 } = await seedAgent(root, U1, [{ id: "r1", role: "user", text: "one", ts: 1 }]);
  const { agentId: e2 } = await seedAgent(root, U2, [{ id: "r2", role: "user", text: "two", ts: 1 }]);
  await boot();
  // both come live in their own panes
  reconcile([pane("w1:p1", announced(U1)), pane("w2:p2", announced(U2))]);
  expect(S.sessionByHandle("w1:p1")!.agentId).toBe(e1);
  expect(S.sessionByHandle("w2:p2")!.agentId).toBe(e2);

  // w1 (established as E1) now ANNOUNCES U2 -- E2's id -- while E2 is live in w2.
  // This is a genuine second session live elsewhere: E1 must lose its pane to
  // E2, but NOTHING may be merged or tombstoned (E1's chat is not folded into
  // E2, no `mergedInto` on either).
  reconcile([pane("w1:p1", announced(U2)), pane("w2:p2", announced(U2))]);

  // both agents still exist; neither was absorbed
  expect(S.agentMetas.has(e1)).toBe(true);
  expect(S.agentMetas.has(e2)).toBe(true);
  expect(S.agentMetas.get(e1)!.mergedInto).toBeUndefined();
  expect(S.agentMetas.get(e2)!.mergedInto).toBeUndefined();
  // chats stayed put -- no theft of rows across the two real sessions
  const s1 = S.sessions.get(e1);
  expect(s1!.chat.map((m) => m.text)).toEqual(["one"]);
  expect(S.sessions.get(e2)!.chat.map((m) => m.text)).toEqual(["two"]);
  // E1 lost its live pane (it is now dead / history-only), E2 kept its own id
  expect(s1!.alive).toBe(false);
  expect(S.agentIdFor(U2)).toBe(e2);
});
