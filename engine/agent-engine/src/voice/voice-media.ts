/* THE ENGINE-SIDE VOICE MEDIA BRIDGE.
 *
 * One AudioBridge per DataChannel client that offered an m=audio track. It owns
 * the reciprocated node-datachannel Track and bridges it to the voice engine's
 * /stt-stream, WITHOUT the voice engine changing: the voice engine stays a core
 * service that speaks 16kHz float32 PCM up and partial/final JSON down.
 *
 *   UPLINK   track RTP -> depacketize -> Opus decode (48k Int16)
 *            -> resample to 16k float32 -> /stt-stream WS.
 *            partial/final JSON from the stream is sealed back down the DC
 *            (call mode's text control rides the sealed channel, never the
 *            media track).
 *   DOWNLINK TTS PCM -> resample to 48k -> Opus encode 20ms frames
 *            -> RTP packetize -> track, paced in real time.
 *
 * THE FINGERPRINT GATE. The media track shares the DataChannel's DTLS
 * transport, but a coturn relay is an on-path box; to bind the (unauthenticated
 * to the app) media to the sealed, engine-signed DC, the two ends exchange DTLS
 * fingerprints INSIDE the sealed channel after sec-done and compare them against
 * what each saw over DTLS (remoteFingerprint) and signaled. Audio stays MUTED --
 * incoming RTP dropped, outgoing refused -- until openGate() is called on fp-ok.
 */

import { rtpDepacketize, rtpPacketize, newRtpSender, type RtpSender } from "./rtp.ts";
import { OpusDecoder, OpusEncoder, OPUS_FRAME_SAMPLES, frame48k } from "./opus.ts";
import { pcm48kToStt, ttsPcmTo48k } from "./audiopcm.ts";
import { voiceUrl, voiceProxyTimeouts, voiceWsUrl } from "./voice-proxy.ts";

/** The Opus payload type the offer advertises and the answer echoes. */
export const OPUS_PAYLOAD_TYPE = 111;
/** 20ms per Opus frame; the downlink paces to it. */
const FRAME_MS = 20;

export type AudioBridgeDeps = {
  /** seal one control frame (partial/final/…) down the sealed DataChannel. */
  seal: (frame: unknown) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** the voice engine ws base picker; the real one probes health. Injected so a
   *  seam test can point it at a fake without an env dance. */
  voiceWsBase?: () => Promise<string>;
};

type SttState = {
  ws: WebSocket;
  ready: boolean;
  buffered: (string | Uint8Array)[];
  session: string;
};

export class AudioBridge {
  private decoder = new OpusDecoder();
  private encoder: OpusEncoder | null = null;
  private sender: RtpSender = newRtpSender(0x1234abcd, OPUS_PAYLOAD_TYPE);
  private gateOpen = false;
  private stt: SttState | null = null;
  private downlinkTimer: ReturnType<typeof setInterval> | null = null;
  private downlinkQueue: Uint8Array[] = []; // paced RTP packets awaiting send
  private closed = false;

  constructor(private track: any, private deps: AudioBridgeDeps) {
    track.onMessage((msg: Buffer) => this.onRtp(msg));
    track.onClosed?.(() => this.stopStt());
  }

  /** fp-ok: the DTLS fingerprints matched, so the media is bound to the sealed
   *  channel. Audio may now flow. Idempotent. */
  openGate(): void {
    if (this.gateOpen) return;
    this.gateOpen = true;
    this.deps.log("voice.fp-ok", {});
  }

  get muted(): boolean { return !this.gateOpen; }

  // ------------------------------------------------------------------ uplink

