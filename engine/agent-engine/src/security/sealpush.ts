/* The v2 push seal: the one piece that turns the generic
 * fallback text into a real, sealed preview for a paired device.
 *
 * The pure half lives here so the crypto can be proven in sealpush.test.ts
 * without booting a whole engine (server.ts starts a server at import). The
 * wire sites in server.ts wrap this with the engine's live E2EState.
 *
 * Key path, exactly as the design names it: the per-session key is derived
 * from the NEWEST content generation (newestGen), never kEngine, never anything
 * invented here; the payload is {title, body, count} sealed by sealPush (AES-
 * 256-GCM, random IV); the wire carries {kid: newestGen.kid, enc}.
 *
 * Total contract: this always returns a seal. Every engine mints content
 * generation 1 at first boot (sec.ts freshState), so there is always a live
 * generation and a key. There is no unsealed mode. A throw is the only failure,
 * and the caller must treat it as fatal: log it and send nothing. */

import { deriveEngineNotifyKey, deriveSessionKey, sealPush } from "../../../shared/e2e";
import { newestGen, type E2EState } from "./sec";

export async function sealPushItem(
  st: E2EState,
  sessionId: string,
  title: string,
  body: string,
  count: number,
): Promise<{ kid: string; enc: string }> {
  const gen = newestGen(st);
  const kS = await deriveSessionKey(gen.key, sessionId);
  const enc = await sealPush(kS, { title, body, count });
  return { kid: gen.kid, enc };
}

/* Seal a SESSION-LESS engine-level item (a plan-usage threshold alert): the
 * preview rides under the ENGINE notify key (deriveEngineNotifyKey), never a
 * per-session key, because the alert is about the account and no chat. Same total
 * contract as sealPushItem: every engine mints content generation 1 at first
 * boot, so a key always exists; a throw is the only failure and the caller sends
 * nothing. `open` is the tap target ("usage:<host>"), sealed so it never rides
 * the wire in the clear. */
export async function sealEngineItem(
  st: E2EState,
  title: string,
  body: string,
  open?: string,
): Promise<{ kid: string; enc: string }> {
  const gen = newestGen(st);
  const kN = await deriveEngineNotifyKey(gen.key);
  const enc = await sealPush(kN, { title, body, ...(open ? { open } : {}) });
  return { kid: gen.kid, enc };
}
