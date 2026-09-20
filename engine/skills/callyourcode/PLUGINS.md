# Plugins: the surfaces, the ops, a minimal worked example

Engines declare plugins; the app renders them. A plugin is one `PluginSpec`
in `agent-engine/src/plugins/` (the engine end holds all the code; only a
function-free declaration crosses the wire). There are no app-side settings
for a plugin: its config lives engine-side, changed by talking to the agent
or through the plugin's own panel.

## The surfaces

| surface  | what the user sees                                     | reference |
|----------|--------------------------------------------------------|-----------|
| card     | an engine-rendered HTML face (no scripts, 128KB cap)   | usage-card |
| panel    | a toolbar entry opening a sandboxed page (1MB cap)     | crons, search |
| action   | a toolbar button, no page: tap fires an rpc            | stop |
| composer | a declarative menu (24 items max) or slider (9 steps)  | prompt bits |
| tui      | a toolbar entry opening the terminal viewer on an engine-spawned pane | terminal |

## The ops

Every surface reaches the engine over ONE route:
`POST /plugin/<id>/rpc/<op>` (args ≤ 256KB, reply ≤ 16MB, 10s timeout; fs/git
ops get 20s; the caps live in plugins/platform/spec.ts, the one source). A
panel page calls it as `cyc.call('<op>', args)`; the op must be listed in the
panel's `ops` array. `badge` names an op the app polls for a live chip on the
toolbar button; cards re-render via `GET /plugin/<id>/card` (refresh floor
5s minimum). Unknown id or op is a 404.

## The minimal worked example: model-indicator

`agent-engine/src/plugins/model-indicator/index.ts` is the tutorial plugin, the
smallest real one. Its whole shape:

```ts
export function modelIndicatorPlugin(deps: ModelDeps): PluginSpec {
  return {
    id: "model-indicator",       // lowercase/digits/dashes, 1..64
    name: "Model",
    version: 1,
    panel: {
      icon: "🤖", label: "Model",
      needsSession: true,        // the app passes the session id to every rpc
      dock: "side",              // side card; "full" = full-bleed overlay
      html: async () => MODEL_HTML,  // self-contained page, show sandbox
      ops: ["model"],            // the only op the page may call
      badge: "model",            // the toolbar chip polls the same op
      toolbarDefault: true,
    },
    rpc: {
      // ctx is {session, agent}: the session the app attached and the stable
      // agent id the engine resolved for it
      model: async ({ session }) => ({ model: session ? deps.current(session) : null }),
    },
  };
}
```

Three ideas to copy: a static decl the app renders with no code of its own;
one rpc for the live data the decl cannot carry; a deps seam so a VIEW plugin
reads the engine's own state (here the same model reader the top bar uses)
instead of a second copy that could drift.

## Two classes of plugin

A VIEW plugin (model-indicator, ctx, search) is a thin closure over live core
state: no data of its own, no loop. The deps seam above is its legitimate
shape.

A plugin that OWNS a vertical (crons is the reference; git and files too)
takes the typed `PluginCore` (`agent-engine/src/plugins/platform/core.ts`) instead: the
three host verbs -- `store()` (engine-scoped KV/dir), `agentStore(agentId)`
(agent-scoped), `deliver(agentId, {text, note?, guardCwd?})` (a message INTO
the agent's pane, deliverToAgent semantics) -- plus brokered session reads
(`core.read("cwd"|"model"|..., id)`, values only, never a live handle) and
the root-scoped fs/git verbs as the `core.fs` capability (git/files call
`core.fs.*` off `core.read("cwd", id)`; no plugin imports engine-internal
code or touches live session state). Anything the core does not offer stays
refused: a plugin that needs a clock runs its own loop (crons does), one
that needs cron math ships it. A new need is a new declared surface on the
core, never a per-plugin hole.

## Adding one

1. Write a `PluginSpec` file in `agent-engine/src/plugins/` (copy
   model-indicator; its panel HTML uses the injected `--cyc-*` theme vars).
   A data-owning plugin gets a directory (`plugins/crons/`) and a host.
2. Wire it in `loadPlugins` (`agent-engine/src/plugins/registry.ts`): a view plugin is
   handed its deps, a data-owning one its `PluginCore` (`ctx.core("<id>")`).
   Loading from external directories is deferred; today plugins compile in.
3. Payload caps are enforced, not advisory: over-cap composer decls are
   dropped, refresh floors clamp up, a hook that overruns answers that one
   request with an error.

`CYC_PLUGINS_OFF=1` is the kill switch: the engine declares nothing and the
app falls back to its native built-ins.
