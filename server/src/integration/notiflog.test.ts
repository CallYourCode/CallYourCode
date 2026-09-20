/* Notification telemetry joins an accepted send to the worker's shown receipt.
 * This uses a local TLS push service only. It never contacts a real device. */
import { test, expect } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function subscription(endpoint: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { endpoint, keys: { p256dh: b64url(raw), auth: b64url(auth) } };
}

async function waitFor(file: string, needle: string) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.includes(needle) || Date.now() > deadline) return text;
    await Bun.sleep(50);
  }
}

test("a sent push id joins its shown receipt with computed lagMs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-notiflog-"));
  const certDir = join(dir, "cert");
  const port = 9600 + Math.floor(Math.random() * 300);
  /* Named with the stdio this spawn actually asks for. `ReturnType<typeof
   * Bun.spawn>` is the DEFAULT shape ("ignore"/"pipe"/"inherit"), which is not
   * the shape of a child started with both streams ignored. */
  let app: Subprocess<"ignore", "ignore", "ignore"> | undefined;
  let pushService: ReturnType<typeof Bun.serve> | undefined;
  try {
    await Bun.$`mkdir -p ${certDir}`.quiet();
    await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${certDir}/key.pem -out ${certDir}/cert.pem -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1`.quiet();
    pushService = Bun.serve({
      port: 0,
      tls: { cert: await Bun.file(join(certDir, "cert.pem")).text(), key: await Bun.file(join(certDir, "key.pem")).text() },
      fetch: async (req) => {
        expect((await req.arrayBuffer()).byteLength).toBeGreaterThan(0);
        return new Response("", { status: 201 });
      },
    });
    app = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], { env: {
      ...process.env, APP_PORT: String(port), APP_HOST: "127.0.0.1", DIST_DIR: dir,
      PUSH_FILE: join(dir, "push-subs.json"), SETTINGS_FILE: join(dir, "settings.json"),
      REPORTS_DIR: join(dir, "reports"), CYC_LOG_DIR: join(dir, "logs"),
      ENGINE_TOKENS_FILE: join(dir, "engine-tokens.json"),
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    }, stdout: "ignore", stderr: "ignore" });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
      if (await fetch(`${url}/settings`).then((r) => r.ok).catch(() => false)) break;
      await Bun.sleep(50);
      if (i === 79) throw new Error("app server did not start");
    }
    const sub = await subscription(`https://127.0.0.1:${pushService.port}/accepted`);
    expect((await fetch(`${url}/push/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub, label: "test" }) })).ok).toBe(true);
    const sent = await (await fetch(`${url}/push/test`, { method: "POST" })).json() as { id: string };
    expect(sent.id).toMatch(/^[a-f0-9]{12}$/);
    const at = Date.now() + 25;
    expect((await fetch(`${url}/push/shown`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: sent.id, at, kind: "notify" }) })).ok).toBe(true);
    const log = await waitFor(join(dir, "logs", "app-server.log"), "push.shown");
    expect(log).toContain(`push.sent id=${sent.id}`);
    expect(log).toContain(`push.shown id=${sent.id} kind=notify lagMs=`);
  } finally {
    if (app) { app.kill(); await app.exited; }
    pushService?.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
