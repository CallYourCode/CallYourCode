/* THE MODEL INDICATOR: the minimal example plugin, and the tutorial one (#563).
 *
 * The smallest thing that is still a real plugin end to end: a toolbar entry
 * that, tapped, tells you which model this session is talking to. It is the
 * shape a plugin author copies to start their own, so it does only what a
 * plugin does and nothing an engine already does for itself.
 *
 * WHAT A PLUGIN IS, read off this file:
 *   - a SURFACE the app draws (here a `panel`: a toolbar icon that opens a
 *     small side-docked page), declared in static fields the app renders with
 *     no code of its own;
 *   - an RPC the page calls back over (`/plugin/model-indicator/rpc/model`) for
 *     the live data the static decl cannot carry;
 *   - a DEPS SEAM so the plugin reads the engine's own state instead of a
 *     second copy of it. The model this session is on is already computed for
 *     the top bar (server.ts modelOf, from the newest assistant turn); this
 *     plugin is handed that exact reader, so the icon and the top bar can never
 *     name two different models.
 *
 * WHY THE SCOPING IS FREE. An engine declares only the plugins it loaded, so an
 * engine that does not wire this seam never sends the entry and the app draws no
 * icon -- the work Mac shows nothing here not because anything special-cased it
 * but because its engine simply did not declare it. Per-engine declaration is
 * the whole mechanism; this plugin adds no scoping logic of its own.
 *
 *   bun test agent-engine/src/plugins/model-indicator/model-indicator.test.ts
 */

import type { PluginSpec } from "../platform/spec.ts";
import type { PluginCore } from "../platform/core.ts";
import { modelDisplayName } from "../../sessions/model-names.ts";

/* THE RESIDUAL. The model READING moved to the typed core
 * (`core.read("model", id)` -> the raw id for claude, the transcript model
 * string for others -- the plugin maps it). The one thing with no PluginCore
 * home is the HARNESS KIND (the agent id, "claude"/"codex"/...): there is no
 * read key for it and inventing one for a single caller is not warranted, so it
 * stays a one-line resolver the composition root supplies (surfaced per the
 * plan, not invented). `harness` is the agent id when the engine knows it, null
 * otherwise. */
export type ModelDeps = {
  harness?: (sessionId: string) => string | null;
};

/* THE NAME MAPPING IS NOT THIS FILE'S (2026-09-02). It used to carry its own
 * id -> name table beside the one in session-events.ts, and the two drifted:
 * neither knew `claude-fable-5-1`. Both now import the ONE derivation in
 * sessions/model-names.ts (claude ids derived, non-claude ids off one friendly
 * table, else the raw id), so the chip and the top bar cannot disagree. */
const HARNESS_NAMES: Record<string, string> = {
  claude: "Claude Code",
  "claude-code": "Claude Code",
  "claude code": "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  "open-code": "opencode",
  pi: "Pi",
};

/** Map a model id or acronym to a friendly name. Unknown input is returned
 *  as-is; an empty string passes straight back out. */
export function friendlyModelName(raw: string): string {
  if (!raw) return raw;
  return modelDisplayName(raw) ?? raw;
}

/** Map a harness id to the product name the panel prints. Unknown is returned as-is. */
export function friendlyHarnessName(raw: string): string {
  if (!raw) return raw;
  return HARNESS_NAMES[raw.trim().toLowerCase()] ?? raw;
}

/** The one line the panel shows on open. */
export function modelOpenText(name: string, harness: string | null): string {
  return harness ? `Harness: ${harness} / Model: ${name}` : name;
}

export function modelIndicatorPlugin(core?: (id: string) => PluginCore, deps: ModelDeps = {}): PluginSpec {
  return {
    id: "model-indicator",
    name: "Model",
    version: 1,
    panel: {
      icon: "🤖",
      label: "Model",
      needsSession: true, // the app attaches the session id to every rpc call
      dock: "side", // a small right-column card (full-screen on the phone)
      html: async () => MODEL_HTML,
      ops: ["model"], // the one op the page below may call
      /* THE BADGE the toolbar button wears (#581): the app polls this op the way
       * it polls ctx, and shows what it returns (the friendly name, or the raw
       * id when we have no mapping) as a live chip beside the "Model" label.
       * The SAME op the panel page reads, so the chip and the panel body can
       * never name two different models. */
      badge: "model",
      /* Shown by default on every device that has not pinned it otherwise (#574):
       * the model this session is on is worth a glance without a Settings trip,
       * and an engine that loads this plugin is saying it can name one. */
      toolbarDefault: false, // his call 2026-08-17: not shown by default, pin to show
    },
    rpc: {
      /* model(session) -> {model, name, harness}. `model` stays the badge
       * field: the friendly name when we know one, else the raw id/acronym.
       * `name` is the same string (panel and profile can read either).
       * `harness` is the product name when the engine handed us an id.
       * No session is null, not an error: the app only opens this panel from a
       * session, so a missing one is nothing to show, not a fault to report. */
      model: async ({ session }) => {
        if (!session) return { model: null, name: null, harness: null };
        const raw = core ? await core("model-indicator").read("model", session) : null;
        const harnessRaw = deps.harness?.(session) ?? null;
        const harness = harnessRaw ? friendlyHarnessName(harnessRaw) : null;
        if (!raw) return { model: null, name: null, harness };
        const name = friendlyModelName(raw);
        return { model: name, name, harness };
      },
    },
  };
}

/* THE PANEL PAGE. Self-contained HTML+CSS+JS in the show sandbox: it has no
 * network of its own, so its one read is a cyc.call the app performs against
 * this engine. It uses the app's --cyc-* theme vars (the frame injects them),
 * so it reads the same in day and night as the rest of the app. */
const MODEL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Model</title>
<style>
  body{margin:0;padding:16px;font-size:14px;color:var(--cyc-text)}
  .label{color:var(--cyc-muted);font-size:12px}
  .model{font-size:20px;font-weight:600;margin-top:4px}
  .muted{color:var(--cyc-muted);font-weight:400}
</style></head>
<body>
  <div class="label">This session's model</div>
  <div class="model" id="model"><span class="muted">checking&hellip;</span></div>
<script>
(function(){
  var el = document.getElementById('model');
  window.cyc.call('model', null).then(function(r){
    var res = r && r.ok && r.result ? r.result : null;
    var name = res ? (res.name || res.model) : null;
    var harness = res && res.harness ? res.harness : null;
    el.textContent = '';
    if(name){ el.textContent = harness ? ('Harness: ' + harness + ' / Model: ' + name) : name; }
    else { var s = document.createElement('span'); s.className = 'muted';
           s.textContent = 'no model yet'; el.appendChild(s); }
  }).catch(function(){
    el.textContent = '';
    var s = document.createElement('span'); s.className = 'muted';
    s.textContent = 'could not read the model'; el.appendChild(s);
  });
})();
</script>
</body></html>`;
