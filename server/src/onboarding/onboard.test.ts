/* Cloud onboarding (onboard.ts + grants.ts): the grant lifecycle and the
 * /enroll surface.
 *
 * Unit-level: grants are minted bound to a sub, redeem exactly once, expire,
 * and refuse forgeries; the page renders offline (no Clerk is ever stood up:
 * the page only REFERENCES Clerk's script, and these tests never execute it);
 * LOCAL answers 404 for the mint.
 *
 * Live: one HOSTED app server (the hosted.test.ts harness pattern: a fake
 * JWKS served from a locally generated RSA key, never a real Clerk key) that
 * proves the wire flow: no session -> 401; session -> grant; enrollment with
 * the grant issues a token bound to the session's owner; the same grant a
 * second time and a forged grant are refused.
 *
 *   bun test app-server/onboard.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnrollDevices, EnrollGrants, GRANTS_PER_SUB_MAX, mintGrantCode } from "../access/grants";
import { ENROLL_DEVICE_RATE_MAX, ENROLL_POLL_RATE_MAX } from "../platform/caps";
import { clerkFrontendOrigin } from "../access/clerk-key";
import { enrollPageHtml, enrollPageJs, onboardRoutes } from "./onboard";
import { enrollEngine, fakeEngine } from "../test-support/enrollkit";

type Stoppable = { stop: () => Promise<void> } | { stop: () => void };
let servers: Stoppable[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

/* ----------------------------------------------------- the grant lifecycle */

test("a grant redeems exactly once, for the sub it was minted for", () => {
  const grants = new EnrollGrants();
  const { code, expiresAt } = grants.mint("user_a");
  expect(code).toMatch(/^cyg_[A-Za-z0-9_-]{20}$/);
  expect(expiresAt).toBeGreaterThan(Date.now());

  expect(grants.redeem(code)).toEqual({ ok: true, sub: "user_a" });
  // single-use: the second redeem is refused, and names why
  expect(grants.redeem(code)).toEqual({ ok: false, why: "used" });
});

test("forged, malformed and expired grants are refused", () => {
  const grants = new EnrollGrants();
  grants.mint("user_a");
  expect(grants.redeem(mintGrantCode()).ok).toBe(false); // right shape, never minted
  expect(grants.redeem("cyt_not_a_grant").ok).toBe(false); // wrong prefix
  expect(grants.redeem("cyg_" + "A".repeat(200)).ok).toBe(false); // oversized
  expect(grants.redeem("").ok).toBe(false);

  const dead = new EnrollGrants(-1); // born expired
  const { code } = dead.mint("user_b");
  expect(dead.redeem(code)).toEqual({ ok: false, why: "expired" });
});

test("one sub's outstanding grants are capped; the newest always works", () => {
  const grants = new EnrollGrants();
  const codes = Array.from({ length: GRANTS_PER_SUB_MAX + 3 }, () => grants.mint("user_a").code);
  expect(grants.size).toBeLessThanOrEqual(GRANTS_PER_SUB_MAX);
  // the oldest were evicted, the newest (the code on screen) redeems
  expect(grants.redeem(codes[0]).ok).toBe(false);
  expect(grants.redeem(codes[codes.length - 1])).toEqual({ ok: true, sub: "user_a" });
});

/* -------------------------------------------------- the device sessions */

test("a device session hands its grant to the poll exactly once", () => {
  const devices = new EnrollDevices();
  const { deviceCode, userCode, expiresAt } = devices.start();
  expect(deviceCode).toMatch(/^cyd_[A-Za-z0-9_-]{20}$/);
  expect(userCode).toMatch(/^cyu_[A-Za-z0-9_-]{20}$/);
  expect(expiresAt).toBeGreaterThan(Date.now());

  // nothing attached yet: pending
  expect(devices.poll(deviceCode)).toEqual({ status: "pending" });

  // the page attaches the grant by user code; first attach wins
  expect(devices.attach(userCode, "cyg_grant1")).toBe(true);
  expect(devices.attach(userCode, "cyg_grant2")).toBe(false);

  // the poll receives it ONCE; the session dies with the answer
  expect(devices.poll(deviceCode)).toEqual({ status: "granted", grant: "cyg_grant1" });
  expect(devices.poll(deviceCode)).toEqual({ status: "unknown" });
  expect(devices.size).toBe(0);
});

