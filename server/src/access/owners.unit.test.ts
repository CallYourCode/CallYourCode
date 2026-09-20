/* owners.ts as a unit: how a request resolves to an owner store in each mode.
 * The Clerk verification itself is auth.ts's (and hosted.test.ts's) problem;
 * here the seams around it are proved: no token means no owner in HOSTED,
 * LOCAL never reads one, engine tokens resolve through the injected store,
 * and per-sub stores are created once and cached. */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeOwners } from "./owners";
import { OwnerStore } from "./owner-store";
import { EngineTokens } from "./enroll";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});
const scratch = async () => {
  const d = await mkdtemp(join(tmpdir(), "cyc-owners-unit-"));
  dirs.push(d);
  return d;
};
const silent = () => {};

async function rig(hosted: boolean) {
  const d = await scratch();
  const engineTokens = await EngineTokens.open(join(d, "tokens.json"));
  const localStore = hosted ? null :
    await OwnerStore.open(join(d, "push.json"), join(d, "settings.json"),
      join(d, "reports"), silent);
  const owners = makeOwners({ hosted, localStore,
    ownersDir: join(d, "owners"), engineTokens, log: silent });
  return { d, engineTokens, localStore, owners };
}

test("LOCAL: every device request gets THE store, token or not", async () => {
  const { owners, localStore } = await rig(false);
  expect(await owners.deviceOwner(new Request("http://x/settings"))).toBe(localStore);
  const with_token = new Request("http://x/settings",
    { headers: { authorization: "Bearer whatever" } });
  expect(await owners.deviceOwner(with_token)).toBe(localStore);
});

test("HOSTED: a device request with no credential resolves to nobody", async () => {
  const { owners } = await rig(true);
  expect(await owners.deviceOwner(new Request("http://x/settings"))).toBeNull();
});

test("engineAuth: an issued bearer resolves to its record, garbage to null", async () => {
  const { owners, engineTokens } = await rig(false);
  const r = await engineTokens.enroll({ engineId: "e-1", spki: "spki-a", owner: "local" });
  if (!r.ok) throw new Error("enroll refused");
  const req = (auth?: string) => new Request("http://x/push/notify",
    auth ? { headers: { authorization: auth } } : {});
  expect(owners.engineAuth(req(`Bearer ${r.token}`))?.engineId).toBe("e-1");
  expect(owners.engineAuth(req("Bearer cyt_wrong"))).toBeNull();
  expect(owners.engineAuth(req())).toBeNull();
});

test("engineStore: LOCAL lands in the one store; HOSTED in the token owner's", async () => {
  const local = await rig(false);
  const rec = { engineId: "e", owner: "user_a" } as any;
  expect(local.owners.engineStore(rec)).toBe(local.localStore);

  const hosted = await rig(true);
  const store = await hosted.owners.engineStore(rec);
  expect(store).not.toBeNull();
  // the store was created under <ownersDir>/<sub>/, private
  const dir = join(hosted.d, "owners", "user_a");
  expect(((await stat(dir)).mode & 0o777)).toBe(0o700);
});

test("ownerStore is memoised: two calls for one sub share one store", async () => {
  const { owners } = await rig(true);
  const [a, b] = await Promise.all([owners.ownerStore("user_x"), owners.ownerStore("user_x")]);
  expect(a).toBe(b);
  expect(owners.ownerCount()).toBe(1);
  await owners.ownerStore("user_y");
  expect(owners.ownerCount()).toBe(2);
});

test("vapidPublicKey: the single store's key in LOCAL, the pinned env pair in HOSTED", async () => {
  const local = await rig(false);
  expect(local.owners.vapidPublicKey()).toBe(local.localStore!.push.publicKey);
  expect(local.owners.vapidPublicKey().length).toBeGreaterThan(0);

  const hosted = await rig(true);
  const prev = process.env.VAPID_PUBLIC_KEY;
  process.env.VAPID_PUBLIC_KEY = "pinned-key";
  try {
    expect(hosted.owners.vapidPublicKey()).toBe("pinned-key");
  } finally {
    if (prev === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = prev;
  }
});
