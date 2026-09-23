/* harness-integration tests: the config-file transformations against fixture
 * copies of the REAL formats (engine/harness/fixtures/, captured from isolated
 * `opencode mcp add` / `codex mcp add` / codex hooks/list probe runs), the
 * installer CLI against a scratch home, the opencode plugin's ported hook
 * logic, and the codex hook scripts run as real subprocesses.
 *
 * The machine's live configs are never read or written: every filesystem test
 * runs under a mkdtemp scratch home via CYC_HOME / CYC_STATE_DIR.
 *
 *   bun test scripts/harness-integration.test.ts
 */

import { test, expect, afterEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import {
  mergeOpencodeConfig,
  mergeCodexToml,
  mergeCodexNotify,
  mergeCodexHooks,
  mergeClaudeJson,
  mergeClaudeSettings,
  mergePiSettings,
  mergeBridgeConfig,
  bridgeHasOneM,
  PI_BRIDGE_PATCH,
  MCP_LAUNCHER,
} from "./harness-integration.ts"
import { CallYourCode } from "../engine/harness/opencode/callyourcode.ts"
import { stateFile } from "../engine/agent-engine/src/storage/datadir.ts"

// The plugin exposes its pure logic as a property on its single export;
// extra module exports would be invoked as plugin factories by opencode.
const { bashGuardReason, hasBackgroundAmp, judge, findSession, STATE_FILE } = (
  CallYourCode as any
).testables

const REPO = join(import.meta.dir, "..")
const FIXTURES = join(REPO, "engine", "harness", "fixtures")
const MCP = "/repo/engine/mcp/src/server.ts"

const dirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "harness-parity-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// opencode.json merge

test("opencode: empty config gains schema and mcp.callyourcode on the `cyc mcp` launcher", () => {
  const r = mergeOpencodeConfig("")
  expect(r.changed).toBe(true)
  const data = JSON.parse(r.text)
  expect(data.$schema).toBe("https://opencode.ai/config.json")
  // Path-independent: the launcher, never an absolute engine path.
  expect(data.mcp.callyourcode).toEqual({ type: "local", command: [MCP_LAUNCHER, "mcp"] })
})

test("opencode: fixture config keeps the foreign server byte-for-byte", () => {
  const fixture = readFileSync(join(FIXTURES, "opencode.json"), "utf-8")
  const r = mergeOpencodeConfig(fixture)
  expect(r.changed).toBe(true)
  const data = JSON.parse(r.text)
  expect(data.mcp.otherserver).toEqual(JSON.parse(fixture).mcp.otherserver)
  expect(data.mcp.callyourcode.command).toEqual([MCP_LAUNCHER, "mcp"])
})

test("opencode: merge is idempotent", () => {
  const once = mergeOpencodeConfig(readFileSync(join(FIXTURES, "opencode.json"), "utf-8"))
  const twice = mergeOpencodeConfig(once.text)
  expect(twice.changed).toBe(false)
  expect(twice.text).toBe(once.text)
})

test("opencode: an old installer's absolute `bun .../server.ts` is migrated to `cyc mcp`", () => {
  const legacy = JSON.stringify(
    { mcp: { callyourcode: { type: "local", command: ["bun", MCP] } } }, null, 2) + "\n"
  const r = mergeOpencodeConfig(legacy)
  expect(r.changed).toBe(true)
  expect(r.note).toContain("migrated")
  expect(JSON.parse(r.text).mcp.callyourcode.command).toEqual([MCP_LAUNCHER, "mcp"])
})

test("opencode: invalid JSON crashes loud instead of clobbering", () => {
  expect(() => mergeOpencodeConfig("{not json")).toThrow()
  expect(() => mergeOpencodeConfig("[]")).toThrow()
})

// ---------------------------------------------------------------------------
// codex config.toml merge

test("codex toml: empty file gains the section on the `cyc mcp` launcher", () => {
  const r = mergeCodexToml("")
  expect(r.changed).toBe(true)
  // Path-independent: the launcher, never an absolute engine path.
  expect(r.text).toBe(`[mcp_servers.callyourcode]\ncommand = ${JSON.stringify(MCP_LAUNCHER)}\nargs = ["mcp"]\n`)
})

test("codex toml: fixture is preserved verbatim as a prefix, section appended", () => {
  const fixture = readFileSync(join(FIXTURES, "codex-config.toml"), "utf-8")
  const r = mergeCodexToml(fixture)
  expect(r.changed).toBe(true)
  expect(r.text.startsWith(fixture)).toBe(true)
  expect(r.text).toContain("[mcp_servers.callyourcode]")
})

test("codex toml: merge is idempotent, and a nested sub-table also counts as present", () => {
  const once = mergeCodexToml(readFileSync(join(FIXTURES, "codex-config.toml"), "utf-8"))
  const twice = mergeCodexToml(once.text)
  expect(twice.changed).toBe(false)
  expect(twice.text).toBe(once.text)
  const nested = '[mcp_servers.callyourcode.env]\nFOO = "bar"\n'
  expect(mergeCodexToml(nested).changed).toBe(false)
})

// ---------------------------------------------------------------------------
// codex notify announcer merge (session identity over codex's notify setting)

// The path-independent notify line every fresh/migrated config now carries.
const NOTIFY = `notify = [${JSON.stringify(MCP_LAUNCHER)}, "hook", "announce-session", "--codex-notify"]`

test("codex notify: empty config gains the root-level notify announcer on `cyc hook`", () => {
  const r = mergeCodexNotify("")
  expect(r.changed).toBe(true)
  // Path-independent: the launcher, never an absolute engine path.
  expect(r.text).toBe(`${NOTIFY}\n`)
})

test("codex notify: inserted BEFORE the first table so TOML reads it as a root key", () => {
  /* The fixture opens with [mcp_servers.otherserver]; an appended notify would
   * become that table's key and codex would ignore it. */
  const fixture = readFileSync(join(FIXTURES, "codex-config.toml"), "utf-8")
  const r = mergeCodexNotify(fixture)
  expect(r.changed).toBe(true)
  expect(r.text.startsWith(`${NOTIFY}\n`)).toBe(true)
  expect(r.text.endsWith(fixture)).toBe(true) // every fixture byte survives
})

test("codex notify: idempotent rerun, including after the mcp section appended", () => {
  const fixture = readFileSync(join(FIXTURES, "codex-config.toml"), "utf-8")
  const once = mergeCodexNotify(fixture)
  const withMcp = mergeCodexToml(once.text)
  const twice = mergeCodexNotify(withMcp.text)
  expect(twice.changed).toBe(false)
  expect(twice.text).toBe(withMcp.text)
})

test("codex notify: a legacy absolute-path announcer is migrated in place to `cyc hook`", () => {
  // From ANY machine: a config copied from another box carries that box's abspath.
  const legacy = `notify = ["python3", "/home/olduser/callyourcode/engine/hooks/announce-session.py", "--codex-notify"]\n\n[mcp_servers.otherserver]\ncommand = "bun"\n`
  const r = mergeCodexNotify(legacy)
  expect(r.changed).toBe(true)
  expect(r.note).toContain("migrated")
  expect(r.text.startsWith(`${NOTIFY}\n`)).toBe(true)
  expect(r.text).toContain("[mcp_servers.otherserver]") // every other byte survives
  // and the migrated form is a no-op on a second pass
  expect(mergeCodexNotify(r.text).changed).toBe(false)
})

test("codex notify: an existing foreign notify is refused loudly, never clobbered", () => {
  const cfg = `notify = ["/usr/local/bin/my-notifier"]\n\n[mcp_servers.otherserver]\ncommand = "bun"\n`
  const r = mergeCodexNotify(cfg)
  expect(r.changed).toBe(false)
  expect(r.text).toBe(cfg)
  expect(r.note).toContain("REFUSED")
  expect(r.note).toContain("my-notifier")
})

test("codex notify: a notify key INSIDE a table is not mistaken for the root key", () => {
  const cfg = `[tui]\nnotify = true\n`
  const r = mergeCodexNotify(cfg)
  expect(r.changed).toBe(true)
  expect(r.text.startsWith("notify = [")).toBe(true)
  expect(r.text.endsWith(cfg)).toBe(true)
})

test("codex notify: the announcer script forwards thread-id as the announce sessionId", async () => {
  /* The real script as a real subprocess, invoked exactly the way codex does
   * (the JSON event as the last argv), POSTing to a local stand-in engine. */
  let got: any = null
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      got = await req.json()
      return Response.json({ ok: true, parked: true })
    },
  })
  try {
    const event = {
      "type": "agent-turn-complete",
      "thread-id": "0199a1b2-c3d4-7e5f-8a9b-00000000cafe",
      "turn-id": "t-1",
      "cwd": "/tmp/somewhere",
      "input-messages": ["hi"],
      "last-assistant-message": "done",
    }
    const proc = Bun.spawn(
      ["python3", join(REPO, "engine", "hooks", "announce-session.py"), "--codex-notify", JSON.stringify(event)],
      { env: { ...process.env, AGENT_PORT: String(srv.port) }, stdin: "ignore" },
    )
    expect(await proc.exited).toBe(0)
    expect(got).not.toBeNull()
    expect(got.sessionId).toBe("0199a1b2-c3d4-7e5f-8a9b-00000000cafe")
    expect(got.source).toBe("codex-notify")
    expect(got.event).toBe("agent-turn-complete")
    expect(got.cwd).toBe("/tmp/somewhere")
    expect(got.pid).toBeGreaterThan(1)
    expect(got.ppid).toBeGreaterThan(1)
  } finally {
    srv.stop(true)
  }
})

