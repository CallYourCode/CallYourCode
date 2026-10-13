/* The context/model/title cache over the reader-seam deps.
 *
 * context-cache.ts no longer value-imports session-events.ts: the claude
 * transcript path, its context/model reading and its title all arrive through
 * injected verbs (the adapter's, in production). This seam test drives
 * pollOnce() directly over FAKE reads -- no interval, no adapter, no real
 * transcript parse -- and proves the cache stores and answers exactly what the
 * reads hand it, and that the size short-circuit still skips an unchanged file.
 *
 *   bun test agent-engine/src/sessions/context-cache.test.ts
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manualClock } from "../runtime/clock.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import {
  initContextCache, pollOnce, resetForTest,
  contextPctOf, contextEntryOf, modelOf, modelAcronymOf, claudeTitleOf,
  type CtxSession,
} from "./context-cache.ts";
import { handleAnnounce, liveModelOf, resetHookAnnounce } from "../terminal/hook-announce.ts";

const CWD = "/tmp/ctx-seam";
const CSID = "aa11bb22-cc33-4d44-8e55-ff6677889900";
let root: string;
let path: string;
let bytes: string; // the "transcript" the size short-circuit stats
let ctxRead: {
  pct: number | null; modelId: string | null;
  modelName: string | null; modelAcronym: string | null;
} | null;
let title: string | null;
let contextReadCalls = 0;
let broadcasts = 0;

const session: CtxSession = {
  id: "s1", harnessSessionId: CSID, agent: { id: "claude" }, hasTranscript: true,
  cwd: CWD, muxHandle: "w1:p1", alive: true,
};

function writeBytes(s: string): void { bytes = s; writeFileSync(path, s); }

beforeEach(async () => {
  root = await tmpDir("ctx-seam");
  path = join(root, `${CSID}.jsonl`);
  contextReadCalls = 0;
  broadcasts = 0;
  ctxRead = { pct: 42, modelId: "claude-opus-4-8", modelName: "Opus 4.8", modelAcronym: "O4.8" };
  title = "A titled session";
  writeBytes("one\n");
  initContextCache({
    sessions: () => [session],
    transcriptFile: () => null,
    contextRead: async () => null,
    claudeTranscriptPath: () => path,
    claudeContextRead: async () => { contextReadCalls++; return ctxRead; },
    claudeTitleRead: async () => title,
    broadcastSessions: () => { broadcasts++; },
    clock: manualClock(), // no real timer fires; we call pollOnce() by hand
  });
});
afterEach(() => resetForTest());

test("pollOnce stores the injected reading; the getters answer from cache", async () => {
  await pollOnce();
  expect(contextPctOf(session)).toBe(42);
  expect(modelOf(session)).toBe("Opus 4.8");
  expect(modelAcronymOf(session)).toBe("O4.8");
  expect(claudeTitleOf(session)).toBe("A titled session");
  expect(contextEntryOf(session)).toMatchObject({ pct: 42, modelId: "claude-opus-4-8" });
  expect(broadcasts).toBe(1); // something changed on the first pass
});

test("an unchanged file is not re-read (the size short-circuit)", async () => {
  await pollOnce();
  expect(contextReadCalls).toBe(1);
  await pollOnce(); // same bytes: no new answer, no read
  expect(contextReadCalls).toBe(1);
});

test("a non-claude session's raw model id is mapped to its display name", async () => {
  // A pi pane on the claude bridge writes the RAW id "claude-fable-5" into its
  // transcript; the generic branch must store the mapped name, not the raw id
  // (the sessions list printed "claude-fable-5" next to "Fable 5" rows).
  const piSession: CtxSession = {
    id: "s2", harnessSessionId: null, agent: { id: "pi" }, hasTranscript: true,
    cwd: CWD, muxHandle: "w1:p6", alive: true,
  };
  resetForTest();
  initContextCache({
    sessions: () => [piSession],
    transcriptFile: () => ({ path }),
    contextRead: async () => ({ pct: 26, model: "claude-fable-5" }),
    claudeTranscriptPath: () => null,
    claudeContextRead: async () => null,
    claudeTitleRead: async () => null,
    broadcastSessions: () => {},
    clock: manualClock(),
  });
  await pollOnce();
  expect(contextPctOf(piSession)).toBe(26);
  expect(modelOf(piSession)).toBe("Fable 5");
});

test("an announced model switch re-reads an unchanged pi transcript (chip follows the switch)", async () => {
  const piSession: CtxSession = {
    id: "pi-live", harnessSessionId: null, agent: { id: "pi" }, hasTranscript: true,
    cwd: CWD, muxHandle: "w1:pA", alive: true,
  };
  let model = "claude-haiku-4-5";
  let reads = 0;
  const prevDir = process.env.CYC_DATA_DIR;
  process.env.CYC_DATA_DIR = mkdtempSync(join(tmpdir(), "ctx-live-")); // the announce persists
  resetHookAnnounce();
  resetForTest();
  initContextCache({
    sessions: () => [piSession],
    transcriptFile: () => ({ path, sessionId: "sess-live-chip" }),
    contextRead: async () => { reads++; return { pct: 1, model: liveModelOf("sess-live-chip") ?? model }; },
    claudeTranscriptPath: () => null,
    claudeContextRead: async () => null,
    claudeTitleRead: async () => null,
    broadcastSessions: () => {},
    clock: manualClock(),
  });
  await pollOnce();
  expect(modelOf(piSession)).toBe("Haiku 4.5");
  await handleAnnounce({ sessionId: "sess-live-chip", pid: 999, cwd: "/w", model: "claude-sonnet-5" },
    { resolveAgentChain: async () => ({ agentPid: 4242, nested: false }) });
  await pollOnce(); // same bytes, but the announced model moved
  expect(reads).toBe(2);
  expect(modelOf(piSession)).toBe("Sonnet 5");
  await pollOnce(); // settled: no further reads
  expect(reads).toBe(2);
  resetHookAnnounce();
  process.env.CYC_DATA_DIR = prevDir;
});

test("a grown file is re-read and the new answer replaces the old", async () => {
  await pollOnce();
  expect(modelAcronymOf(session)).toBe("O4.8");
  writeBytes("one\ntwo\n"); // a turn was written
  ctxRead = { pct: 77, modelId: "claude-opus-5", modelName: "Opus 5", modelAcronym: "O5" };
  await pollOnce();
  expect(contextReadCalls).toBe(2);
  expect(contextPctOf(session)).toBe(77);
  expect(modelOf(session)).toBe("Opus 5");
  expect(modelAcronymOf(session)).toBe("O5");
});

test("a durable Pi reload snapshot refreshes the stat cache without another message", async () => {
  const { PI_TRANSCRIPT } = await import("../chat/transcripts.ts");
  const piSession: CtxSession = { ...session, id: "pi-reload", agent: { id: "pi" }, harnessSessionId: null };
  const history = [
    { type: "model_change", provider: "scratch", modelId: "scratch-model" },
    { type: "message", message: { role: "assistant", provider: "scratch", model: "scratch-model",
      usage: { input: 136000, output: 0, cacheRead: 0, cacheWrite: 0 } } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(path, history);
  let reads = 0;
  resetForTest();
  initContextCache({
    sessions: () => [piSession], transcriptFile: () => ({ path }),
    contextRead: async () => { reads++; return { pct: await PI_TRANSCRIPT.contextPct(path), model: await PI_TRANSCRIPT.model(path) }; },
    claudeTranscriptPath: () => null, claudeContextRead: async () => null, claudeTitleRead: async () => null,
    broadcastSessions: () => {}, clock: manualClock(),
  });
  await pollOnce(); expect(contextPctOf(piSession)).toBeNull();
  await pollOnce(); expect(reads).toBe(1);
  // Models/messages stay untouched. Only Pi's non-context snapshot grows the
  // file, as the real CLI does at session_start on an already-saved session.
  appendFileSync(path, JSON.stringify({ type: "custom", customType: "cyc-context",
    data: { version: 1, provider: "scratch", modelId: "scratch-model", contextWindow: 272000, tokens: 136000 } }) + "\n");
  await pollOnce(); expect(contextPctOf(piSession)).toBe(50); expect(reads).toBe(2);
  await pollOnce(); expect(reads).toBe(2);
});

test("Pi snapshot growth, engine restart, and equal-size resume files remain fresh", async () => {
  const { PI_TRANSCRIPT } = await import("../chat/transcripts.ts");
  const piSession: CtxSession = { ...session, id: "pi-context", agent: { id: "pi" }, harnessSessionId: null };
  const snapshot = (tokens: number | null) => JSON.stringify({ type: "custom", customType: "cyc-context",
    data: { version: 1, provider: "openai-codex", modelId: "gpt-6.1-sol", contextWindow: 272000, tokens } }) + "\n";
  const first = join(root, "first.jsonl");
  const second = join(root, "second.jsonl");
  writeFileSync(first, snapshot(136000));
  // Same file size, another account/session, different reading.
  writeFileSync(second, snapshot(272000));
  let located: { path: string } | null = { path: first };
  let reads = 0;
  const wire = () => initContextCache({
    sessions: () => [piSession],
    transcriptFile: () => located,
    contextRead: async () => { reads++; return { pct: await PI_TRANSCRIPT.contextPct(located!.path), model: await PI_TRANSCRIPT.model(located!.path) }; },
    claudeTranscriptPath: () => null, claudeContextRead: async () => null, claudeTitleRead: async () => null,
    broadcastSessions: () => {}, clock: manualClock(),
  });
  resetForTest(); wire();
  await pollOnce(); expect(contextPctOf(piSession)).toBe(50);
  await pollOnce(); expect(reads).toBe(1);
  located = { path: second };
  await pollOnce(); expect(contextPctOf(piSession)).toBe(100);
  writeFileSync(second, snapshot(272000) + JSON.stringify({ type: "compaction" }) + "\n" + snapshot(null));
  await pollOnce(); expect(contextPctOf(piSession)).toBeNull();
  writeFileSync(second, snapshot(272000) + snapshot(136000));
  await pollOnce(); expect(contextPctOf(piSession)).toBe(50);
  resetForTest(); wire();
  await pollOnce(); expect(contextPctOf(piSession)).toBe(50);
  located = null;
  await pollOnce(); expect(contextPctOf(piSession)).toBeNull();
});
