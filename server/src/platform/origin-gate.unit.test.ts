/* The app-server's browser-origin gate (platform/httpx.ts), as a unit: which
 * Origin values pass, that no-Origin callers are untouched, and that json()
 * answers grant no CORS. The end-to-end proof (enroll refused for a drive-by
 * page over a real booted server) is in integration/hardening.test.ts. */

import { expect, test } from "bun:test";
import { allowedBrowserOrigin, refuseForbiddenOrigin, json } from "./httpx";

const req = (headers: Record<string, string> = {}) =>
  new Request("http://x/y", { headers });

test("no Origin header is never refused (engines and CLI callers send none)", () => {
  expect(refuseForbiddenOrigin(req())).toBeNull();
});

test("same-origin passes: the Origin's host equals the request's Host header", () => {
  expect(allowedBrowserOrigin("https://myhost.tail1234.ts.net", "myhost.tail1234.ts.net")).toBe(true);
  // case-insensitive, and an explicit port is part of the host on both sides
  expect(allowedBrowserOrigin("https://MyHost.Tail1234.TS.NET", "myhost.tail1234.ts.net")).toBe(true);
  expect(allowedBrowserOrigin("http://box.lan:51009", "box.lan:51009")).toBe(true);
  // a DIFFERENT host on the same tailnet is not same-origin: suffixes buy nothing
  expect(allowedBrowserOrigin("https://other.tail1234.ts.net", "myhost.tail1234.ts.net")).toBe(false);
  // and a missing Host header fails closed for non-loopback origins
  expect(allowedBrowserOrigin("https://myhost.tail1234.ts.net", null)).toBe(false);
});

test("loopback-hosted origins pass regardless of the Host header (the machine's own pages)", () => {
  expect(allowedBrowserOrigin("http://localhost:5173", "somewhere.else")).toBe(true);
  expect(allowedBrowserOrigin("http://127.0.0.1:51001", null)).toBe(true);
  expect(allowedBrowserOrigin("http://[::1]:51003", null)).toBe(true);
});

test("everything else is refused: drive-by pages, opaque origins, non-http schemes", () => {
  for (const origin of [
    "https://evil.example.com",
    "https://localhost.evil.com",
    "https://127.0.0.1.evil.com",
    "null", "", "about:blank", "not a url",
    "file:///Users/example/x.html",
    "ftp://localhost",
  ]) {
    expect(allowedBrowserOrigin(origin, "myhost.tail1234.ts.net"), origin || "(empty)").toBe(false);
    const r = refuseForbiddenOrigin(req({ origin, host: "myhost.tail1234.ts.net" }))!;
    expect(r?.status, origin || "(empty)").toBe(403);
  }
});

test("json() answers carry no CORS grant (the old wildcard is gone)", () => {
  const r = json({ ok: true });
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
  expect(r.headers.get("access-control-allow-methods")).toBeNull();
  expect(r.headers.get("access-control-allow-headers")).toBeNull();
});
