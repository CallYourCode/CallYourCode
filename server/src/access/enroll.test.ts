/* Per-engine enrollment tokens, both layers:
 *
 *   - the EngineTokens store as a unit: issue, hash-only persistence, rotate,
 *     revoke/restore, identity and owner mismatch;
 *   - one real LOCAL server process proving the wiring: a signed enrollment
 *     earns a token, announce and push require it, re-enrollment rotates it
 *     (old bearer dies), revocation locks the engine out until restored.
 *
 * HOSTED behaviour (Clerk gate, owner scoping) lives in hosted.test.ts.
 *
 *   VOICE_URL=http://127.0.0.1:1 bun test app-server/enroll.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineTokens, mintEngineToken } from "./enroll";
import { enrollEngine, enrolledBearer, fakeEngine } from "../test-support/enrollkit";
import { ENROLL_SKEW_MS, signEnroll, verifyEnrollSig } from "../../../engine/shared/enroll-wire.ts";

let dirs: string[] = [];
type Server = { url: string; stop: () => Promise<void> };
let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

const scratch = async () => {
  const d = await mkdtemp(join(tmpdir(), "cyc-enroll-"));
  dirs.push(d);
  return d;
};

/* ------------------------------------------------ the store, as a unit */

test("issue, verify, and hash-only persistence", async () => {
  const dir = await scratch();
  const file = join(dir, "engine-tokens.json");
  const s = await EngineTokens.open(file);

  const r = await s.enroll({ engineId: "e-1", spki: "spki-a", owner: "local" });
  if (!r.ok) throw new Error("enroll refused");
  expect(r.token.startsWith("cyt_")).toBe(true);
  expect(r.rotated).toBe(false);

  // the bearer verifies to its record; garbage and near-misses do not
  expect(s.verify(r.token)?.engineId).toBe("e-1");
  expect(s.verify(r.token)?.owner).toBe("local");
  expect(s.verify("cyt_wrong")).toBeNull();
  expect(s.verify(null)).toBeNull();
  expect(s.verify(r.token.slice(0, -1))).toBeNull();

  // the file never holds the bearer, only its hash
  const onDisk = await readFile(file, "utf8");
  expect(onDisk).not.toContain(r.token);
  expect(onDisk).toContain("tokenHash");

  // a re-open (restart) still verifies the same bearer
  const s2 = await EngineTokens.open(file);
  expect(s2.verify(r.token)?.engineId).toBe("e-1");
});

test("re-enroll rotates: fresh token works, the old bearer dies", async () => {
  const s = await EngineTokens.open(join(await scratch(), "t.json"));
  const a = await s.enroll({ engineId: "e-1", spki: "spki-a", owner: "local" });
  const b = await s.enroll({ engineId: "e-1", spki: "spki-a", owner: "local" });
  if (!a.ok || !b.ok) throw new Error("enroll refused");
  expect(b.rotated).toBe(true);
  expect(b.token).not.toBe(a.token);
  expect(s.verify(a.token)).toBeNull();       // yesterday's leak is dead
  expect(s.verify(b.token)?.engineId).toBe("e-1");
  expect(s.count).toBe(1);                     // one record, not two
});

test("identity and owner mismatches are refused, never rebound", async () => {
  const s = await EngineTokens.open(join(await scratch(), "t.json"));
  await s.enroll({ engineId: "e-1", spki: "spki-a", owner: "user_alice" });

  const otherKey = await s.enroll({ engineId: "e-1", spki: "spki-EVIL", owner: "user_alice" });
  expect(otherKey).toMatchObject({ ok: false, status: 403, error: "identity mismatch" });

  const otherOwner = await s.enroll({ engineId: "e-1", spki: "spki-a", owner: "user_bob" });
  expect(otherOwner).toMatchObject({ ok: false, status: 403, error: "owner mismatch" });
});

