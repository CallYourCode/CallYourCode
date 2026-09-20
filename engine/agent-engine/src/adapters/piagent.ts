/* PERSONAL ADAPTER: pi-agent lanes in the agents bar.
 *
 * A Claude session launches pi-agent work as a BACKGROUND Bash tool_use whose
 * command runs a `pi-run` or `pi-workflow` wrapper (from wherever it lives).
 * That is structurally a
 * background agent: a launch tool_use, a "Task ID:" in the launch result, and a
 * later `<task-notification>` completion. The core parser already pairs that
 * shape (see session-events.ts). All this adapter adds is the RECOGNITION step:
 * turn a matching background Bash launch into an `AgentRun` tagged `source:"pi"`
 * with a model label, so it renders as an agent row rather than being skipped.
 *
 * ISOLATED AND GATED. Nothing here runs unless `CYC_PIAGENT_ADAPTER=1`. With the
 * flag unset the vanilla engine takes no new code path and emits no pi rows.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile as readFileP } from "node:fs/promises";
import type { AgentRun } from "../sessions/session-events.ts";

/** The gate. The adapter is inert unless this is set. */
export function piAdapterEnabled(): boolean {
  return process.env.CYC_PIAGENT_ADAPTER === "1";
}

/* The discriminator, anchored to the INVOKED PROGRAM: a match anywhere in the
 * string (grep pi-run, cat ...pi-run-history.jsonl, git log --grep=pi-run) must
 * NOT count. Only the launched program ending in pi-run / pi-workflow does. */
const PI_PROGRAM = /(^|\/)pi-(run|workflow)$/;

/* The program actually invoked by a launch command: the first token of the last
 * `&&` segment (the real invocation after `cd <wt> && export VOICE_URL=... &&`),
 * with leading env assignments (VOICE_URL=...) and a `timeout N` prefix
 * stripped. Returns "" when there is no invocation to name.
 *
 * Shell line-continuations (a backslash right before a newline) are joined
 * first, so `... && \\\n  /path/to/pi-run ...` tokenizes to the program
 * rather than a bare `\\`. */
function invokedProgram(cmd: string): string {
  const joined = cmd.replace(/\\[ \t]*\r?\n/g, " ");
  const seg = joined.split("&&").pop() ?? joined;
  const tokens = seg.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && tokens[0] === "\\") tokens.shift();
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (tokens[0] === "timeout") {
    tokens.shift();
    if (tokens.length && /^\d+$/.test(tokens[0])) tokens.shift();
  }
  return tokens[0] ?? "";
}

const WORDS_CAP = 8;   // task words kept for the description
const DESC_CAP = 80;   // total description length

function flagValue(cmd: string, name: string): string {
  // --name value  or  --name=value  (value may be quoted)
  const eq = cmd.match(new RegExp(`--${name}=("([^"]*)"|'([^']*)'|(\\S+))`));
  if (eq) return eq[2] ?? eq[3] ?? eq[4] ?? "";
  const sp = cmd.match(new RegExp(`--${name}\\s+("([^"]*)"|'([^']*)'|(\\S+))`));
  if (sp) return sp[2] ?? sp[3] ?? sp[4] ?? "";
  return "";
}

/* The badge: --provider + --model folded to one short label.
 *   grok / grok-4.6              -> "grok-4.6"  (model already names the provider)
 *   opus / 4.8                   -> "opus 4.8"  (model does not, so keep both)
 *   claude-bridge / claude-opus-4-8 -> "opus 4.8" (provider is redundant)
 *   opencode-go / kimi-k3        -> "kimi-k3"   (runner label, model names it) */
export function modelLabel(provider: string, model: string): string {
  const p = provider.trim();
  const m = model.trim();
  if (!m) return p;
  const pl = p.toLowerCase();
  // claude-bridge/anthropic name the same family the model already spells out
  // (claude-opus-4-8). Drop "claude-", turn the family|version hyphen into a
  // space and the rest of the version into dots: claude-opus-4-8 -> "opus 4.8".
  if ((pl === "claude-bridge" || pl === "anthropic") && /claude/i.test(m)) {
    return m.replace(/^claude-/i, "").replace(/-/, " ").replace(/-/g, ".");
  }
  // The provider adds nothing when the model already contains its family word
  // (grok/grok-4.6) or when it is a compound runner label (opencode-go/kimi-k3):
  // show the model alone. Otherwise keep both (opus 4.8, claude opus-4.8).
  if (!p) return m;
  if (m.toLowerCase().includes(pl) || p.includes("-")) return m;
  return `${p} ${m}`;
}

/* The literal task argument of a pi-run launch: the longest quoted string on the
 * command line (pi-run ... -p "<task>"). UNCAPPED, so the stop route can match it
 * verbatim against a live process's cmdline; taskWords caps a shortened copy for
 * the row description. */
export function piTaskText(cmd: string): string {
  let best = "";
  for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    const s = m[1] ?? m[2] ?? "";
    if (s.length > best.length) best = s;
  }
  return best;
}

/* A few words of the task, for the row description. */
function taskWords(cmd: string): string {
  const best = piTaskText(cmd).trim();
  if (!best) return "";
  return best.replace(/\s+/g, " ").split(" ").slice(0, WORDS_CAP).join(" ");
}

/* Recognize a background pi-lane launch. Returns an AgentRun to fold into the
 * run map, or null for anything that is not a pi-lane. The core parser's
 * existing tool_result / task-notification handling then closes it (the launch
 * result carries "Task ID: <id>", the completion the matching <task-id>). */
