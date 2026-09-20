/* The engine identity surface: enrollment, revocation, the
 * enrolled list, the lease list, the announce upsert, and token introspection
 * for the standalone relay. There is no shared PUSH_TOKEN any more: an engine
 * enrolls once (signed with its identity key; gated by the owner's Clerk
 * session in HOSTED, open on the trusted network in LOCAL) and is issued a
 * per-engine token. Every announce and push bears that token, and this server
 * maps token -> {engineId, owner}, so no engine can announce or push into
 * another owner's account. */

import { json, type LogFn } from "../platform/httpx";
import { readBodyCapped } from "../../../engine/shared/bodyread.ts";
import { ENROLL_SKEW_MS, verifyEnrollSig } from "../../../engine/shared/enroll-wire.ts";
import { tokenFromRequest } from "../access/auth";
import { ANNOUNCE_BODY_MAX_BYTES, ENROLL_BODY_MAX_BYTES } from "../platform/caps";
import type { EngineTokens, EngineTokenRec } from "../access/enroll";
import type { EnrollGrants } from "../access/grants";
import type { EngineLeases } from "../engines/hosts";
import type { Owners } from "../access/owners";

export type EnginesDeps = {
  hosted: boolean;
  engineTokens: EngineTokens;
  enrollGrants: EnrollGrants;
  leases: EngineLeases;
  engineLeaseMs: number;
  sessionSub: Owners["sessionSub"];
  engineAuth: (req: Request) => EngineTokenRec | null;
  log: LogFn;
};

