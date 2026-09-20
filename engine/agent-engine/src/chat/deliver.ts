/* DELIVERY (L3 feature): the ONE way a message gets into a session.
 *
 * Everything a person types or says comes through here, and so does the
 * completion of a pending voice note; the plugin host's deliver and the
 * agent-message route land through deliverToAgent (a message TO the agent,
 * not FROM a person: no chat row, no reply hook, silence is a valid outcome).
 * ONE SESSION TAKES ITS MESSAGES IN THE ORDER THEY WERE SENT (the per-session
 * inOrder chain); a doubled message is recoverable where a lost one is not,
 * so `retriable` is a promise that NOTHING was typed, never a wish.
 *
 *   bun test agent-engine/src/deliver.test.ts
 */

import { safeCid, newCid } from "../../../shared/logbook.ts";
import { PaneNotReady, DeliveryStranded } from "../adapters/mux-adapter.ts";
import { deliverToPane } from "./pane-deliver.ts";
import { stampTs, logChat, awaitingQueue, armAwaiting, clearAwaiting, armQueueClear,
  QUEUE_STUCK_MS } from "./chatlog.ts";
import { markReadOnUtterance } from "../sessions/readstate.ts";
import { audio, clipOnDisk, haveClip, adoptStagedClip } from "./clips.ts";
import { attachmentsOf, attachmentFields, uploadIds, type ChatMsg, type UploadRec } from "./chatmsg.ts";
import { persistPatch, type Session } from "../sessions/session-state.ts";
import { transcribeStored, showPendingVoiceNote, readWords, fillWords,
  raceInlineRescue, WORDS_TOKEN_RE, type SettledPartial } from "../voice/transcribe.ts";
import { admitPartial, wordsOf, keptPrefix, release } from "../voice/transcript-record.ts";
import type { ReplyDelivery } from "./reply-trace.ts";
import type { OutgoingInput } from "../plugins/platform/core.ts";
import { broadcast, send } from "../transport/wire.ts";
import type { Sock } from "../transport/sock.ts";

export type DeliverDeps = {
  sessionOf(id: string): Session | undefined;
  send(ws: Sock, msg: unknown): void;
  broadcast(msg: unknown): void;
  log(event: string, fields: Record<string, unknown>): void;
  /** the input-transform hook fold: wrap the outgoing body with every
   *  registered plugin hook, in registration order (plugin-core applyInputTransform).
   *  The reply-dials plugin's postfix hook is what appends the reply instruction. */
  transformOutgoing(input: OutgoingInput): string;
  noteDelivery(sessionId: string, how: string): ReplyDelivery;
  forgetDelivery(sessionId: string, entry: ReplyDelivery): void;
  writeHookState(): void;
  /** the upload binder (uploads.ts instance) */
  bindOwnedUploads(claimed: UploadRec[], cid?: string): Promise<{ ups: UploadRec[]; missing: string[] }>;
  adoptStagedUploads(sessionId: string, ups: UploadRec[]): Promise<void>;
};

let deps: DeliverDeps | null = null;
export function initDeliver(d: DeliverDeps): void {
  deps = d;
}

/* THE ONE REASON A SEND FAILS WITH NOTHING TYPED. A dead pane and a socket
 * session with no live pipe are both offline: the message cannot be delivered
 * and none was, so the app keeps it, marks the row failed with this reason, and
 * a tap sends the same cid again once the session is back. */
export const OFFLINE_REASON = "the session is offline; message not delivered";

/* THE ROW'S REASON, out of the failure's `tell`. The tell is a whole
 * parenthetical for a chat bubble ("(not sent: ...)"); the row renders "not
 * delivered: {reason}. Tap to try again" (messageContent.ts), so the wrapper
 * "(not sent: " / "(not delivered: " / "(" and the trailing ")" are stripped
 * and the result is capped so a long question cannot overflow the row. */
function failReason(tell: string): string {
  return tell
    .replace(/^\(\s*(?:not (?:sent|delivered):\s*)?/i, "")
    .replace(/\)\s*$/, "")
    .trim()
    .slice(0, 140);
}

/** Offline the way injectUserMessage decides it (kept in step with OFFLINE): a
 *  herdr pane that is no longer alive, or a socket session with no live pipe.
 *  Known synchronously from the session, so the send can be failed on its cid
 *  before any delivery work rather than positively acked and then dropped. */
export function isOffline(s: Pick<Session, "viaMux" | "alive" | "ws">): boolean {
  return s.viaMux ? !s.alive : (!s.alive || !s.ws);
}
const D = (): DeliverDeps => {
  if (!deps) throw new Error("deliver not initialised");
  return deps;
};

/** TEST ONLY: forget the deps and drop every per-session delivery chain, so a
 *  second in-process wiring's first message is not queued behind a promise
 *  the previous one left in flight. No-op in production, which never
 *  re-wires. */
export function resetForTest(): void {
  utterQueue.clear();
  deps = null;
}

/* ONE SESSION TAKES ITS MESSAGES IN THE ORDER THEY WERE SENT.
 *
 * Newly load-bearing, and it is task 292 that made it so. Holding a message
 * while its recording is decoded means a message sent AFTER it can be ready
 * FIRST, and delivery is the order the agent reads a conversation in: "and do
 * that one first" arriving before the thing it is about is not a late message,
 * it is a different instruction.
 *
 * A chain per session and not a global one: two chats are two conversations and
 * neither is owed anything by the other. Every link swallows the previous one's
 * failure, because a message that could not be delivered must not stop the next
 * one from being.
 */
export const utterQueue = new Map<string, Promise<unknown>>();
export function inOrder<T>(sessionId: string, f: () => Promise<T>): Promise<T> {
  const prev = utterQueue.get(sessionId) ?? Promise.resolve();
  const next = prev.then(f, f);
  utterQueue.set(sessionId, next.catch(() => {}));
  return next;
}

