// HarnessReader: the agent-shaped seam core never imports directly (types
// only). A reader is ONE agent's
// transcript story: how to locate its raw log, parse conversation and events
// out of it, read model / context / title, and -- for agents that draw them --
// read its blocked dialogs off the screen.
//
// S1 extracts the claude reader behind this interface and keeps every existing
// import path byte-stable. `parse` / `parseLine` (the whole-file snapshot and
// incremental parse) are named here but not filled until the tails move;
// the claude reader implements the members that already exist.

import type { Ask, ScreenBox } from "../terminal/blocked.ts";
import type { AgentSessionRef } from "../runtime/agents.ts";
import type { AgentRun, SessionEvent, TurnEdge } from "../sessions/session-events.ts";

export type HarnessTag = string; // "claude" | "codex" | "opencode" | "pi" | ...

/* HOW A HARNESS TAKES INPUT (LANE B, design Gap 1). Most harnesses only
 * accept mux KEYSTROKES (type into the pane, press Enter). pi additionally
 * exposes a first-class DIRECT input path -- its supported RPC `prompt` command
 * -- so a message can reach the live session without keystrokes. A reader that
 * omits this is `keystroke` (the default the adapter reads it as). `direct` is
 * only USED when the adapter also has a live endpoint for the pane; it always
 * falls back to keystrokes when it does not, so declaring `direct` never
 * strands a message. */
export type InputDelivery = "keystroke" | "direct";

/* WHAT META CAPABILITIES A HARNESS PRESENTS UPWARD (the usage/model/context
 * capability domain, capabilities.ts / capability-dispatch.ts). This is the ONE
 * place a harness declares its meta-read profile, so the capability core derives
 * the resolver from the READERS table instead of naming harnesses in a switch.
 *
 *   context  where the model + context reading comes from. "native" reads through
 *            the harness's own windowed model/context seam (adapter.contextModelRead,
 *            today claude's jsonl scan with the model-id -> window table); the caps
 *            answer {used, total, pct} from it. "transcript" reads model + pct off
 *            the generic transcript read (adapter.contextRead) the way
 *            codex / opencode / pi do, so context answers used: null, total: null.
 *   compact  this harness has a native /compact keystroke meaning (claude); absent
 *            is the absence story -- the dispatch answers "not supported".
 *   usage    this harness answers plan / account usage (claude); absent means the
 *            usage-card never asks this kind. */
export type HarnessCaps = {
  context: "native" | "transcript";
  compact?: boolean;
  usage?: boolean;
};

/* THE SESSION-EVENT SOURCE (the activity tail: tool calls, compactions,
 * interrupts, as `t:"s"` rows in the agent's own chat log). ONE declared slot,
 * two forms matching the two transcript storage shapes that exist:
 *
 *   lines  the harness appends jsonl (claude, codex). `eventOf` maps ONE
 *          complete transcript line to the session event it carries, or null
 *          for the many lines that are not activity. The adapter's tail
 *          (SessionTailParser + WatcherPool + the 250ms heartbeat) and the
 *          backfill span reader both call it per line; `off` is the line's
 *          byte offset, kept on the event for the ingest's pointer.
 *
 *   poll   the harness keeps a store that is NOT an append-only file
 *          (opencode's sqlite db). `since` answers every event newer than
 *          `cursor` (an opaque number the reader defines; opencode uses the
 *          row's time_updated ms) plus the new cursor, or null when the store
 *          is unreadable. The adapter polls it on the same tail heartbeat,
 *          cheap-gated by a stat of the store file, and the ingest keeps the
 *          cursor in the same tail pointer it keeps byte offsets in.
 *
 * A reader that declares NEITHER gets no activity tail (pi's live events ride
 * its socket instead). Every event's `uuid` must be a STABLE id from the
 * harness's own record (claude: the record uuid; codex: the item id; opencode:
 * the part id), because it becomes the `rid` of the log's h|sid|rid dedupe key:
 * a re-read, a replay past the pointer, or a second source of the same fact
 * must map to the same key. */