test("codex notify: a payload with no thread id announces nothing and exits 0", async () => {
  let hits = 0
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() { hits++; return Response.json({ ok: true }) },
  })
  try {
    const proc = Bun.spawn(
      ["python3", join(REPO, "engine", "hooks", "announce-session.py"), "--codex-notify",
        JSON.stringify({ type: "agent-turn-complete" })],
      { env: { ...process.env, AGENT_PORT: String(srv.port) }, stdin: "ignore" },
    )
    expect(await proc.exited).toBe(0)
    expect(hits).toBe(0)
  } finally {
    srv.stop(true)
  }
})

// ---------------------------------------------------------------------------
// codex hooks.json merge

const STOP = "enforce-voice-reply"
const PRE = "enforce-shell-async"

test("codex hooks: empty file gains Stop and PreToolUse on the `cyc hook` launcher", () => {
  const r = mergeCodexHooks("", STOP, PRE)
  expect(r.changed).toBe(true)
  const data = JSON.parse(r.text)
  // Path-independent: the launcher names the hook, never an absolute path.
  expect(data.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: `${MCP_LAUNCHER} hook ${STOP}` })
  expect(data.hooks.PreToolUse[0].hooks[0]).toEqual({ type: "command", command: `${MCP_LAUNCHER} hook ${PRE}` })
  // no matcher on ours: the scripts self-filter on payload shape
  expect("matcher" in data.hooks.PreToolUse[0]).toBe(false)
})

test("codex hooks: fixture's foreign hooks survive untouched, ours appended", () => {
  const fixture = readFileSync(join(FIXTURES, "codex-hooks.json"), "utf-8")
  const r = mergeCodexHooks(fixture, STOP, PRE)
  const data = JSON.parse(r.text)
  const orig = JSON.parse(fixture)
  expect(data.hooks.PreToolUse[0]).toEqual(orig.hooks.PreToolUse[0])
  expect(data.hooks.SessionStart).toEqual(orig.hooks.SessionStart)
  expect(data.hooks.PreToolUse[1].hooks[0].command).toBe(`${MCP_LAUNCHER} hook ${PRE}`)
  expect(data.hooks.Stop[0].hooks[0].command).toBe(`${MCP_LAUNCHER} hook ${STOP}`)
})

test("codex hooks: merge is idempotent by launcher command", () => {
  const once = mergeCodexHooks(readFileSync(join(FIXTURES, "codex-hooks.json"), "utf-8"), STOP, PRE)
  const twice = mergeCodexHooks(once.text, STOP, PRE)
  expect(twice.changed).toBe(false)
  expect(JSON.parse(twice.text)).toEqual(JSON.parse(once.text))
})

test("codex hooks: a legacy absolute-path command is migrated in place, a foreign hook is left", () => {
  // A config copied from another box carries THAT box's abspath in the Stop
  // command; a non-cyc PreToolUse hook must never be touched.
  const seed = JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "python3 /home/olduser/callyourcode/engine/hooks/enforce-voice-reply.py" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo mine" }] }],
    },
  })
  const r = mergeCodexHooks(seed, STOP, PRE)
  expect(r.changed).toBe(true)
  const data = JSON.parse(r.text)
  // Stop migrated to the launcher, no duplicate entry added.
  expect(data.hooks.Stop.length).toBe(1)
  expect(data.hooks.Stop[0].hooks[0].command).toBe(`${MCP_LAUNCHER} hook ${STOP}`)
  // the foreign PreToolUse hook survives, ours appended alongside it.
  expect(data.hooks.PreToolUse[0].hooks[0].command).toBe("echo mine")
  expect(data.hooks.PreToolUse[1].hooks[0].command).toBe(`${MCP_LAUNCHER} hook ${PRE}`)
  // migrated + appended form is a clean no-op on a rerun.
  expect(mergeCodexHooks(r.text, STOP, PRE).changed).toBe(false)
})

// ---------------------------------------------------------------------------
// claude ~/.claude.json merge

const CLAUDE_STOP = "enforce-voice-reply"
const CLAUDE_PRE = "enforce-bash-async"

test("claude json: empty file gains mcpServers.callyourcode on the `cyc mcp` launcher", () => {
  const r = mergeClaudeJson("")
  expect(r.changed).toBe(true)
  const data = JSON.parse(r.text)
  // Path-independent: the launcher, never an absolute engine path.
  expect(data.mcpServers.callyourcode).toEqual({ command: MCP_LAUNCHER, args: ["mcp"] })
})

