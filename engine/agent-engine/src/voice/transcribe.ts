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
import { admitPartial, noteDecodeStart, noteDecodeResult, wordsOf, release,
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

/* WHAT THE STREAMING DECODER ALREADY SETTLED ON THE DEVICE: the words its
 * live decoder finalized and how far into the audio they reach. This engine
 * then decodes ONLY the tail past `upToS`. Absent means the old contract:
 * read the whole clip. */
export type SettledPartial = { text: string; upToS: number };

/** What a pending note needs, to be shown now and completed later. */
export type PendingNote = { cid: string; how: string; extra: Partial<ChatMsg>; msgId: string; takenAt: number };

export type TranscribeDeps = {
  voiceUrl(): Promise<string>;
  log(event: string, fields: Record<string, unknown>): void;
  broadcast(msg: unknown): void;
  /** the per-session delivery chain (deliver.ts inOrder) */
  inOrder<T>(sessionId: string, f: () => Promise<T>): Promise<T>;
  /** injectUserMessage, for completing a pending note into its row */
  deliver(s: NoteSession, opts: { cid: string; how: string; text: string;
    extra: Partial<ChatMsg>; completesTs: number; takenAt: number }): Promise<{ ok: boolean; why?: string }>;
  sessionOf(id: string): NoteSession | undefined;
  restoredChats(): Map<string, ChatMsg[]>;
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
   * same rule. */
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
  /* One POST of the stored clip: whole (offsetS 0) or the tail past offsetS. */
  const post = async (offsetS: number): Promise<{ text: string; dropped: string[] }> => {
    const t0 = performance.now();
    const bound = timeoutSignal(RESCUE_STT_TIMEOUT_MS);
    try {
      const base = await d.voiceUrl();
      const url = offsetS > 0 ? `${base}/stt?offset=${encodeURIComponent(offsetS)}` : `${base}/stt`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": clip.mime },
        body: clip.bytes as unknown as ArrayBuffer,
        signal: bound.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const text = typeof json?.text === "string" ? json.text.trim() : "";
      const dropped = Array.isArray(json?.dropped) ? json.dropped.filter((x: unknown) => typeof x === "string") : [];
      const timing = json?.timing ?? {};
      recordVoiceOp({
        op: "stt", cid, chars: text.length,
        queueWaitMs: Number.isFinite(timing.queueMs) ? timing.queueMs : undefined,
        upstreamMs: Number.isFinite(timing.decodeMs) ? timing.decodeMs : undefined,
        audioS: Number.isFinite(timing.audioS) ? timing.audioS : undefined,
        rtf: Number.isFinite(timing.rtf) ? timing.rtf : undefined,
        engineMs: Math.round(performance.now() - t0),
        outcome: "ok",
      });
      return { text, dropped };
    } catch (e) {
      recordVoiceOp({
        op: "stt", cid,
        engineMs: Math.round(performance.now() - t0),
        outcome: isTimeoutAbort(e) ? "timeout" : "error", err: String(e),
      });
      throw e;
    } finally {
      bound.done();
    }
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
  const msg: ChatMsg = { id: s.id, role: "user", text: "", ts, cid: d.cid,
    ...d.extra, transcriptPending: true };
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
  const text = words || "(voice note: transcription failed)";
  if (!words) {
    dd.log("rescue.failed-late", { cid: d.cid, session: s.id, msgId: d.msgId, ts,
      why: "the pending note's decode returned nothing; completing it with the placeholder" });
  }
  await dd.inOrder(s.id, async () => {
    const res = await dd.deliver(s, { cid: d.cid, how: d.how, text,
      extra: d.extra, completesTs: ts, takenAt: d.takenAt });
    if (res.ok) {
      dd.log("rescue.completed", { cid: d.cid, session: s.id, msgId: d.msgId, ts, chars: text.length });
    } else {
      dd.log("rescue.complete-undelivered", { cid: d.cid, session: s.id, msgId: d.msgId, ts,
        why: res.why ?? "the session did not take the completed note; the audio and pending " +
          "bubble stand and a restart re-drives it" });
    }
  });
}

/* Notes shown with a transcript still pending when the engine went down: the
 * row persisted, the audio was always on disk; what did not survive is the
 * in-flight decode. Re-drive it at the boot delay, once the mux has reported,
 * so the session exists to deliver to. */
export async function sweepPendingTranscripts(): Promise<void> {
  const dd = D();
  let redriven = 0;
  for (const [id, msgs] of dd.restoredChats()) {
    const s = dd.sessionOf(id);
    if (!s) continue;
    for (const m of msgs) {
      if (m.role !== "user" || !m.transcriptPending || m.kind !== "voice" || typeof m.msgId !== "string") continue;
      const cid = m.cid || newCid("m");
      dd.log("rescue.redrive", { cid, session: id, msgId: m.msgId, ts: m.ts,
        why: "a long note was shown with its transcript pending and the engine restarted before the decode landed" });
      const extra: Partial<ChatMsg> = { kind: "voice", msgId: m.msgId,
        ...(Number.isFinite(m.durationS) ? { durationS: m.durationS } : {}) };
      void completePendingVoiceNote(s, m.ts, { cid, how: "VOICE", extra, msgId: m.msgId, takenAt: m.ts },
        transcribeStored(m.msgId, cid));
      redriven++;
    }
  }
  if (redriven) console.log(`[rescue] re-drove ${redriven} pending transcript(s) after restart`);
}

/** POST the clip (whole, or the tail past `offsetS`) to the voice engine. */
export async function sttDecode(u: UploadRec, offsetS: number, cid?: string):
  Promise<{ text: string; dropped: string[]; mode?: "salvaged" | "broken" }> {
  const base = await D().voiceUrl();
  const url = offsetS > 0 ? `${base}/stt?offset=${encodeURIComponent(offsetS)}` : `${base}/stt`;
  const t0 = performance.now();
  const bound = timeoutSignal(WORDS_STT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": u.mime || "audio/webm" },
      body: (await Bun.file(u.path).arrayBuffer()) as unknown as ArrayBuffer,
      signal: bound.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const text = typeof json?.text === "string" ? json.text.trim() : "";
    const dropped = Array.isArray(json?.dropped) ? json.dropped.filter((x: unknown) => typeof x === "string") : [];
    /* The voice engine re-muxed a broken container (task 594): visible in the
     * voice log rather than shipping as a silent chars=0. */
    const mode = json?.mode === "salvaged" || json?.mode === "broken" ? json.mode : undefined;
    const timing = json?.timing ?? {};
    recordVoiceOp({
      op: "stt", cid, chars: text.length,
      queueWaitMs: Number.isFinite(timing.queueMs) ? timing.queueMs : undefined,
      upstreamMs: Number.isFinite(timing.decodeMs) ? timing.decodeMs : undefined,
      audioS: Number.isFinite(timing.audioS) ? timing.audioS : undefined,
      rtf: Number.isFinite(timing.rtf) ? timing.rtf : undefined,
      mode,
      engineMs: Math.round(performance.now() - t0),
      outcome: "ok",
    });
    return { text, dropped, mode };
  } catch (e) {
    recordVoiceOp({
      op: "stt", cid,
      engineMs: Math.round(performance.now() - t0),
      outcome: isTimeoutAbort(e) ? "timeout" : "error", err: String(e),
    });
    throw e;
  } finally {
    bound.done();
  }
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
