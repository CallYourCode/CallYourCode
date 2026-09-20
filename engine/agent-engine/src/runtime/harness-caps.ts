/* THE REAL HARNESS CAPABILITIES, derived from the readers' declared capabilities.
 * The interface (capabilities.ts) and the dumb dispatch (capability-dispatch.ts)
 * shipped first; this file
 * BUILDS one HarnessCapabilities per reader over EXISTING engine verbs injected as
 * deps. It NAMES NO HARNESS: the resolver is a Map keyed by reader tag, built from
 * `deps.profiles` (adapter.harnessProfiles, the READERS table), so adding a reader
 * adds its profile and an unknown kind degrades to null.
 *
 * WHAT A READER'S CAPABILITIES DECLARE (readers/types.ts HarnessCaps):
 *   - context: "native" | "transcript". A NATIVE read (claude today) routes model
 *     + windowed context through the adapter seam `adapter.contextModelRead`: the
 *     seam owns the model-id -> window table and the [1m]/date-pin strip, so this
 *     file does no model-name math. The read is {used, total, pct}; pct is derived
 *     the ONE way `contextPct` derives it (floor + clamp, in the seam), so
 *     `PluginCore.read("contextPct")` keeps answering the number the context bar
 *     shows byte for byte. A TRANSCRIPT read (codex / opencode / pi) reads model +
 *     pct off the generic transcript read (adapter.contextRead), context used/total
 *     null. model() answers the RAW id; the model-indicator PLUGIN maps it.
 *   - compact / usage: claude's OWN keystroke and account verbs, the one
 *     claude-specific behaviour the adapter seam does not expose, gated by the
 *     reader-declared flags (deps.claudeCompact / deps.claudeUsage). usage(force)
 *     forwards `limitsNow(force)` verbatim; the LimitsReport IS the shape (5.3).
 *
 * Absence is the story (capabilities.ts): a reader that declares no compact/usage
 * leaves those members undefined, so the dispatch answers "not supported for
 * <name> yet", and input falls to the mux baseline.
 *
 *   bun test agent-engine/src/runtime/harness-caps.test.ts
 */

import type {
  BlockedState,
  CommandResult,
  ContextRead,
  HarnessCapabilities,
  SessionRef,
} from "./capabilities.ts";
import type { AgentConversation, AgentLifecycle, HarnessCaps } from "../readers/types.ts";

/** The existing engine verbs makeHarnessCaps is authored over. Every one is a
 *  verb the composition root already owns; this file reaches no server state
 *  directly. */
export type HarnessCapsDeps = {
  /** the harness kinds this engine knows and their declared capabilities, in
   *  READERS order (adapter.harnessProfiles). The resolver is BUILT from this,
   *  keyed by tag, so the core never names a harness in a switch. */
  profiles: ReadonlyArray<{ tag: string; caps: HarnessCaps }>;
  /** the "transcript" context read: model + pct off the generic transcript read
   *  (adapter.contextRead), for a harness whose caps.context is "transcript". */
  muxContextRead(handle: string): Promise<{ pct: number | null; model: string | null } | null>;
  /** the "native" context read: the harness's own windowed model + context scan
   *  (adapter.contextModelRead, today claude's jsonl read with the model-id ->
   *  window table), for a harness whose caps.context is "native". The caps answer
   *  {used, total, pct} off it and never do model-name math themselves. */
  contextModelRead(cwd: string, sessionId: string): Promise<{
    pct: number | null;
    used: number | null;
    total: number | null;
    modelId: string | null;
  } | null>;
  /** the full conversation snapshot (adapter.conversation), for transcript/blocked. */
  conversation(handle: string): Promise<AgentConversation>;
  /** the coarse lifecycle, synchronous, off the live session snapshot. */
  lifecycle(handle: string): AgentLifecycle;
  /** claude /compact, resolved from the handle to the session (compactSession);
   *  it keeps its exact {ok, tell} tells (session-verbs.ts). */
  claudeCompact(handle: string): Promise<CommandResult>;
  /** claude plan usage in its OWN shape (limitsNow(force) -> LimitsReport).
   *  `force` skips the machine-lease wait and re-reads upstream (the refresh
   *  button); an unforced poll reads the cached number. */
  claudeUsage(force: boolean): Promise<unknown>;
};

