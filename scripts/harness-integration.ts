#!/usr/bin/env bun
/* Harness integration installer: gives every detected harness (claude,
 * opencode, codex) the same CallYourCode pieces -- the speak/chat/show MCP
 * server, the skill, and the two hooks -- each in that harness's real
 * mechanism (formats verified on this box; PARITY.md).
 *
 *   bun scripts/harness-integration.ts [claude] [opencode] [codex] [pi] [--dry-run]
 *
 * With no harness named, installs for every harness detected on the machine
 * (binary on PATH or config root present) and exits 0 when there is none.
 * Idempotent and non-destructive: merges into existing configs, never
 * clobbers, backs up before any write.
 *
 * What it touches, and nothing else:
 *
 * claude (~/.claude, ~/.claude.json):
 *   .claude.json                 adds mcpServers.callyourcode (bun + the repo's
 *                                engine/mcp/src/server.ts); drops a legacy
 *                                mcpServers.voice entry that points at this
 *                                repo's old voice-channel/ dir
 *   .claude/settings.json        appends the hooks: Stop (matcher "*")
 *                                runs hooks/enforce-voice-reply.py, PreToolUse
 *                                (matcher "Bash") runs hooks/enforce-bash-async.py,
 *                                and SessionStart + UserPromptSubmit both run
 *                                hooks/announce-session.py (the session-identity
 *                                announce, engine bug 19)
 *   .claude/skills/callyourcode/ the repo skill, copied fresh; a legacy
 *                                callyourcode dir is archived away
 *
 * opencode (~/.config/opencode, or $XDG_CONFIG_HOME/opencode):
 *   opencode.json                adds mcp.callyourcode (type local, bun + the
 *                                repo's engine/mcp/src/server.ts)
 *   plugin/callyourcode.ts       this repo's plugin (bash guard + reply
 *                                nudge), copied fresh with the engine's .run
 *                                dir stamped in
 *   skill/callyourcode/          the repo skill, copied fresh, but ONLY when
 *                                ~/.claude/skills/callyourcode is absent:
 *                                opencode auto-discovers claude's skills, and
 *                                two copies of one skill would both fire.
 *                                Legacy `callyourcode` dirs (here AND in
 *                                ~/.claude/skills, which opencode reads) are
 *                                archived to ~/.callyourcode/archive/, never
 *                                left beside the new skill
 *
 * codex ($CODEX_HOME or ~/.codex):
 *   config.toml                  appends [mcp_servers.callyourcode]; inserts
 *                                the root-level notify announcer
 *                                (hooks/announce-session.py --codex-notify,
 *                                the session-identity announce: codex's
 *                                notify payload carries thread-id, the
 *                                rollout uuid). An existing foreign notify
 *                                is refused loudly, never clobbered
 *   hooks.json                   adds the Stop hook (the claude
 *                                enforce-voice-reply.py, verbatim: its
 *                                session lookup already falls through to
 *                                HERDR_PANE_ID) and the PreToolUse shell
 *                                guard (engine/harness/codex/enforce-shell-async.py)
 *   skills/callyourcode/         the repo skill, copied fresh; a legacy
 *                                skills/callyourcode dir is archived away
 *
 * pi (~/.pi/agent, or $PI_CODING_AGENT_DIR):
 *   settings.json                adds the absolute path of the repo's
 *                                engine/harness/pi/cyc-output.js to
 *                                `extensions` (reply tools + session announce)
 *
 * Codex asks once, at the next interactive start, to trust the two hooks
 * (its startup hooks review). That is codex's supported flow; this installer
 * does not forge trust hashes.
 *
 * Env overrides, for tests only: CYC_HOME (fake $HOME), CYC_FAKE_HARNESSES
 * (comma list, skips binary detection).
 */

import * as fs from "node:fs"
import * as path from "node:path"

// ---------------------------------------------------------------------------
// Pure config transformations (unit-tested against fixtures of the real
// formats; see scripts/harness-integration.test.ts).

