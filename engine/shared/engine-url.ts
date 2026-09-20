/* THE ONE ENGINE IDENTITY (CYC_ENGINE_URL), shared by every local caller so
 * the CLI, the MCP and the announce hook stop each carrying their own silent
 * 10101 default (three vars, three defaults, one long "why is my reply going
 * to the other instance").
 *
 * Canonical var: CYC_ENGINE_URL. Two accepted forms:
 *   - "http://host:port"  (or https)         -> a TCP origin
 *   - "unix:/abs/path.sock"                   -> an http-over-unix socket
 *     (a leading ~ in the path is expanded)
 *
 * When CYC_ENGINE_URL is unset the default PREFERS the local socket: if the
 * engine's socket exists on disk it is used, else the TCP loopback origin (the
 * port from resolvePorts, so CYC_PORT_BASE moves it too). This is what makes
 * the socket the default local transport the release it ships, while a box
 * that has not restarted the engine yet still reaches it over TCP.
 *
 * The VOICE_ENGINE_URL fallback and its deprecation warning are a CALLER
 * concern (each caller decides whether to honour the old var and how loud to
 * be), not baked in here: this resolver reads only the canonical var. */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePorts } from "./ports.ts";

export type EngineEnv = Record<string, string | undefined>;

/** The default engine's AGENT_PORT (no CYC_PORT_BASE, no explicit AGENT_PORT).
 *  Read from resolvePorts itself so this never drifts from the port scheme. It
 *  is the one port that keeps the bare `engine.sock` name below. */
const DEFAULT_AGENT_PORT = resolvePorts({}).AGENT_PORT;

export type EngineTarget =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; origin: string };

/** $HOME for this env, falling back to the passwd entry only when unset -- the
 *  same rule cycdir.ts uses, so a home-fenced test process (homeguard) that set
 *  HOME is honoured rather than reaching the real user's tree. */
function homeOf(env: EngineEnv): string {
  const h = env.HOME;
  return h && h.trim() ? h : homedir();
}

/** Expand a leading ~ (or ~/x) against this env's HOME. */
function expandTilde(p: string, env: EngineEnv): string {
  if (p === "~") return homeOf(env);
  if (p.startsWith("~/")) return join(homeOf(env), p.slice(2));
  return p;
}

/** The base data dir for this env: CYC_DATA_DIR, else ~/.callyourcode (the same
 *  resolution as shared/cycdir.ts, but driven by the passed env so it is pure
 *  and testable). */
function dataDirOf(env: EngineEnv): string {
  const d = env.CYC_DATA_DIR;
  if (d && d.trim()) return d.trim().replace(/\/+$/, "");
  return join(homeOf(env), ".callyourcode");
}

/** Where the engine's local unix socket lives: CYC_ENGINE_SOCK (tests) wins;
 *  else <dataDir>/engine.sock for the DEFAULT engine, and
 *  <dataDir>/engine-<port>.sock for an offset-port instance (CYC_PORT_BASE, or
 *  an explicit AGENT_PORT).
 *
 *  Deriving the filename from the RESOLVED AGENT_PORT is what gives two engines
 *  on one datadir DISTINCT sockets by construction: item 3 (port base) is the
 *  feature that invites a second same-user instance, and without this the second
 *  boot would land on the first's ~/.callyourcode/engine.sock and (with the
 *  probe in runtime/server.ts) refuse, or -- before both fixes -- silently
 *  hijack it. The engine binds exactly this path (runtime/server.ts) and the
 *  default resolution below probes it, so the two never disagree. */
export function defaultSockPath(env: EngineEnv): string {
  const override = env.CYC_ENGINE_SOCK;
  if (override && override.trim()) return expandTilde(override.trim(), env);
  const port = resolvePorts(env).AGENT_PORT;
  const name = port === DEFAULT_AGENT_PORT ? "engine.sock" : `engine-${port}.sock`;
  return join(dataDirOf(env), name);
}

/** Parse an explicit CYC_ENGINE_URL value into a target. Throws on a shape this
 *  resolver does not accept, so a typo fails loud rather than silently reaching
 *  the default. */
export function parseEngineUrl(raw: string, env: EngineEnv): EngineTarget {
  const v = raw.trim();
  if (v.startsWith("unix:")) {
    return { kind: "unix", path: expandTilde(v.slice("unix:".length), env) };
  }
  const u = new URL(v); // throws on garbage
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`CYC_ENGINE_URL: unsupported scheme ${u.protocol} (use http://host:port or unix:/path.sock)`);
  }
  return { kind: "tcp", origin: u.origin };
}

/** The engine target for this env: the canonical var when set, else the socket
 *  if it exists, else the TCP loopback default. */
export function resolveEngine(env: EngineEnv): EngineTarget {
  const raw = (env.CYC_ENGINE_URL ?? "").trim();
  if (raw) return parseEngineUrl(raw, env);
  const sock = defaultSockPath(env);
  if (existsSync(sock)) return { kind: "unix", path: sock };
  return { kind: "tcp", origin: `http://127.0.0.1:${resolvePorts(env).AGENT_PORT}` };
}

/** A human-readable label for a target (error messages, doctor output). */
export function engineLabel(t: EngineTarget): string {
  return t.kind === "unix" ? `unix:${t.path}` : t.origin;
}

/** fetch against a target: http-over-unix for the socket (Bun's {unix} option),
 *  a plain origin fetch for TCP. `path` is the request path (e.g. "/health"). */
export function engineFetch(t: EngineTarget, path: string, init?: RequestInit): Promise<Response> {
  if (t.kind === "unix") {
    // The host in the URL is ignored when {unix} is set, but must be a valid
    // absolute URL; localhost is the honest placeholder.
    return fetch(`http://localhost${path}`, { ...init, unix: t.path } as RequestInit & { unix: string });
  }
  return fetch(t.origin + path, init);
}
