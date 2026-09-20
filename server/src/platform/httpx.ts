/* HTTP plumbing shared by every route family: the browser-origin gate, the
 * JSON answer shape, and the two ways an untrusted string or body comes off
 * the wire. Nothing here knows a route or an owner.
 *
 * CORS IS GONE (the same H1 fix as the agent engine's httpx.ts). Every answer
 * used to carry the CORS allow-origin wildcard, justified as "for the engines
 * calling /push/notify from another host" -- but engines are server-side
 * fetchers, and CORS only ever governs BROWSERS, so the wildcard served
 * nobody legitimate while letting any web page a browser could point at this
 * server READ its answers cross-origin (including a freshly minted cyt_
 * bearer from the open LOCAL /engines/enroll). The page this server serves is
 * same-origin and needs no grant; nothing else in the product fetches it from
 * a browser. So: no response carries any CORS grant header, and the origin
 * gate below refuses disallowed browser origins outright. */

import { hostname } from "node:os";
import { PUSH_BODY_MAX_BYTES, SESSION_ID_MAX } from "./caps";
import { readBodyCapped } from "../../../engine/shared/bodyread.ts";

export type LogFn = (event: string, fields: Record<string, unknown>) => void;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/* THE BROWSER ORIGIN GATE. A browser always names the calling page in the
 * Origin header (on cross-origin fetch/XHR/ws and on every non-GET); a
 * non-browser caller (an engine's announce/push/enroll, the cyc CLI) never
 * sends one, so a no-Origin request passes untouched. Allowed:
 *   1. same-origin: the Origin's host equals the request's own Host header,
 *      which is the page this server itself serves (the scheme may differ
 *      behind a TLS-terminating front like tailscale serve, so the host is
 *      the comparison, exactly the browser's own serialization of the pair);
 *   2. loopback-hosted origins (localhost / 127.0.0.1 / [::1], any port): the
 *      machine's own pages, e.g. a dev serve. A drive-by internet page can
 *      present neither. Stateless: pure request inspection. */
const LOOPBACK_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function allowedBrowserOrigin(origin: string, reqHost: string | null): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    // "null" (sandboxed iframe), "": a browser that declined to name itself.
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (LOOPBACK_ORIGIN_HOSTS.has(u.hostname.toLowerCase())) return true;
  return reqHost !== null && u.host.toLowerCase() === reqHost.trim().toLowerCase();
}

/** 403 when the request carries an Origin the policy refuses; null otherwise.
 *  Wired BEFORE the route dispatch in bootstrap/server.ts, so it covers every
 *  route including the LOCAL-open mutating ones (/engines/enroll and friends). */
export function refuseForbiddenOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (origin === null) return null;
  if (allowedBrowserOrigin(origin, req.headers.get("host"))) return null;
  return json({ error: "browser cross-origin calls are refused (disallowed Origin)" }, 403);
}

/* THE HOST-HEADER GATE (DNS REBINDING, the origin gate's residual). The
 * same-origin rule above trusts the request's own Host header as "the page
 * this server serves" -- and DNS rebinding is precisely an attack on that
 * trust. An attacker page at evil.com re-points evil.com's DNS at 127.0.0.1
 * after it loads; from then on the browser reaches this server believing it
 * IS evil.com, so a top-level navigation or a same-origin GET carries no
 * Origin at all, and a same-origin POST carries Origin http://evil.com:10100
 * with Host evil.com:10100 -- which the same-origin compare above would have
 * ACCEPTED. The Host header still names the attacker's domain (it comes from
 * the URL bar, not from DNS), so this gate refuses any Host this server is
 * not legitimately reached by, before the origin gate ever compares.
 *
 * WHAT IS ALLOWED, compared by HOSTNAME with any port (the hostname is the
 * trust anchor; a port on a trusted name adds no rebinding surface):
 *   1. Loopback names (localhost / 127.0.0.1 / [::1]): the same-machine page
 *      and every same-machine caller (engines' announce/push, the CLI, Bun
 *      fetch and curl stamp the dial as Host).
 *   2. The server's own bound address (APP_HOST) when it names a real
 *      address; a wildcard bind (0.0.0.0 / ::) opens nothing extra.
 *   3. The machine's own name, bare and as its own tailnet MagicDNS name
 *      <name>.<tailnet>.ts.net -- the `tailscale serve` front, which forwards
 *      the browser's Host (the tailnet name) to this loopback port. The
 *      ts.net zone is DNS tailscale itself serves: an attacker can neither
 *      register this machine's label under this tailnet nor point any ts.net
 *      record at 127.0.0.1, so the pattern cannot be rebound. A blanket
 *      *.ts.net stays refused.
 *   4. The exact hostname of APP_SERVER_URL, when a deploy fronts this
 *      server on a name the pattern above does not cover (a custom domain, a
 *      renamed front). The engine already uses this env to NAME this server;
 *      setting it on the app-server itself declares the same fact here.
 *
 * <name>.local is deliberately NOT allowed (mDNS answers are LAN-spoofable;
 * name such a front in APP_SERVER_URL). Stateless: request inspection plus
 * env reads. */