/* Enqueued the instant the frame is read, so the order the chain runs in is the
 * order the socket delivered them in and not the order their awaits happen to
 * resolve. Everything that can wait is inside handleUtterance.
 *
 * AND THIS IS WHERE THE ENGINE TOOK THE MESSAGE, so this is where its clock
 * starts. Stamped before the queue rather than inside it: the whole point of
 * the delivery deadline is to bound the WAIT, and every wait this message has
 * is on the far side of this line. */
export function onUtterance(ws: Sock, m: any): Promise<void> {
  const takenAt = Date.now();
  const sid = String(m.id ?? "");
  const cid = safeCid(m.cid) || newCid("m");
  if (!safeCid(m.cid)) m = { ...m, cid };
  /* THE ACK COMES FIRST (offline design v2, section 2b). ACKED MEANS TAKEN, not
   * delivered: the app deletes its intent on this receipt and promotes the row
   * to the single 'sent' tick, and it never rewrites the frame. Everything
   * below is delivery, and when delivery then FAILS the outcome follows as a
   * `send-failed {id, cid, reason}` on this same cid (dropDead), which demotes
   * that row to 'failed' with the reason and a working retry tap -- the honest
   * checkmark. A cid this session has already taken, or is taking right now, is
   * acked as a dup and delivered nowhere: the app rewrites a frame whose ack was
   * lost, and the engine is the one that knows whether the first copy landed.
   *
   * A SESSION THIS ENGINE DOES NOT HAVE IS NOT TAKEN. An ack would make the
   * app delete the intent for a message that landed nowhere, so the answer is
   * the definitive nack (ack with err): the app keeps the message as not
   * delivered, and a tap sends it again. */
  const s = D().sessionOf(sid);
  if (!s) {
    D().log("utterance.dropped", { cid, session: sid, kind: m.kind ?? "text",
      why: "this engine has no session with that id; the frame is nacked (ack with " +
        "err) rather than acked, so the app keeps the message and can retry it" });
    D().send(ws, { t: "ack", id: sid, cid, dup: false, err: "unknown-session" });
    return Promise.resolve();
  }
  /* AN OFFLINE SESSION TAKES NOTHING, AND THE SEND FAILS ON ITS CID. A dead
   * pane (or a socket session with no live pipe) cannot be delivered to; a
   * positive ack would tell the app the frame was TAKEN and delete its intent,
   * leaving a message that landed nowhere with nowhere to go. So the send is
   * failed here, before any delivery work, with the reason on the frame:
   * `send-failed {cid, reason}` (offline design v2, F1). The app marks the row
   * failed and shows this reason on it; a tap sends the same cid again once the
   * session is back. The offline drop used to be a positive ack plus a chat
   * notice, which deleted the intent and reported the failure only as a bubble
   * every device saw for a message only one device sent -- the row itself never
   * learned it had failed. */
  if (isOffline(s)) {
    D().log("utterance.dropped", { cid, session: sid, kind: m.kind ?? "text",
      why: "the session is offline (a dead pane, or a socket session with no live " +
        "pipe); the send is failed on its cid rather than acked, so the app keeps " +
        "the message, marks the row failed with the reason, and can retry it" });
    D().send(ws, { t: "send-failed", id: sid, cid, reason: OFFLINE_REASON });
    return Promise.resolve();
  }
  const known = recentCids(s).get(cid);
  const dup = known !== undefined || cidsInFlight(s).has(cid);
  const msgId = known?.msgId ?? (typeof m.msgId === "string" ? m.msgId : undefined);
  D().send(ws, { t: "ack", id: sid, cid, dup, ...(msgId ? { msgId } : {}) });
  if (dup) {
    D().log("utterance.dup", { cid, session: sid,
      why: "this cid was delivered already (or is being delivered); the frame is a " +
        "rewrite after a lost ack, so it is acked and not delivered twice" });
    return Promise.resolve();
  }
  cidsInFlight(s).add(cid);
  return inOrder(sid, () => handleUtterance(ws, m, takenAt))
    .finally(() => { cidsInFlight(s).delete(cid); });
}

/* The last USER_CIDS_KEEP user-role cids this session took, lazily rebuilt from
 * the persisted chat (the cid rides on each user ChatMsg), so the dedupe
 * survives an engine restart the way dedupeIndex does for replies. Insertion
 * order is delivery order. */
export const USER_CIDS_KEEP = 200;
type CidSession = Pick<Session, "chat"> & { recentCids?: Map<string, { msgId?: string }>;
  inflightCids?: Set<string> };
export function recentCids(s: CidSession): Map<string, { msgId?: string }> {
  if (s.recentCids) return s.recentCids;
  const map = new Map<string, { msgId?: string }>();
  for (let i = Math.max(0, s.chat.length - USER_CIDS_KEEP * 2); i < s.chat.length; i++) {
    const c = s.chat[i];
    if (c.role === "user" && c.cid) map.set(c.cid, { msgId: c.msgId });
  }
  while (map.size > USER_CIDS_KEEP) map.delete(map.keys().next().value as string);
  s.recentCids = map;
  return map;
}
function rememberCid(s: CidSession, cid: string, msgId: string | undefined): void {
  const map = recentCids(s);
  map.set(cid, { msgId });
  while (map.size > USER_CIDS_KEEP) map.delete(map.keys().next().value as string);
}
/* The cids acked but not yet committed: a rewrite that lands while the first
 * copy is still in the per-session chain (a recording being decoded) is a
 * dup too, or the agent would read the message twice. */
function cidsInFlight(s: CidSession): Set<string> {
  if (!s.inflightCids) s.inflightCids = new Set();
  return s.inflightCids;
}

