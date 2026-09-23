// The pi HarnessReader (LANE B, design Gap 1). Replaces the transcript-only
// placeholder `readerFromTranscript("pi", PI_TRANSCRIPT)` (adapters/mux-adapter.ts)
// with a first-class reader modelled on readers/codex.ts and readers/claude.ts.
//
// FAITHFUL BY CONSTRUCTION, like the codex/opencode readers. Every transcript
// method delegates to the fixture-proven PI_TRANSCRIPT (chat/transcripts.ts),
// which reads pi's own on-disk jsonl at
//   ~/.pi/agent/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl
// (slug = the cwd with slashes as dashes, wrapped in double dashes). The pi
// session record shape, confirmed READ-ONLY against a real host transcript:
//   {type:"session", version, id:<uuid>, timestamp, cwd}
//   {type:"model_change", id, parentId, provider, modelId}
//   {type:"thinking_level_change", id, parentId, thinkingLevel}
//   {type:"message", id, parentId, timestamp,
//     message:{role:"user"|"assistant"|"toolResult", content, model, provider,
//              api, stopReason, usage:{input,output,cacheRead,cacheWrite,totalTokens,...}}}
// There is no fork/previous pointer at the session-record top level; a forked
// session is a fresh file with its own id (pi's `--fork` writes a new session),
// so lineage is proven from transcript CONTENT (lineage.ts), not a stored link.
//
// What pi ADDS over the placeholder: LAUNCH/RESUME commands (pi has real resume
// verbs, so `resume` returns a command, it is not fabricated) and a declared
// DIRECT input method (adapters/pi-direct.ts).
//
// MODEL: pi records its model id (grok-4.6, claude-opus-4-8, deepseek-chat).
// The reader surfaces that RAW id, exactly as the codex and opencode readers
// surface theirs -- the sessions row carries the harness's own id, and the ONE
// model-name mapper (sessions/model-names.ts: grok-4.6 -> "Grok 4.6") is applied
// at the app/model-indicator layer, not here. Mapping inside the reader would
// diverge from codex/opencode and break the sessions-row contract that draws
// "Pi . grok-4.6" from the raw id.
//
// What pi does NOT implement, returned as the documented empty shape and never
// thrown: title() is null (pi's `--name` is not read back from the transcript
// here) and runs() is [] (AgentRun parsing is claude-only; the background
// pi-run/pi-workflow lane recognizer is adapters/piagent.ts, a SEPARATE seam).
// parseScreen is omitted (no pi TUI dialog parser yet), exactly as codex.

import { PI_TRANSCRIPT } from "../chat/transcripts.ts";
import { augmentPiLaunch, PI_EXTENSION_PATH } from "../adapters/pi-launch.ts";
import type { HarnessReader } from "./types.ts";
import { isFromApp, type SessionEvent } from "../sessions/session-events.ts";

/* THE pi ACTIVITY TAIL (sessionEvents, poll mode). Until now pi was the ONE
 * harness with no transcript tail into the chat log: its session records only
 * flowed over the launch-time extension socket (adapters/pi-events.ts), which
 * exists solely for a pane cyc itself spawned. A pi someone starts in a plain
 * mux pane -- the normal way a person opens pi -- therefore showed replies (the
 * reply-channel POST) but NO session rows, and the app sat on "Queued" until a
 * reply landed. claude/codex/opencode all tail their own files whoever started
 * them; this gives pi the same floor. The socket stays as the faster live
 * source; both feed logSession, which dedupes on the durable id both carry
 * (the jsonl record id for messages, the toolCallId for tools -- the SAME ids
 * cyc-output.js puts on its frames), so a cyc-spawned pi never double-rows.
 *
 * Poll mode, not lines mode: one pi assistant record can hold text AND several
 * toolCalls, so one line can be several rows, which the lines contract (one
 * event per line) cannot express. The file IS append-only; the poll simply
 * reads the bytes past the cursor, consumes whole lines, and leaves a torn
 * trailing line for the next beat. */

