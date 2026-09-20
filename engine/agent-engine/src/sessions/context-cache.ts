/* CONTEXT FULLNESS, MODEL AND CLAUDE-TITLE CACHES (L2 domain).
 *
 * Read out of the session transcript (session-events.ts explains why not the
 * pane) and cached per (sessionId, claude jsonl id) so the poll costs one
 * stat() per session when nothing has been written. KEYED ON THE SESSION
 * FILE, not the pane: /resume rotates the file, and a pane-keyed answer would
 * carry the OLD conversation's fullness into a new one that starts near
 * empty. Sessions and the adapter are injected at boot (initContextCache);
 * the 8s poll starts there and reports through broadcastSessions.
 *
 *   bun test agent-engine/src/sessions/context-cache.test.ts
 */

import { realClock, type Clock } from "../runtime/clock.ts";

export const CONTEXT_POLL_MS = 8000;

/** The slice of a Session this module reads (structural; no cycle). */
export type CtxSession = {
  id: string;
  /* THE ONE session-id field. The claude jsonl id this
   * module keys and reads by is DERIVED from it and the agent kind
   * (claudeSidOf): claude's own id, null for every other harness, exactly the
   * value the retired claudeSessionId field held. */
  harnessSessionId: string | null;
  agent: { id: string };
  hasTranscript: boolean;
  cwd: string;
  muxHandle: string;
  alive: boolean;
};

/** The claude jsonl session id for a row, or null. claude carries it on the one
 *  harnessSessionId; every other harness reads its transcript by handle, so its
 *  claude id is null and the reads below take the by-handle leg. */
const claudeSidOf = (s: CtxSession): string | null =>
  s.agent.id === "claude" ? s.harnessSessionId : null;

type CtxDeps = {
  sessions(): Iterable<CtxSession>;
  transcriptFile(muxHandle: string): { path: string } | null;
  contextRead(muxHandle: string): Promise<{ pct: number | null; model: string | null } | null>;
  /* THE CLAUDE READER SEAM. Instead of value-importing session-events.ts,
   * this module reaches claude's transcript path, its context/model reading and
   * its title through the adapter's verbs. The path is still needed here (not
   * folded into the reads) for the stat short-circuit: the size compare that
   * skips a read when nothing was written. */
  claudeTranscriptPath(cwd: string, csid: string): string | null;
  claudeContextRead(cwd: string, csid: string): Promise<{
    pct: number | null; modelId: string | null;
    modelName: string | null; modelAcronym: string | null;
  } | null>;
  claudeTitleRead(cwd: string, csid: string): Promise<string | null>;
  broadcastSessions(): void;
  /* THE TIME SEAM. Absent in production, which is the global setInterval, so
   * an engine's 8s poll is exactly what it was. A seam test passes a
   * manualClock() and buys the poll tick with one advance() rather than eight
   * seconds of wall time. This module reads no `now` of its own -- its
   * freshness test is the transcript's byte size, not a timestamp -- so the
   * clock here is the timer and nothing else. */
  clock?: Clock;
};

const contextByKey = new Map<string, { size: number; pct: number | null; modelId: string | null; modelName?: string | null; modelAcronym?: string | null }>();
const claudeTitleByKey = new Map<string, { size: number; title: string | null }>();

let deps: CtxDeps | null = null;
let poll: unknown = null;
/* The clock this module's poll is armed on. realClock until a deps bag says
 * otherwise, so production is unchanged. */
let clock: Clock = realClock;

export function initContextCache(d: CtxDeps, pollMs = CONTEXT_POLL_MS): void {
  deps = d;
  if (poll) clock.clearInterval(poll);
  clock = d.clock ?? realClock;
  poll = clock.setInterval(() => void pollOnce(), pollMs);
  (poll as { unref?: () => void }).unref?.();
}

export function stopContextCache(): void {
  if (poll) clock.clearInterval(poll);
  poll = null;
}

/** TEST ONLY: stop the poll, empty both caches and forget the deps and the
 *  clock, so a second in-process wiring starts cold instead of answering a
 *  fullness number the previous wiring measured. No-op in production, which
 *  never re-wires. */
export function resetForTest(): void {
  stopContextCache();
  contextByKey.clear();
  claudeTitleByKey.clear();
  deps = null;
  clock = realClock;
}

const contextKey = (s: CtxSession) => `${s.id}|${claudeSidOf(s)}`;

export function contextPctOf(s: CtxSession): number | null {
  if (!claudeSidOf(s) && !s.hasTranscript) return null;
  return contextByKey.get(contextKey(s))?.pct ?? null;
}

/** The cached raw entry for a session, for readers (the model plugin) that
 *  need the raw id rather than a display name. */
export function contextEntryOf(s: CtxSession): { pct: number | null; modelId: string | null; modelName?: string | null } | null {
  return contextByKey.get(contextKey(s)) ?? null;
}

/** Drop a session's cached entries (the rekey path: the old key's fullness
 *  describes the PRE-roll transcript, which no longer exists). */
export function evictContextFor(s: CtxSession): void {
  const key = contextKey(s);
  contextByKey.delete(key);
  claudeTitleByKey.delete(key);
}

