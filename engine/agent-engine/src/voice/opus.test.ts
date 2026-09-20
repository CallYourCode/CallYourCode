/* Opus codec seam: a tone survives encode -> decode at 48k mono. Proves the
 * opusscript wrapper's calling convention (Int16 in, Opus out, Int16 back) and
 * that the pure-JS/WASM build runs under bun with no native step.
 *   bun test opus.test.ts
 */
import { test, expect } from "bun:test";
import { OpusEncoder, OpusDecoder, OPUS_FRAME_SAMPLES, frame48k } from "./opus.ts";

test("a 440Hz tone survives a continuous encode/decode stream", () => {
  const enc = new OpusEncoder();
  const dec = new OpusDecoder();
  const N = OPUS_FRAME_SAMPLES;
  const decoded: Int16Array[] = [];
  let phase = 0;
  for (let f = 0; f < 12; f++) {
    const frame = new Int16Array(N);
    for (let i = 0; i < N; i++) frame[i] = Math.round(Math.sin(2 * Math.PI * 440 * (phase + i) / 48000) * 10000);
    phase += N;
    decoded.push(dec.decodePacket(enc.encodeFrame(frame)));
  }
  // A settled frame (8), lag-aligned to skip Opus's ~7ms algorithmic delay.
  const out = decoded[8];
  expect(out.length).toBe(N);
  const ref = new Int16Array(N);
  const base = 8 * N;
  for (let i = 0; i < N; i++) ref[i] = Math.round(Math.sin(2 * Math.PI * 440 * (base + i) / 48000) * 10000);
  let best = 0;
  for (let lag = -400; lag <= 400; lag++) {
    let so = 0, sr = 0, sor = 0;
    for (let i = 0; i < N; i++) {
      const j = i + lag;
      if (j < 0 || j >= N) continue;
      so += out[i] * out[i]; sr += ref[j] * ref[j]; sor += out[i] * ref[j];
    }
    const c = sor / Math.sqrt(so * sr || 1);
    if (c > best) best = c;
  }
  expect(best).toBeGreaterThan(0.95);
  enc.close();
  dec.close();
});

test("frame48k slices whole 20ms frames and zero-pads the tail", () => {
  const frames = frame48k(new Int16Array(OPUS_FRAME_SAMPLES + 100));
  expect(frames.length).toBe(2);
  expect(frames[0].length).toBe(OPUS_FRAME_SAMPLES);
  expect(frames[1].length).toBe(OPUS_FRAME_SAMPLES); // padded up from 100
  // the pad is silence
  expect(frames[1][500]).toBe(0);
});