test("claude json: a foreign server survives, and merge is idempotent", () => {
  const seed = JSON.stringify({ mcpServers: { other: { command: "node", args: ["x.js"] } } })
  const once = mergeClaudeJson(seed)
  expect(once.changed).toBe(true)
  const data = JSON.parse(once.text)
  expect(data.mcpServers.other).toEqual({ command: "node", args: ["x.js"] })
  expect(data.mcpServers.callyourcode.command).toBe(MCP_LAUNCHER)
  const twice = mergeClaudeJson(once.text)
  expect(twice.changed).toBe(false)
  expect(twice.text).toBe(once.text)
})

test("claude json: an old installer's absolute `bun .../server.ts` is migrated to `cyc mcp`", () => {
  const legacy = JSON.stringify({ mcpServers: { callyourcode: { command: "bun", args: [MCP] } } })
  const r = mergeClaudeJson(legacy)
  expect(r.changed).toBe(true)
  expect(r.note).toContain("migrated")
  expect(JSON.parse(r.text).mcpServers.callyourcode).toEqual({ command: MCP_LAUNCHER, args: ["mcp"] })
})

test("claude json: a legacy voice-channel server is dropped, an unrelated voice is kept", () => {
  const stale = JSON.stringify({
    mcpServers: { voice: { command: "bun", args: ["/old/voice-channel/voice-channel.ts"] } },
  })
  const r = mergeClaudeJson(stale)
  expect(r.changed).toBe(true)
  expect(r.note).toContain("removed legacy mcpServers.voice")
  expect(JSON.parse(r.text).mcpServers.voice).toBeUndefined()

  const foreign = JSON.stringify({ mcpServers: { voice: { command: "node", args: ["someone-elses.js"] } } })
  const keep = mergeClaudeJson(foreign)
  expect(JSON.parse(keep.text).mcpServers.voice).toEqual({ command: "node", args: ["someone-elses.js"] })
})

test("claude json: invalid JSON crashes loud instead of clobbering", () => {
  expect(() => mergeClaudeJson("{not json")).toThrow()
  expect(() => mergeClaudeJson("[]")).toThrow()
})

// ---------------------------------------------------------------------------
// claude ~/.claude/settings.json merge

test("claude settings: empty file gains both hooks on `cyc hook`, with claude matchers", () => {
  const r = mergeClaudeSettings("", CLAUDE_STOP, CLAUDE_PRE)
  expect(r.changed).toBe(true)
  const data = JSON.parse(r.text)
  // Path-independent: the launcher, never an absolute path.
  expect(data.hooks.Stop[0]).toEqual({ matcher: "*", hooks: [{ type: "command", command: `${MCP_LAUNCHER} hook ${CLAUDE_STOP}` }] })
  expect(data.hooks.PreToolUse[0]).toEqual({
    matcher: "Bash",
    hooks: [{ type: "command", command: `${MCP_LAUNCHER} hook ${CLAUDE_PRE}` }],
  })
})

test("claude settings: foreign hooks survive, ours appended, idempotent by launcher command", () => {
  const seed = JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] }] },
  })
  const once = mergeClaudeSettings(seed, CLAUDE_STOP, CLAUDE_PRE)
  const data = JSON.parse(once.text)
  expect(data.hooks.PreToolUse[0].hooks[0].command).toBe("echo hi")
  expect(data.hooks.PreToolUse[1].hooks[0].command).toBe(`${MCP_LAUNCHER} hook ${CLAUDE_PRE}`)
  expect(data.hooks.Stop[0].hooks[0].command).toBe(`${MCP_LAUNCHER} hook ${CLAUDE_STOP}`)
  const twice = mergeClaudeSettings(once.text, CLAUDE_STOP, CLAUDE_PRE)
  expect(twice.changed).toBe(false)
  expect(JSON.parse(twice.text)).toEqual(JSON.parse(once.text))
})

test("claude settings: a legacy absolute-path hook command is migrated in place to `cyc hook`", () => {
  // A ~/.claude/settings.json copied from another box carries that box's abspath.
  const seed = JSON.stringify({
    hooks: {
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: "python3 /home/olduser/callyourcode/engine/hooks/enforce-voice-reply.py" }] }],
    },
  })
  const r = mergeClaudeSettings(seed, CLAUDE_STOP, CLAUDE_PRE)
  expect(r.changed).toBe(true)
  const data = JSON.parse(r.text)
  // migrated in place, no duplicate Stop entry, matcher preserved
  expect(data.hooks.Stop.length).toBe(1)
  expect(data.hooks.Stop[0].matcher).toBe("*")
  expect(data.hooks.Stop[0].hooks[0].command).toBe(`${MCP_LAUNCHER} hook ${CLAUDE_STOP}`)
  // PreToolUse had nothing of ours: appended fresh on the launcher
  expect(data.hooks.PreToolUse[0].hooks[0].command).toBe(`${MCP_LAUNCHER} hook ${CLAUDE_PRE}`)
  // clean no-op on rerun
  expect(mergeClaudeSettings(r.text, CLAUDE_STOP, CLAUDE_PRE).changed).toBe(false)
})

test("claude settings: the announce hook lands on SessionStart AND UserPromptSubmit, idempotently", () => {
  /* The session-identity announce (engine bug 19): SessionStart
   * covers startup, --resume/--continue and /clear; UserPromptSubmit is the
   * idempotent belt-and-braces re-announce for an engine that was down when
   * SessionStart fired. Both run the same launcher command. */
  const ANNOUNCE = "announce-session"
  const r = mergeClaudeSettings("", CLAUDE_STOP, CLAUDE_PRE, ANNOUNCE)
  expect(r.changed).toBe(true)
  const data = JSON.parse(r.text)
  expect(data.hooks.SessionStart[0]).toEqual(
    { matcher: "*", hooks: [{ type: "command", command: `${MCP_LAUNCHER} hook ${ANNOUNCE}` }] })
  expect(data.hooks.UserPromptSubmit[0]).toEqual(
    { matcher: "*", hooks: [{ type: "command", command: `${MCP_LAUNCHER} hook ${ANNOUNCE}` }] })
  const twice = mergeClaudeSettings(r.text, CLAUDE_STOP, CLAUDE_PRE, ANNOUNCE)
  expect(twice.changed).toBe(false)
  expect(JSON.parse(twice.text)).toEqual(JSON.parse(r.text))
  // and a merge WITHOUT the announce hook (older callers, fixtures) still
  // leaves an existing announce entry untouched
  const kept = mergeClaudeSettings(r.text, CLAUDE_STOP, CLAUDE_PRE)
  expect(kept.changed).toBe(false)
})

// ---------------------------------------------------------------------------
// state-path parity: the opencode plugin, the engine, and the claude/codex
// hook MUST resolve reply-state.json to the SAME file in production. When they
// disagreed, the plugin read <repo>/.run (nobody's writer) and its nudge never
// fired. Sources of truth: agent-engine/src/chat/reply-trace.ts:96 (engine write) and
// hooks/enforce-voice-reply.py:70 (claude/codex hook). Both are
// <CYC_DATA_DIR || ~/.callyourcode>/state/reply-state.json.

