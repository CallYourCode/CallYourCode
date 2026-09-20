/* Test kit: a fake engine identity and its enrollment, for every app-server
 * spec that talks to an engine route. NOT a test file itself.
 *
 * The push and announce routes require an ISSUED per-engine token now,
 * so a spec that wants to push must first be an engine:
 * mint an identity keypair, sign the enrollment, present the token. Spelled
 * once here so a dozen specs do not each carry the ceremony. */

import { newIdentity, type EngineIdentity } from "../../../engine/shared/enroll-wire.ts";
import { signEnroll } from "../../../engine/shared/enroll-wire.ts";

export type FakeEngine = { engineId: string; identity: EngineIdentity };

/** A scratch engine: fresh identity keypair, fresh engineId. */
export async function fakeEngine(engineId?: string): Promise<FakeEngine> {
  return {
    engineId: engineId ?? `e-${crypto.randomUUID().replace(/-/g, "")}`,
    identity: await newIdentity(true),
  };
}

/** POST /engines/enroll with a correctly signed body. Extra headers carry a
 *  Clerk session bearer for HOSTED specs. */
export async function enrollEngine(
  url: string,
  eng: FakeEngine,
  headers: Record<string, string> = {},
  ts?: number,
): Promise<{ status: number; token?: string; json: any }> {
  const body = await signEnroll(eng, ts);
  const res = await fetch(`${url}/engines/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status,
    token: typeof json?.token === "string" ? json.token : undefined, json };
}

/** Enroll and return just the bearer headers, for the common happy path. */
export async function enrolledBearer(
  url: string,
  eng?: FakeEngine,
  headers: Record<string, string> = {},
): Promise<{ eng: FakeEngine; token: string; bearer: { authorization: string } }> {
  const e = eng ?? await fakeEngine();
  const r = await enrollEngine(url, e, headers);
  if (!r.token) throw new Error(`enrollment failed: http ${r.status} ${JSON.stringify(r.json)}`);
  return { eng: e, token: r.token, bearer: { authorization: `Bearer ${r.token}` } };
}
