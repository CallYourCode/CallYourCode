import {describe, expect, test} from 'vitest';
import {unb64} from '../components/terminalViewer';

describe('unb64 terminal frame decoder', () => {
  test('decodes ASCII payloads to their byte values', () => {
    expect(Array.from(unb64(btoa('hi')))).toEqual([0x68, 0x69]);
  });

  test('empty input yields an empty buffer', () => {
    const out = unb64('');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(0);
  });

  test('preserves high bytes rather than clamping to ASCII', () => {
    const raw = Uint8Array.from([0x00, 0x7f, 0x80, 0xff]);
    const b64 = btoa(String.fromCharCode(...raw));
    expect(Array.from(unb64(b64))).toEqual([0x00, 0x7f, 0x80, 0xff]);
  });

  test('round-trips arbitrary bytes through btoa/unb64', () => {
    const raw = Uint8Array.from({length: 256}, (_, i) => i);
    const b64 = btoa(String.fromCharCode(...raw));
    expect(Array.from(unb64(b64))).toEqual(Array.from(raw));
  });
});