export async function handleUtterance(ws: Sock, m: any, takenAt: number) {
  /* The recording's correlation id, minted in the browser when the mic opened
   * and carried on the frame. Falls back to one of ours so that a message from
   * an older bundle still has SOMETHING to grep on. */
  const cid = safeCid(m.cid) || newCid("m");
  const d = D();
  const s = d.sessionOf(String(m.id ?? ""));
  let text = String(m.text ?? "").trim();
  /* The attachments, in the order the composer put them in.
   *
   * `uploads` is what a composer that can hold several blocks sends; `upload`
   * is what every bundle before it sends, and it keeps working. One frame
   * carries the whole message and this function commits all of it or none of
   * it, which is "no partial send" at this boundary: a
   * message that does not land is one the app sends again.
   *
   * That holds because the RETRY IS SAFE, not because nothing below can fail
   * halfway. Delivery is two keystroke RPCs and the second one can miss, which
   * strands the typed body in the pane; deliverToPane() remembers that and
   * submits the stranded body rather than typing it again. Take that away and
   * this comment becomes a lie.
   *
   * An attachment on its own is a valid message: no text required.
   *
   * PATH IS NOT THE CLIENT'S. attachmentsOf keeps whatever record the frame
   * carried, including a forged `path`. bindOwnedUploads throws that away and
   * puts back the file this engine wrote for that uploadId. A forge is
   * dropped. An id we minted whose file is gone fails the whole message. */
  const bound = await d.bindOwnedUploads(
    attachmentsOf({ uploads: m.uploads, upload: m.upload } as ChatMsg), cid);
  const ups = bound.ups;
  /* ...and so is a voice note whose transcript failed on the device: the clip
   * is the message, and we can read it ourselves below.
   *
   * THE DISK, not the hot cache. This one line was task 165: it asked
   * `audio.has(msgId)`, which answers for a 200-clip / 64 MB cache that a long
   * recording falls out of and that every restart empties, and a `false` here
   * meant the message was discarded -- after the upload had succeeded and after
   * the app had drawn the tick that says the recording cannot be lost. The clip
   * was on disk the entire time; both reproductions logged onDisk=true beside
   * the drop. Computed once and reused below, so the guard and the msgId the
   * bubble gets can never disagree about the same clip. */
  const haveIt = m.kind === "voice" && typeof m.msgId === "string" && await haveClip(m.msgId);
  const rescuable = haveIt;
  D().log("utterance.in", { cid, session: String(m.id ?? ""), kind: m.kind ?? "text",
    chars: text.length, msgId: m.kind === "voice" ? m.msgId : undefined,
    durationS: m.durationS, upload: uploadIds(ups),
    known: !!s, rescuable, cached: m.kind === "voice" && typeof m.msgId === "string"
      ? audio.has(m.msgId) : undefined });
  /* THE SILENT DROP. Two very different failures shared one early return and
   * neither left a trace: a message for a session this engine has never heard
   * of, and a voice note with no clip anywhere. The second one used to include
   * every clip the hot cache had merely FORGOTTEN, which is the bug above; what
   * is left here is a msgId this engine genuinely cannot find, in memory or on
   * disk, on a message with no words and no attachment either. There is nothing
   * in it to deliver. */
  if (!s || (!text && !ups.length && !bound.missing.length && !rescuable)) {
    D().log("utterance.dropped", { cid, session: String(m.id ?? ""), kind: m.kind ?? "text",
      chars: text.length, msgId: m.kind === "voice" ? m.msgId : undefined,
      onDisk: typeof m.msgId === "string" ? (await clipOnDisk(m.msgId)) !== null : undefined,
      why: !s ? "this engine has no session with that id" :
        m.kind === "voice" && typeof m.msgId === "string" ?
          "a wordless voice note whose clip is in neither the hot cache nor the audio " +
          "directory, so there is nothing to read and nothing to deliver" :
          "no text, no attachment and no readable clip" });
    return;
  }
  if (typeof m.origin === "string" && m.origin) {
    s.lastOrigin = { id: m.origin.slice(0, 64), ts: Date.now() };
  }

  // voice-note metadata (all optional): msgId must point at a clip the page
  // actually uploaded via POST /user-audio, else it is dropped
  /* The attachments are NOT folded in here any more, and that is the merge
   * with the schedule branch rather than a change of behaviour. Delivery moved
   * into injectUserMessage(), which takes the list as `uploads` and calls
   * attachmentFields() on it once, for a typed message and for a fired
   * schedule alike. Writing them here as well would make two writers of the
   * same pair of fields, which is exactly what attachmentFields() exists to
   * prevent. */
  const voice: Partial<ChatMsg> = {};
  if (m.kind === "voice") {
    voice.kind = "voice";
    /* Same question, same answer. This was the second `audio.has`, and on its
     * own it cost the play button: a note delivered after a restart kept its
     * words and lost its audio for ever, because the cache had not heard of a
     * clip sitting in the audio directory. */
    if (haveIt) voice.msgId = m.msgId;
    else if (typeof m.msgId === "string") {
      /* The message survives, its AUDIO does not: the bubble loses its play
       * button and every history replay after this one is text only. */
      D().log("utterance.clip-forgotten", { cid, session: s.id, msgId: m.msgId,
        cached: audio.size,
        why: "the msgId is in neither the hot cache nor the audio directory, so the " +
          "note is delivered without it" });
    }
    if (Number.isFinite(m.durationS)) voice.durationS = Number(m.durationS);
  }

  /* EVERY ATTACHED FILE IS STILL THERE, OR THE MESSAGE FAILS.
   *
   * An upload is protected from the sweep only once a message REFERENCES it,
   * and staging is a separate act from sending: a file sitting in the composer
   * is debris by that count, and 200 newer uploads evict it. A composition
   * that holds several of them holds them for as long as it sits there, so
   * this stopped being a corner the moment one message could carry a list.
   *
   * Nothing checked. A record naming a path that no longer existed was
   * accepted, written into the chat log, drawn in the bubble and handed to the
   * agent as a real path to open. The agent finds nothing there and the user
   * is told his message was sent.
   *
   * All or nothing (item 89): one missing file fails the whole message, and
   * the app's answer is the same as for any message that did not land. Said
   * plainly to the sender, because "which file" is the one thing he needs and
   * the app cannot work it out for itself. */
  const missing = [...bound.missing];
  for (const u of ups) {
    if (!u.path || !(await Bun.file(u.path).exists())) missing.push(u.name || u.uploadId);
  }
  if (missing.length) {
    D().log("utterance.dropped", { cid, session: s.id, chars: text.length,
      upload: uploadIds(ups), missing: missing.join(","),
      why: "an attached file is no longer on disk (staged, then swept before it was sent); " +
        "the whole message was refused rather than delivering a path that opens nothing" });
    /* THE FAILURE LANDS ON THE ROW, not in a grey bubble (F2). A send this
     * device already saw acked is failed on its cid: `send-failed` on the
     * sender's socket, matching the offline path a few lines up, so the row
     * flips to 'failed' with the reason and a retry tap. The bubble-only report
     * was broadcast to every device for a message only one device ever saw; the
     * row is the honest place for it. The refused MESSAGE is still not written
     * -- it never landed. */
    const names = missing.join(", ");
    D().send(ws, { t: "send-failed", id: s.id, cid,
      reason: `${names} ${missing.length > 1 ? "are" : "is"} no longer on the engine; ` +
        `attach ${missing.length > 1 ? "them" : "it"} again` });
    return;
  }

  /* The message is committed to THIS session: its staged blobs move home now
   * (see adoptStagedUploads/adoptStagedClip), BEFORE the records are persisted
   * or the paths handed to the agent. */
  await d.adoptStagedUploads(s.id, ups);
  if (typeof voice.msgId === "string") await adoptStagedClip(s.id, voice.msgId);

  /* THE WORDS THIS ENGINE OWES THE MESSAGE (task 292).
   *
   * The composer sent a marker where each undecoded recording's transcript
   * belongs and did NOT wait for it. Read them now, off this engine's disk, and
   * put them in. The message has not been written, broadcast or delivered yet,
   * so what happens here is invisible: there is one body, written once, with the
   * words in it, and the agent gets one turn.
   *
   * WHEN IT RUNS AT ALL: only on a message that is CARRYING SOMETHING, either an
   * attachment or a `words` list. A marker is minted by the composer beside the
   * upload it names and never travels alone, so a body with a marker in it and
   * nothing attached did not come from the composer -- it came from him, typing
   * or pasting one.
   *
   * That is not a hypothetical. He is the person most likely to paste
   * `{{cyc-words:...}}` into this app, because he is the person discussing this
   * feature in it, and it used to be deleted from under him: measured, zero
   * decoder calls, "look at this log line: {{cyc-words:...}} -- what does that
   * marker do?" reached the agent with a hole where the marker was, inside a
   * fenced code block as readily as outside one. The bubble kept his original
   * words, so the phone and the agent silently disagreed about what he had said.
   *
   * The TOTAL property is unchanged and is what makes this gate safe. Once the
   * pass runs, no marker survives it whether or not the frame named that one --
   * so a real marker still cannot reach a pane, and the only thing this decides
   * is whether the message is one the pass has any business touching. */
  const inBody = new Set([...text.matchAll(WORDS_TOKEN_RE)].map((x) => x[1]));
  const asked: string[] = Array.isArray(m.words)
    ? m.words.filter((x: unknown): x is string => typeof x === "string" && !!x) : [];
  if (inBody.size && !asked.length && !ups.length) {
    D().log("words.typed", { cid, session: s.id, marker: [...inBody].join(","),
      chars: text.length,
      why: "the body contains a marker and the message carries no recording and asks for " +
        "no transcript, so nobody composed it: it is his own text and goes through " +
        "untouched" });
  } else if (inBody.size) {
    /* Only ids that are BOTH attached to this message and named by a marker in
     * this body. Anything else is a request to decode a recording that is not
     * part of what was sent. */
    const want = asked.filter((id) => inBody.has(id) && ups.some((u) => u.uploadId === id));
    /* WHAT THE DEVICE ALREADY SETTLED (#442). The frame carries, per recording,
     * the streaming decoder's finalized words and how far into the audio they
     * reach; the engine finishes only the tail. A partial for an id that is not
     * being decoded is ignored, and a wanted id with no partial reads whole -
     * the old behaviour, and the honest fallback for an old app or a clip that
     * never streamed. */
    const partials = new Map<string, SettledPartial>();
    if (Array.isArray(m.partials)) {
      for (const p of m.partials) {
        if (p && typeof p === "object" && typeof p.id === "string" &&
          typeof p.text === "string" && p.text.trim() &&
          Number.isFinite(p.upToS) && Number(p.upToS) > 0 && want.includes(p.id)) {
          partials.set(p.id, { text: p.text, upToS: Number(p.upToS) });
        }
      }
    }
    /* The streamed words the device settled are the floor for each recording:
     * admit them into the record, then let readWords feed the decode in. */
    for (const [id, p] of partials) admitPartial(id, p);
    const got = want.length ? await readWords(ups, want, cid, partials) : new Map<string, string>();
    /* THE STREAMED WORDS ARE A FLOOR, NOT A DRAFT (#550).
     *
     * The device already settled some words (`partials[].text`) and handed them
     * over; the engine's batch decode is here to FINISH them, not to be trusted
     * over them when it produced less. A wedged batch service can miss the
     * deadline (readWords returns with the id absent from `got`) or come back
     * empty/garbled/short -- and the fallback used to write that emptier result
     * straight over a good streamed transcript. Two of his real notes went out
     * as "" this way: `utterance.in chars=50`, `words.deadline`, then
     * `words.filled chars=0 was=50`, an empty message where he had spoken.
     *
     * So the batch result may only ever REPLACE the streamed words when it
     * actually produced at least as many usable chars. Anything shorter (the
     * deadline's nothing, a failed decode's "", a garbled short read) keeps the
     * streamed transcript the device already showed him. A successful decode is
     * longer -- tail mode returns settled+tail, a good whole read holds the lot
     * -- so it still wins, which is what "finishes a partial" means.
     *
     * The compare itself lives once, in the record's wordsOf: resolve every
     * wanted id through it, and read which ones kept
     * their streamed prefix from keptPrefix rather than a second copy here. */
    for (const id of want) got.set(id, wordsOf(id));
    const keptStreamed: string[] = [];
    for (const id of partials.keys()) if (keptPrefix(id)) keptStreamed.push(id);
    const r = fillWords(text, ups, got);
    D().log("words.filled", { cid, session: s.id, asked: asked.join(",") || undefined,
      filled: r.filled.join(",") || undefined, unread: r.unread.join(",") || undefined,
      kept: r.kept.join(",") || undefined,
      keptStreamed: keptStreamed.join(",") || undefined,
      chars: r.text.length, was: text.length });
    /* The words are in the body now; the in-memory records have done their job
     * (the durable marker is the transcriptPending row, unchanged). */
    for (const id of want) release(id);
    text = r.text;
    /* NOBODY COULD READ ONE OF THEM, and the bubble must not draw an empty line
     * under a waveform as though the recording were silent. The message still
     * goes: the recording is on this disk and the agent is handed its path. */
    if (r.unread.length) voice.wordsFailed = true;
  }

  // last resort before delivery: read the clip here. A SHORT note comes back
  // within RESCUE_INLINE_MS and is delivered whole, exactly as before. A LONG
  // one (a 30 minute clip is minutes of decode) would leave the bubble stuck at
  // "sending" for all of it, so past the deadline the note is SHOWN now with the
  // audio safe and its transcript pending, and delivered to the agent once when
  // the chunked decode lands (#458). Nothing else in this function runs then:
  // showPendingVoiceNote owns the rest of this note's life.
  if (!text && voice.msgId) {
    /* WHAT THE DEVICE ALREADY SETTLED, for the note's own clip (#442, extended
     * to voice notes). A voice note has no uploadId to hang a partial on, so
     * the frame names it by its own cid (the app may also name the msgId).
     * With it, the rescue decodes ONLY the tail past upToS and prepends the
     * settled words; without it, the whole clip reads exactly as before. */
    let notePartial: SettledPartial | undefined;
    if (Array.isArray(m.partials)) {
      for (const p of m.partials) {
        if (p && typeof p === "object" &&
          (p.id === cid || (typeof m.msgId === "string" && p.id === m.msgId)) &&
          typeof p.text === "string" && p.text.trim() &&
          Number.isFinite(p.upToS) && Number(p.upToS) > 0) {
          notePartial = { text: p.text, upToS: Number(p.upToS) };
        }
      }
    }
    const rescue = transcribeStored(voice.msgId, cid, notePartial);
    /* The race is transcribe.ts's now, unchanged in what it decides: the
     * deadline and the decode it bounds are one decision, measured on the one
     * clock that module already holds (see raceInlineRescue). */
    const inline = await raceInlineRescue(rescue);
    if (inline.ready) {
      text = inline.t;
      if (!text) {
        D().log("utterance.rescue-failed", { cid, session: s.id, msgId: voice.msgId,
          why: "the engine could not read its own copy either; delivering a placeholder" });
        text = "(voice note: transcription failed)";
      }
    } else {
      showPendingVoiceNote(s, { cid, how: m.kind === "voice" ? "VOICE" : "TEXT",
        extra: voice, msgId: voice.msgId, takenAt }, rescue);
      return;
    }
  }

  /* Nothing was delivered. Say so ON THE ROW (F2): the row this device already
   * saw acked is failed on its cid with `send-failed {id, cid, reason}`, so it
   * flips from the single 'sent' tick to the red 'failed' state with the reason
   * and a working retry tap. This is the same path the offline drop takes in
   * onUtterance, and for the same reason its comment gives: the old grey notice
   * was broadcast to every device for a message only one device ever saw, and
   * it left the row itself sitting at 'sent' for ever. The undelivered message
   * is still not written; a message that does not land is one the app sends
   * again.
   *
   * IT SAYS WHICH FAILURE IT WAS, because there are several and they want
   * opposite things from whoever reads them. A dead pane is gone and the message
   * needs somewhere else to go; a pane sitting on a prompt needs the prompt
   * answered; a body typed but not submitted needs sending again to submit it.
   * The sentences are decided by injectUserMessage now and arrive as `why` (for
   * the log) and `tell` (for the reason); this is the half that knows there is a
   * websocket waiting to be told. The default below is the offline case, kept
   * spelled out here because it is the one a caller may report without a
   * reason. */
  const dropDead = (why?: string, tell?: string) => {
    D().log("utterance.dropped", { cid, session: s.id, msgId: voice.msgId,
      chars: text.length, why: why ?? "the session is offline; nothing was delivered and " +
        "nothing was written to the chat log" });
    D().send(ws, { t: "send-failed", id: s.id, cid,
      reason: failReason(tell ?? "(session is offline; message not delivered)") });
  };

  // Every inbound message, before anything can go wrong with it. Messages
  // pasted into a chat went missing once and there was no record of whether
  // they had ever reached the engine, which left the question unanswerable
  // (2026-07-27).
  D().log("utterance.accepted", { cid, session: s.id, kind: m.kind ?? "text",
    msgId: voice.msgId, chars: text.length, upload: uploadIds(ups),
    herdr: !!s.viaMux, alive: s.alive, text: text.slice(0, 120) });

  /* Say which it was. Everything arrived tagged VOICE, including things the
   * user had typed, which is a small lie with real consequences: transcripts
   * carry mis-hearings and typed text does not, and the agent should weigh
   * them differently. The tag is also the only clue about why a sentence
   * reads oddly. */
  const res = await injectUserMessage(s, {
    cid, how: m.kind === "voice" ? "VOICE" : "TEXT", text,
    /* ALL of them, in composer order. This is the join the two branches were
     * heading for: `uploads` was made a list before anything could fill it,
     * precisely so that widening it here is one word rather than a rewrite,
     * and so that no merge of these two could quietly deliver the first
     * attachment and drop the rest. */
    uploads: ups, extra: voice,
    /* The moment the socket handed this over, not the moment this line runs.
     * Everything between them -- the per-session queue, a recording being
     * decoded -- is time he has been looking at a bubble that has not landed. */
    takenAt,
  });
  if (!res.ok) dropDead(res.why ?? "it could not be delivered", res.tell);
}

