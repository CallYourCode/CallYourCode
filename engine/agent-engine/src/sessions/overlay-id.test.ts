/* THE OVERLAY-CAPABLE SESSION ID ON THE WIRE (the harness-event-tails gate).
 *
 * The app's activity overlay renders only when the row carries a non-null
 * `claudeSessionId` (its historical wire key). The engine used to stamp it
 * claude-only, so codex/opencode activity rows were ingested and broadcast
 * but never painted. It is now DERIVED from the reader's declared
 * sessionEvents slot (readers/types.ts) through the adapter's
 * hasSessionEvents: any harness that tails activity advertises its harness
 * session id under the same key; a slotless reader stays null.
 *
 * The predicate under test is the REAL MuxAdapter's, read off the real
 * READERS table, and the rows are built by the REAL reconcile from mux
 * snapshots, so this fails if the frame reverts to the claude-only ternary
 * OR if a reader loses its declaration.
 *
 *   bun test agent-engine/src/sessions/overlay-id.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { FSWatcher } from "node:fs";
import * as S from "./session-state.ts";
import { makeReconcile, resetReconcileForTest } from "./reconcile.ts";
import { initSessionsFrame, sessionList, resetForTest as resetSessionsFrame } from "./sessions-frame.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest, resetForTest as resetIngest } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { WatcherPool } from "../runtime/watcher-pool.ts";
import { MuxAdapter, type MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { Multiplexer, MuxAgent } from "../terminal/mux.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { data } = await tmpDataDir("cyc-overlay-id-");
process.env.CYC_DATA_DIR = data;
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
  resetIngest();
  resetSessionsFrame();
});

const CLAUDE_ID = "5efab001-1111-4aaa-8bbb-000000000001";
const CODEX_ID = "01aa2233-44bb-7000-8000-556677889900";
const OC_ID = "ses_aaaa0000bbbbCCCCddddEEEE01";
const PI_ID = "01bb0000-0000-7000-8000-000000000001";

const deps: S.SessionStateDeps = { noteMinted: () => {}, broadcastSessions: () => {}, lineageOf: () => undefined };

/* The REAL readers-table predicate: a MuxAdapter over a stub mux, used only
 * for hasSessionEvents(kind). */
const stubMux = (): Multiplexer =>
  ({
    onAgents(cb: (a: MuxAgent[]) => void) { cb([]); },
    start() {},
    async readPane() { return { text: "", truncated: false }; },
    async sendText() {}, async sendKeys() {},
    async renamePane() {}, async closePane() {},
    workspaceOf() { return null; }, knownCwds() { return []; },
    async newTab() { return "w9:p1"; },
  }) as unknown as Multiplexer;
const adapter = new MuxAdapter(stubMux(), undefined, (x) => x,
  new WatcherPool(() => ({ close() {} }) as unknown as FSWatcher));

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
  tabs: "off", replyLevel: () => 1,
  // THE DERIVATION UNDER TEST: the real adapter's readers-table answer.
  hasSessionEvents: (kind) => adapter.hasSessionEvents(kind),
});
const reconcile = makeReconcile({
  hasTranscript: () => true,
  canParseScreen: () => false, nativeDone: false,
  sweepTails: () => {},
  broadcastSessions: () => {},
  log: () => {},
});

beforeEach(async () => {
  S.resetForTest();
  resetReconcileForTest();
  await S.chatStore.flush();
  await new Promise((r) => setTimeout(r, 50));
  await rm(join(data, "agents"), { recursive: true, force: true });
  await rm(join(data, "state"), { recursive: true, force: true });
  process.env.CYC_ANNOUNCE_GRACE_MS = "0";
});

function pane(handle: string, kind: string, sid: string): MuxAgentInfo {
  return {
    handle, title: kind, cwd: `/home/x/${kind}-proj`, lifecycle: "running", kind,
    harnessSessionId: kind === "claude" ? sid : null, // the lift is claude-only (toInfo)
    agentSession: { id: sid, kind: "id", source: ANNOUNCED_SOURCE },
    workspace: "w2", tab: null, displayAgent: null, stateChangeSeq: 0, statusHint: "idle",
  };
}

test("the readers-table predicate: exactly the harnesses that declare the slot", () => {
  expect(adapter.hasSessionEvents("claude")).toBe(true);
  expect(adapter.hasSessionEvents("codex")).toBe(true);
  expect(adapter.hasSessionEvents("opencode")).toBe(true);
  expect(adapter.hasSessionEvents("pi")).toBe(false); // live events ride its socket
  expect(adapter.hasSessionEvents("hermes")).toBe(false); // no reader at all
});

test("a codex/opencode row advertises the overlay-capable id on the wire; a slotless reader stays null with its id still carried", async () => {
  await S.loadSessionState(deps);
  S.sessionStateReady();
  reconcile([
    pane("w2:p1", "claude", CLAUDE_ID),
    pane("w2:p2", "codex", CODEX_ID),
    pane("w2:p3", "opencode", OC_ID),
    pane("w2:p4", "pi", PI_ID),
  ]);
  const rows = sessionList() as Array<{ agentId: string; claudeSessionId: string | null; harnessSessionId: string | null }>;
  const by = (kind: string) => {
    const r = rows.find((x) => x.agentId === kind);
    if (!r) throw new Error(`no ${kind} row in the frame`);
    return r;
  };
  // claude: byte-identical to the old claude-only derivation
  expect(by("claude").claudeSessionId).toBe(CLAUDE_ID);
  // the fix: the harnesses whose readers tail activity advertise THEIR id
  expect(by("codex").claudeSessionId).toBe(CODEX_ID);
  expect(by("opencode").claudeSessionId).toBe(OC_ID);
  /* pi: the id is CARRIED (harnessSessionId) but the overlay field is null,
   * proving the gate is the declared slot, not the presence of an id. */
  expect(by("pi").harnessSessionId).toBe(PI_ID);
  expect(by("pi").claudeSessionId).toBeNull();
});