/* The MCP wiring every harness config carries: the ABSOLUTE path of the cyc
 * shim (the installer always writes it at ~/.bun/bin/cyc). Bare `cyc` looked
 * portable but relied on PATH, and harness hooks run under /bin/sh with a
 * bare system PATH that never includes ~/.bun/bin -- live 2026-09-22, every
 * hook and the MCP died with "cyc: command not found" on a fresh install.
 * The shim itself resolves the local engine, so a moved engine dir still
 * works; only the shim's home-relative location is baked in. `MCP_ARGS` is
 * the args a `command`+`args` config (claude, codex) uses; `MCP_COMMAND` is
 * the single argv a `command:[...]` config (opencode) uses. */
import * as os from "node:os"
const home = (): string => process.env.CYC_HOME ?? os.homedir()
export const MCP_LAUNCHER = path.join(home(), ".bun", "bin", "cyc")
export const MCP_ARGS = ["mcp"]
export const MCP_COMMAND = [MCP_LAUNCHER, ...MCP_ARGS]

/* opencode.json: merge mcp.callyourcode. Shape captured from a real
 * `opencode mcp add` run: {type:"local", command:[...], environment:{}}. An
 * entry left by an older installer (an absolute `bun .../server.ts`) is MIGRATED
 * to the launcher in place -- opencode.json is JSON, safely rewritable. */
export function mergeOpencodeConfig(
  text: string,
): { text: string; changed: boolean; note: string } {
  const data = text.trim() ? JSON.parse(text) : {}
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("opencode.json root is not an object")
  }
  if (!("$schema" in data)) data["$schema"] = "https://opencode.ai/config.json"
  const mcp = (data.mcp ??= {})
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
    throw new Error("opencode.json mcp is not an object")
  }
  const desired = { type: "local", command: MCP_COMMAND }
  const present = mcp.callyourcode
  if (present !== undefined && JSON.stringify(present) === JSON.stringify(desired)) {
    return { text, changed: false, note: "mcp.callyourcode already on `cyc mcp`" }
  }
  const migrated = present !== undefined
  mcp.callyourcode = desired
  return {
    text: JSON.stringify(data, null, 2) + "\n",
    changed: true,
    note: migrated ? "migrated mcp.callyourcode to `cyc mcp`" : "added mcp.callyourcode (`cyc mcp`)",
  }
}

/* pi's settings.json (~/.pi/agent/settings.json): add the cyc extension's
 * ABSOLUTE path to the top-level `extensions` array. pi has no MCP; this one
 * extension is its whole integration: the speak/chat/show reply tools, and the
 * session-identity announce that lets the engine tail its transcript. Without
 * it a plain `pi` typed into a pane has no way to reply and the app shows no
 * session rows. The engine's own `-e <same path>` on a pi it spawns is merged
 * with this entry by pi (canonical-path dedupe), so the file loads once. An
 * older entry for the same file at another path (a moved checkout) is
 * replaced in place; every other key and entry is kept. */
const PI_EXTENSION_SUFFIX = path.join("engine", "harness", "pi", "cyc-output.js")

export function mergePiSettings(
  text: string,
  extensionPath: string,
): { text: string; changed: boolean; note: string } {
  const data = text.trim() ? JSON.parse(text) : {}
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("pi settings.json root is not an object")
  }
  const list = (data.extensions ??= [])
  if (!Array.isArray(list)) throw new Error("pi settings.json extensions is not an array")
  if (list.includes(extensionPath)) {
    return { text, changed: false, note: "extensions already has the cyc extension" }
  }
  const stale = list.findIndex((p: unknown) => typeof p === "string" && p.endsWith(PI_EXTENSION_SUFFIX))
  if (stale >= 0) list[stale] = extensionPath
  else list.push(extensionPath)
  return {
    text: JSON.stringify(data, null, 2) + "\n",
    changed: true,
    note: stale >= 0 ? "moved the cyc extension entry to this checkout" : "added the cyc extension",
  }
}

