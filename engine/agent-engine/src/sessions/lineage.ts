/* SESSION LINEAGE (L3 feature): the transcripts BEFORE this one.
 *
 * A conversation outlives the Claude session that happens to be serving it,
 * and Claude Code records no link between the two transcripts. The link is
 * PROVEN FROM CONTENT rather than guessed from timestamps: the chat log holds
 * the exact words of messages from the gap, and the transcript that served
 * them contains those same words (measured: the right file matched 35 of 40
 * probes and every other file matched none). The answer is cached in each
 * agent's meta.json because finding it reads every transcript in the project.
 */

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { ChatMsg } from "../chat/chatmsg.ts";

// A probe is a message distinctive enough that finding it in a transcript
// means that transcript served this conversation. Long ones only: "ok"
// proves nothing.
const PROBE_MIN_CHARS = 45;
const PROBE_COUNT = 40;
const PROBE_HIT_RATIO = 0.25; // 10 of 40. The real file scored 35; the others 0.

export type LineageSession = {
  /** the agent id */
  id: string;
  /** the session's own transcript id (claude's jsonl uuid): the one file the
   *  sibling walk skips. Carried on the single harnessSessionId now;
   *  lineage is a claude-transcript feature, so this is claude's id. */
  harnessSessionId: string | null;
  chat: ChatMsg[];
};

export type LineageDeps = {
  scheduleAgentSave(agentId: string): void;
  log(event: string, fields: Record<string, unknown>): void;
  /** Stream one sibling transcript's jsonl lines forward (adapter's
   *  streamTranscriptLines). A missing file is a no-op, so the sibling walk
   *  drops its own Bun.file exists/size pre-check into this contract. */
  streamLines(path: string, onLine: (line: string) => void): Promise<void>;
};

/* agentId -> proven predecessor harness session ids. Restored from the agent
 * metas at boot (initLineage), persisted back through the meta save, and fed
 * into the session index so a predecessor id resolves to this agent. */
const lineage: { [agentId: string]: string[] } = {};
const lineageLookups = new Set<string>(); // in flight, so an attach storm reads once
let deps: LineageDeps = { scheduleAgentSave: () => {}, log: () => {}, streamLines: async () => {} };

export function initLineage(d: LineageDeps, restored: Iterable<[string, string[]]>): void {
  deps = d;
  for (const [id, prevs] of restored) if (prevs.length) lineage[id] = [...prevs];
}

/** TEST ONLY: forget every cached lineage and the deps, so a second in-process
 *  wiring restores lineage from ITS metas rather than inheriting a predecessor
 *  chain that belongs to another test's sessions (initLineage MERGES into this
 *  object, so leftovers would survive a re-init). No-op in production, which
 *  never re-wires. */
export function resetForTest(): void {
  for (const k of Object.keys(lineage)) delete lineage[k];
  lineageLookups.clear();
  deps = { scheduleAgentSave: () => {}, log: () => {}, streamLines: async () => {} };
}

/** The cached answer for one agent (for the meta save), or undefined. */
export function lineageOf(agentId: string): string[] | undefined {
  return lineage[agentId];
}

/** An EXPLICIT predecessor the harness itself named (a claude fork's parent,
 *  codex `forked_from_id`, pi `previousSessionFile`): recorded without a
 *  content proof, because the harness said so. Idempotent; scheduled to the
 *  agent's meta. */
export function addLineage(agentId: string, fromSessionId: string): void {
  const cur = lineage[agentId] ?? [];
  if (cur.includes(fromSessionId)) return;
  lineage[agentId] = [...cur, fromSessionId];
  deps.scheduleAgentSave(agentId);
}

export async function predecessorsOf(s: LineageSession, ownPath: string, ownEarliest: number): Promise<string[]> {
  const known = lineage[s.id];
  if (known) return known;
  if (lineageLookups.has(s.id)) return [];
  lineageLookups.add(s.id);
  try {
    /* SCOPE NOTE: ownPath is resolved through the adapter by the
     * caller. The sibling walk below reads OTHER transcripts' raw jsonl to
     * prove lineage from content: a cross-transcript search no adapter verb
     * exists for yet. */
    if (!ownPath) return [];
    const dir = ownPath.slice(0, ownPath.lastIndexOf("/"));
    const probes = s.chat
      .filter((c) => c.ts < ownEarliest && (c.text ?? "").length > PROBE_MIN_CHARS)
      .map((c) => (c.text ?? "").slice(0, 60));
    if (probes.length < 4) { lineage[s.id] = []; return []; }
    // spread the sample over the whole gap, so a file serving only part of it still scores
    const step = Math.max(1, Math.floor(probes.length / PROBE_COUNT));
    const sample = probes.filter((_, i) => i % step === 0).slice(0, PROBE_COUNT);
    const need = Math.max(2, Math.ceil(sample.length * PROBE_HIT_RATIO));
    const found: string[] = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".jsonl") || name === `${s.harnessSessionId}.jsonl`) continue;
      const path = join(dir, name);
      /* STREAMED, NOT READ WHOLE (the robustness ruling): scanning line by
       * line in bounded blocks that yield finds the same hits without ever
       * holding the whole file, and stops early once enough match. The adapter
       * owns the jsonl read (missing file: no-op); the walk owns the readdir. */
      const seen = new Set<number>();
      await deps.streamLines(path, (line) => {
        if (seen.size >= need) return; // enough already; keep draining cheaply
        for (let i = 0; i < sample.length; i++) if (!seen.has(i) && line.includes(sample[i])) seen.add(i);
      });
      if (seen.size >= need) found.push(name.replace(/\.jsonl$/, ""));
    }
    lineage[s.id] = found;
    deps.scheduleAgentSave(s.id);
    deps.log("events.lineage", { session: s.id, predecessors: found, probes: sample.length });
    return found;
  } catch (e) {
    deps.log("events.lineage.failed", { session: s.id, err: String(e) });
    return [];
  } finally {
    lineageLookups.delete(s.id);
  }
}
