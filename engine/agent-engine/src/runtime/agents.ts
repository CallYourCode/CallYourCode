/* WHICH CODING AGENTS THIS ENGINE CAN NAME, and that is now the whole job.
 *
 * This used to answer a wider question -- a capability profile per agent
 * (dialogs, composer, launch, transcript, voice) -- and by answering it kept a
 * second copy of every "what can this engine honestly do" fact out of the
 * reader that actually does the work. The capabilities moved into the mux's
 * reader table (adapters/mux-adapter.ts, readers/*): claude is the full reader,
 * codex/opencode/pi bring their transcript readers, everything else is
 * name-only. What remains here is exactly the DISPLAY NAME TABLE plus the id
 * normalization the mux and tmux share.
 *
 * THE DISPLAY NAME IS STILL A WIRE FACT, for the reason the old per-agent
 * profile gave: the app must never compile the word "Claude" into "Queued for
 * Claude" over a pane running codex. The name comes from this table, per
 * agent, and rides the row.
 */

import { basename } from "node:path";
import { readlinkSync } from "node:fs";

/** What the multiplexer reported for a pane's own session handle: herdr's
 *  `agent_session` (the codex thread id, the opencode session id) or tmux's
 *  linked claude uuid. `kind` says whether `id` is an opaque id or a path;
 *  `source` names who filled it (which integration), for the log. */
export type AgentSessionRef = {
  id: string;
  kind: "id" | "path";
  source: string;
  /** what the harness said about where this session CAME FROM (announce v2,
   *  adapters lane 2): claude SessionStart `source` (clear, fork, resume,
   *  compact), codex `forked_from_id`, pi `previousSessionFile`. `from` is
   *  the prior session id when the harness named one; reconcile looks it up
   *  in the session index before any pane matching. */
  link?: SessionLink;
};
export type SessionLink = { kind: "clear" | "fork" | "resume" | "compact" | "parent" | "startup"; from?: string };

/** Source stamp for a PRE-MINTED link: the engine spawned the pane itself and
 *  already knows its stable agent id (the CYC_AGENT_ID it injected at launch),
 *  so the mux emits that as the pane's link until the harness writes a real
 *  transcript. The ref's `id` is an engine agent id (ag-...), NOT a harness
 *  session id, and consumers must never read it as one; the adapter checks
 *  this stamp before deriving harnessSessionId or locating a transcript. */
export const PREMINT_SOURCE = "tmux:premint";

/** Source stamp for a PARKED link: a hand-started pane (no CYC_AGENT_ID, so no
 *  pre-mint) whose harness has not written a transcript yet. The ref's `id` is
 *  the PANE HANDLE, so the session surfaces in the app (trust prompt included)
 *  keyed by its handle until the harness mints a uuid; the same adapter checks
 *  that guard PREMINT_SOURCE apply, since the id is not a harness session id. */
export const PARKED_SOURCE = "tmux:parked";

/** Source stamp for an ANNOUNCED link: the harness itself said "session Y,
 *  pid N" through the installed SessionStart/UserPromptSubmit hook
 *  (hooks/announce-session.py -> POST /harness/announce). It is the STRONGEST
 *  identity evidence there is -- the session file is authoritative and the
 *  announce comes from inside the process that owns it -- so an announced ref
 *  overrides a pre-mint, a parked handle and any folder guess immediately, and
 *  none of the anti-theft gates (birth floors, quiet gates) ever apply against
 *  it. */
export const ANNOUNCED_SOURCE = "hook:announce";

/** The two facts core shows about a session's agent on the wire: the normalized
 *  stamp (`agentId`) and the display name (`agent`). Every other thing the
 *  engine can honestly do for an agent is a READER capability owned by the mux
 *  (adapters/), not a field here. */
export type AgentLabel = { id: string; name: string };

/** Capitalise the first letter, and only that. A name with its own casing
 *  (a space, an internal capital, a deliberately-lowercase product) is spelled
 *  out in the table, never guessed from the id. */
function labelFor(id: string): string {
  return id ? id[0].toUpperCase() + id.slice(1) : id;
}

/* THE DISPLAY NAME TABLE. The names are the ones each product spells itself:
 * "OpenCode" would be wrong when the product writes "opencode", so opencode
 * stays lowercase and codex is capitalised; capitalising is only the fallback
 * for an id the table does not know. */
