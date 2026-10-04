/* THE AGENT->APP PATH (L3 feature): a session putting words in front of the
 * user, out loud or written.
 *
 * The ack the MCP tool waits on is issued only after logChat and the
 * broadcast, carrying msg.seq as proof the log write happened first (#447).
 * Ingest is idempotent per caller key (#505/#576: committed index + in-flight
 * reservation). THE MESSAGE FIRST, THEN THE CLIP: the row ships before the
 * first TTS chunk exists (#speak-latency) and the clip is a background
 * enrichment (tts.ts speakClip).
 *
 *   bun test agent-engine/src/reply.test.ts
 */

import { safeCid } from "../../../shared/logbook.ts";
import { stampTs, logChat, dedupeIndex, rememberKey, clearQueuedByReply } from "./chatlog.ts";
import { markRead, markReadRow } from "../sessions/readstate.ts";
import { growing } from "./clips.ts";
import { speakClip } from "../voice/tts.ts";
import { chunkText } from "../voice/tts-stream.ts";
import type { ChatMsg } from "./chatmsg.ts";
import type { Session } from "../sessions/session-state.ts";
import type { Sock } from "../transport/sock.ts";

export type ReplyDeps = {
  sessionOf(id: string): Session | undefined;
  sessionByHandle(handle: string): Session | undefined;
  /** the one resolution ladder: agent id, harness session id (current or
   *  past, through the index), live mux handle (session-state.resolveSession) */
  resolveSession(id: string): Session | undefined;
  send(ws: Sock, msg: unknown): void;
  broadcast(msg: unknown): void;
  broadcastSessions(): void;
  log(event: string, fields: Record<string, unknown>): void;
  /** the Stop hook's evidence: a reply came back */
  noteReply(sessionId: string): void;
  notifyUnlessWatched(s: Session, n: { title: string; body: string; msgKey: string; ts: number }): Promise<void> | void;
  sessionPushTitle(s: Session): string;
};

let deps: ReplyDeps | null = null;
export function initReply(d: ReplyDeps): void {
  deps = d;
}
const D = (): ReplyDeps => {
  if (!deps) throw new Error("reply not initialised");
  return deps;
};

/* The two ways a session can put words in front of the user: out loud, or as a
 * written message. Same socket, same chat log; speak additionally gets a voice.
 *
 * `chat` exists because reply levels 1 to 3 ask for a written answer and for a
 * long time there was nothing to ask WITH. The instruction shipped, the tool did
 * not, and the written reply landed in a terminal nobody was looking at. */
export async function onSpeak(ws: Sock, m: any) {
  return onReply(ws, m, true);
}

export async function onChat(ws: Sock, m: any) {
  return onReply(ws, m, false);
}

/* The ack fields a delivery yields, decoupled from HOW they are returned to the
 * caller. `null` means "empty text, deliver nothing" -- the old onReply's silent
 * `return`, kept as an explicit value so both callers can honour it. */
export type ReplyAck = { ok: boolean; message: string; seq?: number };

