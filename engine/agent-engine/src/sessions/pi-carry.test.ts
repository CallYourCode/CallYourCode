/* LATE IDENTITY ONTO A PRE-MINTED PANE (reconcile.ts, the /new-session carry).
 *
 * A pane the engine pre-minted (POST /new-session -> adoptAgentId) is bound to
 * its stable agent id BEFORE the harness announces. The harness (pi, over
 * /harness/announce) then names its session id, and the herdr witness bind
 * records it. reconcile must carry that ANNOUNCED id onto the SAME pre-minted
 * agent, so the id /new-session handed the app resolves and a resume works.
 *
 * The happy path (the pane stays in the snapshot the whole time) already
 * carries via alive pane-continuity, and that is locked here. The defect this
 * file drives red-to-green is the herdr STAMPING GAP: a node-launched pi drops
 * out of the stamped snapshot for a beat, and the pre-minted pane must not be
 * stranded -- its (identity-pending) binding stays alive so the late announce
 * reclaims the ORIGINAL agent instead of minting a stranger. The dead-binding
 * fence (an ESTABLISHED session that truly exited never rejoins) and the
 * folder-guess fence (only an ANNOUNCED id carries this way) are both proven to
 * still hold, and claude -- whose id is present at first resolution -- is a
 * no-op through it all.
 *
 *   bun test agent-engine/src/sessions/pi-carry.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { makeReconcile, resetReconcileForTest } from "./reconcile.ts";
import { restartPreflight } from "../routes/session-ops.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentSessionRef } from "../runtime/agents.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { root, data } = await tmpDataDir("cyc-pi-carry-");
process.env.CYC_DATA_DIR = data;
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
});

const PI = "3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9";
const PI2 = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
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

const reconcile = makeReconcile({
  hasTranscript: () => false, canParseScreen: () => false,
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
const guessed = (id: string): AgentSessionRef => ({ id, kind: "id", source: "herdr:pi" });

/** A pane as the herdr lane reports it. harnessSessionId is lifted claude-only
 *  (mux-adapter.ts toInfo), so a pi pane carries null there and its id rides
 *  agentSession alone -- exactly the shape evidenceOf reads for pi. */
function pane(handle: string, ref: AgentSessionRef | null, kind = "pi"): MuxAgentInfo {
  return {
    handle, title: "proj", cwd: CWD, lifecycle: "running", kind,
    harnessSessionId: kind === "claude" && ref?.kind === "id" && ref.source === ANNOUNCED_SOURCE ? ref.id : null,
    agentSession: ref, workspace: "w", tab: null, displayAgent: null, stateChangeSeq: 0, statusHint: "idle",
  };
}
const rowOn = (h: string) => S.sessionByHandle(h);

/** The restart route's resume decision, over a pi reader capability. Succeeds
 *  only when the row carries a harness session id to resume to. */
const resumeAdapter = { launchCommand: () => "pi", resumeCommand: (_k: string, sid: string) => `pi --session ${sid}` };
const resumeOk = (h: string): boolean => {
  const s = rowOn(h)!;
  return restartPreflight(s, "resume", resumeAdapter).ok;
};

// ------------------------------------------------------------- happy path

test("HAPPY: a pre-minted pi pane bound with no id carries a LATER announced id (same tick order, no gap)", async () => {
  await boot();
  const aid = S.freshAgentId();
  S.adoptAgentId("w1:pZ", aid); // /new-session pre-mint + bind
  // tick 1: the announce has not landed; the pane resolves via its binding
  reconcile([pane("w1:pZ", null)]);
  expect(rowOn("w1:pZ")!.agentId).toBe(aid);
  expect(rowOn("w1:pZ")!.harnessSessionId).toBeNull();
  expect(resumeOk("w1:pZ"), "no id yet, resume refused").toBe(false);
  // tick 2: the /harness/announce bind is present -> ANNOUNCED ref
  reconcile([pane("w1:pZ", announced(PI))]);
  expect(rowOn("w1:pZ")!.agentId, "the SAME pre-minted agent").toBe(aid);
  expect(rowOn("w1:pZ")!.harnessSessionId).toBe(PI);
  expect(S.metaFor(aid).sessionId).toBe(PI);
  expect(resumeOk("w1:pZ"), "resume works once the id has arrived").toBe(true);
});

// ------------------------------------------- the defect: the stamping gap

