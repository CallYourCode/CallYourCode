/* THE PLUGIN REGISTRY, AND THE ROUTES ITS DECLARATIONS DESCRIBE.
 *
 * A PLUGIN DECL IS THE APP'S ONLY DESCRIPTION OF A SURFACE IT HAS NEVER SEEN.
 * The app does not hold the render function, the panel page or the rpc map; it
 * holds a decl and draws chrome from it. So decl shaping is a wire contract, and
 * the two properties it rests on are the ones this file spends most of its
 * assertions on:
 *
 *   1. NO FUNCTION CROSSES THE WIRE. render/rpc/html/dedupe read this engine's
 *      own limits, schedules and files; none of it is describable on a phone.
 *   2. ONE BAD PLUGIN MUST NOT BLANK THE COMPOSER. Declaring reads static
 *      fields, so a plugin whose hooks throw still yields a clean decl, and a
 *      malformed SURFACE drops that surface alone rather than the plugin, and
 *      an undeclarable plugin drops itself rather than the list.
 *
 * NO ENGINE. The decl half is pure. The route half is the real pluginRoutes
 * group on a real Bun.serve on port 0 (test-utils/serve-routes.ts), against
 * fixture specs written here whose hooks are real enough to be raced, refused
 * and blown past their caps. One wireCore stands behind it for the two things
 * the routes read out of live engine state: the session an rpc resolves an
 * agent id from, and the data dir the two-axis state record lands in.
 *
 * THE THREE BUDGETS ARE ENV-SHORTENED (routes/plugin.ts cardDeadlineMs /
 * hookDeadlineMs), for the same reason the refresh floor already was: the SPLIT
 * between the poll deadline and the refresh deadline is the thing worth proving
 * (#577), and proving it at 8s/12s costs thirteen wall seconds per assertion.
 * The renders here are deferred promises the test resolves by hand, so what is
 * measured is the race and not a sleep.
 *
 * The wire-level half -- the same decls riding a sealed DataChannel, and a card
 * fetched from a booted engine -- is e2e/plugin-rpc.test.ts and only there.
 *
 *   bun test agent-engine/src/plugins/registry.test.ts
 */

import { test, expect, afterAll, afterEach, beforeAll } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  pluginDecl,
  declarePlugins,
  loadPlugins,
} from "./registry.ts";
import {
  PLUGIN_ID_RE,
  CARD_HTML_MAX_BYTES,
  CARD_REFRESH_FLOOR_MIN_S,
  MENU_MAX_ITEMS,
  MENU_ITEM_TEXT_MAX,
  PANEL_HTML_MAX_BYTES,
  SLIDER_MAX_STEPS,
  WIDGET_KEY_RE,
  RPC_ARGS_MAX_BYTES,
  RPC_REPLY_MAX_BYTES,
  type PluginSpec,
} from "./platform/spec.ts";
import { tuiPlugin } from "./tui/index.ts";
import { gitPlugin } from "./git/index.ts";
import { filesPlugin } from "./files/index.ts";
import { stopPlugin } from "./stop/index.ts";
import type { PluginCore } from "./platform/core.ts";
import { pluginRoutes, resetForTest as resetCardCache } from "../routes/plugin.ts";

/* A fake PluginCore factory for the stop plugin's two verbs: `has` gates the
 * live-pane refusal, `command` records the interrupt. Everything else is unused
 * by stop, so the partial is cast. */
function fakeStopCore(over: { has?: (id: string) => boolean; command?: (id: string) => Promise<void> } = {}): (id: string) => PluginCore {
  const canHas = over.has ?? (() => true);
  const cmd = over.command ?? (async () => {});
  const core = {
    has: (_w: unknown, id: string) => canHas(id),
    command: async (_w: unknown, id: string) => { await cmd(id); return { ok: true, tell: "" }; },
  } as unknown as PluginCore;
  return () => core;
}
import { agentsDir } from "../storage/datadir.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { wireCore, type WireCore } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";

/* ============================ part 1: the decl ============================= */

/* THE LEAF STAYS A LEAF (plugin-selfcontain Move 1). platform/spec.ts holds the
 * spec/decl vocabulary and the caps a plugin is written in; it must import
 * NOTHING engine-side, so a plugin file can take its shape from the leaf without
 * dragging in the registry that lists every plugin. That is the property the
 * broken cycle rests on: the day someone adds a `from "./..."` here, this fails. */
test("platform/spec.ts imports no engine module (the leaf is a leaf)", async () => {
  const src = await Bun.file(join(import.meta.dir, "platform/spec.ts")).text();
  const rel = [...src.matchAll(/\bfrom\s*["'](\.[^"']*)["']/g)].map((m) => m[1]);
  expect(rel).toEqual([]);
});

/* A whole spec, every surface populated, hooks that would throw if called. The
 * decl builder must read only the static fields, so building this must not
 * throw and must not carry a single function through. */
function fullSpec(over: Partial<PluginSpec> = {}): PluginSpec {
  return {
    id: "demo",
    name: "Demo",
    version: 2,
    card: {
      title: "Demo Card",
      refreshFloorS: 30,
      dedupe: () => {
        throw new Error("dedupe must not be called to declare");
      },
      render: async () => {
        throw new Error("render must not be called to declare");
      },
    },
    panel: {
      icon: "gear",
      label: "Demo Panel",
      needsSession: true,
      html: async () => {
        throw new Error("html must not be called to declare");
      },
    },
    action: { icon: "stop", label: "Stop", needsSession: true, run: "stop", badge: "ctx" },
    tui: { icon: "terminal", label: "Shell" },
    rpc: {
      op: async () => {
        throw new Error("rpc must not be called to declare");
      },
    },
    composer: [{ type: "menu", icon: "plus", label: "Bits", items: [{ text: "Hi", insert: "hi " }] }],
    ...over,
  };
}

