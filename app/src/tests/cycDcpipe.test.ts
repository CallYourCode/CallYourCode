import {describe, expect, test} from 'vitest';
import vectors from '@shared/fixtures/dcpipe-vectors.json';
import {
  FRAG,
  LAST,
  PING,
  PONG,
  CLOSE,
  FRAG_MAX,
  MSG_MAX,
  fragment,
  Reassembler,
  type PipeError
} from '@shared/dcpipe';

const RECIPES: {name: string; make: () => string}[] = [
  {name: 'empty', make: () => ''},
  {name: 'short-ascii', make: () => 'hello'},
  {name: 'json-ish', make: () => JSON.stringify({t: 'x', n: 3, ct: 'abc'})},
  {name: 'exactly-frag-max', make: () => 'a'.repeat(FRAG_MAX)},
  {name: 'one-over', make: () => 'a'.repeat(FRAG_MAX + 1)},
  {name: 'two-frags', make: () => 'a'.repeat(FRAG_MAX * 2)},
  {name: 'three-frags', make: () => 'a'.repeat(FRAG_MAX * 2 + 1)},
  {name: 'multibyte-straddle', make: () => 'a'.repeat(FRAG_MAX - 1) + '€'}
];
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}
function wireOf(frags: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = frags.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const f of frags) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}
describe('shared dcpipe framing', () => {
  test('the wire constants are the frozen values', () => {
    expect([FRAG, LAST, PING, PONG, CLOSE]).toEqual([0x00, 0x01, 0x02, 0x03, 0x04]);
    expect(FRAG_MAX).toBe(16 * 1024 - 1);
    expect(MSG_MAX).toBe(16 * 1024 * 1024);
  });
  test('the app copy fragments to the same frozen vectors', async () => {
    for (const r of RECIPES) {
      const frags = fragment(r.make());
      const frozen = (
        vectors.frag as Record<string, {headers: number[]; lengths: number[]; sha256: string}>
      )[r.name];
      expect(
        frags.map((f) => f[0]),
        r.name
      ).toEqual(frozen.headers);
      expect(
        frags.map((f) => f.length - 1),
        r.name
      ).toEqual(frozen.lengths);
      expect(await sha256Hex(wireOf(frags)), r.name).toBe(frozen.sha256);
    }
  });
  test('every input round-trips through the reassembler', () => {
    const rx = new Reassembler();
    for (const r of RECIPES) {
      const s = r.make();
      let delivered: string | null = null;
      for (const f of fragment(s)) {
        const out = rx.push(f);
        if (out !== null) delivered = out;
      }
      expect(delivered, r.name).toBe(s);
    }
  });
  test('a message over MSG_MAX is refused with 1009', () => {
    const rx = new Reassembler();
    const bigFrag = new Uint8Array(1 + FRAG_MAX);
    bigFrag[0] = FRAG;
    const need = Math.ceil(MSG_MAX / FRAG_MAX) + 1;
    let code = 0;
    try {
      for (let i = 0; i < need; i++) rx.push(bigFrag);
    } catch (e) {
      code = (e as PipeError).code;
    }
    expect(code).toBe(1009);
  });
  test('a PING/PONG mid-message is a protocol error 1002', () => {
    const rx = new Reassembler();
    expect(rx.push(new Uint8Array([FRAG, 65]))).toBeNull();
    let code = 0;
    try {
      rx.push(new Uint8Array([PING]));
    } catch (e) {
      code = (e as PipeError).code;
    }
    expect(code).toBe(1002);
  });
  test('a PING/PONG between whole messages is inert', () => {
    const rx = new Reassembler();
    expect(rx.push(new Uint8Array([LAST, 65, 66]))).toBe('AB');
    expect(rx.push(new Uint8Array([PING]))).toBeNull();
    expect(rx.push(new Uint8Array([PONG]))).toBeNull();
    expect(rx.push(new Uint8Array([LAST, 67]))).toBe('C');
  });
});