/* pi-claude-bridge 1M default. Upstream serves an unmeasured model at 200K
 * until it is added to a hardcoded list; provider.oneMByDefault (our upstream
 * PR, elidickinson/pi-claude-bridge#126) gives any model pi-ai declares at 1M
 * its [1m] id. Until a release carries it, the installer re-applies the shipped
 * patch to the installed bridge, so a reinstall does not quietly drop it. */
export const PI_BRIDGE_PATCH = path.join("engine", "harness", "pi", "bridge-one-m.patch")

export function bridgeDirOf(agentDir: string): string {
  return path.join(agentDir, "npm", "node_modules", "pi-claude-bridge")
}

export function bridgeHasOneM(modelsTs: string): boolean {
  return /\boneMByDefault\b/.test(modelsTs)
}

/* claude-bridge.json: turn oneMByDefault on for a Max plan only. An unentitled
 * [1m] request fails every turn, so a Pro/unset plan is left alone, and an
 * explicit value (true or false) is never overwritten. */
export function mergeBridgeConfig(text: string): { text: string; changed: boolean; note: string } {
  const data = text.trim() ? JSON.parse(text) : {}
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("claude-bridge.json root is not an object")
  }
  const provider = data.provider
  if (provider !== undefined && (typeof provider !== "object" || provider === null || Array.isArray(provider))) {
    throw new Error("claude-bridge.json provider is not an object")
  }
  if (provider && typeof provider.oneMByDefault === "boolean") {
    return { text, changed: false, note: `provider.oneMByDefault already ${provider.oneMByDefault}` }
  }
  if (!provider || provider.plan !== "max") {
    return { text, changed: false, note: "plan is not max: oneMByDefault left off" }
  }
  provider.oneMByDefault = true
  return { text: JSON.stringify(data, null, 2) + "\n", changed: true, note: "set provider.oneMByDefault (Max plan)" }
}

/* Apply the shipped patch to the installed bridge when its code lacks the
 * setting. Dry-run first: a bridge that moved on (or already merged it in
 * another shape) is reported, never half-patched. */
function ensureBridgeOneM(bridgeDir: string, repo: string, dry: boolean): void {
  const modelsTs = path.join(bridgeDir, "src", "models.ts")
  const text = fs.readFileSync(modelsTs, "utf-8")
  if (bridgeHasOneM(text)) {
    console.log("  skip  pi-claude-bridge: already supports oneMByDefault")
    return
  }
  const patchFile = path.join(repo, PI_BRIDGE_PATCH)
  const run = (extra: string[]) =>
    Bun.spawnSync(["patch", "-p1", "--forward", "--batch", "--no-backup-if-mismatch", ...extra, "-i", patchFile], {
      cwd: bridgeDir, stdout: "pipe", stderr: "pipe",
    })
  const check = run(["--dry-run"])
  if (check.exitCode !== 0) {
    console.log("  WARN  pi-claude-bridge: oneMByDefault patch does not apply to this version; unmeasured models stay at 200K")
    return
  }
  if (dry) {
    console.log(`  would patch ${bridgeDir} (oneMByDefault)`)
    return
  }
  const res = run([])
  console.log(res.exitCode === 0
    ? "  ok    pi-claude-bridge: applied the oneMByDefault patch"
    : "  WARN  pi-claude-bridge: oneMByDefault patch failed; unmeasured models stay at 200K")
}

/* config.toml: append [mcp_servers.callyourcode]. Shape captured from a real
 * `codex mcp add` run. Append-if-absent keeps every existing byte intact;
 * TOML is not round-trippable with a naive parser, so nothing is rewritten. */
