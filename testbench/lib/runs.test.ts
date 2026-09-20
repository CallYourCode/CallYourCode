/* artifacts layout, the expectation map, the exit code. Run explicitly:
 *   bun test testbench/lib/runs.test.ts */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize, type CellVerdict } from "./report.ts";
import { archivePrevious, exitCode, expectedFromSummary, readExpected, runRoot, stamp, writeExpected, diffText } from "./runs.ts";

const cell = (id: string, verdict: CellVerdict["verdict"]): CellVerdict => {
  const [harness, version, mux, scenario] = id.split("/");
  return { cell: id, harness, version, mux, scenario, verdict, reason: `${verdict} because` };
};
const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "tb-runs-"));

describe("runs", () => {
  test("stamp is filesystem-safe and second-resolution", () => {
    expect(stamp("2026-09-02T10:30:15.123Z")).toBe("2026-09-02T10-30-15Z");
  });

  test("--only runs land under only/<stamp>; a tier run is the record itself", () => {
    const now = new Date("2026-09-02T10:30:15Z");
    expect(runRoot("/a", "claude/*/tmux/01*", now)).toBe("/a/only/2026-09-02T10-30-15Z");
    expect(runRoot("/a", null, now)).toBe("/a");
  });

  test("archivePrevious copies the record's summary files to history/<its startedAt>", () => {
    const dir = tmp();
    expect(archivePrevious(dir)).toBeNull();
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ startedAt: "2026-09-02T00:49:19.181Z", cells: [] }));
    writeFileSync(join(dir, "summary.md"), "# summary\n");
    writeFileSync(join(dir, "junit.xml"), "<testsuites/>\n");
    const h = archivePrevious(dir);
    expect(h).toBe(join(dir, "history", "2026-09-02T00-49-19Z"));
    for (const f of ["summary.json", "summary.md", "junit.xml"]) expect(existsSync(join(h!, f))).toBe(true);
    expect(readFileSync(join(h!, "summary.md"), "utf8")).toBe("# summary\n");
    /* the record itself is left for the run to overwrite */
    expect(existsSync(join(dir, "summary.json"))).toBe(true);
  });

  test("archivePrevious falls back to now when the record's startedAt is unreadable", () => {
    const dir = tmp();
    writeFileSync(join(dir, "summary.json"), "{not json");
    const h = archivePrevious(dir, new Date("2026-09-03T01:02:03Z"));
    expect(h).toBe(join(dir, "history", "2026-09-03T01-02-03Z"));
  });

  test("expectedFromSummary keeps green/red, drops errors, merges over the previous map, sorts", () => {
    const prev = { generatedFrom: null, cells: { "pi/0.84.3/tmux/09-cron-redelivery": "red" as const, "claude/2.1.257/tmux/01-bring-up": "green" as const } };
    const e = expectedFromSummary({ startedAt: "2026-09-02T00:49:19.181Z", cells: [
      cell("claude/2.1.257/tmux/01-bring-up", "red"),
      cell("codex/0.148.0/herdr/06-engine-restart", "green"),
      cell("opencode/1.18.19/tmux/03-disconnect", "error"),
    ] }, prev);
    expect(e.generatedFrom).toBe("2026-09-02T00:49:19.181Z");
    expect(Object.keys(e.cells)).toEqual(["claude/2.1.257/tmux/01-bring-up", "codex/0.148.0/herdr/06-engine-restart", "pi/0.84.3/tmux/09-cron-redelivery"]);
    expect(e.cells["claude/2.1.257/tmux/01-bring-up"]).toBe("red");
    const dir = tmp();
    const p = join(dir, "expected", "pr.json");
    writeExpected(p, e);
    expect(readExpected(p)).toEqual(e);
    expect(readExpected(join(dir, "missing.json"))).toBeNull();
  });

  test("the set matches: exit 0; a surprise either direction, an unlisted cell, or an error: exit 1", () => {
    const expected = { cells: { "claude/2.1.257/tmux/01-bring-up": "red" as const, "claude/2.1.257/tmux/12-nested-child": "green" as const, "codex/0.148.0/tmux/06-engine-restart": "green" as const }, path: "testbench/expected/pr.json" };
    const t0 = Date.now();
    const ok = summarize([cell("claude/2.1.257/tmux/01-bring-up", "red"), cell("claude/2.1.257/tmux/12-nested-child", "green")], { tier: "pr", only: null, startedAt: t0, expected });
    expect(ok.surprises).toEqual([]);
    expect(ok.expectedFrom).toBe("testbench/expected/pr.json");
    expect(exitCode(ok)).toBe(0);
    expect(diffText(ok.surprises, ok.expectedFrom ?? null)).toContain("every cell matched");

    const fixed = summarize([cell("claude/2.1.257/tmux/01-bring-up", "green")], { tier: "pr", only: null, startedAt: t0, expected });
    expect(fixed.surprises.map((s) => `${s.expected}>${s.got}`)).toEqual(["red>green"]);
    expect(exitCode(fixed)).toBe(1);

    const broke = summarize([cell("codex/0.148.0/tmux/06-engine-restart", "red")], { tier: "pr", only: null, startedAt: t0, expected });
    expect(exitCode(broke)).toBe(1);
    expect(diffText(broke.surprises, broke.expectedFrom ?? null)).toContain("codex/0.148.0/tmux/06-engine-restart: expected green, got red");

    const unlisted = summarize([cell("pi/0.84.3/herdr/02-deliver-verified", "red")], { tier: "pr", only: null, startedAt: t0, expected });
    expect(unlisted.surprises[0].expected).toBe("(unlisted)");
    expect(exitCode(unlisted)).toBe(1);

    const errored = summarize([cell("claude/2.1.257/tmux/01-bring-up", "error")], { tier: "pr", only: null, startedAt: t0, expected });
    expect(exitCode(errored)).toBe(1);
  });

  test("without a map the lane-1 rule judges, and only errors or rule surprises fail", () => {
    const s = summarize([cell("claude/2.1.257/tmux/01-bring-up", "red"), cell("claude/2.1.257/tmux/12-nested-child", "green")], { tier: "nightly", only: null, startedAt: Date.now() });
    expect(s.expectedFrom).toBeNull();
    expect(exitCode(s)).toBe(0);
  });
});
