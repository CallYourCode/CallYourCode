/* The signaling relay FOLDED onto the app-server (server/src/bootstrap/server.ts /engine and
 * /device legs), as a REAL process on a scratch port: the auth gating on both
 * legs, the device-key envelope, blind verbatim forwarding, engine matching and
 * the caps. LOCAL (the tailscale target) is open on both legs; HOSTED gates
 * /engine by the issued cyt_ token and /device by the owner's Clerk session,
 * owner-scoped. The relay CORE is server/src/relay.ts; this drives it end to
 * end through the app-server that owns the port and the auth.
 *
 *   bun test src/relay.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Stoppable = { stop: () => Promise<void> | void };
let stops: Stoppable[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- the app-server under test (relay folded on) ---------------------------

let nextPort = 8300 + Math.floor(Math.random() * 200);

type Seed = {
  tokens?: Array<{ token: string; engineId: string; owner: string }>;
  leases?: Array<{ engineId: string; owner: string; user?: string; url?: string }>;
};

async function startApp(env: Record<string, string> = {}, seed: Seed = {tokens: [{token: "cyt_scratch", engineId: "eng-l", owner: "local"}]}) {
  const port = nextPort++;
  const dir = await mkdtemp(join(tmpdir(), "cyc-relay-"));
  dirs.push(dir);
  const logDir = join(dir, "logs");
  const tokensFile = join(dir, "engine-tokens.json");
  const leasesFile = join(dir, "leases.json");
  if (seed.tokens?.length) {
    await writeFile(tokensFile, JSON.stringify({
      engines: seed.tokens.map((t) => ({
        engineId: t.engineId, owner: t.owner, spki: "x", fp: "",
        tokenHash: sha256hex(t.token), issuedAt: Date.now(), rotatedAt: null, revokedAt: null,
      })),
    }));
  }
  if (seed.leases?.length) {
    await writeFile(leasesFile, JSON.stringify({
      engines: seed.leases.map((l) => ({
        engineId: l.engineId, owner: l.owner, user: l.user ?? "u",
        url: l.url ?? "wss://h/ws", lastSeen: Date.now(),
      })),
    }));
  }
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port), APP_HOST: "127.0.0.1", DIST_DIR: dir,
      PUSH_FILE: join(dir, "push-subs.json"),
      SETTINGS_FILE: join(dir, "app-settings.json"),
      ENGINE_LEASES_FILE: leasesFile,
      ENGINE_TOKENS_FILE: tokensFile,
      OWNERS_DIR: join(dir, "owners"),
      CYC_LOG_DIR: logDir,
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
      // A LOCAL app-server by default: no CLERK. HOSTED tests set these + VAPID.
      CLERK_SECRET_KEY: "", CLERK_JWKS_URL: "", CLERK_ISSUER: "",
      ...env,
    },
    stdout: "ignore", stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${url}/health`).then((r) => r.ok).catch(() => false)) break;
    await Bun.sleep(100);
    if (i === 99) throw new Error("app server did not start");
  }
  const s = { url, ws: `ws://127.0.0.1:${port}`, logFile: join(logDir, "app-server.log"),
    stop: async () => { proc.kill(); await proc.exited; } };
  stops.push(s);
  return s;
}

// ---- small ws helpers -------------------------------------------------------

type WsEnd = { ws: WebSocket; frames: string[]; closed: Promise<{ code: number }>; next: (pred?: (s: string) => boolean) => Promise<string> };

function wsClient(url: string, headers?: Record<string, string>): WsEnd {
  if (new URL(url).pathname === "/engine") headers ??= {authorization: "Bearer cyt_scratch"};
  const ws = new WebSocket(url, headers ? ({ headers } as any) : undefined);
  const frames: string[] = [];
  const waiters: Array<{ pred: (s: string) => boolean; res: (s: string) => void }> = [];
  ws.onmessage = (ev) => {
    const s = String(ev.data);
    const i = waiters.findIndex((w) => w.pred(s));
    if (i >= 0) waiters.splice(i, 1)[0].res(s);
    else frames.push(s);
  };
  const closed = new Promise<{ code: number }>((res) => { ws.onclose = (ev) => res({ code: ev.code }); });
  const next = (pred: (s: string) => boolean = () => true) =>
    new Promise<string>((res, rej) => {
      const i = frames.findIndex(pred);
      if (i >= 0) return res(frames.splice(i, 1)[0]);
      waiters.push({ pred, res });
      setTimeout(() => rej(new Error("no frame")), 8000);
    });
  return { ws, frames, closed, next };
}

const opened = (e: WsEnd) => new Promise<void>((res, rej) => {
  if (e.ws.readyState === WebSocket.OPEN) return res();
  e.ws.onopen = () => res();
  setTimeout(() => rej(new Error("ws never opened")), 8000);
});

/* The device-key handshake, driven by hand. The relay
 * is blind, so the "engine" stand-in (a raw ws) decides the verdict; the
 * spki/sig here are opaque placeholders the relay forwards verbatim. Returns the
 * r-open the engine leg received. */