export function piLaneFromToolUse(b: any, ts: number): AgentRun | null {
  if (b?.name !== "Bash") return null;
  if (b?.input?.run_in_background !== true) return null;
  const cmd = typeof b?.input?.command === "string" ? b.input.command : "";
  if (!PI_PROGRAM.test(invokedProgram(cmd))) return null;

  const provider = flagValue(cmd, "provider");
  const model = flagValue(cmd, "model");
  const label = modelLabel(provider, model);
  const words = taskWords(cmd);
  let desc = label && words ? `${label} · ${words}` : (words || label || "pi-lane");
  if (desc.length > DESC_CAP) desc = desc.slice(0, DESC_CAP) + "…";

  return {
    toolUseId: String(b.id),
    agentId: null,
    ts,
    desc,
    endedTs: null,
    tokens: null,
    source: "pi",
    model: label || undefined,
    command: cmd,
  };
}

// ------------------------------------------------------- stop a running lane

/* The run to stop, found by its harness agentId. ONLY a pi-lane can be stopped
 * (never touch a non-pi run), so a subagent id -- or an unknown id -- returns
 * null and the route answers 404. */
export function piRunByAgentId(runs: AgentRun[], agentId: string): AgentRun | null {
  if (!agentId) return null;
  return runs.find((r) => r.source === "pi" && r.agentId === agentId) ?? null;
}

/* Kill the live pi-run process behind a recorded launch task. pi-run writes NO
 * pidfile, so the only handle is the task it was launched with (pi-run ... -p
 * "<task>"), which rides on the process's argv verbatim. Scan /proc for a
 * process whose cmdline contains that EXACT task (never a loose pattern) and
 * kill its process GROUP -- the pi-run bash and the pi child share it. Returns
 * true if something was signalled, false if no matching process is alive.
 *
 * Our own group is skipped so a task word that happened to land in this engine's
 * argv can never make it kill itself (best-effort: when /proc/self/stat cannot
 * name our group the scan proceeds without the skip, which on a host without
 * /proc also finds no candidates at all). */
export async function killPiRunByTask(task: string): Promise<boolean> {
  if (!task) return false;
  let ownPgid = -1;
  try {
    const selfStat = await readFileP("/proc/self/stat", "utf8");
    const parsed = Number(selfStat.slice(selfStat.lastIndexOf(")") + 1).trim().split(/\s+/)[2]);
    // A NaN would compare unequal to every pgrp and silently drop the self-skip.
    if (Number.isFinite(parsed)) ownPgid = parsed;
  } catch {}
  let pids: string[];
  try { pids = await readdir("/proc"); } catch { return false; }
  const groups = new Set<number>();
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let cmdline: string;
    try { cmdline = await readFileP(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
    if (!cmdline) continue;
    // argv is NUL-separated; the task rode as a single argv element (the quoted
    // -p argument), so it appears contiguous once the NULs are spaces.
    if (!cmdline.replace(/\0/g, " ").includes(task)) continue;
    let stat: string;
    try { stat = await readFileP(`/proc/${pid}/stat`, "utf8"); } catch { continue; }
    // fields after the ")": state ppid pgrp ...
    const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[2]);
    if (Number.isFinite(pgrp) && pgrp > 1 && pgrp !== ownPgid) groups.add(pgrp);
  }
  if (!groups.size) return false;
  let killed = false;
  for (const g of groups) {
    try { process.kill(-g, "SIGTERM"); killed = true; } catch {}
  }
  return killed;
}

// ------------------------------------------------------- enrich from history

/* Where the pi-run wrapper records each run. Configurable so the adapter never
 * hard-names one person's home layout: set CYC_PIAGENT_HISTORY to the wrapper's
 * history file. Falls back to a generic location; enrichment degrades silently
 * when the file is absent, so an unset env on a box without the wrapper simply
 * skips enrichment. */
const HISTORY_PATH =
  process.env.CYC_PIAGENT_HISTORY ||
  join(homedir(), ".cyc", "pi-run-history.jsonl");

type HistoryRow = {
  ts?: number;
  cwd?: string;
  requested_model?: string;
  resolved_model?: string;
};

/* Best-effort: correlate each pi run with the wrapper's run-history file
 * (HISTORY_PATH) to fill the RESOLVED model (the requested "grok-4.6" may resolve to a dated
 * build). Match by requested model and nearest launch ts. If the file is
 * missing, unreadable, or nothing matches, degrade silently: the requested
 * label already stands, and this must never throw or block the feed. */
export async function enrichPiRuns(runs: AgentRun[]): Promise<void> {
  if (!runs.some((r) => r.source === "pi")) return;
  let rows: HistoryRow[];
  try {
    const f = Bun.file(HISTORY_PATH);
    if (!(await f.exists())) return;
    const text = await f.text();
    rows = text.split("\n").flatMap((line) => {
      const s = line.trim();
      if (!s) return [];
      try { return [JSON.parse(s) as HistoryRow]; } catch { return []; }
    });
  } catch { return; }
  if (!rows.length) return;

  for (const run of runs) {
    if (run.source !== "pi" || !run.model) continue;
    const want = run.model.trim().toLowerCase();
    let best: HistoryRow | null = null;
    let bestGap = Infinity;
    for (const row of rows) {
      const req = String(row.requested_model ?? "").trim().toLowerCase();
      if (!req || (req !== want && !want.includes(req) && !req.includes(want))) continue;
      const rowTs = Number(row.ts);
      const gap = Number.isFinite(rowTs) ? Math.abs(rowTs - run.ts) : Infinity;
      if (gap < bestGap) { bestGap = gap; best = row; }
    }
    const resolved = String(best?.resolved_model ?? "").trim();
    if (resolved) run.model = resolved;
  }
}
