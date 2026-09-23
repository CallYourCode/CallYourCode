/* The four reader-seam bypass verbs on MuxAdapter.
 *
 * carry.ts, lineage.ts and context-cache.ts used to value-import session-events.ts
 * directly; they now reach every transcript fact through these verbs. The point
 * of this file is PARITY: each verb answers exactly what the session-events
 * function it delegates to answers, on the same seeded transcript, so the seam
 * move is invisible.
 *
 *   bun test agent-engine/src/adapters/reader-verbs.test.ts
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";
import {
  contextPct, contextWindowFor, modelAcronym, modelDisplayName, modelIdOf,
  readContextUsage, readSessionTitle, sessionFilePath,
} from "../sessions/session-events.ts";

const { MuxAdapter } = await import("./mux-adapter.ts");

/** A Multiplexer stub: the reader-seam verbs are path/cwd-keyed and never touch
 *  the mux, so nothing here needs to answer a pane call. */
const stubMux = () => ({
  onAgents() {}, start() {},
  async readPane() { return { text: "", truncated: false }; },
  async sendText() {}, async sendKeys() {},
  async renamePane() {}, async closePane() {},
  workspaceOf() { return null; }, knownCwds() { return []; },
  async newTab() { return "w9:p1"; },
}) as unknown as import("../terminal/mux.ts").Multiplexer;

const CWD = "/tmp/reader-verbs-proj";
const UUID = "aa11bb22-cc33-4d44-8e55-ff6677889900";
let root: string;
let prevProjects: string | undefined;

/** One assistant usage record: `tokens` is the sum readContextUsage accounts. */
function assistant(model: string, input: number): string {
  return JSON.stringify({
    type: "assistant", uuid: `u${Math.random()}`,
    timestamp: new Date().toISOString(), isSidechain: false,
    message: {
      model, content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: input, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0, output_tokens: 0 },
    },
  });
}
const aiTitle = (title: string): string =>
  JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: UUID });

