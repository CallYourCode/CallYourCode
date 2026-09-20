/* THE VOICE PROXY (L3 feature): the voice-engine pick, the /voice/* HTTP
 * forwarding, and the sealed STT bridge (the mic stream as sealed DC frames).
 *
 * The engine's OWN origin carries the voice contract (/voice/*), forwarding
 * to the configured voice engine (VOICE_URL). The app stops needing a second
 * host: it dials this engine and this engine relays to whichever host speaks.
 * VOICE_URL may list several engines, preferred first (comma separated);
 * health decides, not assumption.
 *
 *   bun test agent-engine/src/voice/voice-stt-bridge.test.ts agent-engine/src/voice/voice-through.test.ts
 */

import { send } from "../transport/wire.ts";
import { b64decode } from "../../../shared/e2e.ts";
import type { Sock } from "../transport/sock.ts";

export const VOICE_URLS = (process.env.VOICE_URL ?? "http://127.0.0.1:10102")
  .split(",").map((u) => u.trim().replace(/\/$/, "")).filter(Boolean);
let voicePick = VOICE_URLS[0];
let voicePickedAt = 0;
const VOICE_RECHECK_MS = 30_000;

export async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// The healthy engine to use right now. Sticky for RECHECK_MS so a burst of
// speech does not re-probe per request, and it re-prefers the first entry as
// soon as it comes back.
export async function voiceUrl(): Promise<string> {
  if (VOICE_URLS.length === 1) return VOICE_URLS[0];
  if (Date.now() - voicePickedAt < VOICE_RECHECK_MS) return voicePick;
  for (const url of VOICE_URLS) {
    if (await probe(url)) {
      if (url !== voicePick) console.log(`[voice] using ${url}`);
      voicePick = url;
      voicePickedAt = Date.now();
      return url;
    }
  }
  voicePickedAt = Date.now(); // all down: keep the preferred one and let it error
  return VOICE_URLS[0];
}

// ---------------------------------------------------------------- voice proxy
// The engine's OWN origin now carries the voice contract (/voice/*), forwarding
// to the configured voice engine (VOICE_URL). The app stops needing a second
// host: it dials this engine and this engine relays to whichever host speaks.
//
// /voice/stt, /voice/tts and /voice/voices forward over HTTP with the same
// request/response shapes the voice engine already serves; the mic STREAM rides
// the sealed DataChannel as stt-* frames and the bridge below. A down voice
// engine fails at connect (immediate), so these timeouts are backstops for a
// connected-but-silent upstream, never the working deadline.

// /voice/voices is a quick list; /voice/tts may stream a long reply chunk by
// chunk. /voice/stt reuses RESCUE_STT_TIMEOUT_MS, the same backstop the engine's
// own rescue decode carries, because a real long note decodes for minutes.
//
// Each one takes an env override, the same way RESCUE_STT_TIMEOUT_MS (the
// fourth backstop, transcribe.ts) already does. Nothing in the product sets
// them, so the shipped numbers are the three defaults below, byte for byte.
// They exist because "a reachable engine that never answers is bounded, and the
// bound is THIS one" cannot be proven at ten and sixty seconds without a test
// file that runs for over a minute; with the override a spec proves the same
// fact in a few hundred milliseconds.
//
// READ PER CALL, not once at import: a value captured at module evaluation is
// captured before any test file's first statement runs, so a const here could
// only ever be overridden through the process environment of a spawned engine,
// which is exactly the boot this suite no longer does. A value that does not
// parse falls back to the default rather than to NaN, which
// AbortSignal.timeout would treat as 0 and fire immediately.
const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const voiceProxyTimeouts = {
  /** /voice/voices: a quick list, so a long wait is already a fault. */
  get list(): number { return envMs("VOICE_PROXY_LIST_TIMEOUT_MS", 10_000); },
  /** /voice/tts: a long reply is generated chunk by chunk, so this is minutes
   *  of speech, not a round trip. */
  get tts(): number { return envMs("VOICE_PROXY_TTS_TIMEOUT_MS", 60_000); },
  /** the stt bridge: how long the upstream stream socket has to become
   *  ready before the app is told the engine is not there. */
  get wsConnect(): number { return envMs("VOICE_PROXY_WS_CONNECT_TIMEOUT_MS", 5_000); },
};

