/* THE WHOLE ROUTE SURFACE IS GATED, MECHANICALLY + DEFAULT-DENY.
 *
 * control-localhost.test.ts drives a HAND-CURATED table of routes over the real
 * Bun.serve and proves each refuses a tailnet/proxied peer. Its weakness is the
 * curation: it omits all /voice/*, all /plugin/*, all /transfer/*, /new-session,
 * /session/:id/restart|exit|trim-log|page, /chat-search, /doc/*, /user-audio,
 * /upload* -- a NEW ungated route would not be in the table and CI would stay
 * green. This file closes that hole two ways:
 *
 *   THE MECHANICAL CENTERPIECE: read the SOURCE of every engine route
 *     group + the server.ts pre-table routes and assert, via a control-flow
 *     lexer, that every content-answering `return` is dominated by an auth gate
 *     (requireOwner / requireLocal / isTrustedLocal). The only ungated answers
 *     allowed are an EXPLICIT, commented allowlist (/health, OPTIONS preflight,
 *     the / redirect, the 404 fall-through). A newly added handler that answers
 *     without gating is not on that allowlist, so it fails here.
 *
 *   RUNTIME CONFIRMATION: drive ALL route groups over the real Bun.serve
 *     with a peer shim and assert a representative request on every route family
 *     is 403 for a TAILNET and a PROXIED peer. This confirms the static verdict
 *     at runtime for the broad surface control-localhost does not cover.
 *
 *   DEFAULT-DENY FALL-THROUGH: an unknown route/method is 404 with no side
 *     effect, and an unknown-path OPTIONS is a preflight, never a mutation --
 *     plus a static pin that server.ts's real router OPTIONS-answers 204 and
 *     falls through to 404 (runtime/server.ts).
 *
 * If the mechanical scan flags an un-allowlisted ungated route, that is a REAL HOLE: do not add
 * it to the allowlist to make this pass; report it.
 *
 *   bun test agent-engine/src/runtime/route-gate-surface.test.ts
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractFunctionBody, scanBody, type ContentReturn } from "../test-utils/route-gate-scan.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { voiceRoutes } from "../routes/voice.ts";
import { healthRoutes } from "../routes/health.ts";
import { mediaRoutes } from "../routes/media.ts";
import { chatRoutes } from "../routes/chat.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { pluginRoutes } from "../routes/plugin.ts";
import { transferRoutes } from "../routes/transfer.ts";
import type { RouteGroup } from "../routes/ctx.ts";

const ROUTES_DIR = join(import.meta.dir, "../routes");
const SERVER_TS = join(import.meta.dir, "server.ts");

/* ------------------------------------------------------------------ source-scan data
 *
 * Each engine route source, the exported group function to scan, and the
 * EXPLICIT allowlist of content returns that are intentionally ungated. Every
 * allowlist entry names WHY it is safe to answer without an owner/local gate.
 * A `match` is a distinctive substring of the ungated answer; the test requires
 * every ungated finding to match one allowlist entry (subset), so a NEW ungated
 * answer that matches nothing is a failure. */
type SurfaceSource = {
  name: string;
  file: string;
  header: string;
  /** intentionally-ungated content returns; each entry: the reason + a match */
  allowlist: Array<{ why: string; match: string }>;
};

