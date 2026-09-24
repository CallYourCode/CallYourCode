import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPiSubagentRuns, runFromStatus } from "./pi-subagent-runs.ts";

const SESSION = "/home/me/.pi/agent/sessions/--home-me-proj--/2026-09-24_01a0.jsonl";
const NOW = 1_790_262_500_000;
let root: string;

/** A status.json in the shape pi-subagents writes (fields read off live runs). */
function status(runId: string, over: Record<string, unknown> = {}) {
  return {
    runId, sessionId: SESSION, state: "running", pid: process.pid,
    startedAt: NOW - 60_000, lastUpdate: NOW - 1_000,
    steps: [{ agent: "delegate", sessionName: "delegate: Verify 318 partner emails", model: "claude-bridge/claude-opus-5-5" }],
    totalTokens: { input: 128, output: 18878, total: 19006 },
    ...over,
  };
}
function seed(runId: string, over: Record<string, unknown> = {}) {
  const d = join(root, "async-subagent-runs", runId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "status.json"), JSON.stringify(status(runId, over)));
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "pi-subagents-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a running run becomes a bar row: agent + title, model, tokens, no end", () => {
  const r = runFromStatus(status("4ac399c3-2d16-4611-bed4-89fa9912f31a") as never, SESSION, NOW);
  expect(r).toEqual({
    toolUseId: "pi-subagent:4ac399c3-2d16-4611-bed4-89fa9912f31a",
    agentId: "4ac399c3-2d16-4611-bed4-89fa9912f31a",
    ts: NOW - 60_000,
    desc: "delegate: Verify 318 partner emails",
    endedTs: null,
    tokens: "19k",
    source: "pi",
    model: "claude-opus-5-5",
  });
});

test("another session's run, a day-old finished run, and a dead 'running' run", () => {
  expect(runFromStatus(status("a1111111", { sessionId: "/other.jsonl" }) as never, SESSION, NOW)).toBeNull();
  expect(runFromStatus(status("a2222222", { state: "complete", endedAt: NOW - 25 * 3600_000 }) as never, SESSION, NOW)).toBeNull();
  // the runner is gone: closed at its last update, not shown as running forever
  const dead = runFromStatus(status("a3333333") as never, SESSION, NOW, () => false);
  expect(dead?.endedTs).toBe(NOW - 1_000);
});

test("reads this session's runs off disk, oldest first, skipping broken files", async () => {
  seed("b0000002", { startedAt: NOW - 10_000 });
  seed("b0000001", { startedAt: NOW - 20_000, state: "complete", endedAt: NOW - 15_000 });
  seed("b0000003", { sessionId: "/someone-else.jsonl" });
  mkdirSync(join(root, "async-subagent-runs", "b0000004"), { recursive: true });
  writeFileSync(join(root, "async-subagent-runs", "b0000004", "status.json"), "{half");
  const runs = await readPiSubagentRuns(SESSION, root, NOW);
  expect(runs.map((r) => [r.agentId, r.endedTs])).toEqual([["b0000001", NOW - 15_000], ["b0000002", null]]);
});
