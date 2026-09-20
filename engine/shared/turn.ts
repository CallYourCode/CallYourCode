/* Ephemeral TURN credentials, coturn's static-auth-secret scheme.
 *
 * The app-server never runs TURN itself (that is a separate public box).
 * It only MINTS the time-limited
 * credentials both ends put in their iceServers list:
 *
 *   username   = "<unix expiry seconds>:<label>"   (coturn reads the expiry;
 *                the label is for our logs only, the Clerk sub or "engine")
 *   credential = base64(HMAC-SHA1(TURN_STATIC_SECRET, username))
 *
 * coturn, configured with `use-auth-secret` and the same static secret,
 * recomputes the HMAC and refuses anything expired or forged. The secret
 * never leaves this server; a credential expires on its own, so nothing is
 * stored and nothing needs revoking.
 *
 * TURN traffic is DTLS-wrapped SCTP carrying the sealed client wire, so the
 * TURN box sees ciphertext of ciphertext: sizes and timing, never content.
 */

import { createHmac } from "node:crypto";

export type TurnEnv = {
  urls: string[];       // e.g. ["turn:turn.example.com:3478", "turns:turn.example.com:5349?transport=tcp"]
  secret: string;       // coturn's static-auth-secret
  ttlS: number;         // credential lifetime in seconds
};

export const TURN_TTL_DEFAULT_S = 21_600; // 6 h: outlives any signaling attempt

/** The TURN deployment named by env, or null when there is none (the common
 *  case; STUN alone then). TURN_URLS is comma separated turn:/turns: URIs. */
export function turnEnv(env: Record<string, string | undefined> = process.env): TurnEnv | null {
  const urls = (env.TURN_URLS ?? "").split(",").map((u) => u.trim())
    .filter((u) => /^turns?:/.test(u));
  const secret = env.TURN_STATIC_SECRET ?? "";
  if (!urls.length || !secret) return null;
  const ttl = Number(env.TURN_TTL_S);
  return { urls, secret, ttlS: Number.isFinite(ttl) && ttl > 0 ? ttl : TURN_TTL_DEFAULT_S };
}

export type IceServer = { urls: string[]; username?: string; credential?: string };

/** One freshly minted credential set for `label`, browser iceServers shape. */
export function mintTurn(t: TurnEnv, label: string, now = Date.now()): IceServer {
  const expiry = Math.floor(now / 1000) + t.ttlS;
  const username = `${expiry}:${label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}`;
  const credential = createHmac("sha1", t.secret).update(username).digest("base64");
  return { urls: t.urls, username, credential };
}

/** The ICE servers for the LOCAL path: STUN + TURN at our OWN turn-server
 *  (server/turn, turn-server), reached at the box's tailnet host. STUN is the
 *  one that matters -- a tailnet client queries it over tailscale and gets its
 *  tailscale IP back, so ICE forms the direct pair. TURN (same static secret)
 *  is the wired fallback. Empty when no turn host is configured. */
export function localIce(host: string | undefined, port: number,
  secret: string | undefined, label: string, now = Date.now()): IceServer[] {
  if (!host) return [];
  const stun: IceServer = { urls: [`stun:${host}:${port}`] };
  if (!secret) return [stun];
  const turn = mintTurn({ urls: [`turn:${host}:${port}`], secret, ttlS: TURN_TTL_DEFAULT_S }, label, now);
  return [stun, turn];
}

/** What coturn does with a presented pair; here only so a test can prove the
 *  mint against an independent recomputation. */
export function verifyTurn(secret: string, username: string, credential: string,
  now = Date.now()): boolean {
  const expiry = Number(username.split(":")[0]);
  if (!Number.isFinite(expiry) || expiry * 1000 <= now) return false;
  return createHmac("sha1", secret).update(username).digest("base64") === credential;
}
