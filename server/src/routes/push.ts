/* The push surface, both sides of it.
 *
 * DEVICE side (same origin as the page): subscribe/unsubscribe, the key, the
 * device list, shown receipts, read receipts, and the test button.
 *
 * ENGINE side (/push/notify, /push/batch): an agent engine asking for a device
 * to be buzzed. It sends what to say, never who to say it to. One banner per
 * chat: the count is kept per owner so a burst of replies merges into "3 new
 * messages" instead of three separate buzzes, and reading the chat anywhere
 * resets it. Both engine routes are authenticated by the issued per-engine
 * token and rate-capped per engine. */

import { json, engineBody, engineSessionId, type LogFn } from "../platform/httpx";
import { grantRate, type RateBucket } from "../platform/ratelimit";
import { carrySealed } from "../delivery/push";
import { PUSH_RATE_MAX, BATCH_ITEMS_MAX, SESSION_ID_MAX } from "../platform/caps";
import type { Owners } from "../access/owners";
import type { EngineTokenRec } from "../access/enroll";

export type PushDeps = {
  owners: Pick<Owners, "deviceOwner" | "engineAuth" | "engineStore" | "vapidPublicKey">;
  log: LogFn;
};

/* A SEALED push's visible fields ARE the generic fallback. The current engine
 * already puts only these on the wire (the real title/body/count ride inside
 * `enc`), but this relay treats an engine as somebody else's software, so it
 * enforces the contract itself: whenever `enc` is present, the visible title
 * and body are forced to these constants before anything is logged or
 * forwarded. A plaintext title/body beside `enc` is a broken or old engine and
 * its content never reaches the log file or a device. */
const GENERIC_TITLE = "CallYourCode";
const GENERIC_BODY = "New message";

