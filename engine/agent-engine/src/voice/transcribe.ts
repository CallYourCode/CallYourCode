/* TRANSCRIPTION (L3 feature): the rescue decode, pending long notes, and the
 * deferred-words marker pipeline (task 292 / #442 / #458).
 *
 * The send never waits on a decode: a message whose recording has no words
 * yet ships with a `{{cyc-words:<uploadId>}}` MARKER standing where they
 * belong, and this engine -- which has held the clip since before send was
 * pressed -- reads it and puts the words in. A marker cannot drift because it
 * is TEXT, not an offset; the offsets each attachment carries are moved here,
 * in the one place the edit happens. Long notes are SHOWN at once with the
 * transcript pending and completed into the same row when the chunked decode
 * lands.
 *
 * Wired at boot (initTranscribe) over the voice pick, the log, the broadcast
 * and the delivery chain; the clip and chat stores are their own modules.
 *
 *   bun test agent-engine/src/transcribe.test.ts
 */

import { audio, audioFromDisk } from "../chat/clips.ts";
import { recordVoiceOp } from "./voicelog.ts";
import { newCid } from "../../../shared/logbook.ts";
import { realClock, type Clock } from "../runtime/clock.ts";
import { stampTs, logChat, type ChatSession } from "../chat/chatlog.ts";
import { markReadOnUtterance, type ReadStateSession } from "../sessions/readstate.ts";
import { admitPartial, noteDecodeStart, noteDecodeResult, wordsOf, release, reopen,
  setTranscriptRecordLog, type DecodeMode } from "./transcript-record.ts";
import type { ChatMsg, UploadRec } from "../chat/chatmsg.ts";

/** The slice of a Session this module touches (structural; no cycle). */
export type NoteSession = ChatSession & ReadStateSession;

/* HOW LONG THE RESCUE DECODE MAY RUN before this engine gives up on it: the
 * never-hang-for-ever backstop, not the working deadline (a real 30 minute
 * note decodes legitimately for minutes). */
export const RESCUE_STT_TIMEOUT_MS = Number(process.env.RESCUE_STT_TIMEOUT_MS ?? 15 * 60 * 1000);

/* HOW LONG DELIVERY WAITS for the rescue transcript before it stops holding
 * the note (#458): under this a short note is delivered whole; over it the
 * note is SHOWN at once with the audio safe and its transcript pending. */
export const RESCUE_INLINE_MS = Number(process.env.RESCUE_INLINE_MS ?? 8000);

export const WORDS_TOKEN_RE = /\{\{cyc-words:([0-9a-fA-F-]{8,64})\}\}/g;

/** The marker for one upload, spelled in ONE place: the app builds the same
 *  string from the same uploadId. */
export function wordsToken(uploadId: string): string {
  return `{{cyc-words:${uploadId}}}`;
}

/* What a voice note says when nobody could read its recording: the words the
 * agent and the bubble get instead of an empty line. */
export const NOTE_UNREAD = "(voice note: transcription failed)";

/* A VOICE NOTE'S OWN WORDS, PUT WHERE THE COMPOSER LEFT THEM ("note-words").
 *
 * A note sent as a quoted reply, or with typed words beside it, carries text
 * of its own; the body is that text with ONE marker naming the frame's cid
 * where the recording's words belong (the reply quote above it, the caption
 * below). The send did not wait for the words: this engine reads the note's
 * clip, exactly as it does for an empty-bodied note, and the words go into
 * that marker. The agent reads one message, quote and words together, in the
 * same shape a send that waited for the device used to produce. */
export function fillNoteWords(into: string, cid: string, words: string): string {
  return into.split(wordsToken(cid)).join(words).trim();
}

/* What a note's pending row SHOWS while its words are read: the quote and the
 * caption, with nothing where the words will go (never the marker, which is
 * this engine's bookkeeping). Another device, or this one after a reload, sees
 * what the note answers and what was typed beside it from the first frame;
 * the completion replaces it with the whole text. */
export function noteWithoutWords(into: string, cid: string): string {
  return fillNoteWords(into, cid, "").replace(/\n{3,}/g, "\n\n").trim();
}

/* How long a held message may wait for its transcripts before it goes anyway.
 * A bound and not a promise. */
export const WORDS_WAIT_MS = Number(process.env.WORDS_WAIT_MS ?? 25_000);

