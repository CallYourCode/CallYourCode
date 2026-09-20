/* SPOKEN REPLIES (L3 feature): TTS synthesis, the streaming clip growth
 * (#525) and its close-out.
 *
 * The first chunk lands before the reply's say frame ships; the rest appends
 * to the same mp3 while the app already plays. Generation runs to completion
 * no matter what any client does; a failure closes the clip out to a valid
 * playable partial. Wired at boot (initTts) over the voice pick, the voice
 * override lookup, the patch persistence and the broadcast; the clip store is
 * clips.ts.
 *
 *   bun test agent-engine/src/tts.test.ts
 */

import { appendPrivate, mkdirPrivate, writePrivate } from "../../../shared/runfiles.ts";
import { recordVoiceOp } from "./voicelog.ts";
import { audioDirFor, audioPath, audioDurationS, cacheAudio, growing } from "../chat/clips.ts";
import { realClock, type Clock } from "../runtime/clock.ts";
import type { ChatMsg } from "../chat/chatmsg.ts";

/* How long a show/page origin is remembered on a session, so a spoken reply
 * can say which page asked the question it answers. */
export const ORIGIN_TTL_MS = 15 * 60 * 1000;

/** The slice of a Session this module reads (structural; no cycle). */
export type TtsSession = {
  id: string;
  lastOrigin?: { id: string; ts: number };
};

export type TtsDeps = {
  /** the healthy voice engine base url right now */
  voiceUrl(): Promise<string>;
  /** the session's chosen voice, or undefined for the host default */
  voiceFor(sessionId: string): string | undefined;
  persistPatch(sessionId: string, mts: number, set: Partial<ChatMsg> | undefined, unset: string[]): void;
  broadcast(msg: unknown): void;
  restoredChats(): Map<string, ChatMsg[]>;
  /* Stream this spoken reply down any live call's media track as it is
   * synthesised (voicectl.ts speakToCalls), alongside the clip growth. Optional
   * on purpose: a wiring without call-mode voice has no live path and the clip
   * stands alone, which is also the fallback when no call is up. */
  streamSay?(s: TtsSession, msgId: string, chunks: string[]): void;
  /* The one wall-clock read in this module: whether the page a reply answers
   * is still recent enough to name on the say frame (ORIGIN_TTL_MS, fifteen
   * minutes). Defaults to the real clock, so production is unchanged; a test
   * advances past the SHIPPED fifteen minutes instead of waiting them out. */
  clock?: Clock;
};

let deps: TtsDeps | null = null;
export function initTts(d: TtsDeps): void {
  deps = d;
}
const D = (): TtsDeps => {
  if (!deps) throw new Error("tts not initialised");
  return deps;
};

/** TEST ONLY: forget the deps, so a second in-process wiring cannot broadcast
 *  a say frame down the previous wiring's seams. The clip state this module
 *  writes lives in clips.ts and on disk, not here. No-op in production, which
 *  never re-wires. */
export function resetForTest(): void {
  deps = null;
}

/* Synthesise ONE chunk of text to mp3 bytes, or null if the voice engine
 * could not do it. Raw mp3 frames: concatenating several yields a longer
 * valid mp3, which is the whole reason streaming can append to one file. */
export async function ttsChunk(s: TtsSession, text: string): Promise<Uint8Array | null> {
  // a session can sound like itself: its own voice if one was chosen for it,
  // otherwise this host's default
  return ttsWithVoice(text, D().voiceFor(s.id), s.id);
}

/** A voice-engine response header parsed to a number, or undefined when
 *  absent or unparseable (the headers are advisory timings, #575). */
