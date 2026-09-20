/* agents/<agentId>/meta.json: the per-agent record (the design).
 *
 * Everything `.run` kept in per-session side files (names.json, voices.json,
 * photos.json, session-settings.json, heard.json, schedules-seeded.json,
 * session-lineage.json, agent-ids.json) folds into ONE small JSON per agent,
 * keyed on disk by the STABLE agentId. The agent is the identity; the harness
 * session id it currently answers to is an attribute (`sessionId`), and every
 * id it ever answered to stays in `pastSessions` so a `--resume` of any of
 * them finds this agent through the boot-built session index
 * (session-state.ts sessionIndex). The in-memory model is keyed by agentId
 * too; nothing re-keys when the harness rolls its session.
 *
 * v2 (additive to v1): `harness`, `cwd`, a nullable `sessionId` (an agent
 * whose pane has not announced yet has none), and the rule that `sessionId`
 * and `pastSessions` hold HARNESS-shaped ids only. v1 metas let mux pane ids
 * ("w7:p1", "%3") leak into both through the old boot carry; the one-time
 * migration in loadAgentMetas strips them and writes the record back once.
 *
 * Atomic rewrite (tmp + rename, 0600): meta.json is a small record, not a
 * chat file, so rewriting it whole is the right shape; the append-only rule
 * is about conversation logs.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { agentDir, agentsDir, safeAgentId } from "../storage/datadir.ts";
import { mkdirPrivate, writeAtomicPrivate } from "../../../shared/runfiles.ts";
import { isHarnessSessionId } from "./ids.ts";

export type AgentRead = {
  heardTs: number;
  doneSeq: number;
  seenDoneSeq: number;
  notified?: boolean;
  filedTs?: number;
};

export type AgentMeta = {
  v: 2;
  agentId: string;
  /** which coding agent this record belongs to ("claude", "codex", ...), from
   *  the first sighting; absent on a record older than the field */
  harness?: string;
  /** the folder the harness ran in when first seen: the anchor, never a key */
  cwd?: string;
  /** the harness session id this agent currently answers to, or null while
   *  its pane has not announced one (a provisional agent is never written
   *  with null: it is persisted only once it has an id or a chat) */
  sessionId: string | null;
  /** every prior harness session id, oldest first; an id is pushed once */
  pastSessions?: string[];
  /** the chat files this agent has, oldest first */
  chats?: { id: string; createdAt: number }[];
  /** the CURRENT chat file's id */
  chat?: string;
  name?: string;
  voice?: string;
  photo?: { file: string; mime: string; ts: number };
  settings?: { muted?: boolean; notify?: boolean };
  read?: AgentRead;
  seeded?: boolean;
  /** content-proved predecessors of the current session (lineage.ts) */
  lineage?: string[];
  /** set when this agent's conversation was absorbed into another's */
  mergedInto?: string;
  /** the transcript ingest pointers, one per harness session id this agent
   *  has read (chat/ingest.ts): where the next read resumes */
  tails?: Record<string, TailPointer>;
};

/** Where the ingest of one transcript stands (design A.2, A.4). `off` is
 *  the byte offset the live tail resumes from (just past the last complete
 *  line it appended); `rid`/`ts` name the last record it took. `bf` is the
 *  initial backfill still in progress: bytes [0, at) are done, the job ends
 *  at `to` (the offset the live tail started from); absent once complete. */
export type TailPointer = {
  h: string;
  off: number;
  rid?: string;
  ts?: number;
  bf?: { at: number; to: number };
};

/* THE THREE ID FIELDS a record may carry, gated together: each is either
 * absent, or (for sessionId) null, or harness-shaped throughout. */
const ID_FIELDS = ["sessionId", "pastSessions", "lineage"] as const;
type IdField = (typeof ID_FIELDS)[number];

/** The ids in one field that are NOT harness-shaped, [] when the field is
 *  well formed; null when the field is not even the right type (sessionId
 *  must be present, null or a non-empty string; the arrays may be absent). */
function badIdsIn(j: Record<string, unknown>, f: IdField): string[] | null {
  const v = j[f];
  if (f === "sessionId") {
    if (v === null) return [];
    if (typeof v !== "string" || !v) return null;
    return isHarnessSessionId(v) ? [] : [v];
  }
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  return v.filter((id) => !isHarnessSessionId(id)).map(String);
}

/** Parse a record as this build writes it (v2). Anything else is not ours:
 *  a wrong version, a bad agent id, a wrong-typed field, or a pane-shaped id
 *  (or any non-harness id) anywhere in sessionId, pastSessions or lineage.
 *  loadAgentMetas cleans such a record through migrateAgentMeta rather than
 *  refusing it; this parser is the strict reading. */
export function parseAgentMeta(raw: unknown): AgentMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  if (j.v !== 2) return null;
  if (typeof j.agentId !== "string" || !safeAgentId(j.agentId)) return null;
  for (const f of ID_FIELDS) {
    const bad = badIdsIn(j, f);
    if (bad === null || bad.length) return null;
  }
  // taken as written past the identity checks: the engine wrote it, and a field
  // this build does not know is carried by the spread on save rather than eaten
  return j as unknown as AgentMeta;
}

export type Migration = {
  meta: AgentMeta;
  /** what the migration changed, one line per field, empty when nothing did */
  changes: string[];
};

