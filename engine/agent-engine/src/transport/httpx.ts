/* HTTP CROSS-CUTTING HELPERS (L1): the browser-origin gate, the json() answer
 * shape, and the auth gates every content/mutating route shares
 * (BRIEF-control-localhost). requireOwner answers for two callers only: the
 * engine host itself (isTrustedLocal) and the sealed DataChannel tunnel
 * (markSealedTunnel). No bearer exists at all: the x-cyc-cap machinery is
 * DELETED (sealed-transport plan, engine enforcement), not merely ignored.
 *
 * CORS IS GONE (H1 fix). The engine used to answer every request with the
 * CORS allow-origin wildcard, which let ANY web page a browser on this host
 * visited read engine responses cross-origin. Nothing legitimate ever needed
 * it: the app reaches this engine over the sealed DataChannel tunnel only
 * (engineCapFetch), never by browser fetch, and every non-browser caller (the
 * cyc CLI, the harness hooks, the MCP) is CORS-exempt by nature. So no
 * response carries any CORS grant header now (route-gate-surface scans for
 * one mechanically), and the origin gate below refuses the request itself. */

import { hostname } from "node:os";
import { isLoopback } from "./wire.ts";

/* THE SEALED TUNNEL IS THE SECOND OWNER.
 *
 * A request the sealed DataChannel reassembled (tunnel-glue.ts onReq) is already
 * proven to come from an enrolled device: the channel carried it through the v2
 * sec handshake before onReq ever built a Request, so the frame behind it is
 * owner-authenticated by the transport itself, which is exactly what the old
 * x-cyc-cap header only CLAIMED to prove. onReq marks the in-process Request it
 * builds; requireOwner treats a marked request as the owner.
 *
 * A remote HTTP caller can never be in this set: Bun.serve hands the gate a
 * DIFFERENT Request object, the one it received off the socket, and nothing ever
 * places that object here. So the mark cannot be forged over the wire the way a
 * header can. A WeakSet, so the mark dies with the request and needs no teardown. */
const sealedTunnelReqs = new WeakSet<Request>();
export function markSealedTunnel(req: Request): void {
  sealedTunnelReqs.add(req);
}
function fromSealedTunnel(req: Request): boolean {
  return sealedTunnelReqs.has(req);
}

/* THE LOCAL UNIX SOCKET IS A THIRD TRUSTED CALLER (engine-socket plan, item 1).
 *
 * The engine listens on a SECOND Bun.serve bound to ~/.callyourcode/engine.sock
 * (mode 0600 under the 0700 data dir), beside the loopback TCP listen. A peer
 * that reached the engine through that socket is same-uid BY FILESYSTEM
 * PERMISSION -- only this user can open it -- which is a stronger, user-scoped
 * proof than "the packet came from 127.0.0.1" ever was (any local uid can dial
 * loopback TCP). The socket listener marks each in-process Request it builds
 * (markLocalSocket) exactly as the sealed tunnel marks its own, and
 * isTrustedLocal trusts a marked request before it even looks at requestIP
 * (which is null for a unix peer). A WeakSet, so the mark dies with the request. */
const localSocketReqs = new WeakSet<Request>();
export function markLocalSocket(req: Request): void {
  localSocketReqs.add(req);
}
export function fromLocalSocket(req: Request): boolean {
  return localSocketReqs.has(req);
}

export const json = (v: unknown, status = 200, extra?: Record<string, string>) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

/* THE BROWSER ORIGIN GATE (H1). A browser ALWAYS sends an Origin header on a
 * cross-origin request (fetch, XHR, ws upgrade, form post); a non-browser
 * caller on this machine (the cyc CLI, the harness curl hooks, the MCP, cron)
 * never sends one. So: a request that carries an Origin the engine does not
 * recognise is a web page reaching into 127.0.0.1:10101, and it is refused
 * outright, before any route runs. A request with NO Origin header is
 * untouched, which is exactly what keeps every local script working.
 *
 * WHAT IS ALLOWED, and why it is this small:
 *   1. Loopback-hosted origins (localhost / 127.0.0.1 / [::1], any port, http
 *      or https): the machine's own served pages, which is where the app
 *      server's default serve (:10100) and a dev vite page live. A drive-by
 *      internet page can never present a loopback origin.
 *   2. The exact origin of APP_SERVER_URL and of ENGINE_PUBLIC_URL, when
 *      configured non-loopback: the fronts this engine is TOLD serve its app.
 *
 * DELIBERATELY NOT ALLOWED: a blanket *.ts.net suffix (the old, never-wired
 * forbiddenWsOrigin allowed it). Any tailscale user owns *.ts.net names, and
 * `tailscale funnel` serves them to the public internet, so a suffix match
 * would hand the drive-by page right back. If a deployment fronts the app on a
 * tailnet URL, name it in APP_SERVER_URL and exactly that origin is allowed.
 *
 * The app itself never fetches this engine from a browser at all (everything
 * rides the sealed DataChannel; verified: app/src engine calls all go through
 * engineCapFetch), so even the allowed set exists only for the machine's own
 * pages, not for any shipped call path. Stateless on purpose: pure request
 * inspection plus env reads, no session state, no token files. */
