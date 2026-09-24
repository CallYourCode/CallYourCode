/* pi's subagents in the app's agents bar.
 *
 * pi-subagents (the npm package pi agents run their subagents through) writes
 * each background run's live state to <root>/async-subagent-runs/<runId>/
 * status.json: the parent session file (sessionId), state, start/end, the
 * agent, task title and model per step, token totals and the runner pid. That
 * is the same fact claude's transcript gives readAgentRuns, so a pi pane's runs
 * are read straight from there and shaped as AgentRun rows the bar already
 * renders. There is no stop from the bar (owner, 2026-09-24): ask the agent.
 *
 * Root: PI_SUBAGENTS_TEMP_ROOT, else <tmpdir>/pi-subagents-uid-<uid>, the rule
 * pi-subagents' shared/types.js uses for the same user. */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { AgentRun } from "../sessions/session-events.ts";

// Finished runs stay in the bar this long, like a recent claude subagent.
const RECENT_MS = 24 * 60 * 60 * 1000;
const MAX_RUNS = 20;

export function piSubagentsRoot(env: Record<string, string | undefined> = process.env): string {
  const own = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (own) return own;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return join(tmpdir(), uid !== null ? `pi-subagents-uid-${uid}` : "pi-subagents-shared");
}

type Step = { agent?: string; sessionName?: string; model?: string };
type Status = {
  runId?: string; sessionId?: string; state?: string; pid?: number;
  startedAt?: number; endedAt?: number; lastUpdate?: number;
  steps?: Step[]; totalTokens?: { total?: number };
};

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
}

function tokensLabel(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

/** The bar row for one status.json, or null when it is not this session's. */
export function runFromStatus(s: Status, sessionPath: string, now: number, alive = pidAlive): AgentRun | null {
  if (!s || s.sessionId !== sessionPath || typeof s.runId !== "string") return null;
  const startedAt = typeof s.startedAt === "number" ? s.startedAt : null;
  if (startedAt === null) return null;
  const step = (Array.isArray(s.steps) && s.steps[0]) || {};
  // "running" with its runner gone is a run that died: close it at its last word
  const running = s.state === "running" && alive(s.pid);
  const endedTs = running ? null
    : typeof s.endedAt === "number" ? s.endedAt
    : typeof s.lastUpdate === "number" ? s.lastUpdate : startedAt;
  if (!running && now - (endedTs ?? startedAt) > RECENT_MS) return null;
  const agent = step.agent || "subagent";
  const title = (step.sessionName || "").replace(new RegExp(`^${agent}:\\s*`), "").trim();
  const model = typeof step.model === "string" ? step.model.split("/").pop() : undefined;
  return {
    toolUseId: `pi-subagent:${s.runId}`,
    agentId: s.runId,
    ts: startedAt,
    desc: title ? `${agent}: ${title}` : agent,
    endedTs,
    tokens: tokensLabel(s.totalTokens?.total),
    source: "pi",
    ...(model ? { model } : {}),
  };
}

/** This pi session's subagent runs, newest last (the bar's order). */
export async function readPiSubagentRuns(sessionPath: string, root = piSubagentsRoot(), now = Date.now()): Promise<AgentRun[]> {
  const dir = join(root, "async-subagent-runs");
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const runs: AgentRun[] = [];
  await Promise.all(names.map(async (n) => {
    try {
      const s = JSON.parse(await readFile(join(dir, n, "status.json"), "utf8")) as Status;
      const r = runFromStatus(s, sessionPath, now);
      if (r) runs.push(r);
    } catch { /* a run mid-write or gone: skip it */ }
  }));
  runs.sort((a, b) => a.ts - b.ts);
  return runs.slice(-MAX_RUNS);
}
