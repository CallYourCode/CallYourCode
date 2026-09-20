/* THE FILE EXPLORER AS A FULL PLUGIN (#590): the toolbar's Files entry,
 * now a sandboxed-HTML `panel` like crons/voice/model, not an `appPanel`.
 *
 * Same conversion git got (see plugins/git/index.ts): filesViewer was app shell and
 * its data did not fit the old 1MB rpc bridge. With the 16MB reply cap and the
 * viewer moved into a self-contained page (app: src/plugins/files/), files
 * is an ordinary plugin: the engine serves app/dist/plugins/files-page.html and
 * answers its four reads plus a raw-image op
 * as plugin rpc, all under the 16MB cap. No native face, no /fs/* routes.
 *
 * dock:'page' is the chromeless full-bleed overlay: the page draws its own head
 * bar, exactly as the native files overlay did.
 *
 * THE ROOT IS THE SESSION'S CWD AND NOTHING ELSE; a request that names something
 * outside is answered "outside" (403-shaped) with a reason, not an empty
 * directory (the fsgit rule). `raw` answers {base64, mime} for a picture only --
 * everything else that is not text stays reported as binary, drawn as a message,
 * because a browser handed an arbitrary file downloads it.
 *
 *   bun test agent-engine/src/plugins/files/files-plugin.test.ts
 */

import type { PluginSpec, RpcCtx } from "../platform/spec.ts";
import { FSGIT_OP_TIMEOUT_MS } from "../platform/spec.ts";
import type { PluginCore } from "../platform/core.ts";

const PAGE = Bun.file(new URL("../../../../../app/dist/plugins/files-page.html", import.meta.url));

const str = (a: unknown, k: string): string => {
  const v = (a && typeof a === "object") ? (a as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" ? v : "";
};

/* THE FILES PLUGIN, over the typed PluginCore (no engine-internal imports): the
 * session's cwd is `core.read("cwd", id)` and every fs/git verb plus the
 * RAW_MAX_BYTES/fmtBytes helpers are `core.fs.*`. With no core (a bare
 * loadPlugins() in a test) it still declares; its ops refuse with the
 * missing-session sentence. */
export function filesPlugin(core?: PluginCore): PluginSpec {
  /* THE ROOT IS THE SESSION'S CWD AND NOTHING ELSE; the cwd is read the same
   * adapter->core way as every other session fact, so this plugin never reaches
   * live session state. A missing session (or no core) answers the native
   * sentence. */
  async function rootFor(ctx: RpcCtx): Promise<{ root: string } | { fail: { ok: false; error: string } }> {
    const cwd = core && ctx.session ? await core.read("cwd", ctx.session) : null;
    if (!cwd) return { fail: { ok: false, error: "no such session on this engine" } };
    return { root: await core!.fs.rootOf(cwd) };
  }

  return {
  id: "files",
  name: "Files",
  version: 2,
  panel: {
    icon: "folder",
    label: "Files",
    needsSession: true,
    dock: "page",
    html: async () => PAGE.text(),
    ops: ["list", "read", "git", "diff", "raw"],
  },
  rpcTimeoutMs: {
    list: FSGIT_OP_TIMEOUT_MS, read: FSGIT_OP_TIMEOUT_MS, git: FSGIT_OP_TIMEOUT_MS,
    diff: FSGIT_OP_TIMEOUT_MS, raw: FSGIT_OP_TIMEOUT_MS,
  },
  rpc: {
    list: async (ctx, args) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      const out = await core!.fs.listDir(r.root, str(args, "path"));
      return { ...out, root: r.root, name: r.root.split("/").pop() ?? r.root };
    },
    read: async (ctx, args) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      return core!.fs.readFile(r.root, str(args, "path"));
    },
    git: async (ctx) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      return core!.fs.gitStatus(r.root);
    },
    diff: async (ctx, args) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      return core!.fs.gitDiff(r.root, str(args, "path"));
    },
    /* RAW BYTES, AND ONLY FOR A PICTURE. Native /fs/raw streamed the file with a
     * content-type; over rpc there is no separate URL, so the bytes ride the
     * reply as base64 with their mime and the page renders a data: URL (PAGE_CSP
     * allows data: images). RAW_MAX_BYTES stays 10 MB; base64 of 10 MB is ~13.4
     * MB, which plus the JSON envelope fits the 16 MB reply cap. The same
     * 403/415/404/413 reasons carry the same sentences. */
    raw: async (ctx, args) => {
      const r = await rootFor(ctx); if ("fail" in r) return r.fail;
      const fs = core!.fs;
      const abs = await fs.resolveInRoot(r.root, str(args, "path"));
      if (!abs) return { ok: false, error: "path is outside the session directory" };
      const mime = fs.imageMimeOf(abs);
      if (!mime) return { ok: false, error: "not an image" };
      const f = Bun.file(abs);
      if (!(await f.exists())) return { ok: false, error: "no such file" };
      if (f.size > fs.RAW_MAX_BYTES) {
        return { ok: false, error: `image is ${fs.fmtBytes(f.size)}, over the ${fs.fmtBytes(fs.RAW_MAX_BYTES)} cap` };
      }
      const base64 = Buffer.from(await f.arrayBuffer()).toString("base64");
      return { ok: true, base64, mime };
    },
  },
  };
}
