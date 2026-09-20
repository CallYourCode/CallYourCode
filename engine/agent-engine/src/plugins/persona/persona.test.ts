/* THE VOICE PLUGIN, PROVEN AT ITS SEAMS (#558, migrated to the typed PluginCore).
 *
 * The voice selector is a side-docked, session-scoped panel. Its four ops now go
 * through core.tts: list/sample are the TTS engine; voiceOf/setVoice/
 * globalDefault/setDefault are the per-session choice and host default (the SAME
 * state the /voices and /session/<id>/voice routes use); sessionExists is the
 * panel's session guard, and it runs BEFORE any write. The rpc is a plain
 * function of a fake PluginCore, so its behaviour is proved without a voice engine.
 *
 *   bun test agent-engine/src/plugins/persona/persona.test.ts
 */

import { test, expect } from "bun:test";
import { pluginDecl, loadPlugins } from "../registry.ts";
import { personaPlugin } from "./index.ts";
import type { PluginCore } from "../platform/core.ts";

/* rpc ops take {session, agent}; C() wraps a bare session id the way the app's
 * panel calls arrive. */
const C = (s: string | null) => ({ session: s, agent: null });

type VoiceTts = PluginCore["tts"];

/* A fake PluginCore whose .tts is the voice service, over an in-memory override
 * map, the shape server.ts wires to the real voiceOverrides + listHostVoices +
 * ttsWithVoice. */
function fakeCore(over: Partial<VoiceTts> = {}): { core: (id: string) => PluginCore; overrides: Map<string, string> } {
  const overrides = new Map<string, string>();
  let hostDefault = "af_heart";
  const tts: VoiceTts = {
    list: async () => ["af_heart", "am_onyx", "bf_emma"],
    voiceOf: (id) => overrides.get(id) ?? "",
    globalDefault: () => hostDefault,
    setDefault: (v) => { hostDefault = v; },
    setVoice: (id, v) => { if (v) overrides.set(id, v); else overrides.delete(id); },
    sample: async (v) => `mp3-of-${v || "default"}`,
    sessionExists: () => true,
    ...over,
  };
  const core = { tts } as unknown as PluginCore;
  return { core: () => core, overrides };
}

test("the decl carries the toolbar entry with the right surface fields", () => {
  const d = pluginDecl(personaPlugin(fakeCore().core))!;
  // the wire id is "persona" (routes + the app's toolbar key), what a person
  // reads is Persona (#574)
  expect(d.id).toBe("persona");
  expect(d.name).toBe("Persona");
  // a side-docked, session-scoped panel with the four ops it calls back over,
  // the person glyph and Persona label, shown by default (#574)
  expect(d.panel).toEqual({
    icon: "user",
    label: "Persona",
    needsSession: true,
    ops: ["list", "set", "sample", "set-default"],
    dock: "side",
    toolbarDefault: false,
  });
  // the whole design rests on no function crossing the wire.
  expect(JSON.stringify(d).includes("function")).toBe(false);
});

test("list reports the host voices, the override, and the default it falls back to", async () => {
  const { core, overrides } = fakeCore();
  overrides.set("w1:p1", "am_onyx");
  const r = (await personaPlugin(core).rpc!.list(C("w1:p1"), undefined)) as any;
  expect(r.voices).toEqual(["af_heart", "am_onyx", "bf_emma"]);
  expect(r.current).toBe("am_onyx");
  expect(r.default).toBe("af_heart");
});

test("no override reads as current:'' (on the default), not a made-up voice", async () => {
  const { core } = fakeCore();
  const r = (await personaPlugin(core).rpc!.list(C("w1:p1"), undefined)) as any;
  expect(r.current).toBe("");
  expect(r.default).toBe("af_heart");
});

test("set writes the override, and an empty voice clears it", async () => {
  const { core, overrides } = fakeCore();
  const spec = personaPlugin(core);

  const set = (await spec.rpc!.set(C("w1:p1"), { voice: "bf_emma" })) as any;
  expect(set.current).toBe("bf_emma");
  expect(overrides.get("w1:p1")).toBe("bf_emma");

  // empty clears it, exactly as POST /session/<id>/voice does
  const cleared = (await spec.rpc!.set(C("w1:p1"), { voice: "" })) as any;
  expect(cleared.current).toBe("");
  expect(overrides.has("w1:p1")).toBe(false);
});

