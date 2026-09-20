/* One-time enrollment grants: the cloud onboarding handshake's code.
 *
 * HOSTED first-run used to mean pasting a raw Clerk session JWT into the
 * engine's environment (ENROLL_SESSION_TOKEN). That is gone. The onboarding
 * page (/enroll, onboard.ts) mints one of THESE instead, only ever inside the
 * Clerk-authenticated grant handler, and the user copies it into the engine
 * terminal. The engine presents it as the bearer on POST /engines/enroll; the
 * server redeems it for the owner `sub` it was minted for and issues the
 * long-lived cyt_ engine token as before. The engine never
 * sees a Clerk JWT at all any more.
 *
 * Properties, each proved in onboard.test.ts:
 *   - minted only for an authenticated session (the caller passes the sub it
 *     verified; the route 401s without one)
 *   - single-use: redeeming marks it used, a second redeem is refused
 *   - short-lived: minutes (GRANT_TTL_MS), then refused
 *   - opaque and server-stored: `cyg_` + 120 random bits; only the SHA-256 of
 *     the code is kept, so this store is a lookup table, not a bag of codes
 *
 * In-memory on purpose: a grant lives minutes and a restart voiding pending
 * grants only means reloading the page. Nothing here touches disk.
 */

import { createHash } from "node:crypto";

/** How long a freshly minted grant stays redeemable. Env-dialable so a test
 *  can prove expiry without waiting minutes; the default is the real value. */
export const GRANT_TTL_MS = Number(process.env.CYC_ENROLL_GRANT_TTL_MS ?? 10 * 60_000);

/** Outstanding (unredeemed, unexpired) grants ONE owner may hold. A human
 *  onboarding a machine needs one; reloading the page a few times needs a
 *  few. Past the cap the OLDEST is evicted, so the newest code (the one on
 *  screen) always works and the map cannot grow without bound. */
export const GRANTS_PER_SUB_MAX = 10;

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

const b64url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Mint the code itself: `cyg_` + 15 random bytes base64url (20 chars, 120
 *  bits). Short enough to copy by hand, far past guessable. The prefix keeps
 *  it visually distinct from the cyt_ engine token and lets /engines/enroll
 *  route a grant bearer away from the Clerk-session path by shape. */
export function mintGrantCode(): string {
  return "cyg_" + b64url(crypto.getRandomValues(new Uint8Array(15)));
}

type GrantRec = { sub: string; mintedAt: number; expiresAt: number; usedAt: number | null };

export type RedeemOutcome =
  | { ok: true; sub: string }
  | { ok: false; why: "unknown" | "expired" | "used" };

export class EnrollGrants {
  private byHash = new Map<string, GrantRec>();

  constructor(private ttlMs: number = GRANT_TTL_MS) {}

  /** Drop what can never be redeemed again. Used records are kept until
   *  expiry so a replayed code answers "used" (an honest signal in the log),
   *  then fall out with everything else. */
  private sweep(now: number): void {
    for (const [h, rec] of this.byHash) {
      if (now > rec.expiresAt) this.byHash.delete(h);
    }
  }

  /** A fresh grant for `sub`. THE ONLY CALLER is the Clerk-authenticated
   *  grant route (onboard.ts): the sub arrives already verified, never off a
   *  body. Evicts the sub's oldest outstanding grant past the per-sub cap. */
  mint(sub: string): { code: string; expiresAt: number } {
    const now = Date.now();
    this.sweep(now);
    const mine: Array<[string, GrantRec]> = [];
    for (const e of this.byHash) if (e[1].sub === sub && e[1].usedAt === null) mine.push(e);
    if (mine.length >= GRANTS_PER_SUB_MAX) {
      mine.sort((a, b) => a[1].mintedAt - b[1].mintedAt);
      for (const [h] of mine.slice(0, mine.length - GRANTS_PER_SUB_MAX + 1)) this.byHash.delete(h);
    }
    const code = mintGrantCode();
    const rec: GrantRec = { sub, mintedAt: now, expiresAt: now + this.ttlMs, usedAt: null };
    this.byHash.set(sha256hex(code), rec);
    return { code, expiresAt: rec.expiresAt };
  }

  /** Trade a presented code for its owner, exactly once. Refuses anything
   *  unknown (forged, or swept), expired, or already redeemed. The lookup is
   *  by sha256, so no secret bytes are compared against caller input. */
  redeem(code: string): RedeemOutcome {
    if (typeof code !== "string" || !code.startsWith("cyg_") || code.length > 64) {
      return { ok: false, why: "unknown" };
    }
    const rec = this.byHash.get(sha256hex(code));
    if (!rec) return { ok: false, why: "unknown" };
    if (rec.usedAt !== null) return { ok: false, why: "used" };
    if (Date.now() > rec.expiresAt) return { ok: false, why: "expired" };
    rec.usedAt = Date.now();
    return { ok: true, sub: rec.sub };
  }

