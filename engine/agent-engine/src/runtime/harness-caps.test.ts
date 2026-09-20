/* THE HARNESS CAPABILITIES, proven per member per kind, DERIVED from the readers'
 * declared capabilities. The resolver names no
 * harness: it is a Map built from `deps.profiles` (adapter.harnessProfiles), so an
 * added reader adds its profile and an unknown kind degrades to null.
 *
 * This file proves the WIRING and the MAPPING: claude's model + context route
 * through the adapter seam (deps.contextModelRead), not a jsonl read here, and the
 * seam's {pct, used, total, modelId} is mapped to the caps shape faithfully (the
 * window math itself is pinned in context.test.ts + reader-verbs.test.ts). codex /
 * opencode / pi are reads-only off the transcript read, and pi -- unlike an unknown
 * kind -- answers a REAL profile so its context bar degrades cleanly.
 *
 *   bun test agent-engine/src/runtime/harness-caps.test.ts
 */

import { test, expect } from "bun:test";
import { makeHarnessCaps, type HarnessCapsDeps } from "./harness-caps.ts";
import type { SessionRef, CommandResult } from "./capabilities.ts";
import type { AgentConversation, AgentLifecycle, HarnessCaps } from "../readers/types.ts";
import { HARNESS_CWD } from "../test-utils/fake-herdr.ts";

const conv = (o: Partial<AgentConversation> = {}): AgentConversation => ({
  harnessSessionId: "csid", model: null, contextPct: null, title: null, blocked: null,
  lifecycle: "running", messages: [], events: [], runs: [], ...o,
});

/* The reader profiles the real READERS table declares (mux-adapter.harnessProfiles);
 * the resolver is BUILT from this and never from a harness switch. */
const PROFILES: ReadonlyArray<{ tag: string; caps: HarnessCaps }> = [
  { tag: "claude", caps: { context: "native", compact: true, usage: true } },
  { tag: "codex", caps: { context: "transcript" } },
  { tag: "opencode", caps: { context: "transcript" } },
  { tag: "pi", caps: { context: "transcript" } },
];

/* A fake deps bag; each member records or answers what a test needs. The native
 * read is the adapter seam (contextModelRead), the transcript read is muxContextRead. */
function fakeDeps(over: Partial<HarnessCapsDeps> = {}): HarnessCapsDeps {
  return {
    profiles: PROFILES,
    muxContextRead: async () => ({ pct: 12, model: "gpt-5.6-sol" }),
    contextModelRead: async () => ({ pct: 25, used: 250_000, total: 1_000_000, modelId: "claude-opus-5[1m]" }),
    conversation: async () => conv(),
    lifecycle: () => "running",
    claudeCompact: async () => ({ ok: true, tell: "compacting this context" }),
    claudeUsage: async () => ({ ok: true, email: "a@b.c", windows: [], fetchedAt: 123 }),
    ...over,
  };
}

const refFor = (uuid: string): SessionRef => ({ handle: "pane-1", cwd: HARNESS_CWD, harnessSessionId: uuid });
const CSID = "aaaaaaaa-1111-4111-8111-000000000001";

test("claude context/model route through the adapter seam (contextModelRead), not a jsonl read here", async () => {
  // the seam is a SPY: the caps must call it with the ref's cwd + harness session id
  const seen: Array<{ cwd: string; csid: string }> = [];
  const caps = makeHarnessCaps(fakeDeps({
    contextModelRead: async (cwd, csid) => {
      seen.push({ cwd, csid });
      return { pct: 25, used: 250_000, total: 1_000_000, modelId: "claude-opus-5[1m]" };
    },
  }))("claude")!;
  const ref = refFor(CSID);
  // context maps the seam's {pct, used, total} to the caps ContextRead, byte for byte
  expect(await caps.context(ref)).toEqual({ used: 250_000, total: 1_000_000, pct: 25 });
  // model answers the seam's RAW modelId (the plugin maps it to a friendly name)
  expect(await caps.model(ref)).toBe("claude-opus-5[1m]");
  // both went through the seam, keyed by cwd + harness session id
  expect(seen).toEqual([
    { cwd: HARNESS_CWD, csid: CSID },
    { cwd: HARNESS_CWD, csid: CSID },
  ]);
});

test("claude context maps a no-reading seam answer to nulls (compacted/no-turn), the bar's honest empty", async () => {
  // the seam answers a non-null object with null fields when there is a path but no reading
  const caps = makeHarnessCaps(fakeDeps({
    contextModelRead: async () => ({ pct: null, used: null, total: null, modelId: null }),
  }))("claude")!;
  expect(await caps.context(refFor(CSID))).toEqual({ used: null, total: null, pct: null });
  expect(await caps.model(refFor(CSID))).toBeNull();
});

test("claude context/model are null without a harness session id (the seam is never asked)", async () => {
  let called = false;
  const caps = makeHarnessCaps(fakeDeps({
    contextModelRead: async () => { called = true; return null; },
  }))("claude")!;
  const ref: SessionRef = { handle: "pane-1", cwd: HARNESS_CWD, harnessSessionId: null };
  expect(await caps.context(ref)).toBeNull();
  expect(await caps.model(ref)).toBeNull();
  expect(called).toBe(false); // no session id: the seam is short-circuited
});

