/* THE HARNESS CAPABILITY INTERFACE.
 *
 * A PURE TYPES LEAF, beside readers/types.ts: the finite meta/commands a harness
 * adapter (claude, codex, opencode) presents upward, as ONE typed interface.
 * This IS the registry: adding a member is a reviewed edit to one file every
 * adapter must answer for, so the surface cannot grow ad hoc.
 *
 * "Normalized" here is ADAPTER-AUTHORING DISCIPLINE, not engine code: each
 * adapter is written to this same interface with same-shaped members where
 * natural (model() -> string, contextPct() -> number). The sameness lives in the
 * adapters by construction; the dispatch that fronts them (capability-dispatch.ts)
 * is a dumb forwarder with zero per-fact logic and no normalization layer.
 *
 * Optional members ARE the absence story: an undefined member is "this harness
 * cannot" (or, for sendText/interrupt, "this harness has no native path; use the
 * mux baseline", section 5.1). Nothing here imports a core feature; only type-only
 * imports of the shapes the members already speak.
 */

import type { Ask } from "../terminal/blocked.ts";
import type { AgentConversation, AgentLifecycle } from "../readers/types.ts";

/** The three reasons a blocked read has no `ask`; only meaningful when ask is
 *  null (mirrors AgentConversation.blocked.why). */
export type BlockedWhy = "unread" | "unrecognised" | "unsupported";

/** The result shape every command answers in, ok and refusal alike. It is the
 *  shape compactSession already returns (session-verbs.ts). `tell` is the
 *  sentence the app shows as a toast; a refusal names why in the product's own
 *  words. */
export type CommandResult = { ok: boolean; tell: string };

/** A normalized context read: the context window
 *  is HARNESS knowledge. `used`/`total` are the tokens in context and the model's
 *  window; `pct` is derived from that pair the one way `contextPct` derives it
 *  today (floor + clamp), and rides along so `PluginCore.read("contextPct")` keeps
 *  answering the exact number the context bar shows. A claude adapter fills the
 *  window from its model-id table (the ONE copy, behind readers/claude.ts); a
 *  harness with no window table answers `total: null, pct: null`. */
export type ContextRead = { used: number | null; total: number | null; pct: number | null };

/** The windowing a transcript read accepts (the shape session-events.ts
 *  readEventsTail takes). */
export type TranscriptOpts = { limit?: number; from?: number; before?: number; maxBytes?: number };

/** SessionRef is what the dispatch BUILDS per session and hands the harness
 *  adapter: the live mux handle, the session's directory, and the harness's own
 *  id. It is core-internal; NO plugin ever sees one (section 4). */
export type SessionRef = {
  handle: string; // the live mux handle (opaque; never parsed here)
  cwd: string;
  harnessSessionId: string | null; // the harness's own id (the claude caps' jsonl key)
};

/** What a blocked read answers: the question and its options, or which kind of
 *  nothing (section 5.2). */
export type BlockedState = { ask: Ask | null; why?: BlockedWhy };

/* THE ONE AUTHORED INTERFACE (section 5.2). Every harness adapter implements it;
 * optional members are the absence story. */
export interface HarnessCapabilities {
  // ---- meta reads (total; every harness answers, even if with a null/empty) ----
  model(s: SessionRef): Promise<string | null>;
  /** the normalized context read (used/total/pct); the model->window table lives
   *  behind the claude adapter (readers/claude.ts). `PluginCore.read("contextPct")`
   *  answers `context().pct`, so the ctx plugin and the context bar stay one number. */
  context(s: SessionRef): Promise<ContextRead | null>;
  transcript(s: SessionRef, opts?: TranscriptOpts): Promise<AgentConversation>;
  status(s: SessionRef): AgentLifecycle; // running status; synchronous, off the snapshot
  blocked(s: SessionRef): Promise<BlockedState>; // the question + its options

  // ---- commands (optional members are the absence story) ----
  /** harness-NATIVE input path; absent means "use the mux baseline" (5.1). */
  sendText?(s: SessionRef, text: string): Promise<CommandResult>;
  /** same brokering as sendText: harness-native if present, else mux baseline. */
  interrupt?(s: SessionRef): Promise<CommandResult>;
  /** absent: this harness has no compact (claude: the "/compact" keystroke). */
  compact?(s: SessionRef): Promise<CommandResult>;
  /** claude: the "/model <name>" keystroke; others absent. */
  setModel?(s: SessionRef, model: string): Promise<CommandResult>;
  /** the chooser fingerprint press; absent where there is no parseScreen. */
  answer?(s: SessionRef, choice: string, fingerprint: string): Promise<CommandResult>;

  // ---- adapter facts, own shape per harness (5.3) ----
  /** e.g. claude: ClaudeUsage. Usage is a HARNESS-ACCOUNT fact, not a session
   *  fact: it takes no SessionRef, only a `force` flag (skip the cached lease,
   *  re-read upstream). Typed concretely in the adapter's own module; the
   *  dispatch forwards it and never reshapes. */
  usage?(force: boolean): Promise<unknown>;
}

/** One harness kind this engine knows, with whether it has a LIVE agent right
 *  now. The usage-card folds account usage across the ACTIVE kinds (a harness
 *  with no live agent is not asked). `kind` is the normalized harness tag
 *  ("claude" | "codex" | "opencode"); the composition root answers the list. */
export type HarnessInfo = { kind: string; active: boolean };

/** The meta reads a plugin may ask for through `PluginCore.read`. `cwd` is the
 *  one session-IDENTITY read (the agent's working directory), sourced the same
 *  adapter->core way the harness facts are (the dispatch resolves it off the
 *  session model); it is not a harness capability, so it answers even for a
 *  name-only agent with no adapter. */
export type ReadKey = "model" | "contextPct" | "transcript" | "status" | "blocked" | "cwd";

/** The commands a plugin may issue through `PluginCore.command` / probe through
 *  `PluginCore.has`. */
export type CommandKey = "sendText" | "interrupt" | "compact" | "setModel" | "answer";

/** Maps each read key to what it answers (null when the session is unknown). */
export type ReadResult = {
  model: string | null;
  contextPct: number | null;
  transcript: AgentConversation | null;
  status: AgentLifecycle | null;
  blocked: BlockedState | null;
  cwd: string | null;
};
