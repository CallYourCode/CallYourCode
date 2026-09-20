/* The browser's log, on its way to disk.
 *
 * Same origin as the page, so there is no CORS and nothing to configure:
 * whatever served cyc.html is what writes the file. Answers 204 with no
 * body because the page sends this with sendBeacon on the way out and
 * cannot read a reply anyway.
 *
 * Nothing here can fail the request. A malformed body, an oversized batch
 * or a line full of control characters is trimmed and written; the one
 * thing a log sink must never do is make the page retry. */

import { safeCid, type Logbook } from "../../../engine/shared/logbook.ts";
import { readBodyCapped } from "../../../engine/shared/bodyread.ts";
import { type LogFn } from "../platform/httpx";
import { grantRate, clientKeyOf, type RateBucket } from "../platform/ratelimit";
import { CLIENTLOG_MAX_BYTES, CLIENTLOG_MAX_LINES, CLIENTLOG_MAX_CHARS,
  CLIENTLOG_RATE_MAX } from "../platform/caps";

export type ClientlogDeps = {
  hosted: boolean;
  deviceOwner(req: Request): Promise<unknown | null>;
  log: LogFn;       // the server's own book
  applog: Logbook;  // the page's lines, written raw
};

type Srv = { requestIP(r: Request): { address: string } | null };

const CONTROL = /[\u0000-\u001f]+/g;

export function makeClientlogRoute(deps: ClientlogDeps) {
  /* /clientlog's own budget: same shape as the push one, its own map and
   * ceiling. The page batches at 40 lines and rate-caps itself, so a real
   * device sits far under this; only a broken or hostile client meets it. */
  const rate = new Map<string, RateBucket>();

  return async (req: Request, path: string, srv: Srv): Promise<Response | null> => {
    if (path !== "/clientlog" || req.method !== "POST") return null;
    /* BOUNDED FIRST (DDoS hardening): this was the one unauthenticated route
     * that would buffer the server-wide 320MB body allowance. A real batch
     * is 40 lines; anything past the cap is dropped whole -- still a 204,
     * because a log sink must never make the page retry. In HOSTED the
     * writer must be a signed-in device (sendBeacon carries the __session
     * cookie); an anonymous line is dropped, not stored. Each client also
     * has a per-minute line budget. */
    const capped = await readBodyCapped(req, CLIENTLOG_MAX_BYTES);
    if (!capped.ok || capped.value.byteLength > CLIENTLOG_MAX_BYTES) {
      deps.log("clientlog.refused", { cap: CLIENTLOG_MAX_BYTES,
        why: "the POST is larger than any real log batch; dropped, not stored" });
      return new Response(null, { status: 204 });
    }
    if (deps.hosted && !(await deps.deviceOwner(req))) {
      return new Response(null, { status: 204 });
    }
    let body: any = null;
    try { body = JSON.parse(new TextDecoder().decode(capped.value)); } catch { /* below */ }
    const linesAll: unknown[] = Array.isArray(body?.lines) ? body.lines : [];
    const budget = grantRate(rate, clientKeyOf(req, srv),
      Math.min(linesAll.length, CLIENTLOG_MAX_LINES), CLIENTLOG_RATE_MAX,
      "clientlog.rate.limited", deps.log);
    const lines = linesAll.slice(0, budget);
    const device = safeCid(body?.device) || "?";
    const page = safeCid(body?.page) || "?";
    const dropped = Number(body?.dropped) || 0;
    if (dropped) {
      deps.applog.line("log.dropped", { dev: device, pg: page, n: dropped,
        why: "the page's own queue overflowed before these could be sent" });
    }
    let n = 0;
    for (const raw of lines) {
      if (n++ >= CLIENTLOG_MAX_LINES) {
        deps.applog.line("log.truncated", { dev: device, pg: page,
          sent: lines.length, kept: CLIENTLOG_MAX_LINES });
        break;
      }
      const text = String(raw).replace(CONTROL, " ").slice(0, CLIENTLOG_MAX_CHARS);
      if (!text.trim()) continue;
      /* Written RAW rather than through line(), because the page has
       * already formatted it: it stamped the time the event happened, which
       * is not the time this batch arrived, and the difference is exactly
       * what a "did it happen before I navigated away" question turns on. */
      deps.applog.raw(text);
    }
    return new Response(null, { status: 204 });
  };
}
