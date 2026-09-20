/* THE MULTIPLEXER SEAM (#480).
 *
 * The engine owns terminals through exactly one of these: herdr today, plain
 * tmux for a user who runs their own tmux server. This interface is not
 * invented -- it is the set of methods server.ts actually calls on the mux
 * object, extracted verbatim from the call sites (grep `herdr.<method>` in
 * server.ts). Nothing here is a method nobody calls.
 *
 * The concrete classes (HerdrClient, TmuxMux) are imported for the makeMux
 * factory. They import only TYPES from this file, so those imports are erased
 * at runtime and there is no import cycle.
 *
 * This module imports NO adapter. It used to, for makeAdapter(), and that made
 * a real cycle: mux-adapter.ts value-imports makeTerminalDriver, so entering
 * evaluation at mux-adapter.ts ran mux.ts, which ran tmux-adapter.ts, whose
 * `class TmuxMuxAdapter extends MuxAdapter` dereferenced a binding that was
 * still in its temporal dead zone. makeAdapter() now lives in
 * adapters/factory.ts and makeTerminalDriver() in terminal.ts. */

import { HerdrClient } from "./herdr.ts";
import { sharedTmuxMux } from "./tmux.ts";
import type { AgentSessionRef } from "../runtime/agents.ts";
import type { TmuxLinkFacts } from "../sessions/tmux-link.ts";

/* THE FIVE VERBS of the contract map onto these methods:
 *   1. enumerate panes  -> onAgents()/start() deliver the agent list; each
 *                          MuxAgent carries a stable paneId and cwd.
 *   2. read a screen WITH ANSI -> readPane()
 *   3. type + submit    -> sendText() (types, no submit) + sendKeys("enter")
 *   4. spawn without focus -> newTab()
 *   5. detect agents (OPTIONAL) -> the mux fills MuxAgent.status/agentSession
 *      as best it honestly can; herdr scrapes it, tmux derives it engine-side.
 *
 * The rest (renamePane, closePane, workspaceOf, knownCwds) are the session
 * management verbs the app drives, and they are on the interface for the same
 * reason: server.ts calls them.
 */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/* One agent pane, as server.ts consumes it (the onAgents rebuild reads exactly
 * these fields). Named MuxAgent because it is no longer herdr's alone; herdr.ts
 * keeps `HerdrAgent` as an alias so its own code reads unchanged. */
export type MuxAgent = {
  paneId: string;
  name: string; // basename(cwd), deduped with pane id on collision
  cwd: string;
  status: AgentStatus; // best honest status; working/idle/blocked refined engine-side
  /* WHICH CODING AGENT THIS PANE RUNS, normalized (agents.ts). Every listed pane
   * has one: a pane the mux does not stamp with an agent is not a session and is
   * never emitted. This used to be read on one line and thrown away (the engine
   * filtered the snapshot on a single id and kept nothing); it is a field now so
   * every agent's panes are listed and each row is tagged with its own agent. */
  agent: string;
  /* The pane's own session handle as the mux reported it (herdr's agent_session,
   * tmux's linked uuid), for ANY agent. null = the mux gave none. The adapter
   * lifts this into the pane's harnessSessionId only when agent === "claude" &&
   * kind === "id" (the claude jsonl path builder is its one consumer); every
   * other harness flows its id through the announce/socket ref, not this lift. */
  agentSession: AgentSessionRef | null;
  /* THE RAW jsonl-linking FACTS the tmux mux emits, with NO decision about which
   * candidate is "the" session (design Gap 2). The identity layer
   * (sessions/tmux-link.ts, driven by the tmux adapter) turns these into the
   * pane's agentSession above. Present only on tmux panes; herdr's agent_session
   * is authoritative and needs no linking step, so it leaves this undefined. */
  tmuxLink?: TmuxLinkFacts;
  workspace: string; // workspace display label
  tab: string | null; // tab display label; null = hidden
  displayAgent: string | null; // metadata override (herdr's teleport timer); null = none
  stateChangeSeq: number;
};

/* THE INTERFACE. Every method is a real call site in server.ts. */
export interface Multiplexer {
  /** cb fires with the full agent list on first snapshot and on every change. */
  onAgents(cb: (agents: MuxAgent[]) => void): void;
  /** Begin enumerating; retries/polls forever on its own. */
  start(): void;

  /** A pane's screen WITH ANSI, newest at the bottom. `lines` bounds the read. */
  readPane(paneId: string, lines: number): Promise<{ text: string; truncated: boolean }>;

  /** Type literal text; does NOT submit. */
  sendText(paneId: string, text: string): Promise<void>;
  /** Send keys like "enter", "ctrl+c", or a digit for a chooser. */
  sendKeys(paneId: string, ...keys: string[]): Promise<void>;

  /** Rename the pane in the multiplexer's own view; best-effort. */
  renamePane(paneId: string, label: string): Promise<void>;
  /** Close the pane; the agent list stops listing it on the next poll. */
  closePane(paneId: string): Promise<void>;

  /** Which workspace a pane belongs to, so a new tab opens beside it. */
  workspaceOf(paneId: string): string | null;
  /** Directories that already have an agent, newest-workspace order first. */
  knownCwds(): string[];
  /** New tab/window in a cwd, running a command, unfocused. Returns the pane id. */
  newTab(opts: {
    workspaceId?: string | null;
    cwd: string;
    label?: string;
    command: string;
  }): Promise<string>;
}

/* WHICH MULTIPLEXER THIS ENGINE DRIVES, decided once at import from the env.
 *
 * Default is tmux, so nothing extra to install. `CYC_MUX=herdr` opts into the
 * herdr upgrade; `CYC_TMUX_SOCKET` names the `tmux -L` socket (the default
 * tmux socket when unset). */
export function makeMux(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Multiplexer {
  const which = (env.CYC_MUX ?? "tmux").trim().toLowerCase();
  /* THE SHARED INSTANCE, not a fresh one: makeAdapter's TmuxMuxAdapter and any
   * makeMux caller must land on the SAME TmuxMux, or a spawn path pre-links a
   * mux nobody polls and the spawned agent never surfaces (the two-instance
   * split fixed 2026-08-23). */
  if (which === "herdr") return new HerdrClient();
  return sharedTmuxMux(env.CYC_TMUX_SOCKET?.trim() || undefined);
}
