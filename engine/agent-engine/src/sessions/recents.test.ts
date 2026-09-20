/* THE RECENT-FOLDERS DERIVATION, on the store it reads.
 *
 * recentCwds and isRecentCwd are the two functions the plus menu's Recent
 * group and the widened /new-session cwd gate lean on. Both read the durable
 * paneBindings map directly, so this proves them against that map with no
 * route and no engine: seed a few bindings (some dead, one re-run of an old
 * folder, one empty-cwd stub), pin their ts so newest-first is deterministic,
 * and assert the dedupe, the sort, the exclude set and the cap.
 *
 * ts is pinned on the map entries rather than trusted from Date.now(): several
 * recordBinding calls in one millisecond would otherwise tie, and the sort
 * order is the whole point.
 *
 *   bun test agent-engine/src/sessions/recents.test.ts
 */

import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// datadir.ts reads CYC_DATA_DIR lazily per call; a throwaway dir keeps
// savePaneBindings (fire-and-forget) off any real state dir.
process.env.CYC_DATA_DIR = mkdtempSync(join(tmpdir(), "cyc-recents-"));

import {
  recentCwds, isRecentCwd, recordBinding, markBindingDead,
  paneBindings, resetForTest,
} from "./session-state.ts";

const AID = "ag-recentsxxxxxxxxxx";

beforeEach(() => {
  resetForTest();
});

/** Seed the standard fixture: /old/one (dead), /old/two (dead), /old/one again
 *  (alive, a later re-run), and one empty-cwd stub the derivation must drop.
 *  ts is pinned after the fact so the ordering is not a race. */
function seed() {
  recordBinding("h1", { agentId: AID, sessionId: null, cwd: "/old/one" });
  markBindingDead("h1");
  recordBinding("h2", { agentId: AID, sessionId: null, cwd: "/old/two" });
  markBindingDead("h2");
  recordBinding("h3", { agentId: AID, sessionId: null, cwd: "/old/one" }); // later re-run, alive
  recordBinding("h4", { agentId: AID, sessionId: null, cwd: "" });         // adoptAgentId-style stub
  paneBindings.get("h1")!.ts = 100;
  paneBindings.get("h2")!.ts = 200;
  paneBindings.get("h3")!.ts = 300;
  paneBindings.get("h4")!.ts = 400;
}

test("dedupes by cwd (newest ts wins) and sorts newest first", () => {
  seed();
  // /old/one keeps its newest ts (300 from h3), so it leads /old/two (200).
  expect(recentCwds(new Set())).toEqual(["/old/one", "/old/two"]);
});

test("an empty-cwd stub binding never appears", () => {
  seed();
  expect(recentCwds(new Set())).not.toContain("");
});

test("the exclude set removes a folder already offered as live", () => {
  seed();
  expect(recentCwds(new Set(["/old/one"]))).toEqual(["/old/two"]);
});

test("the cap slices the list", () => {
  seed();
  expect(recentCwds(new Set(), 1)).toEqual(["/old/one"]);
});

test("isRecentCwd is exact-equality membership, and refuses the empty string", () => {
  seed();
  expect(isRecentCwd("/old/one")).toBe(true);
  expect(isRecentCwd("/old/two")).toBe(true);
  // not byte-identical to any recorded cwd -> refused (no normalization)
  expect(isRecentCwd("/old/one/../one")).toBe(false);
  expect(isRecentCwd("/etc")).toBe(false);
  expect(isRecentCwd("")).toBe(false);
});
