/* routes/engines.ts as a unit: the enrollment gate order (signature before
 * grant), the skew bound, revoke/restore, announce identity binding, and
 * token introspection. Real EngineTokens and EngineLeases on scratch files,
 * real P-256 signatures via enrollkit; no server process. */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEngineRoutes } from "./engines";
import { EngineTokens } from "../access/enroll";
import { EnrollGrants } from "../access/grants";
import { EngineLeases } from "../engines/hosts";
import { fakeEngine } from "../test-support/enrollkit";
import { signEnroll } from "../../../engine/shared/enroll-wire.ts";
import { ENROLL_SKEW_MS } from "../../../engine/shared/enroll-wire.ts";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});
const silent = () => {};

async function rig(hosted = false, sub: string | null = null) {
  const d = await mkdtemp(join(tmpdir(), "cyc-engroutes-unit-"));
  dirs.push(d);
  const engineTokens = await EngineTokens.open(join(d, "tokens.json"));
  const leases = await EngineLeases.open(join(d, "leases.json"), 60_000);
  const enrollGrants = new EnrollGrants();
  const routes = makeEngineRoutes({
    hosted, engineTokens, enrollGrants, leases, engineLeaseMs: 60_000,
    sessionSub: async () => sub,
    engineAuth: (req) => {
      const h = req.headers.get("authorization") ?? "";
      return engineTokens.verify(h.startsWith("Bearer ") ? h.slice(7) : null);
    },
    log: silent,
  });
  return { engineTokens, leases, enrollGrants, routes };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, { method: "POST", headers,
    body: JSON.stringify(body) });

test("LOCAL enroll: a signed body earns a token under owner 'local'", async () => {
  const { routes } = await rig();
  const eng = await fakeEngine();
  const r = (await routes(post("/engines/enroll", await signEnroll(eng)), "/engines/enroll"))!;
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.token.startsWith("cyt_")).toBe(true);
  expect(j.owner).toBe("local");
});

test("a stale ts is a 400 (replay bound) before anything is issued", async () => {
  const { routes, engineTokens } = await rig();
  const eng = await fakeEngine();
  const stale = await signEnroll(eng, Date.now() - ENROLL_SKEW_MS - 1000);
  const r = (await routes(post("/engines/enroll", stale), "/engines/enroll"))!;
  expect(r.status).toBe(400);
  expect(engineTokens.count).toBe(0);
});

test("a bad signature is a 401; a tampered field kills the real signature", async () => {
  const { routes, engineTokens } = await rig();
  const eng = await fakeEngine();
  const body = await signEnroll(eng);
  const tampered = { ...body, engineId: "someone-else" };
  const r = (await routes(post("/engines/enroll", tampered), "/engines/enroll"))!;
  expect(r.status).toBe(401);
  expect(engineTokens.count).toBe(0);
});

test("HOSTED enroll: signature is checked BEFORE a grant is burned", async () => {
  const { routes, enrollGrants } = await rig(true);
  const sub = "user_alice";
  const code = enrollGrants.mint(sub).code;
  const eng = await fakeEngine();
  const forged = { ...(await signEnroll(eng)), sig: "AAAA" };
  const r = (await routes(post("/engines/enroll", forged,
    { authorization: `Bearer ${code}` }), "/engines/enroll"))!;
  expect(r.status).toBe(401);
  // the grant survived the forgery and still redeems for the real enrollment
  const ok = (await routes(post("/engines/enroll", await signEnroll(eng),
    { authorization: `Bearer ${code}` }), "/engines/enroll"))!;
  expect(ok.status).toBe(200);
  expect((await ok.json()).owner).toBe(sub);
});

test("HOSTED enroll with neither grant nor session is a 401", async () => {
  const { routes } = await rig(true, null);
  const eng = await fakeEngine();
  const r = (await routes(post("/engines/enroll", await signEnroll(eng)), "/engines/enroll"))!;
  expect(r.status).toBe(401);
});

test("revoke kills the bearer; restore only un-bars re-enrollment", async () => {
  const { routes, engineTokens } = await rig();
  const eng = await fakeEngine("e-rev");
  const enrolled = (await routes(post("/engines/enroll", await signEnroll(eng)), "/engines/enroll"))!;
  const token = (await enrolled.json()).token as string;
  expect(engineTokens.verify(token)?.engineId).toBe("e-rev");

  const rev = (await routes(post("/engines/revoke", { engineId: "e-rev" }), "/engines/revoke"))!;
  expect((await rev.json()).revoked).toBe(true);
  expect(engineTokens.verify(token)).toBeNull();

  const res = (await routes(post("/engines/revoke", { engineId: "e-rev", restore: true }),
    "/engines/revoke"))!;
  expect((await res.json()).revoked).toBe(false);
  expect(engineTokens.verify(token)).toBeNull();   // the old bearer stays dead

  const unknown = (await routes(post("/engines/revoke", { engineId: "nope" }), "/engines/revoke"))!;
  expect(unknown.status).toBe(404);
});

test("announce: token required, engineId bound to the token, lease recorded", async () => {
  const { routes, leases } = await rig();
  const eng = await fakeEngine("e-ann");
  const enrolled = (await routes(post("/engines/enroll", await signEnroll(eng)), "/engines/enroll"))!;
  const bearer = { authorization: `Bearer ${(await enrolled.json()).token}` };

  // no token: 401
  const bare = (await routes(post("/engines/announce",
    { engineId: "e-ann", url: "ws://h:10101/ws" }), "/engines/announce"))!;
  expect(bare.status).toBe(401);

  // a token cannot speak for another engine
  const forged = (await routes(post("/engines/announce",
    { engineId: "e-other", url: "ws://h:10101/ws" }, bearer), "/engines/announce"))!;
  expect(forged.status).toBe(403);

  // a non-ws url is refused
  const badUrl = (await routes(post("/engines/announce",
    { engineId: "e-ann", url: "http://h:10101" }, bearer), "/engines/announce"))!;
  expect(badUrl.status).toBe(400);

  const ok = (await routes(post("/engines/announce",
    { engineId: "e-ann", url: "ws://h:10101/ws", host: "h", user: "u" }, bearer),
    "/engines/announce"))!;
  expect(ok.status).toBe(200);
  expect((await ok.json()).leased).toBe(60_000);
  const live = await leases.list();
  expect(live.length).toBe(1);
  expect(live[0]).toMatchObject({ engineId: "e-ann", url: "ws://h:10101/ws", user: "u" });
});

test("GET /engines: LOCAL lists all; HOSTED scopes to the session's own", async () => {
  const local = await rig();
  const r = (await local.routes(new Request("http://x/engines"), "/engines"))!;
  expect((await r.json()).engines).toEqual([]);

  const hosted = await rig(true, null);
  expect((await hosted.routes(new Request("http://x/engines"), "/engines"))!.status).toBe(401);
});

test("/engines/verify trades a bearer for {engineId, owner}; garbage is a 401", async () => {
  const { routes } = await rig();
  const eng = await fakeEngine("e-ver");
  const enrolled = (await routes(post("/engines/enroll", await signEnroll(eng)), "/engines/enroll"))!;
  const token = (await enrolled.json()).token as string;

  const good = (await routes(post("/engines/verify", { token }), "/engines/verify"))!;
  expect(await good.json()).toMatchObject({ ok: true, engineId: "e-ver", owner: "local" });

  const bad = (await routes(post("/engines/verify", { token: "cyt_nope" }), "/engines/verify"))!;
  expect(bad.status).toBe(401);
});
