/* HOSTED mode: Clerk session verification and owner-scoped state.
 *
 * A real server process, exactly like settings.test.ts, but with the env that
 * flips it into HOSTED: CLERK_SECRET_KEY present (the switch, a fake sk_test_
 * value that is never a real key and is never used to call Clerk), and
 * CLERK_JWKS_URL pointing at a JWKS THIS TEST serves from a locally generated
 * RSA keypair. No real Clerk key is ever read, minted or committed.
 *
 * What it proves:
 *   - a valid session token gets 200 and scopes state to its `sub`
 *   - missing / bad-signature / expired / unknown-kid tokens get 401
 *   - two owners cannot see each other's settings or devices
 *   - public routes answer without any token, and /config reports the mode
 *
 *   bun test app-server/hosted.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollEngine, enrolledBearer, fakeEngine } from "../test-support/enrollkit";

type Stoppable = { stop: () => Promise<void> } | { stop: () => void };
let servers: Stoppable[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

// ---- the local RSA keypair and the JWKS built from it ----------------------

const b64url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlJson = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

// a unique port per spawned server: a shared counter off a random base so two
// servers in the same run never collide (which the old random pick sometimes
// did, a pre-existing harness flake the extra boot-guard spawns would worsen)
let nextPort = 8700 + Math.floor(Math.random() * 300);
const takePort = () => nextPort++;

const KID = "test-key-1";
const ISSUER = "https://fake.clerk.test";
// a locally generated VAPID pair, never a real key, only to satisfy the HOSTED
// boot guard so the store never falls back to a random per-owner pair
const VAPID_PUBLIC = "BOuHGkAv4-PtWtHGwZfTg0cZ1eXXYJhjZTG02Y-jbXwWULmHh_n35fGq7TcI9jGT1gy3GSX5VomGREvoFZdAnUU";
const VAPID_PRIVATE = "Sy2m28XLTu-1pDAao8kt50es9zajr6r0PXp0Pd-JvP0";
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

// ---- the app server, in HOSTED mode ----------------------------------------

type Server = { url: string; stop: () => Promise<void> };
async function startHosted(dir: string, jwksUrl: string): Promise<Server> {
  const port = takePort();
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: "127.0.0.1",
      DIST_DIR: dir,
      OWNERS_DIR: join(dir, "owners"),
      CYC_LOG_DIR: join(dir, "logs"),
      ENGINE_LEASES_FILE: join(dir, "leases.json"),
      ENGINE_TOKENS_FILE: join(dir, "engine-tokens.json"),
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
      // the switch (a fake key, never real, never used to call Clerk) and the
      // JWKS this test serves from its own keypair
      CLERK_SECRET_KEY: "sk_test_fake_not_a_real_key",
      CLERK_PUBLISHABLE_KEY: "pk_test_fake",
      CLERK_ISSUER: ISSUER,
      CLERK_JWKS_URL: jwksUrl,
      // HOSTED pins one push identity for the whole server; the boot guard
      // requires both, so tests supply a locally generated (never-real) pair
      VAPID_PUBLIC_KEY: VAPID_PUBLIC,
      VAPID_PRIVATE_KEY: VAPID_PRIVATE,
      // HOSTED refuses to boot without its public front named (host-header gate)
      APP_SERVER_URL: "https://cyc-hosted.example.com",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${url}/health`).then((r) => r.ok).catch(() => false)) break;
    await Bun.sleep(100);
    if (i === 79) throw new Error("app server did not start");
  }
  const s = { url, stop: async () => { proc.kill(); await proc.exited; } };
  servers.push(s);
  return s;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const getJson = async (url: string, headers?: Record<string, string>) =>
  (await fetch(url, { headers })).json() as Promise<any>;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const sub = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: "BJ" + "A".repeat(85), auth: "0123456789abcdef0123456" },
});

test("public routes need no token, and /config reports the mode", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const s = await startHosted(dir, jwks.url);

  expect((await fetch(`${s.url}/health`)).status).toBe(200);
  const health = await getJson(`${s.url}/health`);
  expect(health.mode).toBe("hosted");

  expect((await fetch(`${s.url}/push/key`)).status).toBe(200);

  const cfg = await getJson(`${s.url}/config`);
  expect(cfg.auth).toBe("clerk");
  expect(cfg.clerkPublishableKey).toBe("pk_test_fake");
});

test("owner-scoped routes 401 without a valid token", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const s = await startHosted(dir, jwks.url);

  // no token
  expect((await fetch(`${s.url}/settings`)).status).toBe(401);
  expect((await fetch(`${s.url}/push/devices`)).status).toBe(401);

  // bad signature: a valid token with its signature mangled
  const good = await mint({ sub: "user_a" });
  const tampered = good.slice(0, -4) + (good.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
  expect((await fetch(`${s.url}/settings`, { headers: bearer(tampered) })).status).toBe(401);

  // expired
  const expired = await mint({ sub: "user_a", exp: Math.floor(Date.now() / 1000) - 100 });
  expect((await fetch(`${s.url}/settings`, { headers: bearer(expired) })).status).toBe(401);

  // unknown kid: signed by the right key but a kid the JWKS does not carry
  const unknownKid = await mint({ sub: "user_a", kid: "no-such-kid" });
  expect((await fetch(`${s.url}/settings`, { headers: bearer(unknownKid) })).status).toBe(401);

  // garbage
  expect((await fetch(`${s.url}/settings`, { headers: bearer("not.a.jwt") })).status).toBe(401);
});

test("a valid token gets 200 and state is scoped to its sub", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const s = await startHosted(dir, jwks.url);

  const tokenA = await mint({ sub: "user_alice" });
  const tokenB = await mint({ sub: "user_bob" });

  // valid token -> 200 and the shipped defaults
  const a0 = await getJson(`${s.url}/settings`, bearer(tokenA));
  expect(a0).toMatchObject({ speed: 1, notify: true, seq: 0 });

  // alice changes her settings
  expect((await post(`${s.url}/settings`, { speed: 2, activity: false }, bearer(tokenA))).status).toBe(200);
  const a1 = await getJson(`${s.url}/settings`, bearer(tokenA));
  expect(a1).toMatchObject({ speed: 2, activity: false });

  // bob sees the defaults, NOT alice's change
  const b0 = await getJson(`${s.url}/settings`, bearer(tokenB));
  expect(b0).toMatchObject({ speed: 1, activity: true, seq: 0 });

  // the cookie form works too (Clerk's __session)
  const aCookie = await getJson(`${s.url}/settings`, { cookie: `__session=${tokenA}` });
  expect(aCookie.speed).toBe(2);
});

test("two owners cannot see each other's devices", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const s = await startHosted(dir, jwks.url);

  const tokenA = await mint({ sub: "user_alice" });
  const tokenB = await mint({ sub: "user_bob" });

  // alice subscribes one device
  const r = await post(`${s.url}/push/subscribe`,
    { subscription: sub("https://fcm.example/alice"), label: "alice phone", deviceId: "dev-a" },
    bearer(tokenA));
  expect((await r.json()).ok).toBe(true);

  const aDevices = await getJson(`${s.url}/push/devices`, bearer(tokenA));
  expect(aDevices.devices.length).toBe(1);

  // bob has none
  const bDevices = await getJson(`${s.url}/push/devices`, bearer(tokenB));
  expect(bDevices.devices.length).toBe(0);
});

test("a hanging JWKS answers within ~5s with 401, never hangs the request", async () => {
  // a JWKS endpoint that accepts the connection and then never responds: the
  // verifier's AbortSignal.timeout(5000) must fire so the route fails closed
  const hung: Response[] = [];
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch() { return new Promise<Response>(() => {}); }, // never resolves
  });
  servers.push({ stop: () => srv.stop(true) });
  const hangUrl = `http://127.0.0.1:${srv.port}/jwks`;

  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const s = await startHosted(dir, hangUrl);

  // a token whose kid is a cache miss forces the (stalled) JWKS fetch
  const token = await mint({ sub: "user_alice" });
  const started = Date.now();
  const res = await fetch(`${s.url}/settings`, { headers: bearer(token) });
  const elapsed = Date.now() - started;
  void hung;

  expect(res.status).toBe(401);
  // the 5s abort plus request overhead, comfortably under a hang
  expect(elapsed).toBeLessThan(8000);
}, 15000);

test("HOSTED without both VAPID keys refuses to boot with a clear message", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const port = takePort();
  const baseEnv = {
    ...process.env,
    APP_PORT: String(port),
    APP_HOST: "127.0.0.1",
    DIST_DIR: dir,
    OWNERS_DIR: join(dir, "owners"),
    CYC_LOG_DIR: join(dir, "logs"),
    VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
    CLERK_SECRET_KEY: "sk_test_fake_not_a_real_key",
    CLERK_PUBLISHABLE_KEY: "pk_test_fake",
    CLERK_ISSUER: ISSUER,
    CLERK_JWKS_URL: jwks.url,
  } as Record<string, string>;
  // CLERK_SECRET_KEY set (HOSTED) but VAPID unset -> exit non-zero with message
  delete baseEnv.VAPID_PUBLIC_KEY;
  delete baseEnv.VAPID_PRIVATE_KEY;

  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: baseEnv, stdout: "ignore", stderr: "pipe",
  });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(code).not.toBe(0);
  expect(stderr).toContain("VAPID_PUBLIC_KEY");
  expect(stderr).toContain("VAPID_PRIVATE_KEY");

  // with both set it boots and serves
  const ok = await startHosted(dir, jwks.url);
  expect((await fetch(`${ok.url}/health`)).status).toBe(200);
});

test("state survives a restart, keyed by sub", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const token = await mint({ sub: "user_alice" });

  const s1 = await startHosted(dir, jwks.url);
  await post(`${s1.url}/settings`, { speed: 1.75 }, bearer(token));
  await Bun.sleep(50);
  await s1.stop();
  servers = servers.filter((x) => x !== s1);

  const s2 = await startHosted(dir, jwks.url);
  const j = await getJson(`${s2.url}/settings`, bearer(token));
  expect(j.speed).toBe(1.75);
});

// ---- engine enrollment: the Clerk session is the gate, the issued token is
// ---- the only engine credential, and everything it opens is owner-scoped

test("enrollment needs a Clerk session; announce and push need an issued token", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const s = await startHosted(dir, jwks.url);
  const eng = await fakeEngine();

  // a correctly SIGNED enrollment with no session (or a garbage one) is 401:
  // the signature proves the engine, the session proves the owner, both gate
  expect((await enrollEngine(s.url, eng)).status).toBe(401);
  expect((await enrollEngine(s.url, eng, bearer("not.a.jwt"))).status).toBe(401);

  // and with no engine ever enrolled, announce and push are 401, never open
  const ann = { engineId: eng.engineId, host: "mac", url: "ws://mac:10101/ws" };
  expect((await post(`${s.url}/engines/announce`, ann)).status).toBe(401);
  expect((await post(`${s.url}/push/notify`, { sessionId: "x", body: "b" })).status).toBe(401);
  expect((await post(`${s.url}/push/batch`, { host: "mac", new: [] })).status).toBe(401);

  // nothing bogus landed where an owner would read
  const aToken = await mint({ sub: "user_alice" });
  expect((await getJson(`${s.url}/engines`, bearer(aToken))).engines).toEqual([]);
});

test("an enrolled engine announces as its owner, scoped in /engines and /config", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const s = await startHosted(dir, jwks.url);

  const tokenA = await mint({ sub: "user_alice" });
  const tokenB = await mint({ sub: "user_bob" });

  // alice's session gates the enrollment; the engine token comes back
  const a = await enrolledBearer(s.url, await fakeEngine("e-a"), bearer(tokenA));
  expect((await enrollEngine(s.url, a.eng, bearer(tokenA))).json.owner).toBe("user_alice");

  const r = await post(`${s.url}/engines/announce`,
    { engineId: "e-a", host: "mac", url: "ws://a-host:10101/ws" },
    { authorization: `Bearer ${(await enrollEngine(s.url, a.eng, bearer(tokenA))).token}` });
  expect(r.status).toBe(200);
  expect((await r.json()).ok).toBe(true);

  // A sees it, and the lease owner is the TOKEN's owner, never a body claim
  const aEngines = await getJson(`${s.url}/engines`, bearer(tokenA));
  expect(aEngines.engines).toHaveLength(1);
  expect(aEngines.engines[0]).toMatchObject({ engineId: "e-a", owner: "user_alice" });
  expect((await getJson(`${s.url}/config`, bearer(tokenA))).engines).toEqual([
    { url: "ws://a-host:10101/ws", engineId: "e-a", host: "user_alice" },
  ]);

  // B sees neither, in /engines nor in /config (announce-only: nothing of B's,
  // and no seed default)
  expect((await getJson(`${s.url}/engines`, bearer(tokenB))).engines).toEqual([]);
  expect((await getJson(`${s.url}/config`, bearer(tokenB))).engines).toEqual([]);

  // /engines still needs a session in HOSTED (no token -> 401)
  expect((await fetch(`${s.url}/engines`)).status).toBe(401);

  // /engines/enrolled is session-scoped the same way
  const aList = await getJson(`${s.url}/engines/enrolled`, bearer(tokenA));
  expect(aList.engines.map((e: any) => e.engineId)).toEqual(["e-a"]);
  expect((await getJson(`${s.url}/engines/enrolled`, bearer(tokenB))).engines).toEqual([]);
  expect((await fetch(`${s.url}/engines/enrolled`)).status).toBe(401);
});

test("owner-scoping: engine A's token cannot reach owner B's account", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const s = await startHosted(dir, jwks.url);

  const tokenA = await mint({ sub: "user_alice" });
  const tokenB = await mint({ sub: "user_bob" });
  const a = await enrolledBearer(s.url, await fakeEngine("e-alice"), bearer(tokenA));
  const b = await enrolledBearer(s.url, await fakeEngine("e-bob"), bearer(tokenB));

  // bob subscribes one device; alice has none. The `devices` count each push
  // answers with is the proof of WHOSE store the push landed in.
  await post(`${s.url}/push/subscribe`,
    { subscription: sub("https://127.0.0.1:1/bob-phone"), label: "bob phone", deviceId: "dev-b" },
    bearer(tokenB));

  const viaA = (await (await post(`${s.url}/push/notify`,
    { sessionId: "x", body: "hi" }, a.bearer)).json()) as any;
  const viaB = (await (await post(`${s.url}/push/notify`,
    { sessionId: "x", body: "hi" }, b.bearer)).json()) as any;
  expect(viaA.devices).toBe(0);  // alice's engine buzzes alice's (empty) store
  expect(viaB.devices).toBe(1);  // bob's engine reaches bob's device, only

  // a token speaks only for its own engineId: A's token cannot announce B's
  expect((await post(`${s.url}/engines/announce`,
    { engineId: "e-bob", host: "mac", url: "ws://evil:10101/ws" }, a.bearer)).status).toBe(403);

  // and an engineId enrolled by A cannot be re-enrolled under B's session,
  // even by the SAME identity key (owner mismatch), nor by a different key
  expect((await enrollEngine(s.url, a.eng, bearer(tokenB))).status).toBe(403);
  expect((await enrollEngine(s.url, await fakeEngine("e-alice"), bearer(tokenB))).status).toBe(403);

  // revocation is owner-scoped: B cannot revoke A's engine (404, not 403,
  // so the route cannot enumerate), A can, and the token dies at once
  expect((await post(`${s.url}/engines/revoke`, { engineId: "e-alice" }, bearer(tokenB))).status).toBe(404);
  expect((await post(`${s.url}/engines/revoke`, { engineId: "e-alice" }, bearer(tokenA))).status).toBe(200);
  expect((await post(`${s.url}/push/notify`, { sessionId: "x", body: "b" }, a.bearer)).status).toBe(401);
  expect((await enrollEngine(s.url, a.eng, bearer(tokenA))).status).toBe(403); // barred until restored
});

test("an enrolled engine reads its owner's /settings (the two dials), read-only", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-hosted-"));
  dirs.push(dir);
  const s = await startHosted(dir, jwks.url);

  const tokenA = await mint({ sub: "user_alice" });
  await post(`${s.url}/settings`, { replyLevel: 5 }, bearer(tokenA));
  const a = await enrolledBearer(s.url, await fakeEngine("e-a"), bearer(tokenA));

  const viaEngine = await getJson(`${s.url}/settings`, a.bearer);
  expect(viaEngine.replyLevel).toBe(5);
  // the engine token does not open the WRITE side
  expect((await post(`${s.url}/settings`, { replyLevel: 1 }, a.bearer)).status).toBe(401);
});