const SOURCES: SurfaceSource[] = [
  { name: "voice.ts", file: join(ROUTES_DIR, "voice.ts"),
    header: "export async function voiceRoutes", allowlist: [] },
  { name: "health.ts", file: join(ROUTES_DIR, "health.ts"),
    header: "export async function healthRoutes",
    allowlist: [
      // GET /health: a bootstrap-metadata read trimmed to {ok, rev} and nothing
      // else (host telemetry moved to the sealed channel). The deploy report
      // needs it before any device is enrolled, so it is deliberately open; it
      // exposes no content and mutates nothing.
      { why: "/health is an open {ok, rev} bootstrap read, no content, no mutation",
        match: "ok: true, rev: ctx.rev" },
    ] },
  { name: "media.ts", file: join(ROUTES_DIR, "media.ts"),
    header: "export async function mediaRoutes", allowlist: [] },
  { name: "chat.ts", file: join(ROUTES_DIR, "chat.ts"),
    header: "export async function chatRoutes", allowlist: [] },
  { name: "session-ops.ts", file: join(ROUTES_DIR, "session-ops.ts"),
    header: "export async function sessionOpsRoutes", allowlist: [] },
  { name: "plugin.ts", file: join(ROUTES_DIR, "plugin.ts"),
    header: "export async function pluginRoutes", allowlist: [] },
  { name: "transfer.ts", file: join(ROUTES_DIR, "transfer.ts"),
    header: "export async function transferRoutes", allowlist: [] },
  { name: "server.ts routeRequest (pre-table)", file: SERVER_TS,
    header: "async function routeRequest(req: Request, server: import(\"bun\").Server): Promise<Response>",
    allowlist: [
      // OPTIONS preflight: a bodyless 204, no handler, no side effect, and
      // since the H1 fix NO CORS grant at all (a browser preflight finds
      // nothing allowed). The preflight answers nothing a peer could read or
      // mutate, and a disallowed browser Origin never even reaches it
      // (refuseForbiddenOrigin runs before the router on the TCP feed).
      { why: "OPTIONS preflight is a bodyless 204 with no grant and no side effect",
        match: "status: 204" },
      // GET /: a 302 redirect to the app front. Serves no engine content.
      { why: "GET / is a 302 redirect to the app front, no content",
        match: "the engine UI is the app front" },
      // The default-deny fall-through: an unmatched route/method is a bare 404
      // with no side effect. This is the tail of the router (the default-deny fall-through).
      { why: "the default-deny 404 fall-through",
        match: "\"not found\", { status: 404 }" },
    ] },
];

/* ------------------------------------------------------------------ source-scan test */

test("every content-answering route return is dominated by an auth gate", () => {
  let totalGates = 0;
  for (const src of SOURCES) {
    const source = readFileSync(src.file, "utf8");
    const body = extractFunctionBody(source, src.header);
    const r = scanBody(body);
    totalGates += r.gates;

    // scanner sanity: it actually parsed a body and found gate calls (a parser
    // that silently extracted nothing would report zero and pass vacuously).
    expect(r.gates, `${src.name}: the scanner found no gate calls (parser broke?)`).toBeGreaterThan(0);
    expect(r.contentReturns, `${src.name}: the scanner found no content returns`).toBeGreaterThan(0);

    // THE TRIPWIRE: every ungated content return must be on the explicit
    // allowlist. An extra one is a route that answers without a gate.
    const unexplained: ContentReturn[] = r.ungated.filter(
      (u) => !src.allowlist.some((a) => u.context.includes(a.match)),
    );
    expect(unexplained.map((u) => `@${u.offset}: ${u.context}`),
      `${src.name}: an UNGATED content route is not on the allowlist -- a real hole, ` +
      `do not weaken this test`).toEqual([]);
  }
  // a global floor so a scanner regression that finds a handful of gates is caught
  expect(totalGates, "the scanner found suspiciously few gates across the surface").toBeGreaterThanOrEqual(30);
});