test("GAP (red->green): the pre-minted pane drops out of the snapshot, the announce lands, the pane returns", async () => {
  await boot();
  const aid = S.freshAgentId();
  S.adoptAgentId("w1:pZ", aid);
  reconcile([pane("w1:pZ", null)]); // bound, no id
  expect(rowOn("w1:pZ")!.agentId).toBe(aid);
  // the node-launched pi pane is momentarily unstamped: herdr drops it from the
  // stamped snapshot, so reconcile reads it as gone
  reconcile([]);
  // the empty pre-mint row is purged, but its pending binding (sessionId null)
  // SURVIVES, dead, so the coming announce can reclaim the pre-minted agent
  expect(S.bindingOf("w1:pZ"), "the pending binding survives the purge").toBeDefined();
  expect(S.bindingOf("w1:pZ")!.sessionId, "still identity-pending").toBeNull();
  // the /harness/announce lands while the pane is absent, then the pane returns
  reconcile([pane("w1:pZ", announced(PI))]);
  const s = rowOn("w1:pZ")!;
  expect(s.agentId, "the id lands on the ORIGINAL /new-session agent, not a stranger").toBe(aid);
  expect(s.harnessSessionId).toBe(PI);
  expect(S.metaFor(aid).sessionId).toBe(PI);
  expect(resumeOk("w1:pZ")).toBe(true);
  expect(S.sessions.size, "one row, no orphan").toBe(1);
});

// ------------------------------------------------------ the fences hold

test("FENCE (folder guess): a NON-announced ref returning after the gap does NOT carry", async () => {
  process.env.CYC_ANNOUNCE_GRACE_MS = "10000"; // a guess must wait out the grace
  await boot();
  const aid = S.freshAgentId();
  S.adoptAgentId("w1:pZ", aid);
  reconcile([pane("w1:pZ", null)]);
  reconcile([]); // the gap
  // the pane returns carrying only a herdr GUESS (a transcript locator), no
  // announce: within the grace it counts for nothing, so nothing is carried
  reconcile([pane("w1:pZ", guessed(PI))]);
  // no id is carried from a guess: the reclaim is announced-only, so the guess
  // waits out the grace and the pane resolves with NO session id (whichever
  // agent id it lands on, the pre-minted id is not falsely resumed from a guess)
  expect(rowOn("w1:pZ")!.harnessSessionId, "a folder guess never carries an id").toBeNull();
  expect(resumeOk("w1:pZ"), "resume stays refused off a mere guess").toBe(false);
  expect(S.sessionIndex.get(PI), "the guessed id was never indexed to any agent").toBeUndefined();
});

test("FENCE (dead binding): an ESTABLISHED pi session that truly exits never rejoins a stranger", async () => {
  await boot();
  const aid = S.freshAgentId();
  S.adoptAgentId("w1:pZ", aid);
  reconcile([pane("w1:pZ", announced(PI))]); // adopts PI: now ESTABLISHED, not pre-mint
  expect(rowOn("w1:pZ")!.harnessSessionId).toBe(PI);
  S.sessions.get(aid)!.chat.push({ id: aid, role: "user", text: "said", ts: 5 } as never);
  reconcile([]); // the pane exits for real
  expect(S.sessions.get(aid)!.alive).toBe(false);
  expect(S.bindingOf("w1:pZ")!.alive, "an established session's binding dies with the pane").toBe(false);
  // a stranger announces in the reused handle: it is a NEW agent, PI stays with aid
  reconcile([pane("w1:pZ", announced(PI2))]);
  expect(rowOn("w1:pZ")!.agentId, "whatever comes back is new").not.toBe(aid);
  expect(S.metaFor(aid).sessionId).toBe(PI);
  expect(S.metaFor(aid).pastSessions).toBeUndefined();
});

// ------------------------------------------------------ claude no-op

test("REGRESSION (claude): first resolution unchanged; its id is present at once, the gap path is a no-op", async () => {
  await boot();
  const aid = S.freshAgentId();
  S.adoptAgentId("w2:pC", aid);
  // claude announces its id at first resolution (its hook fires on SessionStart)
  reconcile([pane("w2:pC", announced(PI), "claude")]);
  const s = rowOn("w2:pC")!;
  expect(s.agentId).toBe(aid);
  expect(s.harnessSessionId, "claude carries its id on the one session-id field too").toBe(PI);
  expect(S.metaFor(aid).sessionId).toBe(PI);
});
