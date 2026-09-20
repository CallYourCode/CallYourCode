/* The HTTP cross-cutting helpers (httpx.ts): the json answer shape, the
 * trusted-local predicate, the owner/local gates and the browser-origin gate.
 * Pure unit tests over fake Request/Server objects; no engine, no sockets.
 *
 * These functions are the ONLY thing standing between a tailnet peer or a
 * drive-by web page and renaming a session, typing into a bypassPermissions
 * pane, or reading a chat. Every test here is a refusal, and the failure mode
 * they exist for is a guard that quietly starts returning null.
 *
 * No port number in this file is one of his (gates.test.ts holds the reserved
 * list): a test that writes a real port is one edit away from pointing at the
 * live engine. */

import { afterEach, describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import {
  json,
  isTrustedLocal,
  requireOwner,
  requireLocal,
  allowedBrowserOrigin,
  originForbidden,
  refuseForbiddenOrigin,
  allowedRequestHost,
  hostForbidden,
  refuseForbiddenHost,
  markSealedTunnel,
  markLocalSocket,
  fromLocalSocket,
  isLoopbackTrusted,
} from "./httpx.ts";

type FakeServer = { requestIP(req: Request): { address: string } | null };
const from = (address: string | null): FakeServer =>
  ({ requestIP: () => (address === null ? null : { address }) });
const req = (headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1/x", { headers });

describe("json()", () => {
  test("carries the body, the status and the extra headers, and NO CORS grant", async () => {
    const r = json({ ok: true }, 418, { "x-extra": "1" });
    expect(r.status).toBe(418);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("x-extra")).toBe("1");
    /* THE CORS TRIPWIRE (H1). The engine used to stamp
     * access-control-allow-origin: "*" on every answer, which let any web page
     * a browser on this host visited READ engine responses cross-origin. No
     * response carries any access-control-* grant now; a reappearing one is a
     * regression, not a feature. */
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("access-control-allow-methods")).toBeNull();
    expect(r.headers.get("access-control-allow-headers")).toBeNull();
  });

  test("defaults to 200 and serialises the falsy bodies too", async () => {
    expect(json({}).status).toBe(200);
    expect(await json(null).text()).toBe("null");
    expect(await json(false).text()).toBe("false");
    expect(await json([1, 2]).json()).toEqual([1, 2]);
  });
});