test("set only ever touches the session it was handed", async () => {
  const { core, overrides } = fakeCore();
  const spec = personaPlugin(core);
  await spec.rpc!.set(C("w1:p1"), { voice: "am_onyx" });
  await spec.rpc!.set(C("w2:p9"), { voice: "bf_emma" });
  expect(overrides.get("w1:p1")).toBe("am_onyx");
  expect(overrides.get("w2:p9")).toBe("bf_emma");
});

test("sample returns the base64 audio the seam rendered", async () => {
  const { core } = fakeCore();
  const r = (await personaPlugin(core).rpc!.sample(C("w1:p1"), { voice: "am_onyx" })) as any;
  expect(r.audio).toBe("mp3-of-am_onyx");
});

test("set-default writes the HOST default every un-overridden session falls back to (#584)", async () => {
  const { core } = fakeCore();
  const spec = personaPlugin(core);
  const r = (await spec.rpc!["set-default"](C("w1:p1"), { voice: "bf_emma" })) as any;
  expect(r.default).toBe("bf_emma");
  // list reports the new default for any session with no override
  const l = (await spec.rpc!.list(C("w1:p1"), undefined)) as any;
  expect(l.default).toBe("bf_emma");
  expect(l.current).toBe("");
  // '' clears it to the voice engine's own default
  const c = (await spec.rpc!["set-default"](C("w1:p1"), { voice: "" })) as any;
  expect(c.default).toBe("");
});

test("a voice engine that could not render a sample is null, not an error", async () => {
  const { core } = fakeCore({ sample: async () => null });
  const r = (await personaPlugin(core).rpc!.sample(C("w1:p1"), { voice: "am_onyx" })) as any;
  expect(r.audio).toBeNull();
});

test("every op needs a real session; a null or unknown one is refused", async () => {
  const spec = personaPlugin(fakeCore({ sessionExists: (id) => id === "w1:p1" }).core);
  for (const op of ["list", "set", "sample", "set-default"] as const) {
    await expect(spec.rpc![op](C(null), {})).rejects.toThrow("this panel needs a session");
    await expect(spec.rpc![op](C("w9:p9"), {})).rejects.toThrow("no such session");
  }
});

test("the gate runs BEFORE the seam, so an unknown session writes nothing", async () => {
  /* set-default is host-wide: if the guard ran after the write, one call from a
   * stale panel would repoint every conversation on the host. */
  let writes = 0;
  const { core } = fakeCore({
    sessionExists: () => false,
    setVoice: () => { writes++; },
    setDefault: () => { writes++; },
    sample: async () => { writes++; return null; },
    list: async () => { writes++; return []; },
  });
  const spec = personaPlugin(core);
  for (const op of ["list", "set", "sample", "set-default"] as const) {
    await expect(spec.rpc![op](C("w9:p9"), { voice: "am_onyx" })).rejects.toThrow();
  }
  expect(writes).toBe(0);
});

test("a voice argument is trimmed before it is stored or spoken", async () => {
  // the panel sends what the row carried; a stray space would mint a second,
  // never-matching override key for the same voice
  const spoken: string[] = [];
  const { core, overrides } = fakeCore({ sample: async (v) => { spoken.push(v); return null; } });
  const spec = personaPlugin(core);
  await spec.rpc!.set(C("w1:p1"), { voice: "  am_onyx  " });
  expect(overrides.get("w1:p1")).toBe("am_onyx");
  await spec.rpc!.sample(C("w1:p1"), { voice: " bf_emma\n" });
  expect(spoken).toEqual(["bf_emma"]);
  // whitespace only is nothing, so it clears rather than storing a blank voice
  await spec.rpc!.set(C("w1:p1"), { voice: "   " });
  expect(overrides.has("w1:p1")).toBe(false);
});

test("a missing or wrong-typed voice argument reads as empty, never as junk", async () => {
  /* args comes off the wire. A number, an object or no args at all must land on
   * the SAME branch as "" (clear / host default), not become the string "42". */
  const { core, overrides } = fakeCore();
  const spec = personaPlugin(core);
  overrides.set("w1:p1", "am_onyx");
  for (const args of [undefined, {}, { voice: 42 }, { voice: null }, { voice: ["a"] }] as unknown[]) {
    overrides.set("w1:p1", "am_onyx");
    const r = (await spec.rpc!.set(C("w1:p1"), args as Record<string, unknown>)) as any;
    expect(r.current).toBe("");
    expect(overrides.has("w1:p1")).toBe(false);
  }
  const d = (await spec.rpc!["set-default"](C("w1:p1"), undefined)) as any;
  expect(d.default).toBe("");
});