/** A v1 record lifted to v2 in memory, or a v2 record with a leaked pane id
 *  cleaned. v1's `sessionId` was "the harness key this agent currently
 *  answers to (pane id, or claude uuid)", and the boot carry pushed pane ids
 *  into `pastSessions` and `lineage` as well; v2 keeps harness ids only. A
 *  non-harness current id becomes null (the pane it named is long gone; the
 *  next announce fills it), non-harness ids leave `pastSessions` and
 *  `lineage` (lineage otherwise as written: it is an ordered chain), the
 *  reserved `keys` field (never written, verified by grep 2026-09-02) is
 *  dropped, and duplicates in `pastSessions` collapse to their first
 *  occurrence. A v2 record that parseAgentMeta refuses only for
 *  its ids (the lineage leak, defect C) gets the same cleaning, so the one
 *  write-back in loadAgentMetas leaves it strict. Returns null for a record
 *  that is neither v1 nor v2, or has a bad identity or a wrong-typed field. */
export function migrateAgentMeta(raw: unknown): Migration | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  if (j.v === 2) {
    const meta = parseAgentMeta(j);
    if (meta) return { meta, changes: [] };
  } else if (j.v !== 1) return null;
  if (typeof j.agentId !== "string" || !safeAgentId(j.agentId)) return null;
  if (j.v === 1 && (typeof j.sessionId !== "string" || !j.sessionId)) return null;
  for (const f of ID_FIELDS) if (badIdsIn(j, f) === null) return null;
  const changes: string[] = j.v === 1 ? ["v: 1 -> 2"] : [];
  const { keys, ...rest } = j;
  if (keys !== undefined) changes.push("keys: dropped");
  let sessionId = j.sessionId as string | null;
  if (sessionId !== null && !isHarnessSessionId(sessionId)) {
    changes.push(`sessionId: ${JSON.stringify(sessionId)} -> null (not a harness id)`);
    sessionId = null;
  }
  const out = { ...rest, v: 2, sessionId } as Record<string, unknown>;
  for (const f of ["pastSessions", "lineage"] as const) {
    if (!Array.isArray(j[f])) continue;
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const id of j[f] as unknown[]) {
      if (!isHarnessSessionId(id)) { dropped.push(String(id)); continue; }
      if (f === "pastSessions" && (kept.includes(id) || id === sessionId)) { dropped.push(id); continue; }
      kept.push(id);
    }
    if (dropped.length) changes.push(`${f}: dropped ${dropped.join(", ")}`);
    if (kept.length) out[f] = kept;
    else delete out[f];
  }
  return { meta: out as unknown as AgentMeta, changes };
}

/** Scan agents/ and read every meta. Unreadable metas are reported, not fatal:
 *  one corrupt agent must not take the fleet down at boot. A v1 record is
 *  migrated in memory AND written back once (atomic), with `onMigrated` told
 *  what changed, so the second boot reads v2 and logs nothing. */
export async function loadAgentMetas(
  onBad: (agentId: string, why: string) => void = () => {},
  onMigrated: (agentId: string, changes: string[]) => void = () => {},
): Promise<Map<string, AgentMeta>> {
  const out = new Map<string, AgentMeta>();
  const root = agentsDir(); // one root for the whole pass, resolved before any await
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return out; // fresh engine: no agents yet
  }
  for (const name of names) {
    if (!safeAgentId(name)) continue; // not ours: leave anything we did not mint alone
    try {
      const dir = join(root, name);
      const f = Bun.file(join(dir, "meta.json"));
      if (!(await f.exists())) { onBad(name, "no meta.json"); continue; }
      const mig = migrateAgentMeta(await f.json());
      if (!mig) { onBad(name, "meta.json is not a v1 or v2 agent record"); continue; }
      if (mig.meta.agentId !== name) { onBad(name, `meta names ${mig.meta.agentId}`); continue; }
      if (mig.changes.length) {
        await saveAgentMetaIn(dir, mig.meta);
        onMigrated(name, mig.changes);
      }
      out.set(name, mig.meta);
    } catch (e) {
      onBad(name, String(e));
    }
  }
  return out;
}

/** Atomic write of one agent's meta (0600, tmp + rename). Makes the dir.
 *
 *  BOTH PATHS ARE RESOLVED BEFORE THE FIRST AWAIT. dataDir() reads
 *  CYC_DATA_DIR per call, so a write that resolved the dir, awaited, and then
 *  resolved the file put meta.json under whatever root the env named by
 *  then: the seam rig swaps the env at stop(), and that is how records
 *  reached a real ~/.callyourcode (defect A, 2026-09-02). */
export async function saveAgentMeta(meta: AgentMeta): Promise<void> {
  await saveAgentMetaIn(agentDir(meta.agentId), meta);
}
async function saveAgentMetaIn(dir: string, meta: AgentMeta): Promise<void> {
  const file = join(dir, "meta.json");
  await mkdirPrivate(dir);
  await writeAtomicPrivate(file, JSON.stringify(meta, null, 2) + "\n");
}

/* `ag-` plus 16 base64url chars (12 random bytes). Never the pane id, never
 * the harness uuid: those are the two ids this field exists to outlive.
 * (Moved verbatim from server.ts so the migration script mints identically.) */
export function mintAgentId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const tok = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
  return `ag-${tok}`;
}
