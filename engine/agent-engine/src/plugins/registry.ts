/* THE PLUGIN REGISTRY, AND WHAT OF IT CROSSES THE WIRE.
 *
 * #479. "engines declare plugins, the app renders them." This file is the
 * engine end of that sentence: the shape a plugin is written in (PluginSpec),
 * the list this engine actually loaded (loadPlugins), and the ONE thing that
 * goes to the app -- a declaration with the FUNCTIONS TAKEN OUT (pluginDecl).
 *
 * WHY THE DECL IS A SEPARATE SHAPE FROM THE SPEC, drawn once here so nothing
 * downstream has to decide it again. A PluginSpec holds render/rpc/html/dedupe
 * -- code that reads this engine's own limits, schedules, files. None of that
 * can run on the app, and none of it should even be describable there: the app
 * asks for a card over HTTP (/plugin/<id>/card) and renders the answer, it does
 * not hold the function that made it. So the frame carries only the static
 * fields a toolbar or a card frame needs to draw its chrome -- title, icon,
 * label, refresh floor, whether a toolbar entry shows by default (#574) -- and
 * the code stays here where the data is.
 *
 * SHAPED LIKE loadServices (services.ts:1213) AND declareTabs (tabs.ts:113):
 * a built-ins table compiled in, a decl derived from it for the wire, and an
 * absent declaration meaning "old engine, the app falls back". Loading external
 * plugin directories (CYC_PLUGINS_DIR, manifest validation, dynamic import) is
 * a DEFERRED step and changes nothing on the wire -- only where loadPlugins
 * reads from.
 *
 *   bun test agent-engine/src/plugins/registry.test.ts
 */

import { usageCardPlugin, type UsagePollDeps } from "./usage-card/index.ts";
import { cronsPlugin } from "./crons/index.ts";
import { searchPlugin } from "./search/index.ts";
import { modelIndicatorPlugin, type ModelDeps } from "./model-indicator/index.ts";
import { personaPlugin } from "./persona/index.ts";
import { replyDialsPlugin, type DialsDeps } from "./reply-dials/index.ts";
import { ctxPlugin } from "./ctx/index.ts";
import { tuiPlugin } from "./tui/index.ts";
import { gitPlugin } from "./git/index.ts";
import { filesPlugin } from "./files/index.ts";
import { stopPlugin } from "./stop/index.ts";
import type { PluginCore } from "./platform/core.ts";

/* THE SPEC/DECL VOCABULARY AND THE CAPS ARE A PURE LEAF (platform/spec.ts). This
 * file is the registry; a plugin file imports the shape it is written in from
 * the leaf, never from here, so there is no registry.ts <-> plugin cycle. */
import {
  PLUGIN_ID_RE,
  CARD_REFRESH_FLOOR_MIN_S,
  MENU_MAX_ITEMS,
  MENU_ITEM_TEXT_MAX,
  SLIDER_MAX_STEPS,
  WIDGET_KEY_RE,
  type ComposerWidgetDecl,
  type PluginSpec,
  type PluginDecl,
} from "./platform/spec.ts";
/* One composer widget, validated for the wire. Returns null (the caller drops
 * it) when a cap is exceeded or a field is the wrong shape, because a widget
 * the app cannot render faithfully is one it should not render at all. */