/** The voice engine's ws base: VOICE_URL with the http(s) scheme swapped to
 *  ws(s), since the browser dials the same origin over websocket. */
export function voiceWsUrl(base: string): string {
  return base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

// ------------------------------------------------------- the sealed stt bridge
/* The app's mic stream rides the sealed DataChannel as
 * ordinary client frames (dispatched by frames.ts), and this bridge carries
 * each stream to the voice engine's /stt-stream over loopback -- the same
 * server-to-server pipe shape the old /voice/stt-stream WS relay had, minus the
 * browser-facing socket. That WS route is REMOVED, not demoted: a WS upgrade
 * can never carry the in-process sealed-tunnel mark, so it could never be
 * owner-gated. The engine-internal AudioBridge (call-mode media, voice-media.ts)
 * dials the voice engine itself and never passes through here.
 *
 * THE WIRE, exactly (the contract the app half implements):
 *
 *   app -> engine, sealed DC client frames:
 *     {t:"stt-open", id, rate, format}
 *         Open one streaming STT session. `id` is the app's name for the
 *         stream, any non-empty string, unique per connection while live.
 *         `rate` is the PCM sample rate in Hz, forwarded to the voice engine
 *         as {t:"start", sampleRate: rate} (the voice engine accepts 16000
 *         only and answers its own error otherwise). `format` is "f32"
 *         (mono little-endian float32 PCM); it may be omitted, and any other
 *         value is refused with stt-error before anything is dialed.
 *     {t:"stt-b", id, b}
 *         One PCM chunk for that session: `b` is base64 of the raw f32le
 *         bytes, forwarded as one binary frame, order preserved. Chunks that
 *         arrive while the upstream is still connecting are buffered (up to
 *         STT_BRIDGE_BUFFER_MAX) and flushed in order behind the start frame.
 *     {t:"stt-close", id}
 *         End of audio. Forwarded as {t:"stop"}; the voice engine finalizes
 *         and answers its final, which comes back as stt-final below.
 *
 *   engine -> app, sealed DC frames (transcripts ride BACK sealed too):
 *     {t:"stt-partial", id, text, committed, committedS?}
 *         A live transcript. Field-for-field the voice engine's own partial:
 *         `text` = the corrected words so far (committed + live draft tail),
 *         `committed` = how many chars of `text` the decoder has finalized,
 *         `committedS` = finalized audio reach in source seconds (ABSENT until
 *         the first commit, then > 0 and monotonic).
 *     {t:"stt-final", id, text, corrections, dropped}
 *         The stream's answer, TERMINAL. The voice engine's own final:
 *         `text` = the whole corrected transcript ("" when nothing was heard
 *         or a hallucination was refused), `corrections` = the vocabulary
 *         fixes applied (array), `dropped` = raw transcripts refused as
 *         unbacked hallucinations (string[], `text` is "" when non-empty).
 *     {t:"stt-error", id, error}
 *         TERMINAL failure: the voice engine is down/never became ready, the
 *         stream broke mid-flight, or the open was malformed. `error` is
 *         prose for the log/UI, never parsed.
 *
 *   Every opened id ends in EXACTLY ONE terminal frame (stt-final or
 *   stt-error), except when the client connection itself dies first --
 *   closeSttClient then tears the upstreams down with nobody left to tell. */

/** Pre-ready buffer cap, mirroring the voice engine's own STT_BUFFER_MAX
 *  (~30s of 16k f32 audio): a session whose upstream never opens must not
 *  hold unbounded PCM in memory. */
const STT_BRIDGE_BUFFER_MAX = 2 * 1024 * 1024;

type SttSession = {
  id: string;
  upstream: WebSocket | null;
  ready: boolean; // upstream open, start sent, buffer flushed
  buffered: (string | Uint8Array)[]; // pre-ready frames, in order (stop rides here too)
  bufferedBytes: number;
  done: boolean; // a terminal frame went down (or the client died); inert now
  connectTimer: ReturnType<typeof setTimeout> | null;
};

/* One session table per sealed client, dropped with the socket; the sockets'
 * own close path calls closeSttClient so the UPSTREAM sockets never wait for
 * the GC. Keyed by the app's stream id. */
const sttOf = new WeakMap<Sock, Map<string, SttSession>>();

function sttTeardown(ws: Sock, st: SttSession): void {
  st.done = true;
  if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; }
  st.buffered.length = 0;
  st.bufferedBytes = 0;
  sttOf.get(ws)?.delete(st.id);
  const up = st.upstream;
  st.upstream = null;
  if (up) {
    up.onopen = up.onmessage = up.onerror = up.onclose = null;
    // Close in any non-CLOSED state: a session torn down while the upstream is
    // still CONNECTING must abort the handshake, or the socket would finish
    // connecting into a bridge that has forgotten it and leak.
    if (up.readyState !== WebSocket.CLOSED) { try { up.close(); } catch {} }
  }
}