const LOOPBACK_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function allowedBrowserOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    // "null" (sandboxed iframe), "", "about:blank": a browser that declined to
    // name itself is exactly the drive-by case; refused, never read as absent.
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (LOOPBACK_ORIGIN_HOSTS.has(u.hostname.toLowerCase())) return true;
  for (const front of [process.env.APP_SERVER_URL, process.env.ENGINE_PUBLIC_URL]) {
    if (!front) continue;
    try {
      if (new URL(front).origin === u.origin) return true;
    } catch {
      // a misconfigured front URL opens nothing
    }
  }
  return false;
}

/** True when the request carries an Origin header the policy refuses. */
export function originForbidden(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && !allowedBrowserOrigin(origin);
}

/** The one refusal a disallowed browser origin gets, uniform across every
 *  route (server.ts calls this before the router on the TCP feed; the sealed
 *  tunnel feed never passes through it). */
export function refuseForbiddenOrigin(req: Request): Response | null {
  if (!originForbidden(req)) return null;
  return json({ ok: false, error: "browser cross-origin calls are refused (disallowed Origin)" }, 403);
}

/* THE HOST-HEADER GATE (DNS REBINDING, the origin gate's residual). The origin
 * gate refuses a page that NAMES itself; DNS rebinding is the page that never
 * has to. An attacker page at evil.com re-points evil.com's DNS at 127.0.0.1
 * after the page loads; from then on the browser believes the engine IS
 * evil.com, so a top-level navigation or a same-origin GET carries NO Origin
 * header at all and arrives from a true loopback peer with no forwarding
 * header, which is exactly the shape isTrustedLocal was built to trust. The
 * one header that still names the attack is Host: the browser sends the
 * attacker's own domain there, never localhost, because Host comes from the
 * URL bar, not from DNS. So: a request whose Host is not a name this engine
 * is legitimately reached by is refused outright, 403, before any route.
 *
 * WHAT IS ALLOWED, compared by HOSTNAME with any port (the hostname is the
 * trust anchor; a port on a trusted name adds no rebinding surface):
 *   1. Loopback names: localhost / 127.0.0.1 / [::1]. Every real local caller
 *      (the cyc CLI, the harness hooks, the MCP, cron, the app-server's
 *      /health poll) dials one of these, and both Bun fetch and curl stamp
 *      exactly that dial as Host (verified empirically: Bun fetch sends
 *      "127.0.0.1:<port>").
 *   2. The engine's own bound address (AGENT_HOST) when it names a real
 *      address: whoever legitimately dials the bound name sends it as Host.
 *      A wildcard bind (0.0.0.0 / ::) allows NOTHING extra here; opening
 *      every Host because the socket is open to every interface would gut
 *      this gate exactly when the engine is most exposed.
 *   3. The machine's own name (ENGINE_HOST, else os.hostname()), bare and as
 *      its own tailnet MagicDNS name <name>.<tailnet>.ts.net. The ts.net zone
 *      is DNS that tailscale itself serves: an attacker can neither register
 *      the victim machine's label under the victim's tailnet nor point ANY
 *      ts.net record at 127.0.0.1, so this pattern cannot be rebound. (A
 *      blanket *.ts.net stays refused, the same argument as the origin gate:
 *      only names whose FIRST label is this very machine's pass.)
 *   4. The exact hostname of a configured front, APP_SERVER_URL and
 *      ENGINE_PUBLIC_URL: the same two envs the origin gate honours.
 *
 * DELIBERATELY NOT ALLOWED: <name>.local (mDNS answers are LAN-spoofable and
 * no cyc caller dials it; a deploy that wants such a front names it in
 * ENGINE_PUBLIC_URL). Stateless like the origin gate: pure request inspection
 * plus env reads, no session state, no token files. */
