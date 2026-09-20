import { clerkFrontendOrigin } from "./clerk-key";

/** base64url (and plain base64) to bytes. A JWT's parts are base64url. */
function b64ToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 ? "=".repeat(4 - (norm.length % 4)) : "";
  const bin = atob(norm + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** Exported for its unit test: the JWKS endpoint, from CLERK_JWKS_URL or
 *  derived from the publishable key. Null when neither can name one. */
export function jwksUrl(): string | null {
  if (process.env.CLERK_JWKS_URL) return process.env.CLERK_JWKS_URL;
  const fapi = clerkFrontendOrigin();
  return fapi ? `${fapi}/.well-known/jwks.json` : null;
}

/** Exported for its unit test: the issuer to check, from CLERK_ISSUER or the
 *  publishable key's frontend origin. Null when we cannot name it, in which
 *  case the iss check is skipped rather than faked. */
export function issuer(): string | null {
  return process.env.CLERK_ISSUER ?? clerkFrontendOrigin();
}

/* THE KEY CACHE, keyed by `kid`.
 *
 * Clerk rotates signing keys, and a session minted after a rotation carries a
 * `kid` this process has never seen. So a miss is not a failure: it refreshes
 * the set once (rate-limited, so a flood of forged kids cannot turn into a
 * flood of fetches) and looks again. Only after that is a `kid` truly unknown,
 * and then the token is rejected. */
let keysByKid = new Map<string, CryptoKey>();
let lastFetch = 0;
const REFRESH_MIN_MS = 10_000;

async function refreshJwks(): Promise<void> {
  const url = jwksUrl();
  if (!url) return;
  lastFetch = Date.now();
  let data: any;
  try {
    /* A stalled Clerk JWKS must not hang the first request for an uncached kid:
     * abort the fetch after 5s so the verifier returns null and the route 401s,
     * the same fail-closed outcome as a garbage or unreachable JWKS. */
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  const next = new Map<string, CryptoKey>();
  for (const k of keys) {
    if (k?.kty !== "RSA" || typeof k?.kid !== "string") continue;
    if (k.alg && k.alg !== "RS256") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      next.set(k.kid, key);
    } catch {
      /* a malformed entry is skipped, not fatal to the rest of the set */
    }
  }
  if (next.size) keysByKid = next;
}

async function keyFor(kid: string): Promise<CryptoKey | null> {
  const have = keysByKid.get(kid);
  if (have) return have;
  if (Date.now() - lastFetch > REFRESH_MIN_MS) await refreshJwks();
  return keysByKid.get(kid) ?? null;
}

/* Verify a Clerk session JWT and return its `sub` (the owner id), or null.
 *
 * FAILS CLOSED on everything: a malformed token, an algorithm that is not
 * RS256, a `kid` no key matches, a bad signature, an expired or not-yet-valid
 * token, or a wrong issuer. Only RS256 is accepted -- `alg: none` and the HS*
 * confusion where a public key is used as an HMAC secret are both refused here
 * because the header's alg is checked before any key is chosen. */
export async function verifySession(token: string): Promise<string | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const header = JSON.parse(decode(b64ToBytes(h)));
    if (header?.alg !== "RS256") return null;
    if (typeof header?.kid !== "string") return null;
    const key = await keyFor(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      b64ToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(decode(b64ToBytes(p)));
    const now = Math.floor(Date.now() / 1000);
    const leeway = 5;
    if (typeof claims?.exp === "number" && claims.exp + leeway < now) return null;
    if (typeof claims?.nbf === "number" && claims.nbf - leeway > now) return null;
    const iss = issuer();
    if (iss && claims?.iss !== iss) return null;
    if (typeof claims?.sub !== "string" || !claims.sub) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/** A `sub` that is safe to use as a directory name. Clerk ids are
 *  `user_<base58>`, so this is generous but refuses anything with a slash, a
 *  dot-dot, or a control character that could escape the owners tree. */
export function safeSub(sub: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sub);
}
