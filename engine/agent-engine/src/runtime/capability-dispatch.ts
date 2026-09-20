/* THE CORE CAPABILITY DISPATCH.
 *
 * The one thing that fronts the harness adapters for plugins. It RESOLVES and
 * FORWARDS only: resolve the session id to its facts, build a SessionRef, pick
 * the harness capabilities behind it, forward the call, return the value. It
 * NEVER refuses (absence is answered, not policed) and it NEVER reshapes an
 * adapter's answer -- ZERO per-fact logic, no normalization layer (section 4,
 * the dumb-forwarder principle). Where members share shapes across harnesses,
 * that sameness was built into the ADAPTERS when they were authored to the one
 * interface (capabilities.ts); the dispatch adds nothing to it.
 *
 * INPUT IS BROKERED, not hardwired to the mux (section 5.1). sendText / interrupt
 * resolve HARNESS-NATIVE-FIRST, MUX-FALLBACK: if the resolved HarnessCapabilities
 * implements its own input path (piagent's direct lane control is the live
 * example), the dispatch routes input straight into it; otherwise the mux's
 * keystrokes-into-pane baseline answers, through core's delivery guard. Core
 * decides which, per session, right here. compact / setModel / answer are
 * harness MEANINGS of keystrokes and always live with the harness adapter.
 *
 * SessionRef is built HERE and never leaves; plugins never see one (section 4).
 *
 *   bun test agent-engine/src/runtime/capability-dispatch.test.ts
 */

import type {
  BlockedState,
  CommandKey,
  CommandResult,
  HarnessCapabilities,
  HarnessInfo,
  ReadKey,
  ReadResult,
  SessionRef,
  TranscriptOpts,
} from "./capabilities.ts";
import type { AgentConversation, AgentLifecycle } from "../readers/types.ts";

/** The session facts the dispatch resolves a session id to, from core's own
 *  session model. The dispatch builds a SessionRef from `handle`/`cwd`/
 *  `harnessSessionId`; `kind` selects the harness caps; `name` is only for the
 *  absence sentence; `viaMux`/`alive` gate whether the mux baseline can answer. */
export type DispatchSessionFacts = {
  handle: string; // muxHandle
  cwd: string;
  harnessSessionId: string | null; // the harness's own id (only the native/claude caps read it)
  kind: string; // harness tag: "claude" | "codex" | "opencode" | ...
  name: string; // the agent's display name, for the absence sentence only
  viaMux: boolean;
  alive: boolean;
};

/** The mux keystroke baseline every mux provides (section 5.1): input-in through
 *  core's delivery guard, and interrupt. The dispatch falls back to these when a
 *  harness has no native input path. Answers in the CommandResult shape (a
 *  PaneNotReady is mapped to its `tell` by the wiring). */
export type MuxInputBaseline = {
  sendText(ref: SessionRef, text: string): Promise<CommandResult>;
  interrupt(ref: SessionRef): Promise<CommandResult>;
};

/** What the composition root wires the dispatch over. Every function is an
 *  EXISTING engine verb re-homed behind the one seam; the dispatch itself holds
 *  no logic beyond resolve-and-forward. */
export type DispatchWiring = {
  /** Resolve a session id to its facts, or undefined when there is no such
   *  session. The one place the dispatch learns a session's identity. */
  sessionOf(sessionId: string): DispatchSessionFacts | undefined;
  /** The harness capabilities for an agent kind, authored to the one interface
   *  (capabilities.ts), or null for an unknown/name-only agent. */
  harnessFor(kind: string): HarnessCapabilities | null;
  /** Every harness kind this engine knows, each with whether it has a LIVE agent
   *  right now. Answered by the composition root off the live sessions; usage is
   *  an account fact folded across the ACTIVE kinds. */
  harnessKinds(): HarnessInfo[];
  /** The mux keystroke baseline (input-in / interrupt), for the fallback leg of
   *  the input broker. */
  muxInput: MuxInputBaseline;
};

/* THE ABSENCE SENTENCE. A command whose harness member is undefined is answered,
 * not policed: the dispatch says so in the product's own {ok,tell} shape. This
 * is the absence story (section 4), not per-fact logic: one sentence, keyed only
 * off the command name and the agent's own name. */
function notSupported(which: CommandKey, agentName: string): CommandResult {
  const verb: Record<CommandKey, string> = {
    sendText: "sending text",
    interrupt: "interrupting",
    compact: "compacting from here",
    setModel: "switching the model",
    answer: "answering from here",
  };
  return { ok: false, tell: `${verb[which]} is not supported for ${agentName} yet` };
}

const NO_SESSION: CommandResult = { ok: false, tell: "that session is not known to this engine" };

/** The forward-only surface the dispatch exposes; PluginCore.read/command/has/
 *  usage delegate straight to these. */
export interface CapabilityDispatch {
  /** Forward a meta read to the session's harness; null when the session is
   *  unknown. Overloaded so each key answers its own value shape. */
  read(which: "model", sessionId: string): Promise<ReadResult["model"]>;
  read(which: "contextPct", sessionId: string): Promise<ReadResult["contextPct"]>;
  read(which: "transcript", sessionId: string, opts?: TranscriptOpts): Promise<ReadResult["transcript"]>;
  read(which: "status", sessionId: string): Promise<ReadResult["status"]>;
  read(which: "blocked", sessionId: string): Promise<ReadResult["blocked"]>;
  /** The session's working directory (a session-identity fact, not a harness
   *  one); null when the session is unknown. */
  read(which: "cwd", sessionId: string): Promise<ReadResult["cwd"]>;
  read(which: ReadKey, sessionId: string, opts?: TranscriptOpts): Promise<ReadResult[ReadKey]>;