function composerDecl(w: unknown): ComposerWidgetDecl | null {
  if (!w || typeof w !== "object") return null;
  const a = w as Record<string, unknown>;
  const icon = typeof a.icon === "string" ? a.icon : "";
  const label = typeof a.label === "string" ? a.label : "";
  if (!icon || !label) return null;
  /* `key` (which dial). A present-but-malformed key is a drop, not a silent
   * strip: a widget whose key is junk cannot round-trip a pick faithfully. */
  const hasKey = a.key !== undefined && a.key !== null;
  const key = typeof a.key === "string" ? a.key : "";
  if (hasKey && !WIDGET_KEY_RE.test(key)) return null;
  if (a.type === "menu") {
    if (!Array.isArray(a.items) || a.items.length === 0 || a.items.length > MENU_MAX_ITEMS) return null;
    const items: { text: string; insert: string }[] = [];
    for (const it of a.items) {
      if (!it || typeof it !== "object") return null;
      const text = typeof (it as any).text === "string" ? (it as any).text : "";
      const insert = typeof (it as any).insert === "string" ? (it as any).insert : "";
      if (!text || text.length > MENU_ITEM_TEXT_MAX) return null;
      items.push({ text, insert });
    }
    // key OPTIONAL on a menu: carried when a valid one is present, else omitted
    return hasKey ? { type: "menu", icon, label, key, items } : { type: "menu", icon, label, items };
  }
  if (a.type === "slider") {
    // key REQUIRED on a slider: a dial that cannot say which dial it is is dropped
    if (!key) return null;
    if (!Array.isArray(a.steps) || a.steps.length === 0 || a.steps.length > SLIDER_MAX_STEPS) return null;
    const steps: { n: number; name: string; hint?: string }[] = [];
    for (const s of a.steps) {
      if (!s || typeof s !== "object") return null;
      const n = Number((s as any).n);
      const name = typeof (s as any).name === "string" ? (s as any).name : "";
      if (!Number.isFinite(n) || !name) return null;
      const hint = typeof (s as any).hint === "string" ? (s as any).hint : undefined;
      steps.push(hint ? { n, name, hint } : { n, name });
    }
    /* `value` (the current rung). When present it must name a real step, else
     * the widget is dropped: a rail pointing at a rung it does not have is not
     * the dial the plugin declared. Absent is fine (an unset dial). */
    const hasValue = a.value !== undefined && a.value !== null;
    const value = Number((a as any).value);
    if (hasValue && (!Number.isFinite(value) || !steps.some((st) => st.n === value))) return null;
    return hasValue
      ? { type: "slider", icon, label, key, value, steps }
      : { type: "slider", icon, label, key, steps };
  }
  return null;
}

/* Derive the wire declaration for one spec, or null if the spec cannot be
 * declared honestly (bad id, no name, no version).
 *
 * IT NEVER CALLS A HOOK. Every field it reads is static; render/rpc/html/dedupe
 * are copied nowhere. That is the property the fail-safe rule rests on: a
 * plugin whose render throws still produces a clean decl, because building the
 * decl and running the plugin are different moments and only the second can
 * fail. A card/panel/composer that is itself malformed is DROPPED from the decl
 * (the plugin keeps its other surfaces), never allowed to abort the whole
 * list. */
