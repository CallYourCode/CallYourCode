/* ROUTES: /health, the services restart, and the state debug probe (L4 interface; blueprint 4b row 29).
 * Extracted verbatim from server.ts routeRequest; each handler answers a
 * Response or null (not mine). The auth gates stay per-route
 * (requireOwner/requireLocal), exactly as the if-chain had them. */

import type { RoutesCtx } from "./ctx.ts";
import { askCommitted, asks } from "../chat/asks.ts";
import { utterQueue } from "../chat/deliver.ts";
import { json, requireLocal, requireOwner } from "../transport/httpx.ts";
import { unsubmitted } from "../chat/pane-deliver.ts";
import { agentMetas, paneBindings, sessionStateProbe } from "../sessions/session-state.ts";
import { hasIngest } from "../chat/ingest.ts";

/* WHICH REV A .deployed-rev STAMP FILE NAMES.
 *
 * scripts/deploy-engines.sh writes "<sha> <iso-timestamp>\n" and older runs of
 * it wrote the sha alone, so both shapes are on real hosts right now and both
 * have to answer the same sha. An empty (or absent) file is an EMPTY STRING,
 * never a guess: the deploy report prints "rev unknown" for that, and an
 * invented rev would be the report's own failure mode ("says what was asked
 * for, not what happened") moved one process to the left.
 *
 * It lives here, beside the route that serves the field, rather than inside
 * server.ts's boot IIFE, because server.ts cannot be imported without booting
 * an engine and this one line decides what the whole deploy report reads. */
export function revFromStamp(text: string): string {
  return text.trim().split(/\s+/)[0] ?? "";
}

export async function healthRoutes(ctx: RoutesCtx, req: Request, url: URL, path: string,
  server: import("bun").Server): Promise<Response | null> {

  if (ctx.notifyDebug && req.method === "GET" && path === "/debug/session-companions") {
    // Debug-only probe (NOTIFY_DEBUG, off in prod). Defense-in-depth: localhost
    // is the only legitimate caller, so gate it local-only even behind the flag.
    const denied = requireLocal(req, server);
    if (denied) return denied;
    const id = url.searchParams.get("id") ?? "";
    const paneId = url.searchParams.get("pane") ?? "";
    const csid = url.searchParams.get("csid") ?? id;
    return json({
      ...sessionStateProbe(id),
      tailOffsets: !!agentMetas.get(id)?.tails?.[csid],
      tailWatch: !!(id && hasIngest(id)) || !!(paneId && hasIngest(paneId)),
      asks: paneId ? asks.has(paneId) : false,
      askCommitted: paneId ? askCommitted.has(paneId) : false,
      utterQueue: utterQueue.has(id),
      unsubmitted: paneId ? unsubmitted.has(paneId) : false,
      paneBindings: paneId ? paneBindings.has(paneId) : false,
    });
  }


  if (path === "/health") {
    /* TRIMMED to bootstrap metadata (sealed-transport enforcement): {ok, rev}
     * and nothing else. It used to carry the voice probe + voice URL, the
     * session count and the whole supervised-service table -- host telemetry a
     * bare tailnet peer could read. Those readings ride the sealed channel now
     * (the {t:"voice"} frame, the sessions frame); the deploy report only ever
     * needed ok + rev, so the rest is dropped rather than owner-gated. */
    return json({ ok: true, rev: ctx.rev });
  }


  // The plan limits for the account signed in on THIS machine: which account,
  // how much of the five-hour and weekly windows is gone, when they reset.
  /* NO /limits ROUTE ANY MORE (blueprint section 3): the usage card is the
   * one surface for plan usage (U8 forbids an app fallback), and the card
   * rides /plugin/usage-card/card. */

  /* The /reply-level compat shim is gone (blueprint section 3): global reads
   * and writes ride the reply-dials plugin rpc. */



  /* Rename a session. herdr first, so its own panel agrees; our override is
   * kept regardless, because a rename that quietly did nothing is worse than
   * one that only applies here. An empty name clears the override. */
  /* Restart ONE supervised service, by table key, through this engine's own
   * supervision (ctx.services.ts restart): the voice-model commands call this after
   * a model change so just that service picks the new file up. Localhost-only,
   * like every other machine control: a tailnet peer can read /health but not
   * bounce a service. */
  if (req.method === "POST" && path.startsWith("/services/") && path.endsWith("/restart")) {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const key = decodeURIComponent(path.slice("/services/".length, -"/restart".length));
    const restarted = await ctx.services.restart(key);
    return json(restarted, restarted.ok ? 200 : 409);
  }

  return null;
}
