/* The engine's half of enrollment: the signed request, the
 * token file and the never-throw client. Everything here is provable without a
 * process, and everything that is not lives beside a boot -- see the note at the
 * bottom of this file for exactly where and why.
 *
 *   bun test agent-engine/src/security/enroll.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newIdentity } from "../../../shared/e2e";
import {
  clearAppToken, enrollCanonical, enrollOnce, loadAppToken, saveAppToken,
  signEnroll, verifyEnrollSig,
} from "./enroll";

let dirs: string[] = [];
let stops: Array<() => void> = [];
afterEach(async () => {
  for (const f of stops.splice(0)) f();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

const fakeState = async (engineId = `e-${crypto.randomUUID().replace(/-/g, "")}`) =>
  ({ engineId, identity: await newIdentity(true) });

/* ------------------------------------------------------- the signed request */

test("signEnroll produces exactly what verifyEnrollSig accepts", async () => {
  const st = await fakeState("e-sign");
  const body = await signEnroll(st, 1234567890);
  expect(body).toMatchObject({ engineId: "e-sign", pubkey: st.identity.spki, ts: 1234567890 });
  expect(await verifyEnrollSig(body.engineId, body.pubkey, body.ts, body.sig)).toBe(true);
  // the canonical string is versioned and field-separated
  expect(enrollCanonical("e", "k", 5)).toBe("cyc-enroll-v1\ne\nk\n5");
  // moving any claim kills the signature
  expect(await verifyEnrollSig("e-other", body.pubkey, body.ts, body.sig)).toBe(false);
  expect(await verifyEnrollSig(body.engineId, body.pubkey, 42, body.sig)).toBe(false);
});

/* ----------------------------------------------------------- the token file */

test("the token file round-trips, is 0600, binds to its app server, and clears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-etoken-"));
  dirs.push(dir);
  const file = join(dir, "state", "app-token.json");

  expect(loadAppToken(file, "http://a:1")).toBeNull(); // nothing yet

  saveAppToken(file, "http://a:1", "cyt_abc");
  expect(loadAppToken(file, "http://a:1")).toBe("cyt_abc");
  expect(statSync(file).mode & 0o777).toBe(0o600);

  // a token is only valid for the server that issued it
  expect(loadAppToken(file, "http://other:2")).toBeNull();

  clearAppToken(file);
  expect(loadAppToken(file, "http://a:1")).toBeNull();
  clearAppToken(file); // clearing what is not there never throws
});

/* --------------------------------------------------- the never-throw client */

function stubServer(handler: (req: Request) => Response | Promise<Response>) {
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  stops.push(() => srv.stop(true));
  return `http://127.0.0.1:${srv.port}`;
}

test("enrollOnce returns the token, forwards the session bearer, and nulls on refusal", async () => {
  const seen: Array<{ auth: string | null; body: any }> = [];
  const url = stubServer(async (req) => {
    seen.push({ auth: req.headers.get("authorization"), body: await req.json() });
    return new Response(JSON.stringify({ ok: true, token: "cyt_issued", owner: "local" }),
      { headers: { "content-type": "application/json" } });
  });
  const st = await fakeState();

  // LOCAL shape: no session header at all
  expect(await enrollOnce(url, st)).toBe("cyt_issued");
  expect(seen[0].auth).toBeNull();
  expect(seen[0].body).toMatchObject({ engineId: st.engineId, pubkey: st.identity.spki });
  expect(typeof seen[0].body.sig).toBe("string");

  // HOSTED first run: the pasted one-time grant rides as the bearer
  await enrollOnce(url, st, "cyg_pastedgrant");
  expect(seen[1].auth).toBe("Bearer cyg_pastedgrant");

  // a refusal is null, not a throw
  const refusing = stubServer(() => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
  expect(await enrollOnce(refusing, st)).toBeNull();
  // a 200 with no token in it is a refusal too
  const empty = stubServer(() => new Response(JSON.stringify({ ok: true })));
  expect(await enrollOnce(empty, st)).toBeNull();
  // unreachable is null, not a throw; no app server is null immediately
  expect(await enrollOnce("http://127.0.0.1:1", st)).toBeNull();
  expect(await enrollOnce("", st)).toBeNull();
});

/* WHERE THE REST OF ENROLMENT IS PROVED, named exactly, because this file used
 * to point at one place and the facts were in three. They are all facts about a
 * LIVE engine rather than about enroll.ts, which is why none of them is here:
 *
 *   - ENROLS BEFORE IT SPEAKS, and the announce bears the issued token:
 *     e2e/roundtrip.test.ts, step (1). Boot ORDER is a property of server.ts's
 *     startup; no seam can hold it.
 *   - A 401 DROPS THE TOKEN, the engine enrols again, and the retried push
 *     bears the NEW token: e2e/push.test.ts, the never-drop test. It needs a
 *     real refusal from a real server and an engine that reacts to it.
 *   - THE ANNOUNCE-SIDE 401 and the backoff ladder: announce.test.ts, over the
 *     real announce module on a manual clock.
 *
 * What stays here is everything provable without a process: the signature
 * symmetry, the token file's mode and binding, and enrollOnce against a stub. */