/* THE ONE WAY A MESSAGE GETS INTO A SESSION.
 *
 * Everything a person types or says comes through here, and so does everything
 * a schedule fires (schedules.ts). Keeping that single is the whole reason it
 * is a function: a scheduled message has to behave exactly like a typed one --
 * the same reply-level instruction appended, the same hook state written before
 * the agent can read it, the same queued divider when the pane is busy, the same
 * bubble in the same chat log, and therefore the same push when the answer comes
 * back. A second delivery route would be a second set of all of those, and they
 * would drift.
 *
 * Returns rather than reports: the caller knows who is waiting to be told. A
 * person gets a bubble saying it did not go; a schedule gets a record on the
 * schedule and a retry while it is still worth retrying.
 */
export type Injection = {
  cid: string;
  /** the word the pane is told this arrived as: TEXT, VOICE, SCHEDULED */
  how: string;
  /** what goes in the chat log, i.e. what a person would have typed */
  text: string;
  /* THE ATTACHMENTS, and it is a LIST rather than one.
   *
   * It was a list before anything could fill it, written that way by the
   * schedule branch while `ChatMsg` still carried a single `upload`, because
   * the multipart-composer branch was rewriting these exact lines of
   * onUtterance at the same time. A single-valued field would have been
   * widened by QUIETLY DROPPING every attachment after the first -- a merge
   * that compiles, passes, and loses files.
   *
   * Both are here now and it was one word: onUtterance hands over the whole
   * composition, and the pair of fields a message is written with comes from
   * attachmentFields() below. Narrow this back to one and four attachments
   * arrive as one. */
  uploads?: NonNullable<ChatMsg["upload"]>[];
  /** the bubble's other fields (voice note kind, msgId, duration, and any mark
   *  saying this was not typed by hand) */
  extra?: Partial<ChatMsg>;
  /** a parenthetical on the delivered line only, for context the bubble does
   *  not carry: which schedule this is, and whether it is late */
  note?: string;
  /** when the engine took this message, for the delivery deadline. Omitted by
   *  callers with nothing queued in front of them (a schedule firing is taken
   *  and delivered in the same breath); see deliverToPane. */
  takenAt?: number;
  /* COMPLETING A MESSAGE ALREADY SHOWN, not writing a new one (#458).
   *
   * A long voice note is written and shown the instant it arrives, with the
   * audio safe and its transcript pending, and delivered to the AGENT only when
   * the chunked decode lands -- so the agent reads it ONCE, whole, and never a
   * placeholder turn it then has to un-remember. When this is set, the delivery
   * to the pane happens exactly as always, but the chat row is the one already
   * at `completesTs`: its text is filled in and its `transcriptPending` cleared,
   * rather than a second row appended. The escape is the message's own ts, so a
   * completion cannot land on anything but the note it belongs to. */
  completesTs?: number;
};

