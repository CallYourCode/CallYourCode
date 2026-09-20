/* THE REQUEST GATE: who this engine answers, decided once, before any route.
 *
 * The voice engine has no auth at all; its whole security story is "only this
 * machine can reach it" (the loopback boot assertion in server.ts). This module
 * is the per-request half of that story, and it is STRICTER than the agent
 * engine's httpx.ts gate on purpose: the contract
 * (docs/contracts/01-engine-voice.md) names the agent engine as the ONLY
 * network-facing front, dialling over loopback with server-side fetch/WebSocket
 * (voice-proxy.ts), which sends no Origin and no x-forwarded-for. So:
 *
 *   1. NON-LOOPBACK PEER: refused. A request with no peer data fails closed.
 *   2. X-FORWARDED-FOR PRESENT: refused. A reverse proxy fronting the loopback
 *      port hands every remote peer a loopback TCP address, but it stamps this
 *      header on the way through; the header's PRESENCE marks the request as
 *      forwarded, exactly the agent engine's rule. It is never read as a
 *      credential.
 *   3. HOST NOT A LOOPBACK NAME: refused (DNS rebinding, the origin check's
 *      residual). The origin check refuses a page that NAMES itself; a
 *      DNS-rebound page never has to. An attacker page at evil.com re-points
 *      evil.com's DNS at 127.0.0.1 after the page loads; from then on the
 *      browser believes this engine IS evil.com, so a top-level navigation or
 *      a same-origin GET arrives from a true loopback peer with NO Origin and
 *      no x-forwarded-for, which is exactly the shape rules 1 and 2 pass. The
 *      one header that still names the attack is Host: the browser sends the
 *      attacker's domain there, never localhost, because Host comes from the
 *      URL bar, not from DNS. The agent engine's httpx.ts closes the same hole
 *      with allowedRequestHost; this engine's allow-set is STRICTER for the
 *      same reason the whole gate is: the only intended caller is the agent
 *      engine's server-side fetch/WebSocket over loopback (voice-proxy.ts
 *      dials VOICE_URL, default http://127.0.0.1:10102, so Bun stamps
 *      Host: 127.0.0.1:10102), and the boot assertion in server.ts pins
 *      VOICE_HOST to a loopback name, so even "the bound host" is a loopback
 *      name. Loopback host, any port, nothing else: no tailnet name, no
 *      machine name, no configured front. A request with NO Host fails
 *      CLOSED: HTTP/1.1 mandates the header and every real caller sends it
 *      (Bun fetch, curl, every browser); nothing in-process ever builds a
 *      synthetic Request for this engine.
 *   4. ORIGIN PRESENT AND NOT THIS ENGINE'S OWN: refused. A browser always
 *      sends Origin on a cross-origin fetch, XHR, or WS upgrade, and no
 *      browser page has business here EXCEPT the engine's own standing test
 *      bench (GET /test.html, served from public/ by this very server). Only a
 *      page this engine itself served can carry the engine's own origin
 *      (loopback host, this port, http), so exactly that origin is allowed and
 *      nothing else is: not other loopback ports (the agent engine's own pages
 *      live there and must ride voice-proxy, never fetch here directly), not
 *      "null", not https, not any remote host. A request with NO Origin (every
 *      server-side caller, and a plain browser navigation) is untouched.
 *
 * The gate applies to EVERY request, the /stt-stream websocket upgrade
 * included; the upgrade used to be entirely ungated, so a proxied peer could
 * open streaming STT and any host page could stream the mic to it cross-origin.
 * CORS headers are gone with it (server.ts used to answer everything with the
 * allow-origin wildcard, so any page a browser on this host visited could READ
 * responses); gate.test.ts scans the source for the header as a tripwire.
 *
 * Stateless on purpose: pure request inspection, no tokens, no sessions, no
 * env. Windows-friendly and deterministic. */

export function isLoopbackPeer(addr: string | null | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Hostnames a page served by this engine itself can appear under. The URL
 *  parser keeps the brackets on an IPv6 hostname, so "[::1]" is the literal.
 *  The SAME set is the whole Host allowlist (isLoopbackHost): the boot
 *  assertion pins the bind to one of these, so a legitimate dial of this
 *  engine can never carry any other name. */
const SELF_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Is `hostHeader` a loopback host[:port]? The only Hosts this engine is ever
 *  legitimately reached by (see rule 3 up top). Absent fails closed: every
 *  real caller sends Host. Parsed the way the agent engine's
 *  allowedRequestHost parses it: refuse characters no host[:port] contains
 *  (parser games like "127.0.0.1@evil.com"), then let URL normalize the rest
 *  (lowercases, keeps IPv6 brackets). */
export function isLoopbackHost(hostHeader: string | null): boolean {
  if (hostHeader === null) return false;
  const t = hostHeader.trim();
  if (t === "" || /[@/\\?#\s]/.test(t)) return false;
  let u: URL;
  try {
    u = new URL(`http://${t}`);
  } catch {
    return false;
  }
  return SELF_ORIGIN_HOSTS.has(u.hostname);
}

/** Is `origin` this engine's OWN origin: http, loopback host, this port?
 *  Only a page this server itself served (public/test.html) can present it;
 *  no cross-origin page can, and the engine never serves https. */
export function isSelfOrigin(origin: string, port: number): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    // "null" (sandboxed iframe), "": a browser that declined to name itself is
    // exactly the drive-by case; refused, never read as absent.
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (!SELF_ORIGIN_HOSTS.has(u.hostname.toLowerCase())) return false;
  return (u.port === "" ? 80 : Number(u.port)) === port;
}

/** The whole policy as one pure predicate. Returns null for a request this
 *  engine answers, or the reason it is refused. `peer` is the TCP peer address
 *  (null when unknown: fails closed), `xff`, `host` and `origin` are the raw
 *  header values (null when absent; an absent `host` fails closed), `port` is
 *  the port this server is bound to. */
export function outsiderReason(
  peer: string | null,
  xff: string | null,
  host: string | null,
  origin: string | null,
  port: number,
): string | null {
  if (!isLoopbackPeer(peer)) return "non-loopback peer";
  if (xff !== null) return "forwarded request (x-forwarded-for)";
  if (!isLoopbackHost(host)) return "non-loopback Host header (DNS-rebinding shapes are refused)";
  if (origin !== null && !isSelfOrigin(origin, port)) return "cross-origin browser call";
  return null;
}

/** The one refusal every outsider gets, uniform across every route and the
 *  websocket upgrade. Null means the request may proceed. */
export function refuseOutsider(req: Request, server: import("bun").Server): Response | null {
  const reason = outsiderReason(
    server.requestIP(req)?.address ?? null,
    req.headers.get("x-forwarded-for"),
    req.headers.get("host"),
    req.headers.get("origin"),
    server.port,
  );
  if (reason === null) return null;
  return new Response(
    JSON.stringify({ ok: false, error: `the voice engine answers this machine only (${reason})` }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}
