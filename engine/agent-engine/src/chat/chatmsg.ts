/* THE CHAT MESSAGE MODEL (L2 domain): what one line of a conversation IS, and
 * the ONE way to read or write its attachments. Pure: no IO, no engine state.
 * The wire shape here is CONTRACT.md's one message shape; nothing may grow a
 * second array or a second read path.
 *
 *   bun test agent-engine/src/chat/chatmsg.test.ts
 */

import type { ShowKind } from "./show.ts";

/** One file the user sent up. See ChatMsg.upload / ChatMsg.uploads. */
export type UploadRec = {
  uploadId: string; name: string; mime: string; size: number; path: string; image: boolean;
  fromPage?: { label: string; page: string };
  /* How long the clip runs, in whole seconds, when this attachment IS a
   * recording. Without it a sent voice block has no length, no clock and a
   * dead seek bar the moment the page reloads or another device replays the
   * history -- and nothing downstream can recover it,
   * because a clip recorded in a browser carries no duration in its container
   * at all: MediaRecorder never fills the WebM header, so only the recorder
   * knows and only at record time.
   *
   * Absent on anything that is not a recording, and an attachment without it
   * renders exactly as it did before this field existed. Declared here for the
   * same reason `fromPage` is: so it is kept on purpose rather than surviving
   * by accident through a spread somebody may later replace with a field
   * list. */
  durationS?: number;
  /* WHERE IN THE BODY THIS ATTACHMENT WAS COMPOSED, and how many characters
   * from there are its OWN words (see sendLayout in the app's
   * components/composer.ts). Minted by the composer against the body it sends
   * and copied through untouched -- except on a message whose transcripts THIS
   * engine filled in, where the body they were measured against is not the body
   * that ships. fillWords() below moves every one of them by the same edit that
   * put the words in, which is the only place in this file allowed to. */
  at?: number;
  textLen?: number;
};

/* Seconds from a client, or nothing.
 *
 * The number only decides how long a bar is drawn, so a wrong one costs a
 * wrong clock and nothing more -- but NaN, Infinity and negatives all render
 * as garbage, and 0 is indistinguishable from "not a recording", so they all
 * become absent. The cap is a day, which no voice note reaches and every
 * accident exceeds. */
export function cleanDuration(v: unknown): number | undefined {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 && n <= 86_400 ? n : undefined;
}

/* The durable row id minted for ChatMsg.mid: `mr-` plus 16 base64url chars
 * (12 random bytes), the same shape as the session-record mint with a distinct
 * prefix so a message row id can never be confused with a record (`se-`) or an
 * agent id. Minted once at write time and persisted; nothing derives it, so it
 * survives an ensureSeqs renumber and any restart. */
export function mintMsgId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `mr-${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_")}`;
}

/* THE CONTROL-ANSWER SENTINEL. When the owner answers a terminal prompt from
 * the app (session-verbs.ts onAnswer: the session-resume picker, a yes/no
 * dialog), the engine records the decision in the transcript as one of his
 * messages, formatted `\u21a9 <label>` ("\u21a9 Resume full session as-is").
 * That row is a CONTROL INPUT, not a message he typed, so the transcript hides
 * its bubble and the roster does not let it drive the preview or the last
 * activity clock. The row stays in the log (it is real history); only its shape
 * is recognised, here at the one origin, so the match is exact and never a fuzzy
 * search over arbitrary user text. */
export const CONTROL_ANSWER_PREFIX = "\u21a9 ";
export function isControlAnswer(m: { role: string; text: string }): boolean {
  return m.role === "user" && typeof m.text === "string" && m.text.startsWith(CONTROL_ANSWER_PREFIX);
}