export function mergeCodexToml(
  text: string,
): { text: string; changed: boolean; note: string } {
  if (/^\s*\[mcp_servers\.callyourcode(\.|\])/m.test(text)) {
    // TOML is not round-trippable with a naive parser, so an existing section
    // is left byte-for-byte intact -- except OUR old bare-`cyc` command line,
    // which relied on PATH and died under /bin/sh (2026-09-22): that one line
    // is migrated in place to the absolute shim.
    const bare = /^(\s*command\s*=\s*)"cyc"(\s*)$/m
    if (bare.test(text)) {
      return {
        text: text.replace(bare, `$1${JSON.stringify(MCP_LAUNCHER)}$2`),
        changed: true,
        note: "migrated [mcp_servers.callyourcode] command to the absolute cyc shim",
      }
    }
    return { text, changed: false, note: "[mcp_servers.callyourcode] already present" }
  }
  const section = `[mcp_servers.callyourcode]\ncommand = ${JSON.stringify(MCP_LAUNCHER)}\nargs = ${JSON.stringify(MCP_ARGS)}\n`
  const sep = text.length === 0 || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"
  return {
    text: text + sep + section,
    changed: true,
    note: "appended [mcp_servers.callyourcode] (`cyc mcp`)",
  }
}

/* config.toml: wire the session-identity announcer into codex's `notify`
 * setting (the program codex runs at turn boundaries with one JSON argument;
 * its payload carries thread-id = the rollout uuid, verified against the
 * codex 0.148.0 binary). The command is the path-INDEPENDENT launcher
 * (`cyc hook announce-session --codex-notify`), never an absolute engine path,
 * so a config copied across machines still finds the local engine. `notify` is
 * a ROOT key, so it must sit BEFORE the first [table] header or TOML reads it as
 * that table's key; insertion, not append. codex supports exactly one notify
 * program, so an existing FOREIGN notify is REFUSED loudly (never clobbered,
 * never silently chained: chaining would mean rewriting the user's program into
 * a wrapper this installer does not own). An older absolute-path OURS notify is
 * MIGRATED in place to the launcher; ours-already-launcher is idempotent. */
const NOTIFY_LINE = `notify = [${JSON.stringify(MCP_LAUNCHER)}, "hook", "announce-session", "--codex-notify"]`

export function mergeCodexNotify(
  text: string,
): { text: string; changed: boolean; note: string } {
  const firstTable = text.match(/^\s*\[/m)
  const rootRegion = firstTable?.index !== undefined ? text.slice(0, firstTable.index) : text
  const existing = rootRegion.match(/^\s*notify\s*=.*$/m)
  if (existing) {
    const line = existing[0]
    // Ours in either form: the launcher command or an old absolute
    // announce-session.py path (from this or any other machine).
    if (line.includes("announce-session")) {
      if (line.trim() === NOTIFY_LINE) {
        return { text, changed: false, note: "notify announcer already present" }
      }
      return {
        text: text.replace(line, NOTIFY_LINE),
        changed: true,
        note: "migrated notify announcer to `cyc hook announce-session`",
      }
    }
    return {
      text,
      changed: false,
      note:
        `REFUSED: config.toml already sets notify (${line.trim()}); ` +
        `codex runs exactly one notify program, so wire the announcer yourself ` +
        `(have your program also run: cyc hook announce-session --codex-notify '<the JSON arg>')`,
    }
  }
  const line = NOTIFY_LINE + "\n"
  if (firstTable?.index === undefined) {
    const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n"
    return { text: text + sep + line, changed: true, note: "added notify announcer" }
  }
  return {
    text: text.slice(0, firstTable.index) + line + "\n" + text.slice(firstTable.index),
    changed: true,
    note: "added notify announcer",
  }
}

/* The path-INDEPENDENT hook command a harness config carries: the launcher
 * (`cyc hook <name>`, scripts/cyc.ts), never an absolute engine `.py` path. The
 * name is one of the whitelisted engine hooks (enforce-voice-reply,
 * enforce-bash-async, enforce-shell-async, announce-session); the launcher
 * resolves it against the LOCAL engine, so a config copied across machines (or a
 * moved engine dir) never carries a dead absolute path -- the config-portable
 * footgun that silently killed codex's outbound reply on one host. */
export const hookCommand = (name: string): string => `${MCP_LAUNCHER} hook ${name}`

/* Is `command` OUR wire for the engine hook `name`? True for the portable
 * `cyc hook <name>` form AND for a legacy `python3 <abspath>/<name>.py` form
 * (from THIS or any other machine -- a copied config carries the source box's
 * absolute path). A foreign hook matches neither and is never touched. */
function isOurHookCommand(command: unknown, name: string): boolean {
  if (typeof command !== "string") return false
  // `cyc hook <name>` matches the bare legacy form AND the absolute-shim form
  // (which ends in .../cyc hook <name>), so both migrate to the current wire.
  return command.includes(`cyc hook ${name}`) || command.includes(`/${name}.py`)
}

/* Find our existing hook object (portable or legacy) for `name` under an event's
 * entry list, so it can be migrated in place; null when we have none there. */
function findOurHook(entries: any, name: string): { command?: unknown } | null {
  for (const entry of entries ?? []) {
    for (const h of entry?.hooks ?? []) {
      if (isOurHookCommand(h?.command, name)) return h
    }
  }
  return null
}

/* hooks.json: merge our Stop and PreToolUse entries into the Claude-shaped
 * schema codex reads (verified via the hooks/list RPC). Each command is the
 * path-independent `cyc hook <name>` launcher. Idempotent + migrating: an
 * existing `cyc hook <name>` is a no-op, an older absolute-path OURS command is
 * migrated in place to the launcher, a foreign hook is never touched. */
export function mergeCodexHooks(
  text: string,
  stopHook: string,
  preHook: string,
): { text: string; changed: boolean; notes: string[] } {
  const data = text.trim() ? JSON.parse(text) : {}
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("hooks.json root is not an object")
  }
  const hooks = (data.hooks ??= {})
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("hooks.json hooks is not an object")
  }

  // No matcher on either event: codex's shell tool name is not pinned across
  // versions, so the scripts self-filter on the payload instead.
  const wanted: [string, string][] = [
    ["Stop", stopHook],
    ["PreToolUse", preHook],
  ]

  const notes: string[] = []
  let changed = false
  for (const [event, name] of wanted) {
    const desired = hookCommand(name)
    const found = findOurHook(hooks[event], name)
    if (found) {
      if (found.command === desired) {
        notes.push(`${event} hook already present (${name})`)
        continue
      }
      found.command = desired
      notes.push(`migrated ${event} hook to \`${desired}\``)
      changed = true
      continue
    }
    ;(hooks[event] ??= []).push({ hooks: [{ type: "command", command: desired }] })
    notes.push(`added ${event} hook (${name})`)
    changed = true
  }
  return { text: JSON.stringify(data, null, 2) + "\n", changed, notes }
}