describe("isTrustedLocal", () => {
  test("loopback with no x-forwarded-for is trusted", () => {
    expect(isTrustedLocal(req(), from("127.0.0.1") as any)).toBe(true);
    expect(isTrustedLocal(req(), from("::1") as any)).toBe(true);
    // the v4-mapped-v6 form is what Bun hands back on a dual-stack listener
    expect(isTrustedLocal(req(), from("::ffff:127.0.0.1") as any)).toBe(true);
  });
  test("a proxied request is NOT local even from loopback (tailscale serve)", () => {
    expect(isTrustedLocal(req({ "x-forwarded-for": "100.1.2.3" }), from("127.0.0.1") as any)).toBe(false);
  });
  test("ANY x-forwarded-for disqualifies, including an empty one", () => {
    /* The test is presence, not content, on purpose: a peer that forges the
     * header only ever locks itself out, and a proxy that stamps an empty one
     * still means this request did not come from a process on this box. */
    expect(isTrustedLocal(req({ "x-forwarded-for": "" }), from("127.0.0.1") as any)).toBe(false);
    expect(isTrustedLocal(req({ "x-forwarded-for": "127.0.0.1" }), from("127.0.0.1") as any)).toBe(false);
  });
  test("a remote peer is never local, and missing peer data fails closed", () => {
    expect(isTrustedLocal(req(), from("100.1.2.3") as any)).toBe(false);
    expect(isTrustedLocal(req(), from(null) as any)).toBe(false);
  });
  test("a lookalike loopback address is not loopback", () => {
    /* 127.0.0.2 IS loopback to the kernel but the allowlist is exact, and
     * "127.0.0.1.evil.com" or a stray space would sail through a substring
     * check. Named here so nobody relaxes isLoopback into `startsWith`. */
    for (const addr of ["127.0.0.2", "127.0.0.10", " 127.0.0.1", "127.0.0.1 ", "0.0.0.0", "::2"]) {
      expect(isTrustedLocal(req(), from(addr) as any), addr).toBe(false);
    }
  });
  test("a loopback peer carrying a DISALLOWED browser Origin is NOT local (H1)", () => {
    /* The drive-by shape: a web page open in a browser ON this host fetches
     * 127.0.0.1:10101. The peer is loopback and there is no x-forwarded-for,
     * which used to pass this gate wholesale; the Origin header is the one
     * thing that names the page, so it is what refuses it. */
    expect(isTrustedLocal(req({ origin: "https://evil.example.com" }), from("127.0.0.1") as any)).toBe(false);
    expect(isTrustedLocal(req({ origin: "null" }), from("127.0.0.1") as any)).toBe(false);
    expect(isTrustedLocal(req({ origin: "https://linux.tail1234.ts.net" }), from("127.0.0.1") as any)).toBe(false);
  });
  test("a loopback peer with an ALLOWED origin, or no Origin at all, stays local", () => {
    // no Origin: every non-browser caller on this box (CLI, hooks, MCP, cron)
    expect(isTrustedLocal(req(), from("127.0.0.1") as any)).toBe(true);
    // loopback-hosted pages: the machine's own served app / a dev page
    expect(isTrustedLocal(req({ origin: "http://localhost:5173" }), from("127.0.0.1") as any)).toBe(true);
    expect(isTrustedLocal(req({ origin: "http://127.0.0.1:51001" }), from("127.0.0.1") as any)).toBe(true);
  });
});

describe("the local unix socket + the CYC_ALLOW_LOOPBACK_LOCAL transition flag (item 1)", () => {
  /* THE UID HOLE, and the door that closes it. Loopback TCP is not user-scoped:
   * any local uid can dial 127.0.0.1 and POST /new-session, /agent/reply,
   * /agent/info. The fix is the unix socket (same-uid by filesystem permission,
   * marked with markLocalSocket) plus a flag that, once flipped to "0", stops
   * trusting loopback TCP on these surfaces. Default "1" keeps loopback trusted
   * so the transition ships unbroken.
   *
   * SCRATCH-PROVE (done during development, restored): deleting the
   * `process.env.CYC_ALLOW_LOOPBACK_LOCAL === "0"` line from isTrustedLocal makes
   * the flag=0 refusals below PASS the request (403 -> null), i.e. the tests go
   * red -- so they genuinely bind the flag check, not something incidental. */
  const KEY = "CYC_ALLOW_LOOPBACK_LOCAL";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test("a socket-marked request passes isTrustedLocal before the requestIP look-up (null peer)", () => {
    const r = req();
    expect(fromLocalSocket(r)).toBe(false);
    markLocalSocket(r);
    expect(fromLocalSocket(r)).toBe(true);
    // from(null): a unix peer has no requestIP; the mark alone carries it
    expect(isTrustedLocal(r, from(null) as any)).toBe(true);
  });

  test("flag unset (today's default): an UNMARKED loopback request still passes -- the transition is unbroken", () => {
    delete process.env[KEY];
    expect(isTrustedLocal(req(), from("127.0.0.1") as any)).toBe(true);
    expect(requireLocal(req(), from("127.0.0.1") as any)).toBeNull();
  });

  test('flag "1" is the same as unset (explicit ON)', () => {
    process.env[KEY] = "1";
    expect(isTrustedLocal(req(), from("127.0.0.1") as any)).toBe(true);
  });

  test('flag "0": an UNMARKED loopback request is refused (403) on the local-trust surfaces', async () => {
    process.env[KEY] = "0";
    expect(isTrustedLocal(req(), from("127.0.0.1") as any)).toBe(false);
    // the routes that share this gate (new-session/rename via requireOwner,
    // agent-message/announce via requireLocal, /agent/reply/info inline)
    expect((await requireOwner(req(), from("127.0.0.1") as any))!.status).toBe(403);
    expect(requireLocal(req(), from("127.0.0.1") as any)!.status).toBe(403);
  });

  test('flag "0": the SAME request, marked via markLocalSocket, passes', async () => {
    process.env[KEY] = "0";
    const owner = req();
    markLocalSocket(owner);
    expect(isTrustedLocal(owner, from(null) as any)).toBe(true);
    expect(await requireOwner(owner, from(null) as any)).toBeNull();
    const local = req();
    markLocalSocket(local);
    expect(requireLocal(local, from(null) as any)).toBeNull();
  });

  test("isLoopbackTrusted IGNORES the flag: /ws keeps passing on loopback either way (mux lane owns it)", () => {
    for (const v of [undefined, "1", "0"]) {
      if (v === undefined) delete process.env[KEY];
      else process.env[KEY] = v;
      expect(isLoopbackTrusted(req(), from("127.0.0.1") as any), `flag=${v}`).toBe(true);
      // but a disallowed origin / non-loopback peer is still refused
      expect(isLoopbackTrusted(req({ origin: "https://evil.example.com" }), from("127.0.0.1") as any)).toBe(false);
      expect(isLoopbackTrusted(req(), from("100.1.2.3") as any)).toBe(false);
    }
  });

  test('flag "0": a socket-marked request wins even if it somehow also looked non-loopback', () => {
    process.env[KEY] = "0";
    const r = req();
    markLocalSocket(r);
    // the mark is checked FIRST, so the peer address is irrelevant
    expect(isTrustedLocal(r, from("100.1.2.3") as any)).toBe(true);
  });
});