export function makePushRoutes(deps: PushDeps) {
  const { owners, log } = deps;
  const pushRate = new Map<string, RateBucket>();

  /** How many of `want` messages this engine may push right now. */
  const grantPush = (eng: EngineTokenRec, want: number): number =>
    grantRate(pushRate, `engine:${eng.engineId}`, want, PUSH_RATE_MAX,
      "push.rate.limited", log);

  return async (req: Request, path: string): Promise<Response | null> => {
    // ---- device-side: what the browser calls (same origin)
    if (path === "/push/key") return json({ key: owners.vapidPublicKey() });

    if (path === "/push/subscribe" && req.method === "POST") {
      const store = await owners.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      const push = store.push;
      const body = (await req.json().catch(() => null)) as any;
      const ok = push.subscribe(
        body?.subscription,
        String(body?.label ?? "").slice(0, 60),
        String(body?.deviceId ?? "").slice(0, 64),
        /* A test says so, and is then kept away from the real devices: it can
         * never replace one, and it is reaped rather than carried for ever.
         * The e2e suite registers real subscriptions against this server, and a
         * run was leaving five of them beside the phone and the tablet. */
        body?.test === true,
      );
      return json({ ok, devices: push.count }, ok ? 200 : 400);
    }

    /* Forget every test subscription, now. For a suite to call when it is done,
     * so a run leaves the store exactly as it found it. Devices are never
     * touched by this. */
    if (path === "/push/reap-tests" && req.method === "POST") {
      const store = await owners.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      const gone = store.push.reapTests("asked to", true);
      return json({ ok: true, reaped: gone, devices: store.push.count });
    }

    if (path === "/push/unsubscribe" && req.method === "POST") {
      const store = await owners.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => null)) as any;
      return json({ ok: store.push.unsubscribe(String(body?.endpoint ?? "")), devices: store.push.count });
    }

    if (path === "/push/devices") {
      const store = await owners.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      return json({ devices: store.push.list() });
    }

    /* A shown receipt is telemetry from the worker, not a state-changing client
     * command. It deliberately has the same no-auth posture as the other
     * same-origin device endpoints. Unknown ids still get recorded with the
     * device timestamp, because a server restart may have forgotten the send. */
    if (path === "/push/shown" && req.method === "POST") {
      const store = await owners.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => null)) as any;
      const id = typeof body?.id === "string" ? body.id.slice(0, 64) : "";
      const kind = typeof body?.kind === "string" ? body.kind.slice(0, 32) : "?";
      const clientAt = typeof body?.at === "number" && Number.isFinite(body.at) ? body.at : Date.now();
      const sendAt = id ? store.push.sentAt(id) : undefined;
      log("push.shown", sendAt === undefined
        ? { id, kind, at: clientAt }
        : { id, kind, lagMs: clientAt - sendAt });
      return json({ ok: true });
    }

    // ---- engine-side
    if (path === "/push/notify" && req.method === "POST") {
      const eng = owners.engineAuth(req);
      if (!eng) return json({ error: "unauthorized" }, 401);
      const parsed = await engineBody(req, log);
      if ("reject" in parsed) return parsed.reject;
      const body = parsed.body;
      const store = await owners.engineStore(eng);
      if (!store) return json({ error: "no owner" }, 400);
      const push = store.push;
      const pending = store.pending;
      const title = String(body?.title ?? "CallYourCode").slice(0, 100);
      const text = String(body?.body ?? "").slice(0, 2000);
      const sessionId = engineSessionId(body?.sessionId);
      if (!text) return json({ error: "empty body" }, 400);
      /* The session's avatar, when the engine can name a URL the OS can fetch.
       * Absent/null means "no photo (or no public base)": the worker keeps the
       * logo. Bounded like a session id; nothing legitimate is near it. */
      const icon = typeof body?.icon === "string" && body.icon ? body.icon.slice(0, 1000) : undefined;
      /* An engine-level push names its raising PLUGIN (what sessionId is to a
       * session push): opaque routing/dedup metadata, forwarded as-is like the
       * tag, never content. A plugin id is not sensitive. */
      const plugin = typeof body?.plugin === "string" && body.plugin ? body.plugin.slice(0, 64) : undefined;
      /* NO CONTENT LOGIC. An engine-level push (the plan-usage alert) is sealed
       * under the engine key and this server cannot read it, so it does not try
       * to reason about it either: the account merge that used to live here is
       * gone (the owner's call: forward, that's it). A user with several
       * machines on one account gets one buzz per machine. */
      /* THE PER-ENGINE RATE CAP. The ordinary per-chat message is what a
       * runaway engine floods, so the cap sits here. Over it the message is
       * dropped with a plain ok (never a 4xx that would make an engine retry
       * into the cap), and the badge maps are not grown for a message that
       * never left. */
      if (grantPush(eng, 1) < 1) {
        return json({ ok: true, dropped: true, devices: push.count });
      }
      /* Computed once, spread byte-for-byte at the send site below. When `enc`
       * is present the visible fields ARE the generic fallback; a plaintext
       * title/body is not forwarded and (see the log line) never recorded. */
      const sealed = carrySealed(body);
      const outTitle = sealed.enc ? GENERIC_TITLE : title;
      const outBody = sealed.enc ? GENERIC_BODY : text;
      /* Lengths and sealedness only, never a content byte: whatever a foreign
       * or old engine put in title/body does not land in the on-disk log. */
      log("push.notify", { session: sessionId, ...(plugin ? { plugin } : {}),
        devices: push.count,
        sealed: !!sealed.enc, titleLen: title.length, bodyLen: text.length });
      /* THE ENGINE'S NUMBER. This server does not count.
       *
       * The engine derives it from the one read marker it holds for that
       * session, so it is the same number the row shows and it goes
       * DOWN when the chat is read on any device.
       *
       * NO FALLBACK, and that is a deliberate deletion. This server counting
       * for itself is what produced the stuck badge, and every replacement
       * guess is the same mistake in a new size: a local `+1` rises without
       * bound, a flat 1 still asserts a number nobody measured. An engine that
       * did not send the field has told us nothing about that chat, so the
       * honest move is to leave the badge exactly where it was and still send
       * the banner. */
      const engineUnread = Number(body?.unread);
      const known = Number.isFinite(engineUnread) && engineUnread >= 0;
      if (sessionId && known) {
        if (engineUnread > 0) {
          if (store.room(pending, sessionId, "pending")) pending.set(sessionId, engineUnread);
        } else pending.delete(sessionId);
      }
      const count = known ? engineUnread : 1; // the banner's "N new messages"
      await push.send({
        title: outTitle,
        body: outBody,
        sessionId,
        ...(plugin ? { plugin } : {}),
        tag: body?.tag ? String(body.tag).slice(0, SESSION_ID_MAX) : sessionId || undefined,
        count,
        icon,
        // E2E (task 527): relay the sealed blob untouched; we cannot read it.
        ...sealed,
        // the home screen badge: the SUM of the counts across every session on
        // every host, which is the number you get by adding up the rows. It was
        // `pending.size` -- how many chats had ever pushed -- so it stuck at the
        // number of chats and never matched anything on screen.
        badge: store.badge(),
      });
      return json({ ok: true, suppressed: false, devices: push.count, count });
    }

    /* ONE WINDOW'S WORTH FROM ONE ENGINE.
     *
     * This server does NOT trust the engine's batching, and that is the reason
     * it batches at all rather than forwarding: an engine is somebody else's
     * software (the open-source idea in 31-ideas.md), and one that pushes every
     * message the instant it lands would otherwise reach the phone at exactly
     * the rate it decided.
     *
     * The same 10s wall-clock boundary as the engine, fired a moment AFTER it,
     * so an aligned engine's post lands inside this window instead of missing
     * it by a millisecond. Aligned windows overlap; they do not stack.
     *
     * Combining across engines is the point. One phone serves example, work and
     * linux, and only this server sees all three, so the decision about what
     * one push should contain belongs here. */
    if (path === "/push/batch" && req.method === "POST") {
      const eng = owners.engineAuth(req);
      if (!eng) return json({ error: "unauthorized" }, 401);
      const parsed = await engineBody(req, log);
      if ("reject" in parsed) return parsed.reject;
      const body = parsed.body;
      const store = await owners.engineStore(eng);
      if (!store) return json({ error: "no owner" }, 400);
      const push = store.push;
      const pending = store.pending;
      const outNew = store.outNew;
      const outDismiss = store.outDismiss;
      const host = String(body?.host ?? "?").slice(0, 100);
      /* CAPPED, NOT REFUSED (as /report caps its lines): one window from one host
       * carries at most a handful of chats, so an array past the cap is a broken
       * or hostile engine, and processing the first BATCH_ITEMS_MAX keeps a real
       * batch whole while it cannot make this server loop over a giant array. */
      const freshAll: any[] = Array.isArray(body?.new) ? body.new : [];
      const goneAll: unknown[] = Array.isArray(body?.dismiss) ? body.dismiss : [];
      const freshCut = freshAll.slice(0, BATCH_ITEMS_MAX);
      const goneCut = goneAll.slice(0, BATCH_ITEMS_MAX).map(engineSessionId);
      if (freshAll.length > BATCH_ITEMS_MAX || goneAll.length > BATCH_ITEMS_MAX) {
        log("push.batch.truncated", { host, cap: BATCH_ITEMS_MAX,
          sentNew: freshAll.length, keptNew: freshCut.length,
          sentDismiss: goneAll.length, keptDismiss: goneCut.length,
          why: "more sessions in one batch than any real window carries" });
      }
      /* THE PER-ENGINE RATE CAP, same window and origin as /push/notify: a batch
       * carries many messages, so it is charged its whole size and cut to what
       * the window still allows. New messages are kept before dismissals, and
       * grantPush logs the drop once for the window. */
      const budget = grantPush(eng, freshCut.length + goneCut.length);
      const fresh = freshCut.slice(0, budget);
      const gone = goneCut.slice(0, Math.max(0, budget - fresh.length));
      /* WHAT THIS WINDOW DID NOT KEEP, so the engine can requeue it instead of
       * assuming a 200 delivered everything (#569). `truncated` is what the
       * per-batch cap cut; `dropped` is what the per-minute rate cap cut. They
       * are disjoint (the rate cap only ever sees the post-truncation items), so
       * the engine requeues on `truncated + dropped > 0`. */
      const truncated = (freshAll.length - freshCut.length) + (goneAll.length - goneCut.length);
      const dropped = (freshCut.length - fresh.length) + (goneCut.length - gone.length);
      for (const item of fresh) {
        const sessionId = engineSessionId(item?.sessionId);
        if (!sessionId) continue;
        const text = String(item?.body ?? "").slice(0, 2000);
        /* The session's avatar, as on /push/notify: only a string survives, and
         * null/absent means the worker keeps the logo. */
        const icon = typeof item?.icon === "string" && item.icon ? item.icon.slice(0, 1000) : undefined;
        /* THE ENGINE'S NUMBER, as on /push/notify: this server never counts for
         * itself. No field means it told us nothing about that chat, so the
         * badge stays exactly where it was. */
        const unread = Number(item?.unread);
        if (Number.isFinite(unread) && unread >= 0) {
          if (unread > 0) {
            if (store.room(pending, sessionId, "pending")) pending.set(sessionId, unread);
          } else pending.delete(sessionId);
        }
        outDismiss.delete(sessionId); // it is unread again
        /* Same sealed-when-enc rule as /push/notify: a sealed item's stored
         * visible fields ARE the generic fallback, so flushOut (which reuses
         * sessions[0].title/body) is safe by construction and no plaintext
         * beside `enc` survives the rebuild. */
        const itemSealed = carrySealed(item);
        if (store.room(outNew, sessionId, "outNew")) {
          outNew.set(sessionId, {
            sessionId,
            title: itemSealed.enc ? GENERIC_TITLE : String(item?.title ?? GENERIC_TITLE).slice(0, 100),
            body: itemSealed.enc ? GENERIC_BODY : text,
            count: Number.isFinite(unread) && unread > 0 ? unread : 1,
            ...(icon ? { icon } : {}),
            // E2E (task 527): carry the sealed blob through the rebuild. Without
            // this explicit pass-through the OutItem reconstruction drops it.
            ...itemSealed,
          });
        }
      }
      for (const sessionId of gone) {
        if (!sessionId) continue;
        pending.delete(sessionId);
        outNew.delete(sessionId);
        if (store.room(outDismiss, sessionId, "outDismiss")) outDismiss.add(sessionId);
      }
      log("push.batch", { host, new: fresh.length, dismiss: gone.length,
        truncated, dropped, devices: push.count, waiting: outNew.size + outDismiss.size });
      store.scheduleOut();
      return json({ ok: true, devices: push.count, queued: outNew.size + outDismiss.size,
        truncated, dropped });
    }

    /* A device opened (or read) a chat: the banner has served its purpose, so
     * it goes away on the OTHER devices too and the count starts again.
     *
     * It joins the SAME outgoing window as everything else,
     * and that is a fix, not tidiness. It used to be its own immediate push
     * with dismiss:true, while the engine reported the very same read through
     * /push/batch a moment later: two pushes for one read, and on iOS two
     * banners, because a push that shows nothing costs Safari the permission so
     * the worker has to show a placeholder for each. Read three chats and the
     * lock screen held six "Read on another device" lines and no messages,
     * which is what he photographed on 2026-08-03.
     *
     * Through the window, the engine's dismissal and this one are the same
     * entry in a Set, so one read is one push and (with the worker's single
     * placeholder tag) at most one placeholder. It costs up to ten seconds
     * before the banner clears on the other devices, which is the same latency
     * every other notification decision already accepted. */
    if (path === "/push/read" && req.method === "POST") {
      const store = await owners.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => null)) as any;
      const sessionId = String(body?.sessionId ?? "");
      if (!sessionId) return json({ error: "no session" }, 400);
      const had = store.pending.delete(sessionId);
      if (had) {
        store.outNew.delete(sessionId); // read inside the window: it never buzzes
        store.outDismiss.add(sessionId);
        store.scheduleOut();
      }
      return json({ ok: true, cleared: had });
    }

    if (path === "/push/test" && req.method === "POST") {
      const store = await owners.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      await store.push.send({
        title: "CallYourCode",
        body: "Push is working.",
        sessionId: "",
        tag: "cyc-test",
      }, "test");
      return json({ ok: true, id: store.push.lastSentId, devices: store.push.count });
    }

    return null;
  };
}