export type SessionEventSource =
  /* `consumedOf` (optional, lines mode): the RAW text of a user record this
   * line carries, for the same queued-clear `consumed` serves in poll mode
   * below. The claude-format side parse (tailSideOf) runs regardless; this is
   * for a harness whose user records are not claude-shaped (codex). */
  | { mode: "lines"; eventOf(line: string, off: number): SessionEvent | null; consumedOf?(line: string): string | null }
  /* `consumed` (optional): the RAW texts of user records this drain saw land in
   * the harness's own store -- the proof a delivered message entered the model's
   * context, which is what clears the app's "Queued" mark (chat/ingest
   * markInContext, exact-text match, so raw and uncapped). The lines mode gets
   * this from the claude-format side parse (tailSideOf); a poll harness that
   * can name its user records returns them here. Absent means none this drain. */
  /* `startAtEnd` (optional): with no saved cursor, begin at the store's current
   * size instead of 0 -- the lines tail's rule. For an append-only file whose
   * byte offset IS the cursor (pi), so binding a resumed session never replays
   * its whole history into the chat as new rows. Absent: cursor 0, one backfill
   * batch deduped by rid (opencode's store). */
  | { mode: "poll"; startAtEnd?: boolean; since(path: string, cursor: number): Promise<{ events: SessionEvent[]; cursor: number; consumed?: string[] } | null> };

export type DetectInput = {
  kindStamp: string; // mux's agent stamp (normalized)
  command?: string; // tmux pane_current_command
  cwd: string;
  sessionRef: AgentSessionRef | null;
};

export type ConversationRole = "user" | "agent"; // mapped to wire role "user"|"claude"

export type AgentLifecycle = "started" | "running" | "blocked" | "gone";

/* The conversation turns the app can render (TranscriptSupport.messages). */
export type TranscriptMessage = { role: "user" | "claude"; text: string; ts: number };

export type AgentConversation = {
  harnessSessionId: string | null;
  model: string | null;
  contextPct: number | null;
  title: string | null;
  /* `why` is optional because a successfully-read dialog has an `ask` and no
   * "which kind of nothing" to name; the three reasons only apply when `ask`
   * is null. Mirrors AgentEvent.blocked.why? below. */
  blocked: null | { ask: Ask | null; why?: "unread" | "unrecognised" | "unsupported" };
  lifecycle: AgentLifecycle;
  messages: Array<{ role: ConversationRole; text: string; ts: number; kind?: "voice" }>;
  events: SessionEvent[]; // overlay one-liners (session-events.ts)
  runs: AgentRun[]; // pinned bar
};

export type AgentEvent =
  | { t: "message"; role: ConversationRole; text: string; ts: number }
  | { t: "overlay"; ev: SessionEvent }
  | { t: "runs"; runs: AgentRun[] }
  | { t: "status"; lifecycle: AgentLifecycle; thinking: boolean }
  | { t: "model"; model: string | null; contextPct: number | null }
  | { t: "blocked"; ask: Ask | null; why?: "unread" | "unrecognised" | "unsupported" }
  | { t: "gone" };

export interface HarnessReader {
  readonly tag: HarnessTag;

  /** The harness's declared meta capabilities (the usage/model/context domain).
   *  The capability core builds its resolver from these, keyed by `tag`, so it
   *  never names a harness; adding a reader adds its profile automatically. */
  readonly capabilities: HarnessCaps;

  detect(input: DetectInput): boolean;

  locate(ref: AgentSessionRef | null, cwd: string):
    { sessionId: string; path: string } | null;

  /** Whole-file / snapshot. Filled when the tails move; named here first. */
  parse?(raw: string): AgentConversation;
  /** Incremental: one transcript line -> one event, or null. */
  parseLine?(line: string): AgentEvent | null;

  /** This harness's activity-event extraction (see SessionEventSource above).
   *  Declared by claude (lines), codex (lines), opencode (poll) and pi (poll); absent
   *  means no activity tail for this harness. */
  readonly sessionEvents?: SessionEventSource;