export function pluginDecl(spec: PluginSpec): PluginDecl | null {
  if (!spec || typeof spec !== "object") return null;
  if (typeof spec.id !== "string" || !PLUGIN_ID_RE.test(spec.id)) return null;
  if (typeof spec.name !== "string" || !spec.name) return null;
  if (!Number.isFinite(spec.version)) return null;

  const decl: PluginDecl = { id: spec.id, name: spec.name, version: spec.version };

  if (spec.card && typeof spec.card.title === "string" && spec.card.title) {
    const floor = Number(spec.card.refreshFloorS);
    decl.card = {
      title: spec.card.title,
      refreshFloorS: Number.isFinite(floor) ? Math.max(CARD_REFRESH_FLOOR_MIN_S, floor) : CARD_REFRESH_FLOOR_MIN_S,
    };
  }
  if (spec.panel && typeof spec.panel.icon === "string" && spec.panel.icon &&
      typeof spec.panel.label === "string" && spec.panel.label) {
    const ops = Array.isArray(spec.panel.ops)
      ? spec.panel.ops.filter((o): o is string => typeof o === "string" && !!o)
      : [];
    decl.panel = {
      icon: spec.panel.icon,
      label: spec.panel.label,
      needsSession: spec.panel.needsSession === true,
      ...(ops.length ? { ops } : {}),
      ...(spec.panel.dock === "side" ? { dock: "side" as const }
        : spec.panel.dock === "page" ? { dock: "page" as const } : {}),
      ...(typeof spec.panel.badge === "string" && spec.panel.badge ? { badge: spec.panel.badge } : {}),
      ...(typeof spec.panel.toolbarDefault === "boolean" ? { toolbarDefault: spec.panel.toolbarDefault } : {}),
    };
  }
  if (spec.action && typeof spec.action.icon === "string" && spec.action.icon &&
      typeof spec.action.label === "string" && spec.action.label) {
    const rawConfirm = spec.action.confirm as unknown;
    const confirmObj = rawConfirm && typeof rawConfirm === "object" ? rawConfirm as Record<string, unknown> : null;
    const confirmLabel = typeof confirmObj?.label === "string" ? confirmObj.label.trim() : "";
    const confirmMessage = typeof confirmObj?.message === "string" ? confirmObj.message.trim() : "";
    // only label + message; extra keys (Escape remap, extra buttons) are dropped
    const confirm = confirmLabel && confirmMessage ? { label: confirmLabel, message: confirmMessage } : undefined;
    decl.action = {
      icon: spec.action.icon,
      label: spec.action.label,
      needsSession: spec.action.needsSession === true,
      ...(typeof spec.action.run === "string" && spec.action.run ? { run: spec.action.run } : {}),
      ...(typeof spec.action.badge === "string" && spec.action.badge ? { badge: spec.action.badge } : {}),
      ...(typeof spec.action.toolbarDefault === "boolean" ? { toolbarDefault: spec.action.toolbarDefault } : {}),
      ...(confirm ? { confirm } : {}),
    };
  }
  if (spec.tui && typeof spec.tui.icon === "string" && spec.tui.icon &&
      typeof spec.tui.label === "string" && spec.tui.label) {
    decl.tui = {
      icon: spec.tui.icon,
      label: spec.tui.label,
      ...(typeof spec.tui.toolbarDefault === "boolean" ? { toolbarDefault: spec.tui.toolbarDefault } : {}),
    };
  }
  /* The composer surface may be a live function (built from engine state). It is
   * the ONE field pluginDecl calls a hook to read, so it does it in try/catch: a
   * throwing builder drops the composer surface and keeps the rest of the decl,
   * the same fail-safe the malformed-surface drops obey. */
  if (spec.composer) {
    let raw: unknown[] | null = null;
    if (Array.isArray(spec.composer)) raw = spec.composer;
    else if (typeof spec.composer === "function") {
      try {
        const built = spec.composer();
        raw = Array.isArray(built) ? built : null;
      } catch (e) {
        console.error(`[plugins] composer builder threw for id=${JSON.stringify(spec.id)}: ${(e as Error)?.message}`);
        raw = null;
      }
    }
    if (raw) {
      const widgets = raw.map(composerDecl).filter((w): w is ComposerWidgetDecl => w !== null);
      if (widgets.length) decl.composer = widgets;
    }
  }
  return decl;
}

/* The whole loaded set, as declarations, in load order. A spec that cannot be
 * declared is dropped with a line so it is not silent. This is what the hello
 * burst carries. */
export function declarePlugins(specs: readonly PluginSpec[]): PluginDecl[] {
  const out: PluginDecl[] = [];
  for (const s of specs) {
    const d = pluginDecl(s);
    if (d) out.push(d);
    else console.error(`[plugins] dropped a plugin: id=${JSON.stringify((s as any)?.id)} is not declarable`);
  }
  return out;
}

/* The table this engine will actually use.
 *
 * Built-ins are compiled in, exactly like defaultServices(): the usage-card
 * plugin and the crons panel join this array. A test can add
 * a fixture plugin with real hooks by setting CYC_PLUGINS_TEST, the same way
 * CYC_SERVICES_FILE lets a test supply services -- prod never sets it, so the
 * fixture never loads outside a test. */
