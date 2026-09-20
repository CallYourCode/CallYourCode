/* THE OFF-CHANNEL LOOPBACK-ONLY WHITELIST REFUSES EVERY NON-LOCAL PEER.
 *
 * A handful of surfaces are deliberately reachable ONLY by a process on the
 * engine's own host -- not the tailnet, and not even a paired device over the
 * sealed tunnel (requireLocal / inline isTrustedLocal have NO fromSealedTunnel
 * branch, unlike requireOwner). They are the on-machine control seams: the MCP
 * beside the agent (/agent/reply, /agent/info), the harness hook
 * (/harness/announce), the `cyc` CLI (/agents), governor scripts + cron
 * (/session/:id/agent-message), and a debug probe (/debug/session-companions).
 *
 * This file pins that they answer 403 to a TAILNET peer and to a PROXIED
 * loopback peer (the tailscale-serve shape), and pass for the engine HOST. The
 * servable ones are driven over the real Bun.serve with a peer shim; the two
 * pre-table ones that live in server.ts's routeRequest (not a RouteGroup) are
 * pinned statically to be LOCAL-only gated (isTrustedLocal / requireLocal, never
 * requireOwner), which -- combined with httpx.test.ts's proof that those gates
 * 403 a non-loopback/proxied peer and route-gate-surface.test.ts's proof they
 * are the handler's first effect -- is the same guarantee.
 *
 *   bun test agent-engine/src/runtime/off-channel-local.test.ts
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { healthRoutes } from "../routes/health.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { extractFunctionBody } from "../test-utils/route-gate-scan.ts";
import type { RouteGroup } from "../routes/ctx.ts";

const SERVER_TS = join(import.meta.dir, "server.ts");

function asPeer(group: RouteGroup): RouteGroup {
  return (ctx, req, url, path, server) => {
    const claimed = req.headers.get("x-test-peer") ?? "127.0.0.1";
    const shim = {
      requestIP: () => claimed === "none" ? null : { address: claimed, family: "IPv4", port: 0 },
    } as unknown as import("bun").Server;
    return group(ctx, req, url, path, shim);
  };
}

const HOST = { "x-test-peer": "127.0.0.1" };
const TAILNET = { "x-test-peer": "100.64.0.55" };
const PROXIED = { "x-test-peer": "127.0.0.1", "x-forwarded-for": "100.64.0.55" };

let srv: ServedRoutes;
const OLD_DATA_DIR = process.env.CYC_DATA_DIR;

beforeAll(() => {
  process.env.CYC_DATA_DIR = "/tmp/does-not-exist-off-channel";
  srv = serveRoutes({
    groups: [healthRoutes, sessionOpsRoutes].map(asPeer),
    // the debug probe is behind ctx.notifyDebug; turn it on so the route exists
    // to be gated (off in prod, defense-in-depth requireLocal even when on).
    ctx: { notifyDebug: true },
  });
});

afterAll(() => {
  srv?.stop();
  if (OLD_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = OLD_DATA_DIR;
});

/* The servable loopback-only routes and how each is driven. */
type Local = { name: string; method: string; path: string };
const SERVABLE: Local[] = [
  { name: "/agents", method: "GET", path: "/agents" },
  { name: "/session/:id/agent-message", method: "POST", path: "/session/sess1/agent-message" },
  { name: "/debug/session-companions", method: "GET", path: "/debug/session-companions" },
];

test("T4: each loopback-only route refuses a TAILNET and a PROXIED peer with 403", async () => {
  for (const r of SERVABLE) {
    for (const peer of [TAILNET, PROXIED]) {
      const res = await srv.fetch(r.path, {
        method: r.method,
        headers: { "content-type": "application/json", ...peer },
        body: r.method === "POST" ? "{}" : undefined,
      });
      const which = peer === TAILNET ? "tailnet" : "proxied";
      expect(res.status, `${r.name} let a ${which} peer through`).toBe(403);
    }
  }
});

test("T4: each loopback-only route passes for the engine HOST", async () => {
  // /agents lists the (empty) session set -> 200
  const agents = await srv.fetch("/agents", { method: "GET", headers: HOST });
  expect(agents.status, "the cyc CLI could not read /agents on its own host").toBe(200);
  expect((await agents.json()).ok).toBe(true);

  // /debug/session-companions answers the probe json for the host -> 200
  const debug = await srv.fetch("/debug/session-companions", { method: "GET", headers: HOST });
  expect(debug.status, "the debug probe refused the host").toBe(200);

  // /agent-message reaches its own validation past the gate (no such session /
  // empty body) -> NOT a 403; the gate opened for the host.
  const am = await srv.fetch("/session/sess1/agent-message", {
    method: "POST", headers: { "content-type": "application/json", ...HOST }, body: "{}",
  });
  expect(am.status, "agent-message refused the host at the gate").not.toBe(403);
});

/* -------------------------------- the two pre-table routes (server.ts inline) */

test("T4-static: /agent/reply and /agent/info are inline LOOPBACK-only (isTrustedLocal, not requireOwner)", () => {
  const body = extractFunctionBody(
    readFileSync(SERVER_TS, "utf8"),
    "async function routeRequest(req: Request, server: import(\"bun\").Server): Promise<Response>",
  );
  for (const [route, refusal] of [
    ["/agent/reply", "agent-reply is local-only (this machine)"],
    ["/agent/info", "agent-info is local-only (this machine)"],
  ] as const) {
    const at = body.indexOf(`path === "${route}"`);
    expect(at, `${route} handler not found in routeRequest`).toBeGreaterThan(-1);
    // the handler's window, up to the next pre-table branch
    const win = body.slice(at, at + 600);
    // gated loopback-only as the FIRST effect, and NOT via requireOwner (which
    // would also admit the sealed tunnel -- these must be host-only).
    expect(win, `${route} is not isTrustedLocal-gated`).toContain("if (!isTrustedLocal(req, server))");
    expect(win, `${route} lost its local-only refusal`).toContain(refusal);
    const gateAt = win.indexOf("isTrustedLocal(req, server)");
    const ownerAt = win.indexOf("requireOwner(");
    expect(ownerAt === -1 || gateAt < ownerAt,
      `${route} must be local-only, never requireOwner (that would admit the tunnel)`).toBe(true);
  }
});

test("T4-static: /harness/announce is requireLocal (host-only, no tunnel branch)", () => {
  const body = extractFunctionBody(
    readFileSync(SERVER_TS, "utf8"),
    "async function routeRequest(req: Request, server: import(\"bun\").Server): Promise<Response>",
  );
  const at = body.indexOf(`path === "/harness/announce"`);
  expect(at, "/harness/announce handler not found").toBeGreaterThan(-1);
  const win = body.slice(at, at + 400);
  // requireLocal as the first effect, before the announce body is read/handled.
  expect(win, "/harness/announce lost its requireLocal gate").toContain("requireLocal(req, server)");
  const gateAt = win.indexOf("requireLocal(req, server)");
  const handleAt = win.indexOf("handleAnnounce(");
  expect(gateAt).toBeGreaterThan(-1);
  expect(handleAt === -1 || gateAt < handleAt,
    "the announce body is handled before the requireLocal gate").toBe(true);
});