test("set reports what the engine now holds, not what the panel asked for", async () => {
  /* The op answers with voiceOf AFTER the write. A seam that refused (a voice this
   * host cannot speak) then reports the old value, and the panel redraws honestly
   * instead of ticking a row the engine never accepted. */
  const overrides = new Map<string, string>();
  const tts = {
    list: async () => ["af_heart", "am_onyx", "bf_emma"],
    voiceOf: (id: string) => overrides.get(id) ?? "",
    globalDefault: () => "af_heart",
    setDefault: () => {},
    // refuses bf_emma (a voice this host cannot speak)
    setVoice: (id: string, v: string) => { if (v === "bf_emma") return; if (v) overrides.set(id, v); else overrides.delete(id); },
    sample: async () => null,
    sessionExists: () => true,
  };
  const core = (() => ({ tts } as unknown as PluginCore));
  overrides.set("w1:p1", "am_onyx");
  const r = (await personaPlugin(core).rpc!.set(C("w1:p1"), { voice: "bf_emma" })) as any;
  expect(r.current).toBe("am_onyx");
});

test("the host default is host-wide: one session sets it, every session sees it", async () => {
  const { core, overrides } = fakeCore();
  const spec = personaPlugin(core);
  overrides.set("w2:p9", "am_onyx"); // this one has its own override
  await spec.rpc!["set-default"](C("w1:p1"), { voice: "bf_emma" });
  const a = (await spec.rpc!.list(C("w1:p1"), undefined)) as any;
  const b = (await spec.rpc!.list(C("w2:p9"), undefined)) as any;
  expect(a.default).toBe("bf_emma");
  expect(b.default).toBe("bf_emma");
  // and setting the host default did NOT stamp an override on the caller
  expect(a.current).toBe("");
  expect(b.current).toBe("am_onyx"); // nor disturb one that already existed
});

test("sampling the empty voice asks the engine for its own default", async () => {
  // the panel's "Host default" row plays with sampleVoice:'' ; it must reach the
  // seam as '' rather than being refused for having no voice
  const spoken: string[] = [];
  const { core } = fakeCore({ sample: async (v) => { spoken.push(v); return "mp3"; } });
  const spec = personaPlugin(core);
  expect(((await spec.rpc!.sample(C("w1:p1"), { voice: "" })) as any).audio).toBe("mp3");
  expect(spoken).toEqual([""]);
});

test("a host with no voices lists an empty set rather than failing", async () => {
  const { core } = fakeCore({ list: async () => [], globalDefault: () => "" });
  const r = (await personaPlugin(core).rpc!.list(C("w1:p1"), undefined)) as any;
  expect(r).toEqual({ voices: [], current: "", default: "" });
});

test("the declared ops are exactly the ops the plugin implements", () => {
  const spec = personaPlugin(fakeCore().core);
  // a decl naming an op with no implementation is a panel button that throws on
  // tap, and an op the decl omits is one the app is not allowed to call
  expect([...spec.panel!.ops!].sort()).toEqual(Object.keys(spec.rpc!).sort());
});

test("the panel page is self-contained: cyc.call only, no network of its own", async () => {
  const spec = personaPlugin(fakeCore().core);
  const html = await spec.panel!.html!(); // panel.html takes nothing; the page asks via cyc.call
  for (const op of spec.panel!.ops!) expect(html).toContain(`cyc.call('${op}'`);
  // the show sandbox has no origin to fetch from; the sample plays from the
  // data: URL the rpc returned
  expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest|https?:\/\//);
  expect(html).toContain("data:audio/mpeg;base64,");
  // and it names each kind of nothing rather than going blank
  expect(html).toContain("This host reports no voices.");
  expect(html).toContain("could not load voices");
  expect(html).toContain("no sample for that voice");
});

test("the plugin loads only when the engine wires its seam (per-engine scoping)", () => {
  // the whole scoping mechanism: an engine that does not mark `voice` never
  // declares the panel, so its app draws no icon -- an absent declaration, no
  // special-casing.
  expect(loadPlugins().some((p) => p.id === "persona")).toBe(false);
  expect(loadPlugins({ persona: true }).some((p) => p.id === "persona")).toBe(true);
});