// caps pinned to cyc-output.js / adapters/pi-events.ts so the tail row and the
// socket row for the same record carry identical text.
const PI_TOOL_CAP = 200;
const PI_BODY_CAP = 20000; // engine BODY_CAP: prompt/reply bodies keep their text
const capText = (t: string, n: number): string => (t.length > n ? t.slice(0, n) + "…" : t);

/** The joined text blocks of a pi message content, trimmed ("" when none). */
function piContentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (p && typeof p === "object" && (p as { type?: unknown }).type === "text"
      && typeof (p as { text?: unknown }).text === "string") {
      parts.push((p as { text: string }).text);
    }
  }
  return parts.join("").trim();
}

/** The tool row's text, the SAME derivation cyc-output.js toolText uses. */
function piToolText(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return capText(o.command, PI_TOOL_CAP);
    if (typeof o.path === "string") return capText(o.path, PI_TOOL_CAP);
    if (typeof o.file_path === "string") return capText(o.file_path, PI_TOOL_CAP);
    if (typeof o.pattern === "string") return capText(o.pattern, PI_TOOL_CAP);
  }
  return name || "";
}

/** One parsed pi jsonl record -> its renderable rows (0..n). Exported for the
 *  unit test; piEventsSince drives it per consumed line. */
export function piRecordEvents(rec: unknown, off: number): SessionEvent[] {
  if (!rec || typeof rec !== "object") return [];
  const e = rec as { type?: unknown; id?: unknown; timestamp?: unknown; message?: unknown; summary?: unknown };
  const uuid = typeof e.id === "string" ? e.id : "";
  if (!uuid) return [];
  const recTs = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  if (e.type === "compaction") {
    if (!Number.isFinite(recTs)) return [];
    return [{ uuid, ts: recTs, kind: "compact", text: "Context compacted", off }];
  }
  if (e.type !== "message" || !e.message || typeof e.message !== "object") return [];
  const m = e.message as { role?: unknown; content?: unknown; timestamp?: unknown };
  const ts = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : recTs;
  if (!Number.isFinite(ts)) return [];
  const out: SessionEvent[] = [];
  if (m.role === "user") {
    const text = capText(piContentText(m.content), PI_BODY_CAP);
    /* The app's own utterance (VOICE:/TEXT:) is already a user bubble in the
     * chat; a prompt row of it would paint the same text twice, faint above
     * the bubble (live 2026-09-23). Same skip the claude extractor keeps;
     * crons and terminal-typed prompts stay visible. The queued-clear still
     * sees it: piEventsSince reads consumed off the raw record, not off rows. */
    if (text && !isFromApp(text)) out.push({ uuid, ts, kind: "prompt", text, off });
  } else if (m.role === "assistant") {
    // tool rows first (that is the order the turn ran them in), each on the
    // toolCallId the socket frame and the transcript share; then the reply
    // text, on the record id, skipped when the turn was pure tool calls.
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== "object") continue;
        const blk = b as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (blk.type !== "toolCall" || typeof blk.id !== "string" || !blk.id) continue;
        const tool = typeof blk.name === "string" ? blk.name : "";
        out.push({ uuid: blk.id, ts, kind: "tool", tool,
          text: capText(piToolText(tool, blk.arguments), PI_TOOL_CAP), off });
      }
    }
    const text = capText(piContentText(m.content), PI_BODY_CAP);
    if (text) out.push({ uuid, ts, kind: "reply", text, off });
  }
  // toolResult records are not rows, matching the socket source.
  return out;
}

/** The RAW joined text of a user record, uncapped and untrimmed: the exact
 *  string the engine armed at send time (chat/ingest awaitingByText), so a
 *  landed prompt clears the app's "Queued" mark by exact match. */
