/* THE SEALED-DC CONTROL FOR CALL-MODE VOICE.
 *
 * The media track carries audio only; every text control rides the sealed
 * DataChannel as ordinary client frames dispatched here:
 *
 *   {t:"fp", local, remote}   the app's view of the DTLS fingerprints, its
 *                             half of the binding. It is checked against what
 *                             THIS engine saw (fpRemote = the app over DTLS,
 *                             fpLocal = the engine's own answer SDP). A match
 *                             opens the audio gate; a mismatch closes the client
 *                             (a coturn box re-terminated DTLS -> MITM).
 *   {t:"voice-ctl", op}       start | stop a streaming transcription, or speak a
 *                             call-mode TTS reply down the track.
 *
 * partial/final transcripts come back UP the sealed channel (AudioBridge.seal),
 * never over the media track.
 *
 * AGENT->YOU LIVE SPEECH (speakToCalls). The downlink used to have no
 * engine-side sender: op "speak" is a CLIENT frame the app never sends, so an
 * agent's spoken reply reached the phone only as the batch say clip. Now a
 * spoken reply streams down the media track of every fp-gated call client
 * attached to its session, chunk by chunk as the TTS is synthesised:
 *
 *   {t:"say-live", id, msgId}       sealed to the call clients BEFORE their say
 *                                   frame can arrive (same ordered channel), so
 *                                   the app suppresses the clip's auto-play and
 *                                   lets the track carry the live speech.
 *   {t:"say-live-fail", id, msgId}  the stream never started (no PCM from the
 *                                   voice engine): auto-play the clip after
 *                                   all. The say-clip path always runs and
 *                                   remains the history record + the FALLBACK
 *                                   for every client not in a call.
 */

import { ttsPcmFromVoiceEngine } from "./voice-media.ts";
import { clients, send } from "../transport/wire.ts";
import type { Sock } from "../transport/sock.ts";

export type VoiceCtlDeps = {
  log: (event: string, fields: Record<string, unknown>) => void;
  /** injectable TTS-PCM source, so a seam test points it at a fake without an
   *  env dance; defaults to the real voice engine. */
  ttsPcm?: (text: string, voice?: string) => Promise<{ pcm: Int16Array; rate: number } | null>;
};

let deps: VoiceCtlDeps = { log: () => {} };
export function initVoiceCtl(d: VoiceCtlDeps): void { deps = d; }

/** The app's fingerprint view. Compare against what the engine saw over DTLS and
 *  in its own answer SDP; on a match, the media is bound to the sealed channel
 *  and the audio gate opens. On a mismatch, close: the media transport is not
 *  the one that was authenticated. */
export function onVoiceFp(ws: Sock, m: any): void {
  const audio = ws.data.audio;
  if (!audio) return; // no media track to gate
  const appLocal = typeof m.local === "string" ? m.local.toUpperCase() : null;
  const appRemote = typeof m.remote === "string" ? m.remote.toUpperCase() : null;
  const okLocal = appLocal !== null && appLocal === ws.data.fpRemote;
  const okRemote = appRemote !== null && appRemote === ws.data.fpLocal;
  if (okLocal && okRemote) {
    audio.openGate();
    deps.log("voice.fp-verified", { client: `c${ws.data.cid}` });
    return;
  }
  deps.log("voice.fp-mismatch", {
    client: `c${ws.data.cid}`,
    appLocal, appRemote, sawRemote: ws.data.fpRemote, ownLocal: ws.data.fpLocal,
  });
  try { ws.close(4462, "fp-mismatch"); } catch {}
}

/** The fp-gated call clients attached to this session: the devices whose media
 *  track may carry its live speech. */
function callTargets(sessionId: string): Sock[] {
  const out: Sock[] = [];
  for (const c of clients) {
    if (c.data.audio && !c.data.audio.muted && c.data.attached === sessionId) out.push(c);
  }
  return out;
}

/** Stream an agent's spoken reply down the live call(s) on its session, chunk
 *  by chunk as the TTS PCM is synthesised (the same chunks tts.ts renders the
 *  clip from). With no gated call attached this does NOTHING: the say clip is
 *  the whole delivery, exactly as before. Un-awaited by its caller; a chunk the
 *  voice engine cannot render stops the stream, never the clip. */
export async function speakToCalls(sessionId: string, msgId: string, chunks: string[], voice?: string): Promise<void> {
  const targets = callTargets(sessionId);
  if (targets.length === 0) return; // no live call: the clip path stands alone
  /* Announced BEFORE any synthesis: sealed per-client frames and the later say
   * broadcast ride the same ordered channel, so say-live always precedes the
   * say it suppresses. */
  for (const c of targets) send(c, { t: "say-live", id: sessionId, msgId });
  deps.log("voice.say-live", { session: sessionId, msgId, targets: targets.length, chunks: chunks.length });
  const src = deps.ttsPcm ?? ((text: string, v?: string) => ttsPcmFromVoiceEngine(text, { voice: v }));
  for (let i = 0; i < chunks.length; i++) {
    const got = await src(chunks[i], voice);
    if (!got) {
      /* The FIRST chunk failing means no live speech at all: tell the clients
       * to fall back to the clip they were told to suppress. A LATER chunk
       * failing leaves the reply half-heard live; re-playing the whole clip on
       * top would repeat the start, so the bubble's clip is simply there for a
       * manual replay. */
      if (i === 0) {
        for (const c of targets) { if (clients.has(c)) send(c, { t: "say-live-fail", id: sessionId, msgId }); }
      }
      deps.log("voice.say-live-fail", { session: sessionId, msgId, chunk: i });
      return;
    }
    for (const c of targets) {
      // a client may have hung up mid-reply; the survivors keep their stream
      if (clients.has(c) && c.data.audio && !c.data.audio.muted) c.data.audio.speakPcm(got.pcm, got.rate);
    }
  }
}

export async function onVoiceCtl(ws: Sock, m: any): Promise<void> {
  const audio = ws.data.audio;
  if (!audio) return;
  const op = String(m.op ?? "");
  if (op === "start") {
    await audio.startStt(String(m.session ?? ""));
    deps.log("voice.stt-start", { client: `c${ws.data.cid}`, session: String(m.session ?? "") });
  } else if (op === "stop") {
    audio.stopStt();
    deps.log("voice.stt-stop", { client: `c${ws.data.cid}` });
  } else if (op === "speak") {
    const src = deps.ttsPcm ?? ((text: string, voice?: string) => ttsPcmFromVoiceEngine(text, { voice }));
    const got = await src(String(m.text ?? ""), typeof m.voice === "string" ? m.voice : undefined);
    if (got) {
      audio.speakPcm(got.pcm, got.rate);
      deps.log("voice.speak", { client: `c${ws.data.cid}`, samples: got.pcm.length, rate: got.rate });
    }
  }
}
