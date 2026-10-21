import { json, type LogFn } from "../platform/httpx";
import { readBodyCapped } from "../../../engine/shared/bodyread.ts";
import { ENROLL_SKEW_MS, verifyEnrollSig } from "../../../engine/shared/enroll-wire.ts";
import { ANNOUNCE_BODY_MAX_BYTES, ENROLL_BODY_MAX_BYTES } from "../platform/caps";
import type { EngineTokens, EngineTokenRec } from "../access/enroll";
import type { EngineLeases } from "../engines/hosts";

export type EnginesDeps = {
  engineTokens: EngineTokens;
  leases: EngineLeases;
  engineLeaseMs: number;
  engineAuth: (req: Request) => EngineTokenRec | null;
  log: LogFn;
};

export function makeEngineRoutes(deps: EnginesDeps) {
  const { engineTokens, leases, log } = deps;

  return async (req: Request, path: string): Promise<Response | null> => {

    if (path === "/engines" && req.method === "GET") {
      const live = await leases.list();

      return json({ engines: live });
    }

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

      if (Math.abs(Date.now() - ts) > ENROLL_SKEW_MS) {
        return json({ error: "stale ts" }, 400);
      }
      if (!(await verifyEnrollSig(engineId, pubkey, ts, sig))) {
        log("engines.enroll.badsig", { engineId });
        return json({ error: "bad signature" }, 401);
      }
      const owner = "local";

      const r = await engineTokens.enroll({ engineId, spki: pubkey });
      if (!r.ok) {
        log("engines.enroll.refused", { engineId, owner, why: r.error });
        return json({ error: r.error }, r.status);
      }
      log("engines.enroll", { engineId, owner, rotated: r.rotated });
      return json({ ok: true, token: r.token, engineId, owner });
    }

    if (path === "/engines/revoke" && req.method === "POST") {

      const body = (await req.json().catch(() => null)) as any;
      const engineId = String(body?.engineId ?? "").slice(0, 100).trim();
      if (!engineId) return json({ error: "engineId required" }, 400);
      const restore = body?.restore === true;
      const v = restore
        ? await engineTokens.restore(engineId)
        : await engineTokens.revoke(engineId);
      if (v === "not-found") return json({ error: "not found" }, 404);
      log(restore ? "engines.restore" : "engines.revoke", { engineId, owner: "local" });
      return json({ ok: true, engineId, revoked: !restore });
    }

    if (path === "/engines/enrolled" && req.method === "GET") {

      return json({ engines: engineTokens.list() });
    }

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
      const owner = String(body?.host ?? "").slice(0, 100).trim() || "?";
      const changed = await leases.announce({ engineId, owner, user, url });
      log("engines.announce", { engineId, owner, user, url, changed });
      return json({ ok: true, changed, leased: deps.engineLeaseMs });
    }

    return null;
  };
}
