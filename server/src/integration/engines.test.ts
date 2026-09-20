/* The announce route and the lease list, against a REAL server process.
 *
 * The app server now keeps {engineId, owner, user, url, lastSeen} for every
 * engine that POSTs /engines/announce, and drops an entry once it is past the
 * lease. Discovery is ANNOUNCE-ONLY: /config serves each still-leased announced
 * lease as a {url, engineId, host, user} object and nothing else (no seed);
 * /hosts keeps the app's old payload shape with `up` derived from leased. All of
 * it on a scratch port with scratch stores, never the real one.
 *
 *   bun test app-server/engines.test.ts
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

async function startServer(dir: string, leaseMs = 60_000): Promise<Server> {
  const port = 8600 + Math.floor(Math.random() * 300);
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: "127.0.0.1",
      DIST_DIR: dir,
      PUSH_FILE: join(dir, "push-subs.json"),
      SETTINGS_FILE: join(dir, "app-settings.json"),
      ENGINE_LEASES_FILE: join(dir, "leases.json"),
      ENGINE_LEASE_MS: String(leaseMs),
      ENGINE_TOKENS_FILE: join(dir, "engine-tokens.json"),
      CYC_LOG_DIR: join(dir, "logs"),
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
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

const getJson = async (url: string) => (await fetch(url)).json() as Promise<any>;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body) });

test("announce upserts, /engines lists it, /config emits the object form, /hosts keeps the url", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-engines-"));
  dirs.push(dir);
  const s = await startServer(dir);

  // nothing yet: /engines empty, /config empty (announce-only, no seed default)
  expect((await getJson(`${s.url}/engines`)).engines).toEqual([]);
  expect((await getJson(`${s.url}/config`)).engines).toEqual([]);

  // the engine must be enrolled first; its token opens the announce route
  const { bearer } = await enrolledBearer(s.url, await fakeEngine("e-a"));
  const ann = { engineId: "e-a", host: "mac", user: "example", url: "ws://mac:10101/ws", rev: "abc", ts: Date.now() };
  const r1 = await post(`${s.url}/engines/announce`, ann, bearer);
  expect(r1.status).toBe(200);
  expect((await r1.json()).ok).toBe(true);

  // a second announce for the same id is one entry, not two
  await post(`${s.url}/engines/announce`, ann, bearer);

  const list = (await getJson(`${s.url}/engines`)).engines;
  expect(list.length).toBe(1);
  expect(list[0]).toMatchObject({ engineId: "e-a", owner: "mac", user: "example", url: "ws://mac:10101/ws" });
  expect(typeof list[0].lastSeen).toBe("number");

  // /config now carries the announced lease as {url, engineId, host, user}
  // (announce-only: no seed entry precedes it), and /hosts keeps the app's
  // payload shape with up derived from leased
  expect((await getJson(`${s.url}/config`)).engines).toEqual([
    { url: "ws://mac:10101/ws", engineId: "e-a", host: "mac", user: "example" },
  ]);
  const hosts = await getJson(`${s.url}/hosts`);
  expect(hosts).toEqual({
    seq: 0,
    hosts: [
      { url: "ws://mac:10101/ws", up: true },
    ],
  });
});

test("two announces on the same url collapse to one object entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-engines-"));
  dirs.push(dir);
  const s = await startServer(dir);

  // Announcing the same url twice (a heartbeat) must surface exactly one object
  // form carrying the engineId, never a duplicate/orphan row.
  const { bearer } = await enrolledBearer(s.url, await fakeEngine("e-dup"));
  const ann = { engineId: "e-dup", host: "mac", user: "example", url: "ws://mac:10101/ws", rev: "abc", ts: Date.now() };
  await post(`${s.url}/engines/announce`, ann, bearer);
  await post(`${s.url}/engines/announce`, ann, bearer);

  expect((await getJson(`${s.url}/config`)).engines).toEqual([
    { url: "ws://mac:10101/ws", engineId: "e-dup", host: "mac", user: "example" },
  ]);
});

test("an entry past the lease drops from /engines and /config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-engines-"));
  dirs.push(dir);
  const s = await startServer(dir, 150);

  const { bearer } = await enrolledBearer(s.url, await fakeEngine("e-a"));
  await post(`${s.url}/engines/announce`,
    { engineId: "e-a", host: "mac", user: "example", url: "ws://mac:10101/ws", rev: "abc", ts: Date.now() },
    bearer);
  expect((await getJson(`${s.url}/engines`)).engines.length).toBe(1);
  expect((await getJson(`${s.url}/config`)).engines).toContainEqual(
    { url: "ws://mac:10101/ws", engineId: "e-a", host: "mac", user: "example" },
  );

  await Bun.sleep(400); // past the 150ms lease

  expect((await getJson(`${s.url}/engines`)).engines).toEqual([]);
  expect((await getJson(`${s.url}/config`)).engines).toEqual([]);
});

test("no token is 401; malformed bodies are 400; a foreign engineId is 403; oversize is 413", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-engines-"));
  dirs.push(dir);
  const s = await startServer(dir);
  const { bearer } = await enrolledBearer(s.url, await fakeEngine("e-a"));

  // no token at all, and a token-shaped guess: 401, never open (LOCAL too)
  expect((await post(`${s.url}/engines/announce`,
    { engineId: "e-a", url: "ws://x:10101/ws" })).status).toBe(401);
  expect((await post(`${s.url}/engines/announce`,
    { engineId: "e-a", url: "ws://x:10101/ws" },
    { authorization: "Bearer cyt_guess" })).status).toBe(401);

  // not JSON
  expect((await post(`${s.url}/engines/announce`, "not json", bearer)).status).toBe(400);
  // a JSON array is not an object
  expect((await post(`${s.url}/engines/announce`, [1, 2], bearer)).status).toBe(400);
  // missing engineId
  expect((await post(`${s.url}/engines/announce`, { url: "ws://x:10101/ws" }, bearer)).status).toBe(400);
  // missing the ws url
  expect((await post(`${s.url}/engines/announce`, { engineId: "e-a" }, bearer)).status).toBe(400);
  // a url that is not ws(s)
  expect((await post(`${s.url}/engines/announce`,
    { engineId: "e-a", url: "http://x:10101" }, bearer)).status).toBe(400);
  // the token speaks only for its own engineId
  expect((await post(`${s.url}/engines/announce`,
    { engineId: "e-other", url: "ws://x:10101/ws" }, bearer)).status).toBe(403);

  // over the small announce cap (4 KiB)
  const big = { engineId: "e-a", host: "mac", url: "ws://x:10101/ws", rev: "x".repeat(10_000) };
  expect((await post(`${s.url}/engines/announce`, big, bearer)).status).toBe(413);
});