/** Seal the session's ONE terminal frame down and free everything. */
function sttEnd(ws: Sock, st: SttSession, frame: Record<string, unknown>): void {
  if (st.done) return;
  sttTeardown(ws, st);
  send(ws, frame);
}

function sttFail(ws: Sock, st: SttSession, error: string): void {
  sttEnd(ws, st, { t: "stt-error", id: st.id, error });
}

/** One frame toward the voice engine, buffered until the upstream is ready
 *  (the same way the voice engine's own stream buffers before SERVER_READY). */
function sttSend(ws: Sock, st: SttSession, frame: string | Uint8Array): void {
  const up = st.upstream;
  if (st.ready && up && up.readyState === WebSocket.OPEN) {
    try { up.send(frame); } catch {}
    return;
  }
  if (typeof frame !== "string") {
    st.bufferedBytes += frame.byteLength;
    if (st.bufferedBytes > STT_BRIDGE_BUFFER_MAX) {
      sttFail(ws, st, "audio buffered too long before the voice engine was ready");
      return;
    }
  }
  st.buffered.push(frame);
}

/** A frame FROM the voice engine's stream: partial/final/error JSON, re-tagged
 *  with the stream's id and sealed down. Binary is not part of the contract and
 *  is dropped; so is any frame kind the contract above does not name. */
function onSttUpstream(ws: Sock, st: SttSession, data: unknown): void {
  if (st.done || typeof data !== "string") return;
  let m: any;
  try { m = JSON.parse(data); } catch { return; }
  if (m.t === "partial") {
    // spread first: the voice engine's own fields ride verbatim (text,
    // committed, committedS, and whatever it grows next), the re-tag wins.
    send(ws, { ...m, t: "stt-partial", id: st.id });
  } else if (m.t === "final") {
    sttEnd(ws, st, { ...m, t: "stt-final", id: st.id });
  } else if (m.t === "error") {
    sttFail(ws, st, String(m.message ?? "voice engine stream error"));
  }
}

/** {t:"stt-open", id, rate, format}: open a streaming STT session, bridged to
 *  the voice engine's /stt-stream over loopback. */