/* What the built-ins need wired to live engine state. A built-in whose data is
 * a module function (the usage card reads limitsNow) needs nothing here; one
 * that skins an engine INSTANCE (crons over the Schedules store) is handed its
 * seam so there is one store, not two. server.ts builds this and passes it. */
/* crons is the first FULL plugin (blueprint section 2): it takes the minimal
 * PluginHost, not a deps bag. The deps-bag seam survives only for VIEW
 * plugins (thin closures over live core state, section 3). */
/* `core` is the ONE typed PluginCore factory the composition root builds
 * (platform/core.ts): a migrated plugin takes it instead of a bespoke deps bag, and
 * its bag key leaves this type as it moves. End state: { core,
 * crons, dials } -- crons keeps its minimal host, dials the sanctioned residual. */
export type PluginContext = { core?: (id: string) => PluginCore; crons?: boolean; usage?: UsagePollDeps; search?: boolean; model?: ModelDeps; persona?: boolean; dials?: DialsDeps; ctx?: boolean; stop?: boolean };

export function loadPlugins(ctx: PluginContext = {}): PluginSpec[] {
  /* Kill switch: with CYC_PLUGINS_OFF=1 the engine declares no plugins. This is
   * the production revert lever for a plugin surface that fails the parity bar on
   * a real device while the code stays merged.
   *
   * WHAT IT NOW MEANS (#590). Since ctx/tui/git/files/persona/model/crons are all
   * plugins, an engine that declares none (this switch, or an OLD engine without
   * the code) gets a CORE-ONLY bar: no Context, TUI, Git, Files, Persona, Model or
   * Crons button at all. The switch no longer reverts those to a native face; it
   * REMOVES their toolbar entries. That is the #590 rule ("an engine that does not
   * declare the plugin shows no button for it"), and the kill switch is just its
   * bluntest instance. */
  if (process.env.CYC_PLUGINS_OFF === "1") return [];
  const builtins: PluginSpec[] = [...BUILTINS];
  /* Git and Files are full plugins over the typed PluginCore now (they read the
   * session cwd via core.read("cwd") and the fs/git verbs via core.fs), so they
   * are factory-constructed here like every other migrated plugin rather than
   * compiled into BUILTINS as bare specs. Always loaded (they were unconditional
   * built-ins); with no core (a bare loadPlugins() in a test) they still declare
   * and their ops refuse with the missing-session sentence. */
  builtins.push(gitPlugin(ctx.core?.("git")), filesPlugin(ctx.core?.("files")));
  /* The usage card is crons-shaped now: the factory takes the typed core (its
   * render folds plan usage across the ACTIVE harnesses via core.harnesses() ->
   * core.usage(kind, force)) AND owns its own limits-poll ticker when the root
   * wires the poll seam. A bare loadPlugins() (tests) leaves both null and gets
   * the card renderer with no loop. */
  builtins.push(usageCardPlugin(ctx.core, ctx.usage));
  /* Crons takes its four host verbs off the typed core (its narrowed slice of
   * the contract), not a separate PluginHost handle. Gated on the core being
   * wired: a bare loadPlugins() leaves the schedules vertical off, exactly as
   * before (the old marker was the presence of a crons host). */
  if (ctx.crons && ctx.core) builtins.push(cronsPlugin(ctx.core("crons")));
  if (ctx.search) builtins.push(searchPlugin(ctx.core));
  if (ctx.model) builtins.push(modelIndicatorPlugin(ctx.core, ctx.model));
  if (ctx.persona) builtins.push(personaPlugin(ctx.core));
  /* The dials plugin takes the typed core too: it registers its own delivery-time
   * input-transform hook (the instruction append) when it loads, via
   * core.inputTransform, instead of the composition root registering it. */
  if (ctx.dials) builtins.push(replyDialsPlugin(ctx.dials, ctx.core));
  if (ctx.ctx) builtins.push(ctxPlugin(ctx.core));
  /* The stop button, wired over the typed PluginCore (H2 bug fix: its decl said
   * run:"interrupt" with no rpc map, so honoring it 404ed; the app's ws
   * special-case masked that). With no core (a bare loadPlugins() in a test) it
   * still declares, its rpc simply refuses.
   *
   * GATED LIKE EVERY OTHER PLUGIN now: no plugin is special. The flag DEFAULTS ON
   * (ctx.stop ?? true), so the one production caller and a bare loadPlugins() both
   * get it; a caller may pass stop:false to drop the button, the crons/search
   * shape exactly. */
  if (ctx.stop ?? true) builtins.push(stopPlugin(ctx.core));
  if (process.env.CYC_PLUGINS_TEST) builtins.push(...testPlugins());
  return builtins;
}