test("device sessions refuse forgeries, junk and expiry", () => {
  const devices = new EnrollDevices();
  const { userCode } = devices.start();
  // a device code never started, the user code on the wrong side, junk shapes
  expect(devices.poll("cyd_" + "A".repeat(20))).toEqual({ status: "unknown" });
  expect(devices.poll(userCode)).toEqual({ status: "unknown" });
  expect(devices.poll("")).toEqual({ status: "unknown" });
  expect(devices.poll("cyd_" + "A".repeat(200))).toEqual({ status: "unknown" });
  expect(devices.attach("cyu_neverminted12345678", "cyg_x")).toBe(false);
  expect(devices.attach("", "cyg_x")).toBe(false);

  const dead = new EnrollDevices(-1); // born expired
  const s = dead.start();
  expect(dead.attach(s.userCode, "cyg_x")).toBe(false);
  expect(dead.poll(s.deviceCode)).toEqual({ status: "unknown" });
});

/* ------------------------------------------- the page, rendered offline */

test("the hosted page renders sign-in + copy affordances; LOCAL renders none", () => {
  const hosted = enrollPageHtml(true);
  expect(hosted).toContain("<!doctype html>");
  expect(hosted).toContain('id="signin"');
  expect(hosted).toContain('id="code"');
  expect(hosted).toContain('id="copy"');
  expect(hosted).toContain('src="/enroll.js"'); // no inline script: CSP has no unsafe-inline
  expect(hosted).toContain("Paste this code into your terminal");
  expect(hosted).toContain('id="linked"'); // the auto-receive "return to your terminal" panel
  expect(hosted).not.toContain("<script>");

  const local = enrollPageHtml(false);
  expect(local).toContain("local mode");
  expect(local).not.toContain("script");
});

test("the page script carries the publishable key and the Clerk origin", () => {
  const js = enrollPageJs("pk_test_abc", "https://clean-cat-1.clerk.accounts.dev");
  expect(js).toContain('"pk_test_abc"');
  expect(js).toContain("https://clean-cat-1.clerk.accounts.dev/npm/@clerk/clerk-js@5");
  expect(js).toContain("/enroll/grant");
  // the device flow: the user code is read off ?code=, sent with the mint,
  // and scrubbed from the address bar
  expect(js).toContain('get("code")');
  expect(js).toContain("attached");
  expect(js).toContain("history.replaceState");
  // no key configured: the script still parses and says so instead of fetching
  const bare = enrollPageJs("", null);
  expect(bare).toContain("not configured");
});

test("clerkFrontendOrigin decodes both publishable-key payload formats", () => {
  const classic = "pk_test_" + btoa("clean-cat-1.clerk.accounts.dev$");
  expect(clerkFrontendOrigin(classic)).toBe("https://clean-cat-1.clerk.accounts.dev");
  const json = "pk_live_" + btoa(JSON.stringify({ iss: "https://clerk.example.com" }));
  expect(clerkFrontendOrigin(json)).toBe("https://clerk.example.com");
  expect(clerkFrontendOrigin("")).toBeNull();
  expect(clerkFrontendOrigin("pk_test_%%%")).toBeNull();
});

/* --------------------------- the routes, driven directly (no server, no Clerk) */

const routeDeps = (hosted: boolean, sub: string | null,
  grants = new EnrollGrants(), devices = new EnrollDevices()) => ({
  hosted, grants, devices,
  sessionSub: async () => sub,
  docHeaders: { "content-security-policy": "test-csp" },
  baseHeaders: {},
});