function headerNum(res: Response, name: string): number | undefined {
  const v = res.headers.get(name);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/* Synthesise one chunk of text in an EXPLICIT voice, the one tts POST site so
 * a spoken reply and a voice sample render the same way. null when the voice
 * engine could not: the caller still delivers the words. */
export async function ttsWithVoice(text: string, voice: string | undefined, session?: string): Promise<Uint8Array | null> {
  // The wait to pick a voice engine (a health probe when several are listed)
  // is part of "why was tts slow", so the upstream clock starts AFTER it and
  // the gap before it is the queue wait (#575).
  const t0 = performance.now();
  try {
    const base = await D().voiceUrl();
    const upStart = performance.now();
    const res = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) throw new Error(`voice engine tts ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    recordVoiceOp({
      op: "tts", session, voice: voice || undefined, chars: text.length,
      queueWaitMs: Math.round(upStart - t0),
      upstreamTtfbMs: headerNum(res, "x-voice-ttfb-ms"),
      upstreamMs: headerNum(res, "x-voice-synth-ms"),
      audioS: headerNum(res, "x-voice-audio-s"),
      rtf: headerNum(res, "x-voice-rtf"),
      engineMs: Math.round(performance.now() - t0),
      outcome: "ok",
    });
    return bytes;
  } catch (e) {
    recordVoiceOp({
      op: "tts", session, voice: voice || undefined, chars: text.length,
      engineMs: Math.round(performance.now() - t0),
      outcome: "error", err: String(e),
    });
    // Still deliver the words. A page that can read the reply beats silence.
    console.error("[speak] tts failed:", e);
    return null;
  }
}

/* Render the FIRST chunk of a spoken reply and put it on disk, fresh. Returns
 * the clip's length in whole seconds (0 if it could not be measured), or -1
 * if there is no clip at all. -1 means "no clip", so the reply ships as
 * written words: the user loses the speech, the smaller half, but never a
 * play button over nothing. */
export async function synthesizeFirst(s: TtsSession, msgId: string, text: string): Promise<number> {
  const bytes = await ttsChunk(s, text);
  if (!bytes) return -1;
  try {
    // Fresh file: overwrite any stale clip at this id, then growClip appends.
    // Written straight to disk (not via cacheAudio) so the hot cache is not
    // warmed with a PARTIAL clip -- it holds the whole thing only once done.
    await mkdirPrivate(audioDirFor(msgId));
    await writePrivate(audioPath(msgId, "audio/mpeg"), bytes as unknown as ArrayBuffer);
  } catch (e) {
    console.error("[audio] persist failed:", e);
    return -1;
  }
  return await audioDurationS(audioPath(msgId, "audio/mpeg"));
}

/* BACKGROUND SPEECH (#speak-latency): the first chunk is synthesised AFTER
 * the tool has been acked, then the clip is announced and grown exactly as
 * #525 did. Failure degrades like a failed growClip: the row is closed out
 * (never stuck growing), and a first chunk that could not be made leaves the
 * reply as written words with no clip advertised on the persisted row. */
export async function speakClip(s: TtsSession, msg: ChatMsg, chunks: string[], msgId: string): Promise<void> {
  const d = D();
  /* AGENT->YOU LIVE SPEECH: hand the same chunks to the call-mode downlink
   * BEFORE the first clip synthesis, so a live call hears the reply as it is
   * rendered rather than as this batch clip. Independent of the clip: a failed
   * stream leaves the clip (the fallback) exactly as it always was. */
  d.streamSay?.(s, msgId, chunks);
  const first = await synthesizeFirst(s, msgId, chunks[0]);
  if (first < 0) {
    /* No clip at all. Clear the growing flag and un-claim the msgId on the
     * persisted row, and re-broadcast the written form; chat.json never
     * advertises a clip this engine does not hold. */
    growing.delete(msgId);
    delete msg.growing;
    msg.msgId = undefined;
    d.persistPatch(s.id, msg.ts, undefined, ["growing", "msgId"]);
    d.broadcast({ t: "chat", ...msg });
    return;
  }
  const spokenDurationS = Math.max(0, first);
  const multi = chunks.length > 1;
  const origin = s.lastOrigin && (d.clock ?? realClock).now() - s.lastOrigin.ts < ORIGIN_TTL_MS ?
    s.lastOrigin.id : undefined;
  d.broadcast({ t: "say", id: s.id, msgId, text: msg.text, ...(multi ? { growing: true } : {}), ...(origin ? { origin } : {}) });
  if (multi) {
    /* The first growth beat (#543): the first chunk is on disk with a
     * measured length, so tell the devices its duration-so-far and how many
     * characters it covers the instant the say goes out. */
    d.broadcast({ t: "say-grow", id: s.id, msgId, durS: spokenDurationS, chars: chunks[0].length });
    void growClip(s, msg, chunks.slice(1), chunks[0].length);
    return;
  }
  /* A single-chunk reply was written in one shot, so it is not growing. It
   * closes out exactly like a grown clip. */
  void finalizeClip(s, msg);
}

/* GENERATION RUNS TO COMPLETION NO MATTER WHAT ANY CLIENT DOES (#525). A
 * failure on one chunk stops the loop but still finalises what did land, so
 * the clip is always closed out to a valid playable partial. */
export async function growClip(s: TtsSession, msg: ChatMsg, rest: string[], chars0: number): Promise<void> {
  const d = D();
  const msgId = msg.msgId!;
  let chars = chars0; // characters voiced so far, starting from the first chunk
  try {
    for (const chunk of rest) {
      const bytes = await ttsChunk(s, chunk);
      if (!bytes) break; // voice engine went away: close out what we have
      await appendPrivate(audioPath(msgId, "audio/mpeg"), bytes);
      /* Tell the devices this clip just grew (#543). A chars count that
       * slightly trails the transcript only ever UNDER-lights, which is the
       * safe direction. */
      chars += chunk.length;
      const durS = await audioDurationS(audioPath(msgId, "audio/mpeg"));
      d.broadcast({ t: "say-grow", id: s.id, msgId, ...(durS ? { durS } : {}), chars });
    }
  } catch (e) {
    console.error("[stream] grow failed:", e);
  } finally {
    await finalizeClip(s, msg);
  }
}

/* Mark a growing clip done: measure the final duration, warm the hot cache
 * with the whole file, clear the growing flag, and re-broadcast the SAME
 * message (same ts/seq) so the bubble becomes an ordinary finished voice
 * note. Idempotent. */
export async function finalizeClip(s: TtsSession, msg: ChatMsg): Promise<void> {
  const d = D();
  const msgId = msg.msgId;
  if (!msgId) return;
  growing.delete(msgId);
  const path = audioPath(msgId, "audio/mpeg");
  const dur = await audioDurationS(path);
  try {
    const f = Bun.file(path);
    if (await f.exists()) await cacheAudio(msgId, new Uint8Array(await f.arrayBuffer()));
  } catch (e) {
    console.error("[stream] finalize cache failed:", e);
  }
  if (msg.growing) delete msg.growing;
  if (dur) msg.durationS = dur;
  d.persistPatch(s.id, msg.ts, dur ? { durationS: dur } : undefined, ["growing"]);
  d.broadcast({ t: "chat", ...msg });
  d.broadcast({ t: "say-done", id: s.id, msgId, ...(dur ? { durationS: dur } : {}) });
}

/* On boot, close out any clip a restart caught mid-growth (#525). The partial
 * mp3 on disk is already a valid playable file. Operates on restoredChats
 * directly (the live sessions inherit these same arrays). */
export async function sweepGrowingClips(): Promise<void> {
  const d = D();
  let swept = 0;
  for (const [id, msgs] of d.restoredChats()) {
    for (const m of msgs) {
      if (!m.growing) continue;
      delete m.growing;
      swept++;
      let dur = 0;
      if (m.msgId) {
        dur = await audioDurationS(audioPath(m.msgId, "audio/mpeg"));
        if (dur) m.durationS = dur; // else keep whatever partial length shipped
      }
      d.persistPatch(id, m.ts, dur ? { durationS: dur } : undefined, ["growing"]);
    }
  }
  if (swept) {
    console.log(`[stream] swept ${swept} stranded growing clip(s) to done`);
  }
}
