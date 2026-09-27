/* The running-subagent count over the reader-seam deps.
 *
 * subagent-count.ts reads the SAME runs the agents bar does (pi from its
 * status.json files, every other harness from the claude transcript) and counts
 * the running ones. This seam test drives pollOnce() directly over FAKE reads
 * -- no interval, no adapter, no real transcript parse -- and proves the count
 * matches the bar's own running test (endedTs === null), the size short-circuit
 * skips an unchanged claude transcript, a change is reported through
 * broadcastSessions, and a session going away clears its count.
 *
 *   bun test agent-engine/src/sessions/subagent-count.test.ts
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { manualClock } from "../runtime/clock.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import type { AgentRun } from "./session-events.ts";
import {
  initSubagentCount, pollOnce, resetForTest, runningCount,
  subagentsRunningOf, type SubagentCountSession,
} from "./subagent-count.ts";

const CWD = "/tmp/subagents-seam";
const CSID = "aa11bb22-cc33-4d44-8e55-ff6677889900";
let root: string;
let path: string;

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  toolUseId: "t1", agentId: "a1", ts: 1000, desc: "worker", endedTs: null, tokens: null, ...over,
});

// The runs the claude transcript reads back; the fake conversationRuns returns
// exactly these, so a test dials the count by editing this array.
let claudeRuns: AgentRun[] = [];
let piRunsById: AgentRun[] = [];
let conversationRunsCalls = 0;
let broadcasts = 0;

const claude: SubagentCountSession = {
  id: "s-claude", agent: { id: "claude" }, cwd: CWD, harnessSessionId: CSID,
  muxHandle: "w1:p1", alive: true,
};
const pi: SubagentCountSession = {
  id: "s-pi", agent: { id: "pi" }, cwd: CWD, harnessSessionId: null,
  muxHandle: "w1:p6", alive: true,
};

function writeBytes(s: string): void { writeFileSync(path, s); }

function wire(sessions: SubagentCountSession[]): void {
  initSubagentCount({
    sessions: () => sessions,
    transcriptFile: () => ({ path }),
    piRuns: async () => piRunsById,
    conversationRuns: async () => { conversationRunsCalls++; return { logExists: true, runs: claudeRuns }; },
    claudeTranscriptPath: () => path,
    broadcastSessions: () => { broadcasts++; },
    clock: manualClock(), // no real timer fires; we call pollOnce() by hand
  });
}

beforeEach(async () => {
  root = await tmpDir("subagents-seam");
  path = join(root, `${CSID}.jsonl`);
  claudeRuns = [];
  piRunsById = [];
  conversationRunsCalls = 0;
  broadcasts = 0;
  writeBytes("one\n");
});
afterEach(() => resetForTest());

test("runningCount is the bar's own test: only endedTs === null counts", () => {
  expect(runningCount([
    run({ endedTs: null }), run({ endedTs: 2000 }), run({ endedTs: null }),
  ])).toBe(2);
  expect(runningCount([])).toBe(0);
});

test("a claude session's running count is read from its transcript runs", async () => {
  claudeRuns = [run({ endedTs: null }), run({ toolUseId: "t2", endedTs: null }), run({ toolUseId: "t3", endedTs: 5 })];
  wire([claude]);
  await pollOnce();
  expect(subagentsRunningOf("s-claude")).toBe(2);
  expect(broadcasts).toBe(1);
});

test("an unchanged claude transcript is not re-parsed (the size short-circuit)", async () => {
  claudeRuns = [run({ endedTs: null })];
  wire([claude]);
  await pollOnce();
  expect(conversationRunsCalls).toBe(1);
  await pollOnce(); // same bytes: no re-parse, no change
  expect(conversationRunsCalls).toBe(1);
  expect(broadcasts).toBe(1);
});

test("a run finishing (a transcript write) drops the count and broadcasts", async () => {
  claudeRuns = [run({ endedTs: null }), run({ toolUseId: "t2", endedTs: null })];
  wire([claude]);
  await pollOnce();
  expect(subagentsRunningOf("s-claude")).toBe(2);
  // one finishes: the parser writes the closing result, so the file grows
  claudeRuns = [run({ endedTs: null }), run({ toolUseId: "t2", endedTs: 9000 })];
  writeBytes("one\ntwo\n");
  await pollOnce();
  expect(subagentsRunningOf("s-claude")).toBe(1);
  expect(broadcasts).toBe(2);
});

test("a pi session counts its status.json runs, no transcript short-circuit", async () => {
  piRunsById = [run({ endedTs: null }), run({ toolUseId: "p2", endedTs: null }), run({ toolUseId: "p3", endedTs: 5 })];
  wire([pi]);
  await pollOnce();
  expect(subagentsRunningOf("s-pi")).toBe(2);
  // pi runs move without any session-transcript write: the next poll re-reads
  piRunsById = [run({ endedTs: null })];
  await pollOnce();
  expect(subagentsRunningOf("s-pi")).toBe(1);
});

test("a session that goes away clears its count and broadcasts the drop", async () => {
  piRunsById = [run({ endedTs: null })];
  const roster = [pi];
  wire(roster);
  await pollOnce();
  expect(subagentsRunningOf("s-pi")).toBe(1);
  roster.pop(); // the pane left
  await pollOnce();
  expect(subagentsRunningOf("s-pi")).toBe(0);
  expect(broadcasts).toBe(2);
});

test("a non-claude, non-pi harness reads no runs and counts 0", async () => {
  const codex: SubagentCountSession = {
    id: "s-codex", agent: { id: "codex" }, cwd: CWD, harnessSessionId: "ses_x",
    muxHandle: "w1:p9", alive: true,
  };
  claudeRuns = [run({ endedTs: null })];
  wire([codex]);
  await pollOnce();
  expect(subagentsRunningOf("s-codex")).toBe(0);
  expect(conversationRunsCalls).toBe(0); // never asks the claude transcript for it
});