/** What a caller is told when nothing was delivered: `why` for the log and for
 *  the schedule's record, `tell` for the sentence a person reads in the app.
 *  `retriable` is a promise that NOTHING was typed, never a wish. */
export type Injected = { ok: boolean; why?: string; tell?: string; ts?: number; retriable?: boolean };

/** The one failure with no keystroke anywhere near it. Spelled once: both the
 *  herdr path and the socket path end here, and the two used to disagree about
 *  the wording. */
export const OFFLINE: Injected = { ok: false, retriable: true,
  why: "the session is offline; nothing was delivered and nothing was written " +
    "to the chat log",
  tell: "(session is offline; message not delivered)" };

/* Write the row a delivery produces, and broadcast it.
 *
 * A NEW row for an ordinary message. But when the delivery is COMPLETING a note
 * shown earlier (#458, `inj.completesTs`), it is the row already at that ts:
 * its text is filled in and its `transcriptPending` cleared, so the same bubble
 * fills rather than a second one appearing. If that row is gone (a front trim, a
 * wipe), the words are appended as a new row instead of being lost with the
 * bubble they belonged to. The escape is the note's own ts, so a completion
 * cannot land on any other message. */
export function commitDelivery(s: Session, inj: Injection, ts: number, willQueue: boolean): ChatMsg {
  const { cid, text } = inj;
  if (inj.completesTs != null) {
    const row = s.chat.find((r) => r.role === "user" && r.ts === inj.completesTs);
    if (row) {
      row.text = text;
      delete row.transcriptPending;
      if (willQueue) row.queued = true;
      persistPatch(s.id, row.ts,
        { text, ...(willQueue ? { queued: true } : {}) }, ["transcriptPending"]);
      broadcast({ t: "chat", ...row });
      return row;
    }
  }
  /* attachmentFields() is the only thing that writes the `upload`/`uploads`
   * pair, here and nowhere else, so a message from a schedule is written the
   * same way as one he typed: one attachment keeps the old singular shape,
   * several are the list plus its first entry. */
  const msg: ChatMsg = { id: s.id, role: "user", text, ts, cid,
    ...(willQueue ? { queued: true } : {}), ...(inj.extra ?? {}),
    ...attachmentFields(inj.uploads ?? []) };
  logChat(s, msg);
  rememberCid(s, cid, msg.msgId);
  broadcast({ t: "chat", ...msg });
  return msg;
}

