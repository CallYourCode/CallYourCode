/* clerk-key.ts as a unit: the single source of truth for decoding the Clerk
 * frontend origin out of a publishable key. Both payload formats, the host
 * reduction, and every malformed input answering null (never a garbage origin
 * a caller would turn into a broken JWKS url, issuer, or CSP token). */

import { test, expect } from "bun:test";
import { clerkFrontendOrigin } from "./clerk-key";

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("classic base64(\"<host>$\") payload decodes to the origin", () => {
  const pk = "pk_test_" + btoa("clean-cat-1.clerk.accounts.dev$");
  expect(clerkFrontendOrigin(pk)).toBe("https://clean-cat-1.clerk.accounts.dev");
});

test("newer base64url JSON {\"iss\"} payload decodes to the origin (test and live)", () => {
  const payload = b64url(JSON.stringify({ iss: "https://foo.clerk.accounts.dev" }));
  expect(clerkFrontendOrigin("pk_test_" + payload)).toBe("https://foo.clerk.accounts.dev");
  expect(clerkFrontendOrigin("pk_live_" + payload)).toBe("https://foo.clerk.accounts.dev");
});

test("a JSON iss with scheme, port and path is reduced to the bare host", () => {
  const payload = b64url(JSON.stringify({ iss: "http://bar.clerk.accounts.dev:8443/some/path" }));
  expect(clerkFrontendOrigin("pk_live_" + payload)).toBe("https://bar.clerk.accounts.dev");
});

test("absent, malformed and junk keys all answer null (never a garbage origin)", () => {
  expect(clerkFrontendOrigin("")).toBeNull();
  expect(clerkFrontendOrigin("pk_test_%%%")).toBeNull();       // not base64
  expect(clerkFrontendOrigin("not-a-key")).toBeNull();          // no pk_ prefix
  expect(clerkFrontendOrigin("sk_test_" + btoa("x$"))).toBeNull(); // secret, not publishable
  // decodes cleanly but the host fails the charset check -> null, not an origin
  expect(clerkFrontendOrigin("pk_test_" + btoa("has space$"))).toBeNull();
  expect(clerkFrontendOrigin("pk_test_" + b64url(JSON.stringify({ iss: "https://a b" })))).toBeNull();
});