test("claude context/model are null when the seam cannot locate a transcript (returns null)", async () => {
  const caps = makeHarnessCaps(fakeDeps({ contextModelRead: async () => null }))("claude")!;
  expect(await caps.context(refFor(CSID))).toBeNull();
  expect(await caps.model(refFor(CSID))).toBeNull();
});

test("claude compact forwards compactSession's exact {ok, tell}", async () => {
  const seen: string[] = [];
  const caps = makeHarnessCaps(fakeDeps({
    claudeCompact: async (h) => { seen.push(h); return { ok: false, tell: "waiting on a permission prompt in that pane" }; },
  }))("claude")!;
  const r: CommandResult = await caps.compact!(refFor(CSID));
  expect(r).toEqual({ ok: false, tell: "waiting on a permission prompt in that pane" });
  expect(seen).toEqual(["pane-1"]); // resolved by the live mux handle
});

test("claude usage forwards the LimitsReport untouched and threads the force flag (section 5.3)", async () => {
  const report = { ok: true, email: "him@example.com", windows: [{ label: "5 hours", pct: 40, resetsAt: null }], fetchedAt: 9 };
  const seen: boolean[] = [];
  const caps = makeHarnessCaps(fakeDeps({ claudeUsage: async (force) => { seen.push(force); return report; } }))("claude")!;
  // usage is an ACCOUNT fact: it takes the force flag, no SessionRef
  expect(await caps.usage!(false)).toBe(report); // same object, no reshape
  expect(await caps.usage!(true)).toBe(report);
  // the refresh button's force reaches limitsNow untouched
  expect(seen).toEqual([false, true]);
});

test("claude transcript/status/blocked read off the conversation snapshot", async () => {
  const snapshot = conv({ lifecycle: "blocked", blocked: { ask: null, why: "unread" } });
  const caps = makeHarnessCaps(fakeDeps({
    conversation: async () => snapshot,
    lifecycle: () => "blocked",
  }))("claude")!;
  const ref = refFor(CSID);
  expect(await caps.transcript(ref)).toBe(snapshot);
  expect(caps.status(ref)).toBe("blocked" as AgentLifecycle);
  expect(await caps.blocked(ref)).toEqual({ ask: null, why: "unread" });
});

test("blocked falls back to {ask:null} when the snapshot has no dialog", async () => {
  const caps = makeHarnessCaps(fakeDeps({ conversation: async () => conv({ blocked: null }) }))("claude")!;
  expect(await caps.blocked(refFor(CSID))).toEqual({ ask: null });
});

test("codex is reads-only: model+pct off the transcript read, no compact/usage", async () => {
  const caps = makeHarnessCaps(fakeDeps({
    muxContextRead: async () => ({ pct: 33, model: "gpt-5.6-sol" }),
  }))("codex")!;
  const ref: SessionRef = { handle: "pane-2", cwd: "/w", harnessSessionId: "csid-2" };
  expect(await caps.model(ref)).toBe("gpt-5.6-sol");
  expect(await caps.context(ref)).toEqual({ used: null, total: null, pct: 33 });
  // absence IS the story: the members are undefined, so the dispatch says "not supported"
  expect(caps.compact).toBeUndefined();
  expect(caps.setModel).toBeUndefined();
  expect(caps.answer).toBeUndefined();
  expect(caps.usage).toBeUndefined();
  expect(caps.sendText).toBeUndefined();
  expect(caps.interrupt).toBeUndefined();
});

test("codex context is null when the transcript read has nothing", async () => {
  const caps = makeHarnessCaps(fakeDeps({ muxContextRead: async () => null }))("codex")!;
  expect(await caps.context({ handle: "pane-2", cwd: "/w", harnessSessionId: null })).toBeNull();
  expect(await caps.model({ handle: "pane-2", cwd: "/w", harnessSessionId: null })).toBeNull();
});

test("opencode has the same reads-only shape as codex", async () => {
  const caps = makeHarnessCaps(fakeDeps())("opencode")!;
  expect(typeof caps.model).toBe("function");
  expect(typeof caps.context).toBe("function");
  expect(caps.compact).toBeUndefined();
  expect(caps.usage).toBeUndefined();
});

test("pi answers a REAL reads-only profile (it degrades cleanly, it is not absent)", async () => {
  const caps = makeHarnessCaps(fakeDeps({
    muxContextRead: async () => ({ pct: 41, model: "pi-model" }),
  }))("pi");
  expect(caps).not.toBeNull();
  const ref: SessionRef = { handle: "pane-3", cwd: "/w", harnessSessionId: "csid-3" };
  // same shape as codex/opencode: model + pct off the transcript read, no compact/usage
  expect(await caps!.model(ref)).toBe("pi-model");
  expect(await caps!.context(ref)).toEqual({ used: null, total: null, pct: 41 });
  expect(caps!.compact).toBeUndefined();
  expect(caps!.usage).toBeUndefined();
});

test("the resolver is derived from profiles: an unknown kind degrades cleanly to null", () => {
  const resolve = makeHarnessCaps(fakeDeps());
  expect(resolve("")).toBeNull();
  expect(resolve("gemini")).toBeNull(); // a reader that is not in the profiles table
  // and dropping a reader from the profiles drops its profile (no hardcoded switch)
  const noPi = makeHarnessCaps(fakeDeps({
    profiles: PROFILES.filter((p) => p.tag !== "pi"),
  }));
  expect(noPi("pi")).toBeNull();
  expect(noPi("claude")).not.toBeNull();
});
