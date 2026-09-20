/* THE ROUTES CONTEXT (L4): everything a route group needs that is OWNED BY
 * BOOT rather than importable from a module. Built exactly once by the
 * composition root (ordering hazard 4: no module-level reach-ins), handed to
 * every group on every request.
 */

import type { MultiplexerAdapter } from "../adapters/mux-adapter.ts";
import type { Uploads } from "../chat/uploads.ts";
import type { Services } from "../runtime/services.ts";
import type { PluginSpec } from "../plugins/platform/spec.ts";
import type { AgentRun } from "../sessions/session-events.ts";

/* AGENT STOP HANDLER (adapter inversion). Stopping a run is
 * an OUT-OF-TREE personal-adapter capability (piagent's pi-lane kill), so core
 * never imports it. The composition root injects a handler behind the
 * CYC_PIAGENT_ADAPTER gate; the stop route 404s when none is registered
 * (behaviour-identical to the flag unset today). Given the session's parsed
 * runs and the target agentId, it decides what to stop and reports the outcome:
 *   ok:true            -> the process was signalled
 *   ok:false + status  -> a hard failure (e.g. 404 unknown agent)
 *   ok:false, no status -> a soft outcome the route answers 200 (not running) */
export type AgentStopResult =
  | { ok: true }
  | { ok: false; error: string; status?: number };

export type AgentStopHandler =
  (runs: AgentRun[], agentId: string) => Promise<AgentStopResult>;

export type RoutesCtx = {
  adapter: MultiplexerAdapter;
  uploads: Uploads;
  services: Services;
  rev: string;
  engineHost: string;
  engineUser: string;
  engineHome: string;
  /** The engine's own checkout (the directory above agent-engine/src/), or null
   *  when the layout does not look like one. The preferred default place for
   *  a new session: on macOS it is the one directory already TCC-blessed by
   *  running the engine at all. */
  engineRepo: string | null;
  voiceUrlPublic: string;
  claudeCommand: string;
  /** True when `program` resolves on this host's PATH. Injected (Bun.which at
   *  boot wiring, runtime/which.ts) so route tests stay hermetic. Called per
   *  request, never cached, so a harness installed after boot appears on the
   *  next probe. binaryOnPath("") is false (Bun.which("") is null), which is
   *  what the places computation relies on for a launch with no program token. */
  binaryOnPath(program: string): boolean;
  sendMsgMax: number;
  notifyDebug: boolean;
  voiceHealthy(): boolean;
  /** Why a voice capability must be refused right now -- its model files are
   *  not on disk yet, still downloading in the background -- or null to let
   *  the proxy answer. OPTIONAL: absent means no gate, the pre-warm-up
   *  behavior every seam test wires. */
  voiceGate?(cap: "stt" | "tts"): string | null;
  /** OPTIONAL out-of-tree adapter stop handler, injected by the composition
   *  root behind CYC_PIAGENT_ADAPTER; the stop route 404s when absent. */
  agentStopHandler?: AgentStopHandler;
  /** The engine's ONE request router, verbatim -- the same function the
   *  localhost server's fetch() and the sealed tunnel call. The resumable
   *  transfer route (routes/transfer.ts) uses it to hand its assembled bytes to
   *  the EXISTING /upload or /user-audio route, so the reply is byte-identical
   *  to a direct upload. Injected by the composition root, which owns
   *  routeRequest. */
  routeRequest(req: Request, server: import("bun").Server): Promise<Response>;
  /** LIVE plugin registry (redeclare swaps the decl list, never the specs) */
  plugins(): readonly PluginSpec[];
  pluginById(id: string): PluginSpec | undefined;
  log(event: string, fields: Record<string, unknown>): void;
};

export type RouteGroup = (ctx: RoutesCtx, req: Request, url: URL, path: string,
  server: import("bun").Server) => Promise<Response | null>;