export async function injectUserMessage(
  s: Session,
  inj: Injection,
): Promise<Injected> {
  const { cid, text } = inj;
  if (s.viaMux) {
    /* Nothing has been typed at this point, and nothing will be. `retriable`
     * says exactly that, and it is the only condition under which anyone may
     * try this message again: once a keystroke has left, a retry is a second
     * message. */
    if (!s.alive) return OFFLINE;
    /* The agent gets a real path per attachment, in the order they were
     * composed, and the caption (if any) rides along after them. ONE message:
     * several attachments make the line longer, they never
     * make it a second delivery, so the agent reads one turn however many
     * files came with it. One attachment renders exactly the string this has
     * always sent. */
    const ups = inj.uploads ?? [];
    const body = ups.length
      ? ups.map((u) => `[attached ${u.image ? "image" : "file"}: ${u.path}]`).join(" ") +
        (text ? ` ${text}` : "")
      : text;
    /* Fold every registered input-transform hook over the body (the reply-dials
     * plugin's postfix hook appends the reply instruction). Then record the
     * delivery for the Stop hook: just that a message went out, tagged with how
     * it arrived. The hook is verbosity-unaware, so no channel demand travels
     * with it. */
    const delivered = `${inj.how}${inj.note ? ` (${inj.note})` : ""}: ` +
      D().transformOutgoing({ sessionId: s.id, text: body, channels: s.channels });
    // On disk before the agent can possibly read the message: the Stop hook at
    // the end of this turn asks the state file whether a reply went out.
    const noted = D().noteDelivery(s.id, inj.how);
    D().writeHookState();
    /* PRE-ARM the consumption listener BEFORE the keystrokes go out. The
     * current claude journals the message's `user` record ~0.45s after it is
     * typed, which is usually WHILE deliverToPane's echo gate is still
     * settling; arming after the await meant that signal fired into a void
     * and the queued divider stood until the next reply (or the deadline)
     * on every busy-pane send (measured live, 2026-09-06: record ts equal to
     * the send ts to the millisecond, strip still up seconds later). The ts
     * is a placeholder: consumption during the await deletes the entry, and
     * that deletion is the memory the commit reads as consumedEarly. Keyed by
     * the delivery id (cid), so the reply slider moving between a failed attempt
     * and its retry cannot change what this message is keyed under; the reverse
     * index off the delivered text is what the transcript echo matches on. */
    armAwaiting(cid, s.id, 0, delivered);
    try {
      await deliverToPane(s.muxHandle, delivered, cid, inj.takenAt);
    } catch (e) {
      clearAwaiting(cid);
      /* Three failures now, and the user needs them told apart. A pane sitting
       * on a prompt (PaneNotReady, nothing typed) is "go and answer it". A body
       * typed but not submitted (DeliveryStranded) is "send it again and it will
       * be submitted". herdr refusing the keystrokes somewhere in the pair is
       * "try again". See deliverToPane. */
      const notReady = e instanceof PaneNotReady;
      const stranded = e instanceof DeliveryStranded;
      D().log("utterance.delivery-failed", { cid, session: s.id, msgId: inj.extra?.msgId,
        err: String(e),
        why: notReady || stranded ? (e as PaneNotReady | DeliveryStranded).why
          : "herdr would not take the keystrokes; the message never reached the pane" });
      // Never enforce a reply to a message that never arrived.
      D().forgetDelivery(s.id, noted);
      D().writeHookState();
      /* RETRIABLE FOR THE TWO FAILURES WHERE A RETRY IS SAFE.
       *
       * PaneNotReady is thrown BEFORE any send_text (or after the echo gate
       * proved the text was swallowed): nothing is in any box, so a retry types
       * the body fresh. DeliveryStranded is thrown AFTER the body is typed and
       * left sitting in the input box: the unsubmitted note is kept, so a retry
       * presses enter only and submits it. Both are retriable, and both are the
       * existing measured stranded-note behaviour.
       *
       * The remaining case is the important one: herdr refused SOMEWHERE in a
       * send_text/enter pair, and there is no way from here to know whether the
       * text landed without its enter. Sending it again risks two copies of the
       * same instruction in the pane, so it is not retriable at all. */
      if (stranded)
        return { ok: false, retriable: true,
          why: (e as DeliveryStranded).why, tell: (e as DeliveryStranded).tell };
      return notReady
        ? { ok: false, retriable: true,
            why: (e as PaneNotReady).why, tell: (e as PaneNotReady).tell }
        : { ok: false,
            why: "the pane is alive but would not take the keystrokes; nothing was " +
              "delivered and nothing was written to the chat log",
            tell: "(message not delivered; the session did not take it. Try again.)" };
    }
    // Completing a note shown earlier keeps its ts, so the words fill that same
    // bubble; an ordinary message takes the next one (#458).
    const ts = inj.completesTs ?? stampTs(s);
    /* The pre-armed entry is GONE when the transcript's user record already
     * landed during the typing await: claude has the message in context, so
     * the row is never marked queued at all. The pre-armed entry is keyed by
     * the delivery id (cid), so this reads its absence AFTER the await, exactly
     * as before -- consumption during the typing await cleared it. Load-bearing:
     * it is what decides willQueue, and deleting it would leave the divider up
     * on a message claude has already read. */
    const consumedEarly = !awaitingQueue.has(cid);
    // Only a message typed into a BUSY pane actually waits in claude's input
    // queue; an idle pane takes it straight into context and logs no
    // queue-operation record at all (measured: a message sent to an idle
    // session produced no enqueue, so marking everything queued left the
    // divider up forever).
    const willQueue = s.busy && !consumedEarly;
    if (willQueue) {
      armAwaiting(cid, s.id, ts, delivered);
      // Safety net: a queue record we never see (log rotation, a resume, an
      // interrupted turn) must not strand the divider. It is a deadline, not a
      // promise: `ts` is on disk with the message, so a restart re-arms what is
      // left of this rather than losing it (see sweepRestoredQueued). Keyed by
      // the delivery id (cid), the same key clearQueued matches under.
      armQueueClear(s.id, ts, QUEUE_STUCK_MS, cid);
    } else {
      clearAwaiting(cid); // an idle pane never queues: drop the pre-arm
    }
    const msg = commitDelivery(s, inj, ts, willQueue);
    markReadOnUtterance(s, ts); // his own message reads everything above it (#452)
    D().log("utterance.delivered", { cid, session: s.id, msgId: msg.msgId, ts,
      queued: willQueue, consumedEarly: consumedEarly || undefined,
      chars: text.length, how: inj.how,
      completing: inj.completesTs != null || undefined });
    return { ok: true, ts };
  }

  if (!s.alive || !s.ws) return OFFLINE;

  const ts = inj.completesTs ?? stampTs(s);
  send(s.ws, { t: "transcript", text });
  const msg = commitDelivery(s, inj, ts, false);
  markReadOnUtterance(s, ts); // his own message reads everything above it (#452)
  D().log("utterance.delivered", { cid, session: s.id, msgId: msg.msgId, ts,
    transport: "socket", chars: text.length, how: inj.how,
    completing: inj.completesTs != null || undefined });
  return { ok: true, ts };
}