export function allowedRequestHost(hostHeader: string): boolean {
  const t = hostHeader.trim();
  /* None of these characters is legal in a Host header (host[:port] only). A
   * value like "127.0.0.1@evil.com" or "127.0.0.1/x" is someone playing
   * parser games, and it names nothing this engine answers as. */
  if (t === "" || /[@/\\?#\s]/.test(t)) return false;
  let u: URL;
  try {
    u = new URL(`http://${t}`);
  } catch {
    return false;
  }
  const h = u.hostname; // URL lowercases it and keeps IPv6 brackets
  if (LOOPBACK_ORIGIN_HOSTS.has(h)) return true;
  const bound = (process.env.AGENT_HOST ?? "").trim().toLowerCase();
  if (bound && bound !== "0.0.0.0" && bound !== "::" && bound !== "[::]" && h === bound) return true;
  const own = (process.env.ENGINE_HOST ?? hostname()).replace(/\.local$/i, "").toLowerCase();
  if (own) {
    if (h === own) return true;
    const ownEscaped = own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^${ownEscaped}\\.[a-z0-9-]+\\.ts\\.net$`).test(h)) return true;
  }
  for (const front of [process.env.APP_SERVER_URL, process.env.ENGINE_PUBLIC_URL]) {
    if (!front) continue;
    try {
      if (new URL(front).hostname.toLowerCase() === h) return true;
    } catch {
      // a misconfigured front URL opens nothing
    }
  }
  return false;
}

/** True when the request carries a Host header the policy refuses. An ABSENT
 *  Host is tolerated here (an in-process synthetic Request, e.g. the sealed
 *  tunnel's, has none); the TCP feed fails closed on absence in
 *  refuseForbiddenHost instead. */
export function hostForbidden(req: Request): boolean {
  const host = req.headers.get("host");
  return host !== null && !allowedRequestHost(host);
}

/** The one refusal an unexpected Host gets, uniform across every route
 *  (server.ts calls this before the router on the TCP feed, ahead of the
 *  origin refusal; the sealed tunnel feed never passes through it).
 *
 *  A request with NO Host at all fails CLOSED here: HTTP/1.1 mandates the
 *  header and every real caller sends it (Bun fetch, curl, every browser);
 *  the only shape that arrives without one is a hand-written HTTP/1.0
 *  request, which no cyc caller is. Bun delivers such a request with a
 *  RELATIVE req.url, which the router's own `new URL(req.url)` would throw
 *  on, so refusing it up front is both the safe and the honest answer. */
export function refuseForbiddenHost(req: Request): Response | null {
  const host = req.headers.get("host");
  if (host !== null && allowedRequestHost(host)) return null;
  return json({ ok: false, error: "unexpected Host header (DNS-rebinding shapes are refused)" }, 403);
}

/* WHO MAY MUTATE THIS ENGINE (security hardening).
 *
 * The old gate trusted server.requestIP() == loopback. Behind a reverse proxy
 * that fronts this loopback port, EVERY forwarded peer arrives from 127.0.0.1,
 * so "localhost-only" was no gate at all: a remote peer could rename, reface,
 * or inject input into a running agent. Two callers are legitimate:
 *
 *   1. Scripts on this engine's own host (the MCP server, the harness, cron).
 *      They dial 127.0.0.1 DIRECTLY, so their request has a loopback peer AND
 *      no x-forwarded-for -- a reverse proxy on this host always stamps one,
 *      and a remote direct peer has a non-loopback address whatever headers
 *      it forges. Fails closed when peer data is missing.
 *   2. The app on an enrolled device. It reaches these routes over the sealed
 *      DataChannel tunnel: onReq reassembles the request and marks
 *      it (markSealedTunnel), and the channel already proved the device through
 *      the v2 sec handshake. The old bare-header cap path does not exist any
 *      more; there is no bearer at all, so a tailnet peer has nothing to
 *      present over plain HTTP.
 *
 * Everything else -- any tailnet peer reaching in over plain HTTP -- is
 * refused.
 *
 * AND A BROWSER PAGE IS NOT "A SCRIPT ON THIS MACHINE" (H1). A web page open
 * in a browser on this host fetches 127.0.0.1:10101 from a loopback peer with
 * no x-forwarded-for, which used to pass this gate wholesale. The page names
 * itself in the Origin header (a browser always sends it cross-origin), so a
 * request carrying a disallowed Origin is refused here too: defense in depth
 * under the pre-router refusal in server.ts, and it keeps this one predicate
 * the whole meaning of "trusted local" for every gate that calls it.
 *
 * AND NEITHER IS A REBOUND PAGE (the host gate). A DNS-rebound page reaches
 * 127.0.0.1 with NO Origin at all (top-level navigation, same-origin GET), so
 * the origin check above never sees it; its Host header still names the
 * attacker's domain, and hostForbidden refuses it here too -- the same
 * defense-in-depth relationship the origin check has to refuseForbiddenOrigin.
 * An absent Host stays trusted at THIS level (the sealed tunnel's synthetic
 * Request and in-process test Requests carry none); the TCP feed is where
 * absence fails closed (refuseForbiddenHost). */
/* THE OLD "trusted local" predicate, kept as its own function: a true loopback
 * peer, no forwarding header, an allowed Host and an allowed Origin. /ws still
 * gates on THIS (see isTrustedLocal's transition note) because the herdr/agent
 * channel's mux readers dial loopback TCP, and moving /ws onto the socket is a
 * later job the mux lane owns. */
export function isLoopbackTrusted(req: Request, server: import("bun").Server): boolean {
  if (!isLoopback(server.requestIP(req)?.address ?? null)) return false;
  if (req.headers.get("x-forwarded-for") !== null) return false;
  if (hostForbidden(req)) return false;
  return !originForbidden(req);
}

/* THE LOCAL-TRUST GATE every content/control surface shares (requireOwner,
 * requireLocal, the /agent/reply and /agent/info checks). Three ways in, in
 * order:
 *   1. the local unix socket (fromLocalSocket): same-uid by filesystem
 *      permission, trusted before the requestIP look-up that a unix peer has
 *      no answer for;
 *   2. CYC_ALLOW_LOOPBACK_LOCAL: the transition flag, default "1" (ON) this
 *      release, so loopback TCP keeps passing exactly as before and the
 *      loopback hosts and the distribution instance ride the change unbroken. When set to
 *      "0", loopback TCP is NO LONGER trusted here -- only a socket peer is --
 *      which closes the any-local-uid hole. The flag flips OFF a release after
 *      a deploy confirms the socket path (see the report). It gates ONLY this
 *      predicate, never /ws (which calls isLoopbackTrusted directly).
 *   3. the loopback predicate itself, when the flag allows it. */
export function isTrustedLocal(req: Request, server: import("bun").Server): boolean {
  if (fromLocalSocket(req)) return true;
  if (process.env.CYC_ALLOW_LOOPBACK_LOCAL === "0") return false;
  return isLoopbackTrusted(req, server);
}

export async function requireOwner(req: Request, server: import("bun").Server): Promise<Response | null> {
  if (isTrustedLocal(req, server)) return null;
  // The enrolled device reaches these routes over the sealed DataChannel
  // (onReq -> routeRequest), never over bare HTTP; no header opens this gate.
  if (fromSealedTunnel(req)) return null;
  /* The ONE refusal every unsealed content/control request gets, at route head,
   * identical for existing and nonexistent resources -- a refused peer learns
   * nothing from the difference. */
  return json({ ok: false, error:
    "content rides the sealed channel only (enrolled device) or the engine host itself" }, 403);
}

/* agent-to-agent delivery (#513) and fired schedules both run ON the machine.
 * This route is deliberately loopback-only: no enrolled-device cap path, so it
 * is never reachable over the tailnet even by a paired device. The app never
 * calls it (the phone sends chat as a sealed `utterance` frame over the wire).
 */
export function requireLocal(req: Request, server: import("bun").Server): Response | null {
  if (isTrustedLocal(req, server)) return null;
  return json({ ok: false, error: "agent-message is local-only (this machine)" }, 403);
}

/* forbiddenWsOrigin is GONE (H2 fix). It was defined and imported but never
 * called: /ws gated on isTrustedLocal alone, so its origin allowlist was dead
 * wiring. The unified policy above supersedes it: isTrustedLocal itself now
 * refuses a disallowed Origin, so the /ws upgrade (and every other gate) gets
 * the origin check on the same predicate, and the *.ts.net suffix it would
 * have allowed is deliberately not carried forward (see the policy comment). */