/* The transport backstop for the /stt POST below, aborting at the same window
 * the readWords race gives up on. */
export const WORDS_STT_TIMEOUT_MS = Number(process.env.WORDS_STT_TIMEOUT_MS ?? WORDS_WAIT_MS);

/* The signal above aborts with a DOMException named "TimeoutError". Told
 * apart from a decode that FAILED so the deadline path does not trip the
 * once-only whole-clip fallback. */
export function isTimeoutAbort(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "TimeoutError";
}

/* WAITING OUT A BUSY VOICE ENGINE rather than failing the note (#stt-busy).
 *
 * The voice engine answers 503 the moment its batch slots are full (#551), and
 * the rescue used to treat that as "could not read the clip" and ship
 * "(voice note: transcription failed)": a seven-second note behind one 166 s
 * upload was lost after a single two-second try. A 503 is not a failure, it is
 * "wait your turn", so the POST is retried with a climbing backoff until a slot
 * frees -- bounded by the SAME deadline the decode itself already carries
 * (RESCUE_STT_TIMEOUT_MS for the rescue, WORDS_STT_TIMEOUT_MS for deferred
 * words), so a wedged-busy engine still gives up and only THEN falls back to the
 * placeholder. The backoff climbs from MIN to MAX so a short note retries often
 * enough to grab the slot the instant it frees, without hammering the engine
 * while it is genuinely working. FIFO ordering is not imposed here: whichever
 * waiting note wins the next free slot proceeds, which is fine because every
 * wait is bounded by its own decode deadline. */
export const STT_BUSY_BACKOFF_MIN_MS = Number(process.env.STT_BUSY_BACKOFF_MIN_MS ?? 500);
export const STT_BUSY_BACKOFF_MAX_MS = Number(process.env.STT_BUSY_BACKOFF_MAX_MS ?? 5_000);

/* WHAT THE STREAMING DECODER ALREADY SETTLED ON THE DEVICE: the words its
 * live decoder finalized and how far into the audio they reach. This engine
 * then decodes ONLY the tail past `upToS`. Absent means the old contract:
 * read the whole clip. */
export type SettledPartial = { text: string; upToS: number };

/** What a pending note needs, to be shown now and completed later. `into` is
 *  the body the words fill (a note with a reply quote or a caption beside it,
 *  fillNoteWords); absent, the words ARE the body. */
export type PendingNote = { cid: string; how: string; extra: Partial<ChatMsg>; msgId: string; takenAt: number;
  into?: string; redriven?: boolean };

export type TranscribeDeps = {
  voiceUrl(): Promise<string>;
  log(event: string, fields: Record<string, unknown>): void;
  broadcast(msg: unknown): void;
  /** the per-session delivery chain (deliver.ts inOrder) */
  inOrder<T>(sessionId: string, f: () => Promise<T>): Promise<T>;
  /** injectUserMessage, for completing a pending note into its row */
  deliver(s: NoteSession, opts: { cid: string; how: string; text: string;
    extra: Partial<ChatMsg>; completesTs: number; takenAt: number }): Promise<{ ok: boolean; why?: string; tell?: string }>;
  sessionOf(id: string): NoteSession | undefined;
  /** give up on a pending note: its row stops being pending and is marked
   *  undelivered with the reason (deliver.ts failUndeliveredNote) */
  failNote?(s: NoteSession, ts: number, tell: string): void;
  /* EVERY DEADLINE IN THIS FILE COMES FROM HERE. Defaults to the real timers,
   * so production is what it always was; a test passes manualClock() and the
   * four budgets above become arithmetic. That matters more here than almost
   * anywhere else in the engine: RESCUE_STT_TIMEOUT_MS is fifteen minutes and
   * WORDS_WAIT_MS is twenty-five seconds, so the only way these were ever
   * tested was by overriding them from the environment -- which proves the
   * mechanism against a number the product does not ship. With the clock
   * injected a test advances past the SHIPPED constant and no wall clock
   * moves at all. */
  clock?: Clock;
};

let deps: TranscribeDeps | null = null;
export function initTranscribe(d: TranscribeDeps): void {
  deps = d;
  /* The transcript records live behind their own module now; point their
   * write-once log at the engine's log so a duplicate partial is visible where
   * every other words.* line is. */
  setTranscriptRecordLog(d.log);
}
const D = (): TranscribeDeps => {
  if (!deps) throw new Error("transcribe not initialised");
  return deps;
};
const CLOCK = (): Clock => D().clock ?? realClock;