/* TO THE AGENT, NOT FROM A PERSON. The shared "just feed it into the session"
 * path (#515). Both the agent-message route and a fired schedule deliver through
 * here: the text lands in the pane so the agent acts on it, but neither is
 * something he typed. So NONE of injectUserMessage's user-message bookkeeping
 * runs here:
 *
 *   - no reply-level instruction is appended and no Stop-hook delivery is
 *     recorded, so the turn is free to STOP SILENTLY. A cron that needs nothing
 *     says nothing: enforce-voice-reply.py, finding no outstanding delivery for
 *     this turn, allows the stop. (A cron that DOES need to tell him something
 *     calls the voice MCP itself, which is a normal agent reply on its own path.)
 *   - no role:"user" chat row is written and nothing is marked read, so a firing
 *     leaves the conversation untouched: no litter, no bubble;
 *   - no queued divider, which keys on that row.
 *
 * HE STILL SEES IT, as a session message: the delivered line lands in the
 * transcript, the ingest logs it as a `prompt` session record (source cron or
 * agent, session-events classifyInput), and the app paints that record as a
 * grey activity pill (VISIBLE_EVENT_KINDS). That is the ONE rendering machine
 * input gets. A chat bubble for it has been tried twice (the chat-message
 * route before #515; the attributed role:user+from receipt rows, 2026-09-06)
 * and both were rolled back: a script's words must never sit in the chat as
 * a message, the owner's or anyone's.
 *
 * A busy pane still holds the delivered text in claude's own input; that is
 * herdr's to queue, not ours to track, so nothing is stranded. Returns the same
 * { ok, why, tell, retriable, ts } envelope injectUserMessage does, so the
 * schedule's retry record and the 503 the route answers with are both unchanged. */
