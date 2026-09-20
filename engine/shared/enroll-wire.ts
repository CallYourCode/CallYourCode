/* THE ENROLLMENT SIGNATURE, both halves, in one place so they cannot drift.
 *
 * PUSH_TOKEN (one shared secret on every engine) is gone. Instead the engine
 * proves possession of its identity key (keys.json v3, agent-engine/src/security/sec.ts) by
 * SIGNING an enrollment request, and the app server answers with a per-engine
 * opaque token. Every later announce and push bears that token; the app server
 * maps token -> {engineId, owner}, so in HOSTED no engine can announce or push
 * into another owner's account.
 *
 * WHY IT LIVES HERE. The canonical string is a WIRE CONTRACT: the engine signs
 * it and the app server verifies it, and if the two ever spelled it differently
 * every enrollment would fail closed with nothing to point at. It used to live
 * in agent-engine/src/security/enroll.ts, whose header said plainly that the app server
 * "already imports agent-engine modules" -- true, and the reason this directory
 * now exists. The engine-side token FILE IO stayed behind in
 * agent-engine/src/security/enroll.ts, where it belongs: the app server has no token file.
 *
 * The identity helpers are re-exported at the bottom so the app server has one
 * door for "engine identity and enrolment" rather than two.
 *
 *   bun test agent-engine/src/security/enroll.test.ts
 *   bun test app-server/enroll.test.ts
 */

/* THE crypto core now lives beside this file, so there is no edge out of shared/.
 *
 * shared/e2e.ts is a VENDORED crypto core, committed byte-identical to the app
 * repo (src/cyc/engine/e2e.ts) and pinned by a drift test over
 * fixtures/e2e-vectors.json in each repo. It used to sit in agent-engine/src/ and
 * this module reached upward for it, the last upward arrow out of shared/;
 * moving it here (the app's copy is held to the same
 * bytes) turned that arrow into an ordinary sibling import. Copying the five
 * crypto primitives into shared/ instead would have put a drift risk on the
 * security boundary these functions defend, which is why the file moved whole. */
import { b64decode, b64encode, importSpkiVerify, signId, verifyId } from "./e2e";

/** The identity fields the signer needs. Structural, so a caller may pass a
 *  whole E2EState (the engine does) or just these two (the test kits do)
 *  without this module importing the engine's key-file types. */
export type EnrollIdentity = {
  engineId: string;
  identity: { spki: string; keyPair: { privateKey: CryptoKey } };
};

/** How far an enrollment `ts` may sit from the server clock. A replay bound,
 *  not a security boundary on its own (HOSTED also gates on the Clerk
 *  session; LOCAL is a trusted network by definition). */
export const ENROLL_SKEW_MS = 10 * 60_000;

/** The exact bytes the identity key signs. Versioned so a future shape can
 *  coexist with old engines. */
export function enrollCanonical(engineId: string, spki: string, ts: number): string {
  return `cyc-enroll-v1\n${engineId}\n${spki}\n${ts}`;
}

export type EnrollBody = { engineId: string; pubkey: string; ts: number; sig: string };

/** The signed enrollment body for THIS engine's identity. */
export async function signEnroll(
  st: EnrollIdentity,
  ts = Date.now(),
): Promise<EnrollBody> {
  const spki = st.identity.spki;
  const sig = await signId(
    st.identity.keyPair.privateKey,
    new TextEncoder().encode(enrollCanonical(st.engineId, spki, ts)),
  );
  return { engineId: st.engineId, pubkey: spki, ts, sig: b64encode(sig) };
}

/** The app server's half: does `sig` verify against the pubkey in the body?
 *  False on anything malformed; never throws. Skew is the CALLER's check (it
 *  owns the clock and the 400-vs-401 distinction). */
export async function verifyEnrollSig(
  engineId: string,
  pubkey: string,
  ts: number,
  sig: string,
): Promise<boolean> {
  try {
    const pub = await importSpkiVerify(pubkey);
    return await verifyId(
      pub,
      new TextEncoder().encode(enrollCanonical(engineId, pubkey, ts)),
      b64decode(sig),
    );
  } catch {
    return false;
  }
}

/* The identity primitives an enroller needs, re-exported so both sides reach
 * them through this module rather than through the vendored file directly:
 * fpOfSpki names an engine by its key, newIdentity mints one. */
export { fpOfSpki, newIdentity, type EngineIdentity } from "./e2e";