export function allowedRequestHost(hostHeader: string): boolean {
  const t = hostHeader.trim();
  /* None of these characters is legal in a Host header (host[:port] only);
   * "127.0.0.1@evil.com" or "127.0.0.1/x" is someone playing parser games. */
  if (t === "" || /[@/\\?#\s]/.test(t)) return false;
  let u: URL;
  try {
    u = new URL(`http://${t}`);
  } catch {
    return false;
  }
  const h = u.hostname; // URL lowercases it and keeps IPv6 brackets
  if (LOOPBACK_ORIGIN_HOSTS.has(h)) return true;
  const bound = (process.env.APP_HOST ?? "").trim().toLowerCase();
  if (bound && bound !== "0.0.0.0" && bound !== "::" && bound !== "[::]" && h === bound) return true;
  const own = hostname().replace(/\.local$/i, "").toLowerCase();
  if (own) {
    if (h === own) return true;
    const ownEscaped = own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^${ownEscaped}\\.[a-z0-9-]+\\.ts\\.net$`).test(h)) return true;
  }
  const front = process.env.APP_SERVER_URL;
  if (front) {
    try {
      if (new URL(front).hostname.toLowerCase() === h) return true;
    } catch {
      // a misconfigured front URL opens nothing
    }
  }
  return false;
}

/** The one refusal an unexpected Host gets, wired BEFORE the origin gate and
 *  before any route in bootstrap/server.ts. A request with NO Host fails
 *  CLOSED: HTTP/1.1 mandates the header and every real caller sends it; the
 *  only no-Host shape is a hand-written HTTP/1.0 request, which Bun delivers
 *  with a RELATIVE req.url that the fetch handler's own `new URL(req.url)`
 *  would throw on anyway. */
export function refuseForbiddenHost(req: Request): Response | null {
  const host = req.headers.get("host");
  if (host !== null && allowedRequestHost(host)) return null;
  return json({ error: "unexpected Host header (DNS-rebinding shapes are refused)" }, 403);
}

/** A session id off the wire, bounded to what the page and a real engine use. */
export const engineSessionId = (v: unknown) => String(v ?? "").slice(0, SESSION_ID_MAX);

/* An engine's POST body, read the way /report reads a device's: through the
 * capped reader (shared/bodyread), which refuses a declared Content-Length over
 * the cap before a byte is kept and stops the read the moment the stream would
 * pass it, so a modified engine cannot make this server buffer an arbitrary
 * amount before it parses. (It used to arrayBuffer() first and check size
 * after, which held up to maxRequestBodySize -- 320MB -- per request.)
 * Rejected if it is not a JSON object. Returns the parsed body, or a Response
 * the caller returns unchanged, a 413 or a 400, never a silent 200. */
export async function engineBody(
  req: Request, log: LogFn,
): Promise<{ body: any } | { reject: Response }> {
  let raw: Awaited<ReturnType<typeof readBodyCapped>>;
  try { raw = await readBodyCapped(req, PUSH_BODY_MAX_BYTES); }
  catch { return { reject: json({ error: "no body" }, 400) }; }
  if (!raw.ok) {
    log("push.refused", { path: new URL(req.url).pathname, cap: PUSH_BODY_MAX_BYTES,
      why: "the POST is larger than any notify or batch a real engine sends" });
    return { reject: json({ error: "too large", cap: PUSH_BODY_MAX_BYTES }, 413) };
  }
  let body: any = null;
  try { body = JSON.parse(new TextDecoder().decode(raw.value)); } catch { /* below */ }
  if (!body || typeof body !== "object") return { reject: json({ error: "bad body" }, 400) };
  return { body };
}