export async function deliverToAgent(
  s: Session,
  msg: { how: string; note?: string; text: string; takenAt?: number; deliveryId?: string },
): Promise<Injected> {
  const { how, note, text } = msg;
  const delivered = `${how}${note ? ` (${note})` : ""}: ${text}`;
  /* No user cid here (an agent-message/schedule send writes no chat row and has
   * no queued bookkeeping), but the delivery still reaches the unsubmitted memory
   * through deliverToPane, so a delivery id is needed purely for that keying.
   *
   * A caller that retries the SAME send passes its own STABLE id, and this
   * function honours it: the schedules ladder retries a stranded occurrence at
   * +30s (nextTryAt), inside the 60s stranded TTL, so the retry must carry the
   * id the first attempt keyed its stranded note on, or the enter-only dedupe
   * misses and the body is typed onto the stranded one -- the agent reads the
   * scheduled message doubled. The occurrence mints once (schedules.fire) and
   * threads the id through every retry.
   *
   * When there is no id (a genuinely fresh agent-message send with no retry
   * ladder in front of it), mint one: a distinct send is a distinct stranded
   * note. */
  const deliveryId = msg.deliveryId ?? newCid("agent");
  if (s.viaMux) {
    if (!s.alive) return OFFLINE;
    try {
      await deliverToPane(s.muxHandle, delivered, deliveryId, msg.takenAt);
    } catch (e) {
      /* The same failures injectUserMessage draws, and the same words: a pane
       * sitting on a prompt (PaneNotReady, nothing typed) and a body typed but
       * not submitted (DeliveryStranded, note kept) are both retriable; herdr
       * refusing the keystrokes somewhere in a send_text/enter pair is not,
       * because the text may have landed without its enter. */
      const notReady = e instanceof PaneNotReady;
      const stranded = e instanceof DeliveryStranded;
      D().log("agent-message.delivery-failed", { session: s.id, err: String(e),
        why: notReady || stranded ? (e as PaneNotReady | DeliveryStranded).why
          : "herdr would not take the keystrokes; the message never reached the pane" });
      if (stranded)
        return { ok: false, retriable: true,
          why: (e as DeliveryStranded).why, tell: (e as DeliveryStranded).tell };
      return notReady
        ? { ok: false, retriable: true,
            why: (e as PaneNotReady).why, tell: (e as PaneNotReady).tell }
        : { ok: false,
            why: "the pane is alive but would not take the keystrokes; nothing was " +
              "delivered and nothing was written to the chat log",
            tell: "(message not delivered; the session did not take it. Try again.)" };
    }
    const ts = stampTs(s);
    D().log("agent-message.delivered", { session: s.id, ts, chars: text.length, how });
    return { ok: true, ts };
  }
  if (!s.alive || !s.ws) return OFFLINE;
  const ts = stampTs(s);
  send(s.ws, { t: "transcript", text: delivered });
  D().log("agent-message.delivered", { session: s.id, ts, transport: "socket",
    chars: text.length, how });
  return { ok: true, ts };
}