export async function onReply(ws: Sock, m: any, aloud: boolean) {
  /* THE ACK THE MCP TOOL WAITS ON (#447). speak/chat used to return the moment
   * the frame left the MCP's send buffer, which is why "a tool ack is not
   * delivery": after a restart a socket could hold a raw pane id with no
   * session, every reply it carried died on the DROPPED return below, and the
   * agent's Stop hook was told it had spoken. Now the tool returns only once
   * THIS engine has confirmed. The msgId echoed is the WIRE one (m.msgId),
   * because that is the id the MCP is keyed on. `show` has always answered this
   * way ({t:"shown"}). */
  const ackSaid = (ok: boolean, message: string, seq?: number) =>
    D().send(ws, { t: "said", ok, msgId: m.msgId, message, ...(seq !== undefined ? { seq } : {}) });
  /* RE-RESOLVE ON EVERY REPLY, because register can win a race it never
   * replays. On an engine restart the voice channel reconnects within a
   * second, and if herdr's reconcile has not repopulated `sessions` yet,
   * onRegister holds the socket with the raw pane id and no session. The
   * socket then stays OPEN for hours, never re-registering, and every reply
   * it carries died right here on a silent `return` -- 2026-08-09, ~25
   * minutes of his replies gone with the tools still acking. So the pane id
   * is resolved again at use time, when herdr has long since caught up, the
   * repaired id is cached on the socket, and a drop is never silent.
   *
   * The loopback POST /agent/reply route (server.ts) resolves its session by
   * pane and then calls deliverReply directly, so this ws re-resolution is the
   * one thing the two paths do NOT share -- everything after the session is in
   * hand is deliverReply, byte for byte. */
  const d = D();
  let s = ws.data.sessionId ? d.sessionOf(ws.data.sessionId) : undefined;
  if (!s && ws.data.sessionId) {
    s = d.sessionByHandle(ws.data.sessionId);
    if (s) {
      console.log(`[session] ~ ${ws.data.sessionId} late-resolved to ${s.id}; replies flow again`);
      ws.data.sessionId = s.id;
    }
  }
  /* THE CONSUMER HOLDS A HARNESS SESSION ID. A voice MCP that registered
   * under the claude uuid keeps addressing it after the harness rolled; the
   * session index maps every id the agent ever answered to onto its row, so
   * the late frame routes to the agent instead of being dropped. The repaired
   * id is cached on the socket, same as the handle repair above. */
  if (!s && ws.data.sessionId) {
    s = d.resolveSession(ws.data.sessionId);
    if (s) {
      console.log(`[session] ${ws.data.sessionId} -> ${s.id} routed (${aloud ? "speak" : "chat"})`);
      ws.data.sessionId = s.id;
    }
  }
  if (!s) {
    console.log(`[session] ! reply DROPPED: no session for '${ws.data.sessionId}' (${String(m.text ?? "").length} chars, ${aloud ? "speak" : "chat"})`);
    // Tell the tool it failed, so the Stop hook retries rather than losing the
    // reply the way it did on 2026-08-09. This is the drop the whole change is
    // about: the frame arrived, and there is nowhere durable to put it.
    return ackSaid(false, "this session is not registered with the engine yet; retry the reply in a moment");
  }
  const ack = await deliverReply(s, { aloud, text: m.text, msgId: m.msgId, key: m.key });
  // A null ack is the empty-text case: the old code returned in silence, so do
  // the same here and send no `said` frame at all.
  if (ack) ackSaid(ack.ok, ack.message, ack.seq);
}

/* THE DELIVERY CORE (mcp-http): everything from a resolved session to the ack
 * fields -- dedupe, the chat-log write, the broadcast, the notification, the
 * background TTS -- with the transport removed. onReply (the /ws frame) calls
 * this and sends the ack over the socket; the loopback POST /agent/reply route
 * calls this and returns the ack as the HTTP response. One body, so a reply
 * logs and accounts for its seq identically whichever door it came in.
 *
 * Returns the ack fields, or `null` for empty text (deliver nothing), which is
 * the silent `return` the ws handler used to do inline. */
