/* Security hardening proofs for the app server (H3, DDoS, engine auth):
 *
 *   - A HOSTED deploy needs no PUSH_TOKEN boot gate any more: engine routes
 *     verify the per-engine issued token, and an empty
 *     token store fails CLOSED -- proven here by booting HOSTED with no
 *     legacy env and getting 401 on push/announce.
 *   - Documents carry the CSP + baseline security headers; hashed assets get
 *     the baseline without a CSP.
 *   - /clientlog is capped: an oversize POST is dropped whole (still 204,
 *     the sink never makes the page retry) and never reaches the log file.
 *   - The push rate limit is per ENGINE: two enrolled engines arriving from
 *     the same loopback proxy (tailscale serve) each have their own budget,
 *     keyed by the authenticated token, no forwarded header trusted.
 *
 *   VOICE_URL=http://127.0.0.1:1 bun test app-server/hardening.test.ts
 */

import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrolledBearer } from "../test-support/enrollkit";

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

type Spawned = { url: string; dir: string; stop: () => Promise<void>; said: () => Promise<string> };

async function spawnServer(extraEnv: Record<string, string>): Promise<Spawned> {
  const dir = await mkdtemp(join(tmpdir(), "cyc-hardening-"));
  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: "127.0.0.1",
      DIST_DIR: dir,
      PUSH_FILE: join(dir, "push-subs.json"),
      SETTINGS_FILE: join(dir, "app-settings.json"),
      ENGINE_TOKENS_FILE: join(dir, "engine-tokens.json"),
      CYC_LOG_DIR: join(dir, "logs"),
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
      CYC_LOG_FLUSH_MS: "20", // so the log assertions do not race the flush timer
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const said = async () => {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    return `${out}${err}`.trim();
  };
  const stop = async () => { proc.kill(); await proc.exited; };
  await writeFile(join(dir, "index.html"), "<!doctype html><title>scratch</title>");
  await writeFile(join(dir, "app-DEADBEEF12.js"), "// hashed asset");
  await writeFile(join(dir, "cyc-sandbox.html"), "<!doctype html><script>1</script>");
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`app server exited ${proc.exitCode} before /health:\n${await said()}`);
    }
    const health = await fetch(`${url}/health`).catch(() => null);
    if (health?.ok) break;
    if (Date.now() > deadline) { await stop(); throw new Error("app server never answered"); }
    await Bun.sleep(100);
  }
  return { url, dir, stop, said };
}

/* ------------- engine auth fails closed: no boot gate needed any more.
 * The old H2 check ("HOSTED refuses to boot without PUSH_TOKEN") is
 * superseded: there is no shared secret to require. A HOSTED server with an
 * EMPTY engine-token store must boot fine and refuse every unauthenticated
 * or garbage-bearer engine call. */

test("HOSTED boots with no PUSH_TOKEN and engine routes fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-h2-"));
  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: "127.0.0.1",
      DIST_DIR: dir,
      OWNERS_DIR: join(dir, "owners"),
      ENGINE_TOKENS_FILE: join(dir, "engine-tokens.json"),
      CYC_LOG_DIR: join(dir, "logs"),
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
      CLERK_SECRET_KEY: "sk_test_scratch",
      // a locally generated, never-real VAPID pair for the HOSTED boot guard
      VAPID_PUBLIC_KEY: "BOuHGkAv4-PtWtHGwZfTg0cZ1eXXYJhjZTG02Y-jbXwWULmHh_n35fGq7TcI9jGT1gy3GSX5VomGREvoFZdAnUU",
      VAPID_PRIVATE_KEY: "Sy2m28XLTu-1pDAao8kt50es9zajr6r0PXp0Pd-JvP0",
      /* HOSTED also refuses to boot without APP_SERVER_URL now (the
       * host-header gate needs the public front named); this test is about
       * the PUSH_TOKEN legacy, so it names a scratch front. */
      APP_SERVER_URL: "https://cyc-hosted.example.com",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) {
      if (await fetch(`${url}/health`).then((r) => r.ok).catch(() => false)) break;
      await Bun.sleep(100);
      if (i === 79) throw new Error("HOSTED server did not boot without PUSH_TOKEN");
    }
    const post = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${url}${path}`, { method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ sessionId: "x", body: "b", host: "mac",
          engineId: "e-x", url: "ws://mac:10101/ws", new: [] }) });
    for (const path of ["/push/notify", "/push/batch", "/engines/announce"]) {
      expect((await post(path)).status).toBe(401);
      expect((await post(path, { authorization: "Bearer garbage" })).status).toBe(401);
      expect((await post(path, { authorization: "Bearer cyt_lookslegit" })).status).toBe(401);
    }
  } finally {
    proc.kill();
    await proc.exited;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 30_000);

/* ----------------------------------------------- H3: the security headers */

test("documents carry the CSP and baseline headers; hashed assets skip the CSP", async () => {
  const s = await spawnServer({});
  try {
    const page = await fetch(`${s.url}/`);
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    /* script-src is LOCKED: no inline, no eval (the sandbox has its own
     * shell document now, and WSOLA no longer uses new Function); blob: is
     * the AudioWorklet module. No third-party script host in LOCAL. */
    expect(csp).toContain("script-src 'self' blob:");
    expect(/script-src [^;]*unsafe-inline/.test(csp)).toBe(false); // style-src may keep it
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("clerk");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-frame-options")).toBe("DENY");

    /* the sandbox shell: its OWN policy (opaque even on direct navigation,
     * embeddable only by this app), never the app CSP, never XFO DENY */
    const shell = await fetch(`${s.url}/cyc-sandbox.html`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-security-policy"))
      .toBe("sandbox allow-scripts; frame-ancestors 'self'");
    expect(shell.headers.get("x-frame-options")).toBeNull();
    expect(shell.headers.get("x-content-type-options")).toBe("nosniff");

    const asset = await fetch(`${s.url}/app-DEADBEEF12.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-security-policy")).toBeNull();
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
  } finally {
    await s.stop();
    await rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }
}, 40_000);

