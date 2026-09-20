/* THE STOP BUTTON AS AN ACTION PLUGIN: the toolbar's interrupt, declared so
 * its confirm is a field rather than only an app special-case.
 *
 * The app still draws the existing Ctrl-C dialog (session name, class,
 * Send Ctrl-C button) so the confirm stays byte-identical. This plugin names
 * that confirm (label + message only; Cancel is the app's).
 *
 * H2 BUG FIX: the decl used to say run:"interrupt" with NO rpc map, so a
 * client honoring the decl got a 404; only the app's ws interrupt special-case
 * masked it. The rpc now goes through the ONE typed PluginCore:
 * `core.command("interrupt", id)` -- the same ctrl+c the ws interrupt frame
 * sends, brokered by the dispatch (harness-native first, mux baseline otherwise).
 *
 * REFUSAL WORDING: a live, mux-backed session is the only one
 * ctrl+c can reach, which is exactly what `core.has("interrupt", id)` answers
 * (viaMux && alive, or a harness-native input path). A missing session and a dead
 * one both fail that gate, so both refuse with one honest sentence -- the
 * "no such session" / "no live pane" split the deps bag drew is a distinction the
 * generic dispatch does not surface, so it is consolidated here (surfaced, not
 * invented): the live path is unchanged, the two nothing-to-interrupt cases read
 * the same "no live pane for that session".
 *
 *   bun test agent-engine/src/plugins/plugins.test.ts
 */

import type { PluginSpec } from "../platform/spec.ts";
import type { PluginCore } from "../platform/core.ts";

export function stopPlugin(core?: (id: string) => PluginCore): PluginSpec {
  return {
    id: "stop",
    name: "Stop",
    version: 1,
    action: {
      icon: "hand",
      label: "Stop",
      needsSession: true,
      run: "interrupt",
      confirm: {
        label: "Send Ctrl-C",
        message: "Whatever it is doing stops where it is, and that cannot be undone.",
      },
    },
    rpc: {
      interrupt: async ({ session }) => {
        if (!core) throw new Error("interrupt is not wired on this engine");
        if (!session) throw new Error("this action needs a session");
        const c = core("stop");
        // only a live, mux-backed (or harness-native) session can take ctrl+c
        if (!c.has("interrupt", session)) throw new Error("no live pane for that session");
        await c.command("interrupt", session);
        return { ok: true };
      },
    },
  };
}