/* WHICH MODEL THIS SESSION IS ON, as its display name, or null. Read off the
 * SAME poll as contextPct (one backward scan of the transcript per session).
 * Null until the file has an assistant turn, and after a compaction until the
 * next one. */
export function modelOf(s: CtxSession): string | null {
  const cached = contextByKey.get(contextKey(s));
  if (claudeSidOf(s)) {
    // The display name the adapter's read already mapped from the raw id at
    // refresh time (same pure mapping of the same id: identical answers).
    return cached?.modelName ?? null;
  }
  if (!s.hasTranscript) return null;
  return cached?.modelName ?? null;
}

/* The short status-line acronym ("O4.8"), derived from the SAME cached raw id
 * modelOf reads its long name from, so the top bar's model row and the model
 * badge are one fact in two spellings. */
export function modelAcronymOf(s: CtxSession): string | null {
  if (!claudeSidOf(s)) return null;
  // The acronym the adapter's read mapped from the same raw id modelOf's name
  // came from, stored at refresh time so the two spellings never drift.
  return contextByKey.get(contextKey(s))?.modelAcronym ?? null;
}

function statPathOf(path: string): string {
  const hash = path.indexOf("#");
  return hash > 0 ? path.slice(0, hash) : path;
}

/** Recompute one session's fullness AND model. Returns whether either changed. */
export async function refreshContext(s: CtxSession): Promise<boolean> {
  if (!deps) return false;
  const csid = claudeSidOf(s);
  if (csid) {
    const path = deps.claudeTranscriptPath(s.cwd, csid);
    if (!path) return false;
    const key = contextKey(s);
    const size = Bun.file(path).size; // 0 when the file is not there yet
    const had = contextByKey.get(key);
    // No new transcript means no new answer: neither the number nor the model
    // moves until a turn does, and a turn is a write.
    if (had && had.size === size) return false;
    // ONE reading through the adapter carries the whole answer already mapped:
    // pct, the raw id, and both model spellings. Stored so modelOf /
    // modelAcronymOf read strings instead of re-mapping the id at read time.
    const read = await deps.claudeContextRead(s.cwd, csid);
    const pct = read?.pct ?? null;
    const modelId = read?.modelId ?? null;
    contextByKey.set(key, { size, pct, modelId,
      modelName: read?.modelName ?? null, modelAcronym: read?.modelAcronym ?? null });
    return !had || had.pct !== pct || had.modelId !== modelId;
  }
  const located = deps.transcriptFile(s.muxHandle);
  if (!located) return false;
  const key = contextKey(s);
  const size = Bun.file(statPathOf(located.path)).size;
  const had = contextByKey.get(key);
  if (had && had.size === size) return false;
  const read = await deps.contextRead(s.muxHandle);
  if (!read) return false;
  contextByKey.set(key, { size, pct: read.pct, modelId: null, modelName: read.model });
  return !had || had.pct !== read.pct || had.modelName !== read.model;
}

/* Claude Code's own title: the second source for a session's one title
 * (title.ts), read out of the SAME file the context poll already stats,
 * cached and keyed identically. Null until Claude has titled it. */
export function claudeTitleOf(s: CtxSession): string | null {
  if (!claudeSidOf(s)) return null;
  return claudeTitleByKey.get(contextKey(s))?.title ?? null;
}

/** Recompute one session's Claude title. Returns whether the answer changed. */
export async function refreshClaudeTitle(s: CtxSession): Promise<boolean> {
  if (!deps) return false;
  const csid = claudeSidOf(s);
  const path = csid ? deps.claudeTranscriptPath(s.cwd, csid) : null;
  if (!path) return false;
  const key = contextKey(s);
  const size = Bun.file(path).size; // 0 when the file is not there yet
  const had = claudeTitleByKey.get(key);
  // No new transcript means no new title: ai-title only moves when a turn does.
  if (had && had.size === size) return false;
  const title = size ? await deps.claudeTitleRead(s.cwd, csid!) : null;
  claudeTitleByKey.set(key, { size, title });
  return !had || had.title !== title;
}

/** One poll pass over the live sessions; exported so a test drives it without
 *  waiting on the interval. */
export async function pollOnce(): Promise<void> {
  if (!deps) return;
  const live = new Set<string>();
  const jobs: Array<Promise<boolean>> = [];
  for (const s of deps.sessions()) {
    if (!s.alive) continue;
    if (!claudeSidOf(s) && !s.hasTranscript) continue;
    live.add(contextKey(s));
    jobs.push(refreshContext(s).catch((e) => {
      console.error(`[context] ${s.id}:`, e);
      return false;
    }));
    if (claudeSidOf(s)) {
      jobs.push(refreshClaudeTitle(s).catch((e) => {
        console.error(`[title] ${s.id}:`, e);
        return false;
      }));
    }
  }
  // a pane that went away, or a session file that rotated under one
  for (const k of contextByKey.keys()) if (!live.has(k)) contextByKey.delete(k);
  for (const k of claudeTitleByKey.keys()) if (!live.has(k)) claudeTitleByKey.delete(k);
  if (jobs.length) {
    const changed = await Promise.all(jobs);
    if (changed.some(Boolean)) deps.broadcastSessions();
  }
}