/* -------------------------------------------------- DDoS: /clientlog caps */

async function appLogText(dir: string): Promise<string> {
  const logDir = join(dir, "logs");
  let out = "";
  try {
    for (const f of readdirSync(logDir)) {
      if (f.startsWith("app")) out += await readFile(join(logDir, f), "utf8").catch(() => "");
    }
  } catch { /* no log yet */ }
  return out;
}

test("/clientlog stores a real batch, drops an oversize one whole, both as 204", async () => {
  const s = await spawnServer({});
  try {
    const ok = await fetch(`${s.url}/clientlog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: "d1", page: "p1", lines: ["kept-marker-line"] }),
    });
    expect(ok.status).toBe(204);

    // an oversize body: still 204 (the sink never causes a retry), dropped whole
    const big = JSON.stringify({ device: "d1", page: "p1",
      lines: ["dropped-marker-line", "x".repeat(3 * 1024 * 1024)] });
    const refused = await fetch(`${s.url}/clientlog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    });
    expect(refused.status).toBe(204);

    // the file holds the real line and none of the oversize batch
    await Bun.sleep(200);
    const log = await appLogText(s.dir);
    expect(log).toContain("kept-marker-line");
    expect(log).not.toContain("dropped-marker-line");
    expect(log).toContain("clientlog.refused");
  } finally {
    await s.stop();
    await rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }
}, 40_000);

/* --------------------------- DDoS: per-engine push rate buckets. Every push
 * is authenticated by an issued token now, so the bucket keys on the ENGINE
 * rather than any address or forwarded header -- two engines behind the same
 * tailscale-serve loopback proxy can no longer collapse into one budget, and
 * no spoofable x-forwarded-for is involved. */

test("push rate buckets are per enrolled engine, not per address", async () => {
  const s = await spawnServer({});
  try {
    const a = await enrolledBearer(s.url);
    const b = await enrolledBearer(s.url);
    const notify = (bearer: { authorization: string }) =>
      fetch(`${s.url}/push/notify`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer },
        body: JSON.stringify({ sessionId: "h:1", title: "t", body: "b" }),
      }).then((r) => r.json() as Promise<{ ok: boolean; dropped?: boolean }>);

    // exhaust engine A's minute budget (PUSH_RATE_MAX = 100); both arrive
    // from the same loopback peer, which must not matter
    for (let i = 0; i < 100; i++) {
      const r = await notify(a.bearer);
      expect(r.dropped ?? false).toBe(false);
    }
    const overA = await notify(a.bearer);
    expect(overA.dropped).toBe(true);

    // engine B on the SAME peer address still has its own budget
    const rb = await notify(b.bearer);
    expect(rb.dropped ?? false).toBe(false);
  } finally {
    await s.stop();
    await rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }
}, 40_000);

/* --------------------------- the browser origin gate (contracts finding #9)
 * LOCAL /engines/enroll is open by design ("trusted network"), and every
 * answer used to carry the CORS allow-origin wildcard: a drive-by web page in
 * a browser that could reach this server could POST a self-signed enrollment
 * (no preflight: a no-cors POST is a simple request) and READ the minted cyt_
 * bearer cross-origin. The gate closes the browser vector: a disallowed
 * Origin is 403 before any route runs, and no answer grants CORS. The
 * tailnet-peer vector (a non-browser process minting a token) is a pairing
 * design question, deliberately NOT changed here. */

