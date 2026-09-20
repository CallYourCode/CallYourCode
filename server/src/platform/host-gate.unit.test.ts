/* The app-server's host-header gate (platform/httpx.ts), as a unit: which
 * Host values pass, that a missing Host fails closed, and that the
 * DNS-rebound same-origin shape (Origin host == attacker Host) is refused by
 * the host gate BEFORE the origin gate's same-origin rule can accept it. The
 * end-to-end proof over a real booted server is in
 * integration/hardening.test.ts.
 *
 * No port number in this file is a real deploy's: unit tests never dial. */

import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import { allowedRequestHost, refuseForbiddenHost, allowedBrowserOrigin } from "./httpx";

const req = (headers: Record<string, string> = {}) =>
  new Request("http://x/y", { headers });

const ENV_KEYS = ["APP_SERVER_URL", "APP_HOST"] as const;
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
  for (const host of ["localhost", "localhost:51001", "LOCALHOST:51002",
    "127.0.0.1", "127.0.0.1:51003", "[::1]", "[::1]:51004"]) {
    expect(allowedRequestHost(host), host).toBe(true);
  }
});

test("an attacker domain is refused, with or without a port (the rebinding shape)", () => {
  bare();
  for (const host of ["evil.com", "evil.com:51005", "localhost.evil.com",
    "127.0.0.1.evil.com:51006"]) {
    expect(allowedRequestHost(host), host).toBe(false);
  }
});

test("parser games are refused: userinfo, paths, spaces, empty", () => {
  bare();
  for (const host of ["127.0.0.1@evil.com", "evil.com@127.0.0.1", "127.0.0.1/x",
    "127.0.0.1?x", "127.0.0.1 evil.com", "", "  "]) {
    expect(allowedRequestHost(host), JSON.stringify(host)).toBe(false);
  }
});

test("the machine's own name passes, bare and as its OWN tailnet MagicDNS name; foreign tailnet names never", () => {
  bare();
  const own = hostname().replace(/\.local$/i, "").toLowerCase();
  if (own) {
    expect(allowedRequestHost(own)).toBe(true);
    expect(allowedRequestHost(`${own}.tail1234.ts.net`)).toBe(true);
    expect(allowedRequestHost(`${own}.tail1234.ts.net:51007`)).toBe(true);
    // <name>.local is deliberately NOT allowed (mDNS is LAN-spoofable)
    expect(allowedRequestHost(`${own}.local`)).toBe(false);
    // suffix tricks around .ts.net buy nothing
    expect(allowedRequestHost(`${own}.tail1234.ts.net.evil.com`)).toBe(false);
    expect(allowedRequestHost(`not${own}.tail1234.ts.net`)).toBe(false);
  }
  expect(allowedRequestHost("evil-box.attacker-tailnet.ts.net")).toBe(false);
});

test("the bound address (APP_HOST) passes; a wildcard bind opens NOTHING extra", () => {
  bare();
  process.env.APP_HOST = "192.168.7.42";
  expect(allowedRequestHost("192.168.7.42:51008")).toBe(true);
  expect(allowedRequestHost("192.168.7.43:51008")).toBe(false);
  process.env.APP_HOST = "0.0.0.0";
  expect(allowedRequestHost("0.0.0.0")).toBe(false);
  expect(allowedRequestHost("evil.com")).toBe(false);
});

test("APP_SERVER_URL allows its exact HOSTNAME, any port; a misconfigured one opens nothing", () => {
  bare();
  process.env.APP_SERVER_URL = "https://cyc.example.com";
  expect(allowedRequestHost("cyc.example.com")).toBe(true);
  expect(allowedRequestHost("cyc.example.com:8443")).toBe(true);
  expect(allowedRequestHost("notcyc.example.com")).toBe(false);
  process.env.APP_SERVER_URL = "not a url";
  expect(allowedRequestHost("evil.com")).toBe(false);
});

test("refuseForbiddenHost fails CLOSED on a missing Host and 403s an attacker Host; allowed Hosts pass", async () => {
  bare();
  /* HTTP/1.1 mandates Host and every real caller sends it (engines' fetch,
   * the CLI, every browser); the only no-Host shape is a hand-written
   * HTTP/1.0 request, which also arrives with a relative req.url the fetch
   * handler could not even parse. */
  expect(refuseForbiddenHost(req())!.status).toBe(403);
  const evil = refuseForbiddenHost(req({ host: "evil.com:51009" }))!;
  expect(evil.status).toBe(403);
  expect(((await evil.json()) as any).error).toContain("Host");
  expect(refuseForbiddenHost(req({ host: "127.0.0.1:51010" }))).toBeNull();
  expect(refuseForbiddenHost(req({ host: "localhost" }))).toBeNull();
});

test("the REBOUND same-origin shape: the origin gate alone would accept it, the host gate refuses it first", () => {
  bare();
  /* DNS rebinding makes the browser same-origin with the attacker's domain:
   * Origin http://evil.com:51011 with Host evil.com:51011. The same-origin
   * compare (allowedBrowserOrigin) PASSES that pair -- its trust anchor is
   * the Host header itself -- which is exactly why the host gate must run
   * first and refuse the Host. Pinned here so nobody reorders the two. */
  expect(allowedBrowserOrigin("http://evil.com:51011", "evil.com:51011")).toBe(true);
  expect(allowedRequestHost("evil.com:51011")).toBe(false);
  expect(refuseForbiddenHost(req({ host: "evil.com:51011", origin: "http://evil.com:51011" }))!.status).toBe(403);
});
