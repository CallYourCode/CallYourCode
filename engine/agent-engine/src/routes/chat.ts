/* ROUTES: pages, trim and search (L4 interface; blueprint 4b row 29).
 * Extracted verbatim from server.ts routeRequest; each handler answers a
 * Response or null (not mine). The auth gates stay per-route
 * (requireOwner/requireLocal), exactly as the if-chain had them. */

import type { RoutesCtx } from "./ctx.ts";
import { wirePage } from "../chat/attach.ts";
import { JSON_BODY_MAX_BYTES, readJsonCapped } from "../storage/body-limits.ts";
import { ensureSeqs } from "../chat/chatlog.ts";
import { searchableText } from "../chat/chatmsg.ts";
import { json, requireOwner } from "../transport/httpx.ts";
import { normalizeQuery, scanChat } from "../chat/chat-search.ts";
import { rowsBySeq } from "../chat/chatstore.ts";
import { chatStore, metaFor, nameOverrideOf, restoredChats, restoredLogs, scheduleAgentSave, sessions } from "../sessions/session-state.ts";

export async function chatRoutes(ctx: RoutesCtx, req: Request, url: URL, path: string,
  server: import("bun").Server): Promise<Response | null> {

  /* ONE PAGE OF THE CONVERSATION, by seq (the pointer-pages brief). The attach
   * answer hands the app the pointer page and the tail; this is how it fetches
   * any page between them when scrolling up. `sealed` pages are immutable, so
   * the app trusts a fetched sealed page for the life of the process; only the
   * tail is ever refetched, and its `version` bumps as it grows. Read-only.
   * The page holds messages AND session records (`t: "s"` rows) on the one
   * seq axis; there is no separate activity route. */
  {
    const mPage = req.method === "GET" && path.match(/^\/session\/(.+)\/page\/(\d+)$/);
    if (mPage) {
      // Content: the tunnel and the host only, gated before the
      // session lookup so a refused peer cannot tell a 403 from a 404.
      const denied = await requireOwner(req, server);
      if (denied) return denied;
      const id = decodeURIComponent(mPage[1]);
      const s = sessions.get(id);
      if (!s) return json({ error: "no such session", known: false }, 404);
      const n = Math.max(0, Math.floor(Number(mPage[2])));
      return json(wirePage(s, n));
    }
  }


  /* Shorten one session's chat log: drop all of it, or all but the last N.
   *
   * WHY THIS EXISTS. CHAT_KEEP is Infinity because your own conversations are
   * worth keeping whole, so the log only ever grew, and the disposable session
   * the behaviour suites send to grew with it: 682 messages, 279 of them voice
   * notes, after a few days of test runs. That is not cosmetic. It broke two
   * tests that have nothing to do with each other. The app refuses to cache a
   * chat over 500 messages (history.ts MAX_CACHED), so the disk-cache test
   * failed at its own precondition, on a rig fault that reads exactly like the
   * bug it guards. And a chat that long makes every "open a chat and measure
   * something" test 40 times more expensive than the case it was calibrated on.
   * Editing .run/chat.json by hand does not work: this process holds the log in
   * memory and rewrites the file from that, so the edit is gone within a second.
   *
   * `keep` drops the FRONT and leaves the newest N, which is what the suite
   * wants: a sink small enough to be cacheable but still populated, so the
   * layout guards that need a chat with real history still have one. keep: 0
   * (the default) empties it.
   *
   * WHY IT IS SAFE. Losing a real conversation is unrecoverable, and the only
   * caller is a test rig, so two independent things must hold first:
   *
   *   1. the session's DISPLAY NAME must start with TEST-. The disposable sink
   *      is TEST-SINK; nothing you talk to is named that way.
   *   2. the request must echo that exact name. A wrong pane id then lands on a
   *      409 instead of on a real chat, which is the mistake worth guarding:
   *      pane ids are short, similar, and reassigned.
   *
   * Clips stay on disk. They are keyed by msgId and nothing references them once
   * the log entry is gone, so they are dead weight rather than a hazard, and
   * unlinking files is a worse thing to get wrong than leaving them. */
  if (req.method === "POST" && path.startsWith("/session/") && path.endsWith("/trim-log")) {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const id = decodeURIComponent(path.slice("/session/".length, -"/trim-log".length));
    const s = sessions.get(id);
    if (!s) return json({ ok: false, error: "no such session" }, 404);
    const shown = nameOverrideOf(s.id) ?? s.name;
    if (!/^TEST-/.test(shown)) {
      return json({
        ok: false,
        error: `refusing to trim ${id}: it is named ${JSON.stringify(shown)}, and only a ` +
          "session whose name starts with TEST- is treated as disposable. Rename it first " +
          "if you really mean it.",
      }, 403);
    }
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const body = got.value as { name?: unknown; keep?: unknown };
    if (body.name !== shown) {
      return json({
        ok: false,
        error: `confirm the name: POST {"name":${JSON.stringify(shown)}}. Got ` +
          `${JSON.stringify(body.name ?? null)}. This is here so a mistyped pane id cannot ` +
          "empty a chat you meant to keep.",
      }, 409);
    }
    const keepRaw = Number(body.keep ?? 0);
    if (!Number.isFinite(keepRaw) || keepRaw < 0) {
      return json({ ok: false, error: "keep must be a number >= 0" }, 400);
    }
    const keep = Math.floor(keepRaw);
    const before = s.chat.length;
    const dropped = Math.max(0, before - keep);
    if (dropped) s.chat = keep ? s.chat.slice(-keep) : [];
    /* The session records go with the messages: `keep` counts messages, and
     * the records kept are those from the oldest kept message onward (all of
     * them when the chat was already short enough, none when it is emptied). */
    ensureSeqs(s.chat, s.log);
    const floor = s.chat.length ? s.chat[0].seq : (keep ? -1 : Infinity);
    s.log = s.log.filter((r) => r.seq >= floor);
    /* The new file starts its seq axis at 0: renumber the merged rows in
     * storage order so the pages are dense again. */
    rowsBySeq(s.chat, s.log).forEach((r, i) => { r.seq = i; });
    restoredChats.delete(id);
    restoredLogs.delete(id);
    /* Append-only rule: a trim never rewrites lines. The kept tail becomes a
     * NEW chat file and the meta pointer flips; the old file stays as history. */
    try {
      const meta = metaFor(id);
      const cid = await chatStore.writeNew(meta.agentId, s.chat as unknown as Parameters<typeof chatStore.writeNew>[1], s.log);
      meta.chat = cid;
      meta.chats = [...(meta.chats ?? []), { id: cid, createdAt: Date.now() }];
      scheduleAgentSave(id);
    } catch (e) {
      console.error("[chat] trim rewrite failed:", e);
    }
    /* No broadcast. This is a TEST/admin path (the name must start with TEST- and
     * echo exactly), so nothing is watching a trimmed session live. The app has
     * no decode for a mid-session trim: a `log-trimmed` frame was sent and never
     * read, leaving an attached app showing the deleted tail
     * anyway. Rather than teach the app to drop rows for a disposable-sink op, the
     * contract is: trim requires a re-attach, and the next attach-ok replays the
     * trimmed log. */
    console.log(`[chat] trimmed ${shown} (${id}): dropped ${dropped}, kept ${s.chat.length}`);
    return json({ ok: true, name: shown, dropped, kept: s.chat.length });
  }


  /* Search one conversation, over the WHOLE log, here rather than in the app.
   *
   * "the search should not be on the app side, it should be done on the agent
   * engine, so we actually get the full count of how many results we are getting
   * in this whole session". The page holds whatever its
   * cursor asked for and its bubbles are a 300-item tail slice of that, so a
   * count taken in the browser is a count of a window. CHAT_KEEP is Infinity, so
   * the number here is the number for the conversation.
   *
   * WHAT IS SEARCHED, and what is not. `s.chat` is user messages and agent
   * replies, which are the two things that have a bubble to jump to. A voice
   * note's transcript IS its `text` (onUtterance stores it there, and rescues it
   * by re-transcribing when the device sent none), so voice notes are searched
   * like anything else and need no special case. Session records (the tool
   * calls in the activity overlay, `s.log`) are deliberately NOT here: they
   * draw as pills with no message identity for a jump to land on.
   *
   * A message can have no text at all: an attachment sent with no caption, and
   * an inline `show` whose title is empty. Those carry their name on `file` /
   * `upload` instead, so the FILE NAME is searched too -- looking for
   * "report.pdf" and being told a conversation that contains it has no results
   * would be the app lying about its own contents. Nothing else about an
   * attachment is matched: not its path, not its mime type.
   *
   * THE CAPS, and what happens past them:
   *   - the query is trimmed and cut to Q_MAX (200 chars). Longer than that is
   *     a paste, not a search;
   *   - an empty query is 400 rather than "every message", because "no query"
   *     and "matched nothing" must not look the same to the caller;
   *   - `total` is always the true count over the whole log. `hits` is at most
   *     HITS_MAX, taken from the NEWEST end, because that is the end you are
   *     reading from. Past the cap the count still tells the truth and the app
   *     numbers from the newest match as 1 (it reverses this list), so with
   *     2500 matches the counter walks "1 of 2500" down to "2000 of 2500" and
   *     the up arrow then stops: every number it shows is the right number, and
   *     what is lost is only how far back it can walk. MEASURED, 2026-08-03, on
   *     a seeded 2500-message log. `capped` is on the wire so the app can say
   *     that the stop is the cap rather than the end of the matches; nothing
   *     reads it yet.
   *
   * There is no time budget: this is one lowercase scan of an in-memory array,
   * and the longest real log here (2064 messages) is well under a millisecond.
   *
   * A hit names its message by `ts` and `role`, which is the same pair the
   * reply-jump already travels by (app: jumpToReply), because ChatMsg.id is the
   * SESSION id and there is no per-message id on the wire. */
  const csearch = path.match(/^\/chat-search\/(.+)$/);
  if (csearch && req.method === "GET") {
    // Content (query text + hits): the tunnel and the host only,
    // gated before the session lookup so a refused peer cannot tell 403 from 404.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const s = sessions.get(decodeURIComponent(csearch[1]));
    if (!s) return json({ error: "no such session" }, 404);
    const HITS_MAX = 2000;
    const q = normalizeQuery(url.searchParams.get("q"));
    if (!q) return json({ error: "q is required" }, 400);
    // ONE matcher, shared with the search plugin's rpc (scanChat + searchableText),
    // so the count and the matches cannot drift between the two callers. Each hit
    // carries its `seq`: the page address the app fetches (ensureMessageHeld) so a
    // match older than the held pages is reachable; ts + role stays the identity.
    const { total, matches } = scanChat(s.chat, searchableText, q);
    // keep the NEWEST window, exactly as before (the app numbers from the newest
    // match, so past the cap the up arrow stops rather than lying).
    const hits = matches.slice(-HITS_MAX);
    /* No `capped` on the wire. It was `total > hits.length`, which the app can
     * see for itself from the two numbers beside it, and nothing ever read it:
     * one question with two answers, waiting to disagree. The counter says
     * "2000 of 2500", which is the same fact where it is useful. */
    return json({ total, hits, scanned: s.chat.length });
  }

  return null;
}
