/* THE PER-AGENT DISPLAY NAME TABLE (agents.ts), which is all that remains here
 * after capabilities moved into the mux's reader table.
 *
 * The old agents.ts answered "which ONE agent does this engine drive" and then,
 * after #587, "a capability profile per agent". That was split: the profile's
 * dialogs/composer/launch/transcript fields became reader fields owned by the
 * mux (adapters/mux-adapter.ts + readers/*); agents.ts is now exactly the
 * display-name table plus id normalization, and `agentLabel` is the seam core
 * renders a row through. These tests pin the names and the normalization;
 * renames live in `cyc agent rename` (a per-session override), not in env.
 *
 *   bun test agent-engine/src/runtime/agents.test.ts
 */

import { test, expect } from "bun:test";
import { agentIdOfProc, agentLabel, normalizeAgentId, warnRetiredEnv, AGENT_IDS } from "./agents.ts";

test("claude is named Claude, and the label carries the normalized id", () => {
  const p = agentLabel("claude");
  expect(p.id, '"claude" is the filter value; "Claude" is the word on his phone').toBe("claude");
  expect(p.name).toBe("Claude");
  // the herdr:claude alias normalizes before it is labeled
  expect(agentLabel("herdr:claude").id).toBe("claude");
});

test("codex, opencode and pi each have a name and a normalized id", () => {
  for (const id of ["codex", "opencode", "pi"]) {
    const p = agentLabel(id);
    expect(p.id).toBe(id);
    expect(p.name.length, "a name to render, never blank").toBeGreaterThan(0);
  }
});

test("opencode keeps its own lowercase spelling; codex is capitalised", () => {
  expect(agentLabel("opencode").name).toBe("opencode");
  expect(agentLabel("codex").name).toBe("Codex");
});

test("an unknown agent is still named: normalized id, capitalised name", () => {
  const p = agentLabel("someneweditor");
  expect(p.id).toBe("someneweditor");
  expect(p.name).toBe("Someneweditor");
  // the name table only fills what it knows; capitalising is the fallback
  expect(agentLabel("x").name).toBe("X");
});

test("normalizeAgentId lowercases, strips herdr:, and folds the hyphen spellings", () => {
  expect(normalizeAgentId("  Codex ")).toBe("codex");
  expect(normalizeAgentId("herdr:opencode"), "the opencode manifest's alias").toBe("opencode");
  expect(normalizeAgentId("claude-code")).toBe("claude");
  expect(normalizeAgentId("open-code")).toBe("opencode");
  // a herdr:claude stamp still resolves to the claude id
  expect(normalizeAgentId("herdr:claude")).toBe("claude");
});

test("a stamp that is only whitespace, or empty, still answers a label", () => {
  /* agentLabel never returns null by contract: core renders a row through it,
   * and a row with no agent word on it is the failure this table exists to stop.
   * An empty id is the honest end of that: an empty name, not a crash. */
  expect(normalizeAgentId("")).toBe("");
  expect(normalizeAgentId("   ")).toBe("");
  expect(agentLabel("")).toEqual({ id: "", name: "" });
  expect(agentLabel("   ")).toEqual({ id: "", name: "" });
});

test("normalization is case-blind on the herdr: prefix too", () => {
  // the mux stamps what the manifest spells, and manifests are not consistent
  // about case; lowercasing happens BEFORE the prefix is looked for, so an
  // upper-case alias must fold the same as the lower-case one
  expect(normalizeAgentId("HERDR:CLAUDE")).toBe("claude");
  expect(normalizeAgentId("Claude-Code")).toBe("claude");
  expect(normalizeAgentId("OPEN-CODE")).toBe("opencode");
  // one prefix is stripped, not a chain: a doubled stamp is a stamp we do not
  // recognise, and it passes through as itself rather than being guessed at
  expect(normalizeAgentId("herdr:herdr:claude")).toBe("herdr:claude");
});

test("AGENT_IDS lists the known agents, claude among them (tmux matches this set)", () => {
  expect(AGENT_IDS).toContain("claude");
  expect(AGENT_IDS).toContain("codex");
  expect(AGENT_IDS).toContain("opencode");
});

test("every id in AGENT_IDS is already normalized and has a real name", () => {
  /* tmux.ts matches a pane's foreground command against this set, so an entry
   * that is not its own normalized form would be an id no stamp can ever equal:
   * the pane would be seen and then filed under a different id than the row. */
  for (const id of AGENT_IDS) {
    expect(normalizeAgentId(id), `${id} is not its own normalized form`).toBe(id);
    const p = agentLabel(id);
    expect(p.id).toBe(id);
    expect(p.name.length, `${id} has no display name`).toBeGreaterThan(0);
  }
  expect(AGENT_IDS.length).toBeGreaterThanOrEqual(4);
});

/* HARNESS DETECTION IS RUGGED TO WRAPPERS (agentIdOfProc). A usage-freeze
 * wrapper, a version-manager shim, or a renamed launcher execs the REAL
 * harness binary, so the live process no longer reports "claude" in comm or
 * argv[0]; the process must STILL be attributed, or the agent never enters the
 * roster and cannot be messaged. The exe resolver is INJECTED here, so these
 * assertions need no real `/proc` and no real process. */

