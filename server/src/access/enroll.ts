/* The per-engine token store: who may announce and push, and as whom.
 *
 * One record per engineId, written at enrollment. The
 * TOKEN itself is never stored -- only its SHA-256 -- so the file on disk is
 * a lookup table, not a bag of bearer credentials. Verification is a hash of
 * the presented bearer and a map lookup; an empty store verifies nothing, so
 * every engine route fails closed by construction and HOSTED needs no boot
 * gate for push auth any more (the old H2 PUSH_TOKEN gate is superseded).
 *
 * Lifecycle (enroll() below): a new engineId is issued a token; the same
 * engineId with the same identity key and owner ROTATES (fresh token, the old
 * hash stops verifying); a different key or a different owner is refused; a
 * revoked engine is refused until restored. The file is engine-tokens.json
 * under the per-user state dir (bootstrap/server.ts: ~/.callyourcode/app-server)
 * (ENGINE_TOKENS_FILE overrides, for the same reason PUSH_FILE exists: a test
 * server must never write the store the real one reads), 0600, atomic write.
 */

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { mkdirPrivate } from "../../../engine/shared/runfiles.ts";
import { fpOfSpki } from "../../../engine/shared/enroll-wire.ts";

export type EngineTokenRec = {
  engineId: string;
  owner: string;      // Clerk sub in HOSTED; the literal "local" in LOCAL
  spki: string;       // the identity pubkey the enrollment signature proved
  fp: string;         // fingerprint of spki, for humans and lists
  tokenHash: string;  // sha256 hex of the issued bearer; never the bearer
  issuedAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
};

export type EnrollOutcome =
  | { ok: true; token: string; rotated: boolean }
  | { ok: false; status: number; error: string };

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/* How many engines ONE owner may hold records for. A real account runs a
 * handful of machines; this only stops a hostile caller (or, in LOCAL, a
 * hostile network peer) minting endless engineIds and growing this store
 * without bound. Re-enrollment of an existing engineId is never counted. */
export const ENGINES_PER_OWNER_MAX = 100;

const b64url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Mint a fresh bearer: `cyt_` + 32 random bytes, base64url. Opaque on
 *  purpose -- this server is the only verifier, so a random value plus a
 *  server-side record beats a signed token (nothing to mis-verify, and
 *  revocation is immediate). */
