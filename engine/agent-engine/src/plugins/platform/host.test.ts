/* THE MINIMAL PLUGIN HOST: scoping, atomicity, agentIds; deliver's three
 * answers (no session retriable, guardCwd fatal, happy path) over a fake
 * deliverText. No engine boot, no clocks, no network.
 *
 * The host is the only thing between a plugin and the data dir, so the file
 * modes and the key charset are load bearing: a plugin id or a store key is the
 * one string here that did not come from the engine's own minting, and a 0644
 * store record is a secret sitting in the clear.
 *
 *   bun test agent-engine/src/plugins/platform/host.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makePluginHost, makePluginStore, type HostWiring } from "./host.ts";
import { tmpDir } from "../../test-utils/tmp.ts";

/* CYC_DATA_DIR is set ONCE, at file scope, and restored in afterAll. The path
 * helpers read it lazily on every call, so flipping it mid-file would move a
 * store out from under a host that had already cached its dir. Tests that write
 * take their own subdirectory of `base` instead. */
let base = "";
const oldEnv = process.env.CYC_DATA_DIR;

beforeAll(async () => {
  base = await tmpDir("cyc-host-");
  process.env.CYC_DATA_DIR = base;
});
afterAll(() => {
  if (oldEnv === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = oldEnv;
});

const wiringNone: HostWiring = {
  sessionFor: () => null,
  deliverText: async () => ({ ok: true }),
};

/** A store over a directory nobody else in this file touches. */
const storeIn = (name: string) => makePluginStore(join(base, "stores", name));

describe("PluginStore", () => {
  test("round-trips a record and lists its key", async () => {
    const st = storeIn("roundtrip");
    await st.put("cfg", { a: 1 });
    expect(await st.get("cfg")).toEqual({ a: 1 });
    expect(await st.list()).toEqual(["cfg"]);
    await st.del("cfg");
    expect(await st.get("cfg")).toBeNull();
    expect(await st.list()).toEqual([]);
  });

  test("get answers null for missing and for unreadable JSON", async () => {
    const st = storeIn("unreadable");
    expect(await st.get("nothing")).toBeNull();
    await st.ensure();
    await writeFile(join(st.dir, "bad.json"), "{not json");
    // half a JSON record is a fact to survive (a crash mid-write on a full
    // disk), not a reason to take the engine down
    expect(await st.get("bad")).toBeNull();
  });

  test("list answers empty for a store dir that was never created", async () => {
    expect(await storeIn("never-made").list()).toEqual([]);
  });

  test("put is atomic: no tmp litter, file is 0600, dir 0700", async () => {
    const st = storeIn("modes");
    await st.put("k", [1, 2, 3]);
    const names = await readdir(st.dir);
    expect(names).toEqual(["k.json"]);
    const f = await stat(join(st.dir, "k.json"));
    expect(f.mode & 0o777).toBe(0o600);
    const d = await stat(st.dir);
    expect(d.mode & 0o777).toBe(0o700);
  });

  test("put replaces in place and keeps the mode across the rename", async () => {
    const st = storeIn("replace");
    await st.put("k", { v: 1 });
    await st.put("k", { v: 2 });
    expect(await st.get("k")).toEqual({ v: 2 });
    expect(await readdir(st.dir)).toEqual(["k.json"]); // the tmp name never survives
    expect((await stat(join(st.dir, "k.json"))).mode & 0o777).toBe(0o600);
  });

  test("concurrent puts of the same key leave one whole record, never a spliced one", async () => {
    /* The tmp name carries randomness for exactly this: two writers renaming
     * over each other must end with one of the two values, never half of each. */
    const st = storeIn("concurrent");
    await Promise.all([st.put("k", { who: "a" }), st.put("k", { who: "b" }), st.put("k", { who: "c" })]);
    expect(["a", "b", "c"]).toContain((await st.get("k") as { who: string }).who);
    expect(await readdir(st.dir)).toEqual(["k.json"]);
  });

  test("del of a key that was never written is a no-op", async () => {
    const st = storeIn("del-missing");
    await st.ensure();
    await st.del("ghost"); // must not throw
    expect(await st.list()).toEqual([]);
  });

  test("ensure is idempotent and makes the dir private", async () => {
    const st = storeIn("ensure-twice");
    await st.ensure();
    await st.ensure();
    expect((await stat(st.dir)).mode & 0o777).toBe(0o700);
  });

  test("list reports only well-named .json records, sorted", async () => {
    const st = storeIn("listing");
    await st.ensure();
    await st.put("b", 1);
    await st.put("a", 1);
    await st.put("a.b-c_d", 1);
    // things a plugin owning its own file format leaves beside them
    await writeFile(join(st.dir, "schedules.lock"), "");
    await writeFile(join(st.dir, "notes.txt"), "");
    await mkdir(join(st.dir, "sub"), { recursive: true });
    expect(await st.list()).toEqual(["a", "a.b-c_d", "b"]);
  });

  test("accepts the whole documented key charset", async () => {
    const st = storeIn("charset");
    for (const ok of ["a", "A9", "with_underscore", "with-dash", "with.dot", "x".repeat(128)]) {
      await st.put(ok, ok);
      expect(await st.get(ok)).toBe(ok);
    }
  });

  test("refuses keys that could escape the dir", async () => {
    const st = storeIn("escape");
    for (const bad of ["../x", "a/b", "", ".hidden", "x".repeat(200), "a\0b", "a..b", "/abs"]) {
      await expect(st.put(bad, 1)).rejects.toThrow(/not a store key/);
    }
    // and the refusal is on the READ side too, so a poisoned key cannot be used
    // to slurp a file from outside the store either
    await expect(st.get("../../keys")).rejects.toThrow(/not a store key/);
    await expect(st.del("../../keys")).rejects.toThrow(/not a store key/);
  });
});

describe("PluginHost scoping", () => {
  test("engine store and agent store live under the two-axis paths", () => {
    const host = makePluginHost("crons", wiringNone);
    expect(host.store().dir).toBe(join(base, "plugins", "crons"));
    expect(host.agentStore("ag-abc").dir).toBe(join(base, "agents", "ag-abc", "plugins", "crons"));
  });

  test("the two axes are independent: same plugin, two agents, plus the engine scope", () => {
    const host = makePluginHost("crons", wiringNone);
    const dirs = [host.store().dir, host.agentStore("ag-a").dir, host.agentStore("ag-b").dir];
    expect(new Set(dirs).size).toBe(3);
    // agent data never lands under the engine-scoped plugin dir, whatever the
    // plugin's install scope is
    expect(host.agentStore("ag-a").dir.startsWith(host.store().dir)).toBe(false);
  });

  test("stores are cached per scope (stable identity)", () => {
    const host = makePluginHost("crons", wiringNone);
    expect(host.store()).toBe(host.store());
    expect(host.agentStore("ag-a")).toBe(host.agentStore("ag-a"));
    expect(host.agentStore("ag-a")).not.toBe(host.agentStore("ag-b"));
  });

  test("refuses a bad plugin id or agent id", () => {
    for (const bad of ["../etc", "Crons", "cron s", "", "a/b", "x".repeat(65), "crons."]) {
      expect(() => makePluginHost(bad, wiringNone)).toThrow(/not a plugin id/);
    }
    const host = makePluginHost("ok", wiringNone);
    for (const bad of ["not-an-agent/../id", "ag-", "abc", "ag-x/y", "../ag-x"]) {
      expect(() => host.agentStore(bad)).toThrow(/not an agent id/);
    }
  });

  test("agentIds reads the scopes that exist, agent-shaped names only", async () => {
    const host = makePluginHost("crons", wiringNone);
    expect(await host.agentIds()).toEqual([]); // agents/ does not exist yet
    const mk = async (n: string) => { await mkdir(join(base, "agents", n), { recursive: true }); };
    await mk("ag-one");
    await mk("ag-two");
    await mk("junk-dir");
    await mk("..");            // resolves to agents/'s parent; must never be listed
    await writeFile(join(base, "agents", "ag-notadir"), "");
    // a readdir, filtered by the one id shape, sorted so callers can diff two reads
    expect(await host.agentIds()).toEqual(["ag-notadir", "ag-one", "ag-two"]);
  });
});

describe("PluginHost deliver", () => {
  test("no live session is retriable", async () => {
    const host = makePluginHost("crons", wiringNone);
    const r = await host.deliver("ag-x", { text: "hi" });
    expect(r.ok).toBe(false);
    expect(r.retriable).toBe(true);
    expect(r.why).toContain("no live session");
  });

  test("guardCwd mismatch is fatal, resolved on both sides", async () => {
    const calls: unknown[] = [];
    const host = makePluginHost("crons", {
      sessionFor: () => ({ cwd: "/proj/b/" }),
      deliverText: async (aid, m) => {
        calls.push([aid, m]);
        return { ok: true };
      },
      realPathOf: async (p) => p.replace(/\/+$/, ""), // fake resolver: strip trailing slash
    });
    const r = await host.deliver("ag-x", { text: "hi", guardCwd: "/proj/a" });
    expect(r.ok).toBe(false);
    expect(r.retriable).toBeUndefined();
    expect(r.why).toContain("different conversation");
    // the refusal names both directories, so the log says WHICH move broke it
    expect(r.why).toContain("/proj/b/");
    expect(r.why).toContain("/proj/a");
    expect(calls.length).toBe(0);
    // two spellings of one directory ARE the same place
    const ok = await host.deliver("ag-x", { text: "hi", guardCwd: "/proj/b/" });
    expect(ok.ok).toBe(true);
    expect(calls.length).toBe(1);
  });

  test("the default resolver follows a symlink, so an aliased cwd still passes", async () => {
    /* With no realPathOf injected the host uses realpath(). A worktree reached
     * through a symlinked parent is the SAME conversation, and refusing it would
     * silently drop every scheduled message on such a checkout. */
    const root = await tmpDir("cyc-guard-");
    const real = join(root, "real");
    const alias = join(root, "alias");
    await mkdir(real, { recursive: true });
    await symlink(real, alias);
    let delivered = 0;
    const host = makePluginHost("crons", {
      sessionFor: () => ({ cwd: real }),
      deliverText: async () => { delivered++; return { ok: true }; },
    });
    expect((await host.deliver("ag-x", { text: "hi", guardCwd: alias })).ok).toBe(true);
    expect(delivered).toBe(1);
  });

  test("the default resolver fails the guard CLOSED on a path that does not resolve", async () => {
    /* realpath throws for a deleted directory; the host answers with the path
     * itself, which cannot equal the live cwd, so the message is refused rather
     * than delivered into whatever the pane became. */
    const root = await tmpDir("cyc-guard-");
    let delivered = 0;
    const host = makePluginHost("crons", {
      sessionFor: () => ({ cwd: root }),
      deliverText: async () => { delivered++; return { ok: true }; },
    });
    const gone = join(root, "deleted-out-from-under-us");
    const r = await host.deliver("ag-x", { text: "hi", guardCwd: gone });
    expect(r.ok).toBe(false);
    expect(delivered).toBe(0);
  });

  test("no guardCwd, or a session with no cwd, skips the identity check", async () => {
    let delivered = 0;
    const host = makePluginHost("crons", {
      sessionFor: () => ({}), // a live session the engine has no cwd for
      deliverText: async () => { delivered++; return { ok: true }; },
      realPathOf: async () => { throw new Error("the guard must not have run"); },
    });
    expect((await host.deliver("ag-x", { text: "a" })).ok).toBe(true);
    expect((await host.deliver("ag-x", { text: "b", guardCwd: "/anything" })).ok).toBe(true);
    expect(delivered).toBe(2);
  });

  test("happy path forwards how/note/text; how defaults to the id uppercased", async () => {
    const got: Array<{ how: string; note?: string; text: string }> = [];
    const host = makePluginHost("crons", {
      sessionFor: () => ({ cwd: "/p" }),
      deliverText: async (_aid, m) => {
        got.push(m);
        return { ok: true };
      },
    });
    const r = await host.deliver("ag-x", { text: "do it", note: "n1", how: "SCHEDULED" });
    expect(r).toEqual({ ok: true, why: undefined, retriable: undefined });
    expect(got.at(-1)).toEqual({ how: "SCHEDULED", note: "n1", text: "do it" });
    await host.deliver("ag-x", { text: "plain" });
    expect(got.at(-1)!.how).toBe("CRONS");
  });

  test("deliver carries the agent id through to the delivery primitive", async () => {
    const seen: string[] = [];
    const host = makePluginHost("crons", {
      sessionFor: () => ({ cwd: "/p" }),
      deliverText: async (aid) => { seen.push(aid); return { ok: true }; },
    });
    await host.deliver("ag-one", { text: "t" });
    await host.deliver("ag-two", { text: "t" });
    expect(seen).toEqual(["ag-one", "ag-two"]);
  });

  test("a refused delivery passes through why and retriable", async () => {
    const host = makePluginHost("crons", {
      sessionFor: () => ({}),
      deliverText: async () => ({ ok: false, why: "pane busy", retriable: true }),
    });
    const r = await host.deliver("ag-x", { text: "t" });
    expect(r).toEqual({ ok: false, why: "pane busy", retriable: true });
  });
});
