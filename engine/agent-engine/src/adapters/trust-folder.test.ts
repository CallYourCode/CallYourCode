/* PRE-TRUST THE LAUNCH FOLDER so an engine-spawned harness never opens on its
 * first-run "Do you trust the files in this folder?" prompt (default "No,
 * exit"), where the app's first message would type itself and quit the harness.
 *
 * Every config here is a FAKE fixture under a throwaway dir. Never a real
 * ~/.claude.json or ~/.codex/config.toml: the seam test redirects both with
 * CLAUDE_CONFIG_DIR / CODEX_HOME so spawn's write lands in the fixture.
 *
 *   bun test agent-engine/src/adapters/trust-folder.test.ts
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureClaudeTrusted,
  ensureCodexTrusted,
  claudeConfigPath,
  codexConfigPath,
} from "./trust-folder.ts";
import type { Multiplexer, MuxAgent } from "../terminal/mux.ts";

const { MuxAdapter } = await import("./mux-adapter.ts");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cyc-trust-")); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const CWD = "/home/someone/projects/fresh-folder";

test("claude: a not-yet-trusted cwd gets hasTrustDialogAccepted written; a subsequent start would not prompt", () => {
  const cfg = join(dir, ".claude.json");
  const out = ensureClaudeTrusted(cfg, CWD);
  expect(out).toBe("written");
  const obj = JSON.parse(readFileSync(cfg, "utf8"));
  expect(obj.projects[CWD].hasTrustDialogAccepted).toBe(true);
});

test("claude: an already-trusted cwd is a no-op and every other key is preserved", () => {
  const cfg = join(dir, ".claude.json");
  // a realistic pre-existing config: other projects, other top-level keys, and
  // this project already trusted with sibling fields the harness owns.
  const seed = {
    numStartups: 7,
    projects: {
      "/other/repo": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] },
      [CWD]: { hasTrustDialogAccepted: true, allowedTools: ["Read"], lastCost: 0.5 },
    },
  };
  writeFileSync(cfg, JSON.stringify(seed));
  const before = readFileSync(cfg, "utf8");
  const out = ensureClaudeTrusted(cfg, CWD);
  expect(out).toBe("already");
  // byte-identical: an idempotent no-op does not rewrite the file
  expect(readFileSync(cfg, "utf8")).toBe(before);
});

test("claude: trusting a new cwd keeps other projects and top-level keys intact", () => {
  const cfg = join(dir, ".claude.json");
  writeFileSync(cfg, JSON.stringify({ numStartups: 3, projects: { "/other": { hasTrustDialogAccepted: true } } }));
  const out = ensureClaudeTrusted(cfg, CWD);
  expect(out).toBe("written");
  const obj = JSON.parse(readFileSync(cfg, "utf8"));
  expect(obj.numStartups).toBe(3);
  expect(obj.projects["/other"].hasTrustDialogAccepted).toBe(true);
  expect(obj.projects[CWD].hasTrustDialogAccepted).toBe(true);
});

test("codex: a not-yet-trusted cwd gets a trusted [projects.\"<cwd>\"] section; existing content survives", () => {
  const cfg = join(dir, "config.toml");
  writeFileSync(cfg, `notify = ["x"]\n\n[projects."/already"]\ntrust_level = "trusted"\n`);
  const out = ensureCodexTrusted(cfg, CWD);
  expect(out).toBe("written");
  const parsed: any = (Bun as any).TOML.parse(readFileSync(cfg, "utf8"));
  expect(parsed.projects[CWD].trust_level).toBe("trusted");
  expect(parsed.projects["/already"].trust_level).toBe("trusted");
  expect(parsed.notify).toEqual(["x"]);
});

test("codex: an already-trusted cwd is a no-op (byte-identical, no duplicate section)", () => {
  const cfg = join(dir, "config.toml");
  const seed = `[projects.${JSON.stringify(CWD)}]\ntrust_level = "trusted"\n`;
  writeFileSync(cfg, seed);
  const out = ensureCodexTrusted(cfg, CWD);
  expect(out).toBe("already");
  expect(readFileSync(cfg, "utf8")).toBe(seed);
});

test("a locked/corrupt config falls back (skipped) and never throws", () => {
  const badJson = join(dir, ".claude.json");
  writeFileSync(badJson, "{ this is not json");
  expect(ensureClaudeTrusted(badJson, CWD)).toBe("skipped");
  const badToml = join(dir, "config.toml");
  writeFileSync(badToml, `[projects."x"\ntrust_level = broken`);
  expect(ensureCodexTrusted(badToml, CWD)).toBe("skipped");
  // the corrupt file is left untouched, not rewritten
  expect(readFileSync(badToml, "utf8")).toBe(`[projects."x"\ntrust_level = broken`);
});

/** A fake mux that records the command newTab was handed. */
function recordingMux(handle = "w9:p1") {
  const commands: string[] = [];
  const mux = {
    onAgents(cb: (a: MuxAgent[]) => void) { cb([]); },
    start() {},
    async readPane() { return { text: "", truncated: false }; },
    async sendText() {},
    async sendKeys() {},
    async renamePane() {},
    async closePane() {},
    workspaceOf() { return null; },
    knownCwds() { return []; },
    async newTab(opts: { command: string }) { commands.push(opts.command); return handle; },
  } as unknown as Multiplexer;
  return { mux, commands };
}

test("seam: MuxAdapter.spawn pre-trusts the launch folder in claude's config before the pane starts", async () => {
  // Redirect claude's config into the fixture dir so the write can never reach a
  // real ~/.claude.json. codexConfigPath is redirected too for symmetry.
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  const prevCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.CODEX_HOME = join(dir, "codex");
  try {
    expect(existsSync(claudeConfigPath())).toBe(false);
    const { mux } = recordingMux();
    const adapter = new MuxAdapter(mux);
    await adapter.spawn({ cwd: CWD, command: "env CYC_AGENT_ID=ag-0123456789abcdef claude --dangerously-skip-permissions" });
    const obj = JSON.parse(readFileSync(claudeConfigPath(), "utf8"));
    expect(obj.projects[CWD].hasTrustDialogAccepted).toBe(true);
    // idempotent: a second spawn in the same cwd changes nothing
    const before = readFileSync(claudeConfigPath(), "utf8");
    await adapter.spawn({ cwd: CWD, command: "claude --dangerously-skip-permissions" });
    expect(readFileSync(claudeConfigPath(), "utf8")).toBe(before);
    void codexConfigPath();
  } finally {
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodex;
  }
});