describe("requireOwner / requireLocal", () => {
  test("trusted local passes both gates", async () => {
    expect(await requireOwner(req(), from("127.0.0.1") as any)).toBeNull();
    expect(requireLocal(req(), from("127.0.0.1") as any)).toBeNull();
  });
  test("an un-capped remote is 403 on both, with the json shape", async () => {
    const owner = await requireOwner(req(), from("100.1.2.3") as any);
    expect(owner!.status).toBe(403);
    expect(((await owner!.json()) as any).ok).toBe(false);
    const local = requireLocal(req({ "x-cyc-cap": "whatever" }), from("100.1.2.3") as any);
    expect(local!.status).toBe(403); // requireLocal has NO cap path at all
  });
  test("a junk cap header opens nothing: requireOwner reads no header at all", async () => {
    const r = await requireOwner(req({ "x-cyc-cap": "AAAA" }), from("100.1.2.3") as any);
    expect(r!.status).toBe(403);
  });
  test("the 403 body names the sealed channel; requireLocal stays local-only", async () => {
    /* The two refusals are different routes with different rules, and the only
     * thing a person debugging from a phone sees is this sentence. requireOwner
     * now speaks of the sealed channel (the cap bearer is gone). */
    const owner = await requireOwner(req(), from("100.1.2.3") as any);
    expect((await owner!.json()).error).toContain("sealed channel");
    const local = requireLocal(req(), from("100.1.2.3") as any);
    expect((await local!.json()).error).toContain("local-only");
  });

  test("no x-cyc-cap header opens requireOwner: the bearer machinery is deleted", async () => {
    /* There is no cap at all any more. The enrolled device reaches these routes
     * over the sealed DataChannel (markSealedTunnel), never a bare HTTP header,
     * so any x-cyc-cap value a plain-HTTP tailnet peer waves buys nothing. */
    expect((await requireOwner(req({ "x-cyc-cap": "anything-at-all" }),
      from("100.1.2.3") as any))!.status).toBe(403);
    // and the same over `tailscale serve` (loopback peer, real client in XFF)
    expect((await requireOwner(req({ "x-cyc-cap": "anything-at-all", "x-forwarded-for": "100.1.2.3" }),
      from("127.0.0.1") as any))!.status).toBe(403);
  });

  test("a request marked as coming through the sealed tunnel passes requireOwner, never requireLocal", async () => {
    /* onReq (tunnel-glue) marks the in-process Request it built; requireOwner
     * treats that mark as the owner (the channel already proved the device).
     * The peer address is irrelevant to a marked request -- there is no socket
     * behind it -- so `from(null)` stands in for "no requestIP". requireLocal
     * has no tunnel path: agent-message stays this-machine-only. */
    const tun = req();
    markSealedTunnel(tun);
    expect(await requireOwner(tun, from(null) as any)).toBeNull();
    // a DIFFERENT (unmarked) request from the same nowhere is still refused
    expect((await requireOwner(req(), from(null) as any))!.status).toBe(403);
    // the mark opens owner routes, not local-only ones
    const tunLocal = req();
    markSealedTunnel(tunLocal);
    expect(requireLocal(tunLocal, from(null) as any)!.status).toBe(403);
  });

  test("a remote peer stays refused whatever it stamps: proxy header, cap, both", async () => {
    /* Every cross-host HTTP shape is 403: a direct remote peer, a proxied
     * loopback (tailscale serve), and either of those waving a header the gate
     * no longer reads. */
    for (const [headers, peer] of [
      [{}, "100.1.2.3"],
      [{ "x-cyc-cap": "nope" }, "100.1.2.3"],
      [{ "x-forwarded-for": "100.1.2.3", "x-cyc-cap": "nope" }, "127.0.0.1"],
    ] as const) {
      expect((await requireOwner(req(headers), from(peer) as any))!.status).toBe(403);
      expect(requireLocal(req(headers), from(peer) as any)!.status).toBe(403);
    }
  });

  test("the HOST itself still needs no cap and no tunnel", async () => {
    expect(await requireOwner(req(), from("127.0.0.1") as any)).toBeNull();
    expect(requireLocal(req(), from("127.0.0.1") as any)).toBeNull();
  });

  test("a disallowed browser Origin is 403 on BOTH gates even from a loopback peer (H1)", async () => {
    const evil = req({ origin: "https://evil.example.com" });
    expect((await requireOwner(evil, from("127.0.0.1") as any))!.status).toBe(403);
    expect(requireLocal(req({ origin: "https://evil.example.com" }), from("127.0.0.1") as any)!.status).toBe(403);
  });
});

