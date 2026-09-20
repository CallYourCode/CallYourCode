/* ROUTES: the plugin surfaces: card, panel, state and the ONE rpc route (L4 interface; blueprint 4b row 29).
 * Extracted verbatim from server.ts handleHttp; each handler answers a
 * Response or null (not mine). The auth gates stay per-route
 * (requireOwner/requireLocal), exactly as the if-chain had them. */

import type { RoutesCtx } from "./ctx.ts";
import { STATE_BODY_MAX_BYTES, readTextCapped } from "../storage/body-limits.ts";
import { pluginDataDir } from "../storage/datadir.ts";
import { readState, writeState } from "../storage/docstate.ts";
import { json, requireOwner } from "../transport/httpx.ts";
import { CARD_HTML_MAX_BYTES, CARD_RENDER_TIMEOUT_MS, HOOK_TIMEOUT_MS, PANEL_HTML_MAX_BYTES, RPC_ARGS_MAX_BYTES, RPC_REPLY_MAX_BYTES } from "../plugins/platform/spec.ts";
import { mkdirPrivate, writePrivate } from "../../../shared/runfiles.ts";
import { agentIdFor, agentMetas, resolveSession } from "../sessions/session-state.ts";

/* The plugin-route helpers, owned here with the routes that use them. */
/* Two-axis resolution (the design): an engine-keyed record lives in the
 * engine-scoped plugin data dir, a session-keyed record in that agent's own
 * plugins/<id>/ dir. Same one-record-per-key shape either way. */
/* A session id becomes part of a state filename, so it is held to a strict
 * charset before it can. Pane ids are `w1:p1`; anything with a slash or a
 * dot-dot in it is refused rather than sanitised, so no key can escape. */
const PLUGIN_SESSION_RE = /^[A-Za-z0-9:_-]{1,128}$/;

/* Bytes on the wire, not characters: every plugin cap is a byte cap because
 * that is what sits on the disk and crosses the net. */
const byteLen = (s: string): number => new TextEncoder().encode(s).length;

/* THE CARD THROTTLE, engine-side half of the refresh floor: a `?refresh=1`
 * re-renders at most once per the card's declared floor; between, the last
 * body is served. A plain poll always renders fresh and resets the window.
 * CYC_PLUGIN_REFRESH_FLOOR_MS lets a test open the window without sleeping. */
const cardCache = new Map<string, { at: number; body: unknown }>();

/* Race a hook against a deadline. A plugin that overruns answers THAT ONE
 * request with an error and touches no core state; there is no disable-after-N
 * counter, because nothing yet produces the failure that would need one. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const cardFloorMs = (refreshFloorS: number): number =>
  Number(process.env.CYC_PLUGIN_REFRESH_FLOOR_MS ?? refreshFloorS * 1000);

/* THE DEADLINES, ENV-TUNABLE FOR THE SAME REASON THE FLOOR ABOVE IS.
 *
 * The split is the thing worth proving: a plain poll reads a cached number and
 * gets 8s, a forced refresh goes upstream and gets 12s (#577), and a hook that
 * hangs must answer THAT request badly rather than wedge the route. A test
 * cannot prove any of that at the real numbers without rendering for thirteen
 * seconds once per assertion, so the three budgets read an override first and
 * the same race is measured in tens of milliseconds. Production sets none of
 * them, and with none set these return the compiled constants unchanged. */
function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const cardDeadlineMs = (refresh: boolean): number =>
  refresh ? envMs("CYC_PLUGIN_CARD_REFRESH_MS", CARD_RENDER_TIMEOUT_MS.refresh)
          : envMs("CYC_PLUGIN_CARD_POLL_MS", CARD_RENDER_TIMEOUT_MS.poll);
const hookDeadlineMs = (): number => envMs("CYC_PLUGIN_HOOK_MS", HOOK_TIMEOUT_MS);

/** TEST ONLY: forget the throttle's remembered card bodies, so a file that
 *  serves two engines' worth of routes in one process does not answer the
 *  second one from the first one's cache. No-op in production, which has one
 *  route table for the life of the process. */
export function resetForTest(): void {
  cardCache.clear();
}

