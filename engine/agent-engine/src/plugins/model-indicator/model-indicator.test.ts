/* THE MODEL INDICATOR PLUGIN, PROVEN AT ITS TWO SEAMS (#563).
 *
 * The example plugin has exactly two things to get right, and this file holds
 * both: the DECL the app renders (a toolbar entry with the right surface
 * fields) and the RPC that carries the live model, which must be the session's
 * CURRENT model and nothing it once was. The decl-shaping runs without booting
 * an engine; the rpc is a plain function of its deps, so a fake deps proves the
 * tracking without a transcript.
 *
 *   bun test agent-engine/src/plugins/model-indicator/model-indicator.test.ts
 */

import { test, expect } from "bun:test";
import { pluginDecl, loadPlugins } from "../registry.ts";
import {
  modelIndicatorPlugin,
  friendlyModelName,
  friendlyHarnessName,
  modelOpenText,
} from "./index.ts";
import type { PluginCore } from "../platform/core.ts";

/* rpc ops take {session, agent}; C() wraps a bare session id the way the app's
 * panel calls arrive. */
const C = (s: string | null) => ({ session: s, agent: null });

/* A fake PluginCore factory whose read("model", id) answers `modelFor(id)` (the
 * raw id/acronym harness-caps hands back). Only read is exercised by this plugin;
 * the rest of the surface is cast away. */
function fakeCore(modelFor: (id: string) => string | null): (id: string) => PluginCore {
  const core = {
    read: async (_which: unknown, id: string) => modelFor(id),
  } as unknown as PluginCore;
  return () => core;
}

test("the decl carries the toolbar entry with the right surface fields", () => {
  const d = pluginDecl(modelIndicatorPlugin(fakeCore(() => "O4.8")))!;
  expect(d.id).toBe("model-indicator");
  expect(d.name).toBe("Model");
  // a side-docked toolbar panel that the app attaches the session to, wearing a
  // live badge (#581: the model name, polled the ctx way) and shown by default
  expect(d.panel).toEqual({
    icon: "🤖",
    label: "Model",
    needsSession: true,
    ops: ["model"],
    dock: "side",
    badge: "model",
    toolbarDefault: false,
  });
  // the whole design rests on no function crossing the wire: the html/rpc stay
  // engine-side, so the decl is pure data.
  expect(JSON.stringify(d).includes("function")).toBe(false);
});

test("the rpc reports the session's model as the friendly name", async () => {
  // the badge poll and the panel page read this one op; the plugin maps the
  // short status-line acronym server.ts computes (modelAcronymOf) to a name.
  const spec = modelIndicatorPlugin(fakeCore(() => "S5"));
  const r = await spec.rpc!.model(C("w1:p1"), undefined);
  expect(r).toEqual({ model: "Sonnet 5", name: "Sonnet 5", harness: null });
});

test("the declared model TRACKS the session's current model, not a stale one", async () => {
  // the same session, its model switched mid-conversation (a /model). The rpc
  // reads live through the seam, so the second call reports the new model.
  let live = "O4.8";
  const spec = modelIndicatorPlugin(fakeCore(() => live));
  expect(await spec.rpc!.model(C("w1:p1"), undefined)).toEqual({
    model: "Opus 4.8",
    name: "Opus 4.8",
    harness: null,
  });
  live = "H4.5";
  expect(await spec.rpc!.model(C("w1:p1"), undefined)).toEqual({
    model: "Haiku 4.5",
    name: "Haiku 4.5",
    harness: null,
  });
});

test("no model to name (or no session) is null, not an error", async () => {
  // a session with no assistant turn yet, or compacted-and-silent: the seam
  // answers null and the panel shows nothing rather than inventing a model.
  const spec = modelIndicatorPlugin(fakeCore(() => null));
  expect(await spec.rpc!.model(C("w1:p1"), undefined)).toEqual({
    model: null,
    name: null,
    harness: null,
  });
  // no session at all: still null, and the seam is never consulted.
  expect(await spec.rpc!.model(C(null), undefined)).toEqual({
    model: null,
    name: null,
    harness: null,
  });
});

test("the plugin loads only when the engine wires its seam (per-engine scoping)", () => {
  // this is the whole scoping mechanism: an engine that does not pass `model`
  // never declares the indicator, so another host's app draws no icon -- no
  // special-casing, just an absent declaration.
  expect(loadPlugins().some((p) => p.id === "model-indicator")).toBe(false);
  expect(loadPlugins({ model: {} }).some((p) => p.id === "model-indicator")).toBe(true);
});