const KNOWN_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "opencode",
  pi: "Pi",
  hermes: "Hermes",
  openclaw: "Openclaw",
  gemini: "Gemini",
  cursor: "Cursor",
  aider: "Aider",
};

/** The agent ids this engine knows a display name for. tmux.ts matches a pane's
 *  foreground command against this set instead of the single old HARNESS.id, so
 *  a tmux user running codex is detected the same as one running claude. */
export const AGENT_IDS: readonly string[] = Object.keys(KNOWN_NAMES);

/* WRAPPER / VERSION-SHIM install-location patterns. A usage-freeze wrapper,
 * a version manager, or a renamed launcher `exec`s the REAL harness binary,
 * whose comm and argv[0] no longer say "claude"/"codex": on one host claude
 * runs through a wrapper that execs `~/.local/share/claude/versions/<ver>`,
 * so the live process reports comm=`claude-real` and a version-named exe. The
 * ONE signal that survives every wrapper is the RESOLVED executable path
 * (/proc/<pid>/exe) and the real launched path in argv: the harness always
 * lives under its own install directory. Each pattern is a KNOWN install
 * location, tight enough that a random process merely carrying the word in a
 * path arg (e.g. `cat /home/claude/notes.txt`) never matches -- the marker
 * (`versions`, the scoped npm package) is what a real install has and a
 * passing mention does not. */
const INSTALL_PATH_HINTS: ReadonlyArray<{ id: string; re: RegExp }> = [
  // `.../claude/versions/<ver>` (the version binary a wrapper execs)
  { id: "claude", re: /[\/\\]claude[\/\\]versions[\/\\]/ },
  // codex ships as the scoped npm package `@openai/codex`
  { id: "codex", re: /[\/\\]@openai[\/\\]codex[\/\\]/ },
  // opencode's npm package is `opencode` / `opencode-ai`
  { id: "opencode", re: /[\/\\]opencode(?:-ai)?[\/\\]/ },
  // pi ships as `@earendil-works/pi-coding-agent`
  { id: "pi", re: /[\/\\](?:@earendil-works[\/\\]pi|pi-coding-agent)[\/\\]?/ },
  // generic `.../<id>/versions/<ver>` for any known harness that adopts the
  // same version-dir layout claude uses (added last, never shadows a specific
  // hint above)
  ...AGENT_IDS.map((id) => ({ id, re: new RegExp(`[\\/\\\\]${id}[\\/\\\\]versions[\\/\\\\]`) })),
];

/* WRAPPER-SUFFIX shapes. A wrapper is routinely named after the harness with a
 * marker glued on -- `claude-real`, `claude.bin`, `codex.js`. Stripping the
 * suffix and re-matching the base recovers the id when the wrapper kept the
 * name but dressed it. Applied only AFTER an exact match fails, so the normal
 * `claude` case never pays for it. Note a version-NAMED binary (comm=`2.1.241`)
 * carries no harness word at all and is recovered by the exe path, not here. */
function stripWrapperSuffix(name: string): string {
  let base = name;
  // a trailing extension a launcher may add
  base = base.replace(/\.(?:bin|exe|js|mjs|cjs|sh)$/i, "");
  // a `-real` / `.real` wrapper marker (the usage-freeze shape)
  base = base.replace(/[-.]real$/i, "");
  // a trailing version glued to the name (`claude-2.1.241`)
  base = base.replace(/[-.]v?\d+(?:\.\d+)+$/i, "");
  return base;
}

/** The known agent a program NAME denotes: its basename, exactly, or its
 *  basename after a wrapper suffix is stripped (`claude-real` -> `claude`).
 *  Returns null for a name no known harness owns. */
function idFromName(raw: string): string | null {
  const base = basename((raw ?? "").trim());
  if (!base) return null;
  if (AGENT_IDS.includes(base)) return base;
  const stripped = stripWrapperSuffix(base);
  if (stripped !== base && AGENT_IDS.includes(stripped)) return stripped;
  return null;
}

/** The known agent a PATH denotes: the resolved executable, or a launched-path
 *  token, that lives under a known harness install location. Requires a path
 *  separator and a known install marker, so a bare word or a passing mention
 *  of the name in an unrelated path never matches (no false positives). */
