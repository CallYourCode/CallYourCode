import {describe, expect, test, vi} from 'vitest';
import vectors from '@shared/fixtures/tunnel-vectors.json';
import {
  CHUNK,
  REASSEMBLE_MAX,
  TunnelError,
  decodeChunk,
  encodeReq,
  encodeReqAbort,
  encodeRes,
  ReqReassembler,
  ReqStreamEncoder,
  ResReassembler,
  ResStreamEncoder,
  type ReqFrame,
  type ResFrame
} from '@shared/tunnel';
import {TunnelClient} from '../engine/tunnelClient';
function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  return b;
}
const BODIES: {name: string; make: () => Uint8Array | null}[] = [
  {name: 'empty', make: () => null},
  {name: 'tiny', make: () => bytes(5)},
  {name: 'json-ish', make: () => new TextEncoder().encode(JSON.stringify({ok: true, n: 3}))},
  {name: 'exactly-chunk', make: () => bytes(CHUNK)},
  {name: 'one-over', make: () => bytes(CHUNK + 1)},
  {name: 'two-and-a-bit', make: () => bytes(CHUNK * 2 + 100)}
];
const HDRS = {'content-type': 'application/json', 'x-cyc-cap': 'CAP'};
async function sha256Hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}
function wireOf(frames: (ReqFrame | ResFrame)[]): string {
  return frames.map((f) => JSON.stringify(f)).join('\n');
}
type Vec = {frames: number; more: boolean[]; blens: number[]; sha256: string};
async function vecOf(frames: (ReqFrame | ResFrame)[]): Promise<Vec> {
  return {
    frames: frames.length,
    more: frames.map((f) => f.more === true),
    blens: frames.map((f) => (f.b ? f.b.length : 0)),
    sha256: await sha256Hex(wireOf(frames))
  };
}
describe('shared tunnel codec', () => {
  test('the tunnel constants are the frozen values', () => {
    expect(CHUNK).toBe(256 * 1024);
    expect(REASSEMBLE_MAX).toBe(32 * 1024 * 1024);
  });
  test('the app copy chunks to the same frozen vectors', async () => {
    const req = vectors.req as Record<string, Vec>;
    const res = vectors.res as Record<string, Vec>;
    for (const r of BODIES) {
      expect(await vecOf(encodeReq('ID', 'POST', '/upload?x=1', HDRS, r.make())), r.name).toEqual(
        req[r.name]
      );
      expect(await vecOf(encodeRes('ID', 200, HDRS, r.make())), r.name).toEqual(res[r.name]);
    }
  });
  test('every request round-trips through the reassembler', () => {
    const rx = new ReqReassembler();
    for (const r of BODIES) {
      const body = r.make();
      let done: ReturnType<ReqReassembler['push']> = null;
      for (const f of encodeReq('ID', 'POST', '/upload?x=1', HDRS, body)) {
        const out = rx.push(f);
        if (out) done = out;
      }
      expect(done, r.name).not.toBeNull();
      expect(Array.from(done!.body), r.name).toEqual(Array.from(body ?? new Uint8Array(0)));
    }
  });
  test('a body past REASSEMBLE_MAX is refused with 1009', () => {
    const rx = new ReqReassembler();
    let code = 0;
    try {
      for (const f of encodeReq('ID', 'POST', '/p', {}, bytes(REASSEMBLE_MAX + 1))) rx.push(f);
    } catch (e) {
      code = (e as TunnelError).code;
    }
    expect(code).toBe(1009);
    expect(rx.pending).toBe(0);
  });
  test('sweep drops a half-sent id whose sender vanished', () => {
    const rx = new ResReassembler();
    const frames = encodeRes('ID', 200, {}, bytes(CHUNK + 1));
    rx.push(frames[0], 1000);
    expect(rx.pending).toBe(1);
    expect(rx.sweep(500)).toBe(0);
    expect(rx.sweep(2000)).toBe(1);
    expect(rx.pending).toBe(0);
  });

  const DRIP = 100_000;
  function dripReq(body: Uint8Array | null): ReqFrame[] {
    const enc = new ReqStreamEncoder('ID', 'POST', '/upload?x=1', HDRS);
    const b = body ?? new Uint8Array(0);
    const out: ReqFrame[] = [];
    for (let off = 0; off < b.length; off += DRIP)
      out.push(...enc.push(b.subarray(off, off + DRIP)));
    out.push(...enc.end());
    return out;
  }
  function dripRes(body: Uint8Array | null): ResFrame[] {
    const enc = new ResStreamEncoder('ID', 200, HDRS);
    const b = body ?? new Uint8Array(0);
    const out: ResFrame[] = [];
    for (let off = 0; off < b.length; off += DRIP)
      out.push(...enc.push(b.subarray(off, off + DRIP)));
    out.push(...enc.end());
    return out;
  }
  test('the app copy streams to the same frozen vectors (and the streamed wire IS the buffered wire)', async () => {
    const reqStream = vectors.reqStream as Record<string, Vec>;
    const resStream = vectors.resStream as Record<string, Vec>;
    for (const r of BODIES) {
      expect(await vecOf(dripReq(r.make())), r.name).toEqual(reqStream[r.name]);
      expect(await vecOf(dripRes(r.make())), r.name).toEqual(resStream[r.name]);

      expect(wireOf(dripReq(r.make())), r.name).toBe(
        wireOf(encodeReq('ID', 'POST', '/upload?x=1', HDRS, r.make()))
      );
    }
  });
  test('the req-abort frame is the frozen wire shape', () => {
    expect(JSON.stringify(encodeReqAbort('ID'))).toBe(vectors.reqAbort);
    expect(vectors.reqAbort).toBe('{"t":"req-abort","id":"ID"}');
  });
  test('decodeChunk inverts a frame body chunk', () => {
    const body = bytes(CHUNK + 3);
    const back: number[] = [];
    for (const f of encodeReq('ID', 'POST', '/p', {}, body)) {
      for (const v of decodeChunk(f.b)) back.push(v);
    }
    expect(back.length).toBe(body.length);
    expect(back).toEqual(Array.from(body));
    expect(decodeChunk(undefined).length).toBe(0);
  });
});

