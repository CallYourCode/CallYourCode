// The claude HarnessReader: a thin wrapper over the session-events.ts jsonl
// reader and blocked.ts's screen parser (S1). It re-exports the session-events
// functions so `readers/claude.ts` is one import point, while the old
// `session-events.ts` paths keep working unchanged. Nothing here changes a byte
// of output: locate/edge/model/messages are the exact TranscriptSupport methods
// CLAUDE_TRANSCRIPT already had, and parseScreen is classifyPaneBox flattened.

import { parseScreen } from "../terminal/blocked.ts";
import {
  bareModelId,
  contextPct,
  contextWindowFor,
  eventFromRecord,
  modelAcronym,
  modelDisplayName,
  modelIdOf,
  modelName,
  readAgentRuns,
  readContextUsage,
  readEventsTail,
  readSessionTitle,
  latestClaudeSessionId,
  findTranscriptBySessionId,
  registerRunEnricher,
  sessionFilePath,
  SessionTailParser,
  streamLinesForward,
  tailEventOf,
  TurnStatusParser,
  turnEdgeFromLine,
} from "../sessions/session-events.ts";
import type { HarnessReader, TranscriptMessage } from "./types.ts";
import type { RunEnricher } from "../sessions/session-events.ts";

// The BRIEF-s1 export list, re-exported so the reader is a single seam. The
// composition root's one remaining session-events value need (registerRunEnricher,
// the piagent run-tree enricher) imports through here too, so no core module
// value-imports session-events.ts directly.
export {
  eventFromRecord,
  modelDisplayName,
  readAgentRuns,
  readContextUsage,
  readEventsTail,
  latestClaudeSessionId,
  findTranscriptBySessionId,
  registerRunEnricher,
  sessionFilePath,
  SessionTailParser,
  TurnStatusParser,
  turnEdgeFromLine,
};
export type { RunEnricher };

/* THE CONTEXT-WINDOW DOOR. The model-id -> window
 * table and the [1m]/date-pin strip are the claude adapter's IMPLEMENTATION: they
 * are DEFINED once in session-events.ts (reachable only through this reader seam
 * and the adapter) and re-exported HERE as the adapter's named door, so
 * harness-caps.ts answers the claude context read through the one copy and no
 * plugin, route or frame does model-name math to get a window. `contextPct` /
 * `modelIdOf` ride along as the claude reading primitives the caps read over. */
export {
  bareModelId,
  contextPct,
  contextWindowFor,
  modelAcronym,
  modelIdOf,
};

/** Newest claude session jsonl for a cwd. TmuxMux calls this instead of its
 *  old private linkSession (D10). locate() still needs a session id; this is
 *  the cwd-only finder. */
export function locateLatestClaude(cwd: string): { sessionId: string; path: string } | null {
  const id = latestClaudeSessionId(cwd);
  if (!id) return null;
  const path = sessionFilePath(cwd, id);
  return path ? { sessionId: id, path } : null;
}

function parseJson(line: string): any | null {
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

async function eachLine(path: string, onLine: (line: string) => void): Promise<void> {
  const f = Bun.file(path);
  if (!(await f.exists())) return;
  await streamLinesForward(f, 0, f.size, onLine);
}

export const claudeReader: HarnessReader = {
  tag: "claude",

  /* claude is the one native-context harness: model + windowed context come from
   * its own jsonl scan (adapter.contextModelRead), and it alone has /compact and
   * plan usage. */
  capabilities: { context: "native", compact: true, usage: true },

  detect(input) {
    return input.kindStamp === "claude";
  },

  locate(ref, cwd) {
    const id = (ref?.id ?? "").trim();
    if (!id) return null;
    const path = sessionFilePath(cwd, id);
    return path ? { sessionId: id, path } : null;
  },

  turnEdge: turnEdgeFromLine,

  /* The activity tail's extraction, behind the declared slot (types.ts).
   * `tailEventOf` IS the function the tail always used; declaring it here
   * changes no byte of claude's extraction, it only names the seam the
   * adapter dispatches through. */
  sessionEvents: { mode: "lines", eventOf: tailEventOf },

  async contextPct(path) {
    return contextPct(await readContextUsage(path));
  },

  async model(path) {
    /* modelName carries a /model switch's resolved display name when one is
     * newer than the usage record (an idle switch would otherwise keep naming
     * the old model); without a switch it is modelDisplayName of the usage id,
     * byte-identical to before. */
    return modelName(await readContextUsage(path));
  },

  async title(path) {
    return readSessionTitle(path);
  },

  async runs(path) {
    return readAgentRuns(path);
  },

  /* How to spawn / resume claude (was agents.ts CLAUDE.launch; the
   * launch capability lives on the reader now). Strings stay byte-identical. */
  launch: {
    command: "claude --dangerously-skip-permissions",
    resume: (sessionId: string) => `claude --dangerously-skip-permissions --resume ${sessionId}`,
  },

  async messages(path) {
    const out: TranscriptMessage[] = [];
    await eachLine(path, (line) => {
      const ev = eventFromRecord(parseJson(line));
      if (!ev) return;
      if (ev.kind === "prompt") out.push({ role: "user", text: ev.text.replace(/^> /, ""), ts: ev.ts });
      else if (ev.kind === "reply") out.push({ role: "claude", text: ev.text, ts: ev.ts });
    });
    return out;
  },

  parseScreen,
};