export async function deliverReply(
  s: Session,
  o: { aloud: boolean; text: string; msgId?: string; key?: string },
): Promise<ReplyAck | null> {
  const d = D();
  const aloud = o.aloud;
  const okMsg = aloud ? "spoke" : "sent to the chat";
  const text = String(o.text ?? "").trim();
  /* THE WRITE TWIN of clipOnDisk's filter, and the more expensive half.
   *
   * This msgId is a raw wire string off a `speak` or `chat` frame, and it is
   * pasted into a path twice: cacheAudio writes the TTS bytes to
   * audioPath(msgId), and audioDurationS then shells that same path to ffprobe.
   * A traversal msgId therefore writes bytes outside AUDIO_DIR and hands the
   * path to a subprocess. clipOnDisk was closed last round for the READ; a
   * write earns the same filter with less argument.
   *
   * FALLING BACK RATHER THAN REJECTING, and that is the whole of the choice. A
   * rejection here would drop a reply an agent has already returned from and
   * that Example is owed, to punish a field nothing depends on: the only
   * minter is engine/mcp/src/server.ts, which sends randomUUID() and prints it back to
   * the agent for its own logs. Every consumer -- the `say` frame, the chat
   * log, notifyUnlessWatched's msgKey, the app's heard marker -- takes
   * whichever id this line settles on, so substituting a fresh one costs the
   * caller a log line and costs the user nothing. Silence would cost a reply.
   * Same shape as safeCid's own contract: "anything else becomes "" and the
   * call site falls back to its own id". */
  const msgId = safeCid(o.msgId) || crypto.randomUUID();
  if (!text) return null;

  /* IDEMPOTENT INGEST (#505), and the guard the whole change is for. The MCP
   * mints one key per logical utterance and reuses it on retry, so a frame
   * whose key we have already recorded is that retry: record NOTHING, and
   * re-ack the ORIGINAL (its seq), which makes the "Retry the tool call" advice
   * in the ack-timeout error safe instead of duplicating. Keyed per session and
   * bounded, no content hashing and no time window: the caller's key is the
   * whole of the identity. A frame with no key (an MCP older than #505) skips
   * this and keeps the old at-least-once behaviour. This keyless path is
   * PERMANENT, not a cleanup pending: a long-lived pane can hold a pre-#505 MCP
   * process across an engine deploy (panes survive restarts), so a live process
   * can still send a keyless frame -- it is not only a relic of stored rows. */
  const key = typeof o.key === "string" && o.key ? o.key : undefined;
  let commitInflight: ((rec: { seq: number; msgId?: string }) => void) | undefined;
  if (key) {
    const hit = dedupeIndex(s).get(key);
    if (hit) {
      D().log("ingest.dedupe", { session: s.id, key, msgId: hit.msgId });
      return { ok: true, message: okMsg, seq: hit.seq };
    }
    /* A same-key delivery is already MID-INGEST: its row is not committed to
     * recentKeys yet, so the committed check above could not see it. This is the
     * retry the dedupe is for, arriving while the original is still being
     * recorded. Wait for the original to land and re-ack ITS record -- one row,
     * and the retry still gets its ack so the MCP stops retrying (#576). */
    const pending = s.inflightKeys?.get(key);
    if (pending) {
      const rec = await pending;
      D().log("ingest.dedupe", { session: s.id, key, msgId: rec.msgId, inflight: true });
      return { ok: true, message: okMsg, seq: rec.seq };
    }
    /* First sight of this key. Reserve it SYNCHRONOUSLY, so a concurrent retry
     * takes the branch above instead of racing past a check that cannot see an
     * uncommitted delivery. Resolved once the row is logged and remembered,
     * which now happens in the same synchronous run (the TTS await that used to
     * sit in between has moved behind the ack). */
    (s.inflightKeys ??= new Map()).set(key,
      new Promise<{ seq: number; msgId?: string }>((res) => { commitInflight = res; }));
  }

  /* THE TURN CHECK IS GONE, ON PURPOSE (#speak-latency). It used to run after
   * synthesizeFirst, dropping a speak whose TTS resolved after its turn ended
   * (2026-08-17, ttfbMs=83181 after working -> idle). With the row now written
   * before the ack and TTS moved behind it, there is no TTS window for a turn
   * flip to land in: a speak delivered at arrival stays delivered, and its clip
   * becomes a background enrichment that may arrive whenever it arrives. */
  /* Recorded before the row is written: this is the fact the Stop hook is about
   * to ask for, and the agent's own `speak` call returns at the ack below, long
   * before the audio exists. A speak whose TTS then fails still counts as a
   * speak: the words reached the app either way, and whether this host's voice
   * engine was up is not the agent's failure. */
  d.noteReply(s.id);

  // A chat message is a reply with the voice step skipped, and a speak whose
  // TTS FAILED lands in exactly the same place once its background synthesis
  // gives up (speakClip). No new frame is needed: the app has always had to
  // render a reply with no audio behind it.
  /* STREAMING TTS (#525), now with the ack moved in front of the first chunk.
   * The reply is split into sentences; the FIRST is synthesised in the
   * background AFTER the ack, and the rest are appended to the same mp3 by
   * growClip() while the app already plays. A multi-chunk clip ships
   * `growing: true`; a single-chunk reply is one write and looks exactly like
   * the old behaviour. */
  const chunks = aloud ? chunkText(text) : [];
  const isGrowing = aloud && chunks.length > 1;
  if (isGrowing) growing.add(msgId);

  const ts = stampTs(s);
  /* The row is logged and broadcast NOW, carrying msgId and (for a multi-chunk
   * speak) growing:true, BEFORE the first chunk exists. The say frame and its
   * growth beats arrive later and attach audio to a bubble that already exists
   * on every device by identity, which is the message-first ordering below. A
   * single-chunk speak ships its measured durationS on a re-broadcast of the
   * SAME message once the first chunk lands (speakClip). */
  const msg: ChatMsg = { id: s.id, role: "claude", text, ts, msgId: aloud ? msgId : undefined, ...(isGrowing ? { growing: true } : {}), ...(key ? { key } : {}) };
  const seq = logChat(s, msg);
  // Remember this delivery under its key so the retry that reuses it is deduped
  // above (#505). msg.seq is now stamped; the msgId is the delivery's own, so a
  // dedupe hit re-acks the record the audio and bubble actually belong to.
  if (key) {
    rememberKey(s, key, msg.msgId, seq);
    // Release the reservation: this key is now committed, so a later retry hits
    // the recentKeys check, and any retry already awaiting the reservation wakes
    // and re-acks this record (#576).
    s.inflightKeys?.delete(key);
    commitInflight?.({ seq, msgId: msg.msgId });
  }
  clearQueuedByReply(s, ts); // this reply proves the pane read what was queued before it (#456)

  /* Tell the devices, unless somebody can PROVE they are looking at this chat.
   *
   * A client with the page merely open still gets a notification if it is
   * looking at another chat, which is right: that is the case the jump bar
   * exists for. The page takes its own banner down when the chat is open.
   *
   * The notification is tagged host AND pane: pane ids repeat across machines
   * (every herdr has a w9:p4) and the app knows this chat by a namespaced id of
   * its own, so both sides agree on host:pane as the notification's identity.
   * Without that, opening the chat looked for a tag that did not exist and the
   * banner stayed up. */
  void d.notifyUnlessWatched(s, {
    title: d.sessionPushTitle(s),
    body: text,
    msgKey: msgId,
    ts,
  });

  /* THE MESSAGE FIRST, THEN THE CLIP, and the order is the whole of a bug.
   *
   * `say` names a msgId; the bubble that plays it is created by `chat` and by
   * nothing else. Announced first, the say arrives at a page where the spoken
   * message does not exist yet, and the app had to guess which bubble it meant
   * -- by TEXT (store.ts, the backwards walk). He saw what guessing costs on
   * 2026-08-05 in w9:p4: an agent wrote "Understood. No actions, no notes,
   * nothing written from this.", then spoke the same sentence five seconds
   * later. The chat log has it right, one written record with no msgId and one
   * spoken record carrying 228a0ace and durationS 4. The page put the clip on
   * the WRITTEN bubble, because at say-time it was the newest claude bubble
   * with those words and no msgId, and the spoken one had not landed yet.
   *
   * Sent in this order the guess has nothing to do: the bubble exists, it
   * already carries this msgId (the same `aloud` decides both frames), and
   * everything keyed on the id -- the play button, the progress clock, the
   * read-along -- lands on the message the audio is actually of. The clip
   * itself is announced later, by speakClip, once its first chunk exists. */
  d.broadcast({ t: "chat", ...msg });

  /* AND ONLY NOW is the tool told it succeeded: the message is in this engine's
   * chat log (seq stamped, disk write queued) and every client has been told.
   * msg.seq carries that proof to the MCP.
   *
   * THE EARLY ACK IS BY DESIGN (#speak-latency). The ack used to wait on
   * synthesizeFirst, so the MCP speak tool blocked on first-chunk TTS latency --
   * seconds under load, and up to ~80s on a backed-up kokoro. The row is already
   * durable here; the audio is a background enrichment the ack must not wait for.
   * A synthesis that then fails degrades like a failed growClip: the written
   * words stay, no crash, and no row stuck growing.
   *
   * The ack is RETURNED here, not sent: the caller (onReply over /ws, or the
   * loopback POST route) owns the transport. The background clip is scheduled
   * first because it is fire-and-forget either way -- kicking it off a beat
   * before the caller writes the ack is the same "ack, then background TTS"
   * ordering the old inline code had. */
  if (aloud && chunks.length) void speakClip(s, msg, chunks, msgId);
  return { ok: true, message: okMsg, seq: msg.seq };
}

/* A device played a reply through to the end. Every other device should now
 * treat it as heard, so the marker is stored here and broadcast. Only ever
 * moves FORWARD through the log: two devices catching up at once must not
 * make each other repeat. */
export function onHeard(m: any) {
  const d = D();
  const s = d.sessionOf(String(m.id ?? ""));
  if (!s) return;
  /* THE SIGHTING (fix-unread): a device saw a row, named by its durable key
   * (`mid`) and instant (`ts`). A `msgId` is the older shape -- a clip a device
   * finished playing -- so it is resolved to the same row's identity first, and
   * every sighting then goes through the ONE door, markReadRow, which the engine
   * resolves against its own log and moves forward-only by position. */
  let mid: string | undefined = m.mid ? String(m.mid) : undefined;
  let ts: number | undefined =
    typeof m.ts === "number" && Number.isFinite(m.ts) ? m.ts : undefined;
  const msgId = m.msgId ? String(m.msgId) : undefined;
  if (!mid && msgId) {
    const row = s.chat.find((c) => c.msgId === msgId);
    if (row) { mid = row.mid; ts = row.ts; }
  }
  if (mid === undefined && ts === undefined) return;
  if (markReadRow(s, { mid, ts })) d.broadcastSessions();
}