function idFromPath(raw: string): string | null {
  const p = (raw ?? "").trim();
  if (!p || (!p.includes("/") && !p.includes("\\"))) return null;
  for (const { id, re } of INSTALL_PATH_HINTS) {
    if (re.test(p)) return id;
  }
  return null;
}

/** Resolve `/proc/<pid>/exe` to the real executable behind a wrapper, or null
 *  when it cannot be read (a dead pid, a non-Linux host with no procfs, a
 *  permission wall). Strips the ` (deleted)` suffix Linux appends when the
 *  binary was replaced under a running process. Callers pass this as the lazy
 *  resolver to agentIdOfProc; a test injects a fake instead, so no real
 *  process is needed. */
export function resolveProcExe(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
  } catch {
    return null;
  }
}

/** Which known agent a PROCESS is, judged by comm, command line, and -- when
 *  those fall through -- the RESOLVED executable behind a wrapper. Claude Code
 *  retitles its process to its version (e.g. "2.1.241"), so on a real machine
 *  comm never says "claude"; the args first token still carries the launched
 *  path (".../bin/claude"), so its basename is checked too. A usage-freeze
 *  WRAPPER goes one worse: it execs the version binary, so comm=`claude-real`
 *  and argv[0]=`claude-real`, and neither basename is a known id. The order is
 *  cheapest-and-tightest first, most-robust last:
 *    1. comm basename, exact then suffix-stripped (`claude-real` -> claude);
 *    2. argv[0] basename, exact then suffix-stripped (the launched path);
 *    3. any argv token that is an install PATH of a known harness (a wrapper
 *       that passes the real binary as an argument);
 *    4. the resolved exe (via `resolveExe`, called ONLY when 1-3 fail so the
 *       normal case pays no readlink): its basename, then its install path.
 *  `resolveExe` is injected so a test needs no real `/proc`. Shared by the
 *  tmux poller's subtree walk (tmux.ts) and the announce route's ancestor
 *  walk (hook-announce.ts). */
export function agentIdOfProc(
  comm: string,
  args: string,
  resolveExe?: () => string | null | undefined,
): string | null {
  const byComm = idFromName(comm);
  if (byComm) return byComm;
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens[0]) {
    const byArg0 = idFromName(tokens[0]);
    if (byArg0) return byArg0;
  }
  for (const t of tokens) {
    const byPath = idFromPath(t);
    if (byPath) return byPath;
  }
  const exe = resolveExe?.() ?? null;
  if (exe) {
    const byExeName = idFromName(exe);
    if (byExeName) return byExeName;
    const byExePath = idFromPath(exe);
    if (byExePath) return byExePath;
  }
  return null;
}

/** Normalize a raw mux stamp to an id: lowercase, trim, strip a leading
 *  `herdr:` (the opencode manifest's alias), and fold the hyphenated spellings.
 *  A stamp the table does not know passes through as its normalized self. */
export function normalizeAgentId(raw: string): string {
  let id = (raw ?? "").trim().toLowerCase();
  if (id.startsWith("herdr:")) id = id.slice("herdr:".length);
  if (id === "claude-code") return "claude";
  if (id === "open-code") return "opencode";
  return id;
}

/** The wire-facing label for a raw mux stamp: the normalized id and the display
 *  name. Always returns one (never null): an unknown agent keeps its normalized
 *  id and a capitalised name. */
export function agentLabel(raw: string): AgentLabel {
  const id = normalizeAgentId(raw);
  const name = KNOWN_NAMES[id] ?? labelFor(id);
  return { id, name };
}

/** Log once, at boot, if a retired env var is set, so a modifier who set the old
 *  knob learns it is ignored rather than silently getting every agent listed
 *  (which is the new behaviour, and probably what they wanted anyway).
 *  ENGINE_AGENT_NAMES joined the retired list once `cyc agent rename` became
 *  the one way to rename a row: a per-session override, stored by the engine. */
export function warnRetiredEnv(env: Record<string, string | undefined> = process.env): void {
  for (const key of ["ENGINE_AGENT", "ENGINE_AGENT_NAME", "ENGINE_AGENT_NAMES"]) {
    if ((env[key] ?? "").trim()) {
      console.log(`[agents] ${key} is retired and ignored: every agent-stamped pane is now ` +
        `listed regardless. Use "cyc agent rename" to rename a row.`);
    }
  }
}