test("pluginDecl keeps the static shape and strips every function", () => {
  const d = pluginDecl(fullSpec());
  expect(d).toEqual({
    id: "demo",
    name: "Demo",
    version: 2,
    card: { title: "Demo Card", refreshFloorS: 30 },
    panel: { icon: "gear", label: "Demo Panel", needsSession: true },
    action: { icon: "stop", label: "Stop", needsSession: true, run: "stop", badge: "ctx" },
    tui: { icon: "terminal", label: "Shell" },
    composer: [{ type: "menu", icon: "plus", label: "Bits", items: [{ text: "Hi", insert: "hi " }] }],
  });
  // the deep-equal above already proves no render/rpc/html/dedupe survived, but
  // say it out loud: the whole design rests on functions never being on the wire
  const flat = JSON.stringify(d);
  expect(flat.includes("must not be called")).toBe(false);
  /* And say it structurally too, so a surface added later cannot smuggle one
   * through a field this test does not name: nothing anywhere in the decl tree
   * is a function. JSON.stringify DROPS functions silently, which is exactly
   * why the string check above is not enough on its own. */
  const walk = (v: unknown, path: string): string[] => {
    if (typeof v === "function") return [path];
    if (Array.isArray(v)) return v.flatMap((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") {
      return Object.entries(v).flatMap(([k, x]) => walk(x, `${path}.${k}`));
    }
    return [];
  };
  expect(walk(d, "decl")).toEqual([]);
});

test("pluginDecl drops a spec with an id that is not a path/namespace segment", () => {
  for (const bad of ["", "Demo", "de mo", "demo!", "a".repeat(65), "../x", "a/b"]) {
    expect(PLUGIN_ID_RE.test(bad), `${bad} should be rejected`).toBe(false);
    expect(pluginDecl(fullSpec({ id: bad })), `${bad} should not declare`).toBeNull();
  }
  for (const ok of ["a", "usage-card", "crons", "x9-y-z", "a".repeat(64)]) {
    expect(pluginDecl(fullSpec({ id: ok })), `${ok} should declare`).not.toBeNull();
  }
});

test("pluginDecl requires a name and a finite version", () => {
  expect(pluginDecl(fullSpec({ name: "" }))).toBeNull();
  expect(pluginDecl(fullSpec({ version: NaN as unknown as number }))).toBeNull();
  expect(pluginDecl(fullSpec({ version: undefined as unknown as number }))).toBeNull();
  // and a spec that is not an object at all is a null, never a throw: the list
  // builder walks whatever loadPlugins handed it
  expect(pluginDecl(null as unknown as PluginSpec)).toBeNull();
  expect(pluginDecl("nope" as unknown as PluginSpec)).toBeNull();
});

test("card refreshFloorS is clamped UP to the floor, never down", () => {
  expect(pluginDecl(fullSpec({ card: { ...fullSpec().card!, refreshFloorS: 1 } }))!.card!.refreshFloorS)
    .toBe(CARD_REFRESH_FLOOR_MIN_S);
  expect(pluginDecl(fullSpec({ card: { ...fullSpec().card!, refreshFloorS: 0 } }))!.card!.refreshFloorS)
    .toBe(CARD_REFRESH_FLOOR_MIN_S);
  // a larger floor is honoured as declared
  expect(pluginDecl(fullSpec({ card: { ...fullSpec().card!, refreshFloorS: 900 } }))!.card!.refreshFloorS)
    .toBe(900);
  /* A floor that is not a number at all clamps to the minimum rather than
   * riding the wire as NaN: the app divides by this to schedule its poll. */
  expect(pluginDecl(fullSpec({ card: { ...fullSpec().card!, refreshFloorS: "soon" as any } }))!
    .card!.refreshFloorS).toBe(CARD_REFRESH_FLOOR_MIN_S);
});

test("a plugin keeps its good surfaces when one surface is malformed", () => {
  // a card with no title is dropped; panel and composer survive
  const noTitle = pluginDecl(fullSpec({ card: { ...fullSpec().card!, title: "" } }))!;
  expect(noTitle.card).toBeUndefined();
  expect(noTitle.panel).toBeTruthy();
  expect(noTitle.composer).toBeTruthy();
  // a panel with no icon or no label is dropped; card survives
  const noIcon = pluginDecl(fullSpec({ panel: { ...fullSpec().panel!, icon: "" } }))!;
  expect(noIcon.panel).toBeUndefined();
  expect(noIcon.card).toBeTruthy();
});

test("panel dock: only 'side' crosses the wire, anything else leaves the key off", () => {
  /* #530: a panel seats as a right-column card or as the full-bleed overlay,
   * and 'full' is the default the app applies when the key is absent. So a
   * declared 'full' and a declared nonsense are the same answer -- no key --
   * and only 'side' is carried. */
  const side = pluginDecl(fullSpec({ panel: { ...fullSpec().panel!, dock: "side" } }))!;
  expect(side.panel!.dock).toBe("side");
  const full = pluginDecl(fullSpec({ panel: { ...fullSpec().panel!, dock: "full" } }))!;
  expect("dock" in full.panel!).toBe(false);
  const junk = pluginDecl(fullSpec({ panel: { ...fullSpec().panel!, dock: "sideways" as any } }))!;
  expect("dock" in junk.panel!).toBe(false);
});

test("composer menu: over the item cap the widget is dropped, not truncated", () => {
  const items = Array.from({ length: MENU_MAX_ITEMS + 1 }, (_, i) => ({ text: `t${i}`, insert: `${i}` }));
  const d = pluginDecl(fullSpec({ composer: [{ type: "menu", icon: "plus", label: "M", items }] }))!;
  expect(d.composer).toBeUndefined();
  // exactly at the cap is fine and NOT truncated
  const ok = pluginDecl(fullSpec({ composer: [{ type: "menu", icon: "plus", label: "M", items: items.slice(0, MENU_MAX_ITEMS) }] }))!;
  expect(ok.composer![0].type).toBe("menu");
  expect((ok.composer![0] as any).items.length).toBe(MENU_MAX_ITEMS);
  // ...and an EMPTY menu is dropped too: a menu with nothing in it draws a
  // control that does nothing when tapped
  const empty = pluginDecl(fullSpec({ composer: [{ type: "menu", icon: "plus", label: "M", items: [] }] }))!;
  expect(empty.composer).toBeUndefined();
});

test("composer menu: an over-long item text drops the whole widget", () => {
  const items = [{ text: "x".repeat(MENU_ITEM_TEXT_MAX + 1), insert: "x" }];
  const d = pluginDecl(fullSpec({ composer: [{ type: "menu", icon: "plus", label: "M", items }] }))!;
  expect(d.composer).toBeUndefined();
  // exactly at the cap rides
  const at = pluginDecl(fullSpec({ composer: [{ type: "menu", icon: "plus", label: "M",
    items: [{ text: "x".repeat(MENU_ITEM_TEXT_MAX), insert: "x" }] }] }))!;
  expect((at.composer![0] as any).items[0].text.length).toBe(MENU_ITEM_TEXT_MAX);
  // an item with no text is not a menu row anybody could read: dropped
  const blank = pluginDecl(fullSpec({ composer: [{ type: "menu", icon: "plus", label: "M",
    items: [{ text: "", insert: "x" }] }] }))!;
  expect(blank.composer).toBeUndefined();
});

test("composer slider: over the step cap the widget is dropped", () => {
  const steps = Array.from({ length: SLIDER_MAX_STEPS + 1 }, (_, i) => ({ n: i, name: `s${i}` }));
  const d = pluginDecl(fullSpec({ composer: [{ type: "slider", key: "s", icon: "dial", label: "S", steps }] }))!;
  expect(d.composer).toBeUndefined();
  const ok = pluginDecl(fullSpec({ composer: [{ type: "slider", key: "s", icon: "dial", label: "S", steps: steps.slice(0, SLIDER_MAX_STEPS) }] }))!;
  expect((ok.composer![0] as any).steps.length).toBe(SLIDER_MAX_STEPS);
  // a step with no name, or an n that is not a number, drops the whole rail:
  // half a dial is a dial that sets something other than what it shows
  const noName = pluginDecl(fullSpec({ composer: [{ type: "slider", key: "s", icon: "dial", label: "S",
    steps: [{ n: 1, name: "" }] }] }))!;
  expect(noName.composer).toBeUndefined();
  const badN = pluginDecl(fullSpec({ composer: [{ type: "slider", key: "s", icon: "dial", label: "S",
    steps: [{ n: "one" as any, name: "One" }] }] }))!;
  expect(badN.composer).toBeUndefined();
});

test("composer slider: a step `hint` rides when present and is absent otherwise (#595)", () => {
  /* The app draws the current rung's description under the rail. It is an
   * optional field, so a plugin that has nothing to say per rung declares no
   * hint at all rather than an empty string the app would draw as a blank line. */
  const withHint = pluginDecl(fullSpec({ composer: [{ type: "slider", key: "v", icon: "dial", label: "S",
    steps: [{ n: 1, name: "One", hint: "the quiet one" }] }] }))!;
  expect((withHint.composer![0] as any).steps[0]).toEqual({ n: 1, name: "One", hint: "the quiet one" });
  const without = pluginDecl(fullSpec({ composer: [{ type: "slider", key: "v", icon: "dial", label: "S",
    steps: [{ n: 1, name: "One" }] }] }))!;
  expect("hint" in (without.composer![0] as any).steps[0]).toBe(false);
});

test("composer slider: a key is REQUIRED, a menu key is optional (#585)", () => {
  // a slider with no key cannot say which dial it set: dropped, menu beside it lives
  const noKey = pluginDecl(fullSpec({ composer: [
    { type: "slider", icon: "dial", label: "S", steps: [{ n: 1, name: "a" }] } as any,
    { type: "menu", icon: "plus", label: "M", items: [{ text: "a", insert: "a" }] },
  ] }))!;
  expect(noKey.composer!.length).toBe(1);
  expect(noKey.composer![0].type).toBe("menu");
  // a good key crosses the wire on both variants; a bad key drops the widget
  const keyed = pluginDecl(fullSpec({ composer: [
    { type: "slider", key: "verbosity", icon: "dial", label: "S", steps: [{ n: 1, name: "a" }] },
  ] }))!;
  expect((keyed.composer![0] as any).key).toBe("verbosity");
  for (const bad of ["", "Verbosity", "a b", "x!", "a".repeat(33)]) {
    if (bad) expect(WIDGET_KEY_RE.test(bad), `${bad} should be a bad key`).toBe(false);
    const d = pluginDecl(fullSpec({ composer: [
      { type: "slider", key: bad, icon: "dial", label: "S", steps: [{ n: 1, name: "a" }] } as any,
    ] }))!;
    expect(d.composer, `key ${JSON.stringify(bad)} should drop the slider`).toBeUndefined();
  }
  /* A MALFORMED key drops a MENU too, and this is the asymmetry worth spelling
   * out: absent is fine (the app namespaces it itself), present-but-junk is a
   * widget that cannot round-trip a pick faithfully. */
  const junkMenuKey = pluginDecl(fullSpec({ composer: [
    { type: "menu", key: "NOT A KEY", icon: "edit", label: "M", items: [{ text: "a", insert: "a" }] } as any,
  ] }))!;
  expect(junkMenuKey.composer).toBeUndefined();
  // a menu carries a valid key, or omits it when absent
  const menuKey = pluginDecl(fullSpec({ composer: [
    { type: "menu", key: "bits", icon: "edit", label: "M", items: [{ text: "a", insert: "a" }] },
  ] }))!;
  expect((menuKey.composer![0] as any).key).toBe("bits");
  const menuNoKey = pluginDecl(fullSpec({ composer: [
    { type: "menu", icon: "edit", label: "M", items: [{ text: "a", insert: "a" }] },
  ] }))!;
  expect("key" in (menuNoKey.composer![0] as any)).toBe(false);
});

test("composer: a widget with no icon or no label is dropped, whatever its type", () => {
  for (const w of [
    { type: "menu", icon: "", label: "M", items: [{ text: "a", insert: "a" }] },
    { type: "menu", icon: "plus", label: "", items: [{ text: "a", insert: "a" }] },
    { type: "slider", key: "v", icon: "", label: "S", steps: [{ n: 1, name: "a" }] },
    { type: "slider", key: "v", icon: "dial", label: "", steps: [{ n: 1, name: "a" }] },
  ]) {
    expect(pluginDecl(fullSpec({ composer: [w as any] }))!.composer,
      `${JSON.stringify(w)} should be dropped`).toBeUndefined();
  }
});

test("composer slider: `value` must name a real step, else the widget is dropped (#585)", () => {
  const steps = [{ n: 1, name: "a" }, { n: 3, name: "b" }, { n: 5, name: "c" }];
  // value equal to a step's n rides the decl
  const ok = pluginDecl(fullSpec({ composer: [
    { type: "slider", key: "v", icon: "dial", label: "S", value: 3, steps },
  ] }))!;
  expect((ok.composer![0] as any).value).toBe(3);
  // a value pointing at a rung the dial does not have is dropped
  const bad = pluginDecl(fullSpec({ composer: [
    { type: "slider", key: "v", icon: "dial", label: "S", value: 2, steps },
  ] }))!;
  expect(bad.composer).toBeUndefined();
  // absent value is fine (an unset dial)
  const none = pluginDecl(fullSpec({ composer: [
    { type: "slider", key: "v", icon: "dial", label: "S", steps },
  ] }))!;
  expect("value" in (none.composer![0] as any)).toBe(false);
});

test("composer may be a FUNCTION built from state; a throwing builder drops only that surface (#585)", () => {
  // a function-valued composer is called and its widgets declared
  const built = pluginDecl(fullSpec({ composer: () => [
    { type: "slider", key: "v", icon: "dial", label: "S", value: 1, steps: [{ n: 1, name: "a" }] },
  ] }))!;
  expect((built.composer![0] as any).key).toBe("v");
  // a builder that throws drops the composer surface but keeps panel/card
  const boom = pluginDecl(fullSpec({ composer: () => { throw new Error("builder boom"); } }))!;
  expect(boom.composer).toBeUndefined();
  expect(boom.panel).toBeTruthy();
  expect(boom.card).toBeTruthy();
  // a builder that returns a non-array yields no composer, rest intact
  const junk = pluginDecl(fullSpec({ composer: (() => 7) as any }))!;
  expect(junk.composer).toBeUndefined();
  expect(junk.panel).toBeTruthy();
  // a builder that returns an array of nothing declarable leaves the key off
  // rather than declaring an empty composer the app would draw a gap for
  const nothing = pluginDecl(fullSpec({ composer: () => [{ type: "wat" } as any] }))!;
  expect("composer" in nothing).toBe(false);
});

test("composer: an unknown widget type is dropped, known ones beside it survive", () => {
  const d = pluginDecl(fullSpec({
    composer: [
      { type: "wat" } as any,
      { type: "menu", icon: "plus", label: "M", items: [{ text: "a", insert: "a" }] },
    ],
  }))!;
  expect(d.composer!.length).toBe(1);
  expect(d.composer![0].type).toBe("menu");
});

test("action surface: a toolbar button decl carries icon/label/needsSession and its op names", () => {
  // covers stop (run op) and ctx (badge op): the two toolbar buttons that are
  // not panels. The op NAMES cross the wire; the ops themselves stay engine-side.
  const d = pluginDecl(fullSpec())!;
  expect(d.action).toEqual({ icon: "stop", label: "Stop", needsSession: true, run: "stop", badge: "ctx" });
  // an action with no icon or no label is dropped, the rest survives
  const noIcon = pluginDecl(fullSpec({ action: { icon: "", label: "Stop", needsSession: true } as any }))!;
  expect(noIcon.action).toBeUndefined();
  expect(noIcon.panel).toBeTruthy();
  // needsSession coerces: only a literal true is true, so a junk value cannot
  // make the app pass a session id to a button that never wanted one
  const loose = pluginDecl(fullSpec({ action: { icon: "stop", label: "Stop", needsSession: "yes" as any } }))!;
  expect(loose.action!.needsSession).toBe(false);
});

test("action confirm: only label+message cross the wire; extra keys are stripped", () => {
  const d = pluginDecl(fullSpec({
    action: {
      icon: "hand",
      label: "Halt",
      needsSession: true,
      run: "stop",
      confirm: {
        label: "Send Ctrl-C",
        message: "Whatever it is doing stops where it is, and that cannot be undone.",
        keys: ["Escape"],
        extra: true,
      } as any,
    },
  }))!;
  expect(d.action!.confirm).toEqual({
    label: "Send Ctrl-C",
    message: "Whatever it is doing stops where it is, and that cannot be undone.",
  });
  expect("keys" in (d.action!.confirm as object)).toBe(false);
  expect("extra" in (d.action!.confirm as object)).toBe(false);

  const missing = pluginDecl(fullSpec({
    action: { icon: "hand", label: "Halt", needsSession: true, confirm: { label: "X" } as any },
  }))!;
  expect(missing.action!.confirm).toBeUndefined();
  /* A confirm whose halves are whitespace is the same as no confirm: the app
   * would otherwise draw a dialog with a blank question in it. */
  const blank = pluginDecl(fullSpec({
    action: { icon: "hand", label: "Halt", needsSession: true,
      confirm: { label: "  ", message: "  " } as any },
  }))!;
  expect(blank.action!.confirm).toBeUndefined();
  expect(blank.action, "the button itself survives a bad confirm").toBeTruthy();
});

test("toolbarDefault (#574): a declared boolean crosses the wire, a bad value is dropped", () => {
  // false: the panel asks to stay hidden until the user pins it -- carried as-is
  const hidden = pluginDecl(fullSpec({
    panel: { ...fullSpec().panel!, toolbarDefault: false },
  }))!;
  expect(hidden.panel!.toolbarDefault).toBe(false);

  // true: shown by default on every device -- carried as-is, on an action surface
  const shown = pluginDecl(fullSpec({
    action: { ...fullSpec().action!, toolbarDefault: true },
  }))!;
  expect(shown.action!.toolbarDefault).toBe(true);

  // a tui entry declares it too
  const tui = pluginDecl(fullSpec({ tui: { ...fullSpec().tui!, toolbarDefault: false } }))!;
  expect(tui.tui!.toolbarDefault).toBe(false);

  // a NON-boolean is rejected: the key is absent, so the app's device-class
  // default stands rather than being driven by junk. The rest of the panel
  // survives (a bad visibility hint is not a reason to drop the whole surface).
  const bad = pluginDecl(fullSpec({
    panel: { ...fullSpec().panel!, toolbarDefault: "yes" as any },
  }))!;
  expect(bad.panel).toBeTruthy();
  expect("toolbarDefault" in bad.panel!).toBe(false);

  // absent by default: fullSpec declares none, so no surface carries the key
  const plain = pluginDecl(fullSpec())!;
  expect("toolbarDefault" in plain.panel!).toBe(false);
  expect("toolbarDefault" in plain.action!).toBe(false);
  expect("toolbarDefault" in plain.tui!).toBe(false);
});

test("panel badge (#581): a declared op crosses the wire, absent/blank is dropped", () => {
  // a panel that opens a page on tap AND wears a live chip polled off `badge`
  const d = pluginDecl(fullSpec({ panel: { ...fullSpec().panel!, badge: "model" } }))!;
  expect(d.panel!.badge).toBe("model");
  // no badge and a blank badge alike leave the field off, so the button carries
  // its label alone -- the fullSpec panel (no badge) is the plain case
  expect("badge" in pluginDecl(fullSpec())!.panel!).toBe(false);
  const blank = pluginDecl(fullSpec({ panel: { ...fullSpec().panel!, badge: "" } }))!;
  expect("badge" in blank.panel!).toBe(false);
  // an action badge obeys the same rule
  const noActionBadge = pluginDecl(fullSpec({ action: { ...fullSpec().action!, badge: "" } }))!;
  expect("badge" in noActionBadge.action!).toBe(false);
});

test("panel ops: the rpc op whitelist crosses the wire as strings, junk dropped", () => {
  const d = pluginDecl(fullSpec({ panel: { icon: "gear", label: "P", needsSession: false,
    html: async () => "x", ops: ["list", "create", 7 as any, "", "remove"] } }))!;
  expect(d.panel!.ops).toEqual(["list", "create", "remove"]);
  // no ops -> the key is absent (the page may call nothing)
  const none = pluginDecl(fullSpec({ panel: { icon: "gear", label: "P", needsSession: false,
    html: async () => "x" } }))!;
  expect(none.panel!.ops).toBeUndefined();
  // an ops list that is entirely junk is the same as none
  const junk = pluginDecl(fullSpec({ panel: { icon: "gear", label: "P", needsSession: false,
    html: async () => "x", ops: [1, null, ""] as any } }))!;
  expect(junk.panel!.ops).toBeUndefined();
});

test("tui surface: a terminal entry declares icon+label; no command (spawn is a future surface, #590)", () => {
  const d = pluginDecl(fullSpec())!;
  expect(d.tui).toEqual({ icon: "terminal", label: "Shell" });
  // a tui with no icon or no label is not a drawable entry: dropped
  const noIcon = pluginDecl(fullSpec({ tui: { icon: "", label: "Shell" } as any }))!;
  expect(noIcon.tui).toBeUndefined();
  const noLabel = pluginDecl(fullSpec({ tui: { icon: "terminal", label: "" } as any }))!;
  expect(noLabel.tui).toBeUndefined();
  /* #590: `command` was two answers to one question with no caller, so a
   * spec that still declares one must not put it on the wire. */
  const withCommand = pluginDecl(fullSpec({ tui: { icon: "terminal", label: "Shell", command: "htop" } as any }))!;
  expect("command" in withCommand.tui!).toBe(false);
});

test("the real tui builtin (#590): declares the terminal entry, is loaded by default", () => {
  const d = pluginDecl(tuiPlugin)!;
  expect(d.id).toBe("tui");
  expect(d.name).toBe("Terminal");
  expect(d.tui).toEqual({ icon: "terminal", label: "TUI" });
  // no rpc/panel/action: the transport is the existing term-* ws frames
  expect(d.action).toBeUndefined();
  expect(d.panel).toBeUndefined();
  // a builtin: a real engine carries it with no deps wiring
  expect(loadPlugins().some((p) => p.id === "tui")).toBe(true);
});

test("panel dock 'page' (B3): pluginDecl copies it through for the chromeless overlay", () => {
  const spec: PluginSpec = {
    id: "demo-page", name: "DemoPage", version: 1,
    panel: { icon: "folder", label: "Demo", needsSession: true, dock: "page",
      html: async () => "<!doctype html><title>x</title>", ops: ["a", "b"] },
  };
  const d = pluginDecl(spec)!;
  expect(d.panel!.dock).toBe("page");
  expect(d.panel!.ops).toEqual(["a", "b"]);
  // still no html on the wire (functions never cross): only the static shape
  expect((d.panel as any).html).toBeUndefined();
});

test("the real git builtin (B3): a page-dock panel plugin with its read ops, loaded by default", () => {
  const d = pluginDecl(gitPlugin())!;
  expect(d.id).toBe("git");
  expect(d.name).toBe("Git");
  // a sandboxed panel now, not the retired appPanel (which is gone from the spec)
  expect(d.panel).toBeTruthy();
  expect(d.panel!.icon).toBe("gitbranch");
  expect(d.panel!.label).toBe("Git");
  expect(d.panel!.needsSession).toBe(true);
  expect(d.panel!.dock).toBe("page");
  expect(d.panel!.ops).toEqual(["pane", "patch", "show", "change", "branches", "log", "compare"]);
  expect(loadPlugins().some((p) => p.id === "git")).toBe(true);
});

test("the real files builtin (B3): a page-dock panel plugin with its read ops, loaded by default", () => {
  const d = pluginDecl(filesPlugin())!;
  expect(d.id).toBe("files");
  expect(d.name).toBe("Files");
  expect(d.panel).toBeTruthy();
  expect(d.panel!.icon).toBe("folder");
  expect(d.panel!.label).toBe("Files");
  expect(d.panel!.needsSession).toBe(true);
  expect(d.panel!.dock).toBe("page");
  expect(d.panel!.ops).toEqual(["list", "read", "git", "diff", "raw"]);
  expect(loadPlugins().some((p) => p.id === "files")).toBe(true);
});

test("the real stop builtin: declares the interrupt action and its confirm", () => {
  const spec = stopPlugin(fakeStopCore());
  const d = pluginDecl(spec)!;
  expect(d.id).toBe("stop");
  expect(d.action).toEqual({
    icon: "hand",
    label: "Stop",
    needsSession: true,
    run: "interrupt",
    confirm: {
      label: "Send Ctrl-C",
      message: "Whatever it is doing stops where it is, and that cannot be undone.",
    },
  });
  // H2 bug fix: the decl's run op EXISTS in the rpc map now (it used to 404)
  expect(typeof spec.rpc?.[spec.action!.run!]).toBe("function");
  expect(loadPlugins().some((p) => p.id === "stop")).toBe(true);
});

test("stop rpc.interrupt fires the core command and gates on a live pane", async () => {
  const hit: string[] = [];
  // has() is true only for the live pane; a missing OR dead pane fails the gate.
  const spec = stopPlugin(fakeStopCore({
    has: (id) => id === "w1:p1",
    command: async (id) => { hit.push(id); },
  }));
  await expect(spec.rpc!.interrupt({ session: null, agent: null }, undefined))
    .rejects.toThrow(/needs a session/);
  // consolidated wording: a missing OR dead pane both read "no live pane" now
  // (the dispatch does not surface the "no such session" vs dead distinction)
  await expect(spec.rpc!.interrupt({ session: "w9:p9", agent: null }, undefined))
    .rejects.toThrow(/no live pane for that session/);
  await expect(spec.rpc!.interrupt({ session: "w1:p1", agent: null }, undefined))
    .resolves.toEqual({ ok: true });
  expect(hit).toEqual(["w1:p1"]);
});

test("declarePlugins: a spec whose HOOK throws still yields a clean decl list", () => {
  // the whole fail-safe premise: declaring reads static fields, so a throwing
  // render/rpc cannot abort the list. Mix a good spec, a hook-throwing spec, and
  // an undeclarable one; the list holds exactly the two declarable ids.
  const throwing = fullSpec({ id: "throwing" });
  const good = fullSpec({ id: "good" });
  const bad = fullSpec({ id: "Bad Id" }); // undeclarable
  const decls = declarePlugins([good, throwing, bad]);
  expect(decls.map((d) => d.id)).toEqual(["good", "throwing"]);
});

test("declarePlugins: ONE plugin whose composer builder throws does not blank the others", () => {
  /* THE FAILURE THIS FILE EXISTS FOR. The composer is the one surface built
   * from live state, so it is the one that can throw at declare time -- and the
   * composer is the row of controls under his message box. A builder that threw
   * and took the list with it would leave every device with a bare composer and
   * no explanation, on every engine that loaded that plugin. It drops its own
   * surface and nothing else. */
  const boom = fullSpec({ id: "boom", composer: () => { throw new Error("state was half-loaded"); } });
  const fine = fullSpec({ id: "fine" });
  const decls = declarePlugins([boom, fine]);
  expect(decls.map((d) => d.id)).toEqual(["boom", "fine"]);
  expect(decls[0].composer, "the throwing builder's own surface is gone").toBeUndefined();
  expect(decls[0].panel, "and the rest of that plugin still declares").toBeTruthy();
  expect(decls[1].composer, "the plugin BESIDE it kept its composer").toBeTruthy();
});

test("declarePlugins: an empty list declares an empty list, not a throw", () => {
  expect(declarePlugins([])).toEqual([]);
});

test("loadPlugins is an array, and the test fixture loads only under the env gate", () => {
  /* CYC_PLUGINS_TEST is read INSIDE loadPlugins on every call -- it is the
   * module's own switch, not a value captured at import -- so setting it around
   * one call is the injection seam this registry has, and the finally puts the
   * process back exactly as it was. */
  expect(Array.isArray(loadPlugins())).toBe(true);
  const had = process.env.CYC_PLUGINS_TEST;
  try {
    delete process.env.CYC_PLUGINS_TEST;
    expect(loadPlugins().some((p) => p.id === "fixture")).toBe(false);
    process.env.CYC_PLUGINS_TEST = "1";
    const fx = loadPlugins().find((p) => p.id === "fixture");
    expect(fx, "CYC_PLUGINS_TEST should inject the fixture plugin").toBeTruthy();
    expect(pluginDecl(fx!)).not.toBeNull();
  } finally {
    if (had === undefined) delete process.env.CYC_PLUGINS_TEST;
    else process.env.CYC_PLUGINS_TEST = had;
  }
});

test("the kill switch: CYC_PLUGINS_OFF declares NOTHING, not a smaller list", () => {
  /* The production revert lever (#590): an engine that declares no plugins gets
   * a core-only bar -- no Context, TUI, Git, Files, Model or Crons button at
   * all. Same read-per-call seam as the fixture gate above. */
  expect(loadPlugins().length).toBeGreaterThan(0);
  const had = process.env.CYC_PLUGINS_OFF;
  try {
    process.env.CYC_PLUGINS_OFF = "1";
    expect(loadPlugins()).toEqual([]);
    expect(declarePlugins(loadPlugins())).toEqual([]);
  } finally {
    if (had === undefined) delete process.env.CYC_PLUGINS_OFF;
    else process.env.CYC_PLUGINS_OFF = had;
  }
});

/* ====================== part 2: the routes those decls describe ============ */

/* THE BUDGETS, SHORTENED AT FILE SCOPE. Every route test below runs against
 * these numbers; production sets none of them (routes/plugin.ts). The refresh
 * floor is generous enough that a back-to-back request is inside it even on a
 * loaded box, and short enough that waiting for the window to open is a quarter
 * of a second rather than five. */
const FLOOR_MS = 250;
const POLL_MS = 120;
const REFRESH_MS = 400;
const SAVED_ENV = {
  floor: process.env.CYC_PLUGIN_REFRESH_FLOOR_MS,
  poll: process.env.CYC_PLUGIN_CARD_POLL_MS,
  refresh: process.env.CYC_PLUGIN_CARD_REFRESH_MS,
  hook: process.env.CYC_PLUGIN_HOOK_MS,
};
process.env.CYC_PLUGIN_REFRESH_FLOOR_MS = String(FLOOR_MS);
process.env.CYC_PLUGIN_CARD_POLL_MS = String(POLL_MS);
process.env.CYC_PLUGIN_CARD_REFRESH_MS = String(REFRESH_MS);
process.env.CYC_PLUGIN_HOOK_MS = String(POLL_MS);

/* ONE WIRING FOR THE FILE, for the two things the routes read out of live
 * engine state: the session an rpc resolves its agent id from (H2), and the
 * data dir a two-axis state record lands in. The decl half above touches
 * neither, so it runs whether this is up or not. */
let core: WireCore;
beforeAll(async () => {
  core = await wireCore({ with: ["sessions"] });
  await until(() => !!core.byHandle(PANE), { what: "the pane to become a session" });
});
afterAll(async () => {
  await core?.stop();
  for (const [k, v] of [
    ["CYC_PLUGIN_REFRESH_FLOOR_MS", SAVED_ENV.floor],
    ["CYC_PLUGIN_CARD_POLL_MS", SAVED_ENV.poll],
    ["CYC_PLUGIN_CARD_REFRESH_MS", SAVED_ENV.refresh],
    ["CYC_PLUGIN_HOOK_MS", SAVED_ENV.hook],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let http: ServedRoutes | null = null;
afterEach(() => {
  http?.stop();
  http = null;
  /* The card throttle remembers bodies in a module-level map keyed by plugin
   * id. Every test below mints its own id, so this is belt and braces rather
   * than load bearing -- but a file that served two route tables in one process
   * and answered the second from the first one's cache is exactly the kind of
   * cross-test leak this suite exists to not have. */
  resetCardCache();
});

/** A real Bun.serve on port 0 over the REAL pluginRoutes group and these specs. */
function serve(specs: PluginSpec[]): ServedRoutes {
  http = serveRoutes({
    groups: [pluginRoutes],
    ctx: { plugins: () => specs, pluginById: (id) => specs.find((p) => p.id === id) },
  });
  return http;
}

/* Ids are minted per test so no two tests share the throttle's cache entry or
 * the state record's directory. PLUGIN_ID_RE: lowercase, digits, dashes. */
let ids = 0;
const freshId = (what: string) => `${what}-${++ids}`;

/** A promise the TEST decides when to settle: how a deadline is raced without
 *  anybody sleeping. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------------------------------------------------------------- the card

test("card route: renders the plugin's html with ageMs and dedupe", async () => {
  const id = freshId("card");
  let n = 0;
  const s = serve([{ id, name: "Card", version: 1, card: { title: "C", refreshFloorS: 5,
    dedupe: () => "fixture-key",
    render: async () => ({ html: `<b>fixture card ${++n}</b>`, ageMs: 1234 }) } }]);
  const r = await s.get(`/plugin/${id}/card`);
  expect(r.status).toBe(200);
  const j = await r.json() as any;
  expect(j.ok).toBe(true);
  expect(j.html).toContain("fixture card");
  expect(j.ageMs).toBe(1234);
  expect(j.dedupe).toBe("fixture-key");
});

test("card route: a render's freshness flags and height are copied through (#577)", async () => {
  /* The app turns `stale` into "(retrying)" and `throttled` into "(check
   * throttled)" and dims the face; `height` is the exact CSS px a no-JS frame
   * cannot measure for itself. All three are the card's own answer about its
   * own data, so the route may only carry them, never invent them. */
  const id = freshId("card");
  const s = serve([{ id, name: "C", version: 1, card: { title: "C", refreshFloorS: 5,
    render: async () => ({ html: "x", ageMs: null, height: 210, stale: true, throttled: true }) } }]);
  const j = await (await s.get(`/plugin/${id}/card`)).json() as any;
  expect(j).toEqual({ ok: true, html: "x", ageMs: null, height: 210, stale: true, throttled: true });

  // absent flags leave the keys OFF, so "not stale" is not a field the app has
  // to know to read as false
  const id2 = freshId("card");
  const s2 = serve([{ id: id2, name: "C", version: 1, card: { title: "C", refreshFloorS: 5,
    render: async () => ({ html: "y", ageMs: 5 }) } }]);
  expect(await (await s2.get(`/plugin/${id2}/card`)).json()).toEqual({ ok: true, html: "y", ageMs: 5 });
});

test("card route: unknown plugin id, and a plugin with no card, are both 404s", async () => {
  const id = freshId("nocard");
  const s = serve([{ id, name: "NoCard", version: 1 }]);
  for (const path of [`/plugin/nope/card`, `/plugin/${id}/card`]) {
    const r = await s.get(path);
    expect(r.status, `${path} should be a 404, not a 500`).toBe(404);
    expect((await r.json() as any).ok).toBe(false);
  }
});

test("card route: an oversize render is refused 413 with the byte count", async () => {
  const id = freshId("bigcard");
  const s = serve([{ id, name: "Big", version: 1, card: { title: "B", refreshFloorS: 5,
    render: async () => ({ html: "x".repeat(CARD_HTML_MAX_BYTES + 16), ageMs: null }) } }]);
  const r = await s.get(`/plugin/${id}/card`);
  expect(r.status).toBe(413);
  const j = await r.json() as any;
  expect(j.ok).toBe(false);
  expect(j.error).toMatch(/too large.*\d+ bytes/);
  // the number in the sentence is the real byte count, not the character count
  expect(j.error).toContain(String(CARD_HTML_MAX_BYTES + 16));
});

test("card route: a throwing dedupe costs the card its key, never its body", async () => {
  /* dedupe decides whether the app is already showing this card. It is a hook
   * like any other, so it can throw; when it does the card must still render,
   * because a card nobody can see is worse than a card drawn twice. */
  const id = freshId("card");
  const s = serve([{ id, name: "C", version: 1, card: { title: "C", refreshFloorS: 5,
    dedupe: () => { throw new Error("dedupe boom"); },
    render: async () => ({ html: "still here", ageMs: null }) } }]);
  const j = await (await s.get(`/plugin/${id}/card`)).json() as any;
  expect(j.ok).toBe(true);
  expect(j.html).toBe("still here");
  expect("dedupe" in j, "a dedupe that threw must not put a key on the wire").toBe(false);
});

test("card route: refresh floor throttles a re-render, then opens after the floor", async () => {
  const id = freshId("card");
  let n = 0;
  const s = serve([{ id, name: "C", version: 1, card: { title: "C", refreshFloorS: 5,
    render: async () => ({ html: `render ${++n}`, ageMs: null }) } }]);
  // a plain poll renders fresh (the count climbs each call)
  const a = await (await s.get(`/plugin/${id}/card`)).json() as any;
  expect(a.html).toBe("render 1");
  // an immediate refresh is throttled to the last body: the SAME render count
  const b = await (await s.get(`/plugin/${id}/card?refresh=1`)).json() as any;
  expect(b.html, "a refresh inside the floor must serve the cached body unchanged").toBe(a.html);

  /* Past the floor a refresh renders fresh again. Polled rather than slept:
   * what is being waited for is a wall-clock window the route opens on its own,
   * and the poll is what makes the assertion "it opened" rather than "it had
   * opened by the time I woke up". */
  let last = "";
  await until(async () => {
    last = ((await (await s.get(`/plugin/${id}/card?refresh=1`)).json()) as any).html;
    return last !== a.html;
  }, { timeoutMs: 4 * FLOOR_MS, what: "the refresh floor to open" });
  expect(last, "a refresh past the floor must re-render").not.toBe(a.html);
});

test("card route: a plain POLL always renders fresh, so the floor is not a poll cache", async () => {
  /* Only the refresh ARROW is throttled. A plain poll renders fresh and resets
   * the window, because the poll is the app's own cadence and a card that
   * answered it from a cache would be a card that never updates. */
  const id = freshId("card");
  let n = 0;
  const s = serve([{ id, name: "C", version: 1, card: { title: "C", refreshFloorS: 5,
    render: async () => ({ html: `render ${++n}`, ageMs: null }) } }]);
  expect(((await (await s.get(`/plugin/${id}/card`)).json()) as any).html).toBe("render 1");
  expect(((await (await s.get(`/plugin/${id}/card`)).json()) as any).html).toBe("render 2");
});

test("card route: the refresh arrow is threaded through to render() as force (#570)", async () => {
  const id = freshId("card");
  const seen: boolean[] = [];
  const s = serve([{ id, name: "C", version: 1, card: { title: "C", refreshFloorS: 5,
    render: async (o) => { seen.push(!!o?.force); return { html: `force=${!!o?.force}`, ageMs: null }; } } }]);
  // a plain poll renders with force=false: it reads the cached reading
  const a = await (await s.get(`/plugin/${id}/card`)).json() as any;
  expect(a.html, "a plain poll must render with force=false").toBe("force=false");
  /* A refresh past the floor renders with force=true, so the card re-derives
   * its data from source (the usage card's real limitsNow re-poll). Without the
   * threading the button re-rendered the SAME stale reading and looked dead. */
  await until(async () => {
    await s.get(`/plugin/${id}/card?refresh=1`);
    return seen.includes(true);
  }, { timeoutMs: 4 * FLOOR_MS, what: "a forced render past the floor" });
  expect(seen[0]).toBe(false);
  expect(seen.at(-1)).toBe(true);
});

test("card route: a render past the POLL budget is refused, and the same render is SERVED on a refresh (#577)", async () => {
  /* The split is the whole point: a plain poll reads a cached number and is
   * given the short budget, a forced refresh goes upstream (two 10s requests
   * for the usage card) and is given the long one. Before #577 both raced the
   * generic 2s and the refresh button killed its own render.
   *
   * ONE deferred render serves both requests, so this is not two different
   * renders being timed differently: it is literally the same outstanding work,
   * refused under one budget and served under the other. */
  const id = freshId("slowcard");
  const late = deferred<{ html: string; ageMs: number | null }>();
  const s = serve([{ id, name: "Slow", version: 1,
    card: { title: "S", refreshFloorS: 5, render: () => late.promise } }]);

  const t0 = Date.now();
  const poll = await s.get(`/plugin/${id}/card`);
  const dt = Date.now() - t0;
  expect(poll.status, "a render past the poll deadline must be refused, not awaited").toBe(500);
  expect((await poll.json() as any).ok).toBe(false);
  expect(dt, "the request must come back around the poll deadline").toBeLessThan(REFRESH_MS);

  // the same work, now finishing, under the longer refresh budget
  const forced = s.get(`/plugin/${id}/card?refresh=1`);
  late.resolve({ html: "on time", ageMs: null });
  const res = await forced;
  expect(res.status, "the longer refresh budget refused a render it had time for").toBe(200);
  expect((await res.json() as any).html).toBe("on time");
});

test("card route: a render past EVEN the refresh budget is refused, and the routes keep answering (#577)", async () => {
  const id = freshId("hungcard");
  const never = deferred<{ html: string; ageMs: number | null }>();
  const alive = freshId("card");
  const s = serve([
    { id, name: "Hung", version: 1, card: { title: "H", refreshFloorS: 5, render: () => never.promise } },
    { id: alive, name: "Fine", version: 1, card: { title: "F", refreshFloorS: 5,
      render: async () => ({ html: "fine", ageMs: null }) } },
  ]);

  const t0 = Date.now();
  const r = await s.get(`/plugin/${id}/card?refresh=1`);
  const dt = Date.now() - t0;
  expect(r.status).toBe(500);
  expect((await r.json() as any).error).toMatch(/exceeded/);
  expect(dt, "the request must come back at the refresh deadline, not hang").toBeGreaterThanOrEqual(REFRESH_MS - 25);

  /* A plugin that overruns answers THAT ONE request badly and touches nothing
   * else: the engine is not a plugin's hostage. */
  expect((await s.get(`/plugin/${alive}/card`)).status).toBe(200);
  never.resolve({ html: "far too late", ageMs: null });
});

// --------------------------------------------------------------- the panel

test("panel route: serves the page html as text/html under the 1MB cap", async () => {
  const id = freshId("panel");
  const s = serve([{ id, name: "P", version: 1, panel: { icon: "gear", label: "P", needsSession: true,
    html: async () => "<!doctype html><title>fixture</title><body>panel</body>" } }]);
  const r = await s.get(`/plugin/${id}/panel`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(await r.text()).toContain("panel");
});

test("panel route: unknown id, oversize page and a throwing hook are 404/413/500", async () => {
  const big = freshId("panel");
  const boom = freshId("panel");
  const s = serve([
    { id: big, name: "Big", version: 1, panel: { icon: "g", label: "B", needsSession: false,
      html: async () => "x".repeat(PANEL_HTML_MAX_BYTES + 16) } },
    { id: boom, name: "Boom", version: 1, panel: { icon: "g", label: "B", needsSession: false,
      html: async () => { throw new Error("panel boom"); } } },
  ]);
  expect((await s.get(`/plugin/nope/panel`)).status).toBe(404);
  const over = await s.get(`/plugin/${big}/panel`);
  expect(over.status).toBe(413);
  expect(await over.text()).toContain(String(PANEL_HTML_MAX_BYTES + 16));
  const threw = await s.get(`/plugin/${boom}/panel`);
  expect(threw.status).toBe(500);
  expect(await threw.text()).toContain("panel boom");
});

// ----------------------------------------------------------------- the rpc

/** The fixture whose rpc map covers every answer the route has to shape. */
function rpcSpec(id: string, seen: Array<{ op: string; ctx: unknown; args: unknown }>): PluginSpec {
  return {
    id, name: "Rpc", version: 1,
    rpc: {
      echo: async (ctx, args) => { seen.push({ op: "echo", ctx, args }); return { session: ctx.session, args }; },
      agent: async (ctx) => { seen.push({ op: "agent", ctx, args: null }); return { agent: ctx.agent }; },
      boom: async () => { throw new Error("fixture rpc boom"); },
      // a 400-shaped refusal: "you asked for rung 9" is not an engine fault
      refuse: async () => { throw Object.assign(new Error("no such rung"), { status: 400 }); },
      big: async () => ({ blob: "x".repeat(RPC_REPLY_MAX_BYTES + 16) }),
    },
  };
}

test("rpc route: an op runs with the session attached and returns its json", async () => {
  const id = freshId("rpc");
  const seen: Array<{ op: string; ctx: any; args: unknown }> = [];
  const s = serve([rpcSpec(id, seen)]);
  const r = await s.post(`/plugin/${id}/rpc/echo`, { session: PANE, args: { a: 1 } });
  expect(r.status).toBe(200);
  const j = await r.json() as any;
  expect(j.ok).toBe(true);
  expect(j.result.session).toBe(PANE);
  expect(j.result.args).toEqual({ a: 1 });
});

test("rpc route: the resolved AGENT id rides the ctx, and an unknown session mints nothing (H2)", async () => {
  /* A data-owning plugin keys its records on the stable agent id (crons does),
   * so the route resolves one for the attached session. Resolved, never minted:
   * a made-up session id must not leave a fresh agent directory behind, or any
   * client could fill the disk with agent trees by POSTing nonsense. */
  const id = freshId("rpc");
  const seen: Array<{ op: string; ctx: any; args: unknown }> = [];
  const s = serve([rpcSpec(id, seen)]);
  const mine = core.byHandle(PANE)!.agentId;
  expect(mine).toMatch(/^ag-/);

  const known = await (await s.post(`/plugin/${id}/rpc/agent`, { session: PANE })).json() as any;
  expect(known.result.agent, "the live session's stable agent id did not reach the op").toBe(mine);

  const before = (await readdir(agentsDir())).sort();
  const stranger = await (await s.post(`/plugin/${id}/rpc/agent`, { session: "w9:p99" })).json() as any;
  expect(stranger.result.agent, "an unknown session must resolve to null, not to an agent").toBeNull();
  expect((await readdir(agentsDir())).sort(), "an unknown session minted an agent directory").toEqual(before);

  // no session at all is the same answer, for a badge poll on the chat list
  const none = await (await s.post(`/plugin/${id}/rpc/agent`, {})).json() as any;
  expect(none.result.agent).toBeNull();
});

test("rpc route: an unknown op, and an op on an unknown plugin, are 404s", async () => {
  const id = freshId("rpc");
  const s = serve([rpcSpec(id, [])]);
  for (const path of [`/plugin/${id}/rpc/nope`, `/plugin/nope/rpc/echo`]) {
    const r = await s.post(path, {});
    expect(r.status, `${path} should be a 404`).toBe(404);
    expect((await r.json() as any).ok).toBe(false);
  }
});

test("rpc route: a throwing op answers {ok:false} 500, and the next request still works", async () => {
  const id = freshId("rpc");
  const seen: Array<{ op: string; ctx: any; args: unknown }> = [];
  const s = serve([rpcSpec(id, seen)]);
  const r = await s.post(`/plugin/${id}/rpc/boom`, {});
  expect(r.status).toBe(500);
  expect((await r.json() as any).ok).toBe(false);
  // the route is still answering after a hook threw
  expect((await s.post(`/plugin/${id}/rpc/echo`, { args: 1 })).status).toBe(200);
  expect(s.logs.some((l) => l.event === "plugin.rpc.fail"),
    "a hook that threw must leave a line: a failure nobody can see is one nobody can fix").toBe(true);
});

test("rpc route: an op that refuses an ARGUMENT answers with its own status, not 500", async () => {
  /* The reply-dials rung refusal is the live instance: "you asked for rung 9"
   * is a client mistake and reads to the app as a 400, where a 500 reads as
   * "the engine is broken". */
  const id = freshId("rpc");
  const s = serve([rpcSpec(id, [])]);
  const r = await s.post(`/plugin/${id}/rpc/refuse`, {});
  expect(r.status).toBe(400);
  expect((await r.json() as any).error).toContain("no such rung");
});

test("rpc route: a body that is not JSON is a 400, and an EMPTY body is fine", async () => {
  const id = freshId("rpc");
  const seen: Array<{ op: string; ctx: any; args: unknown }> = [];
  const s = serve([rpcSpec(id, seen)]);
  const bad = await s.fetch(`/plugin/${id}/rpc/echo`, { method: "POST", body: "{not json" });
  expect(bad.status).toBe(400);
  // a badge poll sends no body at all; the op runs with a null session
  const empty = await s.fetch(`/plugin/${id}/rpc/echo`, { method: "POST", body: "" });
  expect(empty.status).toBe(200);
  expect((await empty.json() as any).result.session).toBeNull();
});

test("rpc route: args over the in-cap are refused 413 BEFORE the hook runs", async () => {
  const id = freshId("rpc");
  const seen: Array<{ op: string; ctx: any; args: unknown }> = [];
  const s = serve([rpcSpec(id, seen)]);
  const big = JSON.stringify({ args: "x".repeat(RPC_ARGS_MAX_BYTES + 16) });
  const r = await s.fetch(`/plugin/${id}/rpc/echo`, { method: "POST",
    headers: { "content-type": "application/json" }, body: big });
  expect(r.status).toBe(413);
  expect(await r.json()).toEqual({ error: "body too large", max: RPC_ARGS_MAX_BYTES });
  expect(seen, "the cap must be enforced before the hook sees a byte").toEqual([]);
});

test("rpc route: a reply over the out-cap is refused 413", async () => {
  const id = freshId("rpc");
  const s = serve([rpcSpec(id, [])]);
  const r = await s.post(`/plugin/${id}/rpc/big`, {});
  expect(r.status).toBe(413);
  expect((await r.json() as any).error).toMatch(/too large.*\d+ bytes/);
});

test("rpc reply cap is 16 MB (arch 3.3): a whole diff/file comes back in one call", () => {
  // The ONE reply cap, raised 1 MB -> 16 MB so git/files return a whole diff or
  // file body in a single cyc.call. args and the html caps are untouched.
  expect(RPC_REPLY_MAX_BYTES).toBe(16 * 1024 * 1024);
  expect(RPC_ARGS_MAX_BYTES).toBe(256 * 1024);
  expect(PANEL_HTML_MAX_BYTES).toBe(1024 * 1024);
});

test("rpc route: a hook that HANGS is refused at its deadline, engine unhurt", async () => {
  const id = freshId("rpc");
  const never = deferred<unknown>();
  const s = serve([{ id, name: "Hang", version: 1, rpc: {
    hang: () => never.promise as Promise<unknown>,
    fine: async () => ({ ok: true }),
  } }]);
  const r = await s.post(`/plugin/${id}/rpc/hang`, {});
  expect(r.status).toBe(500);
  expect((await r.json() as any).error).toMatch(/exceeded/);
  expect((await s.post(`/plugin/${id}/rpc/fine`, {})).status).toBe(200);
  never.resolve(null);
});

test("rpc route: GET is not a way in", async () => {
  // every op is a POST; a GET falls through to the 404 fallback rather than
  // running a mutation somebody could put in an <img src>
  const id = freshId("rpc");
  const s = serve([rpcSpec(id, [])]);
  expect((await s.get(`/plugin/${id}/rpc/echo`)).status).toBe(404);
});

// --------------------------------------------------------------- the state

test("state route: the three-answer docstate shape, engine-level key", async () => {
  const id = freshId("state");
  const s = serve([{ id, name: "S", version: 1 }]);
  // never saved: {ok, saved:false, data:null}
  expect(await (await s.get(`/plugin/${id}/state`)).json())
    .toEqual({ ok: true, saved: false, data: null });
  // save
  const saved = await (await s.post(`/plugin/${id}/state`, { order: [3, 1, 2] })).json() as any;
  expect(saved.ok).toBe(true);
  // read back: {ok, saved:true, data}
  const after = await (await s.get(`/plugin/${id}/state`)).json() as any;
  expect(after.ok).toBe(true);
  expect(after.saved).toBe(true);
  expect(after.data).toEqual({ order: [3, 1, 2] });
  // and it is on disk in the ENGINE-scoped plugin dir (the two-axis rule)
  expect(await Bun.file(join(core.dir, "plugins", id, "state.json")).exists()).toBe(true);
});

test("state route: a session key stores separately, under that agent's own dir", async () => {
  const id = freshId("state");
  const s = serve([{ id, name: "S", version: 1 }]);
  // the app names the conversation by its agent id, never by the pane
  const aid = core.byHandle(PANE)!.agentId;
  await s.post(`/plugin/${id}/state?session=${encodeURIComponent(aid)}`, { scoped: true });
  // the engine-level key is untouched by a session write
  expect(((await (await s.get(`/plugin/${id}/state`)).json()) as any).saved).toBe(false);
  const scoped = await (await s.get(`/plugin/${id}/state?session=${encodeURIComponent(aid)}`)).json() as any;
  expect(scoped.data).toEqual({ scoped: true });
  /* the design's two-axis rule, on the disk: session-keyed plugin data lives
   * under the AGENT, so it follows the conversation across a re-key rather than
   * being keyed to a pane id that will be reused. */
  expect(await Bun.file(join(core.dir, "agents", aid, "plugins", id, "state.json")).exists()).toBe(true);
});

test("state route: refused for an unknown plugin (not a free key-value store)", async () => {
  const s = serve([{ id: freshId("state"), name: "S", version: 1 }]);
  const r = await s.post(`/plugin/nope/state`, {});
  expect(r.status).toBe(404);
  expect((await r.json() as any).ok).toBe(false);
  expect((await s.get(`/plugin/nope/state`)).status).toBe(404);
});

test("state route: an oversize save is refused 413 with the number, nothing written", async () => {
  const id = freshId("state");
  const s = serve([{ id, name: "S", version: 1 }]);
  const big = JSON.stringify({ blob: "x".repeat(256 * 1024 + 16) });
  const r = await s.fetch(`/plugin/${id}/state`, { method: "POST",
    headers: { "content-type": "application/json" }, body: big });
  expect(r.status).toBe(413);
  // and nothing was written
  expect(((await (await s.get(`/plugin/${id}/state`)).json()) as any).saved).toBe(false);
});

test("state route: a bad session key is refused before it can name a file", async () => {
  /* The key becomes a directory name. A slash or a dot-dot is refused rather
   * than sanitised, so no record can escape the plugin's own tree. */
  const id = freshId("state");
  const s = serve([{ id, name: "S", version: 1 }]);
  for (const bad of ["../escape", "a/b", "with space", "x".repeat(129), ""]) {
    const r = await s.get(`/plugin/${id}/state?session=${encodeURIComponent(bad)}`);
    expect(r.status, `session=${JSON.stringify(bad)} should be refused`).toBe(400);
  }
});

test("state route: null is a save, and it round-trips as a saved null", async () => {
  /* docstate's contract: a document that saved `null` HAS state, and the app
   * must be able to tell that from "never saved". */
  const id = freshId("state");
  const s = serve([{ id, name: "S", version: 1 }]);
  expect((await s.post(`/plugin/${id}/state`, null)).status).toBe(200);
  const back = await (await s.get(`/plugin/${id}/state`)).json() as any;
  expect(back).toMatchObject({ ok: true, saved: true, data: null });
  // a saved record is dated; an unsaved one has nothing to date
  expect(typeof back.savedAt).toBe("number");
});
