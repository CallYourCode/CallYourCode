/* PCM format + resample glue between the Opus track and the voice engine.
 *   bun test audiopcm.test.ts
 */
import { test, expect } from "bun:test";
import { i16ToF32, f32ToI16, resampleI16, pcm48kToStt, ttsPcmTo48k } from "./audiopcm.ts";

test("i16 <-> f32 round-trips within one quantum", () => {
  const src = new Int16Array([0, 32767, -32768, 1000, -1000]);
  const back = f32ToI16(i16ToF32(src));
  for (let i = 0; i < src.length; i++) expect(Math.abs(back[i] - src[i])).toBeLessThanOrEqual(1);
});

test("f32 -> i16 clamps out-of-range values", () => {
  const out = f32ToI16(new Float32Array([2, -2]));
  expect(out[0]).toBe(32767);
  expect(out[1]).toBe(-32768);
});

test("48k -> 16k decimates length by three", () => {
  const src = new Int16Array(48000); // 1 second
  const out = resampleI16(src, 48000, 16000);
  expect(out.length).toBe(16000);
});

test("resample preserves a tone's frequency (zero-crossings survive)", () => {
  // 100 Hz at 48k, one second
  const n = 48000;
  const src = new Int16Array(n);
  for (let i = 0; i < n; i++) src[i] = Math.round(Math.sin(2 * Math.PI * 100 * i / 48000) * 10000);
  const out = resampleI16(src, 48000, 16000);
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) crossings++;
  // 100 Hz over 1s -> ~200 zero-crossings, independent of rate
  expect(crossings).toBeGreaterThan(180);
  expect(crossings).toBeLessThan(220);
});

test("pcm48kToStt yields 16k float32, the /stt-stream shape", () => {
  const out = pcm48kToStt(new Int16Array(4800)); // 100ms
  expect(out).toBeInstanceOf(Float32Array);
  expect(out.length).toBe(1600); // 100ms @ 16k
});

test("ttsPcmTo48k lifts an arbitrary rate up to 48k", () => {
  const out = ttsPcmTo48k(new Int16Array(2400), 24000); // 100ms @24k
  expect(out.length).toBe(4800); // 100ms @48k
});

test("an identical rate returns a copy, not the same buffer", () => {
  const src = new Int16Array([1, 2, 3]);
  const out = resampleI16(src, 16000, 16000);
  expect([...out]).toEqual([1, 2, 3]);
  expect(out.buffer).not.toBe(src.buffer);
});
