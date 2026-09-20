// TmuxMuxAdapter: the tmux mux behind the same MultiplexerAdapter seam.
//
// This is the SHIPPABLE "other mux": the
// CYC_MUX=tmux path that mux.ts already proves, wrapped in the
// agent-shaped MultiplexerAdapter interface the herdr adapter implements
// (adapters/mux-adapter.ts). It does NOT reimplement a single tmux verb. It
// composes TmuxMux (tmux.ts) with the tmux TerminalDriver (terminal.ts
// tmuxDriver) and inherits everything else from MuxAdapter, which already
// wraps the Multiplexer interface generically: conversation, the sendInput
// delivery guard, spawn/rename/close, and the live terminal bridge.
//
// The claude transcript story is identical on tmux. TmuxMux links a pane to
// the newest claude session jsonl in its project dir (tmux.ts detectAgents), so
// the inherited conversation() resolves that session through readers/claude.ts
// exactly the way the herdr adapter does. A codex or opencode pane on tmux
// carries no lifted claude jsonl id and no agentSession, so it resolves to the
// documented empty conversation shape rather than throwing.
//
// mux.ts's makeAdapter() wires this adapter in: it returns a TmuxMuxAdapter
// under CYC_MUX=tmux (a MuxAdapter over its own HerdrClient otherwise), so the
// server selects it by the same env that has always chosen the tmux mux. The
// older makeMux() factory still returns a raw TmuxMux for any caller that wants
// the bare Multiplexer, but core builds through makeAdapter() now.

import { MuxAdapter } from "./mux-adapter.ts";
import { sharedTmuxMux } from "../terminal/tmux.ts";
import { tmuxDriver } from "../terminal/terminal.ts";
import { TmuxLinker } from "../sessions/tmux-link.ts";
import type { Multiplexer, MuxAgent } from "../terminal/mux.ts";
import type { TerminalDriver } from "../terminal/terminal.ts";

export class TmuxMuxAdapter extends MuxAdapter {
  /* `socket` names the `tmux -L <name>` server (CYC_TMUX_SOCKET in the existing
   * tmux path). `mux` and `terminal` are injectable so a test can drive the
   * adapter against a fake tmux Multiplexer without a live tmux server; when
   * absent the PROCESS-SHARED TmuxMux for that socket is used (sharedTmuxMux),
   * never a private instance: the mux this adapter polls must be the same
   * object any other factory (makeMux) hands the spawn path, or a pre-link
   * lands in an instance nobody enumerates. */
  /* THE TMUX IDENTITY STEP (design Gap 2), injected as the base adapter's
   * refine so this class reimplements no verb (tmux-adapter.test.ts). The tmux
   * mux emits only raw jsonl-linking facts (MuxAgent.tmuxLink); the identity
   * layer's TmuxLinker (sessions/tmux-link.ts) turns them into each pane's
   * agentSession. ONE linker per adapter, so its per-handle link state is this
   * mux's alone, and the base adapter runs it once per poll over a fresh copy of
   * each pane (the shared tmux mux must not have a common emit mutated). herdr
   * never reaches here (its agent_session is authoritative). */
  constructor(socket?: string, mux?: Multiplexer, terminal?: TerminalDriver) {
    const linker = new TmuxLinker();
    /* nativeDone:false (the last super arg): tmux has no native done -- its mux
     * emits only idle/blocked (tmux.ts) -- so a completed turn never lights the
     * app activity dot on its own. That flag opts the engine into synthesizing
     * done from the jsonl turn edge for tmux rows (sessions/reconcile.ts);
     * herdr keeps the base default true. Injected here rather than as a
     * capabilities() override so this class still reimplements NO verb
     * (tmux-adapter.test.ts). */
    super(mux ?? sharedTmuxMux(socket), terminal ?? tmuxDriver(socket),
      (agents) => linkTmuxAgents(linker, agents), undefined, false);
  }
}

/** Fill each tmux pane's agentSession from its raw jsonl-linking facts, on a
 *  COPY so the process-shared mux's emit is never mutated. Panes with no
 *  tmuxLink (there are none on a tmux mux, but a defensive pass-through) are
 *  left untouched. */
function linkTmuxAgents(linker: TmuxLinker, agents: MuxAgent[]): MuxAgent[] {
  const refs = linker.resolve(
    agents.flatMap((a) => (a.tmuxLink ? [a.tmuxLink] : [])), Date.now());
  return agents.map((a) =>
    a.tmuxLink ? { ...a, agentSession: refs.get(a.tmuxLink.handle) ?? null } : a);
}