/** Build the harness-caps resolver: `(kind) => HarnessCapabilities | null`, the
 *  shape the dispatch's `harnessFor` wants (capability-dispatch.ts). The resolver
 *  is a MAP built from the readers' declared capabilities (deps.profiles), keyed
 *  by tag: the core names no harness, adding a reader adds its profile, and an
 *  unknown kind degrades cleanly to null. */
export function makeHarnessCaps(deps: HarnessCapsDeps): (kind: string) => HarnessCapabilities | null {
  // reads shared by every kind, authored off the adapter's conversation snapshot
  const transcript = (s: SessionRef): Promise<AgentConversation> => deps.conversation(s.handle);
  const status = (s: SessionRef): AgentLifecycle => deps.lifecycle(s.handle);
  const blocked = async (s: SessionRef): Promise<BlockedState> =>
    (await deps.conversation(s.handle)).blocked ?? { ask: null };

  /* THE NATIVE (claude today) MODEL + CONTEXT, routed through the adapter seam
   * (adapter.contextModelRead) rather than value-importing claude internals here.
   * The seam answers ONE reading -> {pct, used, total, modelId}: `used` is the
   * tokens in context, `total` the model's window ([1m]/date-pin handled and
   * failing open to 1M in the seam), `modelId` the RAW id (the plugin maps it).
   * `used`/`total`/`modelId` are null only when there is no reading (no assistant
   * turn yet, or compacted and silent since); the whole read is null only without
   * a harness session id or a locatable transcript. */
  const nativeModel = async (s: SessionRef): Promise<string | null> => {
    if (!s.harnessSessionId) return null;
    return (await deps.contextModelRead(s.cwd, s.harnessSessionId))?.modelId ?? null;
  };
  const nativeContext = async (s: SessionRef): Promise<ContextRead | null> => {
    if (!s.harnessSessionId) return null;
    const r = await deps.contextModelRead(s.cwd, s.harnessSessionId);
    return r ? { used: r.used, total: r.total, pct: r.pct } : null;
  };

  /* THE TRANSCRIPT (codex / opencode / pi) MODEL + CONTEXT, off the generic
   * transcript read (adapter.contextRead, which does its own window math in
   * chat/transcripts.ts: the harness's reported window, else the 1M default). The
   * read carries only pct, so context answers used: null, total: null. */
  const transcriptModel = async (s: SessionRef): Promise<string | null> =>
    (await deps.muxContextRead(s.handle))?.model ?? null;
  const transcriptContext = async (s: SessionRef): Promise<ContextRead | null> => {
    const r = await deps.muxContextRead(s.handle);
    return r ? { used: null, total: null, pct: r.pct } : null;
  };

  /* Build one harness's capabilities from its declared profile. The reads are
   * total (every harness answers); the commands are the absence story -- a caps
   * with no compact / usage leaves those members undefined and the dispatch
   * answers "not supported". claude's compact / usage are its OWN keystroke and
   * account verbs (deps.claudeCompact / deps.claudeUsage): the ONE claude-specific
   * behaviour the adapter seam does not expose, kept behind its reader-declared
   * flags rather than a switch in the core. No native sendText/interrupt: input
   * is the mux keystroke baseline for every harness here. */
  const build = (caps: HarnessCaps): HarnessCapabilities => {
    const native = caps.context === "native";
    const profile: HarnessCapabilities = {
      model: native ? nativeModel : transcriptModel,
      context: native ? nativeContext : transcriptContext,
      transcript,
      status,
      blocked,
    };
    if (caps.compact) profile.compact = (s) => deps.claudeCompact(s.handle);
    if (caps.usage) profile.usage = (force) => deps.claudeUsage(force);
    return profile;
  };

  const byTag = new Map<string, HarnessCapabilities>();
  for (const { tag, caps } of deps.profiles) byTag.set(tag, build(caps));
  return (kind: string): HarnessCapabilities | null => byTag.get(kind) ?? null;
}
