import { test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";
import { PI_TRANSCRIPT } from "./transcripts.ts";

const provider = "openai-codex";
const modelId = "gpt-6.1-sol";
const change = (p = provider, m = modelId) => ({ type: "model_change", provider: p, modelId: m });
const snapshot = (contextWindow: unknown = 272000, tokens: unknown = 136000, p = provider, m = modelId) => ({
  type: "custom", customType: "cyc-context", data: { version: 1, provider: p, modelId: m, contextWindow, tokens },
});
const assistant = (input = 136000) => ({ type: "message", message: {
  role: "assistant", provider, model: modelId, usage: { input, output: 2000, cacheRead: 0, cacheWrite: 0 },
} });
async function pct(records: unknown[]) {
  const path = join(await tmpDir("pi-context-"), "session.jsonl");
  await writeFile(path, records.map(r => JSON.stringify(r)).join("\n") + "\n");
  return PI_TRANSCRIPT.contextPct(path);
}

test("Pi's effective 272k window and same-model 1M override, not a model table", async () => {
  expect(await pct([change(), assistant(), snapshot()])).toBe(50);
  expect(await pct([change(), assistant(), snapshot(), snapshot(1000000)])).toBe(13);
  // The snapshot is Pi's projected context reading, including output and tail,
  // not the assistant's input or cumulative billing total.
  expect(await pct([change(), assistant(), snapshot(272000, 163200)])).toBe(60);
});

test("old sessions and invalid windows/tokens stay unknown, zero is a valid Pi reading", async () => {
  expect(await pct([change(), assistant()])).toBeNull();
  for (const window of [null, 0, -1, "272000"]) expect(await pct([change(), snapshot(window)])).toBeNull();
  for (const tokens of [null, -1, "136000"]) expect(await pct([change(), snapshot(272000, tokens)])).toBeNull();
  expect(await pct([change(), snapshot(272000, 0)])).toBe(0);
  expect(await pct([change(), snapshot(272000, 544000)])).toBe(100);
});

test("provider/model changes never reuse a different model's window", async () => {
  for (const [p, m] of [["other-account", modelId], [provider, "future-model"]]) {
    expect(await pct([change(), snapshot(), change(p, m)])).toBeNull();
    expect(await pct([change(), snapshot(1000000, 136000, p, m), assistant()])).toBeNull();
    expect(await pct([change(), snapshot(), change(p, m), snapshot(1000000, 136000, p, m)])).toBe(13);
  }
});

test("compaction, projection edits, and new turns invalidate stale readings until Pi reports again", async () => {
  for (const record of [{ type: "compaction", tokensBefore: 136000 }, { type: "context_edit" },
    { type: "branch_summary" }, assistant(200000)]) {
    expect(await pct([change(), snapshot(), record])).toBeNull();
    expect(await pct([change(), snapshot(), record, snapshot(272000, null)])).toBeNull();
    expect(await pct([change(), snapshot(), record, snapshot(272000, 27200)])).toBe(10);
  }
});

test("session boundaries cannot carry another session's reading", async () => {
  expect(await pct([change(), snapshot(), { type: "session", id: "new" }, change(), assistant()])).toBeNull();
  expect(await pct([change(), snapshot(), { type: "usage", usage: { totalTokens: 999999999 } }])).toBe(50);
});
