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
import { readdir, readFile, stat } from "node:fs/promises";
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

/** One session's rows from a set of parsed statuses, newest last, capped: the
 *  shared shape both the direct read and the cache read return. */
function rowsForSession(statuses: Iterable<Status>, sessionPath: string, now: number, alive: typeof pidAlive): AgentRun[] {
  const runs: AgentRun[] = [];
  for (const s of statuses) {
    const r = runFromStatus(s, sessionPath, now, alive);
    if (r) runs.push(r);
  }
  runs.sort((a, b) => a.ts - b.ts);
  return runs.slice(-MAX_RUNS);
}

/** This pi session's subagent runs, newest last (the bar's order). Uncached: a
 *  full readdir + read + parse of every run, kept for the pi pane reader and as
 *  the equivalence oracle for the cache below. */
export async function readPiSubagentRuns(sessionPath: string, root = piSubagentsRoot(), now = Date.now()): Promise<AgentRun[]> {
  const dir = join(root, "async-subagent-runs");
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const statuses: Status[] = [];
  await Promise.all(names.map(async (n) => {
    try {
      statuses.push(JSON.parse(await readFile(join(dir, n, "status.json"), "utf8")) as Status);
    } catch { /* a run mid-write or gone: skip it */ }
  }));
  return rowsForSession(statuses, sessionPath, now, pidAlive);
}

/* THE SHARED PI RUNS CACHE.
 *
 * The count poll (subagent-count.ts) and the in-chat agents bar route
 * (routes/session-ops.ts) both want every live pi session's runs, and the runs
 * of ALL sessions live intermixed in one dir: <root>/async-subagent-runs. A
 * per-session readPiSubagentRuns re-read the WHOLE dir (~450 status.json,
 * ~9 MB, ~450 JSON.parse) for each of the 11-16 live pi panes every 8 s -- the
 * same bytes, read and parsed a dozen times a tick, growing with retained runs.
 *
 * So the scan is done ONCE per poll into this module-level cache, keyed by run
 * dir, and a run's status.json is re-read only when its mtime or size moved
 * since the last scan (a run starting, stepping or finishing is a write, so an
 * unchanged file is an unchanged run). Removed run dirs are dropped. Steady
 * state -- no run changed -- is a readdir plus one stat per run, no reads and no
 * parses. Both callers read their session's rows out of the cache; the rows are
 * shaped fresh each read (now + pid liveness), so output is byte-identical to
 * readPiSubagentRuns for the same status.json set. */
type CacheEntry = { mtimeMs: number; size: number; status: Status | null };
const statusCache = new Map<string, CacheEntry>();
let lastScanAt = 0;

// A route hit within this window of the last scan reads the cache as-is; older
// than this, it refreshes first so a between-polls request is not stale.
const ROUTE_STALE_MS = 3000;

/** Rescan the pi runs dir into the cache: readdir + stat each status.json, only
 *  re-reading+parsing a run whose mtime or size changed, dropping entries for
 *  run dirs that are gone. Runs once per poll for all sessions. */
export async function refreshPiSubagentCache(root = piSubagentsRoot(), now = Date.now()): Promise<void> {
  const dir = join(root, "async-subagent-runs");
  let names: string[];
  try { names = await readdir(dir); } catch { statusCache.clear(); lastScanAt = now; return; }
  const seen = new Set<string>();
  await Promise.all(names.map(async (n) => {
    const runDir = join(dir, n);
    let st: { mtimeMs: number; size: number };
    try { st = await stat(join(runDir, "status.json")); } catch { return; } // no status.json (yet)
    seen.add(runDir);
    const prev = statusCache.get(runDir);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return; // unchanged: no re-read
    let status: Status | null = null;
    try { status = JSON.parse(await readFile(join(runDir, "status.json"), "utf8")) as Status; }
    catch { status = null; } // mid-write or broken: cached null, re-read when it next moves
    statusCache.set(runDir, { mtimeMs: st.mtimeMs, size: st.size, status });
  }));
  for (const k of statusCache.keys()) if (!seen.has(k)) statusCache.delete(k);
  lastScanAt = now;
}

/** One pi session's runs from the cache (no I/O), newest last, capped. Identical
 *  to readPiSubagentRuns' output for the same status.json set. */
export function piSubagentRunsCached(sessionPath: string, now = Date.now(), alive = pidAlive): AgentRun[] {
  const statuses: Status[] = [];
  for (const e of statusCache.values()) if (e.status) statuses.push(e.status);
  return rowsForSession(statuses, sessionPath, now, alive);
}

/** The route's read: refresh first only when the cache is more than a few
 *  seconds stale (the 8s poll keeps it warm), then serve from the cache. */
export async function piSubagentRunsFresh(sessionPath: string, root = piSubagentsRoot(), now = Date.now()): Promise<AgentRun[]> {
  if (now - lastScanAt > ROUTE_STALE_MS) await refreshPiSubagentCache(root, now);
  return piSubagentRunsCached(sessionPath, now);
}

/** TEST ONLY: empty the cache so a cache test starts cold. */
export function resetPiSubagentCacheForTest(): void {
  statusCache.clear();
  lastScanAt = 0;
}