export type ChatMsg = {
  id: string;
  role: "user" | "claude";
  text: string;
  ts: number;
  msgId?: string; // audio at /audio/<msgId>.mp3 (claude: TTS; user: uploaded voice note)
  /* THE CALLER'S IDEMPOTENCY KEY for this reply (#505). speak/chat are
   * at-least-once: a slow ack (TTS on a busy box outran the MCP's 15s wait)
   * makes the tool retry, the first delivery ALSO lands, and the engine
   * recorded one utterance twice (conv 9cd55489, seq 66/67). The MCP now mints
   * one key per logical utterance and REUSES it on retry; onReply records the
   * first arrival, remembers the key, and a later frame carrying a known key
   * re-acks the original without writing a second row. Stored here so the
   * dedupe window survives a restart (rebuilt from the persisted tail) the same
   * way the chat log does. Absent on every message written before this and on
   * any reply from an MCP older than #505, which simply gets the old behaviour.
   * The keyless tolerance is PERMANENT for two reasons, not a cleanup pending:
   * old stored rows on disk simply lack `key`, AND a long-lived pane can hold a
   * pre-#505 MCP process across an engine deploy (panes survive restarts), so a
   * keyless reply can still arrive from a live process, not only from history. */
  key?: string;
  /* user voice notes; absent = typed text. "system": an engine-authored
   * divider such as "new session (clear)" on a harness rollover (lane 2). */
  kind?: "voice" | "system";
  durationS?: number; // voice notes: recorded length, for the bubble timer
  /* THE CLIP IS STILL BEING WRITTEN (#525). A spoken reply is synthesised one
   * sentence at a time and appended to /audio/<msgId>.mp3, so the app can start
   * playing at the first chunk (~1-2s) instead of waiting ~25s for the whole
   * thing. While this is true the clip on disk is a VALID but PARTIAL mp3 and
   * `durationS` is only what has landed so far; the app draws it as growing and
   * follows the file. A completion re-broadcast of this same message (same
   * ts/seq) clears the flag and carries the final duration, and a boot sweep
   * does the same for any clip caught mid-growth by a restart. Absent on every
   * message that finished growing and on every message written before #525. */
  growing?: boolean;
  // MCP `show` tool: a file pushed for in-app viewing. Content is NOT inline
  // (chat replay stays light); the app fetches GET /doc/<docId> on open.
  // fileKind "image" renders in the bubble itself. `inline` means the app
  // should render it in place rather than as a card to open: short markdown
  // and diffs (a checklist, a small patch) read better as part of the
  // conversation, and `content` carries them so there is nothing to fetch.
  file?: {
    docId: string;
    name: string;
    fileKind: ShowKind; // markdown | diff | text | image | html | binary (show.ts)
    size: number;
    inline?: boolean;
    content?: string;
  };
  // Something the USER sent up: an image renders as a thumbnail, anything
  // else as a document card. Stored on disk under the session's cwd so the
  // agent can simply open `path`.
  /* `fromPage` is the app's, not ours: an interactive page shown in this chat
   * answered back and the composer marked the file with which page and what it
   * called the answer (app: app/src/engine/contract.ts). The engine copies the
   * upload record through whole -- into the chat log and onto the echo -- so
   * the sent bubble can still say `submit:show-decision.html` on a cold start.
   * Declared here so it is not merely surviving by accident. */
  upload?: UploadRec;
  /* SEVERAL attachments on ONE message. The `upload`/`uploads`
   * pair is the PERMANENT STORAGE CONTRACT for attachments, NOT back-compat
   * awaiting cleanup: the chat log on disk carries years of rows written with
   * `upload` alone, and rewriting every agent's multi-MB jsonl at boot to drop
   * the singular field is unbounded risk for a reader dedup that attachmentsOf()
   * already makes safe. Both fields therefore stay for good, under one rule that
   * everything here obeys, readers included:
   *
   *   `uploads`, when present, IS the message's attachment list, in order.
   *   `upload` is then a copy of its FIRST entry and nothing more.
   *
   * New writes always use that pair; the singular `upload` also lets an app
   * bundle that predates the plural field still draw the first attachment. Rows
   * that have `upload` alone are read with attachmentsOf(), never by hand, or
   * the two fields will eventually be counted twice. */
  uploads?: UploadRec[];
  // true while the message sits in claude's input queue: typed into the pane
  // but not yet taken into context. Cleared when the session log records the
  // queue consuming it. Drives the "not read yet" divider in the app.
  queued?: boolean;
  /* The recording's correlation id, minted in the BROWSER when the microphone
   * opened (app: app/src/shared/logging.ts). Stored so the persisted message can be
   * joined back to the log lines that describe how it got here: given a note
   * that looks wrong in chat.json, `cyclog.sh <cid>` prints its whole life.
   * Purely diagnostic; nothing reads it to make a decision. */
  cid?: string;
  /* Nobody typed this one: a schedule fired it (schedules.ts), and this is the
   * schedule's name. It is a `role: "user"` message like any other because the
   * session genuinely received it as one -- but a bubble that looks typed and
   * was not is the app claiming something it does not know, so the name travels
   * with it and the bubble says so. */
  scheduled?: string;
  /* ONE OF THIS MESSAGE'S RECORDINGS HAS NO WORDS AND NEVER WILL (task 292).
   *
   * The composer sent the message without waiting for the transcript and this
   * engine could not read the clip either. The recording is untouched and the
   * agent was handed its path; the WORDS are what is missing, and the bubble has
   * to say so, because an empty line under a waveform reads as a recording of
   * silence -- the app asserting the one thing it does not know.
   *
   * Absent everywhere else, including on every message written before this
   * existed, so an older app renders exactly what it always did. */
  wordsFailed?: boolean;
  /* A LONG NOTE'S TRANSCRIPT IS STILL BEING READ (#458).
   *
   * The device could not transcribe the recording, so this engine reads it --
   * but a 30 minute note takes minutes to decode, and holding the bubble that
   * long would leave it stuck at "sending". So the note is written and shown at
   * once, with the audio safe and this flag set, and the transcript fills the
   * same message in when the chunked decode lands (handleUtterance ->
   * completePendingVoiceNote). The bubble shows the recording is being read
   * rather than an empty line under a waveform, which would be the app asserting
   * silence it does not know. Cleared when the words arrive (or fail).
   *
   * Absent everywhere else, so an older app renders exactly what it always did. */
  transcriptPending?: boolean;
  /* THE MESSAGE'S PLACE IN THE CONVERSATION, monotonic within a session. It is
   * what the page contract counts by: page N holds seq in [N*100, N*100+99]
   * (pages.ts). Assigned at append (logChat) as lastSeq+1, and backfilled from
   * position for any log written before this field existed (ensureSeqs). Stored,
   * not derived from the array index, so a front trim-log cannot re-number the
   * sealed pages under the app. Optional in the type only so the many places
   * that build a message literal need not set it: logChat stamps it on append
   * and ensureSeqs backfills it before any page is served, so it is in fact
   * present on every message the wire ever carries. */
  seq?: number;
  /* A DURABLE, RESTART- AND RENUMBER-INVARIANT ROW IDENTITY (dup-rows).
   *
   * `seq` is the paging axis, and it is NOT a stable identity: it is shared
   * with the session records (chatlog nextSeq/ensureSeqs), so inserting a
   * `t:"s"` record across a restart can renumber a message onto a shifted
   * axis -- the live log already carries message rows with COLLIDING seqs.
   * When seq was the app's dedup key, a row re-served under a changed seq was
   * admitted a second time, painting a verbatim twin of every row (both
   * roles) after a reconnect.
   *
   * `mid` is minted once, at write time (logChat), persisted in this line, and
   * never touched again, so it is identical on every re-serve and every
   * restart. The app dedups on it and only orders by seq. Absent on every
   * message written before this field existed; those fall back to
   * ts|role|text, which is also stable (ts is strictly increasing per session,
   * so unique per row). */
  mid?: string;
};

