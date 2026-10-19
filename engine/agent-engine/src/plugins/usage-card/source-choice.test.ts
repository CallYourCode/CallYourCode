import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpDir } from "../../test-utils/tmp.ts";
import { makePluginStore } from "../platform/host.ts";
import type { PluginCore } from "../platform/core.ts";
import { usageCardPlugin, __usageCardTest, type UsageReport } from "./index.ts";

beforeEach(async () => {
  __usageCardTest.reset();
  __usageCardTest.setCacheFile(join(await tmpDir("source-choice-"), "cache.json"));
});
afterEach(() => __usageCardTest.reset());

test("agent source choice persists and immediately displays Codex weekly rather than Claude", async () => {
  const store = makePluginStore(await tmpDir("source-store-"));
  const core = () => ({ store: () => store, harnesses: () => [{ kind: "pi", active: true }],
    usage: async () => ({ ok: true, email: "claude@example.test", fetchedAt: Date.now(), windows: [] }) }) as unknown as PluginCore;
  const codex = { identity: () => "active-pi-account", read: async () => ({ ok: true, email: "pi@example.test",
    provider: "codex" as const, fetchedAt: Date.now(), windows: [{ label: "week", pct: 37, resetsAt: null }] }) };
  const plugin = usageCardPlugin(core, undefined, codex);
  expect(await plugin.rpc!["get-source"]({ session: null, agent: null }, {})).toEqual({ source: "claude" });
  await plugin.rpc!["set-source"]({ session: null, agent: null }, { source: "codex" });
  const out = await plugin.card!.render();
  expect(out.html).toContain("Codex");
  expect(out.html).toContain("pi@example.test");
  expect(out.html).toContain("37%");
  expect(out.html).not.toContain("claude@example.test");
  __usageCardTest.reset();
  const restarted = usageCardPlugin(core, undefined, codex);
  expect(await restarted.rpc!["get-source"]({ session: null, agent: null }, {})).toEqual({ source: "codex" });
  expect((await restarted.card!.render()).html).toContain("37%");
  await restarted.rpc!["set-source"]({ session: null, agent: null }, { source: "claude" });
  expect((await restarted.card!.render()).html).toContain("claude@example.test");
});

