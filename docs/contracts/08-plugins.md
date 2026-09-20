# 08. Plugins

## Purpose

"Most of its features ship as plugins" with their own UI (PRODUCT.md
section 3): three UI surface classes (card / composer / toolbar), spelled in
the shipped spec as five declarable members (card, composer, panel, action,
tui). Engines declare; the app renders. Plugins declare NO app settings:
config happens by talking to the agent or in the plugin's own panel. This is
the community contribution surface, so its caps are enforced, not advisory.

## Parties and transport

- engine: `plugins/platform/spec.ts` (NORMATIVE for every shape and cap),
  `registry.ts` (declarePlugins/loadPlugins, decl-only projection),
  `platform/host.ts` + `core.ts` (what a plugin may touch), `routes/plugin.ts`
  (the HTTP surface, owner-gated).
- app: `app/src/engine/contract.ts EnginePluginDecl` (the decl decoder),
  `store/plugins.ts`, `components/pluginCard.ts` / `pluginPanel.ts`,
  `features/plugins/sandbox.ts` (the iframe sandbox + `cyc.*` bridge).
- wire: the `plugins {list}` frame in the hello burst; all calls ride the
  sealed tunnel as ordinary engine routes.

## Contract

What crosses the wire is `PluginDecl`: the spec minus every function. `id`
must match `PLUGIN_ID_RE` (`/^[a-z0-9-]{1,64}$/`); a bad id DROPS the plugin,
never coerces. An engine with no plugins sends no frame; `CYC_PLUGINS_OFF=1`
declares nothing and the app falls back to its native built-ins.

### Surfaces (`spec.ts`)

- `card`: engine-rendered HTML face, no scripts, `CARD_HTML_MAX_BYTES` 128KB,
  refresh floor clamped UP to >= 5s; `render({force?})` answers `{html, ageMs,
  height?, stale?, throttled?}`; served at `GET /plugin/<id>/card` (`?refresh=1`
  goes upstream, throttled engine-side to the declared floor).
- `panel`: toolbar entry opening a sandboxed page,
  `{icon, label, needsSession, ops?, dock?, badge?, toolbarDefault?}`;
  `html()` <= `PANEL_HTML_MAX_BYTES` 1MB; `ops` allowlist; `dock:
  full|side|page`.
- `action`: toolbar button, `run` op on tap, optional `badge`, app-owned
  `confirm {label, message}` (extra keys stripped so a remapped Escape cannot
  ride the wire).
- `composer`: DECLARATIVE ONLY ("data in and data out, NO free rein"): `menu`
  (<= `MENU_MAX_ITEMS` 24 items, item text <= `MENU_ITEM_TEXT_MAX` 200) or
  `slider` (<= `SLIDER_MAX_STEPS` 9 steps, required `key` matching
  `WIDGET_KEY_RE`, `value` must equal a declared step). Over any cap the widget
  is DROPPED, never truncated. The app renders with its own components; a
  slider POSTs `{key, n}` to `/plugin/<id>/rpc/set`.
- `tui`: opens the terminal viewer on the session's own pane over the existing
  term-* frames; no command field exists.

### rpc (plugin-level)

`POST /plugin/<id>/rpc/<op>` `{session?, args}` -> `{ok, result}` |
`{ok:false, error}`. Args <= `RPC_ARGS_MAX_BYTES` 256KB; reply <=
`RPC_REPLY_MAX_BYTES` 16MB (a 413 refuses over-cap replies); hook deadline
`HOOK_TIMEOUT_MS` 10s with per-op overrides (`rpcTimeoutMs`); card render
`CARD_RENDER_TIMEOUT_MS` 8s poll / 12s refresh, the SAME numbers the app's
AbortSignals use. Unknown id or op is 404. The route builds `RpcCtx {session,
agent}`: the session the app attached and the stable agent id the engine
resolved.

### Page state

`GET/POST /plugin/<id>/state[?session=]` (`cyc.save`/`cyc.load`), engine-keyed
or agent-keyed by the two-axis rule; session ids held to `PLUGIN_SESSION_RE`
(`/^[A-Za-z0-9:_-]{1,128}$/`) before touching a filename.

### Engine-side capability (normative: `host.ts` header)

A data-owning plugin gets exactly `store()`, `agentStore(agentId)`,
`agentIds()`, and `deliver(agentId, {text, note?, how?, guardCwd?})` with
deliverToAgent semantics (no live session: retriable; cwd guard mismatch:
refused, not retriable). VIEW plugins take a typed deps closure over core
state. There is no tick hook, no session facts, no outbound mutation; a new
need is a new declared surface, never a per-plugin hole.

### Sandbox (app)

Panels and cards render in an iframe with no engine credential; the app
validates a page's `cyc.call(op)` against the declared `ops` BEFORE fetching
(defence in depth; the engine 404s regardless) and proxies the call over the
sealed tunnel itself.

## Capabilities

Decls are additive: an app that does not know a member ignores it; a missing
decl means nothing to render. A new composer widget type is a new member, not
a new transport. Caps may only widen with a spec change in `spec.ts`, the one
place they are spelled.

## Failure semantics

A throwing composer function drops only that surface; a hook overrun answers
that one request with an error and touches no core state; an over-cap reply is
a plain 413 sentence. Card fetch failures dim the face with the age line;
badge polls fail silently to a label-only button.

## Security invariants

- Functions never cross the wire; only data does.
- Card HTML carries no scripts; panel pages run sandboxed with no token to
  leak (the tunnel is the auth, and the app mediates every call).
- Plugin storage is namespaced per plugin id and per agent under the data
  dir's 0700/0600 tree; store keys are charset-checked (`host.ts KEY_RE`).