test("server.ts's real router OPTIONS-answers 204 and default-denies to 404", () => {
  /* control-localhost proves OPTIONS on a KNOWN path is not a bypass; this pins
   * the two lines the route table falls THROUGH to for anything it did not
   * claim -- the 204 preflight and the 404 tail (runtime/server.ts). */
  const body = extractFunctionBody(
    readFileSync(SERVER_TS, "utf8"),
    "async function routeRequest(req: Request, server: import(\"bun\").Server): Promise<Response>",
  );
  // OPTIONS is answered with a bodyless 204 (no CORS grant), before the route table.
  expect(body).toContain("req.method === \"OPTIONS\"");
  expect(body).toMatch(/new Response\(null, \{ status: 204/);
  // the tail is a bare 404, no side effect.
  expect(body.trimEnd()).toMatch(/new Response\("not found", \{ status: 404 \}\);\s*$/);
});

/* ------------------------------------------------------------------ runtime peer-refusal setup
 *
 * The peer shim from control-localhost.test.ts: wrap each real group with a
 * server whose requestIP() answers whatever x-test-peer says, so one served
 * port can play a tailnet peer and a tailscale-serve proxied peer against the
 * real httpx gate. */
function asPeer(group: RouteGroup): RouteGroup {
  return (ctx, req, url, path, server) => {
    const claimed = req.headers.get("x-test-peer") ?? "127.0.0.1";
    const shim = {
      requestIP: () => claimed === "none" ? null : { address: claimed, family: "IPv4", port: 0 },
    } as unknown as import("bun").Server;
    return group(ctx, req, url, path, shim);
  };
}

const TAILNET = { "x-test-peer": "100.64.0.55" };
const PROXIED = { "x-test-peer": "127.0.0.1", "x-forwarded-for": "100.64.0.55" };

const HEX64 = "a".repeat(64);
const uuid = () => crypto.randomUUID();

/* One representative request per route family. On the REFUSAL path the gate
 * returns before any ctx member or body is read, which is why the served ctx
 * can stay minimal (the same reason control-localhost leaves members absent).
 * requireOwner routes answer 403 to a tailnet/proxied peer; requireLocal routes
 * (/agents, /agent-message) answer 403 to them too -- both are non-host. */
type Probe = { name: string; method: string; path: string };
const PROBES: Probe[] = [
  // voice.ts
  { name: "voice/stt", method: "POST", path: "/voice/stt" },
  { name: "voice/tts", method: "POST", path: "/voice/tts" },
  { name: "voice/voices", method: "GET", path: "/voice/voices" },
  { name: "voice-log", method: "GET", path: "/voice-log" },
  { name: "voices/default", method: "POST", path: "/voices/default" },
  { name: "session/:id/voice", method: "POST", path: "/session/sess1/voice" },
  // health.ts (mutating one only; /health is intentionally open, /debug is covered by the off-channel loopback test)
  { name: "services/:k/restart", method: "POST", path: "/services/kokoro/restart" },
  // media.ts
  { name: "user-audio", method: "POST", path: "/user-audio" },
  { name: "upload", method: "POST", path: "/upload" },
  { name: "upload/:id", method: "GET", path: `/upload/${uuid()}` },
  { name: "audio/:id.mp3", method: "GET", path: `/audio/${uuid()}.mp3` },
  { name: "session/:id/photo", method: "POST", path: "/session/sess1/photo" },
  { name: "session-photo/:id", method: "GET", path: "/session-photo/sess1" },
  { name: "doc/:id/raw", method: "GET", path: `/doc/${uuid()}/raw` },
  { name: "doc/:id/state GET", method: "GET", path: `/doc/${uuid()}/state` },
  { name: "doc/:id/state POST", method: "POST", path: `/doc/${uuid()}/state` },
  { name: "doc/:id", method: "GET", path: `/doc/${uuid()}` },
  // chat.ts
  { name: "session/:id/page/:n", method: "GET", path: "/session/sess1/page/0" },
  { name: "session/:id/trim-log", method: "POST", path: "/session/sess1/trim-log" },
  { name: "chat-search/:id", method: "GET", path: "/chat-search/sess1" },
  // session-ops.ts
  { name: "session-agents/:id", method: "GET", path: "/session-agents/sess1" },
  { name: "session-agents/:id/stop", method: "POST", path: "/session-agents/sess1/stop" },
  { name: "session/:id/rename", method: "POST", path: "/session/sess1/rename" },
  { name: "session/:id/unread", method: "POST", path: "/session/sess1/unread" },
  { name: "sessions/order", method: "POST", path: "/sessions/order" },
  { name: "session/:id/settings", method: "POST", path: "/session/sess1/settings" },
  { name: "new-session/places", method: "GET", path: "/new-session/places" },
  { name: "new-session", method: "POST", path: "/new-session" },
  { name: "session/:id/exit", method: "POST", path: "/session/sess1/exit" },
  { name: "session/:id/restart", method: "POST", path: "/session/sess1/restart" },
  { name: "agents (requireLocal)", method: "GET", path: "/agents" },
  { name: "session/:id/agent-message (requireLocal)", method: "POST", path: "/session/sess1/agent-message" },
  // plugin.ts
  { name: "plugin/:id/card", method: "GET", path: "/plugin/p1/card" },
  { name: "plugin/:id/panel", method: "GET", path: "/plugin/p1/panel" },
  { name: "plugin/:id/rpc/:op", method: "POST", path: "/plugin/p1/rpc/op" },
  { name: "plugin/:id/state GET", method: "GET", path: "/plugin/p1/state" },
  { name: "plugin/:id/state POST", method: "POST", path: "/plugin/p1/state" },
  // transfer.ts
  { name: "transfer/begin", method: "POST", path: "/transfer/begin" },
  { name: "transfer/:id/:n PUT", method: "PUT", path: `/transfer/${HEX64}/0` },
  { name: "transfer/:id GET", method: "GET", path: `/transfer/${HEX64}` },
  { name: "transfer/:id DELETE", method: "DELETE", path: `/transfer/${HEX64}` },
  { name: "transfer/:id/finish", method: "POST", path: `/transfer/${HEX64}/finish` },
];

let srv: ServedRoutes;
const OLD_DATA_DIR = process.env.CYC_DATA_DIR;

beforeAll(() => {
  process.env.CYC_DATA_DIR = "/tmp/does-not-exist-route-gate-surface";
  srv = serveRoutes({
    groups: [voiceRoutes, healthRoutes, mediaRoutes, chatRoutes,
      sessionOpsRoutes, pluginRoutes, transferRoutes].map(asPeer),
    // notifyDebug stays false: the /debug route is proven in off-channel-local.test.ts
    ctx: {},
  });
});

afterAll(() => {
  srv?.stop();
  if (OLD_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = OLD_DATA_DIR;
});

test("every route family refuses a TAILNET peer with 403", async () => {
  for (const p of PROBES) {
    const res = await srv.fetch(p.path, { method: p.method, headers: TAILNET });
    expect(res.status, `${p.name} (${p.method} ${p.path}) did not refuse a direct tailnet peer`).toBe(403);
  }
});

test("every route family refuses a PROXIED loopback peer (tailscale-serve shape) with 403", async () => {
  for (const p of PROBES) {
    const res = await srv.fetch(p.path, { method: p.method, headers: PROXIED });
    expect(res.status, `${p.name} (${p.method} ${p.path}) trusted a proxied loopback peer`).toBe(403);
  }
});

/* ------------------------------------------------------------------ origin-refusal
 *
 * THE DRIVE-BY SHAPE (H1): a web page open in a browser ON the engine host
 * fetches 127.0.0.1:10101. The TCP peer is loopback and no proxy stamped an
 * x-forwarded-for, which is exactly what isTrustedLocal used to trust; the
 * Origin header is what names the page, and the gate refuses a disallowed one.
 * This drives the SAME probes as the source scan and runtime refusal so the whole route surface is pinned,
 * not a curated subset. server.ts additionally refuses these before the router
 * on the real serve (refuseForbiddenOrigin, pinned statically below); here the
 * groups are served bare, so a 403 proves the gate-level defense in depth. */
const DRIVE_BY = { "x-test-peer": "127.0.0.1", origin: "https://evil.example.com" };
const TS_NET_PAGE = { "x-test-peer": "127.0.0.1", origin: "https://evil-box.attacker-tailnet.ts.net" };

test("every route family refuses a HOST-loopback request carrying a disallowed browser Origin", async () => {
  for (const p of PROBES) {
    const res = await srv.fetch(p.path, { method: p.method, headers: DRIVE_BY });
    expect(res.status, `${p.name} (${p.method} ${p.path}) trusted a drive-by browser page`).toBe(403);
  }
});

test("a *.ts.net origin is NOT a skeleton key (tailscale funnel serves those publicly)", async () => {
  for (const p of PROBES) {
    const res = await srv.fetch(p.path, { method: p.method, headers: TS_NET_PAGE });
    expect(res.status, `${p.name} (${p.method} ${p.path}) trusted a foreign-tailnet page`).toBe(403);
  }
});

/* ------------------------------------------------------------------ host / DNS-rebinding
 *
 * THE DNS-REBINDING SHAPE: an attacker page re-points its own domain at
 * 127.0.0.1 after it loads, so the browser reaches this engine from a TRUE
 * loopback peer with NO Origin header at all (top-level navigation,
 * same-origin GET) -- the exact shape the origin check cannot see. The Host header still
 * names the attacker's domain, and the host gate inside isTrustedLocal
 * refuses it on every gated route (server.ts additionally refuses it before
 * the router on the real serve; pinned statically in the static origin-gate test). Every other test in
 * this file doubles as the positive control: real fetch stamps the loopback
 * Host "127.0.0.1:<port>", and the runtime and origin probes reach the gates (their 403s
 * are peer/origin refusals, not host ones). */
const REBOUND = { "x-test-peer": "127.0.0.1", host: "evil.example.com" };
const REBOUND_PORT = { "x-test-peer": "127.0.0.1", host: "evil.example.com:51018" };

test("every route family refuses a loopback-peer request whose Host is an attacker domain (DNS rebinding)", async () => {
  for (const p of PROBES) {
    const res = await srv.fetch(p.path, { method: p.method, headers: REBOUND });
    expect(res.status, `${p.name} (${p.method} ${p.path}) trusted a rebound Host`).toBe(403);
    const resPort = await srv.fetch(p.path, { method: p.method, headers: REBOUND_PORT });
    expect(resPort.status, `${p.name} (${p.method} ${p.path}) trusted a rebound Host:port`).toBe(403);
  }
});

/* ------------------------------------------------------------------ static
 * origin-gate + CORS pins over the real server.ts source and the whole src
 * tree, so neither can quietly regress. */

test("server.ts refuses a forbidden Host, then a forbidden Origin, BEFORE the router on the TCP feed", () => {
  const source = readFileSync(SERVER_TS, "utf8");
  /* The exact wiring: the Bun.serve fetch handler runs refuseForbiddenHost
   * (the DNS-rebinding gate: an unexpected or missing Host is 403), then
   * refuseForbiddenOrigin, and only falls through to routeRequest when both
   * return null. The sealed tunnel feed (initTunnel) calls routeRequest
   * directly and must NOT pass through either refusal. */
  expect(source).toContain(
    "fetch: (req, server) => refuseForbiddenHost(req) ?? refuseForbiddenOrigin(req) ?? routeRequest(req, server)");
});

test("no engine source grants cross-origin access (no access-control-allow-origin anywhere)", () => {
  /* The H1 hole was access-control-allow-origin: "*" on every answer. The
   * grant is GONE, not narrowed: nothing in src/ may emit the header at all.
   * (Tests may still ASSERT on the header name; only non-test sources are
   * scanned.) A reappearing grant is a regression, not a feature. */
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      if (readFileSync(p, "utf8").toLowerCase().includes("access-control-allow-origin"))
        offenders.push(p);
    }
  };
  walk(join(import.meta.dir, ".."));
  // the shared helpers the engine answers with (bodyread's 413) count too
  walk(join(import.meta.dir, "../../..", "shared"));
  expect(offenders, "a source file emits or names a CORS grant header").toEqual([]);
});

/* ------------------------------------------------------------------ default-deny runtime */

test("an unknown route/method is 404 over the real serve, no side effect", async () => {
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    const res = await srv.fetch(`/no-such-route-${method.toLowerCase()}`, { method, headers: TAILNET });
    expect(res.status, `${method} on an unknown path was not a 404 default-deny`).toBe(404);
  }
  // the served ctx wires no mutating store; a 404 fall-through touching one
  // would have thrown the absent() proxy, so reaching here is the no-side-effect proof
});

test("an OPTIONS on an unknown path is a preflight/deny, never a mutation", async () => {
  const res = await srv.fetch("/no-such-route-options", { method: "OPTIONS", headers: TAILNET });
  // serveRoutes has no OPTIONS handler of its own, so an unclaimed OPTIONS falls
  // through to 404; the real server.ts answers 204 (pinned statically above).
  // Either way it is a preflight/deny, not a 2xx mutation.
  expect([204, 404]).toContain(res.status);
});