export function onSttOpen(ws: Sock, m: any): void {
  // Sealed DC only, same guard as the tunnel: without a sec state machine there
  // is no proven device behind this frame. The channel is the auth.
  if (!ws.data.sec) return;
  const id = typeof m?.id === "string" ? m.id : "";
  if (!id) return;
  let map = sttOf.get(ws);
  if (!map) { map = new Map(); sttOf.set(ws, map); }
  if (map.has(id)) {
    // same rule as the voice engine's own duplicate start: ignored, so a
    // repeated frame cannot error an incumbent live stream out from under
    // the app. A fresh recording is a fresh id.
    console.log(`[stt-bridge] duplicate stt-open ${id} ignored`);
    return;
  }
  const st: SttSession = { id, upstream: null, ready: false, buffered: [],
    bufferedBytes: 0, done: false, connectTimer: null };
  map.set(id, st);
  const format = m.format === undefined ? "f32" : String(m.format);
  if (format !== "f32") {
    // refused HERE: bytes in any other shape would decode as noise, and the
    // voice engine has no format field to refuse them itself.
    sttFail(ws, st, `format must be f32 (got ${format})`);
    return;
  }
  // rate is forwarded, not judged: the voice engine owns that rule (16000 only)
  // and its refusal comes back as this stream's stt-error.
  const rate = Number(m.rate ?? 16000);
  void (async () => {
    const base = await voiceUrl();
    if (st.done) return; // torn down while the health pick ran
    let up: WebSocket;
    try {
      up = new WebSocket(`${voiceWsUrl(base)}/stt-stream`);
    } catch (e) {
      sttFail(ws, st, `voice engine unreachable: ${e}`);
      return;
    }
    st.upstream = up;
    up.binaryType = "arraybuffer";
    // Backstop only: a reachable engine whose stream never becomes ready.
    st.connectTimer = setTimeout(() => {
      if (!st.done && !st.ready) sttFail(ws, st, "voice engine stt-stream not ready");
    }, voiceProxyTimeouts.wsConnect);
    up.onopen = () => {
      if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; }
      st.ready = true;
      // the start frame FIRST, then the held audio, in arrival order: the
      // voice engine configures the decoder off start before it reads PCM.
      try { up.send(JSON.stringify({ t: "start", sampleRate: rate })); } catch {}
      for (const f of st.buffered) { try { up.send(f as string | Uint8Array); } catch {} }
      st.buffered.length = 0;
      st.bufferedBytes = 0;
    };
    up.onmessage = (ev) => onSttUpstream(ws, st, ev.data);
    up.onerror = () => { if (!st.ready) sttFail(ws, st, "voice engine stt-stream failed"); };
    up.onclose = () => {
      // The normal ending never reaches here: the final (or the voice engine's
      // own error) is terminal and tears this handler down first. A close with
      // no terminal frame sent is a broken stream, whatever its close code --
      // a clean 1000 without a final is still a transcript that never came.
      if (!st.done) sttFail(ws, st, "voice engine stream closed before the final");
    };
  })();
}

/** {t:"stt-b", id, b}: one base64 PCM chunk for a live session. */
export function onSttChunk(ws: Sock, m: any): void {
  if (!ws.data.sec) return;
  const st = sttOf.get(ws)?.get(typeof m?.id === "string" ? m.id : "");
  if (!st || st.done) return;
  if (typeof m.b !== "string" || m.b.length === 0) return; // an empty chunk carries nothing
  sttSend(ws, st, b64decode(m.b));
}

/** {t:"stt-close", id}: end of audio. The session stays live until the voice
 *  engine answers the final (stt-final) or fails (stt-error). */
export function onSttClose(ws: Sock, m: any): void {
  if (!ws.data.sec) return;
  const st = sttOf.get(ws)?.get(typeof m?.id === "string" ? m.id : "");
  if (!st || st.done) return;
  sttSend(ws, st, JSON.stringify({ t: "stop" }));
}

/** The client connection died: tear down every upstream it was streaming
 *  through, silently (there is nobody left to seal a terminal frame to).
 *  Called from closeClient (frames.ts), the one event guaranteed to arrive. */
export function closeSttClient(ws: Sock): void {
  const map = sttOf.get(ws);
  if (!map) return;
  for (const st of [...map.values()]) sttTeardown(ws, st);
}


/* The voices this host can speak in, from the voice engine. The one place that
 * asks, so the /voices route and the voice plugin's `list` op cannot report two
 * different sets. Throws on a voice engine that is down, which the /voices route
 * turns into a 502 and the plugin surfaces as "could not load voices". */
export async function listHostVoices(): Promise<string[]> {
  const res = await fetch(`${await voiceUrl()}/voices`, { signal: AbortSignal.timeout(6000) });
  const j = (await res.json()) as { voices?: string[] };
  return j.voices ?? [];
}
