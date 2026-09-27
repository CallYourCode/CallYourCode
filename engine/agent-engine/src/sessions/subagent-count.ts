/* RUNNING SUBAGENT COUNT PER SESSION (L2 domain).
 *
 * The open chat's agents bar already shows "N agents running" from the runs
 * the `/session-agents/:id` route reads (pi from its status.json files, every
 * other harness from the claude transcript). The chats list showed nothing, so
 * a chat with five subagents working looked idle. This poll reads the SAME runs
 * through the SAME two seams the route uses, counts the running ones (a run
 * whose `endedTs` is null, exactly the bar's own running test), caches the
 * count per session and reports a change through broadcastSessions. The number
 * rides the sessions frame (sessions-frame.ts) so every row can draw a small
 * "N agents" chip, live, without the app polling one loop per chat.
 *
 * Sessions and the run readers are injected at boot (initSubagentCount); the
 * poll starts there, on the same cadence and the same clock seam context-cache
 * uses.
 *
 *   bun test agent-engine/src/sessions/subagent-count.test.ts
 */

import { realClock, type Clock } from "../runtime/clock.ts";
import type { AgentRun } from "./session-events.ts";

// The same 8s cadence context-cache polls on: a subagent starting or finishing
// is news within one tick, and the read is short-circuited when nothing moved.
export const SUBAGENT_POLL_MS = 8000;

/** The slice of a Session this module reads (structural; no cycle). */
export type SubagentCountSession = {
  id: string;
  agent: { id: string };
  cwd: string;
  /** the ONE harness session id; the claude jsonl id is derived from it and
   *  the agent kind, exactly as context-cache derives its own. */
  harnessSessionId: string | null;
  muxHandle: string;
  alive: boolean;
};

type SubagentCountDeps = {
  sessions(): Iterable<SubagentCountSession>;
  /** pi keeps its subagents beside pi-subagents, keyed by its transcript path;
   *  this resolves that path from the live pane handle. */
  transcriptFile(muxHandle: string): { path: string } | null;
  /** pi's background runs, read from their status.json files (readPiSubagentRuns). */
  piRuns(sessionPath: string): Promise<AgentRun[]>;
  /** every other harness: the runs live in the CLAUDE transcript, resolved by
   *  cwd + claude session id (the adapter's conversationRuns, the route's seam). */
  conversationRuns(cwd: string, sessionId: string | null): Promise<{
    logExists: boolean;
    runs: AgentRun[];
  }>;
  /** the claude transcript path for the byte-size short-circuit, or null. A
   *  claude subagent starting or ending is a transcript write, so an unchanged
   *  size means an unchanged count and no re-parse. */
  claudeTranscriptPath(cwd: string, sessionId: string): string | null;
  broadcastSessions(): void;
  /* THE TIME SEAM, exactly as context-cache: absent in production (the global
   * setInterval), a manualClock() in a seam test that buys the poll tick with
   * one advance(). */
  clock?: Clock;
};

/** The running-subagent count, keyed by session id. `size` is the claude
 *  transcript byte length at the last read (absent for pi), for the
 *  short-circuit. */
const countByKey = new Map<string, { count: number; size?: number }>();

let deps: SubagentCountDeps | null = null;
let poll: unknown = null;
let clock: Clock = realClock;

export function initSubagentCount(d: SubagentCountDeps, pollMs = SUBAGENT_POLL_MS): void {
  deps = d;
  if (poll) clock.clearInterval(poll);
  clock = d.clock ?? realClock;
  poll = clock.setInterval(() => void pollOnce(), pollMs);
  (poll as { unref?: () => void }).unref?.();
}

export function stopSubagentCount(): void {
  if (poll) clock.clearInterval(poll);
  poll = null;
}

/** TEST ONLY: stop the poll, empty the cache and forget the deps, so a second
 *  in-process wiring starts cold. No-op in production, which never re-wires. */
export function resetForTest(): void {
  stopSubagentCount();
  countByKey.clear();
  deps = null;
  clock = realClock;
}

/** How many of a set of runs are still going: the bar's own running test. */
export function runningCount(runs: readonly AgentRun[]): number {
  let n = 0;
  for (const r of runs) if (r.endedTs === null) n++;
  return n;
}

/** This session's running-subagent count, 0 when none or not yet read. Read by
 *  the sessions frame; the app draws a chip only while it is above 0. */
export function subagentsRunningOf(id: string): number {
  return countByKey.get(id)?.count ?? 0;
}

/** Recompute one session's running count. Returns whether it changed. */
export async function refreshSubagentCount(s: SubagentCountSession): Promise<boolean> {
  if (!deps) return false;
  const key = s.id;
  if (s.agent.id === "pi") {
    // pi's runs live in its own status.json dir, not the session transcript, so
    // there is no transcript-size short-circuit to lean on: read the dir.
    const located = deps.transcriptFile(s.muxHandle);
    const runs = located ? await deps.piRuns(located.path) : [];
    return store(key, runningCount(runs));
  }
  // claude and every other harness: the runs (Task tool-uses) live in the
  // claude transcript. A non-claude harness passes a null id and reads back
  // no runs, the same no-file answer the route gives it.
  const csid = s.agent.id === "claude" ? s.harnessSessionId : null;
  if (!csid) return store(key, 0);
  const path = deps.claudeTranscriptPath(s.cwd, csid);
  if (!path) return store(key, 0);
  const size = Bun.file(path).size; // 0 when the file is not there yet
  const had = countByKey.get(key);
  // No new transcript means no new run and no run closed: the count is fixed
  // until a write moves it, and a Task start or end is a write.
  if (had && had.size === size) return false;
  const r = await deps.conversationRuns(s.cwd, csid);
  return store(key, r.logExists ? runningCount(r.runs) : 0, size);
}

/** Set a session's count, keeping the size for the short-circuit; report change. */
function store(key: string, count: number, size?: number): boolean {
  const had = countByKey.get(key);
  countByKey.set(key, size === undefined ? { count } : { count, size });
  return !had || had.count !== count;
}

/** One poll pass over the live sessions; exported so a test drives it without
 *  waiting on the interval. */
export async function pollOnce(): Promise<void> {
  if (!deps) return;
  const live = new Set<string>();
  const jobs: Array<Promise<boolean>> = [];
  for (const s of deps.sessions()) {
    if (!s.alive) continue;
    live.add(s.id);
    jobs.push(refreshSubagentCount(s).catch((e) => {
      console.error(`[subagents] ${s.id}:`, e);
      return false;
    }));
  }
  // a session that went away: its count must not linger on the next frame
  let dropped = false;
  for (const k of countByKey.keys()) {
    if (!live.has(k)) {
      // a nonzero count going away IS a change the frame must carry
      if ((countByKey.get(k)?.count ?? 0) > 0) dropped = true;
      countByKey.delete(k);
    }
  }
  if (jobs.length) {
    const changed = await Promise.all(jobs);
    if (dropped || changed.some(Boolean)) deps.broadcastSessions();
  } else if (dropped) {
    deps.broadcastSessions();
  }
}
