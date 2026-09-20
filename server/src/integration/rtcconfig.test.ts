/* The app-server's /config.rtc block and the /engines/verify introspection the
 * folded relay authenticates engines with. The relaying itself (the /engine and
 * /device legs) is tested in relay.test.ts against the app-server.
 *
 *   bun test app-server/rtcconfig.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrolledBearer, fakeEngine } from "../test-support/enrollkit";

type Server = { url: string; stop: () => Promise<void> };
let servers: Server[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

let nextPort = 8340 + Math.floor(Math.random() * 200);

async function startServer(env: Record<string, string> = {}): Promise<Server> {
  const dir = await mkdtemp(join(tmpdir(), "cyc-rtccfg-"));
  dirs.push(dir);
  const port = nextPort++;
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port), APP_HOST: "127.0.0.1", DIST_DIR: dir,
      PUSH_FILE: join(dir, "push-subs.json"),
      SETTINGS_FILE: join(dir, "app-settings.json"),
      ENGINE_LEASES_FILE: join(dir, "leases.json"),
      ENGINE_TOKENS_FILE: join(dir, "engine-tokens.json"),
      CYC_LOG_DIR: join(dir, "logs"),
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
      ...env,
    },
    stdout: "ignore", stderr: "ignore",
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

test("/config.rtc: LOCAL is empty (host candidates connect); no relay url", async () => {
  const s = await startServer();
  const rtc = (await (await fetch(`${s.url}/config`)).json() as any).rtc;
  // LOCAL: no STUN, no TURN -- a same-machine / tailscale dial gathers host
  // candidates and needs neither. Signaling is same-origin (/device), so no
  // relay url rides here.
  expect(rtc.iceServers).toEqual([]);
  expect(rtc.relay).toBeUndefined();
  expect(rtc.relayEngine).toBeUndefined();
});

test("/config.rtc: LOCAL stays empty even with a coturn secret configured", async () => {
  // The TURN cred path is HOSTED-only; a local deploy never emits ICE servers,
  // and TURN's HMAC minting is covered in relay/turn.test.ts. Setting a secret
  // here proves LOCAL ignores it rather than leaking a cred to the trusted net.
  const s = await startServer({
    TURN_URLS: "turn:t.example.com:3478", TURN_STATIC_SECRET: "s3cret", TURN_TTL_S: "600",
    RTC_STUN: "stun:my.stun:3478",
  });
  const rtc = (await (await fetch(`${s.url}/config`)).json() as any).rtc;
  expect(rtc.iceServers).toEqual([]);
});

test("/engines/verify: a live token answers its {engineId, owner}; garbage is 401", async () => {
  const s = await startServer();
  const { token } = await enrolledBearer(s.url, await fakeEngine("e-verify"));

  const ok = await fetch(`${s.url}/engines/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true, engineId: "e-verify", owner: "local" });

  for (const body of [{}, { token: "cyt_guess" }, { token: 42 }, "not json"]) {
    const r = await fetch(`${s.url}/engines/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    expect(r.status).toBe(401);
  }

  // a REVOKED engine's token stops verifying at once: the relay's next
  // introspection (its next engine dial) refuses it
  await fetch(`${s.url}/engines/revoke`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ engineId: "e-verify" }),
  });
  const dead = await fetch(`${s.url}/engines/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(dead.status).toBe(401);
});
