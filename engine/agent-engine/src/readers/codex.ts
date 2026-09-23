// The codex HarnessReader over the existing CODEX_TRANSCRIPT (transcripts.ts).
// It is registered in the default READERS table (adapters/mux-adapter.ts),
// replacing the readerFromTranscript duplicate that stood in for it. It also
// still reads as the shape for a reader you write yourself.
//
// HONEST BY CONSTRUCTION. Every implemented method delegates to the
// fixture-proven CODEX_TRANSCRIPT. Every capability codex does not actually
// implement returns the documented empty shape and never throws: title() is
// null (no title reader), runs() is [] (AgentRun parsing is claude-only), and
// parseScreen is omitted (no dialog parser). A caller can treat absence and
// empty the same way: codex says nothing about what it has not earned.

import { CODEX_TRANSCRIPT } from "../chat/transcripts.ts";
import type { SessionEvent } from "../sessions/session-events.ts";
import type { HarnessReader } from "./types.ts";

/* ----------------------------------------------------- the activity tail
 *
 * Codex writes ONE rollout jsonl per session ($CODEX_HOME/sessions/...), and
 * every activity fact the app renders arrives as an `event_msg` record.
 * MEASURED on this machine's real rollouts (codex-cli 0.148.0, 43 files,
 * 2026-09-05): the `item_completed` payload carries a typed `item` --
 * CommandExecution (the argv it ran), FileChange (per-path diffs), McpToolCall
 * (server+tool), Extension (web.search), CollabAgentToolCall, ContextCompaction
 * -- each with a STABLE `item.id`, and `turn_aborted` marks an interrupt with
 * its `turn_id`. The raw `response_item` records (custom_tool_call,
 * function_call) describe the SAME runs a second time (measured: ctc 24-47 vs
 * CommandExecution 17-37 per file, the delta being calls that never spawned a
 * process), so this extraction reads item_completed ONLY and never both, or a
 * single command would land twice under two rids. Reasoning / AgentMessage /
 * UserMessage / SubAgentActivity items are conversation, not activity, and the
 * app dropped prompt/reply rows from the overlay: they map to null. The
 * `compacted` record type co-occurs 1:1 with a ContextCompaction item on
 * 0.148 (measured, the one compacting rollout has 2 of each), so only the item
 * is mapped; older rollouts that carry `compacted` alone would miss the row
 * (backfill-era only, named in the lane report). */

const CODEX_CMD_CAP = 80; // claude's CMD_CAP: a command line, not a wall
const CODEX_TEXT_CAP = 200; // claude's TEXT_CAP for tool/compact one-liners

/* Disable codex's on-startup CLI update check on every engine-spawned session.
 * codex checks for a newer release at TUI startup; when the update path is
 * unavailable (offline) or broken (here `codex doctor` reports the npm-prefix
 * mismatch: "update would target a different npm install"), that startup step
 * can stall/fail and gate the app's bring-up before the pane is usable.
 *
 * `check_for_update_on_startup` is the config field that governs it (present in
 * codex-cli 0.148.0's config struct; CONFIRMED accepted as a `-c` override under
 * `--strict-config`, which errors on any unknown key). Passing it on the launch
 * line (not the user's config.toml) keeps the knob engine-owned and applies to
 * every spawned + resumed session regardless of the host config. */
const CODEX_NO_UPDATE = "-c check_for_update_on_startup=false";

function cap(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** The argv codex logs is usually ["<shell>", "-c", "<the command>"]: show the
 *  command, not the wrapper. Anything else joins as written. */
function commandText(cmd: unknown): string {
  if (!Array.isArray(cmd)) return "";
  const parts = cmd.map((c) => String(c ?? ""));
  if (parts.length === 3 && parts[1] === "-c") return parts[2];
  return parts.join(" ");
}

function itemEvent(item: any, ts: number): SessionEvent | null {
  const id = typeof item?.id === "string" ? item.id : "";
  if (!id) return null;
  switch (item.type) {
    case "CommandExecution": {
      const cmd = commandText(item.command);
      return { uuid: id, ts, kind: "tool", tool: "exec",
        text: cmd ? `exec: ${cap(cmd, CODEX_CMD_CAP)}` : "exec" };
    }
    case "FileChange": {
      const changes = item.changes && typeof item.changes === "object" ? item.changes : {};
      const names = Object.keys(changes).map((p) => p.split("/").pop() || p);
      return { uuid: id, ts, kind: "tool", tool: "edit",
        text: names.length ? cap(`edit: ${names.join(", ")}`, CODEX_TEXT_CAP) : "edit" };
    }
    case "McpToolCall": {
      const name = [item.server, item.tool].filter((x: unknown) => typeof x === "string" && x).join(".");
      return name ? { uuid: id, ts, kind: "tool", tool: name, text: name } : null;
    }
    case "Extension": {
      const kind = typeof item.kind === "string" && item.kind ? item.kind : "extension";
      const query = typeof item.query === "string" ? item.query : "";
      return { uuid: id, ts, kind: "tool", tool: kind,
        text: query ? cap(`${kind}: ${query}`, CODEX_TEXT_CAP) : kind };
    }
    case "CollabAgentToolCall": {
      const tool = typeof item.tool === "string" && item.tool ? item.tool : "collab";
      return { uuid: id, ts, kind: "tool", tool, text: tool };
    }
    case "ContextCompaction":
      return { uuid: id, ts, kind: "compact", text: "Conversation compacted" };
    default:
      return null; // Reasoning / AgentMessage / UserMessage / SubAgentActivity / unknown
  }
}

/** One rollout line -> the activity event it carries, or null. Exported for
 *  the fixture tests; the reader's declared slot below is this function. */
export function codexTailEvent(line: string, off: number): SessionEvent | null {
  if (!line || !line.includes('"event_msg"')) return null;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return null; } // torn line: next drain
  if (!rec || rec.type !== "event_msg") return null;
  const ts = Date.parse(rec.timestamp ?? "");
  if (!Number.isFinite(ts)) return null;
  const p = rec.payload;
  if (!p || typeof p !== "object") return null;
  let ev: SessionEvent | null = null;
  if (p.type === "item_completed") {
    ev = itemEvent(p.item, ts);
  } else if (p.type === "turn_aborted") {
    /* kind "interrupt", NOT compact: the app renders interrupts specially
     * (folds them onto the preceding tool run), and the stable rid makes a
     * wrong kind permanent in every log it lands in. */
    const turnId = typeof p.turn_id === "string" ? p.turn_id : "";
    if (!turnId) return null;
    const reason = typeof p.reason === "string" ? p.reason : "";
    ev = { uuid: `aborted:${turnId}`, ts, kind: "interrupt",
      text: reason === "interrupted" || !reason ? "Turn interrupted" : `Turn aborted (${reason})` };
  }
  if (ev) ev.off = off;
  return ev;
}

