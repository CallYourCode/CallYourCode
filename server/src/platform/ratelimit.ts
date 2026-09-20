/* FLOOD PROTECTION, per identity (his call, 2026-08-08).
 *
 * An agent engine is somebody else's software (the open-source idea in
 * 31-ideas.md), and one that pushes every message the instant it lands would
 * otherwise feed this server, and through it the phone, at exactly the rate
 * it decided. The app already batches per 10s (BATCH_MS); this bounds the RATE
 * a single identity may hand that batcher.
 *
 * MINIMAL BY DESIGN, because a hostile engine only hurts its own user: this is
 * flood protection, not armor. A fixed count per rolling minute per key; over
 * the cap the surplus is dropped with ONE log line for the window, never one
 * per message and never a crash.
 *
 * WHO ONE BUCKET BELONGS TO: authenticated engine routes key on
 * `engine:<engineId>` (finer than any address key, immune to the
 * reverse-proxy collapse where a proxy hands every request over from
 * 127.0.0.1). The address fallback (clientKeyOf) survives for /clientlog: the
 * forwarded client when a LOOPBACK proxy stamped x-forwarded-for, else the
 * peer address; a remote direct caller cannot spoof its way into a fresh
 * bucket with a forged x-forwarded-for because the header is only believed
 * when the TCP peer is this host's own proxy (loopback). */

import { PUSH_RATE_WINDOW_MS } from "./caps";
import type { LogFn } from "./httpx";

export type RateBucket = { start: number; count: number; logged: boolean };

export const isLoopbackAddr = (a: string | null) =>
  !!a && (a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127."));

/** The identity one rate bucket belongs to: the proxied client when a
 * loopback proxy stamped one, else the peer address. */
export function clientKeyOf(req: Request, srv: { requestIP(r: Request): { address: string } | null }): string {
  const addr = srv.requestIP(req)?.address ?? "?";
  if (isLoopbackAddr(addr)) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return "xff:" + (xff.split(",")[0] ?? "").trim().slice(0, 64);
  }
  return addr;
}

/* How many of `want` messages this bucket may push right now. Advances the
 * window, charges the granted count, and logs the drop ONCE per window (the
 * first message it turns away), so a flood is one log line rather than N.
 * `now` is injectable so a test can walk the window without sleeping. */
export function grantRate(map: Map<string, RateBucket>, key: string, want: number,
                          max: number, event: string, log: LogFn,
                          now: number = Date.now()): number {
  let b = map.get(key);
  if (!b || now - b.start >= PUSH_RATE_WINDOW_MS) {
    b = { start: now, count: 0, logged: false };
    map.set(key, b);
    /* the map itself must not grow without bound under an address-spoofing
     * flood: past a generous ceiling the stalest windows go */
    if (map.size > 10_000) {
      for (const [k, v] of map) {
        if (now - v.start >= PUSH_RATE_WINDOW_MS) map.delete(k);
      }
    }
  }
  const grant = Math.max(0, Math.min(want, max - b.count));
  b.count += grant;
  if (grant < want && !b.logged) {
    b.logged = true;
    log(event, { key, cap: max, windowMs: PUSH_RATE_WINDOW_MS,
      why: "the per-minute cap was crossed; the rest of this window is dropped" });
  }
  return grant;
}