test("account switch and in-flight old read cannot leak previous account, including dedupe", async () => {
  const store = makePluginStore(await tmpDir("switch-store-"));
  await store.put("source", { source: "codex" });
  const core = () => ({ store: () => store }) as unknown as PluginCore;
  let identity = "old";
  let release!: (value: UsageReport) => void;
  const codex = { identity: () => identity, read: async () => identity === "old"
    ? new Promise<UsageReport>((resolve) => { release = resolve; })
    : { ok: true, provider: "codex" as const, accountId: "new", email: "new@example.test", fetchedAt: Date.now(),
      windows: [{ label: "week", pct: 7, resetsAt: null }] } };
  const plugin = usageCardPlugin(core, undefined, codex);
  __usageCardTest.setColdWait(10);
  const cold = await plugin.card!.render();
  expect(cold.html).not.toContain("88%");
  identity = "new";
  expect(plugin.card!.dedupe!()).toBeNull();
  const next = await plugin.card!.render();
  expect(next.html).toContain("7%"); expect(next.html).toContain("new@example.test");
  const key = plugin.card!.dedupe!();
  release({ ok: true, provider: "codex", accountId: "old", email: "old@example.test", fetchedAt: Date.now(),
    windows: [{ label: "week", pct: 88, resetsAt: null }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(__usageCardTest.cache()!.email).toBe("new@example.test"); expect(plugin.card!.dedupe!()).toBe(key);
});

test("source switch invalidates an in-flight Claude read and does not overwrite Codex", async () => {
  const store = makePluginStore(await tmpDir("source-flight-"));
  const core = () => ({ store: () => store }) as unknown as PluginCore;
  let release!: (value: UsageReport) => void;
  __usageCardTest.setSource(() => new Promise((resolve) => { release = resolve; }));
  const plugin = usageCardPlugin(core, undefined, { identity: () => "codex", read: async () => ({
    ok: true, provider: "codex", email: "codex@example.test", fetchedAt: Date.now(), windows: [{ label: "week", pct: 17, resetsAt: null }],
  }) });
  const old = __usageCardTest.refresh();
  await plugin.rpc!["set-source"]({ session: null, agent: null }, { source: "codex" });
  expect((await plugin.card!.render()).html).toContain("17%");
  release({ ok: true, email: "claude@example.test", fetchedAt: Date.now() }); await old;
  expect(__usageCardTest.cache()!.email).toBe("codex@example.test");
  await expect(plugin.rpc!["set-source"]({ session: null, agent: null }, { source: "deepseek" })).rejects.toThrow("source must be");
});

test("authorized RPC and immediate forced card bypass pre-change route cache; active identity change also bypasses", async () => {
  const { serveRoutes } = await import("../../test-utils/serve-routes.ts");
  const { pluginRoutes, resetForTest } = await import("../../routes/plugin.ts");
  resetForTest();
  const store = makePluginStore(await tmpDir("route-source-"));
  const core = () => ({ store: () => store, harnesses: () => [{ kind: "pi", active: true }],
    usage: async () => ({ ok: true, email: "claude@example.test", fetchedAt: Date.now(), windows: [] }) }) as unknown as PluginCore;
  let account = "first";
  const plugin = usageCardPlugin(core, undefined, { identity: () => account, read: async () => ({ ok: true,
    provider: "codex", email: `${account}@example.test`, accountId: account, fetchedAt: Date.now(),
    windows: [{ label: "week", pct: account === "first" ? 38 : 7, resetsAt: null }] }) });
  const server = serveRoutes({ groups: [pluginRoutes], ctx: { plugins: () => [plugin] } });
  try {
    expect((await (await server.get("/plugin/usage-card/card")).json()).html).toContain("claude@example.test");
    const selected = await server.post("/plugin/usage-card/rpc/set-source", { args: { source: "codex" } });
    expect(selected.status).toBe(200); expect(await selected.json()).toEqual({ ok: true, result: { source: "codex" } });
    expect((await (await server.get("/plugin/usage-card/card?refresh=1")).json()).html).toContain("38%");
    account = "second";
    const next = await (await server.get("/plugin/usage-card/card?refresh=1")).json();
    expect(next.html).toContain("7%"); expect(next.html).not.toContain("38%");
    expect((await server.post("/plugin/usage-card/rpc/set-source", { args: { source: "deepseek" } })).status).toBe(400);
  } finally { server.stop(); resetForTest(); }
});


test("all enabled sources persist across restart and card transport names the source; DeepSeek stays rejected", async () => {
  const store = makePluginStore(await tmpDir("three-sources-"));
  const core = () => ({ store: () => store, harnesses: () => [{ kind: "claude", active: true }],
    usage: async () => ({ ok: true, email: "claude@example.test", fetchedAt: Date.now(), windows: [] }) }) as unknown as PluginCore;
  const codex = { identity: () => "codex", read: async () => ({ ok: true, provider: "codex" as const, fetchedAt: Date.now(), windows: [] }) };
  const grok = { identity: () => "grok", read: async () => ({ ok: true, provider: "grok" as const, fetchedAt: Date.now(),
    windows: [{ label: "week", pct: 12, resetsAt: null }] }) };
  for (const source of ["claude", "codex", "grok"]) {
    let p = usageCardPlugin(core, undefined, codex, grok);
    await p.rpc!["set-source"]({ session: null, agent: null }, { source });
    __usageCardTest.reset(); p = usageCardPlugin(core, undefined, codex, grok);
    expect(await p.rpc!["get-source"]({ session: null, agent: null }, {})).toEqual({ source });
    const out = await p.card!.render(); expect(out.source).toBe(source);
    if (source === "grok") { expect(out.html).toContain("Grok"); expect(out.html).toContain("12%"); }
    for (const invalid of ["deepseek", "unknown", null]) {
      try { await p.rpc!["set-source"]({ session: null, agent: null }, { source: invalid }); throw new Error("accepted invalid source"); }
      catch (e) { expect((e as { status: number }).status).toBe(400); }
    }
  }
});