test("state parity: plugin, engine, and hook all resolve the same default path", () => {
  const oldData = process.env.CYC_DATA_DIR
  const oldState = process.env.CYC_STATE_DIR
  delete process.env.CYC_DATA_DIR
  delete process.env.CYC_STATE_DIR
  try {
    // Production default (no env overrides). The claude/codex hook's path is the
    // literal from enforce-voice-reply.py:70; the engine's is stateFile(), the
    // real writer (reply-trace.ts:96 -> datadir.ts). The plugin's is its own
    // runtime resolver. Before the fix the plugin read <repo>/.run instead, so
    // its nudge never fired. All three must be the SAME file:
    const hookDefault = join(homedir(), ".callyourcode", "state", "reply-state.json")
    expect(stateFile("reply-state.json")).toBe(hookDefault) // engine == hook
    expect(STATE_FILE()).toBe(hookDefault) // plugin == both

    // CYC_DATA_DIR (shared with the engine) shifts all three together.
    process.env.CYC_DATA_DIR = "/tmp/cyc-data-parity"
    const shifted = join("/tmp/cyc-data-parity", "state", "reply-state.json")
    expect(stateFile("reply-state.json")).toBe(shifted)
    expect(STATE_FILE()).toBe(shifted)
  } finally {
    if (oldData === undefined) delete process.env.CYC_DATA_DIR
    else process.env.CYC_DATA_DIR = oldData
    if (oldState === undefined) delete process.env.CYC_STATE_DIR
    else process.env.CYC_STATE_DIR = oldState
  }
})

// ---------------------------------------------------------------------------
// installer CLI against a scratch home

const homeCyc = (home: string) => join(home, ".bun", "bin", "cyc")

async function runInstaller(home: string, args: string[] = [], fake = "opencode,codex") {
  const proc = Bun.spawn(["bun", join(REPO, "scripts", "harness-integration.ts"), ...args], {
    cwd: REPO,
    env: { ...process.env, CYC_HOME: home, CYC_FAKE_HARNESSES: fake },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  return { out, err, code }
}

test("cli: --dry-run names the targets and touches nothing", async () => {
  const home = scratch()
  const { out, code } = await runInstaller(home, ["--dry-run"])
  expect(code).toBe(0)
  expect(out).toContain("opencode.json")
  expect(out).toContain("config.toml")
  expect(existsSync(join(home, ".config"))).toBe(false)
  expect(existsSync(join(home, ".codex"))).toBe(false)
})

test("cli: fresh install writes every piece for both harnesses, then re-runs clean", async () => {
  const home = scratch()
  const first = await runInstaller(home)
  expect(first.code).toBe(0)

  const oc = join(home, ".config", "opencode")
  const ocCfg = JSON.parse(readFileSync(join(oc, "opencode.json"), "utf-8"))
  // Path-independent: the launcher, identical on every box.
  expect(ocCfg.mcp.callyourcode.command).toEqual([homeCyc(home), "mcp"])
  // The plugin is installed verbatim: it resolves the engine's data dir from
  // env at runtime, so nothing is stamped into it.
  const plugin = readFileSync(join(oc, "plugin", "callyourcode.ts"), "utf-8")
  expect(plugin).not.toContain("__CYC_RUN_DIR__")
  expect(plugin).toBe(readFileSync(join(REPO, "engine", "harness", "opencode", "callyourcode.ts"), "utf-8"))
  expect(existsSync(join(oc, "skill", "callyourcode", "SKILL.md"))).toBe(true)

  const cx = join(home, ".codex")
  const toml1 = readFileSync(join(cx, "config.toml"), "utf-8")
  expect(toml1).toContain("[mcp_servers.callyourcode]")
  expect(toml1).toContain(`command = ${JSON.stringify(homeCyc(home))}`) // the absolute shim, PATH-proof
  // the notify announcer is a ROOT key: first line, before any table, on the launcher
  expect(toml1.startsWith(`notify = [${JSON.stringify(homeCyc(home))}, "hook", "announce-session"`)).toBe(true)
  expect(toml1).toContain("--codex-notify")
  const hooks = JSON.parse(readFileSync(join(cx, "hooks.json"), "utf-8"))
  expect(hooks.hooks.Stop[0].hooks[0].command).toBe(`${homeCyc(home)} hook enforce-voice-reply`)
  expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe(`${homeCyc(home)} hook enforce-shell-async`)
  expect(existsSync(join(cx, "skills", "callyourcode", "SKILL.md"))).toBe(true)

  const second = await runInstaller(home)
  expect(second.code).toBe(0)
  const cfg2 = JSON.parse(readFileSync(join(oc, "opencode.json"), "utf-8"))
  expect(Object.keys(cfg2.mcp)).toEqual(["callyourcode"])
  const toml2 = readFileSync(join(cx, "config.toml"), "utf-8")
  expect(toml2.split("[mcp_servers.callyourcode]").length).toBe(2)
  expect(toml2.split("--codex-notify").length).toBe(2)
  const hooks2 = JSON.parse(readFileSync(join(cx, "hooks.json"), "utf-8"))
  expect(hooks2.hooks.Stop.length).toBe(1)
  expect(hooks2.hooks.PreToolUse.length).toBe(1)
})

test("cli: a codex config with legacy absolute hook + notify paths is migrated to `cyc hook` on install", async () => {
  // The exact config-portable footgun: a config copied from another box carries
  // that box's dead absolute paths. Installing must migrate them in place to the
  // path-independent launcher (not append a duplicate), so the Stop hook and the
  // notify announcer resolve to the LOCAL engine again.
  const home = scratch()
  mkdirSync(join(home, ".codex"), { recursive: true })
  writeFileSync(
    join(home, ".codex", "config.toml"),
    `notify = ["python3", "/home/olduser/callyourcode/engine/hooks/announce-session.py", "--codex-notify"]\n`,
  )
  writeFileSync(
    join(home, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "python3 /home/olduser/callyourcode/engine/hooks/enforce-voice-reply.py" }] }],
      },
    }),
  )
  const { code } = await runInstaller(home, ["codex"])
  expect(code).toBe(0)

  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8")
  expect(toml.startsWith(`notify = [${JSON.stringify(homeCyc(home))}, "hook", "announce-session", "--codex-notify"]`)).toBe(true)
  expect(toml).not.toContain("announce-session.py") // the dead abspath is gone

  const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf-8"))
  expect(hooks.hooks.Stop.length).toBe(1) // migrated in place, not duplicated
  expect(hooks.hooks.Stop[0].hooks[0].command).toBe(`${homeCyc(home)} hook enforce-voice-reply`)
  expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe(`${homeCyc(home)} hook enforce-shell-async`)
  expect(JSON.stringify(hooks)).not.toContain("enforce-voice-reply.py") // no dead abspath left

  // re-running is a clean no-op on the migrated config
  const second = await runInstaller(home, ["codex"])
  expect(second.code).toBe(0)
  const hooks2 = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf-8"))
  expect(hooks2.hooks.Stop.length).toBe(1)
  expect(hooks2.hooks.PreToolUse.length).toBe(1)
})