export function makeEngineRoutes(deps: EnginesDeps) {
  const { hosted, engineTokens, enrollGrants, leases, log } = deps;

  return async (req: Request, path: string): Promise<Response | null> => {
    /* The lease list itself: every engine that has announced and is still
     * leased, with the identity and the url the app dials. A lapsed entry is
     * dropped by leases.list() before it is served. HOSTED: the caller's own
     * engines only, so the list needs a valid Clerk session (401 without). */
    if (path === "/engines" && req.method === "GET") {
      const live = await leases.list();
      if (hosted) {
        const sub = await deps.sessionSub(req);
        if (!sub) return json({ error: "unauthorized" }, 401);
        return json({ engines: live.filter((e) => e.owner === sub) });
      }
      return json({ engines: live });
    }

    /* ENROLLMENT: an engine trading a signature by its
     * identity key for its own bearer token. HOSTED: the request must ALSO
     * prove WHO is enrolling -- either a one-time cyg_ onboarding grant (the
     * pair command's cloud flow: minted for a signed-in owner by
     * /enroll/grant, redeemed exactly once here) or the owner's Clerk session
     * itself; either way the owner is the verified sub, never a body claim.
     * LOCAL: the same path with no gate (trusted network); the owner is
     * "local". The signature binds engineId + pubkey + ts, so a token is only
     * ever issued to something holding that identity's private key, and a
     * later enroll for the same engineId under a different key or owner is
     * refused. The signature is checked BEFORE a grant is redeemed, so a
     * malformed or forged enrollment cannot burn the one code the user holds. */
    if (path === "/engines/enroll" && req.method === "POST") {
      const got = await readBodyCapped(req, ENROLL_BODY_MAX_BYTES);
      if (!got.ok) return got.response;
      let body: any = null;
      try { body = JSON.parse(new TextDecoder().decode(got.value)); } catch { /* below */ }
      if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
      const engineId = String(body?.engineId ?? "").slice(0, 100).trim();
      const pubkey = String(body?.pubkey ?? "").slice(0, 600).trim();
      const sig = String(body?.sig ?? "").slice(0, 200).trim();
      const ts = Number(body?.ts);
      if (!engineId || !pubkey || !sig || !Number.isFinite(ts)) {
        return json({ error: "engineId, pubkey, ts and sig are required" }, 400);
      }
      /* A replay bound: a captured enrollment goes stale. Not load-bearing on
       * its own (HOSTED also has the session gate), but free to enforce. */
      if (Math.abs(Date.now() - ts) > ENROLL_SKEW_MS) {
        return json({ error: "stale ts" }, 400);
      }
      if (!(await verifyEnrollSig(engineId, pubkey, ts, sig))) {
        log("engines.enroll.badsig", { engineId });
        return json({ error: "bad signature" }, 401);
      }
      let owner = "local";
      if (hosted) {
        const cred = tokenFromRequest(req);
        if (cred && cred.startsWith("cyg_")) {
          const g = enrollGrants.redeem(cred);
          if (!g.ok) {
            log("engines.enroll.badgrant", { engineId, why: g.why });
            return json({ error: "bad grant" }, 401);
          }
          owner = g.sub;
        } else {
          const sub = await deps.sessionSub(req);
          if (!sub) return json({ error: "unauthorized" }, 401);
          owner = sub;
        }
      }
      const r = await engineTokens.enroll({ engineId, spki: pubkey, owner });
      if (!r.ok) {
        log("engines.enroll.refused", { engineId, owner, why: r.error });
        return json({ error: r.error }, r.status);
      }
      log("engines.enroll", { engineId, owner, rotated: r.rotated });
      return json({ ok: true, token: r.token, engineId, owner });
    }

    /* Revoke (or restore) one engine's token. HOSTED: the owner's Clerk
     * session, scoped to their own engines (someone else's engineId answers
     * 404, never 403, so this cannot enumerate). LOCAL: open, like every
     * other local admin surface. Restore only un-bars enrollment; the old
     * bearer stays dead until the engine re-enrolls. */
    if (path === "/engines/revoke" && req.method === "POST") {
      let owner: string | null = null;
      if (hosted) {
        const sub = await deps.sessionSub(req);
        if (!sub) return json({ error: "unauthorized" }, 401);
        owner = sub;
      }
      const body = (await req.json().catch(() => null)) as any;
      const engineId = String(body?.engineId ?? "").slice(0, 100).trim();
      if (!engineId) return json({ error: "engineId required" }, 400);
      const restore = body?.restore === true;
      const v = restore
        ? await engineTokens.restore(engineId, owner)
        : await engineTokens.revoke(engineId, owner);
      if (v === "not-found") return json({ error: "not found" }, 404);
      log(restore ? "engines.restore" : "engines.revoke", { engineId, owner: owner ?? "local" });
      return json({ ok: true, engineId, revoked: !restore });
    }

    /* The enrolled-engine list: engineId, owner, identity fp, issue and
     * revocation times. Never hashes, never keys. HOSTED: the caller's own. */
    if (path === "/engines/enrolled" && req.method === "GET") {
      let owner: string | null = null;
      if (hosted) {
        const sub = await deps.sessionSub(req);
        if (!sub) return json({ error: "unauthorized" }, 401);
        owner = sub;
      }
      return json({ engines: engineTokens.list(owner) });
    }

    /* The engine's announce: an upsert of {engineId, host, user, url, rev, ts}.
     * The store keeps {engineId, owner, user, url, lastSeen}; lastSeen is the
     * server's own clock, not the engine's `ts` (a stale or lying clock must
     * not extend or collapse the lease). `user` is the engine's ENGINE_USER, the
     * unix account that owns the sessions; /config emits it beside `host` so the
     * app can build the handshake's `user@host` key exactly.
     *
     * ONE auth path in every mode now: the issued engine token. The body's
     * engineId must be the token's own (a token cannot speak for another
     * engine), and in HOSTED the lease's owner is the token's owner -- never a
     * body claim. LOCAL keeps the engine's `host` as the lease owner, which is
     * the display value /config always emitted there. */
    if (path === "/engines/announce" && req.method === "POST") {
      const eng = deps.engineAuth(req);
      if (!eng) return json({ error: "unauthorized" }, 401);

      const got = await readBodyCapped(req, ANNOUNCE_BODY_MAX_BYTES);
      if (!got.ok) return got.response;
      const raw = got.value;
      if (raw.byteLength === 0) return json({ error: "no body" }, 400);
      let body: any = null;
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { /* below */ }
      if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
      const engineId = String(body?.engineId ?? "").slice(0, 100).trim();
      const url = String(body?.url ?? "").slice(0, 1000).trim();
      if (!engineId || !url || !/^wss?:\/\//.test(url)) {
        return json({ error: "engineId and a ws url are required" }, 400);
      }
      if (engineId !== eng.engineId) {
        log("engines.announce.mismatch", { engineId, token: eng.engineId });
        return json({ error: "engine mismatch" }, 403);
      }
      const user = String(body?.user ?? "").slice(0, 100).trim();
      const owner = hosted
        ? eng.owner
        : String(body?.host ?? "").slice(0, 100).trim() || "?";
      const changed = await leases.announce({ engineId, owner, user, url });
      log("engines.announce", { engineId, owner, user, url, changed });
      return json({ ok: true, changed, leased: deps.engineLeaseMs });
    }

    /* TOKEN INTROSPECTION for the former standalone relay: the
     * relay holds no token store, so it trades the Bearer an engine presented
     * for the {engineId, owner} this store enrolled it under. A 256-bit
     * random token is its own proof of possession; this answers nothing to a
     * caller who does not already hold one. Enroll surface, not relaying. */
    if (path === "/engines/verify" && req.method === "POST") {
      const got = await readBodyCapped(req, 4 * 1024);
      if (!got.ok) return got.response;
      let body: any = null;
      try { body = JSON.parse(new TextDecoder().decode(got.value)); } catch { /* below */ }
      const rec = engineTokens.verify(typeof body?.token === "string" ? body.token : null);
      if (!rec) return json({ error: "unauthorized" }, 401);
      return json({ ok: true, engineId: rec.engineId, owner: rec.owner });
    }

    return null;
  };
}
