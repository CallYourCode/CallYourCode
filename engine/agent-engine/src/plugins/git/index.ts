/* THE GIT PANE AS A FULL PLUGIN (#590): the toolbar's Git entry, now a
 * sandboxed-HTML `panel` like crons/voice/model, not an `appPanel`.
 *
 * Git used to be app shell (gitViewer.ts pulled prism, shared viewerPrefs and
 * compiled scss, and a git patch reply ran past the 1MB rpc cap). With the reply
 * cap at 16MB (platform/spec.ts) and the viewer moved into a self-contained page
 * (app: src/plugins/git/), git is an ordinary plugin: the engine serves
 * its page html from app/dist/plugins/git-page.html and answers
 * its data as plugin rpc ops within the 16MB cap. No native face, no /git/*
 * routes.
 *
 * dock:'page' is the chromeless full-bleed overlay (no dock header): the page
 * draws its own head bar, exactly as the native git overlay did.
 *
 * THE OPS ARE THE OLD ROUTES, MOVED (routes/fsgit.ts is deleted). Each delegates
 * to the files.ts git verb it always did; the same refusals (side/what/against
 * validated, refused not defaulted) and the same "no such session" sentence come
 * back as the result object rather than an HTTP status, so the page's data
 * adapter reads byte-identical sentences to the native client's. A wider 20 s
 * op deadline (rpcTimeoutMs) matches the native route's transport backstop.
 *
 *   bun test agent-engine/src/plugins/git/git-plugin.test.ts
 */

import type { PluginSpec, RpcCtx } from "../platform/spec.ts";
import { FSGIT_OP_TIMEOUT_MS } from "../platform/spec.ts";
import type { PluginCore } from "../platform/core.ts";

const PAGE = Bun.file(new URL("../../../../../app/dist/plugins/git-page.html", import.meta.url));

const str = (a: unknown, k: string): string => {
  const v = (a && typeof a === "object") ? (a as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" ? v : "";
};

/* THE GIT PLUGIN, over the typed PluginCore (no engine-internal imports): the
 * session's cwd is `core.read("cwd", id)` and every git verb is `core.fs.*`.
 * With no core (a bare loadPlugins() in a test) it still declares; its ops
 * simply refuse with the missing-session sentence. */
export function gitPlugin(core?: PluginCore): PluginSpec {
  /* THE ROOT IS THE SESSION'S CWD AND NOTHING ELSE (the fsgit rule). A missing
   * session (or no core wired) answers the same sentence the native route did;
   * the caller draws it. The cwd is read the same adapter->core way every other
   * session fact is, so this plugin never reaches live session state. */
  async function rootFor(ctx: RpcCtx): Promise<{ root: string } | { fail: { ok: false; error: string } }> {
    const cwd = core && ctx.session ? await core.read("cwd", ctx.session) : null;
    if (!cwd) return { fail: { ok: false, error: "no such session on this engine" } };
    return { root: await core!.fs.rootOf(cwd) };
  }

  return {
  id: "git",
  name: "Git",
  version: 2,
  panel: {
    icon: "gitbranch",
    label: "Git",
    needsSession: true,
    dock: "page",
    html: async () => PAGE.text(),
    ops: ["pane", "patch", "show", "change", "branches", "log", "compare"],
  },
  /* The native /git/* routes had a 20 s transport budget; a cold first
   * `git status` or a range compare on a large repo can want it. */
  rpcTimeoutMs: {
    pane: FSGIT_OP_TIMEOUT_MS, patch: FSGIT_OP_TIMEOUT_MS, show: FSGIT_OP_TIMEOUT_MS,
    change: FSGIT_OP_TIMEOUT_MS, branches: FSGIT_OP_TIMEOUT_MS, log: FSGIT_OP_TIMEOUT_MS,
    compare: FSGIT_OP_TIMEOUT_MS,
  },
  rpc: {
    pane: async (ctx) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      return core!.fs.gitPane(r.root);
    },
    branches: async (ctx) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      return core!.fs.gitBranches(r.root);
    },
    log: async (ctx, args) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      return core!.fs.gitRefLog(r.root, str(args, "ref"));
    },
    compare: async (ctx, args) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      const against = str(args, "against");
      /* Refused rather than defaulted: "since it forked" and "against main's
       * tip" are different questions (the fsgit rule). */
      if (against !== "mergebase" && against !== "main") {
        return { ok: false, error: "against must be mergebase or main" };
      }
      return core!.fs.gitCompare(r.root, str(args, "ref"), against);
    },
    patch: async (ctx, args) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      const side = str(args, "side");
      /* "staged" and "unstaged" are different questions; answering the wrong
       * one silently is the defect class this pane exists to avoid. */
      if (side !== "staged" && side !== "unstaged") {
        return { ok: false, error: "side must be staged or unstaged" };
      }
      return core!.fs.gitFilePatch(r.root, str(args, "path"), side);
    },
    change: async (ctx, args) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      const what = str(args, "what");
      if (what !== "commit" && what !== "staged" && what !== "unstaged") {
        return { ok: false, error: "what must be commit, staged or unstaged" };
      }
      return core!.fs.gitChange(r.root, what, str(args, "sha"));
    },
    show: async (ctx, args) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      return core!.fs.gitCommitPatch(r.root, str(args, "sha"));
    },
  },
  };
}