test("a disallowed browser Origin is refused everywhere; no-Origin and same-origin callers pass; no CORS grant", async () => {
  const s = await spawnServer({});
  try {
    const EVIL = { origin: "https://evil.example.com" };
    const enrollBody = JSON.stringify({ engineId: "e", pubkey: "p", sig: "s", ts: Date.now() });

    // (a) the enroll mint is closed to a drive-by page, before any parsing
    const evil = await fetch(`${s.url}/engines/enroll`, {
      method: "POST", headers: { "content-type": "text/plain", ...EVIL }, body: enrollBody });
    expect(evil.status, "a drive-by Origin reached /engines/enroll").toBe(403);
    // so are the other mutating surfaces and even the open reads
    expect((await fetch(`${s.url}/engines`, { headers: EVIL })).status).toBe(403);
    expect((await fetch(`${s.url}/health`, { headers: EVIL })).status).toBe(403);

    // (b) a no-Origin caller (a real engine's server-side fetch) is untouched:
    // the same garbage body reaches the route and gets its own 401 (bad sig),
    // never the origin 403.
    const engine = await fetch(`${s.url}/engines/enroll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: enrollBody });
    expect(engine.status).toBe(401);

    // (c) the page this server serves is same-origin (here loopback) and passes
    // the gate: same garbage body, same 401, not a 403.
    const samePage = await fetch(`${s.url}/engines/enroll`, {
      method: "POST", headers: { "content-type": "application/json", origin: s.url }, body: enrollBody });
    expect(samePage.status).toBe(401);

    // (d) no answer advertises a CORS grant any more (the old wildcard let the
    // drive-by page read what it minted).
    const health = await fetch(`${s.url}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBeNull();
  } finally {
    await s.stop();
    await rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }
}, 40_000);

/* ------------- the DNS-rebinding vector (the origin gate's residual).
 * An attacker page re-points its own domain at 127.0.0.1 after it loads; the
 * browser then reaches this server from a TRUE loopback peer with the
 * attacker's domain in Host -- and either NO Origin (top-level navigation,
 * same-origin GET) or an Origin whose host EQUALS that attacker Host, the
 * exact pair the same-origin rule used to accept. The host gate refuses both
 * shapes before any route; loopback and the machine's own tailnet name keep
 * passing, which is what the live tailscale-serve front sends. */

test("a rebound Host is 403 everywhere; loopback and the machine's own tailnet Host pass", async () => {
  const s = await spawnServer({});
  try {
    const enrollBody = JSON.stringify({ engineId: "e", pubkey: "p", sig: "s", ts: Date.now() });

    // (a) the no-Origin rebound shape (top-level navigation / same-origin GET)
    for (const path of ["/health", "/engines", "/config", "/"]) {
      const r = await fetch(`${s.url}${path}`, { headers: { host: "evil.example.com" } });
      expect(r.status, `${path} trusted a rebound Host`).toBe(403);
    }
    // with an explicit port too, and on the ws upgrade surfaces
    for (const path of ["/health", "/engine", "/device"]) {
      const r = await fetch(`${s.url}${path}`, { headers: { host: "evil.example.com:10100" } });
      expect(r.status, `${path} trusted a rebound Host:port`).toBe(403);
    }

    // (b) the rebound SAME-ORIGIN mutation: Origin host == attacker Host, the
    // pair the origin gate's same-origin rule would accept on its own.
    const rebound = await fetch(`${s.url}/engines/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json",
        host: "evil.example.com:10100", origin: "http://evil.example.com:10100" },
      body: enrollBody });
    expect(rebound.status, "a rebound same-origin POST reached /engines/enroll").toBe(403);

    // (c) loopback Host (every engine, CLI and same-machine page) still passes:
    // the same garbage enroll body reaches the route and gets its own 401.
    const engine = await fetch(`${s.url}/engines/enroll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: enrollBody });
    expect(engine.status).toBe(401);

    // (d) the machine's OWN tailnet MagicDNS name passes: the live deploy's
    // tailscale serve forwards the browser's Host (the tailnet name) to this
    // loopback port, so this is the front's exact shape.
    const own = (await import("node:os")).hostname().replace(/\.local$/i, "").toLowerCase();
    const fronted = await fetch(`${s.url}/health`, {
      headers: { host: `${own}.tail1234.ts.net` } });
    expect(fronted.status, "the tailscale-serve front's Host shape was refused").toBe(200);
  } finally {
    await s.stop();
    await rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }
}, 40_000);
