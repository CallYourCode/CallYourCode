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

async function rig() {
  const d = await scratch();
  const engineTokens = await EngineTokens.open(join(d, "tokens.json"));
  const localStore =
    await OwnerStore.open(join(d, "push.json"), join(d, "settings.json"),
      join(d, "reports"), silent);
  const owners = makeOwners({localStore, engineTokens});
  return { d, engineTokens, localStore, owners };
}

test("LOCAL: every device request gets THE store, token or not", async () => {
  const { owners, localStore } = await rig();
  expect(await owners.deviceOwner(new Request("http://x/settings"))).toBe(localStore);
  const with_token = new Request("http://x/settings",
    { headers: { authorization: "Bearer whatever" } });
  expect(await owners.deviceOwner(with_token)).toBe(localStore);
});

test("engineAuth: an issued bearer resolves to its record, garbage to null", async () => {
  const { owners, engineTokens } = await rig();
  const r = await engineTokens.enroll({ engineId: "e-1", spki: "spki-a"});
  if (!r.ok) throw new Error("enroll refused");
  const req = (auth?: string) => new Request("http://x/push/notify",
    auth ? { headers: { authorization: auth } } : {});
  expect(owners.engineAuth(req(`Bearer ${r.token}`))?.engineId).toBe("e-1");
  expect(owners.engineAuth(req("Bearer cyt_wrong"))).toBeNull();
  expect(owners.engineAuth(req())).toBeNull();
});