describe("the browser origin policy (allowedBrowserOrigin / originForbidden / refuseForbiddenOrigin)", () => {
  /* This ONE policy supersedes the never-wired forbiddenWsOrigin (H2): it
   * gates HTTP and the /ws upgrade alike, through isTrustedLocal and through
   * the pre-router refusal in server.ts. */
  const ENV_KEYS = ["APP_SERVER_URL", "ENGINE_PUBLIC_URL"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("no Origin header is never forbidden (native/local clients untouched)", () => {
    expect(originForbidden(req())).toBe(false);
    expect(refuseForbiddenOrigin(req())).toBeNull();
  });

  test("loopback-hosted origins pass: localhost, 127.0.0.1, [::1], any port, any case", () => {
    expect(allowedBrowserOrigin("http://localhost:5173")).toBe(true);
    expect(allowedBrowserOrigin("http://127.0.0.1:51001")).toBe(true);
    expect(allowedBrowserOrigin("http://[::1]:51003")).toBe(true);
    expect(allowedBrowserOrigin("HTTP://LOCALHOST:51002")).toBe(true);
    expect(allowedBrowserOrigin("http://localhost")).toBe(true);
    expect(allowedBrowserOrigin("https://localhost")).toBe(true);
  });

  test("*.ts.net is NOT blanket-allowed any more (tailscale funnel makes it attacker-reachable)", () => {
    /* The old forbiddenWsOrigin allowed any *.ts.net origin. Every tailscale
     * account owns such names, and `tailscale funnel` serves them to the open
     * internet, so a suffix match is a drive-by door, not a trust boundary.
     * A deployment that fronts the app on a tailnet URL names it in
     * APP_SERVER_URL and gets exactly that origin, nothing else. */
    expect(allowedBrowserOrigin("https://linux.tail1234.ts.net")).toBe(false);
    expect(allowedBrowserOrigin("https://evil-box.attacker-tailnet.ts.net")).toBe(false);
  });

  test("the configured fronts (APP_SERVER_URL / ENGINE_PUBLIC_URL) allow their EXACT origin only", () => {
    delete process.env.ENGINE_PUBLIC_URL;
    process.env.APP_SERVER_URL = "https://myhost.tail1234.ts.net";
    expect(allowedBrowserOrigin("https://myhost.tail1234.ts.net")).toBe(true);
    // same tailnet, different host: refused. Suffixes buy nothing.
    expect(allowedBrowserOrigin("https://otherhost.tail1234.ts.net")).toBe(false);
    // scheme and port are part of the origin
    expect(allowedBrowserOrigin("http://myhost.tail1234.ts.net")).toBe(false);
    process.env.ENGINE_PUBLIC_URL = "https://front.example.com:8443";
    expect(allowedBrowserOrigin("https://front.example.com:8443")).toBe(true);
    expect(allowedBrowserOrigin("https://front.example.com")).toBe(false);
  });

  test("a misconfigured front URL opens nothing", () => {
    process.env.APP_SERVER_URL = "not a url";
    expect(allowedBrowserOrigin("https://evil.example.com")).toBe(false);
  });

  test("anything else, and an unparsable origin, is refused with a 403", async () => {
    for (const origin of ["https://evil.example.com", "not a url"]) {
      expect(originForbidden(req({ origin })), origin).toBe(true);
      const r = refuseForbiddenOrigin(req({ origin }))!;
      expect(r.status, origin).toBe(403);
      expect(((await r.json()) as any).ok).toBe(false);
    }
  });

  test("a loopback lookalike hostname is refused", () => {
    for (const origin of [
      "https://localhost.evil.com",
      "https://127.0.0.1.evil.com",
      "https://ts.net.evil.com",
      "https://myts.net.co",
      "https://notts.net",
    ]) {
      expect(allowedBrowserOrigin(origin), origin).toBe(false);
    }
  });

  test("an opaque or empty origin is refused, not read as absent", () => {
    /* Only a MISSING origin header means "native client". A present-but-empty
     * one, or the literal "null" a sandboxed iframe sends, is a browser that
     * declined to name itself, and that is exactly the drive-by case. */
    for (const origin of ["file:///Users/example/x.html", "null", "", "about:blank"]) {
      expect(originForbidden(req({ origin })), origin || "(empty)").toBe(true);
    }
  });

  test("a non-http(s) scheme is refused even with a loopback host", () => {
    expect(allowedBrowserOrigin("ftp://localhost")).toBe(false);
    expect(allowedBrowserOrigin("ws://localhost:51004")).toBe(false);
  });
});

describe("the host-header policy (allowedRequestHost / hostForbidden / refuseForbiddenHost)", () => {
  /* THE DNS-REBINDING GATE. The origin gate refuses a page that names itself;
   * a rebound page never has to: it re-points its own domain at 127.0.0.1 and
   * from then on its requests are same-origin in the browser's eyes -- a
   * loopback peer, no x-forwarded-for, and NO Origin header. The Host header
   * is the one thing that still names the attacker's domain, and this policy
   * refuses any Host the engine is not legitimately reached by. */
  const ENV_KEYS = ["APP_SERVER_URL", "ENGINE_PUBLIC_URL", "ENGINE_HOST", "AGENT_HOST"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const bare = () => { for (const k of ENV_KEYS) delete process.env[k]; };

  test("loopback Hosts pass: localhost, 127.0.0.1, [::1], any port, any case", () => {
    bare();
    expect(allowedRequestHost("localhost")).toBe(true);
    expect(allowedRequestHost("localhost:51001")).toBe(true);
    expect(allowedRequestHost("LOCALHOST:51002")).toBe(true);
    expect(allowedRequestHost("127.0.0.1")).toBe(true);
    expect(allowedRequestHost("127.0.0.1:51003")).toBe(true);
    expect(allowedRequestHost("[::1]:51004")).toBe(true);
    expect(allowedRequestHost("[::1]")).toBe(true);
  });

  test("an attacker domain is refused, with or without a port (the rebinding shape)", () => {
    bare();
    expect(allowedRequestHost("evil.com")).toBe(false);
    expect(allowedRequestHost("evil.com:51016")).toBe(false);
    expect(allowedRequestHost("evil.com:51017")).toBe(false);
  });

  test("a loopback lookalike hostname is refused", () => {
    bare();
    for (const host of ["localhost.evil.com", "127.0.0.1.evil.com:51005",
      "localhost.evil.com:51006", "127-0-0-1.evil.com"]) {
      expect(allowedRequestHost(host), host).toBe(false);
    }
  });

  test("parser games are refused: userinfo, paths, spaces, empty", () => {
    bare();
    for (const host of ["127.0.0.1@evil.com", "evil.com@127.0.0.1", "127.0.0.1/x",
      "127.0.0.1?x", "127.0.0.1 evil.com", "", "  ", "evil.com\\x"]) {
      expect(allowedRequestHost(host), JSON.stringify(host)).toBe(false);
    }
  });

  test("the machine's own name passes: bare and as its OWN tailnet MagicDNS name", () => {
    bare();
    process.env.ENGINE_HOST = "mybox";
    expect(allowedRequestHost("mybox")).toBe(true);
    expect(allowedRequestHost("mybox:51007")).toBe(true);
    expect(allowedRequestHost("mybox.tail1234.ts.net")).toBe(true);
    expect(allowedRequestHost("MYBOX.TAIL1234.TS.NET:51008")).toBe(true);
  });

  test("the ENGINE_HOST fallback is os.hostname(), so an unconfigured engine's own name still passes", () => {
    bare();
    const own = hostname().replace(/\.local$/i, "").toLowerCase();
    if (own) {
      expect(allowedRequestHost(own)).toBe(true);
      expect(allowedRequestHost(`${own}.tail1234.ts.net`)).toBe(true);
    }
  });

  test("a FOREIGN tailnet name is refused: *.ts.net is not a skeleton key here either", () => {
    bare();
    process.env.ENGINE_HOST = "mybox";
    // another machine on the same tailnet
    expect(allowedRequestHost("otherbox.tail1234.ts.net")).toBe(false);
    // an attacker's own tailnet machine
    expect(allowedRequestHost("evil-box.attacker-tailnet.ts.net")).toBe(false);
    // suffix tricks around .ts.net
    expect(allowedRequestHost("mybox.tail1234.ts.net.evil.com")).toBe(false);
    expect(allowedRequestHost("mybox.ts.net")).toBe(false);
    expect(allowedRequestHost("notmybox.tail1234.ts.net")).toBe(false);
  });

  test("<name>.local is deliberately NOT allowed (mDNS is LAN-spoofable; name it in ENGINE_PUBLIC_URL instead)", () => {
    bare();
    process.env.ENGINE_HOST = "mybox";
    expect(allowedRequestHost("mybox.local")).toBe(false);
    expect(allowedRequestHost("mybox.local:51009")).toBe(false);
  });

  test("the bound address (AGENT_HOST) passes; a wildcard bind opens NOTHING extra", () => {
    bare();
    process.env.AGENT_HOST = "192.168.7.42";
    expect(allowedRequestHost("192.168.7.42:51010")).toBe(true);
    expect(allowedRequestHost("192.168.7.43:51010")).toBe(false);
    process.env.AGENT_HOST = "0.0.0.0";
    expect(allowedRequestHost("0.0.0.0")).toBe(false);
    expect(allowedRequestHost("evil.com")).toBe(false);
    process.env.AGENT_HOST = "::";
    expect(allowedRequestHost("evil.com")).toBe(false);
  });

  test("the configured fronts allow their exact HOSTNAME, any port; a misconfigured one opens nothing", () => {
    bare();
    process.env.APP_SERVER_URL = "https://myhost.tail1234.ts.net";
    expect(allowedRequestHost("myhost.tail1234.ts.net")).toBe(true);
    expect(allowedRequestHost("myhost.tail1234.ts.net:443")).toBe(true);
    expect(allowedRequestHost("otherhost.tail1234.ts.net")).toBe(false);
    process.env.ENGINE_PUBLIC_URL = "https://front.example.com:8443";
    expect(allowedRequestHost("front.example.com")).toBe(true);
    expect(allowedRequestHost("front.example.com:8443")).toBe(true);
    process.env.APP_SERVER_URL = "not a url";
    expect(allowedRequestHost("evil.com")).toBe(false);
  });

  test("hostForbidden tolerates an ABSENT Host (in-process synthetic requests) and refuses a bad one", () => {
    bare();
    expect(hostForbidden(req())).toBe(false); // constructed Requests carry no Host header
    expect(hostForbidden(req({ host: "127.0.0.1:51011" }))).toBe(false);
    expect(hostForbidden(req({ host: "evil.com" }))).toBe(true);
  });

  test("refuseForbiddenHost fails CLOSED on a missing Host and 403s an attacker Host, json-shaped", async () => {
    bare();
    /* The TCP feed is the one place absence is refused: HTTP/1.1 mandates
     * Host and every real caller sends it (Bun fetch stamps the dial,
     * verified empirically); the no-Host HTTP/1.0 shape also arrives with a
     * RELATIVE req.url that the router's new URL() would throw on. */
    const noHost = refuseForbiddenHost(req())!;
    expect(noHost.status).toBe(403);
    const evil = refuseForbiddenHost(req({ host: "evil.com:51016" }))!;
    expect(evil.status).toBe(403);
    expect(((await evil.json()) as any).ok).toBe(false);
    expect(refuseForbiddenHost(req({ host: "localhost:51012" }))).toBeNull();
    expect(refuseForbiddenHost(req({ host: "127.0.0.1:51013" }))).toBeNull();
  });

  test("a loopback peer with a REBOUND Host is not trusted local, even with no Origin at all", () => {
    bare();
    /* THE shape the origin gate cannot see: true loopback peer, no
     * x-forwarded-for, no Origin -- only the Host names the attack. This is
     * what gates /ws (isTrustedLocal at the upgrade) and every owner/local
     * route as defense in depth under the pre-router refusal. */
    expect(isTrustedLocal(req({ host: "evil.com" }), from("127.0.0.1") as any)).toBe(false);
    expect(isTrustedLocal(req({ host: "evil.com:51016" }), from("127.0.0.1") as any)).toBe(false);
    // and the gates answer 403 to it
  });

  test("requireOwner and requireLocal both 403 the rebound shape from a loopback peer", async () => {
    bare();
    expect((await requireOwner(req({ host: "evil.com" }), from("127.0.0.1") as any))!.status).toBe(403);
    expect(requireLocal(req({ host: "evil.com" }), from("127.0.0.1") as any)!.status).toBe(403);
  });

  test("legitimate local callers stay trusted: loopback Host, own name, tailnet name, or no Host", () => {
    bare();
    process.env.ENGINE_HOST = "mybox";
    expect(isTrustedLocal(req({ host: "127.0.0.1:51014" }), from("127.0.0.1") as any)).toBe(true);
    expect(isTrustedLocal(req({ host: "localhost:51015" }), from("127.0.0.1") as any)).toBe(true);
    expect(isTrustedLocal(req({ host: "mybox.tail1234.ts.net" }), from("127.0.0.1") as any)).toBe(true);
    // absent Host: the sealed tunnel's synthetic Request and unit-test Requests
    expect(isTrustedLocal(req(), from("127.0.0.1") as any)).toBe(true);
  });

  test("the sealed-tunnel mark still opens requireOwner regardless of the host gate", async () => {
    bare();
    const tun = req();
    markSealedTunnel(tun);
    expect(await requireOwner(tun, from(null) as any)).toBeNull();
  });
});