/* The compiled-in built-ins, one line per migrated built-in (defaultServices
 * shape). The usage card is engine-level (a fact about the account on this
 * host); the crons panel joins here next. */
const BUILTINS: PluginSpec[] = [tuiPlugin];

/* A fixture that exercises every surface, for the wire and route tests. Gated
 * behind CYC_PLUGINS_TEST so it is never in a real engine's list. Its hooks are
 * real (a route test needs a card to fetch and an rpc to call); one of them
 * throws on purpose so the fail-safe wrapper has something to catch. */
let fixtureRenders = 0;
function testPlugins(): PluginSpec[] {
  return [
    {
      id: "fixture",
      name: "Test Fixture",
      version: 1,
      card: {
        title: "Fixture Card",
        refreshFloorS: 5,
        dedupe: () => "fixture-key",
        // the render count is baked into the html so a route test can tell a
        // fresh render from a throttled cache hit without waiting on a clock; the
        // force flag is baked in too, so a test can prove the route threads the
        // refresh arrow through to render() (#570)
        render: async (opts) => ({ html: `<b>fixture card ${++fixtureRenders} force=${!!opts?.force}</b>`, ageMs: 1234 }),
      },
      panel: {
        icon: "gear",
        label: "Fixture",
        needsSession: true,
        html: async () => "<!doctype html><title>fixture</title><body>panel</body>",
        ops: ["echo", "big"],
        toolbarDefault: false, // #574: this panel asks to stay hidden until pinned
      },
      // a toolbar action button (stop-shaped: tap runs an rpc) with a live badge
      // (ctx-shaped: a polled rpc supplies a short chip)
      action: {
        icon: "stop",
        label: "Stop",
        needsSession: true,
        run: "stop",
        badge: "ctx",
        confirm: { label: "Stop", message: "This cannot be undone." },
      },
      // a terminal entry (opens the terminal viewer on the session's own pane)
      tui: { icon: "terminal", label: "Shell" },
      // PLUGIN-LEVEL rpc: reached by the panel page, the action tap and the badge
      // poll alike over the one /plugin/<id>/rpc/<op> route
      rpc: {
        echo: async ({ session }, args) => ({ session, args }),
        boom: async () => {
          throw new Error("fixture rpc boom");
        },
        // a reply past the 16MB out cap, to prove the size check
        big: async () => ({ blob: "x".repeat(16 * 1024 * 1024 + 16) }),
        stop: async ({ session }) => ({ stopped: session }),
        // the resolved agent id rides the ctx (H2): prove the route fills it
        agent: async ({ session, agent }) => ({ session, agent }),
        ctx: async () => "42%",
      },
      composer: [
        { type: "menu", icon: "plus", label: "Bits", items: [{ text: "Hello", insert: "hello " }] },
      ],
    },
    {
      // a card whose render blows the 128KB html cap, to prove the 413
      id: "bigcard",
      name: "Big Card",
      version: 1,
      card: {
        title: "Big",
        refreshFloorS: 5,
        render: async () => ({ html: "x".repeat(128 * 1024 + 16), ageMs: null }),
      },
    },
  ];
}
