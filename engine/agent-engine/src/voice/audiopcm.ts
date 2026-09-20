/* PCM format + sample-rate glue between the Opus track and the voice engine.
 *
 * The Opus codec works at 48kHz mono Int16 (opus.ts). The voice engine's
 * /stt-stream consumes 16kHz mono FLOAT32 (voice-engine/src/server.ts:701). TTS PCM
 * comes back out at whatever rate the voice engine emits and must climb back to
 * 48kHz Int16 to Opus-encode for the downlink. So: one linear resampler and the
 * two format conversions, pure, testable, no native handles.
 */

/** Int16 mono PCM -> Float32 mono in [-1, 1). */
export function i16ToF32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/** Float32 mono PCM -> Int16 mono, clamped. */
export function f32ToI16(pcm: Float32Array): Int16Array {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.round(pcm[i] * 32768);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** Linear-interpolation resample of mono Int16 PCM from `inRate` to `outRate`.
 *  Good enough for speech STT and TTS playback; not a studio SRC. A ratio of 1
 *  returns a copy. */
export function resampleI16(pcm: Int16Array, inRate: number, outRate: number): Int16Array {
  if (inRate === outRate) return pcm.slice();
  if (pcm.length === 0) return new Int16Array(0);
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.round(pcm.length * ratio));
  const out = new Int16Array(outLen);
  const step = inRate / outRate; // input samples per output sample
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = pcm[i0] ?? pcm[pcm.length - 1];
    const b = pcm[i0 + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/** 48kHz Int16 -> 16kHz Float32, the exact shape /stt-stream reads. */
export function pcm48kToStt(pcm48k: Int16Array): Float32Array {
  return i16ToF32(resampleI16(pcm48k, 48000, 16000));
}

/** Arbitrary-rate Int16 TTS PCM -> 48kHz Int16, ready for Opus encode. */
export function ttsPcmTo48k(pcm: Int16Array, inRate: number): Int16Array {
  return resampleI16(pcm, inRate, 48000);
}
