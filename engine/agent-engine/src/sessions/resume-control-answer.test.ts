/* THE RESUME-CONTROL ANSWER: hidden shape + roster clock.
 *
 * When the owner answers a terminal prompt from the app (the session-resume
 * picker, a yes/no dialog), onAnswer records his decision in the transcript as
 * one of his own messages, formatted `\u21a9 <label>` (chatmsg.CONTROL_ANSWER_
 * PREFIX). That row is a CONTROL INPUT, not a message he typed: the transcript
 * hides its bubble and the roster clock (lastActivity) must not let it drive the
 * time a row shows. This pins BOTH halves of the engine side:
 *   - isControlAnswer recognises the exact origin shape and nothing else, so the
 *     match is never a fuzzy search over arbitrary user text.
 *   - sessionList's lastActivity skips a trailing control-answer row and reads
 *     the real row before it, while a normal user row still drives the clock.
 *
 * The lastActivity half runs over the REAL sessions frame reading a real
 * session's chat, so it fails if lastActivityOf reverts to `s.chat.at(-1)?.ts`.
 *
 *   bun test agent-engine/src/sessions/resume-control-answer.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { makeReconcile, resetReconcileForTest } from "./reconcile.ts";
import { initSessionsFrame, sessionList, resetForTest as resetSessionsFrame } from "./sessions-frame.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest, resetForTest as resetIngest } from "../chat/ingest.ts";
import { CONTROL_ANSWER_PREFIX, isControlAnswer, type ChatMsg } from "../chat/chatmsg.ts";
import { ANNOUNCED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";

// --------------------------------------------------------- isControlAnswer

test("isControlAnswer matches the origin shape and only that shape", () => {
  // The exact row onAnswer writes: a user message whose text is the prefix +
  // the picked label.
  const answer = { role: "user", text: `${CONTROL_ANSWER_PREFIX}Resume full session as-is` };
  expect(isControlAnswer(answer)).toBe(true);
  // The prefix alone (a label-less control line) still matches.
  expect(isControlAnswer({ role: "user", text: CONTROL_ANSWER_PREFIX })).toBe(true);

  // Arbitrary user text is NOT a control answer: no fuzzy search.
  expect(isControlAnswer({ role: "user", text: "Resume full session as-is" })).toBe(false);
  expect(isControlAnswer({ role: "user", text: "hi there" })).toBe(false);
  expect(isControlAnswer({ role: "user", text: "" })).toBe(false);
  // The glyph mid-string (not a prefix) does not match.
  expect(isControlAnswer({ role: "user", text: `see ${CONTROL_ANSWER_PREFIX}here` })).toBe(false);
  // A claude row carrying the same prefix is not a user control answer.
  expect(isControlAnswer({ role: "claude", text: `${CONTROL_ANSWER_PREFIX}nope` })).toBe(false);
  // A non-string text is refused, not thrown on.
  expect(isControlAnswer({ role: "user", text: undefined as unknown as string })).toBe(false);
});

// ------------------------------------------------ lastActivity over the frame

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { data } = await tmpDataDir("cyc-resume-control-");
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
  tabs: "off", replyLevel: () => 1, hasSessionEvents: (k) => k === "claude",
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

function pane(): MuxAgentInfo {
  return {
    handle: PANE, title: "cyc", cwd: "/home/x/cyc", lifecycle: "running", kind: "claude",
    harnessSessionId: U1, agentSession: { id: U1, kind: "id", source: ANNOUNCED_SOURCE },
    workspace: "w2", tab: null, displayAgent: null, stateChangeSeq: 0, statusHint: "idle",
  };
}

const row = (id: string, role: "user" | "claude", text: string, ts: number): ChatMsg =>
  ({ id, role, text, ts }) as ChatMsg;
const control = (id: string, label: string, ts: number): ChatMsg =>
  row(id, "user", `${CONTROL_ANSWER_PREFIX}${label}`, ts);

/* Boot the frame, materialise the one claude session, set its chat, and return
 * the lastActivity the roster row carries. */
async function activityFor(chat: ChatMsg[]): Promise<number | undefined> {
  await S.loadSessionState(deps);
  S.sessionStateReady();
  reconcile([pane()]);
  const s = S.sessionByHandle(PANE);
  if (!s) throw new Error("no session for the pane");
  s.chat = chat;
  const r = sessionList().find((x) => x.sessionAgentId === s.id) as
    | { lastActivity?: number }
    | undefined;
  if (!r) throw new Error("no row in the frame");
  return r.lastActivity;
}

test("lastActivity skips a trailing control-answer row and reads the real row before it", async () => {
  const got = await activityFor([
    row("a", "user", "start it", 100),
    row("b", "claude", "on it", 200),
    control("c", "Resume full session as-is", 300),
  ]);
  // The clock is the real reply at 200, NOT the control answer at 300.
  expect(got).toBe(200);
});

test("more than one trailing control answer is skipped down to the real row", async () => {
  const got = await activityFor([
    row("a", "user", "hello", 100),
    control("b", "Resume full session as-is", 300),
    control("c", "Keep going", 400),
  ]);
  expect(got).toBe(100);
});

test("a normal user row as the newest still drives lastActivity", async () => {
  const got = await activityFor([
    row("a", "claude", "hey", 100),
    row("b", "user", "one more thing", 250),
  ]);
  expect(got).toBe(250);
});

test("a chat that is only ever control answers still shows the last row's time", async () => {
  const got = await activityFor([
    control("a", "Resume full session as-is", 300),
    control("b", "Keep going", 400),
  ]);
  expect(got).toBe(400);
});