/* ~/.claude.json: merge mcpServers.callyourcode = {command:"bun", args:[script]}.
 * Also drops a legacy mcpServers.voice entry whose args point into this repo's
 * pre-593 voice-channel/ dir; an unrelated server someone else named "voice" is
 * not this installer's to touch. Same already-present rule as the others. */
export function mergeClaudeJson(
  text: string,
): { text: string; changed: boolean; note: string } {
  const data = text.trim() ? JSON.parse(text) : {}
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(".claude.json root is not an object")
  }
  const servers = (data.mcpServers ??= {})
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error(".claude.json mcpServers is not an object")
  }
  const stale =
    "voice" in servers &&
    (servers.voice?.args ?? []).map((a: unknown) => String(a)).join(" ").includes("voice-channel")
  const desired = { command: MCP_LAUNCHER, args: MCP_ARGS }
  const present = servers.callyourcode
  const onLauncher = present !== undefined && JSON.stringify(present) === JSON.stringify(desired)
  if (onLauncher && !stale) {
    return { text, changed: false, note: "mcpServers.callyourcode already on `cyc mcp`" }
  }
  // Migrate an older installer's absolute `bun .../server.ts` in place
  // (.claude.json is JSON, safely rewritable).
  let note = present === undefined ? "added mcpServers.callyourcode (`cyc mcp`)" : "migrated mcpServers.callyourcode to `cyc mcp`"
  if (stale) {
    delete servers.voice
    note += " (removed legacy mcpServers.voice)"
  }
  servers.callyourcode = desired
  return { text: JSON.stringify(data, null, 2) + "\n", changed: true, note }
}

