/* auth.ts's env-derived JWKS url and issuer, the seam where the fail-closed
 * brick lived: a newer JSON publishable key used to derive a garbage origin,
 * so jwksUrl() built a garbage url (JWKS fetch fails, keysByKid empty, every
 * token rejected) and issuer() returned garbage (the iss check fails every
 * token). These are pure env readers now delegating to clerk-key.ts. */

import { test, expect, afterEach } from "bun:test";
import { issuer, jwksUrl } from "./clerk-session";

/* Set exactly the four Clerk env vars this pair reads; restore afterwards so
 * no test leaks env into the next. */
const KEYS = ["CLERK_JWKS_URL", "CLERK_ISSUER", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});
function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jsonKey = (host: string) => "pk_test_" + b64url(JSON.stringify({ iss: `https://${host}` }));
const classicKey = (host: string) => "pk_test_" + btoa(`${host}$`);

test("newer JSON key with no explicit JWKS url derives a correct endpoint (the brick is gone)", () => {
  setEnv({ CLERK_PUBLISHABLE_KEY: jsonKey("foo.clerk.accounts.dev") });
  expect(jwksUrl()).toBe("https://foo.clerk.accounts.dev/.well-known/jwks.json");
});

test("newer JSON key with no explicit issuer derives the correct issuer", () => {
  setEnv({ CLERK_PUBLISHABLE_KEY: jsonKey("foo.clerk.accounts.dev") });
  expect(issuer()).toBe("https://foo.clerk.accounts.dev");
});

test("classic key derives the same two answers for its host (no regression)", () => {
  setEnv({ CLERK_PUBLISHABLE_KEY: classicKey("clean-cat-1.clerk.accounts.dev") });
  expect(jwksUrl()).toBe("https://clean-cat-1.clerk.accounts.dev/.well-known/jwks.json");
  expect(issuer()).toBe("https://clean-cat-1.clerk.accounts.dev");
});

test("a garbage key derives no url and no issuer (fail closed, never a garbage origin)", () => {
  setEnv({ CLERK_PUBLISHABLE_KEY: "pk_test_%%%" });
  expect(jwksUrl()).toBeNull();
  expect(issuer()).toBeNull();
});

test("explicit CLERK_JWKS_URL and CLERK_ISSUER win over derivation", () => {
  setEnv({
    CLERK_PUBLISHABLE_KEY: jsonKey("derived.clerk.accounts.dev"),
    CLERK_JWKS_URL: "https://explicit.example/jwks",
    CLERK_ISSUER: "https://explicit.example",
  });
  expect(jwksUrl()).toBe("https://explicit.example/jwks");
  expect(issuer()).toBe("https://explicit.example");
});
