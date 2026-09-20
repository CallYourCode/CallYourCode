/* THE CONTEXT BUTTON AS AN ACTION PLUGIN (#590): the toolbar's context chip and
 * its tap-to-compact, moved out of the core toolbar and onto the plugin surface.
 *
 * His rule for #590: if it can be a plugin, it is a plugin. ctx is the smallest
 * real action plugin and proves the whole shape: a toolbar BUTTON with no page,
 * a live badge, and a tap that fires an rpc.
 *
 *   badge `pct`  -- the context fullness percent, read off the SAME contextPctOf
 *                   seam #571 built (the number that already rides every sessions
 *                   frame). The badge op exists so the decl is a complete action
 *                   for any client; the app does NOT poll it (it reads the number
 *                   off the sessions frame as before), so the two spellings of the
 *                   one number cannot drift.
 *   run   `compact` -- taps run /compact through the SAME compactSession body the
 *                   ws `compact` frame runs, and the reply's `tell` is the toast
 *                   the app shows (ok and refusal alike, the engine's sentence
 *                   verbatim). Compaction is irreversible; the confirmation stays
 *                   the app's native face for this action id (his #274 rule).
 *
 * WHAT STAYS BEHIND IT: contextPct still rides the sessions frame (the tube fill,
 * the profile row and the sort key read it there); the engine still answers the
 * ws `compact` frame for one release (delegating to the same compactSession). This
 * plugin is a second caller of those seams, not a replacement for them.
 *
 *   bun test agent-engine/src/plugins/ctx/ctx.test.ts
 */

import type { PluginSpec } from "../platform/spec.ts";
import type { PluginCore } from "../platform/core.ts";
import { openLog } from "../../../../shared/logbook.ts";

/* THE CTX ACTION, over the typed PluginCore. `pct` reads
 * `core.read("contextPct", id)` -- the exact number the context bar shows (the
 * dispatch answers the claude context() pair's pct, byte-identical on a static
 * transcript); `compact` runs `core.command("compact", id)` -- for claude the
 * dispatch delegates to compactSession's exact tells, and codex/opencode take the
 * dispatch's "compacting from here is not supported for <name> yet", which is the
 * SAME sentence compactSession gave a non-claude agent (parity by construction).
 *
 * REFUSALS, AND NOTHING THROWS (2026-09-02, fail open): a null session or an
 * engine with no core answers {ok:false, tell:"..."} in the same {ok, tell} shape
 * the dispatch's own refusals take, so the app shows a toast and never an rpc
 * error. An unknown session is the dispatch's answer, {ok:false, tell:"that
 * session is not known to this engine"} (surfaced, not invented: core.command
 * owns that sentence and the plugin can no longer probe existence). A core
 * failure mid-compact is answered the same way, its message as the tell. A
 * badge poll never gates on existence and never throws either: a session-less
 * badge is blank, and a read that fails is {pct:null} with one line in the
 * engine log (cyclog: `ctx.pct.failed`). */

export function ctxPlugin(core?: (id: string) => PluginCore): PluginSpec {
  return {
    id: "ctx",
    name: "Context",
    version: 1,
    action: {
      icon: "contextbar",
      label: "Context",
      needsSession: true, // the app attaches the session id to every rpc call
      run: "compact", // tap fires the compact op
      badge: "pct", // a client could poll this; the app reads the sessions frame
      // the app still draws the existing compact dialog (percent, class,
      // Compact button) so the confirm stays byte-identical; this names it.
      confirm: {
        label: "Compact",
        message: "Compacting replaces the conversation with a summary of it, and that cannot be undone.",
      },
    },
    rpc: {
      /* pct(session) -> {pct}. The fullness percent off core.read("contextPct"),
       * or null without a session or when it cannot be read. No existence gate: a
       * badge on a session-less client is simply blank, not an error. A read that
       * THROWS is also {pct:null}, logged once; a badge is never worth an rpc
       * error. */
      pct: async ({ session }) => {
        if (!session || !core) return { pct: null };
        try {
          return { pct: await core("ctx").read("contextPct", session) };
        } catch (e) {
          openLog("engine").line("ctx.pct.failed", { session, err: String(e) });
          return { pct: null };
        }
      },
      /* compact(session) -> {ok, tell}. Runs /compact through the dispatch; the
       * reply's tell is the toast, verbatim (the permission-prompt refusal and the
       * not-supported sentence included). Refusals and failures take the same
       * shape; nothing here throws. */
      compact: async ({ session }) => {
        if (!core) return { ok: false, tell: "compact is not wired on this engine" };
        if (!session) return { ok: false, tell: "this action needs a session" };
        try {
          return await core("ctx").command("compact", session);
        } catch (e) {
          openLog("engine").line("ctx.compact.failed", { session, err: String(e) });
          return { ok: false, tell: (e as Error)?.message || String(e) };
        }
      },
    },
  };
}
