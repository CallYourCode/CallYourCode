/* THE MERGED-AGENT GHOST: a provisional that folds into an established agent
 * must leave the LIVE roster the instant the merge happens, and the change
 * must reach connected clients, with NO engine restart and NO client reload.
 *
 * The bug the owner reported (BZ Builder): a pane that reported no session id
 * inside the announce grace got a PROVISIONAL agent (reconcile.ts, rule 5);
 * the conversation logged under it; the pane then announced the real session
 * id, already indexed to an established agent, so reconcile called
 * absorb(provisional, target) (carry.ts). absorb unions the rows into the
 * survivor and tombstones the provisional's meta (`mergedInto`). The
 * load-time filter (session-state.ts, `if (meta.mergedInto) continue;`) keeps
 * a merged record out of the roster on the NEXT boot, which is why a restart
 * hid the duplicate. This proves the SAME must be true at runtime: the served
 * roster (the `sessions` map that both the ws sessions frame and GET /agents
 * read) drops the provisional in the same reconcile tick that writes the
 * tombstone, and the trailing broadcastSessions pushes the shorter list to
 * every watching client.
 *
 * SEAM: the shipped reconcile + the shipped sessions-frame broadcast over
 * session-state in a throwaway data dir, with a client registered on the real
 * wire so the push is observed exactly as a device would see it.
 *
 *   bun test agent-engine/src/sessions/merge-ghost.test.ts
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
import { clients, resetForTest as resetWire } from "../transport/wire.ts";
import type { Sock } from "../transport/sock.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentSessionRef } from "../runtime/agents.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { root, data } = await tmpDataDir("cyc-merge-ghost-");
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

/** A client on the real wire, capturing every frame it is sent. */
function watcher(): { frames: Record<string, unknown>[] } {
  const frames: Record<string, unknown>[] = [];
  const sock = { send: (s: string) => frames.push(JSON.parse(s)) } as unknown as Sock;
  clients.add(sock);
  return { frames };
}
/** The agent ids the app would list from a `{t:"sessions"}` frame. */
const idsIn = (frame: Record<string, unknown> | undefined) =>
  ((frame?.list as { id: string }[]) ?? []).map((r) => r.id);
const lastSessionsFrame = (frames: Record<string, unknown>[]) =>
  [...frames].reverse().find((f) => f.t === "sessions");

test("the runtime merge drops the provisional from the served roster with no restart", async () => {
  const { agentId } = await seedAgent(root, U1, [{ id: "r", role: "user", text: "kept", ts: 1 }]);
  await boot();
  // the pane arrives parked (no announce inside the grace): a provisional row
  reconcile([pane("w1:p1", parked)]);
  const prov = S.sessionByHandle("w1:p1")!.agentId;
  expect(prov).not.toBe(agentId);
  // a conversation logs under the provisional (pushed straight onto the row,
  // as reconcile.test does, so the seam needs no chat file on disk)
  S.sessions.get(prov)!.chat.push({ id: prov, role: "user", text: "said while parked", ts: 2000 } as never);

  // the pane now announces the real id, already indexed to the established agent
  reconcile([pane("w1:p1", announced(U1))]);

  // the served roster -- what GET /agents and the sessions frame both read --
  // no longer carries the provisional, in the SAME tick, without a restart
  expect(S.sessions.has(prov)).toBe(false);
  expect(S.agentMetas.has(prov)).toBe(false);
  expect([...S.sessions.keys()]).toEqual([agentId]);
  // the merge itself stays correct: the survivor holds both rows, unioned
  expect(S.sessions.get(agentId)!.chat.map((m) => m.text)).toEqual(["kept", "said while parked"]);
  // and the provisional's id still resolves to the survivor through the index
  expect(S.agentIdFor(U1)).toBe(agentId);
});

test("a watching client is pushed the shorter roster the instant the merge lands", async () => {
  const { agentId } = await seedAgent(root, U1, [{ id: "r", role: "user", text: "kept", ts: 1 }]);
  await boot();
  const w = watcher(); // a device already attached, watching the roster

  reconcile([pane("w1:p1", parked)]);
  const prov = S.sessionByHandle("w1:p1")!.agentId;
  S.sessions.get(prov)!.chat.push({ id: prov, role: "user", text: "hi", ts: 2000 } as never);
  reconcile([pane("w1:p1", parked)]); // a frame that DID list the provisional

  // the client really saw the ghost before the merge
  expect(w.frames.some((f) => f.t === "sessions" && idsIn(f).includes(prov)),
    "the provisional was on the wire before the merge").toBe(true);

  const before = w.frames.length;
  reconcile([pane("w1:p1", announced(U1))]); // the merge tick

  // a fresh sessions frame went out, and it no longer lists the provisional
  expect(w.frames.length).toBeGreaterThan(before);
  const last = lastSessionsFrame(w.frames)!;
  expect(idsIn(last)).toEqual([agentId]);
  expect(idsIn(last)).not.toContain(prov);
});
