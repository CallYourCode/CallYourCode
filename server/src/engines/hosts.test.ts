/* The engine lease list (discovery): the engine reaches OUT, this store just
 * remembers who announced and drops anyone past the lease. Replaces the old
 * poller verdict test in place: same file, new subject, no coverage lost.
 *
 *   bun test app-server/hosts.test.ts
 */

import { test, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineLeases, LEASE_DEFAULT_MS } from "./hosts";

let dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cyc-leases-"));
  dirs.push(d);
  return d;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

test("announce upserts by engineId: one entry per id, lastSeen moves", async () => {
  const dir = await tmp();
  const leases = await EngineLeases.open(join(dir, "leases.json"));

  await leases.announce({ engineId: "e-a", owner: "mac", user: "example", url: "ws://mac:10101/ws" });
  const first = await leases.list();
  expect(first.length).toBe(1);
  expect(first[0].owner).toBe("mac");
  expect(first[0].user).toBe("example");
  expect(first[0].url).toBe("ws://mac:10101/ws");
  const at1 = first[0].lastSeen;

  // a heartbeat for the same id updates lastSeen and does not add a second row
  await Bun.sleep(5);
  await leases.announce({ engineId: "e-a", owner: "mac", user: "example", url: "ws://mac:10101/ws" });
  const again = await leases.list();
  expect(again.length).toBe(1);
  expect(again[0].engineId).toBe("e-a");
  expect(again[0].lastSeen).toBeGreaterThan(at1);

  // a second engine is a second row
  await leases.announce({ engineId: "e-b", owner: "k8", user: "root", url: "ws://k8:10101/ws" });
  const both = await leases.list();
  expect(both.map((e) => e.engineId).sort()).toEqual(["e-a", "e-b"]);
});

test("an entry past the lease drops from the list and from disk", async () => {
  const dir = await tmp();
  const file = join(dir, "leases.json");
  const leases = await EngineLeases.open(file, 1000);

  await leases.announce({ engineId: "e-a", owner: "mac", user: "example", url: "ws://mac:10101/ws" });
  const [entry] = await leases.list();
  expect(entry).toBeDefined();

  // just inside the lease still lives
  expect((await leases.list(entry.lastSeen + 999)).length).toBe(1);

  // past it: dropped from the list AND written out of the store
  expect((await leases.list(entry.lastSeen + 1001)).length).toBe(0);

  const reopened = await EngineLeases.open(file, 1000);
  expect((await reopened.list()).length).toBe(0);
});

test("urls: announced urls only, deduped, in list order (announce-only, no seed)", async () => {
  const dir = await tmp();
  const leases = await EngineLeases.open(join(dir, "leases.json"));

  // with nothing announced there is nothing to list: no static seed survives
  expect(leases.urls([])).toEqual([]);

  await leases.announce({ engineId: "e-1", owner: "a", user: "u1", url: "ws://one:10101/ws" });
  await leases.announce({ engineId: "e-2", owner: "b", user: "u2", url: "ws://two:10101/ws" });
  const live = await leases.list();

  expect(leases.urls(live)).toEqual([
    "ws://one:10101/ws",
    "ws://two:10101/ws",
  ]);
});

test("configEngines: announce-only, one object per leased engine, no seed strings", async () => {
  const dir = await tmp();
  const leases = await EngineLeases.open(join(dir, "leases.json"));

  // with no announced engine the list is EMPTY, not a seed default
  expect(leases.configEngines([])).toEqual([]);

  await leases.announce({ engineId: "e-1", owner: "a", user: "u1", url: "ws://one:10101/ws" });
  await leases.announce({ engineId: "e-2", owner: "b", user: "u2", url: "ws://two:10101/ws" });
  const live = await leases.list();

  expect(leases.configEngines(live)).toEqual([
    { url: "ws://one:10101/ws", engineId: "e-1", host: "a", user: "u1" },
    { url: "ws://two:10101/ws", engineId: "e-2", host: "b", user: "u2" },
  ]);
});

test("configEngines omits host and user when the lease stored none", async () => {
  const dir = await tmp();
  const leases = await EngineLeases.open(join(dir, "leases.json"));

  await leases.announce({ engineId: "e-1", owner: "", user: "", url: "ws://new:10101/ws" });
  const live = await leases.list();

  expect(leases.configEngines(live)).toEqual([
    { url: "ws://new:10101/ws", engineId: "e-1" },
  ]);
});

test("/hosts payload keeps the app's shape and derives up from leased", async () => {
  const dir = await tmp();
  const leases = await EngineLeases.open(join(dir, "leases.json"), 1000);

  // announce-only: with nothing announced the payload is EMPTY, no seed default
  const empty = leases.hostsPayload([]);
  expect(empty).toEqual({ seq: 0, hosts: [] });

  // an announced url is leased by construction: up true, no downSince
  await leases.announce({ engineId: "e-a", owner: "mac", user: "example", url: "ws://mac:10101/ws" });
  const live = await leases.list();
  const p = leases.hostsPayload(live);
  expect(p.seq).toBe(0);
  expect(p.hosts).toEqual([
    { url: "ws://mac:10101/ws", up: true },
  ]);
});

test("lease default is six hours", () => {
  expect(LEASE_DEFAULT_MS).toBe(6 * 60 * 60 * 1000);
});