test("revoke kills the bearer at once and bars re-enrollment until restored", async () => {
  const s = await EngineTokens.open(join(await scratch(), "t.json"));
  const a = await s.enroll({ engineId: "e-1", spki: "spki-a", owner: "user_alice" });
  if (!a.ok) throw new Error("enroll refused");

  expect(await s.revoke("e-1", "user_alice")).toBe("revoked");
  expect(s.verify(a.token)).toBeNull();

  // a revoked engine may not talk its way back in
  const again = await s.enroll({ engineId: "e-1", spki: "spki-a", owner: "user_alice" });
  expect(again).toMatchObject({ ok: false, status: 403, error: "revoked" });

  // another owner can neither revoke nor restore, and cannot tell it exists
  expect(await s.revoke("e-1", "user_bob")).toBe("not-found");
  expect(await s.restore("e-1", "user_bob")).toBe("not-found");

  // restore un-bars the door; the old bearer stays dead until re-enrollment
  expect(await s.restore("e-1", "user_alice")).toBe("restored");
  expect(s.verify(a.token)).toBeNull();
  const fresh = await s.enroll({ engineId: "e-1", spki: "spki-a", owner: "user_alice" });
  if (!fresh.ok) throw new Error("post-restore enroll refused");
  expect(s.verify(fresh.token)?.engineId).toBe("e-1");
});

test("the listing carries no hashes and scopes by owner", async () => {
  const s = await EngineTokens.open(join(await scratch(), "t.json"));
  await s.enroll({ engineId: "e-a", spki: "sa", owner: "user_alice" });
  await s.enroll({ engineId: "e-b", spki: "sb", owner: "user_bob" });
  const alice = s.list("user_alice");
  expect(alice.map((e) => e.engineId)).toEqual(["e-a"]);
  expect(JSON.stringify(alice)).not.toContain("tokenHash");
  expect(JSON.stringify(alice)).not.toContain("spki");
  expect(s.list(null).length).toBe(2);
});

test("one owner cannot grow the store past the per-owner cap; re-enroll still works", async () => {
  const s = await EngineTokens.open(join(await scratch(), "t.json"));
  const { ENGINES_PER_OWNER_MAX } = await import("./enroll");
  for (let i = 0; i < ENGINES_PER_OWNER_MAX; i++) {
    const r = await s.enroll({ engineId: `e-${i}`, spki: `s${i}`, owner: "user_alice" });
    expect(r.ok).toBe(true);
  }
  // one more NEW engineId is refused, loudly
  const over = await s.enroll({ engineId: "e-over", spki: "sx", owner: "user_alice" });
  expect(over).toMatchObject({ ok: false, status: 429, error: "too many engines" });
  // an existing engine still rotates (never counted against the cap)...
  expect((await s.enroll({ engineId: "e-0", spki: "s0", owner: "user_alice" })).ok).toBe(true);
  // ...and another owner is unaffected
  expect((await s.enroll({ engineId: "e-bob", spki: "sb", owner: "user_bob" })).ok).toBe(true);
});

test("two minted tokens never collide and carry the prefix", () => {
  const a = mintEngineToken();
  const b = mintEngineToken();
  expect(a).not.toBe(b);
  expect(a.startsWith("cyt_")).toBe(true);
  expect(a.length).toBeGreaterThan(40);
});

/* ------------------------------------- the signature, engine <-> server */

test("a signed enrollment verifies; a tampered one does not", async () => {
  const eng = await fakeEngine("e-sig");
  const body = await signEnroll(eng);
  expect(await verifyEnrollSig(body.engineId, body.pubkey, body.ts, body.sig)).toBe(true);
  // any field moving breaks the signature
  expect(await verifyEnrollSig("e-other", body.pubkey, body.ts, body.sig)).toBe(false);
  expect(await verifyEnrollSig(body.engineId, body.pubkey, body.ts + 1, body.sig)).toBe(false);
  // a signature by a DIFFERENT key over the same claim fails
  const other = await fakeEngine("e-sig");
  const forged = await signEnroll(other);
  expect(await verifyEnrollSig(body.engineId, body.pubkey, forged.ts, forged.sig)).toBe(false);
  // garbage never throws
  expect(await verifyEnrollSig("e", "not spki", 1, "not sig")).toBe(false);
});

/* --------------------------------- the wiring, against a real process */

async function startLocal(dir: string): Promise<Server> {
  const port = 9500 + Math.floor(Math.random() * 300);
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: "127.0.0.1",
      DIST_DIR: dir,
      PUSH_FILE: join(dir, "push-subs.json"),
      SETTINGS_FILE: join(dir, "app-settings.json"),
      ENGINE_LEASES_FILE: join(dir, "leases.json"),
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

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body) });

