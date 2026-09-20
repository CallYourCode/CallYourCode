/* THE PUSH SINK: where the app server would be.
 *
 * Moved out of notify-harness.ts verbatim. It was only ever reachable by a spec
 * that booted a whole engine; it is a plain in-process Bun.serve on port 0 and
 * every seam test that wants to ask "what did the engine push, and when" can
 * have one for the cost of a function call.
 */

/* Stands in for the app server: records what the engine asked to be pushed and
 * when, and pushes nothing anywhere.
 *
 * GETs are answered but never recorded: the engine reads /settings from its
 * app server in the background (and read /voices too before #584), and a boot-time or
 * TTL-timed GET landing inside a test's window used to be indistinguishable
 * from a push. `settings` is mutable so a test can flip the user's global
 * defaults (the bell) and watch the engine honour them. */
export function pushSink() {
  const hits: Array<{ at: number; sessionId: string; body: string; decided?: boolean; unread?: number;
    title?: string; icon?: string; kid?: string; enc?: string }> = [];
  /** one entry per push that actually left the engine, whatever it carried */
  const batches: Array<{ at: number; sessions: number; dismissed: string[]; auth: string }> = [];
  const dismissals: Array<{ at: number; sessionId: string }> = [];
  const settings = { speed: 1, notify: true, sound: true, activity: true };
  /* A reachable app server that REFUSES with a non-2xx (a token typo is a 401,
   * an oversize batch a 413): the engine must re-queue and retry, not drop the
   * window (the never-drop rule). Zero = accept normally. */
  let refuseStatus = 0;
  /* A reachable app server that ACCEPTS (200) but reports it could not keep the
   * whole window: `truncated` over the per-batch cap, `dropped` over the rate cap
   * (#569). The engine must requeue exactly as it does for an outage, rather than
   * assume a 200 delivered everything. Null = a clean 200 that kept it all. */
  let capReport: { truncated?: number; dropped?: number } | null = null;
  /* One entry per /engines/announce the engine posted, in order. Kept OUT of
   * `hits` so discovery does not read as a push and pollute a push count. */
  const announces: Array<{ at: number; engineId: string; host: string; url: string;
    rev?: string; ts?: number; auth: string }> = [];
  /* Enrollment: the engine POSTs /engines/enroll before it
   * announces or pushes; the sink issues a fresh scratch token per enrollment
   * (so re-enrollment after a 401 is observable as a NEW token) and records
   * the bearer every later call presented. */
  const enrolls: string[] = [];
  const bearerOf = (req: Request) =>
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "GET") {
        const path = new URL(req.url).pathname;
        const body = path === "/settings" ? { ...settings, seq: 1 } :
          path === "/voices" ? { voices: [], default: "" } : {};
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      }
      if (new URL(req.url).pathname === "/engines/enroll") {
        // handled ahead of refuseStatus: refuse() means "the pushes are
        // refused", the way a dead/rotated token looks, not "enrollment down"
        const token = `cyt_sink_${enrolls.length + 1}_${crypto.randomUUID().slice(0, 8)}`;
        enrolls.push(token);
        return new Response(JSON.stringify({ ok: true, token, owner: "local" }),
          { headers: { "content-type": "application/json" } });
      }
      if (new URL(req.url).pathname === "/engines/announce") {
        const body = (await req.json().catch(() => ({}))) as any;
        announces.push({ at: Date.now(), engineId: String(body?.engineId ?? ""),
          host: String(body?.host ?? ""), url: String(body?.url ?? ""),
          ...(typeof body?.rev === "string" ? { rev: body.rev } : {}),
          ...(typeof body?.ts === "number" ? { ts: body.ts } : {}),
          auth: bearerOf(req) });
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
      if (refuseStatus) {
        return new Response(JSON.stringify({ error: "refused" }),
          { status: refuseStatus, headers: { "content-type": "application/json" } });
      }
      const body = (await req.json().catch(() => ({}))) as any;
      /* A BATCH IS THE NORMAL SHAPE NOW: one post per 10s window
       * carrying every session that changed. Recorded flattened, one hit per
       * session, so a test can still ask "was this chat pushed" without caring
       * how many rode along -- and `batches` answers "how many times did the
       * phone buzz", which is the question the batching exists for. */
      if (new URL(req.url).pathname === "/push/batch") {
        const at = Date.now();
        batches.push({ at, sessions: (body?.new ?? []).length,
          dismissed: [...(body?.dismiss ?? [])], auth: bearerOf(req) });
        for (const item of body?.new ?? []) {
          hits.push({ at, sessionId: String(item?.sessionId ?? ""), body: String(item?.body ?? ""),
            decided: true,
            title: typeof item?.title === "string" ? item.title : undefined,
            ...(Number.isFinite(item?.unread) ? { unread: Number(item.unread) } : {}),
            ...(typeof item?.icon === "string" ? { icon: item.icon } : {}),
            // task 527: capture the sealed blob so a spec can prove the wire body
            // is not the plaintext reply
            ...(typeof item?.kid === "string" ? { kid: item.kid } : {}),
            ...(typeof item?.enc === "string" ? { enc: item.enc } : {}) });
        }
        for (const id of body?.dismiss ?? []) dismissals.push({ at, sessionId: String(id) });
        return new Response(JSON.stringify({ ok: true, devices: 1, ...(capReport ?? {}) }), {
          headers: { "content-type": "application/json" },
        });
      }
      hits.push({ at: Date.now(), sessionId: String(body?.sessionId ?? ""),
        body: String(body?.body ?? ""), decided: body?.decided === true,
        title: typeof body?.title === "string" ? body.title : undefined,
        ...(typeof body?.icon === "string" ? { icon: body.icon } : {}),
        // the engine's own count, from its read marker: the app server sums
        // these for the icon badge rather than counting for itself
        ...(Number.isFinite(body?.unread) ? { unread: Number(body.unread) } : {}) });
      return new Response(JSON.stringify({ ok: true, devices: 1, count: hits.length }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { hits, batches, dismissals, announces, enrolls, settings, url: `http://127.0.0.1:${server.port}`,
    /** refuse every push with this status until accept(): a reachable-but-refusing server */
    refuse: (status = 401) => { refuseStatus = status; },
    accept: () => { refuseStatus = 0; },
    /** answer 200 but report a partial keep ({truncated, dropped}) until uncap() (#569) */
    cap: (report: { truncated?: number; dropped?: number }) => { capReport = report; },
    uncap: () => { capReport = null; },
    stop: () => server.stop(true) };
}
