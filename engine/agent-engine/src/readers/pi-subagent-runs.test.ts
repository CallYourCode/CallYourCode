import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  piSubagentRunsCached, piSubagentRunsFresh, readPiSubagentRuns, refreshPiSubagentCache,
  resetPiSubagentCacheForTest, runFromStatus,
} from "./pi-subagent-runs.ts";
import { runningCount } from "../sessions/subagent-count.ts";

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

// The shared cache the count poll and the agents-bar route serve from. Each
// cache test gets its OWN root so leftover runs from other tests cannot leak
// into the whole-dir scan.
afterEach(() => resetPiSubagentCacheForTest());

function freshRoot(): string { return mkdtempSync(join(tmpdir(), "pi-subagents-cache-")); }
function seedIn(r: string, runId: string, over: Record<string, unknown> = {}): string {
  const d = join(r, "async-subagent-runs", runId);
  mkdirSync(d, { recursive: true });
  const p = join(d, "status.json");
  writeFileSync(p, JSON.stringify(status(runId, over)));
  return p;
}

// Relevant fields copied read-only from six VLC Reskin status.json files on
// 2026-10-13. Workflow pids were the parent pi pid, not subagent runners.
const workflowStatuses = JSON.parse(readFileSync(
  new URL("../fixtures/pi-subagent-workflow-statuses.json", import.meta.url), "utf8",
)) as Array<Parameters<typeof runFromStatus>[0] & { mode: string; parentWorkflowRunId?: string }>;
const WORKFLOW_SESSION = workflowStatuses[0]!.sessionId!;
const WORKFLOW_NOW = 1_791_908_900_000;

