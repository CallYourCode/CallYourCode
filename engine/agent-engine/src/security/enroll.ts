/* Engine enrollment, the ENGINE's half: the token file and the one POST.
 *
 * The signature itself -- the canonical string, the signer and the verifier --
 * is a wire contract shared with the app server and lives in
 * ../shared/enroll-wire.ts. It used to live here, and this file's header used
 * to justify that by noting the app server "already imports agent-engine
 * modules"; it no longer does. What stays here is what only an engine has: the
 * token file it earned, and the enrollment request that earns it.
 *
 * The wire names are re-exported below so engine call sites keep one import.
 *
 *   bun test agent-engine/src/security/enroll.test.ts
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { signEnroll, type EnrollIdentity } from "../../../shared/enroll-wire.ts";

export {
  ENROLL_SKEW_MS,
  enrollCanonical,
  signEnroll,
  verifyEnrollSig,
  type EnrollBody,
} from "../../../shared/enroll-wire.ts";

/* ------------------------------------------------ the engine's token file
 *
 * state/app-token.json, 0600, beside keys.json rather than inside it (sec.ts
 * owns the keys.json v3 shape strictly). The token is only valid for the app
 * server that issued it, so the URL rides along and a mismatch discards it. */

type TokenFile = { v: 1; appServerUrl: string; token: string; issuedAt: number };

export function loadAppToken(file: string, appServerUrl: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, "utf8")) as TokenFile;
    if (j?.v !== 1 || typeof j.token !== "string" || !j.token) return null;
    if (j.appServerUrl !== appServerUrl) return null;
    return j.token;
  } catch {
    return null;
  }
}

/** The app-server base a saved enrollment names, or null when there is none.
 *  This is what lets `cyc pair` -> Cloud JUST WORK: the pair saves the token
 *  file with the enrolled base inside it, and the engine's next boot resolves
 *  its app-server address from here when no APP_SERVER_URL env is set, so no
 *  manual env or unit drop-in is ever needed to go live. A local enrollment
 *  writes the loopback base, which is the default anyway. */
export function enrolledAppServerUrl(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, "utf8")) as TokenFile;
    if (j?.v !== 1 || typeof j.token !== "string" || !j.token) return null;
    if (typeof j.appServerUrl !== "string" || !j.appServerUrl) return null;
    return j.appServerUrl.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function saveAppToken(file: string, appServerUrl: string, token: string): void {
  const j: TokenFile = { v: 1, appServerUrl, token, issuedAt: Date.now() };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(j) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch {}
}

export function clearAppToken(file: string): void {
  try { unlinkSync(file); } catch {}
}

/** One enrollment POST. Returns the issued token, or null on any failure
 *  (unreachable, refused, malformed answer); never throws -- the engine must
 *  boot and serve regardless, the same posture announceOnce has.
 *
 *  `bearer` is the one-time cyg_ onboarding grant for a HOSTED first run (the
 *  pair command's cloud flow, pairkey.ts: received over the device-flow poll
 *  after Google sign-in, or pasted in the manual fallback). The engine never
 *  handles a raw Clerk
 *  JWT. Empty on LOCAL, where enrollment is open. A HOSTED re-enroll after a
 *  401 needs a fresh grant too: run the pair command's Cloud path again. */
export async function enrollOnce(
  appServerUrl: string,
  st: EnrollIdentity,
  bearer = "",
): Promise<string | null> {
  if (!appServerUrl) return null;
  try {
    const body = await signEnroll(st);
    const res = await fetch(`${appServerUrl}/engines/enroll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json().catch(() => null)) as any;
    if (!res.ok || typeof j?.token !== "string" || !j.token) {
      console.warn(`[enroll] ${st.engineId} REFUSED http ${res.status}` +
        `${j?.error ? ` (${j.error})` : ""}`);
      return null;
    }
    console.log(`[enroll] ${st.engineId} enrolled at ${appServerUrl}` +
      `${j.owner ? ` (owner ${j.owner})` : ""}`);
    return j.token;
  } catch (e) {
    console.warn(`[enroll] ${st.engineId} FAILED: ${(e as Error)?.message}`);
    return null;
  }
}
