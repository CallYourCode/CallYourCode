/* THE CTX PLUGIN, PROVEN AT ITS SEAMS (#590, migrated to the typed PluginCore).
 *
 * The context button is a toolbar action with a run op (compact) and a badge op
 * (pct). Both now go through the ONE typed core: pct reads
 * `core.read("contextPct", id)` and compact runs `core.command("compact", id)`.
 * Decl-shaping runs without booting an engine; the rpc is a plain function of a
 * fake PluginCore, so its behaviour is proved without a live session.
 *
 * WHAT MOVED TO THE DISPATCH: the "unknown session" answer. The plugin no longer
 * probes existence (core has no such verb); a missing session is answered by
 * core.command as a {ok:false, tell:"that session is not known to this engine"}
 * toast (capability-dispatch.test.ts pins that). The plugin keeps only the
 * null-session guard.
 *
 *   bun test agent-engine/src/plugins/ctx/ctx.test.ts
 */

import { test, expect } from "bun:test";
import { pluginDecl, loadPlugins } from "../registry.ts";
import { ctxPlugin } from "./index.ts";
import type { PluginCore } from "../platform/core.ts";

/* rpc ops take {session, agent}; C() wraps a bare session id the way a toolbar
 * tap arrives. */
const C = (s: string | null) => ({ session: s, agent: null });

/* A fake PluginCore factory: read("contextPct", id) answers the pcts map (or an
 * override), command("compact", id) answers an {ok, tell} (or an override). The
 * rest of the surface is unused by ctx and cast away. */
function fakeCore(over: {
  pct?: (id: string) => number | null;
  compact?: (id: string) => Promise<{ ok: boolean; tell: string }>;
} = {}): { core: (id: string) => PluginCore; pcts: Map<string, number>; asked: string[] } {
  const pcts = new Map<string, number>();
  const asked: string[] = [];
  const pct = over.pct ?? ((id: string) => pcts.get(id) ?? null);
  const compact = over.compact ?? (async (id: string) => ({ ok: true, tell: `compacting ${id}` }));
  const core = {
    read: async (_which: unknown, id: string) => { asked.push(id); return pct(id); },
    command: async (_which: unknown, id: string) => compact(id),
  } as unknown as PluginCore;
  return { core: () => core, pcts, asked };
}

test("the decl carries the action entry with run and badge ops", () => {
  const d = pluginDecl(ctxPlugin(fakeCore().core))!;
  expect(d.id).toBe("ctx");
  expect(d.name).toBe("Context");
  expect(d.action).toEqual({
    icon: "contextbar",
    label: "Context",
    needsSession: true,
    run: "compact",
    badge: "pct",
    confirm: {
      label: "Compact",
      message: "Compacting replaces the conversation with a summary of it, and that cannot be undone.",
    },
  });
  expect(d.panel).toBeUndefined();
  expect(d.tui).toBeUndefined();
  // the whole design rests on no function crossing the wire.
  expect(JSON.stringify(d).includes("function")).toBe(false);
});

test("pct returns the core number for a session", async () => {
  const { core, pcts } = fakeCore();
  pcts.set("w1:p1", 73);
  const r = (await ctxPlugin(core).rpc!.pct(C("w1:p1"), undefined)) as any;
  expect(r).toEqual({ pct: 73 });
});

test("pct is null without a session, and null when the core cannot read it", async () => {
  const { core } = fakeCore();
  // no session at all: null, not an error (a session-less badge is simply blank)
  expect(await ctxPlugin(core).rpc!.pct(C(null), undefined)).toEqual({ pct: null });
  // a session whose fullness is unreadable (no assistant turn yet): null
  expect(await ctxPlugin(core).rpc!.pct(C("w1:p1"), undefined)).toEqual({ pct: null });
});

test("compact returns core.command's {ok, tell} verbatim", async () => {
  const { core } = fakeCore({
    compact: async () => ({ ok: false, tell: "waiting on a permission prompt in that pane" }),
  });
  const r = (await ctxPlugin(core).rpc!.compact(C("w1:p1"), undefined)) as any;
  // the engine's own sentence, unwrapped and unrephrased -- it becomes the toast
  expect(r).toEqual({ ok: false, tell: "waiting on a permission prompt in that pane" });
});