test("three real subagents plus their workflow wrappers give three bar rows and three running", async () => {
  const r = freshRoot();
  try {
    for (const s of workflowStatuses) {
      const d = join(r, "async-subagent-runs", s.runId!);
      mkdirSync(d, { recursive: true });
      // Preserve the real shapes, but use our own live pid for a stable test.
      writeFileSync(join(d, "status.json"), JSON.stringify({ ...s, pid: process.pid }));
    }
    const children = workflowStatuses.filter((s) => s.mode === "single");
    expect(children.map((s) => s.parentWorkflowRunId).sort()).toEqual(
      workflowStatuses.filter((s) => s.mode === "workflow").map((s) => s.runId).sort(),
    );
    const rows = await readPiSubagentRuns(WORKFLOW_SESSION, r, WORKFLOW_NOW);
    expect(runningCount(rows)).toBe(3);
    expect(rows.map((row) => row.agentId)).toEqual(
      children.sort((a, b) => a.startedAt! - b.startedAt!).map((s) => s.runId!),
    );
    await refreshPiSubagentCache(r, WORKFLOW_NOW);
    expect(piSubagentRunsCached(WORKFLOW_SESSION, WORKFLOW_NOW)).toEqual(rows);
    expect(await piSubagentRunsFresh(WORKFLOW_SESSION, r, WORKFLOW_NOW)).toEqual(rows);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a workflow before its child starts and a finished workflow are never subagent rows", () => {
  const wrapper = workflowStatuses.find((s) => s.mode === "workflow")!;
  // A wrapper alone does not imply a child runner has started.
  expect(runFromStatus(wrapper, WORKFLOW_SESSION, WORKFLOW_NOW, () => true)).toBeNull();
  expect(runFromStatus({ ...wrapper, state: "complete", endedAt: WORKFLOW_NOW - 1_000 },
    WORKFLOW_SESSION, WORKFLOW_NOW, () => true)).toBeNull();
  // Its finished child still has a recent row, just not a running count.
  const child = workflowStatuses.find((s) => s.mode === "single")!;
  const row = runFromStatus({ ...child, state: "complete", endedAt: WORKFLOW_NOW - 1_000 },
    WORKFLOW_SESSION, WORKFLOW_NOW, () => true)!;
  expect(row.agentId).toBe(child.runId!);
  expect(row.endedTs).toBe(WORKFLOW_NOW - 1_000);
  expect(runningCount([row])).toBe(0);
});

test("a plain single run with no workflow remains a subagent row", () => {
  const row = runFromStatus(status("plain-single", { mode: "single" }), SESSION, NOW, () => true);
  expect(row?.agentId).toBe("plain-single");
  expect(row?.endedTs).toBeNull();
});

test("cache: identical output to the uncached read, per session, across runs", async () => {
  const r = freshRoot();
  const OTHER = "/home/me/.pi/agent/sessions/--home-me-other--/2026-09-24_zz.jsonl";
  seedIn(r, "c0000001", { startedAt: NOW - 30_000 });
  seedIn(r, "c0000002", { startedAt: NOW - 20_000, state: "complete", endedAt: NOW - 10_000 });
  seedIn(r, "c0000003", { sessionId: OTHER, startedAt: NOW - 5_000 });
  seedIn(r, "c0000004", { sessionId: OTHER, startedAt: NOW - 40_000, state: "complete", endedAt: NOW - 35_000 });
  await refreshPiSubagentCache(r, NOW);
  // Every session's cached rows match its uncached readPiSubagentRuns rows.
  for (const sid of [SESSION, OTHER]) {
    expect(piSubagentRunsCached(sid, NOW)).toEqual(await readPiSubagentRuns(sid, r, NOW));
  }
});

test("cache: a changed status.json is re-read (its row reflects the new state)", async () => {
  const r = freshRoot();
  const p = seedIn(r, "d0000001", { startedAt: NOW - 10_000 });
  await refreshPiSubagentCache(r, NOW);
  expect(piSubagentRunsCached(SESSION, NOW)[0]?.endedTs).toBeNull(); // running
  // the run finishes: pi rewrites status.json (state + endedAt), a real write
  writeFileSync(p, JSON.stringify(status("d0000001", { startedAt: NOW - 10_000, state: "complete", endedAt: NOW - 2_000 })));
  await refreshPiSubagentCache(r, NOW);
  expect(piSubagentRunsCached(SESSION, NOW)[0]?.endedTs).toBe(NOW - 2_000); // re-read: now closed
});

test("cache: an unchanged file (same mtime + size) is NOT re-read", async () => {
  const r = freshRoot();
  const p = seedIn(r, "e0000001", { startedAt: NOW - 10_000 });
  // Pin an integer-ms mtime so restoring it is exact (no sub-ms stat drift).
  const fixed = new Date(NOW - 90_000);
  utimesSync(p, fixed, fixed);
  await refreshPiSubagentCache(r, NOW);
  expect(piSubagentRunsCached(SESSION, NOW)[0]?.desc).toBe("delegate: Verify 318 partner emails");
  // Overwrite with DIFFERENT content of the SAME byte length and restore the
  // exact mtime: the mtime+size short-circuit must skip the re-read, so the
  // cache still returns the first parse, not the tampered one.
  const original = JSON.stringify(status("e0000001", { startedAt: NOW - 10_000 }));
  const tampered = original.replace("Verify 318 partner emails", "XXXXXX XXX XXXXXXX XXXXXX");
  expect(tampered.length).toBe(original.length);
  writeFileSync(p, tampered);
  utimesSync(p, fixed, fixed);
  await refreshPiSubagentCache(r, NOW);
  expect(piSubagentRunsCached(SESSION, NOW)[0]?.desc).toBe("delegate: Verify 318 partner emails");
});

test("cache: a removed run dir is dropped from the cache", async () => {
  const r = freshRoot();
  seedIn(r, "f0000001", { startedAt: NOW - 10_000 });
  seedIn(r, "f0000002", { startedAt: NOW - 20_000 });
  await refreshPiSubagentCache(r, NOW);
  expect(piSubagentRunsCached(SESSION, NOW).map((run) => run.agentId)).toEqual(["f0000002", "f0000001"]);
  rmSync(join(r, "async-subagent-runs", "f0000001"), { recursive: true, force: true });
  await refreshPiSubagentCache(r, NOW);
  expect(piSubagentRunsCached(SESSION, NOW).map((run) => run.agentId)).toEqual(["f0000002"]);
});