test("cli: claude gets .claude.json, both hooks, the skill; re-run clean", async () => {
  const home = scratch()

  const first = await runInstaller(home, [], "claude")
  expect(first.code).toBe(0)

  const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"))
  // Path-independent: the launcher, identical on every box.
  expect(cj.mcpServers.callyourcode).toEqual({ command: homeCyc(home), args: ["mcp"] })
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"))
  expect(settings.hooks.Stop[0].matcher).toBe("*")
  expect(settings.hooks.Stop[0].hooks[0].command).toBe(`${homeCyc(home)} hook enforce-voice-reply`)
  expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash")
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(`${homeCyc(home)} hook enforce-bash-async`)
  expect(existsSync(join(home, ".claude", "skills", "callyourcode", "SKILL.md"))).toBe(true)

  // second run: every merge is a skip, one hook each, no duplicates
  const second = await runInstaller(home, [], "claude")
  expect(second.code).toBe(0)
  expect(second.out).toContain("already present")
  const settings2 = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"))
  expect(settings2.hooks.Stop.length).toBe(1)
  expect(settings2.hooks.PreToolUse.length).toBe(1)
})

test("cli: existing .claude.json foreign server is merged with a backup, not clobbered", async () => {
  const home = scratch()
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { other: { command: "node", args: ["x.js"] } } }),
  )
  const { code } = await runInstaller(home, [], "claude")
  expect(code).toBe(0)
  const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"))
  expect(cj.mcpServers.other).toEqual({ command: "node", args: ["x.js"] })
  expect(cj.mcpServers.callyourcode).toBeDefined()
  const backups = readdirSync(home).filter((f) => f.startsWith(".claude.json.bak-"))
  expect(backups.length).toBe(1)
})

test("cli: all three faked writes every harness's pieces", async () => {
  const home = scratch()
  const { code } = await runInstaller(home, [], "claude,opencode,codex")
  expect(code).toBe(0)
  expect(existsSync(join(home, ".claude.json"))).toBe(true)
  expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true)
  expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(true)
  expect(existsSync(join(home, ".codex", "config.toml"))).toBe(true)
  // opencode dedupes its skill against the claude copy this same run installed
  expect(existsSync(join(home, ".claude", "skills", "callyourcode", "SKILL.md"))).toBe(true)
  expect(existsSync(join(home, ".config", "opencode", "skill", "callyourcode"))).toBe(false)
})

test("cli: existing configs are merged with a backup, not clobbered", async () => {
  const home = scratch()
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(
    join(home, ".config", "opencode", "opencode.json"),
    readFileSync(join(FIXTURES, "opencode.json")),
  )
  mkdirSync(join(home, ".codex"), { recursive: true })
  writeFileSync(join(home, ".codex", "config.toml"), readFileSync(join(FIXTURES, "codex-config.toml")))

  const { code } = await runInstaller(home)
  expect(code).toBe(0)
  const cfg = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf-8"))
  expect(cfg.mcp.otherserver.environment).toEqual({ FOO: "bar" })
  expect(cfg.mcp.callyourcode).toBeDefined()
  const backups = readdirSync(join(home, ".config", "opencode")).filter((f) => f.includes(".bak-"))
  expect(backups.length).toBe(1)
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8")
  expect(toml).toContain("[mcp_servers.otherserver]")
  expect(toml).toContain("[mcp_servers.callyourcode]")
})

test("cli: opencode skill is skipped when the claude copy already exists", async () => {
  const home = scratch()
  mkdirSync(join(home, ".claude", "skills", "callyourcode"), { recursive: true })
  writeFileSync(join(home, ".claude", "skills", "callyourcode", "SKILL.md"), "claude copy")
  const { out, code } = await runInstaller(home, ["opencode"])
  expect(code).toBe(0)
  expect(out).toContain("opencode discovers")
  expect(existsSync(join(home, ".config", "opencode", "skill", "callyourcode"))).toBe(false)
})

// ---------------------------------------------------------------------------
// opencode plugin: bash guard (port of enforce-bash-async.py)

test("guard: capped timeout allows, missing or oversized blocks", () => {
  expect(bashGuardReason({ command: "ls", timeout: 5000 })).toBeNull()
  expect(bashGuardReason({ command: "ls", timeout: 60000 })).toBeNull()
  expect(bashGuardReason({ command: "sleep 999" })).toContain("no timeout")
  expect(bashGuardReason({ command: "sleep 999", timeout: 600000 })).toContain("longer than 60000ms")
})

test("guard: detaching is blocked whatever the timeout", () => {
  expect(bashGuardReason({ command: "nohup make -j", timeout: 1000 })).toContain("nohup")
  expect(bashGuardReason({ command: "setsid server", timeout: 1000 })).toContain("setsid")
  expect(bashGuardReason({ command: "make & echo hi", timeout: 1000 })).toContain("`&`")
})

test("guard: quoting, &&, and redirects are not backgrounding", () => {
  expect(hasBackgroundAmp("a && b")).toBe(false)
  expect(hasBackgroundAmp("cmd 2>&1")).toBe(false)
  expect(hasBackgroundAmp("cmd &> log")).toBe(false)
  expect(hasBackgroundAmp("curl 'a?x=1&y=2'")).toBe(false)
  expect(hasBackgroundAmp('echo "&"')).toBe(false)
  expect(hasBackgroundAmp("cmd &")).toBe(true)
  expect(hasBackgroundAmp("a & b")).toBe(true)
})

test("guard: shapes that are not a bash call fail open", () => {
  expect(bashGuardReason(null)).toBeNull()
  expect(bashGuardReason({})).toBeNull()
  expect(bashGuardReason({ command: 42 })).toBeNull()
  expect(bashGuardReason({ command: "   " })).toBeNull()
})

// ---------------------------------------------------------------------------
// opencode plugin: reply judgment (port of enforce-voice-reply.py)

const NOW = 1_000_000_000_000

function entryWith(deliveries: any[], replies: any[] = []) {
  return { deliveries, replies }
}

test("judge: an unanswered delivery this turn nudges, whatever it was", () => {
  const v = judge(entryWith([{ ts: NOW - 1000 }]), 0, NOW)
  expect(v).not.toBeNull()
  expect(v!.nudge).toContain("MISSED REPLY")
  expect(v!.nudge).toContain("Anything that reaches them counts")
  expect(v!.ackThrough).toBe(NOW - 1000)
})

test("judge: a reply after the delivery satisfies it, whatever the channel", () => {
  const spoke = entryWith([{ ts: NOW - 1000 }], [{ ts: NOW - 500, channel: "speak" }])
  expect(judge(spoke, 0, NOW)!.nudge).toBeNull()
  const showed = entryWith([{ ts: NOW - 1000 }], [{ ts: NOW - 500, channel: "show" }])
  expect(judge(showed, 0, NOW)!.nudge).toBeNull()
})