/** Seed a claude transcript at exactly the path sessionFilePath answers for. */
function seed(body: string): string {
  const path = sessionFilePath(CWD, UUID)!;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

beforeEach(async () => {
  root = await tmpDir("reader-verbs");
  prevProjects = process.env.CYC_PROJECTS_DIR;
  process.env.CYC_PROJECTS_DIR = join(root, "projects");
});
afterEach(() => {
  if (prevProjects === undefined) delete process.env.CYC_PROJECTS_DIR;
  else process.env.CYC_PROJECTS_DIR = prevProjects;
});

test("transcriptPathFor answers the exact path sessionFilePath does", () => {
  const a = new MuxAdapter(stubMux());
  expect(a.transcriptPathFor(CWD, UUID)).toBe(sessionFilePath(CWD, UUID));
  // a non-uuid id is null in both
  expect(a.transcriptPathFor(CWD, "not-a-uuid")).toBe(sessionFilePath(CWD, "not-a-uuid"));
});

test("readTitle matches readSessionTitle on the same file", async () => {
  const path = seed([assistant("claude-opus-5", 1000), aiTitle("Refactor the parser")].join("\n") + "\n");
  const a = new MuxAdapter(stubMux());
  const expected = await readSessionTitle(path);
  expect(expected).toBe("Refactor the parser");
  expect(await a.readTitle(CWD, UUID)).toBe(expected);
});

test("readTitle is null with no path (bad id)", async () => {
  const a = new MuxAdapter(stubMux());
  expect(await a.readTitle(CWD, "not-a-uuid")).toBeNull();
});

test("contextModelRead has parity with readContextUsage + the pure mappers", async () => {
  const path = seed(assistant("claude-opus-4-8", 90_000) + "\n");
  const a = new MuxAdapter(stubMux());
  const reading = await readContextUsage(path);
  const usage = reading && reading !== "compacted" ? reading : null;
  const modelId = modelIdOf(reading);

  const got = await a.contextModelRead(CWD, UUID);
  expect(got).not.toBeNull();
  expect(got!.pct).toBe(contextPct(reading));
  expect(got!.used).toBe(usage ? usage.tokens : null);
  expect(got!.total).toBe(usage ? contextWindowFor(usage.model) : null);
  expect(got!.modelId).toBe(modelId);
  expect(got!.modelName).toBe(modelId ? modelDisplayName(modelId) : null);
  expect(got!.modelAcronym).toBe(modelId ? modelAcronym(modelId) : null);
  // and the concrete answers this fixture pins
  expect(got!.used).toBe(90_000);
  expect(got!.modelName).toBe("Opus 4.8");
  expect(got!.modelAcronym).toBe("O4.8");
});

test("contextModelRead is null with no path", async () => {
  const a = new MuxAdapter(stubMux());
  expect(await a.contextModelRead(CWD, "not-a-uuid")).toBeNull();
});

test("streamTranscriptLines sees every non-empty line, in order", async () => {
  const lines = [assistant("claude-opus-5", 10), aiTitle("t"), assistant("claude-opus-5", 20)];
  const path = seed(lines.join("\n") + "\n");
  const a = new MuxAdapter(stubMux());
  const seen: string[] = [];
  await a.streamTranscriptLines(path, (l) => { if (l) seen.push(l); });
  expect(seen).toEqual(lines);
});

test("streamTranscriptLines no-ops on a missing file", async () => {
  const a = new MuxAdapter(stubMux());
  let called = false;
  await a.streamTranscriptLines(join(root, "nope.jsonl"), () => { called = true; });
  expect(called).toBe(false);
});

/* THE RESTART GONE-WAIT IS THE READER'S, NOT A LITERAL IN THE LADDER.
 *
 * pi flushes on SIGINT and quits slower than the ladder's default window, so
 * its reader declares a wider gone-wait (readers/pi.ts quit.waitMs) and the
 * adapter passes it through here for pane-deliver.ts to resolve. A harness that
 * quits promptly declares nothing and reads as null (the shipped default). */
test("quitWaitMs is pi's declared gone-wait, and null for a prompt-quitting harness", () => {
  const a = new MuxAdapter(stubMux());
  expect(a.quitWaitMs("pi")).toBe(40_000);
  expect(a.quitWaitMs("claude")).toBeNull();
  expect(a.quitWaitMs("codex")).toBeNull();
  expect(a.quitWaitMs("opencode")).toBeNull();
  // an agent with no reader has no override either
  expect(a.quitWaitMs("nonesuch")).toBeNull();
});

/* THE QUIT KEYS ARE THE READER'S TOO.
 *
 * pi does not quit on ctrl+c at all -- it quits on ctrl+d at an empty input
 * (measured) -- so its reader declares the quit KEY sequence (readers/pi.ts
 * quit.keys) and the adapter passes it through for pane-deliver.ts's restart
 * ladder. A harness whose quit is the shipped repeated ctrl+c declares nothing
 * and reads as null. */
test("quitKeys is pi's declared quit sequence, and null for a ctrl+c-quitting harness", () => {
  const a = new MuxAdapter(stubMux());
  expect(a.quitKeys("pi")).toEqual(["ctrl+c", "ctrl+d"]);
  expect(a.quitKeys("claude")).toBeNull();
  expect(a.quitKeys("codex")).toBeNull();
  expect(a.quitKeys("opencode")).toBeNull();
  // an agent with no reader has no override either
  expect(a.quitKeys("nonesuch")).toBeNull();
});

/* THE HARNESS CAPABILITY PROFILES ARE DERIVED FROM THE READERS TABLE (stage 4).
 *
 * harnessProfiles() is the ONE source of truth the capability core (harness-caps.ts)
 * and the usage-card's kind list are built from, so the engine names no harness in
 * a switch and pi is included automatically. It answers every reader's tag + its
 * declared capabilities, in READERS order. */
test("harnessProfiles is the READERS table's tags + declared capabilities, pi included", () => {
  const a = new MuxAdapter(stubMux());
  expect(a.harnessProfiles()).toEqual([
    { tag: "claude", caps: { context: "native", compact: true, usage: true } },
    { tag: "codex", caps: { context: "transcript" } },
    { tag: "opencode", caps: { context: "transcript" } },
    { tag: "pi", caps: { context: "transcript", usage: true } },
  ]);
  // claude is the one native-context harness (its own windowed read + compact + usage);
  // pi degrades cleanly like codex/opencode instead of being absent.
  const byTag = new Map(a.harnessProfiles().map((p) => [p.tag, p.caps]));
  expect(byTag.get("claude")!.context).toBe("native");
  expect(byTag.get("pi")).toEqual({ context: "transcript", usage: true });
});
