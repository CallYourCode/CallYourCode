/* The announced model (hook-announce.ts liveModelOf): pi's extension names its
 * running model on start and on every switch, and that beats the transcript
 * for the app's model chip.
 *
 *   bun test agent-engine/src/terminal/live-model.test.ts
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAnnounce, liveModelOf, resetHookAnnounce } from "./hook-announce.ts";

const resolved = { resolveAgentChain: async () => ({ agentPid: 4242, nested: false }) };
const prevDir = process.env.CYC_DATA_DIR;
beforeAll(() => { process.env.CYC_DATA_DIR = mkdtempSync(join(tmpdir(), "live-model-")); });
afterAll(() => { process.env.CYC_DATA_DIR = prevDir; });
afterEach(() => resetHookAnnounce());

test("an announce with a model records it; a later one replaces it", async () => {
  await handleAnnounce({ sessionId: "sess-1", pid: 999, cwd: "/w", harness: "pi", model: "claude-opus-4-8" }, resolved);
  expect(liveModelOf("sess-1")).toBe("claude-opus-4-8");
  await handleAnnounce({ sessionId: "sess-1", pid: 999, cwd: "/w", harness: "pi", model: "claude-opus-5-5" }, resolved);
  expect(liveModelOf("sess-1")).toBe("claude-opus-5-5");
});

test("no model, or a malformed one, records nothing", async () => {
  await handleAnnounce({ sessionId: "sess-2", pid: 999, cwd: "/w" }, resolved);
  await handleAnnounce({ sessionId: "sess-3", pid: 999, cwd: "/w", model: "bad model; rm" }, resolved);
  expect(liveModelOf("sess-2")).toBeNull();
  expect(liveModelOf("sess-3")).toBeNull();
});

test("the model survives an engine restart (persisted, reloaded lazily)", async () => {
  await handleAnnounce({ sessionId: "sess-4", pid: 999, cwd: "/w", model: "claude-opus-5-5" }, resolved);
  resetHookAnnounce(); // drops the in-memory map, as a restart does
  expect(liveModelOf("sess-4")).toBe("claude-opus-5-5");
});
