#!/usr/bin/env bun
/* THE `cyc` CLI: an agent's control surface for the CallYourCode engine, in
 * place of the raw curls skills/callyourcode/CLI.md used to spell out.
 *
 * Structured like harness-integration.ts: exported PURE functions (arg parse,
 * table render, target resolution, the mime sniff) plus a thin `main`, so
 * the tests import the functions and drive `run()` against a loopback fake
 * engine, and never fork a real one (scripts/cyc.test.ts).
 *
 * EVERY COMMAND NAMES ITS AGENT EXPLICITLY. There is no "acts on self" magic:
 * self-resolution from CYC_AGENT_ID / pane env was fragile (hand-started
 * panes, env not inherited), so the agent id is a required argument
 * everywhere. An agent learns its OWN id from the MCP's `info` tool, which the
 * engine answers from the registered connection -- reliable for every pane.
 *
 * Engine target: CYC_ENGINE_URL (unix:/path.sock or http://host:port), else
 * VOICE_ENGINE_URL (deprecated), else the local socket when it exists, else the
 * loopback TCP default (shared/engine-url.ts resolveEngine). Every mutating verb
 * is a POST to an EXISTING route; a same-uid socket peer or a loopback caller
 * passes requireOwner/requireLocal for free (isTrustedLocal), so the CLI carries
 * no credential. `{ok,...}` answers print as-is; an `ok:false` or a transport
 * failure is exit 1 with the reason on stderr.
 *
 *   cyc install [--local]                        exec scripts/install.sh (--local: install from the on-disk repos)
 *   cyc mcp                                      exec bun engine/mcp/src/server.ts (the harness MCP launcher)
 *   cyc hook <name> [args...]                    exec python3 <the engine hook named `name`> (the harness hook launcher)
 *   cyc start                                    exec scripts/services.sh start
 *   cyc stop                                     exec scripts/services.sh stop
 *   cyc uninstall                                remove the services + the cyc shim; keeps ~/.callyourcode and the repos
 *   cyc voice off|on|status                      toggle ONLY the voice engine (scripts/services.sh voice-*); a voiceless install is a supported setting
 *   cyc pair                                     exec bun engine/agent-engine/src/security/pairkey.ts
 *   cyc model whisper|kokoro [size|variant]      show / set a voice model (engine/agent-engine/src/runtime/model.ts)
 *   cyc agents                                   table of every agent on this engine
 *   cyc agent rename <agentId> <name>            rename that agent ("" clears the override)
 *   cyc agent photo <agentId> <file|->           set that agent's photo (- reads stdin)
 *   cyc agent photo <agentId> --clear            clear it
 *   cyc agent message <toId> --from <fromId> <text>   feed input to an agent, honest author line
 *   cyc plugin <agentId> <pluginId> <op> [json]  local rpc on that plugin in that agent's scope
 *   cyc doctor                                   diagnose engine identity/ports across configs; round-trip the socket
 *
 *   bun test scripts/cyc.test.ts
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  resolveEngine, engineFetch, engineLabel, type EngineTarget,
} from "../engine/shared/engine-url.ts";
import { runDoctor } from "./doctor.ts";

export type Env = Record<string, string | undefined>;

export type AgentRow = {
  agentId: string;
  name: string;
  cwd: string;
  pane: string;
  harness: string;
  status: string;
  alive: boolean;
  sessionId: string;
};
export type AgentsReply = { ok: boolean; mux: string; agents: AgentRow[] };

/** What run() hands back. `exec` is a lifecycle pass-through main() runs and
 *  whose exit code it adopts; everything else is text + an exit code. */
export type RunResult = {
  code: number;
  out?: string;
  err?: string;
  exec?: string[];
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested).

/** The engine target the CLI talks to. CYC_ENGINE_URL is canonical (unix: or
 *  http://); VOICE_ENGINE_URL is a deprecated fallback kept for bundle skew
 *  (the MCP warns about it, the CLI stays quiet). Unset defaults to the local
 *  socket when it exists, else the TCP loopback port (shared/engine-url.ts). */
export function engineTargetFor(env: Env): EngineTarget {
  if (!env.CYC_ENGINE_URL && env.VOICE_ENGINE_URL) {
    return resolveEngine({ ...env, CYC_ENGINE_URL: env.VOICE_ENGINE_URL });
  }
  return resolveEngine(env);
}

