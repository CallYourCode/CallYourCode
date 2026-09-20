/* THE BACKFILL: regenerate an old conversation's session markers from its
 * stored transcript(s).
 *
 * A conversation opened before the ingest existed has a chat log with no
 * `t:"s"` session records: the ingest (ingest.ts) only ever ran for an alive,
 * mux-owned session, and nothing re-derives the overlay events when an old,
 * dead conversation is opened -- the records ride the pages (attach.ts), and
 * the serve path holds no on-demand transcript read. So an old conversation
 * shows none of the session markers a new one does (prompt/reply/tool/compact,
 * the whole overlay). Its transcript is still on disk, though, so the markers
 * can be regenerated: read each transcript FORWARD, turn every line into the
 * same record the live ingest would have (recOf in ingest.ts, over the same
 * session-events.ts extractor), and append it through logSession.
 *
 * IDEMPOTENT twice over, exactly as design A.2 asks:
 *   - a conversation whose log ALREADY holds records is skipped whole, and
 *   - logSession itself drops any record whose src key (`h|sid|rid`) it has
 *     already logged, so even a partial re-run adds only the genuinely new.
 * A backfilled record gets a fresh stable id (mintSessionRecId, in logSession)
 * and a seq PAST the last message -- storage order is high, display order (ts)
 * is old -- so no existing row is renumbered or twinned (feat-dup-rows).
 *
 *   bun test agent-engine/src/chat/backfill.test.ts
 */

import { logSession, type ChatSession, type SessionRecInput } from "./chatlog.ts";
import type { SessionRec } from "./sessionrec.ts";
import { tailEventOf } from "../sessions/session-events.ts";

/** One transcript to read for a conversation's backfill: the harness that
 *  wrote it (the record's src `h`, "claude" for a claude transcript), the
 *  harness session id it is keyed by (`sid`), and the file on disk. */
export type BackfillSource = { harness: string; sid: string; path: string };

export type BackfillDeps = {
  /** Stream one transcript's COMPLETE lines forward, in order (the adapter's
   *  streamTranscriptLines). A missing file is a no-op. */
  streamLines(path: string, onLine: (line: string) => void): Promise<void>;
  log?(event: string, fields: Record<string, unknown>): void;
};

const enc = new TextEncoder();

/** One transcript line -> the record input the live ingest would have logged,
 *  or null for the lines the overlay drops (thinking, tool_results, the app's
 *  own traffic, ...). Mirrors ingest.ts recOf over tailEventOf: same kind,
 *  same text, same input attribution, and the same src identity key
 *  {h, sid, rid} so a backfilled record and a live-ingested one dedupe as one.
 *  `off` is informational (sessionrec.ts): only the key is trusted. */
export function recInputFromLine(
  harness: string, sid: string, line: string, off: number,
): SessionRecInput | null {
  const ev = tailEventOf(line, off);
  if (!ev) return null;
  return {
    ts: ev.ts,
    kind: ev.kind,
    text: ev.text,
    ...(ev.tool ? { tool: { name: ev.tool } } : {}),
    ...(ev.source ? { source: ev.source } : {}),
    ...(ev.sender ? { sender: ev.sender } : {}),
    src: { h: harness, sid, rid: ev.uuid, off: ev.off ?? off },
  };
}

/** Regenerate one conversation's session records from its stored transcript(s).
 *  Sources are read OLDEST FIRST (a predecessor transcript before the current
 *  one) so storage order follows chronology; display order rides each record's
 *  ts regardless. Returns how many records were newly appended, or a skip
 *  reason when the log already carries records. */
