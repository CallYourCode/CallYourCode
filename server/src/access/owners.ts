/* One local store. Clerk setup is intentionally not imported by runtime. */
import type { OwnerStore } from './owner-store';
import { tokenFromRequest } from './auth';
import type { EngineTokens, EngineTokenRec } from './enroll';
export type OwnersDeps = {localStore: OwnerStore; engineTokens: EngineTokens};
export type Owners = {
  deviceOwner(req: Request): Promise<OwnerStore | null>;
  engineAuth(req: Request): EngineTokenRec | null;
  engineStore(eng: EngineTokenRec): OwnerStore;
  vapidPublicKey(): string;
  readonly localStore: OwnerStore;
};
export function makeOwners({localStore, engineTokens}: OwnersDeps): Owners {
  return {
    deviceOwner: async () => localStore,
    engineAuth: (req) => engineTokens.verify(tokenFromRequest(req)),
    engineStore: () => localStore,
    vapidPublicKey: () => localStore.push.publicKey,
    localStore,
  };
}