async function deviceHandshake(dev: WsEnd, eng: WsEnd,
  opts: { accept?: boolean; spki?: string; sig?: string } = {}): Promise<any> {
  const chal = JSON.parse(await dev.next((s) => s.includes("r-challenge")));
  expect(chal.t).toBe("r-challenge");
  expect(typeof chal.nonce).toBe("string");
  dev.ws.send(JSON.stringify({ t: "r-auth", spki: opts.spki ?? "SPKI", sig: opts.sig ?? "SIG" }));
  const rOpen = JSON.parse(await eng.next((s) => s.includes("r-open")));
  if (opts.accept === false) {
    eng.ws.send(JSON.stringify({ t: "r-reject", c: rOpen.c }));
  } else {
    eng.ws.send(JSON.stringify({ t: "r-accept", c: rOpen.c }));
    await dev.next((s) => s.includes("r-ok"));
  }
  return rOpen;
}

test("LOCAL engine leg: opens on ?engine with no auth; a device dial with no engine 400s", async () => {
  const app = await startApp();
  // an engineId is required on the engine leg (owner is "local")
  expect((await fetch(`${app.url}/engine`)).status).toBe(401);
  expect((await fetch(`${app.url}/device`)).status).toBe(400);
  const eng = wsClient(`${app.ws}/engine?engine=eng-l`);
  await opened(eng);
  eng.ws.close();
}, 20_000);

test("LOCAL device dial (step 8): offline engine 4404; the proof rides r-open; LOCAL ice is empty", async () => {
  const app = await startApp();

  // no engine leg yet: engine-offline, before any challenge is issued
  const early = wsClient(`${app.ws}/device?engine=eng-l`);
  expect((await early.closed).code).toBe(4404);

  const eng = wsClient(`${app.ws}/engine?engine=eng-l`);
  await opened(eng);
  const dev = wsClient(`${app.ws}/device?engine=eng-l`);
  await opened(dev);
  const rOpen = await deviceHandshake(dev, eng, { spki: "DEVSPKI", sig: "DEVSIG" });
  expect(rOpen.t).toBe("r-open");
  expect(typeof rOpen.c).toBe("string");
  // LOCAL: host candidates connect, so the engine gets an EMPTY ice list
  expect(rOpen.rtc).toBeUndefined();
  // the proof is attached VERBATIM for the engine to verify (the relay is blind)
  expect(rOpen.auth).toEqual({ nonce: expect.any(String), spki: "DEVSPKI", sig: "DEVSIG" });
  dev.ws.close();
  eng.ws.close();
}, 20_000);