test("LOCAL: the page says so; the mint and the device flow do not exist", async () => {
  const page = await onboardRoutes(new Request("http://x/enroll"), "/enroll", routeDeps(false, null));
  expect(page!.status).toBe(200);
  expect(await page!.text()).toContain("local mode");

  for (const path of ["/enroll/grant", "/enroll/device", "/enroll/device/poll"]) {
    const r = await onboardRoutes(
      new Request(`http://x${path}`, { method: "POST" }), path, routeDeps(false, null));
    expect(r!.status).toBe(404);
  }
});

test("the mint requires an authenticated session and binds the sub", async () => {
  const grants = new EnrollGrants();
  const anon = await onboardRoutes(
    new Request("http://x/enroll/grant", { method: "POST" }), "/enroll/grant", routeDeps(true, null, grants));
  expect(anon!.status).toBe(401);
  expect(grants.size).toBe(0); // nothing was minted for the refused caller

  const ok = await onboardRoutes(
    new Request("http://x/enroll/grant", { method: "POST" }), "/enroll/grant", routeDeps(true, "user_a", grants));
  expect(ok!.status).toBe(200);
  const j = await ok!.json() as any;
  expect(j.grant).toMatch(/^cyg_/);
  expect(grants.redeem(j.grant)).toEqual({ ok: true, sub: "user_a" });
});

test("a mint carrying a live user code attaches the grant instead of showing it", async () => {
  const grants = new EnrollGrants();
  const devices = new EnrollDevices();
  const deps = routeDeps(true, "user_a", grants, devices);

  const start = await onboardRoutes(
    new Request("http://x/enroll/device", { method: "POST" }), "/enroll/device", deps);
  expect(start!.status).toBe(200);
  const s = await start!.json() as any;
  expect(s.device).toMatch(/^cyd_/);
  expect(s.code).toMatch(/^cyu_/);

  const poll = (device: unknown) => onboardRoutes(
    new Request("http://x/enroll/device/poll", {
      method: "POST", body: JSON.stringify({ device }),
      headers: { "content-type": "application/json" },
    }), "/enroll/device/poll", deps);

  expect(await (await poll(s.device))!.json()).toEqual({ status: "pending" });

  // the signed-in page mints WITH the code: the grant rides the session and
  // the page's answer carries no cyg_ at all
  const minted = await onboardRoutes(
    new Request("http://x/enroll/grant", {
      method: "POST", body: JSON.stringify({ code: s.code }),
      headers: { "content-type": "application/json" },
    }), "/enroll/grant", deps);
  expect(minted!.status).toBe(200);
  const mj = await minted!.json() as any;
  expect(mj.attached).toBe(true);
  expect(JSON.stringify(mj)).not.toContain("cyg_");

  // the engine's poll receives the grant, once, and it redeems for the sub
  const got = await (await poll(s.device))!.json() as any;
  expect(got.status).toBe("granted");
  expect(grants.redeem(got.grant)).toEqual({ ok: true, sub: "user_a" });
  expect((await poll(s.device))!.status).toBe(404);
  // junk polls are 404 too
  expect((await poll("cyd_never"))!.status).toBe(404);
  expect((await poll(42))!.status).toBe(404);
});

test("a mint with a dead user code degrades to showing the grant", async () => {
  const deps = routeDeps(true, "user_a");
  const minted = await onboardRoutes(
    new Request("http://x/enroll/grant", {
      method: "POST", body: JSON.stringify({ code: "cyu_expiredorforged1" }),
      headers: { "content-type": "application/json" },
    }), "/enroll/grant", deps);
  expect(minted!.status).toBe(200);
  const j = await minted!.json() as any;
  expect(j.attached).toBeUndefined();
  expect(j.grant).toMatch(/^cyg_/); // manual copy still works
});