  private onRtp(msg: Buffer): void {
    if (this.closed || !this.gateOpen || !this.stt) return; // muted / no session
    const parsed = rtpDepacketize(msg);
    if (!parsed || parsed.payloadType !== OPUS_PAYLOAD_TYPE) return;
    if (parsed.payload.length === 0) return;
    let pcm48: Int16Array;
    try {
      pcm48 = this.decoder.decodePacket(parsed.payload);
    } catch {
      return; // a corrupt frame is dropped, not fatal to the stream
    }
    const f32 = pcm48kToStt(pcm48); // 16kHz mono float32, the /stt-stream shape
    this.sttSend(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength));
  }

  /** Begin a streaming transcription: open the /stt-stream WS and let uplink RTP
   *  flow to it. Control-frame op "start". */
  async startStt(session: string): Promise<void> {
    if (this.closed) return;
    this.stopStt(); // one stream at a time; a fresh start replaces any old one
    const base = this.deps.voiceWsBase ? await this.deps.voiceWsBase() : voiceWsUrl(await voiceUrl());
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${base}/stt-stream`);
    } catch (e) {
      this.deps.seal({ t: "error", where: "stt-stream", error: String(e) });
      return;
    }
    ws.binaryType = "arraybuffer";
    const st: SttState = { ws, ready: false, buffered: [], session };
    this.stt = st;
    ws.onopen = () => {
      st.ready = true;
      try { ws.send(JSON.stringify({ t: "start", sampleRate: 16000 })); } catch {}
      for (const f of st.buffered) { try { ws.send(f); } catch {} }
      st.buffered.length = 0;
    };
    ws.onmessage = (ev) => {
      // Partial/final (and any other JSON the stream emits) ride the sealed DC
      // verbatim: the app's contract shapes, unchanged. Binary from upstream is
      // not part of this contract and is dropped.
      if (typeof ev.data === "string") {
        let frame: unknown;
        try { frame = JSON.parse(ev.data); } catch { return; }
        this.deps.seal(frame);
      }
    };
    ws.onerror = () => {
      if (this.stt === st) this.deps.seal({ t: "error", where: "stt-stream", error: "upstream failed" });
    };
    ws.onclose = () => { if (this.stt === st) this.stt = null; };
  }

  /** End the current stream: tell the voice engine to finalize (op "stop"). The
   *  final frame arrives over onmessage and is sealed down like a partial. */
  stopStt(): void {
    const st = this.stt;
    if (!st) return;
    const ws = st.ws;
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ t: "stop" })); } catch {}
    } else if (ws.readyState === WebSocket.CONNECTING) {
      // never opened: nothing to finalize, just drop it
      try { ws.close(); } catch {}
      this.stt = null;
    }
    // Leave the socket open for the final frame; the voice engine closes it
    // after sending {t:"final"} and onclose clears this.stt.
  }

  private sttSend(frame: string | Uint8Array): void {
    const st = this.stt;
    if (!st) return;
    if (st.ready && st.ws.readyState === WebSocket.OPEN) {
      try { st.ws.send(frame); } catch {}
    } else {
      st.buffered.push(frame);
    }
  }

  // ---------------------------------------------------------------- downlink

  /** Put a TTS clip on the track: `pcm` is mono Int16 at `rate` Hz. Resampled to
   *  48k, Opus-encoded in 20ms frames, RTP-packetized and paced onto the track
   *  in real time. Refused while muted (fp gate). */
  speakPcm(pcm: Int16Array, rate: number): void {
    if (this.closed || !this.gateOpen) return;
    if (!this.encoder) this.encoder = new OpusEncoder();
    const pcm48 = ttsPcmTo48k(pcm, rate);
    for (const frame of frame48k(pcm48)) {
      let opus: Uint8Array;
      try {
        opus = this.encoder.encodeFrame(frame);
      } catch {
        continue;
      }
      this.downlinkQueue.push(rtpPacketize(this.sender, opus, OPUS_FRAME_SAMPLES));
    }
    this.startPacing();
  }

  private startPacing(): void {
    if (this.downlinkTimer) return;
    const flushOne = () => {
      if (this.closed) { this.stopPacing(); return; }
      const pkt = this.downlinkQueue.shift();
      if (!pkt) { this.stopPacing(); return; }
      try { this.track.sendMessageBinary(Buffer.from(pkt.buffer, pkt.byteOffset, pkt.byteLength)); } catch {}
    };
    this.downlinkTimer = setInterval(flushOne, FRAME_MS);
  }

  private stopPacing(): void {
    if (this.downlinkTimer) { clearInterval(this.downlinkTimer); this.downlinkTimer = null; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPacing();
    this.downlinkQueue.length = 0;
    const st = this.stt;
    this.stt = null;
    if (st) { try { st.ws.close(); } catch {} }
    this.decoder.close();
    this.encoder?.close();
    try { this.track.close?.(); } catch {}
  }
}

/** Call-mode TTS as PCM for the downlink track. The voice engine's /tts returns
 *  mp3 for history playback; call mode needs raw PCM to Opus-encode, so it asks
 *  with `pcm:true` and reads back Int16 LE plus an `x-pcm-rate` header. This is
 *  the one voice-engine output option this bridge calls for; a voice engine without
 *  it simply yields no downlink audio (null), never a crash. */
export async function ttsPcmFromVoiceEngine(
  text: string,
  opts: { voice?: string; base?: () => Promise<string> } = {},
): Promise<{ pcm: Int16Array; rate: number } | null> {
  try {
    const base = opts.base ? await opts.base() : await voiceUrl();
    const res = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: opts.voice, pcm: true }),
      signal: AbortSignal.timeout(voiceProxyTimeouts.tts),
    });
    if (!res.ok) return null;
    /* No x-pcm-rate means the voice engine answered the mp3 shape rather than
     * PCM: it did not understand `pcm:true`. Viewing mp3 bytes as Int16 would
     * put NOISE on the track, so we read that shape as null (no downlink audio),
     * as promised above. This is a PERMANENT reader tolerance, not compat debt
     * awaiting cleanup: a deployed voice engine binary can lag this one across a
     * rollout, so the old mp3 shape is a real response to read safely, not a
     * relic to delete. */
    const rateHeader = res.headers.get("x-pcm-rate");
    if (rateHeader === null) return null;
    const rate = Number(rateHeader) || 24000;
    const buf = new Uint8Array(await res.arrayBuffer());
    // View the response bytes as Int16 LE; copy so the fetch buffer can be freed.
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2)).slice();
    return { pcm, rate };
  } catch {
    return null;
  }
}