/** The RAW joined text of a rollout user record, or null: the queued-clear's
 *  exact-match string (readers/types.ts consumedOf). The rollout logs the
 *  delivered message verbatim as {type:"response_item", payload:{type:
 *  "message", role:"user", content:[{type:"input_text", text}]}} (fixture
 *  codex-rollout.jsonl). Harness-injected user records (plugin dumps) also
 *  match this shape; they simply never hit the awaiting index, so extracting
 *  them is harmless. */
export function codexConsumedOf(line: string): string | null {
  if (!line.includes('"response_item"') || !line.includes('"user"')) return null;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return null; }
  const p = rec?.payload;
  if (rec?.type !== "response_item" || p?.type !== "message" || p?.role !== "user") return null;
  const c = p.content;
  if (!Array.isArray(c)) return null;
  const parts = c.filter((b: any) => b?.type === "input_text" && typeof b.text === "string").map((b: any) => b.text);
  return parts.length ? parts.join("") : null;
}

export const codexReader: HarnessReader = {
  tag: "codex",

  // reads-only: model + pct off the transcript read; no native compact / usage.
  capabilities: { context: "transcript" },

  detect(input) {
    return input.kindStamp === "codex";
  },

  // The codex rollout locate: $CODEX_HOME/sessions/.../rollout-...-{id}.jsonl.
  locate: CODEX_TRANSCRIPT.locate,

  // Working/idle edges from codex event_msg payloads.
  turnEdge: CODEX_TRANSCRIPT.turnEdge,

  // The activity tail: item_completed / turn_aborted -> tool / compact /
  // interrupt rows (the extraction above), behind the declared slot
  // (readers/types.ts).
  sessionEvents: { mode: "lines", eventOf: codexTailEvent, consumedOf: codexConsumedOf },

  contextPct: CODEX_TRANSCRIPT.contextPct,
  model: CODEX_TRANSCRIPT.model,

  // Conversation turns, filtered of harness narration dumps.
  messages: CODEX_TRANSCRIPT.messages,

  /* How to spawn / resume codex (the launch capability lives on the reader,
   * as it does for claude). The permissive flag is codex's analog of claude's
   * --dangerously-skip-permissions: `--dangerously-bypass-approvals-and-sandbox`
   * skips every trust / hook-review / MCP-tool / shell-command approval prompt,
   * matching the cyc trust model (the user's own agent on their own machine).
   * PROVEN LIVE (codex-cli 0.148.0): launched with this flag, a full app round
   * trip completed with zero manual approvals. The flag string is byte-exact.
   *
   * `resume` uses codex's non-interactive resume-by-id form (`codex resume
   * <SESSION_ID>`, confirmed via `codex resume --help`; the permissive flag is a
   * valid option on the resume subcommand). It satisfies the required launch
   * type. Resume-by-id readiness depends on the engine having captured a codex
   * session id onto the row's one harnessSessionId (sessions/carry.ts); the
   * delivered win is fresh launch + fresh restart. */
  launch: {
    command: `codex --dangerously-bypass-approvals-and-sandbox ${CODEX_NO_UPDATE}`,
    resume: (sessionId: string) =>
      `codex resume --dangerously-bypass-approvals-and-sandbox ${CODEX_NO_UPDATE} ${sessionId}`,
  },

  /* Known codex dialog text, captured live: the update prompt ("Press enter
   * to continue") and the hooks/settings screens ("Press esc to go back"). */
  dialogScreen(text: string): boolean {
    return /Press enter to continue|Press esc to go back/.test(text);
  },

  // Not implemented for codex: no title reader, no agent-run parser.
  async title() { return null; },
  async runs() { return []; },
};
