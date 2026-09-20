/* THE TERMINAL BUTTON AS A TUI PLUGIN (#590): the toolbar's TUI entry, moved out
 * of the core toolbar onto the plugin surface.
 *
 * A terminal is a STREAM, not a request/response: the first frame alone is ~200KB
 * and it is continuous. So the open/resize/input/scroll/close transport stays the
 * existing term-* ws frames (server.ts term handlers, unchanged on the wire), and
 * this plugin declares ONLY the toolbar entry. It has no deps and no rpc: tapping
 * it opens the terminal viewer on the session's OWN pane, exactly as before; all
 * this plugin adds is that an engine which does not carry it shows no TUI button
 * (the #590 rule).
 *
 * NO `command`: nothing engine-side ever spawned a tui.command (see registry.ts).
 * Spawn-a-command terminals are a future surface, added when something
 * implements them.
 *
 *   bun test agent-engine/src/plugins/plugins.test.ts
 */

import type { PluginSpec } from "../platform/spec.ts";

export const tuiPlugin: PluginSpec = {
  id: "tui",
  name: "Terminal",
  version: 1,
  tui: { icon: "terminal", label: "TUI" },
};
