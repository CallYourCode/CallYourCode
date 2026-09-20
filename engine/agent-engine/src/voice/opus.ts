/* Opus encode/decode for the media track, on opusscript: pure
 * JS/WASM, no native build, verified to encode+decode 48kHz mono under bun.
 *
 * The track speaks 48kHz mono Opus in 20ms frames (960 samples). This module is
 * only the codec: RTP framing is rtp.ts, rate/format conversion is audiopcm.ts.
 * A codec instance is stateful (Opus carries inter-frame prediction and a ~7ms
 * algorithmic delay), so a stream keeps ONE encoder and ONE decoder for its life
 * and feeds frames in order.
 */

import OpusScript from "opusscript";

export const OPUS_RATE = 48000;
export const OPUS_CHANNELS = 1;
/** 20ms at 48kHz mono: the frame size the browser's WebRTC Opus uses and the
 *  packetizer times against. */
export const OPUS_FRAME_SAMPLES = 960;

export class OpusEncoder {
  private enc: OpusScript;
  constructor(bitrate = 24000) {
    this.enc = new OpusScript(OPUS_RATE, OPUS_CHANNELS, OpusScript.Application.VOIP);
    try { this.enc.setBitrate(bitrate); } catch { /* older builds: default rate */ }
  }
  /** Encode exactly one 20ms frame (OPUS_FRAME_SAMPLES Int16 samples). */
  encodeFrame(frame: Int16Array): Uint8Array {
    const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    return new Uint8Array(this.enc.encode(bytes, OPUS_FRAME_SAMPLES));
  }
  close(): void { try { this.enc.delete(); } catch { /* already gone */ } }
}

export class OpusDecoder {
  private dec: OpusScript;
  constructor() {
    this.dec = new OpusScript(OPUS_RATE, OPUS_CHANNELS, OpusScript.Application.VOIP);
  }
  /** Decode one Opus packet to 48kHz mono Int16 PCM. */
  decodePacket(pkt: Uint8Array): Int16Array {
    const pcm = this.dec.decode(Buffer.from(pkt.buffer, pkt.byteOffset, pkt.byteLength));
    // Buffer -> Int16Array over the SAME bytes, then copied out so the codec's
    // internal HEAP view cannot be read as the next frame later.
    const view = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    return view.slice();
  }
  close(): void { try { this.dec.delete(); } catch { /* already gone */ } }
}

/** Slice arbitrary-length 48kHz Int16 PCM into whole 20ms frames. A trailing
 *  partial frame is zero-padded to a full frame so Opus always gets 960 samples;
 *  the pad is silence and inaudible at a clip boundary. */
export function frame48k(pcm: Int16Array): Int16Array[] {
  const out: Int16Array[] = [];
  for (let off = 0; off < pcm.length; off += OPUS_FRAME_SAMPLES) {
    const chunk = pcm.subarray(off, off + OPUS_FRAME_SAMPLES);
    if (chunk.length === OPUS_FRAME_SAMPLES) {
      out.push(chunk);
    } else {
      const padded = new Int16Array(OPUS_FRAME_SAMPLES);
      padded.set(chunk);
      out.push(padded);
    }
  }
  return out;
}