test("judge: any channel, chat included, satisfies (the guard does not read the channel)", () => {
  const v = judge(
    entryWith([{ ts: NOW - 1000 }], [{ ts: NOW - 500, channel: "chat" }]),
    0,
    NOW,
  )
  expect(v!.nudge).toBeNull()
})

test("judge: several pending deliveries, one generic nudge; a reply after the earliest clears them", () => {
  const deliveries = [
    { ts: NOW - 2000 },
    { ts: NOW - 1000 },
  ]
  const unanswered = judge(entryWith(deliveries), 0, NOW)
  expect(unanswered!.nudge).toContain("Anything that reaches them counts")
  expect(unanswered!.ackThrough).toBe(NOW - 1000)
  const answered = judge(entryWith(deliveries, [{ ts: NOW - 500, channel: "chat" }]), 0, NOW)
  expect(answered!.nudge).toBeNull()
})

test("judge: every recorded unanswered delivery counts (there is no ask-for-nothing case)", () => {
  // The engine records a delivery for any message it sends to the pane; nothing
  // records a no-reply-expected informational delivery, so an unanswered one nudges.
  const v = judge(entryWith([{ ts: NOW - 1000 }]), 0, NOW)
  expect(v!.nudge).toContain("MISSED REPLY")
  expect(v!.ackThrough).toBe(NOW - 1000)
})

test("judge: acked and stale deliveries are not this turn's business", () => {
  expect(judge(entryWith([{ ts: NOW - 1000 }]), NOW - 1000, NOW)).toBeNull()
  expect(judge(entryWith([{ ts: NOW - 2 * 60 * 60 * 1000 }]), 0, NOW)).toBeNull()
})

test("judge: a reply sent before the delivery answered something else", () => {
  const v = judge(
    entryWith([{ ts: NOW - 1000 }], [{ ts: NOW - 5000, channel: "speak" }]),
    0,
    NOW,
  )
  expect(v!.nudge).toContain("MISSED REPLY")
})

test("findSession: pane id wins, unique cwd is the fallback, ambiguity is nothing", () => {
  const state = {
    sessions: {
      p1: { cwd: "/a" },
      p2: { cwd: "/b" },
      p3: { cwd: "/b" },
    },
  }
  expect(findSession(state, "p1", null)![0]).toBe("p1")
  expect(findSession(state, null, "/a")![0]).toBe("p1")
  expect(findSession(state, null, "/b")).toBeNull()
  expect(findSession({}, "p1", "/a")).toBeNull()
  expect(findSession(null, "p1", "/a")).toBeNull()
})

// ---------------------------------------------------------------------------
// codex PreToolUse guard: the real script, as codex would run it

async function runCodexGuard(payload: unknown) {
  const proc = Bun.spawn(["python3", join(REPO, "engine", "harness", "codex", "enforce-shell-async.py")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(typeof payload === "string" ? payload : JSON.stringify(payload))
  proc.stdin.end()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  return { code, err }
}

test("codex guard: a field-less shell call is ALLOWED (codex streams + yields)", async () => {
  // codex makes timeout_ms/yield_time_ms optional and the model omits it on
  // ordinary commands; codex's exec streams output and hands control back, so a
  // field-less call is not the dark unbounded hang the claude Bash hook guards.
  // Blocking it here bricked codex (even pwd). The two dark cases -- detach and
  // an explicit over-long timeout -- are still blocked (see below).
  const argv = await runCodexGuard({
    hook_event_name: "PreToolUse",
    tool_name: "shell",
    tool_input: { command: ["bash", "-lc", "sleep 999"] },
  })
  expect(argv.code).toBe(0)
  // the real codex shape on this box: tool_name "Bash", a STRING command, no timing field.
  const real = await runCodexGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  })
  expect(real.code).toBe(0)
})

test("codex guard: capped timeout_ms allows, oversized blocks", async () => {
  const ok = await runCodexGuard({
    tool_name: "shell",
    tool_input: { command: ["bash", "-lc", "ls"], timeout_ms: 30000 },
  })
  expect(ok.code).toBe(0)
  const big = await runCodexGuard({
    tool_name: "shell",
    tool_input: { command: ["bash", "-lc", "make"], timeout_ms: 300000 },
  })
  expect(big.code).toBe(2)
  expect(big.err).toContain("longer than 60000ms")
})

test("codex guard: detaching is blocked in both command shapes", async () => {
  const argv = await runCodexGuard({
    tool_name: "shell",
    tool_input: { command: ["bash", "-lc", "nohup server"], timeout_ms: 1000 },
  })
  expect(argv.code).toBe(2)
  expect(argv.err).toContain("nohup")
  const str = await runCodexGuard({
    tool_name: "local_shell",
    tool_input: { command: "make & echo hi", timeout_ms: 1000 },
  })
  expect(str.code).toBe(2)
  expect(str.err).toContain("`&`")
})

test("codex guard: an interpreter argv is not misread, quoted & is fine", async () => {
  const r = await runCodexGuard({
    tool_name: "shell",
    tool_input: { command: ["bash", "-lc", "curl 'a?x=1&y=2'"], timeout_ms: 5000 },
  })
  expect(r.code).toBe(0)
})

test("codex guard: a renamed shell tool is still judged by its command field", async () => {
  // A renamed-but-command-carrying shell tool must not escape enforcement: a
  // detaching command through it is still blocked (field-less alone allows).
  const blocked = await runCodexGuard({
    tool_name: "shell_v9_renamed",
    tool_input: { command: ["bash", "-lc", "nohup sleep 999"] },
  })
  expect(blocked.code).toBe(2)
  expect(blocked.err).toContain("nohup")
  const allowed = await runCodexGuard({
    tool_name: "shell_v9_renamed",
    tool_input: { command: "ls", timeout_ms: 5000 },
  })
  expect(allowed.code).toBe(0)
})

test("codex guard: non-shell tools and garbage fail open", async () => {
  expect((await runCodexGuard({ tool_name: "apply_patch", tool_input: { input: "patch" } })).code).toBe(0)
  expect((await runCodexGuard({ tool_name: "view_image", tool_input: { path: "/x.png" } })).code).toBe(0)
  expect((await runCodexGuard("{not json")).code).toBe(0)
  expect((await runCodexGuard("")).code).toBe(0)
})