test("a directly-named claude/codex/pi is still detected (the normal case)", () => {
  // comm carries the name (or the version, with the launched path in argv)
  expect(agentIdOfProc("claude", "claude --resume")).toBe("claude");
  expect(agentIdOfProc("2.1.258", "/home/u/.local/bin/claude --resume")).toBe("claude");
  expect(agentIdOfProc("codex", "codex")).toBe("codex");
  expect(agentIdOfProc("pi", "/usr/bin/pi")).toBe("pi");
});

test("claude launched via a `-real` wrapper is detected as claude", () => {
  // the usage-freeze shape on one linux box: comm and argv[0] are `claude-real`,
  // and only the resolved exe (under .../claude/versions/<ver>) says claude
  const exe = "/home/u/.local/share/claude/versions/2.1.258";
  expect(agentIdOfProc("claude-real", "claude-real", () => exe)).toBe("claude");
  // the suffix strip alone recovers it even before the exe is consulted
  expect(agentIdOfProc("claude-real", "claude-real")).toBe("claude");
});

test("a version-NAMED binary with no harness word is detected via the exe path", () => {
  // comm and argv[0] carry only the version; the resolved exe is the ONLY
  // signal, and its install path (.../claude/versions/<ver>) attributes it
  const exe = "/home/u/.local/share/claude/versions/2.1.258";
  expect(agentIdOfProc("2.1.258", "2.1.258 --resume", () => exe)).toBe("claude");
  // with no exe resolvable (dead pid, no procfs) it stays unattributed
  expect(agentIdOfProc("2.1.258", "2.1.258 --resume", () => null)).toBeNull();
});

test("codex under its version/install dir is detected as codex", () => {
  const exe = "/home/u/.local/lib/node_modules/@openai/codex/bin/codex.js";
  expect(agentIdOfProc("codex-real", "codex-real", () => exe)).toBe("codex");
  // and a codex adopting a claude-style versions dir is caught by the generic
  expect(agentIdOfProc("node", "node /opt/codex/versions/1.4.0/codex")).toBe("codex");
});

test("a wrapper that passes the real binary as an argv token is detected", () => {
  // argv[0] is the wrapper name; the real path rides as a later token
  const args = "claude-real /home/u/.local/share/claude/versions/2.1.258 --resume";
  expect(agentIdOfProc("claude-real", args)).toBe("claude");
});

test("a non-harness process is NOT mis-detected (no false positives)", () => {
  expect(agentIdOfProc("bash", "bash")).toBeNull();
  expect(agentIdOfProc("python3", "python3 foo.py")).toBeNull();
  // a mere mention of the word in an unrelated path arg is not an install
  expect(agentIdOfProc("cat", "cat /home/claude/notes.txt")).toBeNull();
  // even a resolved exe that only PASSES THROUGH the word is not a harness:
  // the install marker (versions / the scoped package) is absent
  expect(agentIdOfProc("editor", "editor", () => "/home/claude/bin/editor")).toBeNull();
  // an ambiguous signal prefers NOT attributing over a wrong attribution
  expect(agentIdOfProc("grep", "grep -r pattern .", () => null)).toBeNull();
});

test("the exe resolver is a fallback: comm/argv win first and it is not called", () => {
  let calls = 0;
  const resolve = () => { calls++; return null; };
  expect(agentIdOfProc("claude", "claude", resolve)).toBe("claude");
  expect(calls, "the normal case pays no readlink").toBe(0);
});

test("warnRetiredEnv says so for the three retired knobs, and is silent otherwise", () => {
  /* ENGINE_AGENT used to decide which panes counted as sessions, and setting it
   * made every OTHER agent invisible. ENGINE_AGENT_NAMES was the display-name
   * override, retired once `cyc agent rename` became the one way to rename a
   * row. All are ignored now, and a modifier who still sets one has to learn
   * that from a line at boot rather than from a list behaving oddly. The env is
   * INJECTED here: nothing in this file touches process.env, so the check
   * cannot leak into another test. */
  const said: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { said.push(a.join(" ")); };
  try {
    warnRetiredEnv({ ENGINE_AGENT: "claude" });
    warnRetiredEnv({ ENGINE_AGENT_NAME: "Claude" });
    warnRetiredEnv({ ENGINE_AGENT: "  " });          // blank is not set
    warnRetiredEnv({ ENGINE_AGENT_NAMES: "claude=X" });
    warnRetiredEnv({});
  } finally {
    console.log = log;
  }
  expect(said).toHaveLength(3);
  expect(said[0]).toContain("ENGINE_AGENT is retired");
  expect(said[1]).toContain("ENGINE_AGENT_NAME is retired");
  expect(said[2]).toContain("ENGINE_AGENT_NAMES is retired");
  for (const line of said) expect(line, "the line has to name the replacement").toContain("cyc agent rename");
});
