/* Dormant Clerk setup verified directly against scratch JWKS, never runtime. */
import {test, expect, afterAll} from "bun:test";
import {verifySession} from "./clerk-session";
const servers: Array<{stop(): void}> = [];
const saved = {...process.env};
afterAll(() => { for (const s of servers) s.stop();
  for (const k of ["CLERK_JWKS_URL", "CLERK_ISSUER"]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});
const b64url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlJson = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

const KID = "test-key-1";
const ISSUER = "https://fake.clerk.test";
const key = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", key.publicKey);

/** A fake JWKS endpoint, served from the generated public key. */
function startJwks(): { url: string; stop: () => void } {
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response(
        JSON.stringify({ keys: [{ kty: "RSA", n: publicJwk.n, e: publicJwk.e, kid: KID, use: "sig", alg: "RS256" }] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const s = { url: `http://127.0.0.1:${srv.port}/jwks`, stop: () => srv.stop(true) };
  servers.push(s);
  return s;
}

/** Mint a Clerk-shaped session JWT signed by the local key. */
async function mint(opts: { sub: string; kid?: string; exp?: number } ): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: opts.kid ?? KID };
  const payload = { sub: opts.sub, iss: ISSUER, iat: now, nbf: now - 5, exp: opts.exp ?? now + 3600 };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}


test("Clerk JWT verification remains usable only by explicit setup", async () => {
  const jwks = startJwks();
  process.env.CLERK_JWKS_URL = jwks.url;
  process.env.CLERK_ISSUER = ISSUER;
  const good = await mint({sub: "user_scratch"});
  expect(await verifySession(good)).toBe("user_scratch");
  expect(await verifySession(good.slice(0, -8) + "AAAAAAAA")).toBeNull();
  expect(await verifySession(await mint({sub: "user_scratch", exp: 1}))).toBeNull();
  expect(await verifySession(await mint({sub: "user_scratch", kid: "unknown"}))).toBeNull();
  expect(await verifySession("bad.jwt")).toBeNull();
});