export async function backfillConversation(
  s: ChatSession,
  sources: readonly BackfillSource[],
  deps: BackfillDeps,
): Promise<{ added: number; skipped?: string }> {
  if (s.log && s.log.length) return { added: 0, skipped: "has-records" };
  let added = 0;
  let scanned = 0;
  for (const src of sources) {
    let off = 0;
    await deps.streamLines(src.path, (line) => {
      const at = off;
      off += enc.encode(line).length + 1; // the newline the reader stripped
      scanned++;
      const input = recInputFromLine(src.harness, src.sid, line, at);
      if (input && logSession(s, input)) added++;
    });
  }
  deps.log?.("backfill.done", { session: s.id, sources: sources.length, scanned, added });
  return { added };
}

/** What locating a conversation's transcripts needs of a meta. */
export type MetaLike = {
  agentId: string;
  harness?: string;
  cwd?: string;
  sessionId: string | null;
  pastSessions?: string[];
  lineage?: string[];
};

export type ResolveDeps = {
  /** the claude-shaped absolute path for a cwd + harness session id, or null
   *  (adapter.transcriptPathFor / session-events sessionFilePath) */
  pathFor(cwd: string, sid: string): string | null;
  /** locate a transcript by its session id when the cwd is unknown (an old
   *  meta carries no cwd): a scan of the projects dir, or null */
  findBySid?(sid: string): string | null;
  /** whether a resolved path exists on disk */
  exists(path: string): boolean;
};

/** The transcripts to read for one conversation's backfill, oldest first: its
 *  predecessors (pastSessions, then content-proved lineage) and finally the
 *  current session id. Each id is resolved to a path by cwd when the meta has
 *  one, else by a session-id scan; only paths that exist are returned, and no
 *  id is read twice. */
export function resolveBackfillSources(meta: MetaLike, deps: ResolveDeps): BackfillSource[] {
  const harness = meta.harness ?? "claude";
  const ids: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const id of meta.pastSessions ?? []) add(id);
  for (const id of meta.lineage ?? []) add(id);
  add(meta.sessionId);
  const out: BackfillSource[] = [];
  for (const sid of ids) {
    let path = meta.cwd ? deps.pathFor(meta.cwd, sid) : null;
    if ((!path || !deps.exists(path)) && deps.findBySid) path = deps.findBySid(sid);
    if (path && deps.exists(path)) out.push({ harness, sid, path });
  }
  return out;
}

/* --------------------------------------------------------------- the sweep */

/** One conversation the sweep may backfill: an agent whose persisted chat log
 *  has messages but NO session records. `chat` is the restored message array
 *  (already seq-stamped at boot), so a backfilled record's seq continues its
 *  shared axis. */
export type SweepCandidate = { id: string; meta: MetaLike; chat: ChatSession["chat"] };

export type SweepDeps = BackfillDeps & {
  /** the agents with messages but no records on disk, newest activity first */
  candidates(): SweepCandidate[];
  /** locate one conversation's transcripts */
  resolve(meta: MetaLike): BackfillSource[];
  /** hand the backfilled records to the restore cache so the dead row (and any
   *  later revival) serves them without a restart (session-state restoredLogs) */
  rememberLog(id: string, log: SessionRec[]): void;
};

/* A YIELD BETWEEN CONVERSATIONS so a backlog of old conversations never holds
 * the event loop; the per-transcript read (streamLinesForward) already yields
 * inside a large file. Nothing waits on this: the records land in the log and
 * on disk, and the next open (or a live push) paints them. */
export async function runBackfillSweep(deps: SweepDeps): Promise<{ agents: number; added: number }> {
  const cands = deps.candidates();
  let agents = 0;
  let total = 0;
  for (const c of cands) {
    const sources = deps.resolve(c.meta);
    if (!sources.length) continue;
    const s: ChatSession = { id: c.id, chat: c.chat, log: [] };
    const { added } = await backfillConversation(s, sources, deps);
    if (added > 0 && s.log && s.log.length) {
      deps.rememberLog(c.id, s.log);
      agents++;
      total += added;
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  deps.log?.("backfill.sweep.done", { candidates: cands.length, agents, added: total });
  return { agents, added: total };
}
