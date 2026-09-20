// trust-folder: pre-trust the launch folder so an engine-spawned harness never
// opens on its first-run "Do you trust the files in this folder?" prompt.
//
// THE BUG THIS CLOSES. When the engine spawns claude or codex in a directory
// that harness has not been trusted in before, the harness draws a first-run
// folder-trust dialog whose DEFAULT selection is "No, exit". The engine does
// not clear it, so the next plain app text message types into that menu and its
// Enter picks "No, exit" -- the harness quits. A pure-app first run in a fresh
// folder is dead until someone clears the prompt by hand once. This is separate
// from the permission model, so `--dangerously-skip-permissions` does NOT clear
// it.
//
// THE FIX, NOT A KEYSTROKE. Starting a session in a folder from the app IS the
// user granting trust to that folder; so before the launch we idempotently mark
// the folder trusted in the harness's OWN config, exactly the state the harness
// writes after a human clears the dialog once. We do NOT type into the prompt or
// simulate an accept (fragile: it races the app's first message and depends on
// the menu's default). We touch only the folder-trust bit for this one cwd and
// no other security posture.
//
// EVIDENCE (read-only, from a real host on 2026-09-03):
//   claude ~/.claude.json -> projects["<cwd>"].hasTrustDialogAccepted === true
//   codex  ~/.codex/config.toml -> [projects."<cwd>"] trust_level = "trusted"
//
// DEFENSIVE BY CONSTRUCTION. A missing config is created with just the trust
// entry; an existing one is edited in place, preserving every other byte; a
// locked/corrupt/unreadable config is logged and the launch proceeds exactly as
// today (the human can still clear the dialog once). Nothing here throws into
// the spawn path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** The result of one ensure call, for logging and for tests. `written` changed
 *  the config, `already` found the folder trusted, `skipped` fell back to
 *  today's behavior (missing/locked/corrupt config) without crashing. */
export type TrustOutcome = "written" | "already" | "skipped";

/* The home the ENGINE runs under. `$HOME` before `homedir()` on purpose: bun
 * freezes `os.homedir()` at process start, so a test that points `$HOME` at a
 * throwaway dir (the homeguard preload) would otherwise still resolve the real
 * `~/.claude.json`. shared/cycdir.ts reads `$HOME` first for this same reason.
 * In production the two agree, so the path we write is the path the harness
 * reads. */
function engineHome(): string {
  return process.env.HOME || homedir();
}

/** Where claude keeps its config (and the trusted-folder map). Honors
 *  `CLAUDE_CONFIG_DIR` the way claude itself does, so a test can redirect it. */
export function claudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : join(engineHome(), ".claude.json");
}

/** Where codex keeps its config (and the per-project trust levels). Honors
 *  `CODEX_HOME` the way codex itself does. */
export function codexConfigPath(): string {
  const home = process.env.CODEX_HOME || join(engineHome(), ".codex");
  return join(home, "config.toml");
}

/** Strip a leading `env NAME=VALUE ...` prefix (and a bare `env`) so the first
 *  real token is the program, mirroring how the engine prefixes a launch with
 *  `env CYC_AGENT_ID=... <cmd>` (mux-adapter/env-agent). Then take the basename
 *  so `/usr/bin/claude` and `claude` read the same. */
function programName(command: string): string | null {
  const toks = command.trim().split(/\s+/);
  let i = 0;
  if (toks[i] === "env") i++;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!)) i++;
  const prog = toks[i];
  return prog ? basename(prog) : null;
}

/** Idempotently mark `cwd` trusted in claude's config so the first-run trust
 *  dialog never appears. Preserves every other key; creates a minimal file if
 *  none exists; never throws. */
export function ensureClaudeTrusted(configPath: string, cwd: string): TrustOutcome {
  try {
    let obj: any = {};
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf8");
      obj = raw.trim() ? JSON.parse(raw) : {};
      if (typeof obj !== "object" || obj === null) obj = {};
    }
    if (typeof obj.projects !== "object" || obj.projects === null) obj.projects = {};
    const cur = obj.projects[cwd];
    if (cur && cur.hasTrustDialogAccepted === true) return "already";
    obj.projects[cwd] = { ...(cur && typeof cur === "object" ? cur : {}), hasTrustDialogAccepted: true };
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n");
    return "written";
  } catch (e) {
    console.error(`[trust-folder] claude ${cwd}: ${(e as Error)?.message}; leaving the trust dialog to be cleared by hand`);
    return "skipped";
  }
}

/** Quote a value as a TOML basic string key: escape backslash and double quote
 *  so a path with an odd char cannot break the header. Engine-controlled
 *  absolute paths in practice, but quoting keeps it safe. */
function tomlKey(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Idempotently mark `cwd` trusted in codex's config.toml. Uses Bun.TOML to
 *  read the current trust level; appends a `[projects."<cwd>"]` section only
 *  when the folder is not already trusted. A parse failure (locked/corrupt)
 *  falls back without writing, so a malformed file is never corrupted further.
 *  Never throws. */
export function ensureCodexTrusted(configPath: string, cwd: string): TrustOutcome {
  try {
    let existing = "";
    if (existsSync(configPath)) {
      existing = readFileSync(configPath, "utf8");
      // Bun.TOML.parse throws on malformed input; a locked/corrupt config
      // should fall back, not crash the launch.
      const parsed: any = (Bun as any).TOML.parse(existing);
      const already = parsed?.projects?.[cwd]?.trust_level === "trusted";
      if (already) return "already";
    }
    const section = `\n[projects.${tomlKey(cwd)}]\ntrust_level = "trusted"\n`;
    const next = existing.length && !existing.endsWith("\n") ? existing + "\n" + section : existing + section;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, next);
    return "written";
  } catch (e) {
    console.error(`[trust-folder] codex ${cwd}: ${(e as Error)?.message}; leaving the trust dialog to be cleared by hand`);
    return "skipped";
  }
}

/** Pre-trust the launch folder for the harness this command starts, so the
 *  engine-spawned pane never lands on the first-run folder-trust prompt. Called
 *  in the spawn path (mux-adapter.spawn) before the pane is created. A no-op for
 *  a harness with no such gate (or none we cover yet); never throws.
 *
 *  opencode/pi: not covered here. pi shows no folder-trust gate, and
 *  opencode has no engine launch path today; if either grows one, add a branch
 *  with the same idempotent-write shape. */
export function preTrustLaunchFolder(cwd: string, command: string): TrustOutcome {
  if (!cwd || !command) return "skipped";
  const prog = programName(command);
  if (prog === "claude") return ensureClaudeTrusted(claudeConfigPath(), cwd);
  if (prog === "codex") return ensureCodexTrusted(codexConfigPath(), cwd);
  return "skipped";
}