/* ------------------------ the unauthenticated routes are rate-capped ------ */
/* The buckets are module-level in onboard.ts and roll over a minute, so each
 * test here uses its OWN source key; the direct-driven tests above (no
 * rateKey) share the "?" bucket and stay far under both caps. */

const startDevice = (deps: any) => onboardRoutes(
  new Request("http://x/enroll/device", { method: "POST" }), "/enroll/device", deps);
const pollDevice = (deps: any, device: unknown) => onboardRoutes(
  new Request("http://x/enroll/device/poll", {
    method: "POST", body: JSON.stringify({ device }),
    headers: { "content-type": "application/json" },
  }), "/enroll/device/poll", deps);

test("/enroll/device is rate-capped per source; another source is untouched", async () => {
  const deps = { ...routeDeps(true, null), rateKey: () => "src-device-cap" };
  for (let i = 0; i < ENROLL_DEVICE_RATE_MAX; i++) {
    expect((await startDevice(deps))!.status).toBe(200);
  }
  const over = await startDevice(deps);
  expect(over!.status).toBe(429);
  expect(await over!.json()).toEqual({ error: "too many requests" });
  // the cap is per source: a different caller still starts a session
  const other = { ...deps, rateKey: () => "src-device-cap-other" };
  expect((await startDevice(other))!.status).toBe(200);
});

test("/enroll/device/poll is rate-capped per source", async () => {
  const deps = { ...routeDeps(true, null), rateKey: () => "src-poll-cap" };
  const s = await (await startDevice(deps))!.json() as any;
  for (let i = 0; i < ENROLL_POLL_RATE_MAX; i++) {
    expect((await pollDevice(deps, s.device))!.status).toBe(200); // pending
  }
  const over = await pollDevice(deps, s.device);
  expect(over!.status).toBe(429);
  expect(await over!.json()).toEqual({ error: "too many requests" });
  const other = { ...deps, rateKey: () => "src-poll-cap-other" };
  expect((await pollDevice(other, s.device))!.status).toBe(200);
});

test("a legitimate pairing never meets either cap", async () => {
  // one session start, then a full minute of 2s polling (30 polls): the real
  // engine's worst case sits at half ENROLL_POLL_RATE_MAX
  const deps = { ...routeDeps(true, null), rateKey: () => "src-legit" };
  const s = await (await startDevice(deps))!.json() as any;
  expect(30).toBeLessThan(ENROLL_POLL_RATE_MAX);
  for (let i = 0; i < 30; i++) {
    const r = await pollDevice(deps, s.device);
    expect(r!.status).toBe(200);
    expect(await r!.json()).toEqual({ status: "pending" });
  }
});

/* ------------------- the live wire flow, one HOSTED server + fake JWKS ----- */

const b64url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlJson = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

let nextPort = 9100 + Math.floor(Math.random() * 300);
const KID = "test-key-1";
const ISSUER = "https://fake.clerk.test";
const VAPID_PUBLIC = "BOuHGkAv4-PtWtHGwZfTg0cZ1eXXYJhjZTG02Y-jbXwWULmHh_n35fGq7TcI9jGT1gy3GSX5VomGREvoFZdAnUU";
const VAPID_PRIVATE = "Sy2m28XLTu-1pDAao8kt50es9zajr6r0PXp0Pd-JvP0";
const rsa = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", rsa.publicKey);

function startJwks(): string {
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
  servers.push({ stop: () => srv.stop(true) });
  return `http://127.0.0.1:${srv.port}/jwks`;
}

