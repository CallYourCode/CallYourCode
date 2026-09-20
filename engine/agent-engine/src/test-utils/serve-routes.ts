/* REAL HTTP AGAINST THE REAL ROUTE CODE, WITHOUT AN ENGINE.
 *
 * server.ts's route table is a list of RouteGroups, each a pure
 * `(ctx, req, url, path, server) => Response | null` over a RoutesCtx that boot
 * owns. That shape is what makes this cheap: a test names the groups it cares
 * about, fills in the two or three ctx members its route actually reads, and
 * gets a Bun.serve ON PORT 0 that dispatches exactly the way server.ts's
 * routeRequest does.
 *
 * Everything a route does not touch is filled in with a member that THROWS if
 * called, not a silent stub. A route that starts reaching for the uploads store
 * should fail in the test that did not give it one, rather than pass against a
 * no-op and 500 in production.
 *
 * Port 0 always. No unit or seam test may write a port number; gates.test.ts
 * enforces it.
 */

import type { RouteGroup, RoutesCtx } from "../routes/ctx.ts";
import type { PluginSpec } from "../plugins/platform/spec.ts";

/** A member nobody wired: loud rather than empty. */
function absent<T>(what: string): T {
  return new Proxy({} as object, {
    get(_t, prop) {
      if (prop === "then") return undefined; // so an await on it does not hang
      throw new Error(
        `this route reached for ctx.${what}.${String(prop)}, and the test did not wire ${what}. ` +
        "Pass it in serveRoutes({ ctx: { ... } }).");
    },
  }) as T;
}

export type ServedRoutes = {
  /** where the server is listening; port was chosen by the OS */
  url: string;
  port: number;
  /** fetch against it with a path, e.g. get("/health") */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  get(path: string, init?: RequestInit): Promise<Response>;
  /** POST a JSON body */
  post(path: string, body: unknown, init?: RequestInit): Promise<Response>;
  /** every ctx.log() line the routes wrote, in order */
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  /** the ctx the groups are actually running against, for a test that wants to
   *  move a value mid-flight (rev, voiceHealthy, the plugin list) */
  ctx: RoutesCtx;
  stop(): void;
};

export type ServeRoutesOpts = {
  groups: RouteGroup[];
  /** whatever this test's routes actually read. Anything left out is `absent`. */
  ctx?: Partial<RoutesCtx>;
  /** answered for any path no group claimed. 404 by default, as server.ts does. */
  fallback?: (req: Request, url: URL) => Response | Promise<Response> | null;
  /** websocket handlers, for the two groups that upgrade (voice relay) */
  websocket?: import("bun").WebSocketHandler<any>;
  /** override server.ts's 320MB body ceiling, for a test that wants to prove
   *  what happens BELOW the engine's own caps */
  maxRequestBodySize?: number;
  /** override server.ts's 30s idle timeout */
  idleTimeout?: number;
};

export function serveRoutes(o: ServeRoutesOpts): ServedRoutes {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let plugins: readonly PluginSpec[] = o.ctx?.plugins?.() ?? [];

  const ctx: RoutesCtx = {
    adapter: absent("adapter"),
    uploads: absent("uploads"),
    services: absent("services"),
    rev: "test-rev",
    engineHost: "probe",
    engineUser: "tester",
    engineHome: "/tmp/does-not-exist",
    engineRepo: null,
    voiceUrlPublic: "",
    claudeCommand: "claude",
    binaryOnPath: () => true,
    sendMsgMax: 1_000_000,
    notifyDebug: false,
    voiceHealthy: () => true,
    routeRequest: absent("routeRequest"),
    plugins: () => plugins,
    pluginById: (id) => plugins.find((p) => p.id === id),
    log: (event, fields) => { logs.push({ event, fields }); },
    ...o.ctx,
  };
  if (o.ctx?.plugins) plugins = o.ctx.plugins();

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    /* THE SAME TWO LIMITS server.ts SETS, because otherwise this rig refuses
     * things the engine accepts and a route-level cap test proves the wrong
     * layer. Bun's default maxRequestBodySize is 128MB, and it answers a
     * bodyless 413 of its own BEFORE any handler runs: the 300MB upload class
     * (UPLOAD_BODY_MAX_BYTES) could not be exercised here at all, so a test
     * would be measuring Bun's default rather than the engine's cap. The
     * idleTimeout is 30s for the same reason server.ts raises it: a slow but
     * legitimate request must be able to answer. */
    maxRequestBodySize: o.maxRequestBodySize ?? 320 * 1024 * 1024,
    idleTimeout: o.idleTimeout ?? 30,
    ...(o.websocket ? { websocket: o.websocket } : {}),
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      for (const group of o.groups) {
        const res = await group(ctx, req, url, path, srv);
        if (res) return res;
      }
      return (await o.fallback?.(req, url)) ?? new Response("not found", { status: 404 });
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  return {
    url: base,
    port: server.port,
    fetch: (p, init) => fetch(base + p, init),
    get: (p, init) => fetch(base + p, init),
    post: (p, body, init) => fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
    logs,
    ctx,
    stop: () => server.stop(true),
  };
}