/* AbortSignal.timeout(ms), on the injected clock.
 *
 * Identical to AbortSignal.timeout in what the caller sees: past `ms` the
 * request aborts with a DOMException named "TimeoutError", which is exactly
 * what isTimeoutAbort() below tells apart from a decode that FAILED. The one
 * behavioural difference is in this file's favour: the timer is cancelled once
 * the fetch settles, instead of being left to fire into nothing. */
function timeoutSignal(ms: number): { signal: AbortSignal; done(): void } {
  const c = new AbortController();
  const clock = CLOCK();
  const t = clock.setTimeout(
    () => c.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  return { signal: c.signal, done: () => clock.clearTimeout(t) };
}

/* Sleep `ms` on the injected clock, waking early if `signal` aborts. Used
 * between 503 retries so the backoff wait is itself bounded by the decode
 * deadline: the moment the deadline fires the sleep ends and the next fetch
 * sees an aborted signal. */
function sleepOn(ms: number, signal: AbortSignal): Promise<void> {
  const clock = CLOCK();
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let t: unknown;
    const onAbort = () => { clock.clearTimeout(t); resolve(); };
    t = clock.setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/* ONE decode of a clip through the voice engine's POST /stt, waiting out a busy
 * (503) engine rather than failing the note (#stt-busy).
 *
 * Both decode paths -- the rescue (transcribeStored) and deferred words
 * (sttDecode) -- POST the same shape and want the same 503 handling, so it lives
 * here once. A 503 means the engine's batch slots are full, not that the clip
 * could not be read: log `stt.queued`/`stt.retry`, back off on the injected
 * clock, and try again until a slot frees or `deadlineMs` runs out. The single
 * timeout signal spans every retry, so the whole wait -- decode plus every
 * busy-backoff -- is bounded by the one deadline. When it fires the fetch aborts,
 * which closes the socket and cancels the decode on the voice engine
 * (`stt.cancelled`). The voice op is recorded once, for the final outcome. */
async function sttFetch(opts: {
  url: string; mime: string; body: ArrayBuffer;
  deadlineMs: number; cid?: string; msgId?: string;
}): Promise<{ text: string; dropped: string[]; mode?: "salvaged" | "broken" }> {
  const t0 = performance.now();
  const bound = timeoutSignal(opts.deadlineMs);
  let attempt = 0;
  try {
    for (;;) {
      const res = await fetch(opts.url, {
        method: "POST",
        headers: { "Content-Type": opts.mime },
        body: opts.body,
        signal: bound.signal,
      });
      if (res.status === 503) {
        /* The engine is busy (every batch slot taken). Wait our turn and retry
         * rather than shipping the placeholder; the backoff is bounded by the
         * deadline via the shared signal. */
        const info = await res.json().catch(() => ({} as Record<string, unknown>));
        const backoff = Math.min(STT_BUSY_BACKOFF_MAX_MS,
          STT_BUSY_BACKOFF_MIN_MS * 2 ** Math.min(attempt, 8));
        D().log(attempt === 0 ? "stt.queued" : "stt.retry", {
          cid: opts.cid, msgId: opts.msgId, attempt: attempt + 1,
          busy: typeof info?.error === "string" ? info.error : undefined,
          waitMs: backoff, waitedMs: Math.round(performance.now() - t0) });
        attempt++;
        await sleepOn(backoff, bound.signal);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const text = typeof json?.text === "string" ? json.text.trim() : "";
      const dropped = Array.isArray(json?.dropped) ? json.dropped.filter((x: unknown) => typeof x === "string") : [];
      /* The voice engine re-muxed a broken container (task 594): visible in the
       * voice log rather than shipping as a silent chars=0. */
      const mode = json?.mode === "salvaged" || json?.mode === "broken" ? json.mode : undefined;
      const timing = json?.timing ?? {};
      recordVoiceOp({
        op: "stt", cid: opts.cid, chars: text.length,
        queueWaitMs: Number.isFinite(timing.queueMs) ? timing.queueMs : undefined,
        upstreamMs: Number.isFinite(timing.decodeMs) ? timing.decodeMs : undefined,
        audioS: Number.isFinite(timing.audioS) ? timing.audioS : undefined,
        rtf: Number.isFinite(timing.rtf) ? timing.rtf : undefined,
        mode,
        engineMs: Math.round(performance.now() - t0),
        outcome: "ok",
      });
      return { text, dropped, mode };
    }
  } catch (e) {
    recordVoiceOp({
      op: "stt", cid: opts.cid,
      engineMs: Math.round(performance.now() - t0),
      outcome: isTimeoutAbort(e) ? "timeout" : "error", err: String(e),
    });
    if (isTimeoutAbort(e)) {
      /* The deadline arrived (in a decode, or while waiting out a busy engine):
       * the fetch aborted, closing the socket, which tells the voice engine to
       * cancel the decode instead of burning the decoder on it (#stt-busy). */
      D().log("stt.cancelled", { cid: opts.cid, msgId: opts.msgId,
        waitedMs: Math.round(performance.now() - t0),
        why: "the decode deadline passed; the in-flight decode is cancelled on the voice engine" });
    }
    throw e;
  } finally {
    bound.done();
  }
}

/* HOW LONG DELIVERY HOLDS A WORDLESS NOTE INLINE (#458), raced against the
 * decode itself. It lives here rather than in deliver.ts because the deadline
 * and the decode it bounds are one decision, and because this is the module
 * holding the clock they are both measured on.
 *
 * `ready:false` is the long-note branch: the caller shows the note at once with
 * the audio safe and its transcript pending, and the SAME rescue promise
 * completes that row later. */
export async function raceInlineRescue(rescue: Promise<string>):
  Promise<{ ready: true; t: string } | { ready: false; t: "" }> {
  const clock = CLOCK();
  let t: unknown;
  const late = new Promise<{ ready: false; t: "" }>((res) => {
    t = clock.setTimeout(() => res({ ready: false, t: "" }), RESCUE_INLINE_MS);
  });
  try {
    return await Promise.race([rescue.then((v) => ({ ready: true as const, t: v })), late]);
  } finally {
    clock.clearTimeout(t);
  }
}

/* The device could not (or did not wait to) transcribe its own recording, but
 * the clip is already here. The third fallback: the page tries the streaming
 * socket, then a batch POST of its own; when both fail the message used to
 * simply never arrive.
 *
 * With a SettledPartial the device's streaming decoder already turned the
 * front of this clip into text: decode ONLY the tail past `upToS` and prepend
 * the settled words (the same tail contract as transcribeUpload). The settled
 * words are a FLOOR (#550): a failed or shorter decode never replaces them. */
export async function transcribeStored(msgId: string, cid?: string,
  partial?: SettledPartial): Promise<string> {
  const d = D();
  const settled = (partial?.text ?? "").trim();
  const fromS = partial && Number.isFinite(partial.upToS) && partial.upToS > 0 ? partial.upToS : 0;
  const tailOnly = !!settled && fromS > 0;
  /* The streamed-words floor lives in the record now: admit it here and read it
   * back through wordsOf, rather than keeping `settled` as a second copy of the
   * same rule. This is a new read of the clip (a retry reads it again after the
   * last read released it), so it owns a fresh record from here to its release. */
  reopen(msgId);
  admitPartial(msgId, partial);
  const clip = audio.get(msgId) ?? (await audioFromDisk(msgId));
  if (!clip) {
    d.log("rescue.no-clip", { cid, msgId,
      settledChars: settled.length || undefined,
      why: "neither the hot cache nor the disk has this clip; nothing to transcribe" });
    /* The device's settled words still stand: the prefix it heard beats "". */
    const out = wordsOf(msgId);
    release(msgId);
    return out;
  }
  d.log("rescue.start", { cid, msgId, bytes: clip.bytes.byteLength, mime: clip.mime,
    tailOnly: tailOnly || undefined, fromS: tailOnly ? fromS : undefined,
    settledChars: tailOnly ? settled.length : undefined });
  /* One POST of the stored clip: whole (offsetS 0) or the tail past offsetS. A
   * busy engine (503) is waited out rather than failed; the wait is bounded by
   * RESCUE_STT_TIMEOUT_MS (sttFetch, #stt-busy). */
  const post = async (offsetS: number): Promise<{ text: string; dropped: string[] }> => {
    const base = await d.voiceUrl();
    const url = offsetS > 0 ? `${base}/stt?offset=${encodeURIComponent(offsetS)}` : `${base}/stt`;
    const r = await sttFetch({ url, mime: clip.mime, body: clip.bytes as unknown as ArrayBuffer,
      deadlineMs: RESCUE_STT_TIMEOUT_MS, cid, msgId });
    return { text: r.text, dropped: r.dropped };
  };
  const finish = (text: string, dropped: string[], mode: DecodeMode): string => {
    /* The floor is the record's now (#550): feed the raw decode in and read
     * the merged answer back. The batch result may only replace the streamed
     * words when it holds at least as much. */
    noteDecodeResult(msgId, { state: "decoded", text });
    const out = wordsOf(msgId);
    d.log("rescue.done", { cid, msgId, chars: out.length, mode,
      reusedChars: tailOnly ? settled.length : 0,
      text: out.slice(0, 120), dropped: dropped.length ? dropped : undefined });
    return out;
  };
  try {
    if (tailOnly) {
      noteDecodeStart(msgId, "tail");
      let tail: { text: string; dropped: string[] };
      try {
        tail = await post(fromS);
      } catch (e) {
        /* A TIMED-OUT tail decode is the deadline arriving, not a decode that
         * failed: no second POST at a wedged engine (#550); the settled words
         * stand. */
        if (isTimeoutAbort(e)) {
          noteDecodeResult(msgId, { state: "timeout" });
          d.log("rescue.tail-timeout", { cid, msgId, fromS,
            why: "the tail decode did not land within the deadline; keeping the " +
              "streamed words rather than firing a second POST at a wedged engine" });
          const out = wordsOf(msgId);
          release(msgId);
          return out;
        }
        /* The tail decode FAILED: read the whole clip once instead. The
         * settled words drop out of the join (a whole decode holds them) but
         * remain the floor if that read comes back short. */
        d.log("rescue.tail-failed", { cid, msgId, fromS, err: String(e),
          why: "the tail decode failed; reading the whole clip once instead" });
        noteDecodeStart(msgId, "whole-fallback");
        const whole = await post(0);
        const out = finish(whole.text, whole.dropped, "whole-fallback");
        release(msgId);
        return out;
      }
      const out = finish([settled, tail.text].filter(Boolean).join(" "), tail.dropped, "tail");
      release(msgId);
      return out;
    }
    noteDecodeStart(msgId, "whole");
    const whole = await post(0);
    const out = finish(whole.text, whole.dropped, "whole");
    release(msgId);
    return out;
  } catch (e) {
    noteDecodeResult(msgId, { state: "failed" });
    d.log("rescue.failed", { cid, msgId, err: String(e),
      settledChars: settled.length || undefined,
      why: "the voice engine could not read the stored clip" });
    /* No partial: "" as before. With one, the streamed floor stands. */
    const out = wordsOf(msgId);
    release(msgId);
    return out;
  }
}

/* SHOW A LONG NOTE NOW, COMPLETE ITS TRANSCRIPT LATER (#458). The agent must
 * read a voice note ONCE, whole, so the single delivery waits for
 * completePendingVoiceNote, which fills THIS same row when the decode lands. */
export function showPendingVoiceNote(s: NoteSession, d: PendingNote, rescue: Promise<string>): void {
  const dd = D();
  const ts = stampTs(s);
  /* The body the words go into is kept ON THE ROW, so a restart that loses the
   * in-flight decode still completes the note with its quote and caption
   * (redrivePendingNotes). The app reads frames field by field and never
   * sees it; what it shows meanwhile is the quote and caption alone. */
  const msg: ChatMsg = { id: s.id, role: "user", text: d.into ? noteWithoutWords(d.into, d.cid) : "",
    ts, cid: d.cid, ...d.extra, transcriptPending: true, ...(d.into ? { wordsInto: d.into } : {}) };
  drivingNotes.add(`${s.id}|${d.cid}`);
  logChat(s, msg);
  markReadOnUtterance(s, ts); // his own message reads everything above it (#452)
  dd.broadcast({ t: "chat", ...msg });
  dd.log("utterance.shown-pending", { cid: d.cid, session: s.id, msgId: d.msgId, ts,
    why: "the note is long; shown now with the audio safe and the transcript pending, " +
      "delivered to the agent once when the chunked decode lands" });
  void completePendingVoiceNote(s, ts, d, rescue);
}

/* THE COMPLETION: the note is delivered to the agent ONE time, as the
 * completion of the row already at `ts`. If the session will not take it, the
 * audio and the pending bubble stand and a restart re-drives it. */
export async function completePendingVoiceNote(s: NoteSession, ts: number, d: PendingNote, rescue: Promise<string>): Promise<void> {
  const dd = D();
  let words = "";
  try { words = await rescue; } catch { words = ""; }
  const said = words || NOTE_UNREAD;
  const text = d.into ? fillNoteWords(d.into, d.cid, said) : said;
  if (!words) {
    dd.log("rescue.failed-late", { cid: d.cid, session: s.id, msgId: d.msgId, ts,
      why: "the pending note's decode returned nothing; completing it with the placeholder" });
  }
  await dd.inOrder(s.id, async () => {
    /* The session as it is NOW: the row object is rebuilt on every mux poll,
     * and the one this decode started with may be a dead pane's by now. */
    const live = dd.sessionOf(s.id) ?? s;
    const res = await dd.deliver(live, { cid: d.cid, how: d.how, text,
      extra: d.extra, completesTs: ts, takenAt: d.takenAt });
    if (res.ok) {
      dd.log("rescue.completed", { cid: d.cid, session: s.id, msgId: d.msgId, ts, chars: text.length });
    } else if (d.redriven && dd.failNote) {
      /* A drive after a restart that was refused: what is in the box is not
       * known, so the note is not owed again on its own (a later drive could
       * deliver it twice); the row says so on every device. */
      dd.failNote(live, ts, res.tell ?? "it could not be delivered");
      dd.log("rescue.complete-failed", { cid: d.cid, session: s.id, msgId: d.msgId, ts,
        why: res.why ?? "the session refused the completion driven after a restart" });
    } else {
      /* Not delivered: the audio and the pending bubble stand, and the note
       * is owed again the next time this session comes up live (or the next
       * boot). Taking it off the driving set is what lets that happen. */
      drivingNotes.delete(`${s.id}|${d.cid}`);
      dd.log("rescue.complete-undelivered", { cid: d.cid, session: s.id, msgId: d.msgId, ts,
        why: res.why ?? "the session did not take the completed note; the audio and pending " +
          "bubble stand and it is driven again when the session is next picked up live" });
    }
  });
}

/* The pending notes this process is completing, by session and cid: the one
 * guard that keeps a note from being decoded and delivered twice when its
 * session is picked up again while the first completion is still running. */
const drivingNotes = new Set<string>();

/** TEST ONLY: a fresh process's memory. */
export function resetPendingForTest(): void {
  drivingNotes.clear();
}

/* NOTES SHOWN WITH THEIR WORDS STILL PENDING, driven to the agent for a session
 * that has just come up live (#458, B1 of the reply-words verification).
 *
 * The row is the durable record: it persisted with the audio's msgId, the
 * cid and, for a quoted or captioned note, the body its words fill
 * (wordsInto). What did not survive a restart is the in-flight decode, so it
 * is run again here and the completion fills that same row, ONCE.
 *
 * Called from the session's pickup (reconcile's sessionLive), never from a
 * timer over restoredChats: that map is emptied for a session the moment its
 * pane reconciles, about a second into a boot, so a sweep over it ten seconds
 * in found nothing and a pending note was never delivered. Every pickup of a
 * live session asks; the driving set answers "already owed by this process". */
export function redrivePendingNotes(s: NoteSession): number {
  const dd = D();
  let redriven = 0;
  for (const m of s.chat) {
    if (m.role !== "user" || !m.transcriptPending || m.kind !== "voice" || typeof m.msgId !== "string") continue;
    const cid = m.cid || newCid("m");
    const key = `${s.id}|${cid}`;
    if (drivingNotes.has(key)) continue;
    drivingNotes.add(key);
    dd.log("rescue.redrive", { cid, session: s.id, msgId: m.msgId, ts: m.ts,
      why: "a note was shown with its words pending and its decode did not survive (an engine " +
        "restart, or a delivery the session did not take); it is completed now its session is live" });
    const extra: Partial<ChatMsg> = { kind: "voice", msgId: m.msgId,
      ...(Number.isFinite(m.durationS) ? { durationS: m.durationS } : {}) };
    void completePendingVoiceNote(s, m.ts, { cid, how: "VOICE", extra, msgId: m.msgId, takenAt: Date.now(),
      redriven: true, ...(m.wordsInto ? { into: m.wordsInto } : {}) },
      transcribeStored(m.msgId, cid));
    redriven++;
  }
  if (redriven) console.log(`[rescue] re-drove ${redriven} pending transcript(s) for ${s.id}`);
  return redriven;
}

/** POST the clip (whole, or the tail past `offsetS`) to the voice engine. A busy
 *  engine (503) is waited out, bounded by WORDS_STT_TIMEOUT_MS (sttFetch,
 *  #stt-busy). */
export async function sttDecode(u: UploadRec, offsetS: number, cid?: string):
  Promise<{ text: string; dropped: string[]; mode?: "salvaged" | "broken" }> {
  const base = await D().voiceUrl();
  const url = offsetS > 0 ? `${base}/stt?offset=${encodeURIComponent(offsetS)}` : `${base}/stt`;
  const body = (await Bun.file(u.path).arrayBuffer()) as unknown as ArrayBuffer;
  return sttFetch({ url, mime: u.mime || "audio/webm", body,
    deadlineMs: WORDS_STT_TIMEOUT_MS, cid });
}

/** Read one uploaded recording off this engine's own disk. Tail-only when the
 *  app handed over a partial the device already settled; the whole clip
 *  otherwise, or when a tail decode fails (once, logged). */
export async function transcribeUpload(u: UploadRec, cid?: string, partial?: SettledPartial): Promise<string> {
  const dd = D();
  const f = Bun.file(u.path);
  if (!(await f.exists())) {
    dd.log("words.no-clip", { cid, upload: u.uploadId, path: u.path,
      why: "the message named a recording that is no longer in the upload directory" });
    return "";
  }
  const settled = (partial?.text ?? "").trim();
  const fromS = partial && Number.isFinite(partial.upToS) && partial.upToS > 0 ? partial.upToS : 0;
  const tailOnly = !!settled && fromS > 0;
  dd.log("words.start", { cid, upload: u.uploadId, bytes: f.size, mime: u.mime,
    tailOnly, settledChars: tailOnly ? settled.length : undefined,
    fromS: tailOnly ? fromS : undefined });
  try {
    if (tailOnly) {
      /* sttDecode's own return type, not a hand-copy of two of its three
       * fields: the copy left out `mode`, which the words.done line below
       * logs as `salvage`. */
      let tail: Awaited<ReturnType<typeof sttDecode>>;
      try {
        tail = await sttDecode(u, fromS, cid);
      } catch (e) {
        /* A TIMED-OUT tail decode is the deadline arriving, NOT a decode that
         * failed: a whole-clip fallback would only fire a SECOND POST at a
         * still-wedged engine (#550). Give up quietly and let the streamed
         * words floor stand. */
        if (isTimeoutAbort(e)) {
          dd.log("words.tail-timeout", { cid, upload: u.uploadId, fromS,
            waitMs: WORDS_STT_TIMEOUT_MS,
            why: "the tail decode did not land within the deadline; keeping the " +
              "streamed words rather than firing a second POST at a wedged engine" });
          return "";
        }
        /* THE TAIL DECODE FAILED, so fall back to the whole clip ONCE. The
         * settled words are dropped from the join: a whole decode already
         * holds them. */
        dd.log("words.tail-failed", { cid, upload: u.uploadId, fromS, err: String(e),
          why: "the tail decode failed; reading the whole clip once instead" });
        const whole = await sttDecode(u, 0, cid);
        dd.log("words.done", { cid, upload: u.uploadId, chars: whole.text.length,
          mode: "whole-fallback", reusedChars: 0, tailChars: whole.text.length,
          salvage: whole.mode,
          text: whole.text.slice(0, 120), dropped: whole.dropped.length ? whole.dropped : undefined });
        return whole.text;
      }
      const full = [settled, tail.text].filter(Boolean).join(" ");
      dd.log("words.done", { cid, upload: u.uploadId, chars: full.length,
        mode: "tail", reusedChars: settled.length, tailChars: tail.text.length,
        salvage: tail.mode,
        text: full.slice(0, 120), dropped: tail.dropped.length ? tail.dropped : undefined });
      return full;
    }
    const whole = await sttDecode(u, 0, cid);
    dd.log("words.done", { cid, upload: u.uploadId, chars: whole.text.length,
      mode: "whole", reusedChars: 0, tailChars: whole.text.length,
      salvage: whole.mode,
      text: whole.text.slice(0, 120), dropped: whole.dropped.length ? whole.dropped : undefined });
    return whole.text;
  } catch (e) {
    dd.log("words.failed", { cid, upload: u.uploadId, err: String(e),
      why: "the voice engine could not read the stored recording" });
    return "";
  }
}

/** Every marker in this body, decoded, bounded. Absent words come back as an
 *  empty string, which is the honest answer: nobody could read that clip. */
export async function readWords(ups: UploadRec[], ids: string[], cid: string,
  partials?: Map<string, SettledPartial>):
  Promise<Map<string, string>> {
  const dd = D();
  const got = new Map<string, string>();
  let done = false;
  const all = Promise.all(ids.map(async (id) => {
    const u = ups.find((x) => x.uploadId === id);
    if (!u) return;
    const words = await transcribeUpload(u, cid, partials?.get(id));
    /* Feed the raw decode into this recording's record; the floor merge is the
     * record's (wordsOf), read by the caller (#550, one merge site). */
    noteDecodeResult(id, { state: words ? "decoded" : "failed", text: words });
    if (words) got.set(id, words);
  })).then(() => { done = true; });
  /* The deadline, on the injected clock: past it the message goes with what
   * there is. Cancelled when the decodes win the race, so a message that was
   * never late does not leave a twenty-five second timer behind it. */
  const clock = CLOCK();
  let late: unknown;
  try {
    await Promise.race([all, new Promise<void>((res) => { late = clock.setTimeout(res, WORDS_WAIT_MS); })]);
  } finally {
    clock.clearTimeout(late);
  }
  if (!done) {
    dd.log("words.deadline", { cid, upload: ids.join(","), waitedMs: WORDS_WAIT_MS,
      got: [...got.keys()].join(",") || undefined,
      why: "the recordings were not all decoded in time; the message goes with what there " +
        "is rather than waiting any longer" });
  }
  return got;
}

/* PUT THE WORDS IN, AND MOVE EVERYTHING THE EDIT MOVED. One replace pass over
 * the whole body; a marker naming nothing HERE is his text (a quotation) and
 * is left alone; the offsets each attachment carries are moved against the
 * exact string being edited. Nothing else may touch them. */
export function fillWords(text: string, ups: UploadRec[], got: Map<string, string>):
  { text: string; filled: string[]; unread: string[]; kept: string[] } {
  const known = new Set(ups.map((u) => u.uploadId));
  const toks: { id: string; at: number; raw: number; words: string }[] = [];
  const kept: string[] = [];
  const out = text.replace(WORDS_TOKEN_RE, (raw: string, id: string, at: number) => {
    /* Returned BEFORE it is recorded as a token, deliberately: an untouched
     * marker moves no offset and it is not a transcript that failed, so it
     * must appear in neither list. */
    if (!known.has(id)) {
      kept.push(id);
      return raw;
    }
    const words = (got.get(id) ?? "").trim();
    toks.push({ id, at, raw: raw.length, words });
    return words;
  });
  if (!toks.length) return { text: out, filled: [], unread: [], kept };
  /* An offset in the OLD body, in the NEW one. Only markers that START BEFORE
   * it can have moved it: a marker at the same offset is the thing itself. */
  const moved = (n: number) => n + toks.reduce(
    (d, t) => d + (t.at < n ? t.words.length - t.raw : 0), 0);
  for (const u of ups) {
    const own = toks.find((t) => t.id === u.uploadId);
    if (own) {
      u.at = moved(own.at);
      if (own.words.length) u.textLen = own.words.length;
      else delete u.textLen;
    } else if (typeof u.at === "number") {
      u.at = moved(u.at);
    }
  }
  return {
    text: out,
    filled: toks.filter((t) => t.words).map((t) => t.id),
    unread: toks.filter((t) => !t.words).map((t) => t.id),
    kept,
  };
}