/** A label for the resolved engine (error messages, and what the tests read):
 *  the origin for TCP, `unix:<path>` for the socket. */
export function engineOrigin(env: Env): string {
  return engineLabel(engineTargetFor(env));
}

/** `~` for the user's home in a folder path, for the table's FOLDER column. */
export function tildify(path: string, home: string | undefined): string {
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

/** The docker-ps-style table `cyc agents` prints. pane and sessionId are NOT
 *  shown: the pane id never appears in the CLI's grammar or output. */
export function renderAgentsTable(reply: AgentsReply, home?: string): string {
  const head = ["AGENT ID", "NAME", "FOLDER", "MUX", "HARNESS", "STATUS"];
  const rows = reply.agents.map((r) => [
    r.agentId, r.name, tildify(r.cwd, home), reply.mux, r.harness, r.status,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (row: string[]) =>
    row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ");
  return [line(head), ...rows.map(line)].join("\n");
}

/** A target agent by its stable id, or null when this engine has no such row.
 *  The one resolution the CLI does: every command is TOLD its agent id (an
 *  agent gets its own from the MCP `info` tool); nothing here reads env or
 *  panes to guess who "self" is. */
export function resolveTarget(agentId: string, agents: AgentRow[]): AgentRow | null {
  return agents.find((r) => r.agentId === agentId) ?? null;
}

/** The photo route whitelists on the content-type header, so the CLI must name
 *  the mime. Sniff the magic bytes rather than trust an extension: it is the one
 *  answer that also works for `-` (stdin). null: not an image the engine takes. */
export function sniffPhotoMime(b: Uint8Array): string | null {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  // ISO-BMFF (HEIC/HEIF): a `ftyp` box at offset 4, the brand at offset 8.
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "heif" || brand === "mif1" || brand === "msf1") return "image/heif";
    if (brand.startsWith("hei") || brand.startsWith("hev")) return "image/heic";
  }
  return null;
}

const USAGE = [
  "usage: cyc <command>",
  "",
  "  install [--local]                       run the installer; --local installs from the on-disk repos",
  "  mcp                                     run the CallYourCode MCP server (a harness wires this as `cyc mcp`)",
  "  hook <name> [args...]                   run the named engine hook (a harness wires this as `cyc hook <name>`)",
  "  start                                   start the services (scripts/services.sh start)",
  "  stop                                    stop the services (scripts/services.sh stop)",
  "  uninstall                               remove the services + the cyc shim; keeps ~/.callyourcode and the repos",
  "  voice off|on|status                     toggle only the voice engine; off makes a voiceless install stick (no boot restart)",
  "  pair                                    link a device: Local/Cloud chooser, then the link to open",
  "  model whisper|kokoro [size|variant]     show / set a voice model (engine/agent-engine/src/runtime/model.ts)",
  "  agents                                  list every agent on this engine",
  "  agent rename <agentId> <name>           rename that agent (\"\" clears the override)",
  "  agent photo <agentId> <file|->          set that agent's photo (- reads stdin)",
  "  agent photo <agentId> --clear           clear that agent's photo",
  "  agent message <toId> --from <fromId> <text>   feed input to an agent; --from names the sender",
  "  plugin <agentId> <pluginId> <op> [json-args]",
  "                                          call a plugin op in that agent's scope",
  "  doctor                                  diagnose engine identity/ports across every config, round-trip the socket",
  "",
  "every command takes the agent id explicitly (ag-..., from `cyc agents`; your",
  "own comes from the MCP info tool). engine target: CYC_ENGINE_URL",
  "(unix:/path.sock or http://host:port), else the local socket if present,",
  "else http://127.0.0.1:10101",
].join("\n");

// ---------------------------------------------------------------------------
// Wire calls (localhost; the engine's own auth gate passes a loopback caller).

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function reason(e: unknown, t: EngineTarget): string {
  const m = msg(e);
  if (/ECONNREFUSED|connect|fetch failed|refused|ENOENT/i.test(m)) {
    return `could not reach the engine at ${engineLabel(t)}: ${m}`;
  }
  return m;
}

async function fetchAgents(t: EngineTarget): Promise<AgentsReply> {
  const res = await engineFetch(t, "/agents");
  const text = await res.text();
  let body: AgentsReply | { error?: string } | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-json below */ }
  if (!res.ok || !body || (body as AgentsReply).ok !== true) {
    throw new Error((body as { error?: string })?.error || `engine answered ${res.status} for GET /agents`);
  }
  return body as AgentsReply;
}

