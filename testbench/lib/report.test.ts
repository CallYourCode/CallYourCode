/* summary/junit aggregation. Run explicitly:
 *   bun test testbench/lib/report.test.ts */
import { describe, expect, test } from "bun:test";
import { expectedVerdict, junitXml, summarize, summaryMarkdown, type CellVerdict } from "./report.ts";

const cell = (scenario: string, verdict: CellVerdict["verdict"], extra: Partial<CellVerdict> = {}): CellVerdict => ({
  cell: `claude/2.1.257/tmux/${scenario}`, harness: "claude", version: "2.1.257", mux: "tmux", scenario, verdict, reason: `${verdict} because`, ms: 1500, ...extra,
});

describe("report", () => {
  test("lane-1 expectation: 1 to 11 red, 12 and 13 green", () => {
    expect(expectedVerdict("01-bring-up")).toBe("red");
    expect(expectedVerdict("11-attach-slot")).toBe("red");
    expect(expectedVerdict("12-nested-child")).toBe("green");
    expect(expectedVerdict("13-version-gate")).toBe("green");
  });

  test("summarize counts and names the surprises", () => {
    const s = summarize([
      cell("01-bring-up", "red"),
      cell("02-deliver-verified", "green"),
      cell("12-nested-child", "green", { facts: { supported: true } }),
      cell("13-version-gate", "red"),
      cell("05-close-reopen", "error"),
      cell("09-cron-redelivery", "skipped"),
    ], { tier: "pr", only: null, startedAt: Date.now() - 5000 });
    expect(s.counts).toEqual({ green: 2, red: 2, error: 1, skipped: 1 });
    expect(s.surprises.map((x) => `${x.cell}:${x.expected}>${x.got}`).sort()).toEqual([
      "claude/2.1.257/tmux/02-deliver-verified:red>green",
      "claude/2.1.257/tmux/05-close-reopen:red>error",
      "claude/2.1.257/tmux/13-version-gate:green>red",
    ]);
    expect(s.wallMs).toBeGreaterThanOrEqual(5000);
    const md = summaryMarkdown(s);
    expect(md).toContain("## Surprises");
    expect(md).toContain("| 12-nested-child | claude 2.1.257 | tmux | green | green |");
    expect(md).toContain("## Facts");
    expect(md).toContain("supported=true");
  });

  test("image sizes are labelled: content (inspect) and on disk (docker images)", () => {
    const s = summarize([cell("12-nested-child", "green")], { tier: "pr", only: null, startedAt: Date.now(), images: [{ image: "cyc-testbench/claude:2.1.257", size: "197 MB", disk: "862MB" }] });
    const md = summaryMarkdown(s);
    expect(md).toContain("## Images (content = `docker image inspect .Size`");
    expect(md).toMatch(/cyc-testbench\/claude:2\.1\.257 +content 197 MB, on disk 862MB/);
  });

  test("junit: one suite per scenario, failures/errors/skips typed", () => {
    const s = summarize([cell("01-bring-up", "red", { checks: [{ name: "row has harness", ok: false, detail: "undefined" }] }), cell("01-bring-up", "error", { cell: "codex/0.148.0/tmux/01-bring-up", harness: "codex", version: "0.148.0" }), cell("13-version-gate", "green"), cell("09-cron-redelivery", "skipped")],
      { tier: "pr", only: null, startedAt: Date.now() });
    const x = junitXml(s);
    expect(x).toContain(`<testsuites name="cyc-testbench" tests="4" failures="1" errors="1" skipped="1"`);
    expect(x).toContain(`<testsuite name="01-bring-up" tests="2" failures="1" errors="1" skipped="0">`);
    expect(x).toContain(`<failure message="red because">row has harness: undefined</failure>`);
    expect(x).toContain(`<error message="error because"/>`);
    expect(x).toContain(`<skipped message="skipped because"/>`);
    expect(x).toContain(`classname="codex.0.148.0.tmux"`);
  });
});
