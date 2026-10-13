import { test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";
import { PI_TRANSCRIPT } from "./transcripts.ts";
import { contextWindowFor } from "../readers/claude.ts";

const assistant = (usage: unknown, model?: string) => ({
  type: "message", message: { role: "assistant", usage, model },
});
const line = (r: unknown) => JSON.stringify(r) + "\n";

test("pi context keeps independent newest positive usage and newest nonempty model", async () => {
  const path = join(await tmpDir("pi-context-"), "s.jsonl");
  await writeFile(path,
    line({ type: "model_change", modelId: "grok-4.6" })
    + line(assistant({ input: 100_000, cacheRead: 50_000, cacheWrite: 50_000 }, "grok-4.6"))
    + line(assistant({ input: 0, cacheRead: -1, cacheWrite: "bad" }, ""))
    + "not json\n"
    + line({ type: "model_change", modelId: "claude-haiku-4-5-20251001" })
    + line({ type: "message", message: { role: "toolResult", model: "wrong", usage: { input: 1 } } })
    // Forward streaming ignores an unterminated final record, even if valid JSON.
    + JSON.stringify(assistant({ input: 1 }, "wrong")));
  expect(await PI_TRANSCRIPT.contextPct(path)).toBe(100);
  expect(await PI_TRANSCRIPT.model(path)).toBe("claude-haiku-4-5-20251001");
  await writeFile(path, line(assistant({ input: -1, cacheRead: 0 }, "grok-4.6")));
  expect(await PI_TRANSCRIPT.contextPct(path)).toBeNull();
  expect(await PI_TRANSCRIPT.model(path)).toBe("grok-4.6");
  await writeFile(path, JSON.stringify({ type: "model_change", modelId: "wrong" }));
  expect(await PI_TRANSCRIPT.model(path)).toBeNull();
  expect(await PI_TRANSCRIPT.contextPct(path + ".missing")).toBeNull();
});

test("pi tail handles spanning UTF-8 records and model-only/usage-only records", async () => {
  const path = join(await tmpDir("pi-context-"), "s.jsonl");
  await writeFile(path, line({ type: "model_change", modelId: "claude-haiku-4-5-20251001" })
    + line({ ...assistant({ input: 80_000 }), padding: "你好🙂".repeat(100_000) })
    + line({ type: "message", message: { role: "user", content: "x".repeat(300_000) } }));
  expect(await PI_TRANSCRIPT.contextPct(path)).toBe(40);
  expect(await PI_TRANSCRIPT.model(path)).toBe("claude-haiku-4-5-20251001");
});

test("pi tail matches the old forward reducer on sparse, malformed and switched transcripts", async () => {
  const dir = await tmpDir("pi-context-equivalence-");
  let seed = 17;
  const pick = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  for (let caseId = 0; caseId < 32; caseId++) {
    const records = [
      assistant({ input: 150_000, cacheRead: 50_000 }, "grok-4.6"),
      assistant({ input: 0, cacheRead: -1 }, ""),
      assistant({ input: "wrong", cacheWrite: 80_000 }),
      assistant({ input: 1e308, cacheWrite: 1e308 }),
      assistant(null, "claude-haiku-4-5-20251001"),
      { type: "model_change", modelId: "claude-haiku-4-5-20251001" },
      { type: "model_change", modelId: "" },
      { type: "compaction", summary: "old usage is still retained by the pi reader" },
      { type: "message", message: { role: "user", model: "wrong" } },
      { type: "message", message: { role: "assistant", usage: [] } },
    ];
    let body = "";
    for (let i = 0; i < 64; i++) body += pick(8) === 0 ? "broken json\n" : line(records[pick(records.length)]);
    if (caseId % 2) body += JSON.stringify(assistant({ input: 1 }, "ignored-torn-line"));
    // Today's reducer: the last positive usage and nonempty model independently win.
    let tokens = 0, model: string | null = null;
    for (const text of body.split("\n").slice(0, -1)) {
      let rec: any;
      try { rec = JSON.parse(text); } catch { continue; }
      if (rec.type === "model_change" && typeof rec.modelId === "string" && rec.modelId) model = rec.modelId;
      const m = rec.message;
      if (rec.type !== "message" || m?.role !== "assistant") continue;
      if (typeof m.model === "string" && m.model) model = m.model;
      if (!m.usage || typeof m.usage !== "object") continue;
      const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
      const t = n(m.usage.input) + n(m.usage.cacheRead) + n(m.usage.cacheWrite);
      if (t > 0) tokens = t;
    }
    const expected = !Number.isFinite(tokens) || tokens <= 0 ? null
      : Math.max(0, Math.min(100, Math.floor(tokens / contextWindowFor(model ?? "") * 100)));
    const path = join(dir, `${caseId}.jsonl`);
    await writeFile(path, body);
    expect(await PI_TRANSCRIPT.contextPct(path)).toBe(expected);
    expect(await PI_TRANSCRIPT.model(path)).toBe(model);
  }
});

test("pi latest context/model reads do not scan the history prefix", async () => {
  const path = join(await tmpDir("pi-context-cost-"), "s.jsonl");
  const noise = line({ type: "message", message: { role: "toolResult", content: "x".repeat(4096) } });
  await writeFile(path, noise.repeat(4096) + line(assistant({ input: 250_000 }, "grok-4.6")));
  // Count parsed records, not elapsed time on a contended test runner.
  const parse = JSON.parse;
  let calls = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { calls++; return parse(...args); }) as typeof JSON.parse;
  let pct: number | null, model: string | null;
  try {
    pct = await PI_TRANSCRIPT.contextPct(path);
    model = await PI_TRANSCRIPT.model(path);
  } finally { JSON.parse = parse; }
  expect(pct!).toBe(25);
  expect(model!).toBe("grok-4.6");
  expect(calls, "the two reads need only the newest record, not 8194 parses").toBeLessThan(10);
});