  /** Outstanding records (used ones included until they expire). For tests
   *  and the boot log, never for auth decisions. */
  get size(): number {
    return this.byHash.size;
  }
}

/* ------------------------------------------------------ device sessions
 *
 * The auto-receive half of cloud onboarding (Claude-Code-style login). The
 * engine starts a session and gets TWO codes: `cyd_` (the device code, kept in
 * the terminal, presented on every poll) and `cyu_` (the user code, carried in
 * the /enroll?code= url the engine opens in a browser). After sign-in the page
 * mints its grant as before and ATTACHES it to the session by user code; the
 * engine's next poll receives the grant and redeems it on /engines/enroll
 * exactly like the manual paste did. The grant keeps every property it had
 * (owner-bound, single-use, short-lived); this store only moves it.
 *
 * Both codes are 120 random bits and only their SHA-256 is kept, same posture
 * as the grants above. The start endpoint is unauthenticated (the engine has
 * no credentials yet), so sessions are capped and the oldest evicted. A poll
 * that answers the grant deletes the session: one hand-off, ever. */

/** Outstanding device sessions, all owners together. Starts are
 *  unauthenticated, so the cap is global; past it the OLDEST is evicted. */
export const DEVICE_SESSIONS_MAX = 500;

type DeviceRec = { userHash: string; grant: string | null; startedAt: number; expiresAt: number };

export type DevicePoll =
  | { status: "pending" }
  | { status: "granted"; grant: string }
  | { status: "unknown" };

export class EnrollDevices {
  private byDevice = new Map<string, DeviceRec>(); // sha256(deviceCode) -> rec
  private byUser = new Map<string, string>(); // sha256(userCode) -> sha256(deviceCode)

  constructor(private ttlMs: number = GRANT_TTL_MS) {}

  private drop(devHash: string): void {
    const rec = this.byDevice.get(devHash);
    if (rec) this.byUser.delete(rec.userHash);
    this.byDevice.delete(devHash);
  }

  private sweep(now: number): void {
    for (const [h, rec] of this.byDevice) {
      if (now > rec.expiresAt) this.drop(h);
    }
  }

  /** A fresh session: both codes go back to the engine (the user code rides
   *  to the browser in the url); only hashes stay here. */
  start(): { deviceCode: string; userCode: string; expiresAt: number } {
    const now = Date.now();
    this.sweep(now);
    while (this.byDevice.size >= DEVICE_SESSIONS_MAX) {
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const [h, rec] of this.byDevice) {
        if (rec.startedAt < oldestAt) { oldest = h; oldestAt = rec.startedAt; }
      }
      if (!oldest) break;
      this.drop(oldest);
    }
    const deviceCode = "cyd_" + b64url(crypto.getRandomValues(new Uint8Array(15)));
    const userCode = "cyu_" + b64url(crypto.getRandomValues(new Uint8Array(15)));
    const userHash = sha256hex(userCode);
    const devHash = sha256hex(deviceCode);
    this.byDevice.set(devHash, { userHash, grant: null, startedAt: now, expiresAt: now + this.ttlMs });
    this.byUser.set(userHash, devHash);
    return { deviceCode, userCode, expiresAt: now + this.ttlMs };
  }

  /** Attach a freshly minted grant to the session the user code names. First
   *  attach wins; unknown or expired codes refuse (the page then falls back
   *  to showing the grant for a manual copy). */
  attach(userCode: string, grantCode: string): boolean {
    if (typeof userCode !== "string" || !userCode.startsWith("cyu_") || userCode.length > 64) {
      return false;
    }
    const devHash = this.byUser.get(sha256hex(userCode));
    const rec = devHash ? this.byDevice.get(devHash) : undefined;
    if (!devHash || !rec) return false;
    if (Date.now() > rec.expiresAt) { this.drop(devHash); return false; }
    if (rec.grant !== null) return false;
    rec.grant = grantCode;
    return true;
  }

  /** The engine's poll. Handing the grant out deletes the session, so it is
   *  answered exactly once; everything unknown or expired says "unknown". */
  poll(deviceCode: string): DevicePoll {
    if (typeof deviceCode !== "string" || !deviceCode.startsWith("cyd_") || deviceCode.length > 64) {
      return { status: "unknown" };
    }
    const devHash = sha256hex(deviceCode);
    const rec = this.byDevice.get(devHash);
    if (!rec) return { status: "unknown" };
    if (Date.now() > rec.expiresAt) { this.drop(devHash); return { status: "unknown" }; }
    if (rec.grant === null) return { status: "pending" };
    const grant = rec.grant;
    this.drop(devHash);
    return { status: "granted", grant };
  }

  /** Outstanding sessions, for tests. Never for auth decisions. */
  get size(): number {
    return this.byDevice.size;
  }
}