/* ~/.claude/settings.json: merge our hooks. Claude keys hooks by event with
 * a matcher (Stop matches "*", PreToolUse matches "Bash"); each command is the
 * path-independent `cyc hook <name>` launcher, and already-present /
 * migrate-legacy / leave-foreign follow the same rules as the codex merge.
 * `announceHook` adds the session-identity announce (announce-session) on
 * SessionStart -- which fires for startup, --resume/--continue and /clear --
 * plus UserPromptSubmit as the idempotent belt-and-braces re-announce (heals an
 * engine that was down when SessionStart fired). Optional so existing callers
 * and fixtures read unchanged. */
export function mergeClaudeSettings(
  text: string,
  stopHook: string,
  preHook: string,
  announceHook?: string,
): { text: string; changed: boolean; notes: string[] } {
  const data = text.trim() ? JSON.parse(text) : {}
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("settings.json root is not an object")
  }
  const hooks = (data.hooks ??= {})
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("settings.json hooks is not an object")
  }

  const wanted: [string, string, string][] = [
    ["Stop", "*", stopHook],
    ["PreToolUse", "Bash", preHook],
    ...(announceHook
      ? ([["SessionStart", "*", announceHook],
          ["UserPromptSubmit", "*", announceHook]] as [string, string, string][])
      : []),
  ]

  const notes: string[] = []
  let changed = false
  for (const [event, matcher, name] of wanted) {
    const desired = hookCommand(name)
    const found = findOurHook(hooks[event], name)
    if (found) {
      if (found.command === desired) {
        notes.push(`${event} hook already present (${name})`)
        continue
      }
      found.command = desired
      notes.push(`migrated ${event} hook to \`${desired}\``)
      changed = true
      continue
    }
    ;(hooks[event] ??= []).push({ matcher, hooks: [{ type: "command", command: desired }] })
    notes.push(`added ${event} hook (${name})`)
    changed = true
  }
  return { text: JSON.stringify(data, null, 2) + "\n", changed, notes }
}

// ---------------------------------------------------------------------------
// Filesystem plumbing: backup + atomic write, fresh-copy dirs, dry-run.

const ts = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")