function piRawUserText(rec: unknown): string | null {
  if (!rec || typeof rec !== "object") return null;
  const e = rec as { type?: unknown; message?: unknown };
  if (e.type !== "message" || !e.message || typeof e.message !== "object") return null;
  const m = e.message as { role?: unknown; content?: unknown };
  if (m.role !== "user") return null;
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return null;
  const parts: string[] = [];
  for (const p of c) {
    if (p && typeof p === "object" && (p as { type?: unknown }).type === "text"
      && typeof (p as { text?: unknown }).text === "string") {
      parts.push((p as { text: string }).text);
    }
  }
  return parts.length ? parts.join("") : null;
}

/** The poll-mode drain: every row in the bytes past `cursor`, whole lines
 *  only (a torn trailing line waits for the next beat). `consumed` carries the
 *  raw user texts that landed, for the queued-clear. Null only when the file
 *  is not there (retried on the next snapshot). */
export async function piEventsSince(path: string, cursor: number):
  Promise<{ events: SessionEvent[]; cursor: number; consumed: string[] } | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  const size = f.size;
  const at = cursor >= 0 && cursor <= size ? cursor : 0;
  if (size <= at) return { events: [], cursor: at, consumed: [] };
  const chunk = Buffer.from(await f.slice(at, size).arrayBuffer());
  const nl = chunk.lastIndexOf(0x0a);
  if (nl < 0) return { events: [], cursor: at, consumed: [] }; // no complete line yet
  const events: SessionEvent[] = [];
  const consumed: string[] = [];
  let lineStart = 0;
  while (lineStart <= nl) {
    const lineEnd = chunk.indexOf(0x0a, lineStart);
    const line = chunk.subarray(lineStart, lineEnd).toString("utf8").trim();
    const off = at + lineEnd + 1; // the record's end offset, like the lines tail
    if (line) {
      let rec: unknown = null;
      try { rec = JSON.parse(line); } catch { /* a corrupt line is skipped, not fatal */ }
      if (rec) {
        events.push(...piRecordEvents(rec, off));
        const raw = piRawUserText(rec);
        if (raw) consumed.push(raw);
      }
    }
    lineStart = lineEnd + 1;
  }
  return { events, cursor: at + nl + 1, consumed };
}

