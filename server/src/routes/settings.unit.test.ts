/* routes/settings.ts as a unit: the partial-update contract, the
 * replaced-whole objects, the seq discipline, and the dual-auth GET (device
 * session OR engine token) that the engines' dial polling depends on. */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSettingsRoutes } from "./settings";
import { OwnerStore } from "../access/owner-store";
import type { EngineTokenRec } from "../access/enroll";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});
const silent = () => {};

async function freshStore() {
  const d = await mkdtemp(join(tmpdir(), "cyc-setroutes-unit-"));
  dirs.push(d);
  return OwnerStore.open(join(d, "push.json"), join(d, "settings.json"),
    join(d, "reports"), silent);
}

const get = () => new Request("http://x/settings");
const post = (body: unknown) => new Request("http://x/settings",
  { method: "POST", body: JSON.stringify(body) });

test("GET without any credential is a 401 in HOSTED", async () => {
  const routes = makeSettingsRoutes({ hosted: true, log: silent, owners: {
    deviceOwner: async () => null,
    engineAuth: () => null,
    ownerStore: async () => { throw new Error("must not be reached"); },
  }});
  expect((await routes(get(), "/settings"))!.status).toBe(401);
});

test("GET with an ENGINE token reads the token owner's globals (dual auth)", async () => {
  const store = await freshStore();
  store.settings.replyLevel = 5;
  const eng = { engineId: "e-1", owner: "user_a" } as EngineTokenRec;
  const asked: string[] = [];
  const routes = makeSettingsRoutes({ hosted: true, log: silent, owners: {
    deviceOwner: async () => null,          // no Clerk session on an engine
    engineAuth: () => eng,
    ownerStore: async (sub: string) => { asked.push(sub); return store; },
  }});
  const r = (await routes(get(), "/settings"))!;
  expect(r.status).toBe(200);
  expect((await r.json()).replyLevel).toBe(5);
  expect(asked).toEqual(["user_a"]);      // the token names the owner, not the body
});

test("POST stays device-only: an engine token cannot write", async () => {
  const eng = { engineId: "e-1", owner: "user_a" } as EngineTokenRec;
  const routes = makeSettingsRoutes({ hosted: true, log: silent, owners: {
    deviceOwner: async () => null,
    engineAuth: () => eng,
    ownerStore: async () => { throw new Error("must not be reached"); },
  }});
  expect((await routes(post({ speed: 2 }), "/settings"))!.status).toBe(401);
});

async function localRoutes() {
  const store = await freshStore();
  const routes = makeSettingsRoutes({ hosted: false, log: silent, owners: {
    deviceOwner: async () => store,
    engineAuth: () => null,
    ownerStore: async () => store,
  }});
  return { store, routes };
}

test("POST is a partial update: unknown and out-of-range keys change nothing", async () => {
  const { store, routes } = await localRoutes();
  const r = (await routes(post({ speed: 2, junk: true, replyLevel: 9 }), "/settings"))!;
  const j = await r.json();
  expect(j.speed).toBe(2);
  expect(j.junk).toBeUndefined();
  expect(j.replyLevel).toBeUndefined();   // 9 is off the scale: not stored
  expect(j.seq).toBe(1);
  expect(store.settings.notify).toBe(true);  // keys the client never named stand
});

test("seq bumps once per real change and holds still on a no-op", async () => {
  const { routes } = await localRoutes();
  await routes(post({ sound: false }), "/settings");
  const again = (await routes(post({ sound: false }), "/settings"))!;
  expect((await again.json()).seq).toBe(1);   // same value: no new seq
  const third = (await routes(post({ sound: true }), "/settings"))!;
  expect((await third.json()).seq).toBe(2);
});

test("the keymap is replaced WHOLE, and {} is a real change from absent", async () => {
  const { store, routes } = await localRoutes();
  await routes(post({ keymap: { send: "ctrl+enter", stop: "esc" } }), "/settings");
  expect(store.settings.keymap).toEqual({ send: "ctrl+enter", stop: "esc" });
  // dropping a binding = the key being gone from the next whole map
  await routes(post({ keymap: { send: "ctrl+enter" } }), "/settings");
  expect(store.settings.keymap).toEqual({ send: "ctrl+enter" });
  // {} says "I have none" and still bumps seq so other devices come look
  const r = (await routes(post({ keymap: {} }), "/settings"))!;
  expect(store.settings.keymap).toEqual({});
  expect((await r.json()).seq).toBe(3);
  // a malformed map is refused whole, not half-taken
  await routes(post({ keymap: { a: 1 } }), "/settings");
  expect(store.settings.keymap).toEqual({});
});

test("mergedOrder and dismissed are replaced whole; [] restores everything", async () => {
  const { store, routes } = await localRoutes();
  await routes(post({ mergedOrder: ["b", "a"], dismissed: ["h:1"] }), "/settings");
  expect(store.settings.mergedOrder).toEqual(["b", "a"]);
  expect(store.settings.dismissed).toEqual(["h:1"]);
  await routes(post({ dismissed: [] }), "/settings");
  expect(store.settings.dismissed).toEqual([]);
  expect(store.settings.mergedOrder).toEqual(["b", "a"]);  // untouched
});

test("a bad body is a 400, and non-settings paths fall through", async () => {
  const { routes } = await localRoutes();
  const bad = new Request("http://x/settings", { method: "POST", body: "not json" });
  expect((await routes(bad, "/settings"))!.status).toBe(400);
  expect(await routes(get(), "/config")).toBeNull();
});