export function mintEngineToken(): string {
  return "cyt_" + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

function isRec(v: unknown): v is EngineTokenRec {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.engineId === "string" && e.engineId.length > 0 &&
    typeof e.owner === "string" &&
    typeof e.spki === "string" &&
    typeof e.tokenHash === "string" &&
    typeof e.issuedAt === "number";
}

export class EngineTokens {
  private byId = new Map<string, EngineTokenRec>();
  private byHash = new Map<string, EngineTokenRec>();

  private constructor(private file: string) {}

  static async open(file: string): Promise<EngineTokens> {
    const s = new EngineTokens(file);
    const j = await Bun.file(file).json().catch(() => null) as any;
    if (j && Array.isArray(j.engines)) {
      for (const e of j.engines) {
        if (!isRec(e)) continue;
        const rec: EngineTokenRec = {
          engineId: e.engineId, owner: e.owner, spki: e.spki,
          fp: typeof e.fp === "string" ? e.fp : "",
          tokenHash: e.tokenHash, issuedAt: e.issuedAt,
          rotatedAt: typeof e.rotatedAt === "number" ? e.rotatedAt : null,
          revokedAt: typeof e.revokedAt === "number" ? e.revokedAt : null,
        };
        s.byId.set(rec.engineId, rec);
        s.byHash.set(rec.tokenHash, rec);
      }
    }
    return s;
  }

  private async persist(): Promise<void> {
    await mkdirPrivate(dirname(this.file));
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ engines: [...this.byId.values()] }));
      await chmod(tmp, 0o600).catch(() => {});
      await rename(tmp, this.file);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  /** Issue (or rotate) the token for one proof-carrying enrollment. The
   *  caller has ALREADY verified the signature and the ts window and named
   *  the owner (Clerk sub, or "local"). */
  async enroll(args: { engineId: string; spki: string; owner: string }): Promise<EnrollOutcome> {
    const prev = this.byId.get(args.engineId);
    if (prev) {
      /* A revoked engine may not talk its way back in -- in LOCAL either,
       * where enrollment is otherwise open. restore() is the only door. */
      if (prev.revokedAt !== null) return { ok: false, status: 403, error: "revoked" };
      /* The engineId is claimed by a different identity key: an impersonator
       * or a hand-edited keys.json. A reinstalled engine has a fresh
       * engineId, so this is never the honest path. */
      if (prev.spki !== args.spki) return { ok: false, status: 403, error: "identity mismatch" };
      /* No engine moves between owners implicitly. */
      if (prev.owner !== args.owner) return { ok: false, status: 403, error: "owner mismatch" };
    } else {
      /* A NEW engineId only: one owner may not grow this store without
       * bound. Far above any real fleet; says no rather than growing. */
      let mine = 0;
      for (const r of this.byId.values()) if (r.owner === args.owner) mine++;
      if (mine >= ENGINES_PER_OWNER_MAX) {
        return { ok: false, status: 429, error: "too many engines" };
      }
    }
    const token = mintEngineToken();
    const now = Date.now();
    const rec: EngineTokenRec = {
      engineId: args.engineId,
      owner: args.owner,
      spki: args.spki,
      fp: await fpOfSpki(args.spki).catch(() => ""),
      tokenHash: sha256hex(token),
      issuedAt: prev?.issuedAt ?? now,
      rotatedAt: prev ? now : null,
      revokedAt: null,
    };
    if (prev) this.byHash.delete(prev.tokenHash); // rotation: the old bearer dies now
    this.byId.set(rec.engineId, rec);
    this.byHash.set(rec.tokenHash, rec);
    await this.persist();
    return { ok: true, token, rotated: !!prev };
  }

  /** The record a presented bearer resolves to, or null. Revoked is null.
   *  The lookup is by sha256 of the bearer, so nothing here compares secret
   *  bytes against attacker-controlled input directly. */
  verify(bearer: string | null): EngineTokenRec | null {
    if (typeof bearer !== "string" || !bearer.startsWith("cyt_") || bearer.length > 128) return null;
    const rec = this.byHash.get(sha256hex(bearer));
    if (!rec || rec.revokedAt !== null) return null;
    return rec;
  }

  /** Revoke one engine's token. `owner` scopes the action in HOSTED (an owner
   *  may only touch their own engines); null means unscoped (LOCAL). A record
   *  the caller may not see answers "not-found", never "forbidden", so the
   *  route cannot be used to enumerate other owners' engineIds. */
  async revoke(engineId: string, owner: string | null): Promise<"revoked" | "not-found"> {
    const rec = this.byId.get(engineId);
    if (!rec || (owner !== null && rec.owner !== owner)) return "not-found";
    if (rec.revokedAt === null) {
      rec.revokedAt = Date.now();
      this.byHash.delete(rec.tokenHash); // the bearer dies with the record
      await this.persist();
    }
    return "revoked";
  }

  /** Clear a revocation so the engine's NEXT enrollment is accepted again.
   *  The old token stays dead; restore un-bars the door, it does not re-arm
   *  the bearer. */
  async restore(engineId: string, owner: string | null): Promise<"restored" | "not-found"> {
    const rec = this.byId.get(engineId);
    if (!rec || (owner !== null && rec.owner !== owner)) return "not-found";
    if (rec.revokedAt !== null) {
      rec.revokedAt = null;
      await this.persist();
    }
    return "restored";
  }

  /** The public listing: never hashes, never spki. `owner` scopes it in
   *  HOSTED; null lists everything (LOCAL). */
  list(owner: string | null): Array<Pick<EngineTokenRec, "engineId" | "owner" | "fp" | "issuedAt" | "rotatedAt" | "revokedAt">> {
    const out = [];
    for (const r of this.byId.values()) {
      if (owner !== null && r.owner !== owner) continue;
      out.push({ engineId: r.engineId, owner: r.owner, fp: r.fp,
        issuedAt: r.issuedAt, rotatedAt: r.rotatedAt, revokedAt: r.revokedAt });
    }
    return out;
  }

  get count(): number {
    return this.byId.size;
  }
}