/** Turn an engine answer into a RunResult: an `ok:false` (or an HTTP error) is
 *  exit 1 with the engine's own reason; a 503 retriable is the busy-pane note. */
async function handleReply(res: Response): Promise<RunResult> {
  const text = await res.text();
  let body: { ok?: boolean; error?: string; retriable?: boolean } | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (body && body.ok === false) {
    if (res.status === 503 && body.retriable) return { code: 1, err: "pane busy, retry shortly" };
    return { code: 1, err: body.error || `engine refused (${res.status})` };
  }
  if (!res.ok) return { code: 1, err: body?.error || `engine answered ${res.status}` };
  return { code: 0, out: text };
}

async function postJson(t: EngineTarget, path: string, body: unknown): Promise<RunResult> {
  let res: Response;
  try {
    res = await engineFetch(t, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { code: 1, err: reason(e, t) };
  }
  return handleReply(res);
}

async function postRaw(t: EngineTarget, path: string, bytes: Uint8Array, mime?: string): Promise<RunResult> {
  let res: Response;
  try {
    res = await engineFetch(t, path, {
      method: "POST",
      headers: mime ? { "content-type": mime } : {},
      body: bytes,
    });
  } catch (e) {
    return { code: 1, err: reason(e, t) };
  }
  return handleReply(res);
}

// ---------------------------------------------------------------------------
// Command handlers.

async function cmdAgents(t: EngineTarget, env: Env): Promise<RunResult> {
  let reply: AgentsReply;
  try { reply = await fetchAgents(t); }
  catch (e) { return { code: 1, err: reason(e, t) }; }
  return { code: 0, out: renderAgentsTable(reply, env.HOME) };
}

async function cmdAgent(
  rest: string[], t: EngineTarget, stdin: () => Promise<Uint8Array>,
): Promise<RunResult> {
  const sub = rest[0];
  if (sub !== "rename" && sub !== "photo" && sub !== "message") {
    return { code: 2, err: "usage: cyc agent rename|photo|message ...\n\n" + USAGE };
  }

  if (!rest[1]) {
    const use = sub === "rename" ? 'cyc agent rename <agentId> "<name>"'
      : sub === "photo" ? "cyc agent photo <agentId> <file|-> | --clear"
      : 'cyc agent message <toAgentId> --from <fromAgentId> "<text>"';
    return { code: 2, err: `usage: ${use}` };
  }

  let reply: AgentsReply;
  try { reply = await fetchAgents(t); }
  catch (e) { return { code: 1, err: reason(e, t) }; }

  if (sub === "rename") {
    const row = resolveTarget(rest[1], reply.agents);
    if (!row) return { code: 1, err: `no such agent: ${rest[1]}` };
    const name = rest.slice(2).join(" "); // empty clears the override
    return postJson(t, `/session/${encodeURIComponent(row.sessionId)}/rename`, { name });
  }

  if (sub === "photo") {
    const row = resolveTarget(rest[1], reply.agents);
    if (!row) return { code: 1, err: `no such agent: ${rest[1]}` };
    const path = `/session/${encodeURIComponent(row.sessionId)}/photo`;
    const arg = rest[2];
    if (arg === "--clear") return postRaw(t, path, new Uint8Array(0));
    if (!arg) return { code: 2, err: "usage: cyc agent photo <agentId> <file|-> | --clear" };
    let bytes: Uint8Array;
    try {
      bytes = arg === "-" ? await stdin() : new Uint8Array(await Bun.file(arg).arrayBuffer());
    } catch (e) {
      return { code: 1, err: `could not read ${arg === "-" ? "stdin" : arg}: ${msg(e)}` };
    }
    const mime = sniffPhotoMime(bytes);
    if (!mime) return { code: 1, err: "that is not a png, jpeg, webp, gif or heic/heif image" };
    return postRaw(t, path, bytes, mime);
  }

  // message <toAgentId> --from <fromAgentId> <text>: the recipient leads (like
  // rename/photo), the sender is a REQUIRED --from flag, so the author line is
  // honest without any self-guessing.
  const msgUse = 'usage: cyc agent message <toAgentId> --from <fromAgentId> "<text>"';
  const args = rest.slice(1);
  const fi = args.indexOf("--from");
  if (fi === -1) return { code: 2, err: msgUse };
  const fromId = args[fi + 1];
  if (!fromId) return { code: 2, err: msgUse };
  const toId = args[0];
  const text = [...args.slice(1, fi), ...args.slice(fi + 2)].join(" ");
  if (!text) return { code: 2, err: msgUse };
  const from = resolveTarget(fromId, reply.agents);
  if (!from) return { code: 1, err: `no such agent: ${fromId}` };
  const to = resolveTarget(toId, reply.agents);
  if (!to) return { code: 1, err: `no such agent: ${toId}` };
  const author = `${from.agentId} (${from.name})`;
  return postJson(t, `/session/${encodeURIComponent(to.sessionId)}/agent-message`, { author, text });
}

async function cmdPlugin(rest: string[], t: EngineTarget): Promise<RunResult> {
  /* The agent scope is REQUIRED and explicit, and leads the line (like
   * rename/photo/message): no env, no pane, no "self". */
  const [agentId, pluginId, op, jsonArgs] = rest;
  if (!agentId || !pluginId || !op) {
    return { code: 2, err: "usage: cyc plugin <agentId> <pluginId> <op> [json-args]" };
  }
  // Bad JSON is exit 2 BEFORE any request touches the engine.
  let parsedArgs: unknown = null;
  if (jsonArgs !== undefined) {
    try { parsedArgs = JSON.parse(jsonArgs); }
    catch { return { code: 2, err: "json-args was not valid JSON" }; }
  }

  let reply: AgentsReply;
  try { reply = await fetchAgents(t); }
  catch (e) { return { code: 1, err: reason(e, t) }; }

  const row = resolveTarget(agentId, reply.agents);
  if (!row) return { code: 1, err: `no such agent: ${agentId}` };
  return postJson(t, `/plugin/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(op)}`,
    { session: row.sessionId, args: parsedArgs });
}

/* `cyc hook <name> [args...]`: run the whitelisted engine hook `name` as
 *  `python3 <script> [args...]`. Unknown name is exit 2 with the roster, so a
 *  bad wire fails loud (and is caught by the boot self-check) rather than
 *  running an arbitrary path. */
export function cmdHook(rest: string[]): RunResult {
  const [name, ...args] = rest;
  if (!name) {
    return { code: 2, err: `usage: cyc hook <name> [args...]\nknown hooks: ${Object.keys(HOOK_SCRIPTS).join(", ")}` };
  }
  const script = hookScriptPath(name);
  if (!script) {
    return { code: 2, err: `unknown hook: ${name}\nknown hooks: ${Object.keys(HOOK_SCRIPTS).join(", ")}` };
  }
  return { code: 0, exec: ["python3", script, ...args] };
}

/* `cyc voice <off|on|status>`: toggle ONLY the voice engine. All unit handling
 *  (systemd vs launchd) lives in scripts/services.sh, so this just maps the
 *  subcommand to a services.sh action and hands it back as an exec pass-through
 *  (like start/stop). Bare `cyc voice` reports status. An unknown subcommand is
 *  exit 2 with usage, before anything runs. */
export function cmdVoice(rest: string[]): RunResult {
  const sub = rest[0] ?? "status";
  const action =
    sub === "off" ? "voice-off" :
    sub === "on" ? "voice-on" :
    sub === "status" ? "voice-status" : null;
  if (action === null) {
    return { code: 2, err: "usage: cyc voice <off|on|status>" };
  }
  return { code: 0, exec: ["sh", scriptPath("services.sh"), action] };
}

/* `cyc doctor`: read the engine identity/ports from every config location,
 *  name any disagreement, resolve what this process would use, and round-trip
 *  the local engine over its socket with side-effect-free probes. Exit 1 on any
 *  DIFF or FAILED leg. The pure diffing lives in doctor.ts (unit-tested); this
 *  wires the real IO (systemctl, the config files, Bun.version). */
async function cmdDoctor(env: Env): Promise<RunResult> {
  const realRun = async (cmd: string, args: string[]): Promise<string> => {
    try {
      const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return text;
    } catch {
      return ""; // systemctl absent (a mac, or no user manager): an empty source
    }
  };
  const res = await runDoctor(env, {
    run: realRun,
    readFile: (p: string) => Bun.file(p).text().then((t) => t, () => null),
    bunVersion: Bun.version,
    home: env.HOME && env.HOME.trim() ? env.HOME : homedir(),
  });
  return { code: res.code, out: res.text };
}

// ---------------------------------------------------------------------------
// Dispatch.

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = dirname(SCRIPTS_DIR);
const enginePath = (name: string) => join(REPO_ROOT, "engine", "agent-engine", "src", name);
const scriptPath = (name: string) => join(SCRIPTS_DIR, name);
const mcpServerPath = () => join(REPO_ROOT, "engine", "mcp", "src", "server.ts");

/* The harness hooks a harness config can wire, each resolved to its script
 * RELATIVE to this checkout. A config says `cyc hook <name>` -- machine
 * independent text -- and this launcher resolves it against the LOCAL engine,
 * so a config copied across machines (or a moved engine dir) never carries a
 * dead absolute path. The name is whitelisted: an unknown name is an error,
 * never a path this launcher will run. */
export const HOOK_SCRIPTS: Record<string, string[]> = {
  "enforce-voice-reply": ["engine", "hooks", "enforce-voice-reply.py"],
  "enforce-bash-async": ["engine", "hooks", "enforce-bash-async.py"],
  "enforce-shell-async": ["engine", "harness", "codex", "enforce-shell-async.py"],
  "announce-session": ["engine", "hooks", "announce-session.py"],
};

/** Resolve a whitelisted hook name to its absolute script path in this
 *  checkout, or null when the name is not one this launcher knows. */
export function hookScriptPath(name: string, repoRoot = REPO_ROOT): string | null {
  const parts = HOOK_SCRIPTS[name];
  return parts ? join(repoRoot, ...parts) : null;
}

export async function run(
  argv: string[], ctx: { env: Env; stdin: () => Promise<Uint8Array> },
): Promise<RunResult> {
  const env = ctx.env;
  const target = engineTargetFor(env);
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case "install": return { code: 0, exec: ["sh", scriptPath("install.sh"), ...rest] };
    case "mcp": return { code: 0, exec: ["bun", mcpServerPath(), ...rest] };
    case "hook": return cmdHook(rest);
    case "start": return { code: 0, exec: ["sh", scriptPath("services.sh"), "start"] };
    case "stop": return { code: 0, exec: ["sh", scriptPath("services.sh"), "stop"] };
    case "uninstall": return { code: 0, exec: ["sh", scriptPath("services.sh"), "uninstall"] };
    case "voice": return cmdVoice(rest);
    case "pair": return { code: 0, exec: ["bun", enginePath("security/pairkey.ts"), ...rest] };
    case "model": return { code: 0, exec: ["bun", enginePath("runtime/model.ts"), ...rest] };
    case "agents": return cmdAgents(target, env);
    case "agent": return cmdAgent(rest, target, ctx.stdin);
    case "plugin": return cmdPlugin(rest, target);
    case "doctor": return cmdDoctor(env);
    case "help": case "-h": case "--help": return { code: 0, out: USAGE };
    case undefined: return { code: 2, out: USAGE };
    default: return { code: 2, err: `unknown command: ${cmd}\n\n${USAGE}` };
  }
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of Bun.stdin.stream()) { chunks.push(chunk); total += chunk.length; }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function main(): Promise<number> {
  const res = await run(process.argv.slice(2), { env: process.env as Env, stdin: readStdin });
  if (res.exec) {
    const proc = Bun.spawn(res.exec, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await proc.exited;
  }
  if (res.out) process.stdout.write(res.out.endsWith("\n") ? res.out : res.out + "\n");
  if (res.err) process.stderr.write(res.err.endsWith("\n") ? res.err : res.err + "\n");
  return res.code;
}

if (import.meta.main) process.exit(await main());