test("compact refuses a null session, and forwards any other to the dispatch", async () => {
  const got: string[] = [];
  const { core } = fakeCore({
    compact: async (id) => { got.push(id); return { ok: true, tell: `compacting ${id}` }; },
  });
  const plugin = ctxPlugin(core);
  // no session id: refused by the plugin, before the dispatch is reached, in
  // the same {ok, tell} shape as every other refusal (fail open, 2026-09-02:
  // a refusal is a toast, never an rpc error)
  expect(await plugin.rpc!.compact(C(null), undefined))
    .toEqual({ ok: false, tell: "this action needs a session" });
  expect(got).toEqual([]);
  // an engine that never wired the core: the same shape, the same toast path
  expect(await ctxPlugin(undefined).rpc!.compact(C("w1:p1"), undefined))
    .toEqual({ ok: false, tell: "compact is not wired on this engine" });
  // any session id is forwarded to core.command; the dispatch owns the
  // unknown-session answer now (capability-dispatch.test.ts pins that toast)
  const r = (await plugin.rpc!.compact(C("w1:p1"), undefined)) as any;
  expect(r.ok).toBe(true);
  expect(got).toEqual(["w1:p1"]);
});

test("a zero percent context reads as 0, never as 'cannot read'", async () => {
  /* 0% full and "no assistant turn yet" are different facts; the chip must not
   * show a blank for a fresh, genuinely empty context. */
  const { core, pcts } = fakeCore();
  pcts.set("w1:p1", 0);
  expect(await ctxPlugin(core).rpc!.pct(C("w1:p1"), undefined)).toEqual({ pct: 0 });
});

test("pct reads live: the same session polled twice reports the new number", async () => {
  const { core, pcts } = fakeCore();
  const plugin = ctxPlugin(core);
  pcts.set("w1:p1", 12);
  expect(await plugin.rpc!.pct(C("w1:p1"), undefined)).toEqual({ pct: 12 });
  pcts.set("w1:p1", 91);
  // a cached badge would still say 12 and the app would tell you a full context
  // has room in it
  expect(await plugin.rpc!.pct(C("w1:p1"), undefined)).toEqual({ pct: 91 });
});

test("pct asks the core about the session it was called for, and never runs compact", async () => {
  const { core, pcts, asked } = fakeCore();
  pcts.set("w1:p1", 30);
  pcts.set("w2:p2", 70);
  const plugin = ctxPlugin(core);
  expect(await plugin.rpc!.pct(C("w1:p1"), undefined)).toEqual({ pct: 30 });
  expect(await plugin.rpc!.pct(C("w2:p2"), undefined)).toEqual({ pct: 70 });
  expect(asked).toEqual(["w1:p1", "w2:p2"]);
});

test("compact forwards the session id and never swallows a core failure", async () => {
  /* Updated 2026-09-02 (fail open, nothing throws): the failure still surfaces,
   * as the toast's own sentence in the {ok:false, tell} shape, instead of an rpc
   * error the app has to translate. Not swallowed: the message is the tell. */
  const got: string[] = [];
  const { core } = fakeCore({
    compact: async (id) => { got.push(id); throw new Error("that pane went away mid-compact"); },
  });
  expect(await ctxPlugin(core).rpc!.compact(C("w1:p1"), undefined))
    .toEqual({ ok: false, tell: "that pane went away mid-compact" });
  expect(got).toEqual(["w1:p1"]);
});

test("pct never throws: a read that fails is {pct:null}, and no core is {pct:null}", async () => {
  const { core } = fakeCore({ pct: () => { throw new Error("transcript vanished mid-read"); } });
  expect(await ctxPlugin(core).rpc!.pct(C("w1:p1"), undefined)).toEqual({ pct: null });
  expect(await ctxPlugin(undefined).rpc!.pct(C("w1:p1"), undefined)).toEqual({ pct: null });
});

test("the decl's run and badge name ops the plugin actually implements", () => {
  const spec = ctxPlugin(fakeCore().core);
  const d = pluginDecl(spec)!;
  expect(typeof spec.rpc![d.action!.run!]).toBe("function");
  expect(typeof spec.rpc![d.action!.badge!]).toBe("function");
  expect(Object.keys(spec.rpc!).sort()).toEqual(["compact", "pct"]);
});

test("ctx declares a button, not a page: no html anywhere in the spec", () => {
  const spec = ctxPlugin(fakeCore().core);
  expect(spec.panel).toBeUndefined();
  expect(spec.card).toBeUndefined();
  expect(spec.tui).toBeUndefined();
});

test("ctx is not loaded until the engine marks it wired, then loads", () => {
  // no ctx marker: the plugin is absent (an engine that does not wire it declares
  // no Context button -- the #590 rule)
  expect(loadPlugins().some((p) => p.id === "ctx")).toBe(false);
  const withCtx = loadPlugins({ ctx: true });
  expect(withCtx.some((p) => p.id === "ctx")).toBe(true);
});