test("LOCAL device dial: r-reject closes 4401; a non-r-auth first frame is 4401 too", async () => {
  const app = await startApp();
  const eng = wsClient(`${app.ws}/engine?engine=eng-l`);
  await opened(eng);

  const dev = wsClient(`${app.ws}/device?engine=eng-l`);
  await opened(dev);
  await deviceHandshake(dev, eng, { accept: false });
  expect((await dev.closed).code).toBe(4401);

  const bad = wsClient(`${app.ws}/device?engine=eng-l`);
  await opened(bad);
  await bad.next((s) => s.includes("r-challenge"));
  bad.ws.send(JSON.stringify({ t: "hello", id: "x", sdp: "v=0" }));
  expect((await bad.closed).code).toBe(4401);
  await Bun.sleep(120);
  expect(eng.frames.find((s) => s.includes("r-open"))).toBeUndefined();
  eng.ws.close();
}, 20_000);

test("forwarding is verbatim and blind, both directions; the relay log carries no payload", async () => {
  const app = await startApp();
  const eng = wsClient(`${app.ws}/engine?engine=eng-l`);
  await opened(eng);
  const dev = wsClient(`${app.ws}/device?engine=eng-l`);
  await opened(dev);
  const rOpen = await deviceHandshake(dev, eng);
  const c = rOpen.c as string;

  // device -> engine: an opaque string (not even JSON) crosses byte-identical
  const sentinel = `OPAQUE-${crypto.randomUUID()}-{"t":"hello","sdp":"v=0 FAKE"}`;
  dev.ws.send(sentinel);
  const wrapped = JSON.parse(await eng.next((s) => s.includes("OPAQUE-")));
  expect(wrapped).toEqual({ t: "r", c, f: sentinel });

  // engine -> device: the f string lands bare and byte-identical
  const back = `BACK-${crypto.randomUUID()}-{"t":"x"}`;
  eng.ws.send(JSON.stringify({ t: "r", c, f: back }));
  expect(await dev.next((s) => s.includes("BACK-"))).toBe(back);

  // engine r-close closes the device leg with the code it named
  eng.ws.send(JSON.stringify({ t: "r-close", c, code: 4408 }));
  expect((await dev.closed).code).toBe(4408);

  // BLINDNESS, checked literally: no payload byte reached the relay's log
  await Bun.sleep(300);
  const log = await readFile(app.logFile, "utf8").catch(() => "");
  expect(log).not.toContain("OPAQUE-");
  expect(log).not.toContain("BACK-");
  expect(log).not.toContain("FAKE");
  eng.ws.close();
}, 20_000);

test("an engine leg dying closes its device legs 4404; a superseding engine socket closes the old", async () => {
  const app = await startApp();
  const eng1 = wsClient(`${app.ws}/engine?engine=eng-l`);
  await opened(eng1);
  const dev = wsClient(`${app.ws}/device?engine=eng-l`);
  await opened(dev);
  await deviceHandshake(dev, eng1);

  // the same engine dials again (its old NAT mapping died): new leg wins
  const eng2 = wsClient(`${app.ws}/engine?engine=eng-l`);
  await opened(eng2);
  expect((await eng1.closed).code).toBe(4409);
  expect((await dev.closed).code).toBe(4404);

  // and the new leg is live: a fresh device attempt handshakes through it
  const dev2 = wsClient(`${app.ws}/device?engine=eng-l`);
  await opened(dev2);
  expect((await deviceHandshake(dev2, eng2)).t).toBe("r-open");
  dev2.ws.close();
  eng2.ws.close();
}, 20_000);

test("caps: an oversize frame closes 1009", async () => {
  const app = await startApp();
  const eng = wsClient(`${app.ws}/engine?engine=eng-l`);
  await opened(eng);
  const dev = wsClient(`${app.ws}/device?engine=eng-l`);
  await opened(dev);
  dev.ws.send("x".repeat(16 * 1024 * 1024 + 1));
  expect((await dev.closed).code).toBe(1009);
  eng.ws.close();
}, 20_000);