export async function pluginRoutes(ctx: RoutesCtx, req: Request, url: URL, path: string,
  server: import("bun").Server): Promise<Response | null> {

  /* WHAT A SHOWN PAGE SAVED FOR ITSELF: `cyc.save()` and `cyc.load()`.
   *
   * On the same URL as the document, with `/state` on the end, and that is the
   * design rather than a naming convenience. A card is fetched from the engine
   * that OWNS it -- the app already holds that URL and hands it to the viewer --
   * so the state follows the document to whichever machine has it, with no
   * second address to configure and no way for the two to end up on different
   * hosts. It is also why this works across his phone, his tablet and his
   * laptop: all three ask the same engine, so all three see the same data.
   *
   * The policy (the cap, the refusals, what a missing state means as against an
   * unreadable one) is agent-engine/docstate.ts, testable without booting this.
   *
   * THE DOCUMENT MUST EXIST. Otherwise this is a key-value store any client can
   * fill with anything, keyed by a UUID it made up. */
  /* ===================== THE PLUGIN ROUTES (#479) ==========================
   *
   * One block, here: after the e2e cap gate above (so E2E `require` mode covers
   * every one of them for free) and before the static fallthrough. Every route
   * is `/plugin/<id>/...`, the hook it calls is wrapped (try/catch + a timeout
   * race + an output size check), and an unknown id or op is a 404 rather than a
   * 500 -- a plugin that is not loaded is a client mistake, not an engine fault.
   *
   * The functions live in ctx.plugins() (engine-side); the app only ever sees the
   * decls (PLUGIN_DECLS) and these answers. */
  const pluginRoute = path.match(/^\/plugin\/([a-z0-9-]{1,64})\/(card|panel|state)$/);
  const pluginRpc = path.match(/^\/plugin\/([a-z0-9-]{1,64})\/rpc\/([a-z0-9_-]{1,64})$/);

  if (pluginRoute && pluginRoute[2] === "card" && req.method === "GET") {
    // Plugin card content (git diffs, dials, usage): the tunnel and the host
    // only (Plan C step 4). Gated before the plugin lookup so a refused peer
    // cannot tell a 403 from a 404.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const [, id] = pluginRoute;
    const spec = ctx.pluginById(id);
    if (!spec?.card) return json({ ok: false, error: `no card on plugin ${id}` }, 404);
    const floorMs = cardFloorMs(Math.max(5, Number(spec.card.refreshFloorS) || 5));
    const refresh = url.searchParams.get("refresh") === "1";
    const cached = cardCache.get(id);
    // a refresh inside the floor is throttled to the last body; a plain poll (and
    // a refresh past the floor, and a cold cache) renders fresh
    if (refresh && cached && Date.now() - cached.at < floorMs) {
      return json(cached.body, 200);
    }
    try {
      // a forced render fetches upstream (two 10 s requests); a plain poll reads
      // the cached number. Split the deadline so a forced refresh is not killed
      // by the generic 2 s (#577 section 3); both numbers match the app's budgets.
      const renderTimeout = cardDeadlineMs(refresh);
      const out = await withTimeout(spec.card.render({ force: refresh }), renderTimeout, `plugin ${id} card render`);
      const html = String(out?.html ?? "");
      if (byteLen(html) > CARD_HTML_MAX_BYTES) {
        ctx.log("plugin.card.oversize", { id, bytes: byteLen(html) });
        return json({ ok: false, error: `card html too large (${byteLen(html)} bytes, cap ${CARD_HTML_MAX_BYTES})` }, 413);
      }
      let dedupe: string | null = null;
      try { dedupe = spec.card.dedupe ? spec.card.dedupe() : null; } catch { dedupe = null; }
      const ageMs = typeof out?.ageMs === "number" ? out.ageMs : null;
      const height = typeof out?.height === "number" && Number.isFinite(out.height) ? out.height : undefined;
      // the two freshness booleans, copied through for the app's age line (#577)
      const stale = out?.stale === true;
      const throttled = out?.throttled === true;
      const body = { ok: true, html, ageMs, ...(height != null ? { height } : {}),
        ...(stale ? { stale } : {}), ...(throttled ? { throttled } : {}), ...(dedupe ? { dedupe } : {}) };
      cardCache.set(id, { at: Date.now(), body });
      return json(body, 200);
    } catch (e) {
      ctx.log("plugin.card.fail", { id, err: String(e) });
      return json({ ok: false, error: `card render failed: ${String(e)}` }, 500);
    }
  }

  if (pluginRoute && pluginRoute[2] === "panel" && req.method === "GET") {
    // Plugin panel content (file bodies, persona, crons): the tunnel and the
    // host only (Plan C step 4), gated before the lookup so a refused peer
    // cannot tell a 403 from a 404.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const [, id] = pluginRoute;
    const spec = ctx.pluginById(id);
    if (!spec?.panel) return new Response("not found", { status: 404 });
    try {
      const html = await withTimeout(spec.panel.html(), hookDeadlineMs(), `plugin ${id} panel html`);
      const s = String(html ?? "");
      if (byteLen(s) > PANEL_HTML_MAX_BYTES) {
        ctx.log("plugin.panel.oversize", { id, bytes: byteLen(s) });
        return new Response(`panel html too large (${byteLen(s)} bytes, cap ${PANEL_HTML_MAX_BYTES})`,
          { status: 413 });
      }
      return new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (e) {
      ctx.log("plugin.panel.fail", { id, err: String(e) });
      return new Response(`panel html failed: ${String(e)}`, { status: 500 });
    }
  }

  if (pluginRpc && req.method === "POST") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const [, id, op] = pluginRpc;
    const spec = ctx.pluginById(id);
    // rpc is plugin-level (#479 scope note): a panel page, an action tap and a
    // badge poll all reach the engine over this one route.
    const fn = spec?.rpc?.[op];
    if (!fn) return json({ ok: false, error: `no rpc ${op} on plugin ${id}` }, 404);
    const got = await readTextCapped(req, RPC_ARGS_MAX_BYTES);
    if (!got.ok) return got.response;
    const text = got.value;
    if (byteLen(text) > RPC_ARGS_MAX_BYTES) {
      return json({ ok: false, error: `rpc args too large (${byteLen(text)} bytes, cap ${RPC_ARGS_MAX_BYTES})` }, 413);
    }
    let payload: { session?: unknown; args?: unknown } = {};
    if (text) {
      try { payload = JSON.parse(text); } catch { return json({ ok: false, error: "rpc body was not valid JSON" }, 400); }
    }
    const session = typeof payload?.session === "string" ? payload.session : null;
    /* H2: the op receives {session, agent}. The agent id is resolved, never
     * minted here: an unknown session gets null, not a fresh agent dir. */
    const agent = session ? (resolveSession(session)?.id ?? (agentMetas.has(session) ? session : null)) : null;
    try {
      /* Most ops get the generic hook deadline; an op the spec names in
       * rpcTimeoutMs gets its wider budget (the git/files reads that replaced a
       * native route with a 20 s transport backstop -- 3.4.4). Env still wins so
       * a test can shrink either without waiting on wall seconds. */
      const opTimeout = typeof spec?.rpcTimeoutMs?.[op] === "number"
        ? envMs("CYC_PLUGIN_HOOK_MS", spec.rpcTimeoutMs[op])
        : hookDeadlineMs();
      const result = await withTimeout(fn({ session, agent }, payload?.args), opTimeout, `plugin ${id} rpc ${op}`);
      const wire = JSON.stringify({ ok: true, result });
      if (byteLen(wire) > RPC_REPLY_MAX_BYTES) {
        ctx.log("plugin.rpc.oversize", { id, op, bytes: byteLen(wire) });
        return json({ ok: false, error: `rpc reply too large (${byteLen(wire)} bytes, cap ${RPC_REPLY_MAX_BYTES})` }, 413);
      }
      return new Response(wire, { headers: { "content-type": "application/json" } });
    } catch (e) {
      /* An op may reject a bad ARGUMENT with a client error rather than a server
       * fault: a thrown error carrying a numeric `status` (e.g. reply-dials'
       * RpcError on an unknown dial key) answers with that status, so "you asked
       * for rung 9" is a 400, not a 500. Anything else is a genuine hook fault. */
      const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 500;
      ctx.log("plugin.rpc.fail", { id, op, err: String(e), status });
      return json({ ok: false, error: `rpc ${op} failed: ${String(e)}` }, status);
    }
  }

  /* Plugin state: the docstate shapes and policy (docstate.ts), reused rather
   * than re-spelled. The doc-existence gate there means "a real key, not a free
   * key-value store"; for a plugin that gate is "the plugin id is loaded", so we
   * check it here (with a plugin-shaped 404) and hand docstate a docPath that
   * always exists. The sentinel docDir never touches the filesystem -- docPath
   * is only ever passed to the exists() predicate, never read or written. */
  if (pluginRoute && pluginRoute[2] === "state") {
    // Plugin saved state (read AND write): the tunnel and the host only (Plan C
    // step 4). This was ungated before; a tailnet peer could read or overwrite
    // any loaded plugin's per-session state over plain HTTP.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const [, id] = pluginRoute;
    if (!ctx.pluginById(id)) return json({ ok: false, error: `unknown plugin ${id}` }, 404);
    const session = url.searchParams.get("session");
    if (session !== null && !PLUGIN_SESSION_RE.test(session)) {
      return json({ ok: false, error: "invalid session key" }, 400);
    }
    /* The record's HOME is the two-axis rule (the design): engine-keyed state
     * in plugins/<id>/, session-keyed state in that agent's own plugins/<id>/.
     * The docstate policy is reused with the fixed key "state" -- the
     * directory is what distinguishes records now, not a compound filename. */
    const stateDir = pluginDataDir(id, session ? agentIdFor(session) : null) + "/";
    const SENTINEL = " plugin-loaded /";
    const exists = (p: string) => p.startsWith(" ") ? Promise.resolve(true) : Bun.file(p).exists();
    if (req.method === "GET") {
      const r = await readState(SENTINEL, stateDir, "state", exists,
        (p) => Bun.file(p).json().catch(() => null));
      return json(r, r.ok ? 200 : r.status);
    }
    if (req.method === "POST") {
      const got = await readTextCapped(req, STATE_BODY_MAX_BYTES);
      if (!got.ok) return got.response;
      await mkdirPrivate(stateDir);
      const r = await writeState(SENTINEL, stateDir, "state", got.value, exists,
        async (p, t) => { await writePrivate(p, t); });
      if (!r.ok) ctx.log("plugin.state.refused", { id, err: r.error.split("\n")[0] });
      return json(r, r.ok ? 200 : r.status);
    }
  }

  return null;
}