export const piReader: HarnessReader = {
  tag: "pi",

  // reads-only, the same shape as codex / opencode: model + pct off the
  // transcript read, so pi's usage/context bar degrades cleanly instead of pi
  // being silently absent from the capability domain.
  // usage: pi runs the host's claude account through the bridge, so it
  // answers the same account-level LimitsReport claude does. Without it, an
  // all-pi engine has no usage harness and the card can never refresh.
  capabilities: { context: "transcript", usage: true },

  detect(input) {
    return input.kindStamp === "pi";
  },

  // The pi session locate: ~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl,
  // by session id under the cwd slug (or a direct path ref).
  locate: PI_TRANSCRIPT.locate,

  // Working/idle from the pi transcript tail: a user turn or a toolUse stop is
  // working; a stop/error/length stop reason is idle.
  turnEdge: PI_TRANSCRIPT.turnEdge,

  // Newest assistant usage (input+cacheRead+cacheWrite) against the model's
  // window; null only when no assistant turn has been written yet.
  contextPct: PI_TRANSCRIPT.contextPct,

  // pi's own model id (raw), like codex/opencode; friendly-named downstream.
  model: PI_TRANSCRIPT.model,

  // Conversation turns (user + assistant text), filtered of empty content.
  messages: PI_TRANSCRIPT.messages,

  // Not implemented for pi: no title reader, no agent-run parser (piagent.ts is
  // a separate background-lane recognizer, not this pane reader).
  async title() { return null; },
  async runs() { return []; },

  // How to spawn / resume a pi pane. `pi` is the shipped binary end users have
  // on PATH; auth and providers are pi's own config, so there is no wrapper and
  // every cyc-added flag/env passes straight to the real binary.
  // pi HAS a real resume verb -- `--session <path|id>` resumes a prior session
  // by its (partial) uuid -- so `resume` returns that command; it is NOT
  // fabricated. (`--continue`/`-c` resumes the newest session; `--fork` starts
  // a NEW session from a prior one, which is start-not-resume, so it is not the
  // resume verb here.)
  launch: {
    command: "pi",
    resume: (sessionId: string) => `pi --session ${sessionId}`,
  },

  // PI GETS A WIDER GONE-WAIT than the 20s the restart ladder gives
  // claude/codex/opencode: pi can linger in the mux listing after its quit,
  // long enough that a resume-mode restart refused it a beat before pi
  // actually left (one host, w1:p4). The 40s is still a ceiling
  // waitForAgentGone returns early from, so a prompt quit is not slowed, and
  // it stays under the app's 60s restart timeout (app/store/sessionOps.ts)
  // with room for the shell pause and screen watch. Env CYC_RESTART_GONE_MS_PI
  // overrides it (pane-deliver.ts, tests).
  //
  // PI DOES NOT QUIT ON CTRL+C AT ALL (measured on one host): three ctrl+c
  // presses 500ms apart into a live idle pi pane leave it alive 60s later,
  // still listed, pane unchanged -- so the default ladder's ctrl+c-only quit
  // can never take pi down, and the wider gone-wait above cannot help a quit
  // that never starts. pi's quit is EOF: ONE ctrl+d at an EMPTY input exits it
  // to the shell immediately. So the sequence is ctrl+c (clears any pending
  // input, leaving the box empty) then a SINGLE ctrl+d (the quit). Never send a
  // second ctrl+d: once pi exits the pane holds a shell, and a further ctrl+d
  // there would close the pane itself.
  quit: { waitMs: 40_000, keys: ["ctrl+c", "ctrl+d"] },

  // PI STREAMS LIVE EVENTS + ITS OWN SESSION ID over a per-pane unix socket
  // (adapters/pi-events.ts). Declaring eventSocket has the adapter's spawn bind
  // a PiEventServer before pi starts, decorate the launch through launchAugment
  // below, and attach the identity tap -- the pi-specific spawn work that used
  // to be a command-string sniff in the generic spawn path, now driven by this
  // reader declaration. Every non-pi harness omits it and spawns untouched.
  eventSocket: true,

  // The transcript activity tail (see piEventsSince above): session rows for
  // EVERY pi pane, however it was started. The extension socket above stays as
  // the faster live source for a cyc-spawned pi; the two dedupe on the durable
  // record ids they share.
  sessionEvents: { mode: "poll", startAtEnd: true, since: piEventsSince },

  // Decorate a pi launch so the cyc-launched pi loads the output extension and
  // points it at the bound socket: a leading `CYC_PI_EVENT_SOCK=<sock>` env
  // assignment plus a trailing `-e <cyc-output.js>` flag (both are plain pi
  // flags/env, so they pass to the real binary directly). This is the CURRENT
  // augmentPiLaunch output verbatim -- the
  // adapter used to call augmentPiLaunch itself; the reader owns it now, so the
  // augmented command is byte-for-byte what it was for the same launch + sock.
  launchAugment(command, ctx) {
    return augmentPiLaunch(command, { extensionPath: PI_EXTENSION_PATH, sockPath: ctx.sockPath }).command;
  },

  /* Known pi dialog text, captured live: the selector footer ("Enter to
   * select · ... Escape/Ctrl+C to cancel") and the pi-defender confirm
   * ("Allow anyway", "Will auto-deny in Ns"). */
  dialogScreen(text: string): boolean {
    return /Enter to select|Will auto-deny in \d+s|Allow anyway \(dangerous\)/.test(text);
  },

  // pi input can be delivered DIRECTLY (design Gap 1, product spec), through
  // pi's supported RPC `prompt` command rather than mux keystrokes. Declared
  // here; the adapter routes pi input through the direct path when a live pi
  // RPC endpoint is registered for the pane, and falls back to keystrokes
  // otherwise (adapters/pi-direct.ts, adapters/mux-adapter.ts sendInput).
  inputDelivery: "direct",
};