function fakeTransport() {
  const sent: any[] = [];
  let drains = 0;
  const tx = {
    ready: () => true,
    send: (f: object) => {
      sent.push(f);
      return true;
    },
    drain: async () => {
      drains++;
    }
  };
  return {tx, sent, drains: () => drains};
}
function bytes2(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(new ArrayBuffer(n));
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 251;
  return b;
}

function fakeBlob(body: Uint8Array<ArrayBuffer>, type = ''): Blob {
  return {
    size: body.length,
    type,
    slice: (s: number, e: number) => ({
      arrayBuffer: async () => body.slice(s, e).buffer
    })
  } as unknown as Blob;
}
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
describe('TunnelClient streaming', () => {
  test('a one-frame answer still resolves the buffered shape', async () => {
    const {tx, sent} = fakeTransport();
    const tc = new TunnelClient(tx);
    const p = tc.fetch('http://e/x', {method: 'GET'});
    await flushMicrotasks();
    const id = (sent[0] as ReqFrame).id;
    tc.onRes(encodeRes(id, 200, {'content-type': 'text/plain'}, new TextEncoder().encode('hi'))[0]);
    const res = await p;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hi');
  });
  test('a chunked answer resolves on the FIRST frame with a live stream fed by the rest', async () => {
    const {tx, sent} = fakeTransport();
    const tc = new TunnelClient(tx);
    const p = tc.fetch('http://e/audio/x.mp3');
    await flushMicrotasks();
    const id = (sent[0] as ReqFrame).id;
    const body = bytes2(CHUNK * 2 + 100);
    const frames = encodeRes(id, 200, {'content-type': 'audio/mpeg'}, body);
    expect(frames.length).toBe(3);
    tc.onRes(frames[0]);

    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    const read = res.arrayBuffer();
    tc.onRes(frames[1]);
    tc.onRes(frames[2]);
    const got = new Uint8Array(await read);
    expect(got.length).toBe(body.length);
    expect(Array.from(got.subarray(0, 32))).toEqual(Array.from(body.subarray(0, 32)));
    expect(Array.from(got.subarray(-32))).toEqual(Array.from(body.subarray(-32)));
  });
  test('a response past the old 32MB reassembly ceiling streams through', async () => {
    const {tx, sent} = fakeTransport();
    const tc = new TunnelClient(tx);
    const p = tc.fetch('http://e/big');
    await flushMicrotasks();
    const id = (sent[0] as ReqFrame).id;

    const piece = bytes2(CHUNK);
    const n = Math.ceil((REASSEMBLE_MAX + CHUNK) / CHUNK);
    const enc = new ResStreamEncoder(id, 200, {});
    expect(enc.push(piece)).toEqual([]);
    for (const f of enc.push(piece)) tc.onRes(f);
    const res = await p;
    let total = 0;
    const reader = res.body!.getReader();
    const consume = (async () => {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        total += value!.length;
      }
    })();
    for (let i = 2; i < n; i++) {
      for (const f of enc.push(piece)) tc.onRes(f);
      if (i % 16 === 0) await flushMicrotasks(1);
    }
    for (const f of enc.end()) tc.onRes(f);
    await consume;
    expect(total).toBe(n * CHUNK);
    expect(n * CHUNK).toBeGreaterThan(REASSEMBLE_MAX);
  });
  test('cancelling a streamed response body sends {t:"req-abort"}', async () => {
    const {tx, sent} = fakeTransport();
    const tc = new TunnelClient(tx);
    const p = tc.fetch('http://e/grow.mp3');
    await flushMicrotasks();
    const id = (sent[0] as ReqFrame).id;
    tc.onRes({t: 'res', id, s: 200, h: {}, b: undefined, more: true});
    const res = await p;
    await res.body!.cancel();
    await flushMicrotasks();
    const abort = sent.find((f: any) => f.t === 'req-abort');
    expect(abort).toEqual({t: 'req-abort', id});
  });
  test('sendStream slices at CHUNK, drains between frames, reports progress, resolves the answer', async () => {
    const {tx, sent, drains} = fakeTransport();
    const tc = new TunnelClient(tx);
    const N = CHUNK * 2 + 123;
    const body = bytes2(N);
    const progress: [number, number][] = [];
    const p = tc.sendStream(
      'http://e/upload?x=1',
      {method: 'POST', headers: {'x-filename': 'a.bin'}},
      fakeBlob(body),
      (s, t) => progress.push([s, t])
    );

    await vi.waitFor(() => {
      const reqs = sent.filter((f: any) => f.t === 'req');
      if (!(reqs.length === 3 && reqs[2].more === undefined)) throw new Error('not yet');
    });
    const reqs = sent.filter((f: any) => f.t === 'req') as ReqFrame[];
    const id = reqs[0].id;
    expect(reqs[0].m).toBe('POST');
    expect(reqs[0].p).toBe('/upload?x=1');
    expect(reqs[0].h?.['x-filename']).toBe('a.bin');
    expect(reqs[0].h?.['content-length']).toBe(String(N));
    expect(reqs.map((f) => f.more === true)).toEqual([true, true, false]);

    expect(reqs.map((f) => JSON.stringify(f))).toEqual(
      encodeReq(id, 'POST', '/upload?x=1', reqs[0].h!, body).map((f) => JSON.stringify(f))
    );
    expect(drains()).toBe(3);
    expect(progress[progress.length - 1]).toEqual([N, N]);

    const rx = new ReqReassembler();
    let done: ReturnType<ReqReassembler['push']> = null;
    for (const f of reqs) {
      const out = rx.push(f);
      if (out) done = out;
    }
    expect(Array.from(done!.body)).toEqual(Array.from(body));

    tc.onRes(
      encodeRes(
        id,
        200,
        {'content-type': 'application/json'},
        new TextEncoder().encode('{"ok":true}')
      )[0]
    );
    const res = await p;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true});
  });
  test('aborting a sendStream mid-upload sends {t:"req-abort"} and rejects AbortError', async () => {
    const sent: any[] = [];
    let release: (() => void) | null = null;
    const tx = {
      ready: () => true,
      send: (f: object) => {
        sent.push(f);
        return true;
      },

      drain: () =>
        new Promise<void>((r) => {
          release = r;
        })
    };
    const tc = new TunnelClient(tx);
    const ac = new AbortController();
    const p = tc.sendStream(
      'http://e/user-audio',
      {method: 'POST', signal: ac.signal},
      fakeBlob(bytes2(CHUNK * 3))
    );
    await vi.waitFor(() => {
      if (!sent.some((f: any) => f.t === 'req')) throw new Error('not yet');
    });
    const id = (sent.find((f: any) => f.t === 'req') as ReqFrame).id;
    ac.abort();
    await expect(p).rejects.toMatchObject({name: 'AbortError'});
    expect(sent.find((f: any) => f.t === 'req-abort')).toEqual({t: 'req-abort', id});
    release?.();
    await flushMicrotasks();
    const before = sent.filter((f: any) => f.t === 'req').length;
    await flushMicrotasks();
    expect(sent.filter((f: any) => f.t === 'req').length).toBe(before);
  });
  test('a transfer PUT (drainEachFrame) drains AFTER each frame, so bufferedAmount is seen once the bytes are buffered', async () => {
    const {tx, sent, drains} = fakeTransport();
    const tc = new TunnelClient(tx);
    const body = bytes2(CHUNK * 3); // three request frames
    const p = tc.fetch('http://e/transfer/xid/0', {
      method: 'PUT',
      headers: {'content-type': 'application/octet-stream'},
      body,
      drainEachFrame: true
    });
    await flushMicrotasks();
    const reqs = sent.filter((f: any) => f.t === 'req') as ReqFrame[];
    expect(reqs).toHaveLength(3);
    // One drain awaited per frame handed to the channel (not zero, and not a
    // single check before the burst): exactly the sendStream discipline.
    expect(drains()).toBe(3);
    const id = reqs[0].id;
    tc.onRes(
      encodeRes(
        id,
        200,
        {'content-type': 'application/json'},
        new TextEncoder().encode('{"have":[0]}')
      )[0]
    );
    const res = await p;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({have: [0]});
  });

  test('a plain fetch does NOT drain per frame: the discipline is the transfer PUT route only', async () => {
    const {tx, sent, drains} = fakeTransport();
    const tc = new TunnelClient(tx);
    const p = tc.fetch('http://e/transfer/xid/0', {
      method: 'PUT',
      headers: {'content-type': 'application/octet-stream'},
      body: bytes2(CHUNK * 3)
    });
    await flushMicrotasks();
    expect(sent.filter((f: any) => f.t === 'req')).toHaveLength(3);
    expect(drains()).toBe(0);
    const id = (sent[0] as ReqFrame).id;
    tc.onRes(encodeRes(id, 200, {}, new TextEncoder().encode('{"have":[0]}'))[0]);
    expect((await p).status).toBe(200);
  });

  test('reset errors an open response stream like a dead socket', async () => {
    const {tx, sent} = fakeTransport();
    const tc = new TunnelClient(tx);
    const p = tc.fetch('http://e/grow.mp3');
    await flushMicrotasks();
    const id = (sent[0] as ReqFrame).id;
    tc.onRes({t: 'res', id, s: 200, h: {}, more: true});
    const res = await p;
    const read = res.arrayBuffer();
    tc.reset('test');
    await expect(read).rejects.toThrow(/pipe closed/);
  });
});
