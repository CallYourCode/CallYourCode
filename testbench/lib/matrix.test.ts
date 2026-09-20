/* bun test testbench/lib/matrix.test.ts */
import { describe, expect, test } from "bun:test";
import { expandTier, loadMatrix, matchOnly, validateMatrix } from "./matrix.ts";

describe("matrix", () => {
  const m = loadMatrix();

  test("loads and validates the checked-in matrix", () => {
    expect(Object.keys(m.harnesses).sort()).toEqual(["claude", "codex", "opencode", "pi"]);
    expect(m.tiers.real.enabled).toBe(false);
    expect(m.harnesses.claude.primary).toBe("2.1.257");
  });

  test("pr tier expands to harness x mux x scenario at primary pins", () => {
    const cells = expandTier(m, "pr");
    const plain = m.scenarios.filter((s) => !s.mux).length;
    const both = m.scenarios.filter((s) => s.mux === "both").length;
    expect(cells.length).toBe(4 * (plain * 2 + both));
    expect(cells.every((c) => c.version === m.harnesses[c.harness].primary)).toBe(true);
    const two = cells.filter((c) => c.scenario === "10-two-muxes");
    expect(two.length).toBe(4);
    expect(two.every((c) => c.mux === "both")).toBe(true);
    const gate = cells.filter((c) => c.scenario === "13-version-gate" && c.harness === "codex");
    expect(gate.length).toBe(2);
    expect(gate[0].versions).toEqual(["0.148.0"]);
    expect(new Set(cells.map((c) => c.id)).size).toBe(cells.length);
  });

  test("nightly adds compat pins", () => {
    const cells = expandTier(m, "nightly");
    const claude = cells.filter((c) => c.harness === "claude" && c.scenario === "01-bring-up");
    expect(claude.map((c) => c.version)).toEqual(["2.1.257", "2.1.257", "2.1.200", "2.1.200", "2.0.90", "2.0.90"]);
    const gates = cells.filter((c) => c.harness === "claude" && c.scenario === "13-version-gate");
    expect(gates.length).toBe(6);
    expect(gates.every((c) => c.versions?.join() === "2.1.257,2.1.200,2.0.90")).toBe(true);
  });

  test("real tier refuses to expand", () => {
    expect(() => expandTier(m, "real")).toThrow(/disabled/);
    expect(() => validateMatrix({ ...m, tiers: { ...m.tiers, real: { ...m.tiers.real, enabled: true } } })).toThrow(/real tier/);
  });

  test("--only matching", () => {
    const cells = expandTier(m, "pr");
    const one = cells.filter((c) => matchOnly(c, "claude/2.1.257/tmux/01-bring-up"));
    expect(one.map((c) => c.id)).toEqual(["claude/2.1.257/tmux/01-bring-up"]);
    expect(cells.filter((c) => matchOnly(c, "codex/*/herdr")).every((c) => c.harness === "codex" && c.mux === "herdr")).toBe(true);
    expect(cells.filter((c) => matchOnly(c, "*/*/*/12-nested-child")).length).toBe(8);
    expect(cells.filter((c) => matchOnly(c, "pi")).length).toBe(cells.length / 4);
    /* globs and comma lists per segment; `;` joins patterns */
    expect(cells.filter((c) => matchOnly(c, "claude/*/tmux/0[2-8]*")).map((c) => c.scenario).sort())
      .toEqual(["02-deliver-verified", "03-disconnect", "04-rollover", "05-close-reopen", "06-engine-restart", "07-mux-restart", "08-overlay-input"]);
    expect(cells.filter((c) => matchOnly(c, "claude,pi/*/tmux/01-bring-up")).map((c) => c.harness).sort()).toEqual(["claude", "pi"]);
    expect(cells.filter((c) => matchOnly(c, "codex/*/tmux/01-*;pi/*/tmux/13-*")).length).toBe(2);
    expect(cells.filter((c) => matchOnly(c, "claude/2.1.25?/tmux/01-bring-up")).length).toBe(1);
  });
});