  /** Forward a command to the session's harness. sendText/interrupt are brokered
   *  (harness-native-first, mux fallback); compact/setModel/answer forward to
   *  the harness member, absence answered with {ok,tell}. */
  command(which: "sendText", sessionId: string, args: { text: string }): Promise<CommandResult>;
  command(which: "interrupt", sessionId: string): Promise<CommandResult>;
  command(which: "compact", sessionId: string): Promise<CommandResult>;
  command(which: "setModel", sessionId: string, args: { model: string }): Promise<CommandResult>;
  command(which: "answer", sessionId: string, args: { choice: string; fingerprint: string }): Promise<CommandResult>;
  command(which: CommandKey, sessionId: string, args?: Record<string, unknown>): Promise<CommandResult>;

  /** Whether a command is available for this session (for greying a button):
   *  input is always available on a live mux session (the baseline), the rest is
   *  per-harness member presence. */
  has(which: CommandKey, sessionId: string): boolean;

  /** An adapter fact in the owning harness's own shape (section 5.3); forwarded
   *  and never reshaped. Usage is a HARNESS-ACCOUNT fact, so it keys on the
   *  harness KIND (not a session id) and takes a `force` flag; undefined when the
   *  kind has no adapter or no usage member. */
  usage(kind: string, force: boolean): Promise<unknown>;
  /** Every harness kind this engine knows, with a live-agent flag (forwards the
   *  wiring's harnessKinds). The usage-card folds over the active ones. */
  harnesses(): HarnessInfo[];
}

/** Build the dispatch. Pure: everything it does is resolve a session, pick the
 *  harness, and forward. Composition-root-ready -- the wiring is the only state. */
export function makeCapabilityDispatch(wiring: DispatchWiring): CapabilityDispatch {
  /** Build the SessionRef the harness members take, from the resolved facts. */
  const refOf = (f: DispatchSessionFacts): SessionRef => ({
    handle: f.handle,
    cwd: f.cwd,
    harnessSessionId: f.harnessSessionId,
  });

  async function read(which: ReadKey, sessionId: string, opts?: TranscriptOpts): Promise<ReadResult[ReadKey]> {
    const f = wiring.sessionOf(sessionId);
    if (!f) return null;
    /* cwd is a session-IDENTITY fact off the resolved session model, not a
     * harness capability: answered before (and independent of) the adapter
     * lookup, so a name-only agent with no caps still has a working directory. */
    if (which === "cwd") return f.cwd;
    const caps = wiring.harnessFor(f.kind);
    if (!caps) return null;
    const ref = refOf(f);
    switch (which) {
      case "model": return caps.model(ref);
      // the context window is harness knowledge: the adapter
      // answers {used, total, pct}; the contextPct read is that pair's `pct`, the
      // exact number the ctx plugin and the context bar show today.
      case "contextPct": return (await caps.context(ref))?.pct ?? null;
      case "transcript": return caps.transcript(ref, opts);
      case "status": return caps.status(ref);
      case "blocked": return caps.blocked(ref);
    }
  }

  async function command(which: CommandKey, sessionId: string, args?: Record<string, unknown>): Promise<CommandResult> {
    const f = wiring.sessionOf(sessionId);
    if (!f) return NO_SESSION;
    const caps = wiring.harnessFor(f.kind);
    const ref = refOf(f);
    switch (which) {
      /* Input is brokered (section 5.1): harness-native path first, mux baseline
       * otherwise. Core decides here, per session. */
      case "sendText": {
        const text = String(args?.text ?? "");
        if (caps?.sendText) return caps.sendText(ref, text);
        return wiring.muxInput.sendText(ref, text);
      }
      case "interrupt": {
        if (caps?.interrupt) return caps.interrupt(ref);
        return wiring.muxInput.interrupt(ref);
      }
      /* Harness MEANINGS of keystrokes: they live with the harness that knows
       * them. Absence is answered, not policed. */
      case "compact":
        return caps?.compact ? caps.compact(ref) : notSupported("compact", f.name);
      case "setModel":
        return caps?.setModel ? caps.setModel(ref, String(args?.model ?? "")) : notSupported("setModel", f.name);
      case "answer":
        return caps?.answer
          ? caps.answer(ref, String(args?.choice ?? ""), String(args?.fingerprint ?? ""))
          : notSupported("answer", f.name);
    }
  }

  function has(which: CommandKey, sessionId: string): boolean {
    const f = wiring.sessionOf(sessionId);
    if (!f) return false;
    const caps = wiring.harnessFor(f.kind);
    if (which === "sendText" || which === "interrupt") {
      // available if the harness has its own path OR the mux baseline can answer
      // (a live, mux-backed session)
      if (caps && caps[which]) return true;
      return f.viaMux && f.alive;
    }
    return !!(caps && caps[which]);
  }

  /* Usage keys on the harness KIND, not a session: it is an account fact the
   * adapter answers with no SessionRef (harness-caps.ts already ignored it).
   * Forward to the kind's usage member, else undefined; never reshaped. */
  async function usage(kind: string, force: boolean): Promise<unknown> {
    const caps = wiring.harnessFor(kind);
    if (!caps?.usage) return undefined;
    return caps.usage(force);
  }

  const harnesses = (): HarnessInfo[] => wiring.harnessKinds();

  return { read: read as CapabilityDispatch["read"], command: command as CapabilityDispatch["command"], has, usage, harnesses };
}

// Re-export the value-free shapes a wiring author needs alongside the dispatch.
export type { AgentConversation, AgentLifecycle, BlockedState };