test("the whole local lifecycle: enroll, announce, push, rotate, revoke, restore", async () => {
  const s = await startLocal(await scratch());
  const eng = await fakeEngine();

  // no token: announce and both push routes are 401, never open (LOCAL too)
  const ann = { engineId: eng.engineId, host: "mac", user: "u", url: "ws://mac:10101/ws" };
  expect((await post(`${s.url}/engines/announce`, ann)).status).toBe(401);
  expect((await post(`${s.url}/push/notify`, { sessionId: "a", body: "b" })).status).toBe(401);
  expect((await post(`${s.url}/push/batch`, { host: "mac", new: [] })).status).toBe(401);

  // a bad signature is refused; a stale ts is refused
  const good = await signEnroll(eng);
  expect((await post(`${s.url}/engines/enroll`, { ...good, sig: good.sig.slice(0, -4) + "AAAA" })).status).toBe(401);
  expect((await enrollEngine(s.url, eng, {}, Date.now() - ENROLL_SKEW_MS - 60_000)).status).toBe(400);
  expect((await post(`${s.url}/engines/enroll`, { engineId: "e" })).status).toBe(400);

  // a correct enrollment earns a token, and the token opens the routes
  const { token, bearer } = await enrolledBearer(s.url, eng);
  expect((await post(`${s.url}/engines/announce`, ann, bearer)).status).toBe(200);
  const n = await post(`${s.url}/push/notify`, { sessionId: "a", body: "hello" }, bearer);
  expect(n.status).toBe(200);
  expect(((await n.json()) as any).ok).toBe(true);
  expect((await post(`${s.url}/push/batch`, { host: "mac", new: [] }, bearer)).status).toBe(200);

  // the token speaks ONLY for its own engineId
  const forged = { ...ann, engineId: "e-somebody-else" };
  expect((await post(`${s.url}/engines/announce`, forged, bearer)).status).toBe(403);

  // re-enrollment rotates: the fresh token works, the old one is dead
  const again = await enrollEngine(s.url, eng);
  expect(again.status).toBe(200);
  expect(again.token).not.toBe(token);
  expect((await post(`${s.url}/push/notify`, { sessionId: "a", body: "b" },
    { authorization: `Bearer ${token}` })).status).toBe(401);
  const fresh = { authorization: `Bearer ${again.token}` };
  expect((await post(`${s.url}/push/notify`, { sessionId: "a", body: "b" }, fresh)).status).toBe(200);

  // the enrolled list names it, without secrets
  const listed = (await (await fetch(`${s.url}/engines/enrolled`)).json()) as any;
  expect(listed.engines.map((e: any) => e.engineId)).toEqual([eng.engineId]);
  expect(JSON.stringify(listed)).not.toContain("cyt_");

  // revocation: the bearer dies now, and re-enrollment is barred
  expect((await post(`${s.url}/engines/revoke`, { engineId: eng.engineId })).status).toBe(200);
  expect((await post(`${s.url}/push/notify`, { sessionId: "a", body: "b" }, fresh)).status).toBe(401);
  expect((await enrollEngine(s.url, eng)).status).toBe(403);

  // restore un-bars enrollment; a fresh enroll works again
  expect((await post(`${s.url}/engines/revoke`, { engineId: eng.engineId, restore: true })).status).toBe(200);
  const back = await enrollEngine(s.url, eng);
  expect(back.status).toBe(200);
  expect((await post(`${s.url}/push/notify`, { sessionId: "a", body: "b" },
    { authorization: `Bearer ${back.token}` })).status).toBe(200);

  // an unknown engineId cannot be revoked into existence
  expect((await post(`${s.url}/engines/revoke`, { engineId: "e-nope" })).status).toBe(404);
}, 40_000);

test("a token survives a server restart (the store is on disk)", async () => {
  const dir = await scratch();
  const s1 = await startLocal(dir);
  const { token, eng } = await enrolledBearer(s1.url);
  await s1.stop();
  servers = servers.filter((x) => x !== s1);

  const s2 = await startLocal(dir);
  const r = await post(`${s2.url}/push/notify`, { sessionId: "a", body: "b" },
    { authorization: `Bearer ${token}` });
  expect(r.status).toBe(200);
  // and the identity binding survived too: a different key for that id is 403
  const thief = await fakeEngine(eng.engineId);
  expect((await enrollEngine(s2.url, thief)).status).toBe(403);
}, 40_000);