test("the name mapping turns a known id or acronym into a full name", () => {
  expect(friendlyModelName("O4.8")).toBe("Opus 4.8");
  expect(friendlyModelName("claude-opus-4-8")).toBe("Opus 4.8");
  expect(friendlyModelName("claude-opus-4-8[1m]")).toBe("Opus 4.8");
  expect(friendlyModelName("anthropic/claude-fable-5")).toBe("Fable 5");
  expect(friendlyModelName("F5")).toBe("Fable 5");
  expect(friendlyModelName("claude-opus-5")).toBe("Opus 5");
  expect(friendlyModelName("claude-sonnet-5")).toBe("Sonnet 5");
  expect(friendlyModelName("sonnet-5")).toBe("Sonnet 5");
  expect(friendlyModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(friendlyModelName("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  expect(friendlyModelName("openai/gpt-5.6-terra")).toBe("GPT-5.6 Terra");
  expect(friendlyModelName("gpt-5.6-luna")).toBe("GPT-5.6 Luna");
  expect(friendlyModelName("gpt-5.5")).toBe("GPT-5.5");
  expect(friendlyModelName("grok-4.6")).toBe("Grok 4.6");
  expect(friendlyModelName("kimi-k3")).toBe("Kimi K3");
  expect(friendlyModelName("qwen3.8-max")).toBe("Qwen3.8 Max");
  expect(friendlyModelName("glm-5.3")).toBe("GLM 5.3");
  expect(friendlyModelName("deepseek-v4")).toBe("DeepSeek V4");
  expect(friendlyModelName("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
  expect(friendlyModelName("deepseek-v4-flash")).toBe("DeepSeek V4 Flash");
  expect(friendlyModelName("qwen3-coder-30b-a3b")).toBe("Qwen3-Coder-30B-A3B");
  expect(friendlyModelName("qwen3-coder-next-80b-a3b")).toBe("Qwen3-Coder-Next-80B-A3B");
  expect(friendlyModelName("qwen3.8-27b")).toBe("Qwen3.8-27B");
});

test("the name mapping falls back to the raw id or acronym when unknown", () => {
  /* Updated 2026-09-02: the mapping is the engine's ONE derivation
   * (sessions/model-names.ts) now, so a claude id of the derivable shape is
   * named even when no table lists it: the hand list missed claude-fable-5-1
   * and claude-opus-4-6 and the chip went raw on the model in use. */
  expect(friendlyModelName("claude-neptune-9")).toBe("Neptune 9");
  expect(friendlyModelName("claude-fable-5-1")).toBe("Fable 5.1");
  expect(friendlyModelName("claude-opus-4-6")).toBe("Opus 4.6");
  // a non-claude id with no row, and a chip nobody has mapped, stay raw
  expect(friendlyModelName("N9")).toBe("N9");
  expect(friendlyModelName("some-vendor/mystery-12")).toBe("some-vendor/mystery-12");
});

test("the rpc maps a known model and names the harness when the engine has one", async () => {
  const spec = modelIndicatorPlugin(fakeCore(() => "claude-fable-5"), { harness: () => "claude" });
  expect(await spec.rpc!.model(C("w1:p1"), undefined)).toEqual({
    model: "Fable 5",
    name: "Fable 5",
    harness: "Claude Code",
  });
});

test("the rpc keeps an unknown model as the raw string (honest fallback)", async () => {
  const spec = modelIndicatorPlugin(fakeCore(() => "mystery-12"));
  expect(await spec.rpc!.model(C("w1:p1"), undefined)).toEqual({
    model: "mystery-12",
    name: "mystery-12",
    harness: null,
  });
});

test("on open the panel line is harness plus the full name", () => {
  expect(friendlyHarnessName("claude")).toBe("Claude Code");
  expect(friendlyHarnessName("codex")).toBe("Codex");
  expect(friendlyHarnessName("opencode")).toBe("opencode");
  expect(friendlyHarnessName("weird-agent")).toBe("weird-agent");
  expect(modelOpenText("Fable 5", "Claude Code")).toBe("Harness: Claude Code / Model: Fable 5");
  expect(modelOpenText("Fable 5", null)).toBe("Fable 5");
});

test("the harness mapping accepts every spelling the engine hands it", () => {
  // server.ts has spelled the harness three ways over time; the panel must print
  // one product name for all of them rather than three different chips
  expect(friendlyHarnessName("claude-code")).toBe("Claude Code");
  expect(friendlyHarnessName("claude code")).toBe("Claude Code");
  expect(friendlyHarnessName("  CLAUDE  ")).toBe("Claude Code");
  expect(friendlyHarnessName("open-code")).toBe("opencode");
  expect(friendlyHarnessName("pi")).toBe("Pi");
});

test("empty strings pass straight back out of both mappings", () => {
  // the guard exists so an engine that answers "" (rather than null) does not
  // get "" looked up in the table and turned into something
  expect(friendlyModelName("")).toBe("");
  expect(friendlyHarnessName("")).toBe("");
});

test("the model key strips the noise the status line adds, not the model itself", () => {
  // whitespace, a vendor prefix, a context-window suffix and a dated build all
  // name the same model; none of them may fall through to the raw id
  expect(friendlyModelName("  claude-opus-5  ")).toBe("Opus 5");
  expect(friendlyModelName("CLAUDE-OPUS-5")).toBe("Opus 5");
  expect(friendlyModelName("bedrock/us.anthropic/claude-sonnet-5")).toBe("Sonnet 5");
  expect(friendlyModelName("claude-sonnet-5[200k]")).toBe("Sonnet 5");
  expect(friendlyModelName("claude-sonnet-5-20250101")).toBe("Sonnet 5");
  // a version number that is NOT an 8-digit date must survive intact
  expect(friendlyModelName("mystery-2024")).toBe("mystery-2024");
});

test("the rpc asks the seam about the session it was called for", async () => {
  // a panel opened from one session must never report another's model; the
  // session id is the only thing the plugin knows and it has to pass it on
  const asked: (string | null)[] = [];
  const spec = modelIndicatorPlugin(
    fakeCore((s) => { asked.push(s); return s === "w1:p1" ? "O5" : "S5"; }),
    { harness: (s) => { asked.push(`h:${s}`); return "codex"; } },
  );
  /* An rpc op answers `unknown` by contract (platform/spec.ts): the route ships
   * whatever JSON it returns and never inspects it. The shape below is this
   * op's own, named here because it is what the assertion is about. */
  const model = async (session: string) =>
    await spec.rpc!.model(C(session), undefined) as { name: string };
  expect((await model("w1:p1")).name).toBe("Opus 5");
  expect((await model("w2:p9")).name).toBe("Sonnet 5");
  expect(asked).toEqual(["w1:p1", "h:w1:p1", "w2:p9", "h:w2:p9"]);
});

test("a known harness with no model yet still names the harness (honest partial)", async () => {
  // the session is up and we know what is running in it; we just have no
  // assistant turn to read a model off. Saying "Codex, model unknown" beats
  // saying nothing, and beats guessing a default model.
  const spec = modelIndicatorPlugin(fakeCore(() => null), { harness: () => "codex" });
  expect(await spec.rpc!.model(C("w1:p1"), undefined)).toEqual({
    model: null, name: null, harness: "Codex",
  });
});

test("no session means the seams are never consulted at all", async () => {
  let touched = 0;
  const spec = modelIndicatorPlugin(
    fakeCore(() => { touched++; return "O5"; }),
    { harness: () => { touched++; return "claude"; } },
  );
  expect(await spec.rpc!.model(C(null), undefined)).toEqual({ model: null, name: null, harness: null });
  expect(touched).toBe(0);
});

test("an engine that wires only `current` declares a plugin with no harness line", async () => {
  // `harness` is optional in the deps: an older engine that never learned to
  // report one must still produce a working panel, not a crash on `deps.harness`
  const spec = modelIndicatorPlugin(fakeCore(() => "F5"));
  expect(spec.rpc!.harness).toBeUndefined(); // one op, and only one
  expect(await spec.rpc!.model(C("w1:p1"), undefined)).toEqual({
    model: "Fable 5", name: "Fable 5", harness: null,
  });
});

test("the panel page is self-contained: one cyc.call, no network of its own", async () => {
  const spec = modelIndicatorPlugin(fakeCore(() => "F5"));
  /* panel.html takes NOTHING (platform/spec.ts): the page is static and asks for
   * its session through cyc.call at render time, which is the whole point of
   * the assertion below. This used to be called with a {session, agent} bag
   * that the type has never had and the implementation has never read. */
  const html = await spec.panel!.html!();
  expect(html).toContain("window.cyc.call('model'");
  // the show sandbox has no network; a src/href/fetch to anywhere would be a
  // page that renders blank on the phone rather than a page that works offline
  expect(html).not.toMatch(/\b(fetch|XMLHttpRequest|https?:\/\/)/);
  // and it says which kind of nothing it hit rather than rendering empty
  expect(html).toContain("no model yet");
  expect(html).toContain("could not read the model");
});

test("the decl never carries the panel html or the rpc across the wire", () => {
  const d = pluginDecl(modelIndicatorPlugin(fakeCore(() => "O4.8")))!;
  expect(Object.keys(d).sort()).toEqual(["id", "name", "panel", "version"]);
  expect((d as Record<string, unknown>).rpc).toBeUndefined();
  expect((d.panel as Record<string, unknown>).html).toBeUndefined();
  // the whole MODEL_HTML page is engine-side; the frame gets chrome only
  expect(JSON.stringify(d)).not.toContain("<!doctype");
});
