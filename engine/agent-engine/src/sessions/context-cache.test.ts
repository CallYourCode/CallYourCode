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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { manualClock } from "../runtime/clock.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import {
  initContextCache, pollOnce, resetForTest,
  contextPctOf, contextEntryOf, modelOf, modelAcronymOf, claudeTitleOf,
  type CtxSession,
} from "./context-cache.ts";

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
