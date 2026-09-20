/* ROUTES: the /voice/* proxy forwards and the voice selection routes (L4 interface; blueprint 4b row 29).
 * Extracted verbatim from server.ts routeRequest; each handler answers a
 * Response or null (not mine). The auth gates stay per-route
 * (requireOwner/requireLocal), exactly as the if-chain had them. */

import type { RoutesCtx } from "./ctx.ts";
import { JSON_BODY_MAX_BYTES, UPLOAD_BODY_MAX_BYTES, declaredBodyTooLarge, readJsonCapped, readTextCapped } from "../storage/body-limits.ts";
import { json, requireOwner } from "../transport/httpx.ts";
import { globalVoice, sessions, setDefaultVoice, setVoiceOverride } from "../sessions/session-state.ts";
import { RESCUE_STT_TIMEOUT_MS, isTimeoutAbort } from "../voice/transcribe.ts";
import { voiceProxyTimeouts, voiceUrl } from "../voice/voice-proxy.ts";
import { recentVoiceLog } from "../voice/voicelog.ts";

const USER_AUDIO_MAX = UPLOAD_BODY_MAX_BYTES; // voice-note upload cap (300MB, his call 2026-08-09)

/* The /voice/stt backstop, read PER REQUEST rather than once at import.
 *
 * It is the same RESCUE_STT_TIMEOUT_MS override transcribe.ts's own rescue
 * decode honours, and the same number in every deployment: transcribe.ts reads
 * the environment at module load, so with the variable set the const already
 * equals it and this returns the same value. What the per-call read buys is a
 * seam test being able to prove "a silent upstream ends in a 504, not a hang"
 * in a few hundred milliseconds. A module-load const cannot be overridden by a
 * test at all: import evaluation happens before the file's first statement, and
 * this suite does not spawn an engine to carry an environment in. */
const sttTimeoutMs = (): number => {
  const n = Number(process.env.RESCUE_STT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : RESCUE_STT_TIMEOUT_MS;
};

export async function voiceRoutes(ctx: RoutesCtx, req: Request, url: URL, path: string,
  server: import("bun").Server): Promise<Response | null> {

  if (path === "/voice/stt" && req.method === "POST") {
    // User speech is CONTENT: the sealed tunnel and the engine host only
    // (sealed-transport enforcement). Gate before the readiness 503 so a
    // refused peer learns nothing about this host's model state.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    /* THE MODEL IS STILL DOWNLOADING (first install): a clear 503 with the
     * reason, instead of proxying into a whisper that cannot exist yet and
     * answering an opaque 502. Only the model-missing case is refused here;
     * a service that is merely down keeps its old error through the proxy. */
    const notReady = ctx.voiceGate?.("stt") ?? null;
    if (notReady !== null) return json({ error: notReady }, 503);
    // The clip is streamed through, not buffered, but a declared length over
    // the voice-note cap is refused before any byte reaches the voice engine.
    const over = declaredBodyTooLarge(req, USER_AUDIO_MAX);
    if (over) return over;
    try {
      const base = await voiceUrl();
      /* `duplex` is required by every runtime that accepts a STREAM as a request
       * body (undici, and bun here), and is absent from the DOM lib's
       * RequestInit, so as an inline literal it read as an unknown property.
       * Named as what it is -- a RequestInit plus the one field the lib has not
       * caught up with -- rather than cast away. */
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: { "content-type": req.headers.get("content-type") ?? "application/octet-stream" },
        body: req.body ?? undefined, // streamed through, not buffered here
        duplex: "half",
        signal: AbortSignal.timeout(sttTimeoutMs()),
      };
      const res = await fetch(`${base}/stt${url.search}`, init);
      return res;
    } catch (e) {
      return json({ error: String(e) }, isTimeoutAbort(e) ? 504 : 502);
    }
  }

  if (path === "/voice/tts" && req.method === "POST") {
    // Reply text in, spoken audio out: content, same gate as /voice/stt.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    // Same readiness gate as /voice/stt: kokoro's model is still downloading -> a clear 503.
    const notReady = ctx.voiceGate?.("tts") ?? null;
    if (notReady !== null) return json({ error: notReady }, 503);
    // tts json is a control-sized body: capped before it buffers, 413 over.
    const got = await readTextCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    let body: unknown;
    try {
      body = got.value.trim() ? JSON.parse(got.value) : null;
    } catch {
      body = null;
    }
    if (body == null) return json({ error: "expected json" }, 400);
    try {
      const base = await voiceUrl();
      const res = await fetch(`${base}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(voiceProxyTimeouts.tts),
      });
      return res; // audio streamed back through
    } catch (e) {
      return json({ error: String(e) }, isTimeoutAbort(e) ? 504 : 502);
    }
  }

  if (path === "/voice/voices" && req.method === "GET") {
    // The voice list names what this host runs: the tunnel and the host only.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    try {
      const base = await voiceUrl();
      const res = await fetch(`${base}/voices`, { signal: AbortSignal.timeout(voiceProxyTimeouts.list) });
      return res;
    } catch (e) {
      return json({ voices: [], current: "", error: String(e) }, 502);
    }
  }


  /* The last N voice ops (tts + stt), newest last, the same records the
   * `[voice]` log lines carry (#575). So "the TTS felt slow just now" can be
   * answered from a phone against this route rather than journalctl on the host.
   * Read-only and cheap: it serves an in-memory ring, no work per request. */
  if (req.method === "GET" && path === "/voice-log") {
    // Voice op records carry session ids and host telemetry (load1, freeRamMb,
    // gpuUtil, gpuMemMb): the tunnel and the host only (leak-audit), so a
    // remote tailnet peer cannot read this host's telemetry.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    return json({ records: recentVoiceLog() });
  }


  /* This host's default voice, the one the Persona plugin's `set-default` op
   * writes (#584). Kept as a route too for an engine run WITHOUT our app;
   * same state either way. */
  if (req.method === "POST" && path === "/voices/default") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const body = got.value as { voice?: unknown };
    setDefaultVoice(typeof body.voice === "string" ? body.voice.trim() : "");
    return json({ ok: true, default: globalVoice() });
  }


  /* ...and the override for one of them. Empty clears it. */
  if (req.method === "POST" && path.startsWith("/session/") && path.endsWith("/voice")) {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const id = decodeURIComponent(path.slice("/session/".length, -"/voice".length));
    if (!sessions.has(id)) return json({ ok: false, error: "no such session" }, 404);
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const body = got.value as { voice?: unknown };
    const v = typeof body.voice === "string" ? body.voice.trim() : "";
    setVoiceOverride(id, v);
        return json({ ok: true, voice: v });
  }

  return null;
}