async function mintSession(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${b64urlJson({ alg: "RS256", typ: "JWT", kid: KID })}.` +
    b64urlJson({ sub, iss: ISSUER, iat: now, nbf: now - 5, exp: now + 3600 });
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" }, rsa.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function startHosted(dir: string, jwksUrl: string): Promise<string> {
  const port = nextPort++;
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
      CLERK_SECRET_KEY: "sk_test_fake_not_a_real_key",
      CLERK_PUBLISHABLE_KEY: "pk_test_" + btoa("fake-clerk.test$").replace(/=+$/, ""),
      CLERK_ISSUER: ISSUER,
      CLERK_JWKS_URL: jwksUrl,
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
  servers.push({ stop: async () => { proc.kill(); await proc.exited; } });
  return url;
}

test("the wire flow: sign in, mint, enroll with the grant, reuse refused", async () => {
  const jwks = startJwks();
  const dir = await mkdtemp(join(tmpdir(), "cyc-onboard-"));
  dirs.push(dir);
  const url = await startHosted(dir, jwks);

  // the page and its script are served, with the document CSP on the page
  const page = await fetch(`${url}/enroll`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(await page.text()).toContain("/enroll.js");
  const js = await fetch(`${url}/enroll.js`);
  expect(js.status).toBe(200);
  expect(await js.text()).toContain("fake-clerk.test");

  // no session, no grant
  expect((await fetch(`${url}/enroll/grant`, { method: "POST" })).status).toBe(401);

  // a signed-in owner gets a one-time code
  const session = await mintSession("user_owner");
  const minted = await fetch(`${url}/enroll/grant`, {
    method: "POST", headers: { authorization: `Bearer ${session}` },
  });
  expect(minted.status).toBe(200);
  const { grant } = await minted.json() as any;
  expect(grant).toMatch(/^cyg_/);

  // the grant + the engine's signed identity proof -> a token for THAT owner
  const eng = await fakeEngine();
  const enrolled = await enrollEngine(url, eng, { authorization: `Bearer ${grant}` });
  expect(enrolled.status).toBe(200);
  expect(enrolled.token).toMatch(/^cyt_/);
  expect(enrolled.json.owner).toBe("user_owner");
  const listed = await (await fetch(`${url}/engines/enrolled`, {
    headers: { authorization: `Bearer ${session}` },
  })).json() as any;
  expect(listed.engines.map((e: any) => e.engineId)).toContain(eng.engineId);

  // single-use on the wire: the same grant cannot enroll a second engine
  const again = await enrollEngine(url, await fakeEngine(), { authorization: `Bearer ${grant}` });
  expect(again.status).toBe(401);

  // a forged grant is refused, and no session fallback rescues it
  const forged = await enrollEngine(url, await fakeEngine(), { authorization: `Bearer ${mintGrantCode()}` });
  expect(forged.status).toBe(401);

  /* THE DEVICE FLOW on the same wire: the engine starts a session, the
   * signed-in page mints with the user code (the grant never shows), the
   * poll receives it, and the enrollment lands on the same owner. */
  const started = await fetch(`${url}/enroll/device`, { method: "POST" });
  expect(started.status).toBe(200);
  const dj = await started.json() as any;
  expect(dj.device).toMatch(/^cyd_/);
  expect(dj.code).toMatch(/^cyu_/);

  const pollDevice = () => fetch(`${url}/enroll/device/poll`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: dj.device }),
  });
  expect(await (await pollDevice()).json()).toEqual({ status: "pending" });

  const attached = await fetch(`${url}/enroll/grant`, {
    method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify({ code: dj.code }),
  });
  expect(attached.status).toBe(200);
  const aj = await attached.json() as any;
  expect(aj.attached).toBe(true);
  expect(JSON.stringify(aj)).not.toContain("cyg_"); // the page never sees the grant

  const polled = await (await pollDevice()).json() as any;
  expect(polled.status).toBe("granted");
  expect(polled.grant).toMatch(/^cyg_/);
  const auto = await enrollEngine(url, await fakeEngine(), { authorization: `Bearer ${polled.grant}` });
  expect(auto.status).toBe(200);
  expect(auto.json.owner).toBe("user_owner");

  // drained: the session answered exactly once
  expect((await pollDevice()).status).toBe(404);
}, 30_000);
