/* the transcript parsers keep the turns in the order the harness wrote them
 * (scenario 6 reads that order for "after the turn edge") */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude, pi, type CellPaths } from "./harness.ts";

const pathsIn = (home: string): CellPaths => ({ home, repo: home, work: "/work/w", data: home, out: home });
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("transcript turns", () => {
  test("claude: user and assistant texts interleave in file order", async () => {
    const home = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), "tb-harness-"));
    const dir = join(home, ".claude", "projects", "-work-w");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), jsonl([
      { type: "user", sessionId: "s1", message: { role: "user", content: "SLOW please" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "streaming, until the stream ends." }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } },
      { type: "user", message: { role: "user", content: "TEXT: after the edge" } },
    ]));
    const [t] = await claude.transcripts(pathsIn(home), "/work/w");
    expect(t.id).toBe("s1");
    expect(t.userTexts).toEqual(["SLOW please", "TEXT: after the edge"]);
    expect(t.assistantTexts).toEqual(["streaming, until the stream ends."]);
    expect(t.turns.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    const iTail = t.turns.findIndex((x) => x.role === "assistant" && x.text.includes("until the stream ends."));
    const iUser = t.turns.findIndex((x) => x.role === "user" && x.text.includes("after the edge"));
    expect(iUser).toBeGreaterThan(iTail);
  });

  test("pi: message rows in order, other cwds skipped", async () => {
    const home = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), "tb-harness-"));
    const dir = join(home, ".pi", "agent", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a_one.jsonl"), jsonl([
      { type: "session", id: "one", cwd: "/work/w" },
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok." }] } },
      { type: "message", message: { role: "user", content: "/TEXT: through the overlay" } },
    ]));
    writeFileSync(join(dir, "b_two.jsonl"), jsonl([
      { type: "session", id: "two", cwd: "/elsewhere" },
      { type: "message", message: { role: "user", content: "not ours" } },
    ]));
    const ts = await pi.transcripts(pathsIn(home), "/work/w");
    expect(ts.map((t) => t.id)).toEqual(["one"]);
    expect(ts[0].turns).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "ok." },
      { role: "user", text: "/TEXT: through the overlay" },
    ]);
  });
});