function writeMerged(file: string, next: string, dry: boolean): void {
  if (dry) {
    console.log(`  would write ${file}`)
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-${ts()}`
    fs.copyFileSync(file, backup)
    console.log(`  ok    backed up ${file} -> ${backup}`)
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, file)
}

function copyDirFresh(src: string, dst: string, dry: boolean): void {
  if (dry) {
    console.log(`  would copy ${src} -> ${dst}`)
    return
  }
  fs.rmSync(dst, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.cpSync(src, dst, { recursive: true })
}

// ---------------------------------------------------------------------------
// Per-harness installs.

export function installClaude(opts: { home: string; repo: string; dry: boolean }): void {
  const { home, repo, dry } = opts
  console.log(`claude -> ${path.join(home, ".claude")}`)

  // 1. MCP registration in ~/.claude.json (path-independent: `cyc mcp`).
  const jsonFile = path.join(home, ".claude.json")
  const jsonText = fs.existsSync(jsonFile) ? fs.readFileSync(jsonFile, "utf-8") : ""
  const merged = mergeClaudeJson(jsonText) // invalid JSON crashes loud, we touch nothing
  if (merged.changed) {
    writeMerged(jsonFile, merged.text, dry)
    console.log(`  ok    .claude.json: ${merged.note}`)
  } else {
    console.log(`  skip  .claude.json: ${merged.note}`)
  }

  // 2. Both hooks in ~/.claude/settings.json.
  const settingsFile = path.join(home, ".claude", "settings.json")
  const settingsText = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf-8") : ""
  // Path-independent: the launcher names the engine hook, never an absolute
  // path (the config-portable footgun). scripts/cyc.ts resolves each name.
  const settings = mergeClaudeSettings(
    settingsText,
    "enforce-voice-reply",
    "enforce-bash-async",
    "announce-session",
  )
  for (const note of settings.notes)
    console.log(`  ${note.startsWith("added") ? "ok   " : "skip "} settings.json: ${note}`)
  if (settings.changed) writeMerged(settingsFile, settings.text, dry)

  // 3. Skill.
  const skillDst = path.join(home, ".claude", "skills", "callyourcode")
  copyDirFresh(path.join(repo, "engine", "skills", "callyourcode"), skillDst, dry)
  console.log(`  ok    installed skill -> ${skillDst}`)
}

export function installOpencode(opts: { home: string; repo: string; dry: boolean }): void {
  const { home, repo, dry } = opts
  const configRoot =
    process.env.XDG_CONFIG_HOME && !process.env.CYC_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
      : path.join(home, ".config", "opencode")
  console.log(`opencode -> ${configRoot}`)

  // 1. MCP registration (path-independent: `cyc mcp`).
  const cfgFile = path.join(configRoot, "opencode.json")
  const cfgText = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, "utf-8") : ""
  const merged = mergeOpencodeConfig(cfgText) // invalid JSON crashes loud, we touch nothing
  if (merged.changed) {
    writeMerged(cfgFile, merged.text, dry)
    console.log(`  ok    opencode.json: ${merged.note}`)
  } else {
    console.log(`  skip  opencode.json: ${merged.note}`)
  }

  // 2. Plugin (both hook ports), fresh each run. It resolves the engine's
  // data dir from env at runtime, so nothing is stamped into it.
  const pluginSrc = path.join(repo, "engine", "harness", "opencode", "callyourcode.ts")
  const pluginDst = path.join(configRoot, "plugin", "callyourcode.ts")
  if (dry) {
    console.log(`  would write ${pluginDst}`)
  } else {
    fs.mkdirSync(path.dirname(pluginDst), { recursive: true })
    fs.copyFileSync(pluginSrc, pluginDst)
    console.log(`  ok    installed plugin -> ${pluginDst}`)
  }

  // 3. Skill, only when the claude copy is not already discoverable. First
  const claudeSkill = path.join(home, ".claude", "skills", "callyourcode")
  const skillDst = path.join(configRoot, "skill", "callyourcode")
  if (fs.existsSync(claudeSkill)) {
    console.log(`  skip  skill: opencode discovers ${claudeSkill} on its own`)
    if (!dry) fs.rmSync(skillDst, { recursive: true, force: true })
  } else {
    copyDirFresh(path.join(repo, "engine", "skills", "callyourcode"), skillDst, dry)
    console.log(`  ok    installed skill -> ${skillDst}`)
  }
}

export function installCodex(opts: { home: string; repo: string; dry: boolean }): void {
  const { home, repo, dry } = opts
  const root =
    process.env.CODEX_HOME && !process.env.CYC_HOME
      ? process.env.CODEX_HOME
      : path.join(home, ".codex")
  console.log(`codex -> ${root}`)

  // 1. MCP registration + the session-identity announcer (notify). Both edit
  // config.toml; the notify insert goes first (root key, before any table),
  // the MCP section appends after, one write covers both.
  const tomlFile = path.join(root, "config.toml")
  const tomlText = fs.existsSync(tomlFile) ? fs.readFileSync(tomlFile, "utf-8") : ""
  const notify = mergeCodexNotify(tomlText)
  const toml = mergeCodexToml(notify.text)
  if (notify.changed || toml.changed) {
    writeMerged(tomlFile, toml.text, dry)
  }
  console.log(`  ${notify.changed ? "ok   " : notify.note.startsWith("REFUSED") ? "WARN " : "skip "} config.toml: ${notify.note}`)
  console.log(`  ${toml.changed ? "ok   " : "skip "} config.toml: ${toml.note}`)

  // 2. Hooks: the claude Stop hook verbatim, plus the codex-shaped shell guard.
  const hooksFile = path.join(root, "hooks.json")
  const hooksText = fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile, "utf-8") : ""
  // Path-independent launcher names, resolved to the local engine by cyc.ts.
  const hooks = mergeCodexHooks(hooksText, "enforce-voice-reply", "enforce-shell-async")
  for (const note of hooks.notes) console.log(`  ${note.startsWith("added") ? "ok   " : "skip "} hooks.json: ${note}`)
  if (hooks.changed) writeMerged(hooksFile, hooks.text, dry)

  // 3. Skill.
  const skillDst = path.join(root, "skills", "callyourcode")
  copyDirFresh(path.join(repo, "engine", "skills", "callyourcode"), skillDst, dry)
  console.log(`  ok    installed skill -> ${skillDst}`)

  if (hooks.changed) {
    console.log(
      "  note  codex will ask once, at the next interactive start, to trust the two hooks (startup hooks review)",
    )
  }
}

export function installPi(opts: { home: string; repo: string; dry: boolean }): void {
  const { home, repo, dry } = opts
  const agentDir =
    process.env.PI_CODING_AGENT_DIR && !process.env.CYC_HOME
      ? process.env.PI_CODING_AGENT_DIR
      : path.join(home, ".pi", "agent")
  console.log(`pi -> ${agentDir}`)

  const settingsFile = path.join(agentDir, "settings.json")
  const text = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf-8") : ""
  const merged = mergePiSettings(text, path.join(repo, PI_EXTENSION_SUFFIX)) // invalid JSON crashes loud
  if (merged.changed) {
    writeMerged(settingsFile, merged.text, dry)
    console.log(`  ok    settings.json: ${merged.note}`)
  } else {
    console.log(`  skip  settings.json: ${merged.note}`)
  }

  const bridgeDir = bridgeDirOf(agentDir)
  if (fs.existsSync(path.join(bridgeDir, "src", "models.ts"))) {
    ensureBridgeOneM(bridgeDir, repo, dry)
    const cfgFile = path.join(agentDir, "claude-bridge.json")
    const cfgText = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, "utf-8") : ""
    const cfg = mergeBridgeConfig(cfgText) // invalid JSON crashes loud
    if (cfg.changed) writeMerged(cfgFile, cfg.text, dry)
    console.log(`  ${cfg.changed ? "ok   " : "skip "} claude-bridge.json: ${cfg.note}`)
  }
}

// ---------------------------------------------------------------------------
// Detection + CLI.

export function detectHarnesses(home: string): string[] {
  if (process.env.CYC_FAKE_HARNESSES !== undefined) {
    return process.env.CYC_FAKE_HARNESSES.split(",").filter(Boolean)
  }
  const found: string[] = []
  // command -v misses alias-only installs; the config-root fallback covers them.
  if (Bun.which("claude") || fs.existsSync(path.join(home, ".claude"))) found.push("claude")
  if (Bun.which("opencode") || fs.existsSync(path.join(home, ".config", "opencode"))) found.push("opencode")
  if (Bun.which("codex") || fs.existsSync(path.join(home, ".codex"))) found.push("codex")
  if (Bun.which("pi") || fs.existsSync(path.join(home, ".pi", "agent"))) found.push("pi")
  return found
}

function main(argv: string[]): number {
  const dry = argv.includes("--dry-run")
  const named = argv.filter((a) => !a.startsWith("--"))
  for (const a of named) {
    if (a !== "claude" && a !== "opencode" && a !== "codex" && a !== "pi") {
      console.error(`usage: harness-integration.ts [claude] [opencode] [codex] [pi] [--dry-run]`)
      return 2
    }
  }
  const home = process.env.CYC_HOME || process.env.HOME || ""
  if (!home) {
    console.error("FAILED: no HOME")
    return 1
  }
  const repo = path.resolve(import.meta.dir, "..")
  const targets = named.length ? named : detectHarnesses(home)
  if (targets.length === 0) {
    console.log("harness-integration: no claude, opencode, codex or pi on this machine; nothing to do")
    return 0
  }
  for (const t of targets) {
    if (t === "claude") installClaude({ home, repo, dry })
    if (t === "opencode") installOpencode({ home, repo, dry })
    if (t === "codex") installCodex({ home, repo, dry })
    if (t === "pi") installPi({ home, repo, dry })
  }
  console.log("Done. Restart running claude/opencode/codex/pi sessions to pick up MCP, hooks, skills and the pi extension.")
  return 0
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
