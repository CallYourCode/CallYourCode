/* HOW A REQUEST FINDS ITS OWNER.
 *
 * LOCAL: one store, opened by the composition root at the same paths as
 * always, handed to every owner-scoped route. No token is read; behaviour is
 * byte-identical to before this server learned the word "owner".
 *
 * HOSTED: no single store. Each Clerk `sub` gets its own, created on first use
 * under `<ownersDir>/<sub>/` and cached. The open is memoised on the PROMISE
 * so two requests racing to be an owner's first do not open the store twice.
 *
 * The singletons (the local store, the engine-token store, the owners dir) are
 * INJECTED by the root; nothing here reads the environment. */

import { join } from "node:path";
import { mkdirPrivate } from "../../../engine/shared/runfiles.ts";
import { OwnerStore } from "./owner-store";
import { tokenFromRequest } from "./auth";
import { safeSub, verifySession } from "./clerk-session";
import type { EngineTokens, EngineTokenRec } from "./enroll";
import type { LogFn } from "../platform/httpx";

export type OwnersDeps = {
  hosted: boolean;
  localStore: OwnerStore | null;   // LOCAL: the one store; HOSTED: null
  ownersDir: string;               // HOSTED: where per-sub stores live
  engineTokens: EngineTokens;
  log: LogFn;
};

export type Owners = {
  /** The store for a DEVICE request (the browser). LOCAL hands back the one
   *  store; HOSTED verifies the Clerk session and returns that owner's store,
   *  or null so the caller answers 401. Null is the only failure a route
   *  needs to know. */
  deviceOwner(req: Request): Promise<OwnerStore | null>;
  /** An ENGINE request (/engines/announce, /push/notify, /push/batch): the
   *  issued per-engine token's record, or nothing. The record names the owner
   *  the token was enrolled under, so a route never reads an owner off the
   *  body -- a modified engine cannot name its way into another owner's
   *  account. */
  engineAuth(req: Request): EngineTokenRec | null;
  /** The store an authenticated engine's push lands in. LOCAL: the one
   *  store; HOSTED: the token's owner's. */
  engineStore(eng: EngineTokenRec): Promise<OwnerStore> | OwnerStore | null;
  /** The Clerk `sub` a request's session resolves to, or null. LOCAL never
   *  calls this: there is no session to resolve. */
  sessionSub(req: Request): Promise<string | null>;
  /** One owner's store by sub, created on first use (HOSTED). */
  ownerStore(sub: string): Promise<OwnerStore>;
  /** The VAPID public key the page subscribes against, served on the public
   *  /push/key with no owner in hand. LOCAL: the single store's key. HOSTED:
   *  the pinned VAPID_PUBLIC_KEY, which is the whole server's push identity
   *  and must be set so every owner subscribes against the same pair. */
  vapidPublicKey(): string;
  /** How many owner stores exist (HOSTED health line). */
  ownerCount(): number;
  readonly localStore: OwnerStore | null;
};

export function makeOwners(deps: OwnersDeps): Owners {
  const { hosted, localStore, ownersDir, engineTokens, log } = deps;
  const ownerStores = new Map<string, Promise<OwnerStore>>();

  function ownerStore(sub: string): Promise<OwnerStore> {
    let s = ownerStores.get(sub);
    if (!s) {
      s = (async () => {
        const dir = join(ownersDir, sub);
        await mkdirPrivate(dir);
        return OwnerStore.open(join(dir, "push-subs.json"),
          join(dir, "app-settings.json"), join(dir, "reports"), log);
      })();
      ownerStores.set(sub, s);
    }
    return s;
  }

  async function deviceOwner(req: Request): Promise<OwnerStore | null> {
    if (!hosted) return localStore;
    const token = tokenFromRequest(req);
    if (!token) return null;
    const sub = await verifySession(token);
    if (!sub || !safeSub(sub)) return null;
    return ownerStore(sub);
  }

  const engineAuth = (req: Request): EngineTokenRec | null =>
    engineTokens.verify(tokenFromRequest(req));

  const engineStore = (eng: EngineTokenRec): Promise<OwnerStore> | OwnerStore | null =>
    hosted ? ownerStore(eng.owner) : localStore;

  async function sessionSub(req: Request): Promise<string | null> {
    const token = tokenFromRequest(req);
    if (!token) return null;
    const sub = await verifySession(token);
    return sub && safeSub(sub) ? sub : null;
  }

  const vapidPublicKey = () =>
    localStore ? localStore.push.publicKey : (process.env.VAPID_PUBLIC_KEY ?? "");

  return { deviceOwner, engineAuth, engineStore, sessionSub, ownerStore,
    vapidPublicKey, ownerCount: () => ownerStores.size, localStore };
}