test("codex guard: apply_patch carries patch text in `command`, never judged as shell", async () => {
  // THE REPRODUCED OVER-BLOCK. codex 0.148's apply_patch puts the PATCH TEXT in
  // tool_input.command (a `*** Begin Patch` envelope), not a shell line. The
  // command-shaped fallback used to scan that body and block any edit whose
  // CONTENT mentioned nohup/setsid or a `&` -- codex reported it as "the patch
  // safety hook blocks any patch containing `nohup ... &`". These payloads are
  // captured verbatim from codex exec on this box; each must ALLOW.
  const nohupPatch = await runCodexGuard({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Add File: start.sh\n+#!/usr/bin/env bash\n+nohup ./server > out.log 2>&1 &\n*** End Patch" },
  })
  expect(nohupPatch.code).toBe(0)
  const ampDocPatch = await runCodexGuard({
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Add File: README.md\n+Run make serve & then open the app.\n*** End Patch" },
  })
  expect(ampDocPatch.code).toBe(0)
  // recognised by the patch envelope too, so a renamed apply_patch is still excused.
  const renamed = await runCodexGuard({
    tool_name: "functions.custom_patch",
    tool_input: { command: "*** Begin Patch\n*** Add File: x\n+setsid daemon\n*** End Patch" },
  })
  expect(renamed.code).toBe(0)
  // a GENUINE shell detach is still blocked -- the fix is scoped to patches.
  const realDetach = await runCodexGuard({
    tool_name: "Bash",
    tool_input: { command: "nohup ./server &" },
  })
  expect(realDetach.code).toBe(2)
  expect(realDetach.err).toContain("nohup")
  // HARDENING (verifier finding A): the envelope excuse is scoped to non-shell
  // tools. A Bash/shell call whose command merely STARTS with the patch
  // envelope must NOT skip the detach scan -- its later lines still detach.
  const envelopeBash = await runCodexGuard({
    tool_name: "Bash",
    tool_input: { command: "*** Begin Patch\nnohup ./evil &" },
  })
  expect(envelopeBash.code).toBe(2)
  expect(envelopeBash.err).toContain("nohup")
  const envelopeShell = await runCodexGuard({
    tool_name: "shell",
    tool_input: { command: "*** Begin Patch ; setsid ./evil" },
  })
  expect(envelopeShell.code).toBe(2)
  expect(envelopeShell.err).toContain("setsid")
})

// ---------------------------------------------------------------------------
// codex Stop hook parity: the CLAUDE hook, verbatim, driven with a
// codex-shaped payload. Proves the reply-goes-to-MCP contract holds without
// modification: codex's session_id never matches a claudeSessionId, so the
// lookup falls through to HERDR_PANE_ID exactly as designed.

function codexStopEnv(runDir: string, pane: string) {
  // The hook reads the engine's state dir (CYC_STATE_DIR pins it for tests);
  // seedState writes reply-state.json straight into runDir, so that IS the state dir.
  return { ...process.env, CYC_STATE_DIR: runDir, HERDR_PANE_ID: pane }
}

async function runStopHook(payload: unknown, env: Record<string, string | undefined>) {
  const proc = Bun.spawn(["python3", join(REPO, "engine", "hooks", "enforce-voice-reply.py")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  proc.stdin.write(JSON.stringify(payload))
  proc.stdin.end()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  return { code, err }
}

function seedState(runDir: string, entry: unknown, pane = "codexpane") {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, "reply-state.json"), JSON.stringify({ sessions: { [pane]: entry } }))
}

const codexPayload = {
  hook_event_name: "Stop",
  session_id: "0f2c1a34-0000-4000-8000-cafecafecafe", // a codex thread id, unknown to the engine
  transcript_path: "/nonexistent/rollout.jsonl",
  cwd: "/some/project",
  stop_hook_active: false,
}

test("codex stop parity: an unanswered delivery blocks with the generic nudge", async () => {
  const runDir = join(scratch(), ".run")
  seedState(runDir, {
    cwd: "/some/project",
    deliveries: [{ ts: Date.now() - 5000 }],
    replies: [],
  })
  const r = await runStopHook(codexPayload, codexStopEnv(runDir, "codexpane"))
  expect(r.code).toBe(2)
  expect(r.err).toContain("[enforce-voice-reply]")
  expect(r.err).toContain("Anything that reaches them counts")
})

test("codex stop parity: a speak reply allows the stop", async () => {
  const runDir = join(scratch(), ".run")
  const now = Date.now()
  seedState(runDir, {
    cwd: "/some/project",
    deliveries: [{ ts: now - 5000, level: 5, needs: ["speech"] }],
    replies: [{ ts: now - 1000, channel: "speak" }],
  })
  const r = await runStopHook(codexPayload, codexStopEnv(runDir, "codexpane"))
  expect(r.code).toBe(0)
})

test("codex stop parity: one nudge per message, never a loop", async () => {
  const runDir = join(scratch(), ".run")
  seedState(runDir, {
    cwd: "/some/project",
    deliveries: [{ ts: Date.now() - 5000, level: 5, needs: ["speech"] }],
    replies: [],
  })
  const env = codexStopEnv(runDir, "codexpane")
  expect((await runStopHook(codexPayload, env)).code).toBe(2)
  // the ack was written: the same unanswered delivery cannot nag again
  expect((await runStopHook(codexPayload, env)).code).toBe(0)
  // and stop_hook_active alone allows, belt and braces
  expect((await runStopHook({ ...codexPayload, stop_hook_active: true }, env)).code).toBe(0)
})

test("codex stop parity: a session the engine does not know is left alone", async () => {
  const runDir = join(scratch(), ".run")
  seedState(runDir, {
    cwd: "/other/project",
    deliveries: [{ ts: Date.now() - 5000, level: 5, needs: ["speech"] }],
    replies: [],
  })
  const r = await runStopHook(codexPayload, codexStopEnv(runDir, "unknown-pane"))
  expect(r.code).toBe(0)
})

// ---------------------------------------------------------------------------
// opencode plugin, end to end in-process: the factory returns the two hooks,
// the guard throws into the model, and the idle path nudges exactly once.

test("plugin factory: guard hook throws on a bad bash call, ignores other tools", async () => {
  const hooks = await CallYourCode({ client: {}, directory: "/nowhere" })
  expect(Object.keys(hooks).sort()).toEqual(["event", "tool.execute.before"])
  await expect(
    hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "sleep 999" } }),
  ).rejects.toThrow("no timeout")
  await hooks["tool.execute.before"]({ tool: "read" }, { args: { command: "sleep 999" } })
  await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "ls", timeout: 5000 } })
})

test("plugin factory: session.idle nudges the session once, then never again", async () => {
  const runDir = join(scratch(), ".run")
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, "reply-state.json"),
    JSON.stringify({
      sessions: {
        ocpane: {
          cwd: "/oc/project",
          deliveries: [{ ts: Date.now() - 5000, level: 5, needs: ["speech"] }],
          replies: [],
        },
      },
    }),
  )
  const prompts: any[] = []
  const client = {
    session: {
      get: async () => ({ data: {} }), // top-level session, no parentID
      prompt: async (req: any) => void prompts.push(req),
    },
  }
  // CYC_STATE_DIR pins the state dir straight at runDir (which IS where the
  // reply-state.json above was seeded), mirroring codexStopEnv for the hook.
  const oldState = process.env.CYC_STATE_DIR
  const oldPane = process.env.HERDR_PANE_ID
  process.env.CYC_STATE_DIR = runDir
  process.env.HERDR_PANE_ID = "ocpane"
  try {
    const hooks = await CallYourCode({ client, directory: "/oc/project" })
    const idle = { event: { type: "session.idle", properties: { sessionID: "s1" } } }
    await hooks.event(idle)
    expect(prompts.length).toBe(1)
    expect(prompts[0].sessionID).toBe("s1")
    expect(prompts[0].parts[0].text).toContain("MISSED REPLY")
    expect(existsSync(join(runDir, "reply-acks", "ocpane.json"))).toBe(true)
    // the delivery was judged once; the same idle never nags again
    await hooks.event(idle)
    expect(prompts.length).toBe(1)
    // and a subagent's idle is not the conversation
    ;(client.session as any).get = async () => ({ data: { parentID: "root" } })
    await hooks.event(idle)
    expect(prompts.length).toBe(1)
  } finally {
    if (oldState === undefined) delete process.env.CYC_STATE_DIR
    else process.env.CYC_STATE_DIR = oldState
    if (oldPane === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = oldPane
  }
})

