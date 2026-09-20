/* The global defaults (see AppSettings in owner-store.ts). GET is what every
 * page reads on boot and re-reads to converge; POST is a partial update, so a
 * client that only knows about `speed` cannot reset the keys it has never
 * heard of. Unknown keys are ignored rather than stored: this file is a
 * contract, not a junk drawer. */

import { json, type LogFn } from "../platform/httpx";
import { chordMap, cleanStrings, sidList, type OwnerStore } from "../access/owner-store";
import type { Owners } from "../access/owners";

export type SettingsDeps = {
  hosted: boolean;
  owners: Pick<Owners, "deviceOwner" | "engineAuth" | "ownerStore">;
  log: LogFn;
};

export function makeSettingsRoutes(deps: SettingsDeps) {
  return async (req: Request, path: string): Promise<Response | null> => {
    if (path !== "/settings") return null;

    if (req.method === "GET") {
      /* A device's session, or an ENGINE's issued token: the engine polls the
       * two dials it answers at (replyLevel/complexity), and in HOSTED it has
       * no Clerk session -- its token names the owner whose globals it reads.
       * Read-only: POST below stays device-only. */
      let store: OwnerStore | null = await deps.owners.deviceOwner(req);
      if (!store && deps.hosted) {
        const eng = deps.owners.engineAuth(req);
        if (eng) store = await deps.owners.ownerStore(eng.owner);
      }
      if (!store) return json({ error: "unauthorized" }, 401);
      return json({ ...store.settings, seq: store.settingsSeq });
    }

    if (req.method === "POST") {
      const store = await deps.owners.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      const appSettings = store.settings;
      const body = (await req.json().catch(() => null)) as any;
      if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
      let changed = false;
      if (typeof body.speed === "number" && body.speed >= 0.5 && body.speed <= 4) {
        changed = changed || appSettings.speed !== body.speed;
        appSettings.speed = body.speed;
      }
      for (const k of ["notify", "sound", "activity", "verbosityOn", "complexityOn", "promptBitsOn", "geom"] as const) {
        if (typeof body[k] === "boolean") {
          changed = changed || appSettings[k] !== body[k];
          appSettings[k] = body[k];
        }
      }
      // The two dials: 1..5 on both scales, whole numbers, nothing else stored.
      for (const k of ["replyLevel", "complexity"] as const) {
        if (Number.isInteger(body[k]) && body[k] >= 1 && body[k] <= 5) {
          changed = changed || appSettings[k] !== body[k];
          appSettings[k] = body[k];
        }
      }
      /* The keymap, REPLACED WHOLE. A binding put back on its default is the
       * key being absent, so merging key-by-key like everything above would
       * make unbinding impossible to express. Compared by value because it is
       * an object: absent -> `{}` is a real change (the first device says "I
       * have none"), and it has to bump `seq` or the other devices will not
       * come and look. */
      const km = chordMap(body.keymap);
      if (km) {
        changed = changed || JSON.stringify(appSettings.keymap) !== JSON.stringify(km);
        appSettings.keymap = km;
      }
      // The wording overrides (#362), replaced whole and stored verbatim so the
      // page's holds() round-trip matches. Absent leaves what is here; a present
      // bag (even {}) is the answer.
      const st = cleanStrings(body.strings);
      if (st) {
        changed = changed || JSON.stringify(appSettings.strings) !== JSON.stringify(st);
        appSettings.strings = st;
      }
      // The merged order, replaced whole for the same reason as the keymap: a
      // row put back to its default position is its id moving, not vanishing.
      const mo = sidList(body.mergedOrder);
      if (mo) {
        changed = changed || JSON.stringify(appSettings.mergedOrder) !== JSON.stringify(mo);
        appSettings.mergedOrder = mo;
      }
      // The dismissed dormant chats (task 501), replaced whole like mergedOrder:
      // restoring a chat is its id leaving the list, which a merge could not say.
      const dm = sidList(body.dismissed);
      if (dm) {
        changed = changed || JSON.stringify(appSettings.dismissed) !== JSON.stringify(dm);
        appSettings.dismissed = dm;
      }
      if (changed) {
        store.settingsSeq++;
        await store.saveSettings();
        deps.log("settings.set", { ...appSettings, seq: store.settingsSeq });
      }
      return json({ ...appSettings, seq: store.settingsSeq });
    }

    return null;
  };
}
