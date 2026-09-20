import {describe, expect, test} from 'vitest';
import {wsolaStretch, WSOLA_WORKLET_JS, WSOLA_PROCESSOR_NAME} from '../audio/wsola';

function tone(hz: number, sampleRate: number, seconds: number): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

function fundamentalHz(pcm: Float32Array, sampleRate: number): number {
  let crossings = 0;
  for (let i = 1; i < pcm.length; i++) {
    if ((pcm[i - 1] < 0 && pcm[i] >= 0) || (pcm[i - 1] >= 0 && pcm[i] < 0)) crossings++;
  }
  return crossings / 2 / (pcm.length / sampleRate);
}
describe('wsolaStretch', () => {
  test('tempo 1 is a bit-for-bit copy', () => {
    const src = tone(220, 48000, 0.25);
    const out = wsolaStretch([src], 48000, 1);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(src.length);
    expect([...out[0].slice(0, 500)]).toEqual([...src.slice(0, 500)]);

    expect(out[0]).not.toBe(src);
  });
  test('tempo 2 halves the length and keeps the fundamental (no pitch shift)', () => {
    const sampleRate = 48000;
    const src = tone(220, sampleRate, 1);
    const out = wsolaStretch([src], sampleRate, 2)[0];

    expect(Math.abs(out.length - src.length / 2)).toBeLessThan(sampleRate * 0.04);

    const hz = fundamentalHz(out.subarray(2048, out.length - 2048), sampleRate);
    expect(Math.abs(hz - 220)).toBeLessThan(8);
  });
  test('tempo 0.5 roughly doubles the length, fundamental still 220', () => {
    const sampleRate = 48000;
    const src = tone(220, sampleRate, 0.5);
    const out = wsolaStretch([src], sampleRate, 0.5)[0];
    expect(Math.abs(out.length - src.length * 2)).toBeLessThan(sampleRate * 0.08);
    const hz = fundamentalHz(out.subarray(2048, out.length - 2048), sampleRate);
    expect(Math.abs(hz - 220)).toBeLessThan(8);
  });
  test('stereo: both channels stretched to one shared length', () => {
    const sampleRate = 44100;
    const l = tone(220, sampleRate, 0.5);
    const r = tone(330, sampleRate, 0.5);
    const out = wsolaStretch([l, r], sampleRate, 1.5);
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(out[1].length);
  });
  test('empty input is an empty copy, not a crash', () => {
    expect(wsolaStretch([], 48000, 2)).toEqual([]);
    const out = wsolaStretch([new Float32Array(0)], 48000, 2);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(0);
  });
});
describe('WSOLA_WORKLET_JS (the serialised twin)', () => {
  test('carries the function source assigned to the name the worklet calls', () => {
    expect(WSOLA_WORKLET_JS).toContain('var wsolaStretch = ');
    expect(WSOLA_WORKLET_JS).toContain(`registerProcessor('${WSOLA_PROCESSOR_NAME}'`);

    expect(WSOLA_WORKLET_JS).not.toContain('new Function');
  });
  test('the embedded stretch is the SAME code: it runs standalone and agrees', () => {
    const src = WSOLA_WORKLET_JS;
    const decl = src.slice(src.indexOf('var wsolaStretch'), src.indexOf('\nclass CycWsola'));

    const embedded = new Function(`${decl}\nreturn wsolaStretch;`)() as typeof wsolaStretch;
    const pcm = tone(220, 48000, 0.2);
    const a = wsolaStretch([pcm], 48000, 1.5)[0];
    const b = embedded([pcm.slice()], 48000, 1.5)[0];
    expect(b.length).toBe(a.length);
    expect([...b.slice(0, 4096)]).toEqual([...a.slice(0, 4096)]);
  });
});