// ---------------------------------------------------------------------------
// pi: the cyc extension in ~/.pi/agent/settings.json `extensions`

const PI_EXT = "/home/u/callyourcode/engine/harness/pi/cyc-output.js"

test("pi: an empty settings file gets the extension", () => {
  const r = mergePiSettings("", PI_EXT)
  expect(r.changed).toBe(true)
  expect(JSON.parse(r.text)).toEqual({ extensions: [PI_EXT] })
})

test("pi: every other key and extension is kept; re-running is a no-op", () => {
  const before = JSON.stringify({
    packages: ["npm:pi-claude-bridge"], defaultModel: "gpt-5.6-terra", extensions: ["/x/other.ts"],
  })
  const once = mergePiSettings(before, PI_EXT)
  expect(once.changed).toBe(true)
  const data = JSON.parse(once.text)
  expect(data.packages).toEqual(["npm:pi-claude-bridge"])
  expect(data.defaultModel).toBe("gpt-5.6-terra")
  expect(data.extensions).toEqual(["/x/other.ts", PI_EXT])
  const twice = mergePiSettings(once.text, PI_EXT)
  expect(twice.changed).toBe(false)
  expect(twice.text).toBe(once.text)
})

test("pi: an entry for a moved checkout is replaced in place, not duplicated", () => {
  const old = JSON.stringify({ extensions: ["/a.ts", "/old/place/engine/harness/pi/cyc-output.js", "/b.ts"] })
  const r = mergePiSettings(old, PI_EXT)
  expect(JSON.parse(r.text).extensions).toEqual(["/a.ts", PI_EXT, "/b.ts"])
})

test("pi: a malformed file is refused loudly, never rewritten", () => {
  expect(() => mergePiSettings("{not json", PI_EXT)).toThrow()
  expect(() => mergePiSettings("[]", PI_EXT)).toThrow()
  expect(() => mergePiSettings(JSON.stringify({ extensions: "x" }), PI_EXT)).toThrow()
})

test("cli: pi install writes the repo's extension path into pi settings, then re-runs clean", async () => {
  const home = scratch()
  const first = await runInstaller(home, [], "pi")
  expect(first.code).toBe(0)
  const file = join(home, ".pi", "agent", "settings.json")
  const cfg = JSON.parse(readFileSync(file, "utf-8"))
  const ext = join(REPO, "engine", "harness", "pi", "cyc-output.js")
  expect(cfg.extensions).toEqual([ext])
  expect(existsSync(ext)).toBe(true)
  const second = await runInstaller(home, [], "pi")
  expect(second.code).toBe(0)
  expect(second.out).toContain("skip  settings.json")
  expect(JSON.parse(readFileSync(file, "utf-8")).extensions).toEqual([ext])
})

// ---------------------------------------------------------------------------
// pi-claude-bridge oneMByDefault

test("bridge config: Max plan gets oneMByDefault; others and explicit values are left alone", () => {
  const max = mergeBridgeConfig(JSON.stringify({ provider: { plan: "max", plan2: 1 }, startupNoticeShown: "x" }))
  expect(max.changed).toBe(true)
  expect(JSON.parse(max.text)).toEqual({ provider: { plan: "max", plan2: 1, oneMByDefault: true }, startupNoticeShown: "x" })
  expect(mergeBridgeConfig(max.text).changed).toBe(false)
  expect(mergeBridgeConfig(JSON.stringify({ provider: { plan: "pro" } })).changed).toBe(false)
  expect(mergeBridgeConfig("").changed).toBe(false)
  const off = JSON.stringify({ provider: { plan: "max", oneMByDefault: false } })
  expect(mergeBridgeConfig(off).changed).toBe(false)
  expect(() => mergeBridgeConfig("{nope")).toThrow()
  expect(() => mergeBridgeConfig(JSON.stringify({ provider: [] }))).toThrow()
})

/* A bridge the patch applies to: each file is the pre-image of its hunks,
 * which is all `patch` matches against. */
function seedBridge(agentDir: string): string {
  const dir = join(agentDir, "npm", "node_modules", "pi-claude-bridge")
  const patch = readFileSync(join(REPO, PI_BRIDGE_PATCH), "utf-8")
  for (const part of patch.split(/^diff --git /m).slice(1)) {
    const file = part.match(/^\+\+\+ b\/(\S+)/m)![1]
    const pre = part.split("\n").filter((l) => /^[ -]/.test(l) && !l.startsWith("---")).map((l) => l.slice(1))
    mkdirSync(join(dir, file, ".."), { recursive: true })
    writeFileSync(join(dir, file), pre.join("\n") + "\n")
  }
  return dir
}

test("cli pi: patches an unpatched bridge once, sets oneMByDefault for Max, then no-ops", async () => {
  const home = scratch()
  const agentDir = join(home, ".pi", "agent")
  const bridge = seedBridge(agentDir)
  writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider: { plan: "max" } }))
  expect(bridgeHasOneM(readFileSync(join(bridge, "src", "models.ts"), "utf-8"))).toBe(false)
  const first = await runInstaller(home, [], "pi")
  expect(first.code).toBe(0)
  expect(first.out).toContain("applied the oneMByDefault patch")
  expect(bridgeHasOneM(readFileSync(join(bridge, "src", "models.ts"), "utf-8"))).toBe(true)
  expect(JSON.parse(readFileSync(join(agentDir, "claude-bridge.json"), "utf-8")).provider.oneMByDefault).toBe(true)
  const second = await runInstaller(home, [], "pi")
  expect(second.out).toContain("already supports oneMByDefault")
  expect(second.out).toContain("provider.oneMByDefault already true")
})

test("cli pi: a bridge the patch does not fit is reported and left untouched", async () => {
  const home = scratch()
  const bridge = join(home, ".pi", "agent", "npm", "node_modules", "pi-claude-bridge")
  mkdirSync(join(bridge, "src"), { recursive: true })
  writeFileSync(join(bridge, "src", "models.ts"), "export const other = 1\n")
  const r = await runInstaller(home, [], "pi")
  expect(r.code).toBe(0)
  expect(r.out).toContain("does not apply to this version")
  expect(readFileSync(join(bridge, "src", "models.ts"), "utf-8")).toBe("export const other = 1\n")
})