  turnEdge(line: string): TurnEdge | null;
  contextPct(path: string): Promise<number | null>;
  model(path: string): Promise<string | null>;
  title?(path: string): Promise<string | null>;
  runs?(path: string): Promise<AgentRun[]>;
  /** Conversation turns the app renders (today CLAUDE_TRANSCRIPT.messages). */
  messages?(path: string): Promise<TranscriptMessage[]>;

  parseScreen?(ansi: string): ScreenBox | null;

  /** Whether this plain screen text shows a modal dialog waiting on a human
   *  (a selector, an update/trust prompt). Drives the adapter's dialog watch:
   *  a match overrides the pane's status to "blocked" so the app's
   *  waiting-in-terminal surface fires for muxes that do not detect this
   *  harness's dialogs themselves. Match only KNOWN dialog text: a false
   *  "blocked" is worse than a missed one. */
  dialogScreen?(text: string): boolean;

  launch?: { command: string; resume(sessionId: string): string };

  /* HOW LONG THIS HARNESS TAKES TO QUIT (the restart ladder's gone-wait,
   * pane-deliver.ts). Restart presses ctrl+c and then waits for the mux to stop
   * listing the agent before it types the launch command; a harness that
   * flushes and cleans up on SIGINT can outlast the default window and be
   * refused as "did not take ctrl+c" a beat before it actually leaves.
   *
   * `waitMs` is that harness's own gone-wait ceiling; absent means the shipped
   * default (CYC_RESTART_GONE_MS, 20s). It is only a CEILING: waitForAgentGone
   * returns the instant the agent goes, so a longer value never slows a restart
   * that quits promptly -- it only widens the window a slow one is allowed to
   * quit within before the honest refusal.
   *
   * `keys` is the ordered key-press sequence (herdr key names, e.g. "ctrl+c",
   * "ctrl+d") the restart uses to quit THIS harness, pressed ONCE through, one
   * key per step with the same spacing the default uses. Absent means the
   * shipped behavior: RESTART_QUIT_PRESSES presses of "ctrl+c" (pane-deliver.ts),
   * unchanged for every harness that declares nothing. A harness whose quit is
   * not "ctrl+c three times" declares its own sequence here, so the one place
   * that spells out HOW a harness quits is its reader, not a literal in the
   * ladder. */
  readonly quit?: { waitMs?: number; keys?: string[] };

  /** How this harness prefers to take input. Absent means "keystroke" (the
   *  adapter's default). "direct" is honoured only when a live endpoint is
   *  registered for the pane; otherwise the adapter uses keystrokes. */
  readonly inputDelivery?: InputDelivery;

  /* THE PER-PANE EVENT SOCKET (the pi live-stream + direct-identity seam,
   * adapters/pi-events.ts). A harness that streams its live events AND its own
   * session id to the engine over a per-pane unix socket declares this. When
   * true, the adapter's spawn binds a PiEventServer at a per-pane sock path
   * BEFORE the launch, decorates the command through `launchAugment` below so
   * the harness connects to it, stores the server under the handle, and attaches
   * the identity tap. Absent/false is the whole absence story: spawn binds no
   * socket and passes the command through byte-identical, exactly what
   * claude/codex/opencode do. Today only pi declares it (true).
   *
   * This is the reader declaration the generic spawn path dispatches on instead
   * of sniffing the launch command for pi: adding a reader that streams events
   * turns its socket on by data, with no new branch in spawn. */
  readonly eventSocket?: boolean;

  /** LAUNCH DECORATION. A reader whose spawn needs the launch command rewritten
   *  (pi points its output extension at the event socket with a
   *  `CYC_PI_EVENT_SOCK=<sock>` env assignment and a trailing `-e <ext>` flag)
   *  returns the augmented command; `ctx` carries the bound socket path and the
   *  pane's stable agent id. It is only invoked when `eventSocket` is set and
   *  the socket bound, so a reader that declares one declares both. Absent means
   *  no decoration -- the command is spawned as handed in. */
  launchAugment?(command: string, ctx: { sockPath: string; agentId: string }): string;
}