/* THE ONE WAY TO ASK A MESSAGE WHAT IT HAS ATTACHED, in order.
 *
 * Every reader goes through here -- the uploads sweep above all, because that
 * one DELETES. `referencedUploads()` used to read `m.upload?.uploadId` alone,
 * and the moment a message could carry a second attachment that spelling
 * became a way to lose his audio: the file is in the directory, the message
 * points at it, and the sweep does not see the pointer.
 *
 * The messages this reads are not all ours to trust: `restoredChats` is the
 * chat jsonl replayed off disk, written by whatever version ran last. So a
 * `uploads` that is not an array, or an entry that is not an object, is
 * ignored rather than believed.
 */
/* Fix up the one field that has to be a number, and CHANGE NOTHING ELSE.
 *
 * A spread, not a rebuild, and the difference is a whole class of bug. Writing
 * `{ uploadId, name, mime, size, path, image }` here would look tidier and
 * would silently eat every field not on that list -- `fromPage` today,
 * `durationS` now, whatever is added next. That projection shape has already
 * cost this project several separate defects, so it is spelled out rather than
 * left to whoever edits next. */
export function cleanUpload(u: UploadRec): UploadRec {
  const d = cleanDuration(u.durationS);
  if (d === u.durationS) return u;
  const out = { ...u };
  if (d === undefined) delete out.durationS;
  else out.durationS = d;
  return out;
}

export function attachmentsOf(m: ChatMsg): UploadRec[] {
  const list = Array.isArray(m.uploads)
    ? m.uploads.filter((u): u is UploadRec => !!u && typeof u === "object").map(cleanUpload)
    : [];
  // `upload` is a copy of uploads[0] when both are present, so it is only a
  // source when the plural field is not there at all: the old shape.
  if (!list.length && m.upload && typeof m.upload === "object") return [cleanUpload(m.upload)];
  return list;
}

/* The searchable text of a message: its text, or the name of an attachment sent
 * with no caption, or every attached name (so searching for the second file of
 * four finds the message that carries it). ONE definition, used by both the
 * /chat-search route and the search plugin's rpc via scanChat, so the two cannot
 * disagree about what a message contains. */
export function searchableText(c: ChatMsg): string {
  return c.text || c.file?.name || attachmentsOf(c).map((u) => u.name).join(" ") || "";
}

/** Every id a message carries, for one log field. `undefined` when there are
 *  none, so the field disappears rather than reading `upload=`. */
export function uploadIds(ups: UploadRec[]): string | undefined {
  return ups.length ? ups.map((u) => u.uploadId).join(",") : undefined;
}

/* The other half of the permanent pair: how a message is WRITTEN.
 *
 * Every non-empty list is written as `uploads` in order, plus `upload` holding
 * the first, which is what an app bundle that predates the plural field
 * renders instead of drawing no attachment at all. This is the storage
 * contract, not a compat shim: rows on disk that have `upload` alone are
 * always read back through attachmentsOf(). */
export function attachmentFields(ups: UploadRec[]): Partial<ChatMsg> {
  if (!ups.length) return {};
  return { upload: ups[0], uploads: ups };
}

