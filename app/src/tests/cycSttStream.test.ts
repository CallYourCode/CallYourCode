import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {DcSttStream, type DcSttDeps} from '../engine/sttStream';
import {b64decode} from '@shared/e2e';
type Frame = Record<string, unknown>;

function fakeDeps() {
  const sent: Frame[] = [];
  const detached: string[] = [];
  const drains: (() => void)[] = [];
  let sendOk = true;
  const deps: DcSttDeps = {
    send: (frame) => {
      if (!sendOk) return false;
      sent.push(frame as Frame);
      return true;
    },
    drain: () => new Promise<void>((res) => drains.push(res)),
    detach: (id) => {
      detached.push(id);
    }
  };
  return {
    deps,
    sent,
    detached,
    refuseSends: () => {
      sendOk = false;
    },
    allowSends: () => {
      sendOk = true;
    },

    async drainDone() {
      drains.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}
const pcm = (...vals: number[]) => new Float32Array(vals.length ? vals : [0, 0, 0, 0]);

function decodeChunk(frame: Frame): Float32Array {
  const bytes = b64decode(String(frame.b));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
describe('DcSttStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  test('the open frame goes first, exactly to the engine contract', () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    expect(f.sent).toEqual([{t: 'stt-open', id: s.id, rate: 16000, format: 'f32'}]);
    expect(s.id).not.toBe('');
    expect(s.failed).toBe(false);
    void s.finish().catch(() => {});
  });
  test('every stream mints its own id: unique per connection while live', () => {
    const f = fakeDeps();
    const a = new DcSttStream(f.deps, {});
    const b = new DcSttStream(f.deps, {});
    expect(a.id).not.toBe(b.id);
    void a.finish().catch(() => {});
    void b.finish().catch(() => {});
  });
  test('push sends stt-b frames whose base64 round-trips to the exact PCM, in order', async () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    const first = pcm(0.5, -0.25, 1, 0);
    const second = pcm(0.125, 0.75);
    s.push(first);
    await f.drainDone();
    s.push(second);
    const chunks = f.sent.slice(1);
    expect(chunks.map((c) => c.t)).toEqual(['stt-b', 'stt-b']);
    expect(chunks.every((c) => c.id === s.id)).toBe(true);
    expect(decodeChunk(chunks[0])).toEqual(first);
    expect(decodeChunk(chunks[1])).toEqual(second);

    expect(String(chunks[0].b)).toMatch(/^[A-Za-z0-9+/]+=*$/);
    void s.finish().catch(() => {});
  });
  test('finish sends stt-close and resolves on the sealed stt-final', async () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    s.push(pcm());
    const final = s.finish();
    expect(f.sent[f.sent.length - 1]).toEqual({t: 'stt-close', id: s.id});
    s.onFrame({t: 'stt-final', id: s.id, text: 'hello there', corrections: [], dropped: []} as any);
    await expect(final).resolves.toBe('hello there');
    expect(s.failed).toBe(false);
    expect(f.detached).toEqual([s.id]);
  });
  test('partials reach the handler with the committed counters', () => {
    const partials: [string, number | undefined, number | undefined][] = [];
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {
      onPartial: (text, committed, committedS) => partials.push([text, committed, committedS])
    });
    s.onFrame({t: 'stt-partial', id: s.id, text: 'hel', committed: 2, committedS: 0.4} as any);
    s.onFrame({t: 'stt-partial', id: s.id, text: 'hello'} as any);
    expect(partials).toEqual([
      ['hel', 2, 0.4],
      ['hello', undefined, undefined]
    ]);
    void s.finish().catch(() => {});
  });
  test('an stt-error frame rejects finish and sets failed (terminal)', async () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    s.onFrame({t: 'stt-error', id: s.id, error: 'voice engine unreachable'} as any);
    await expect(s.finish()).rejects.toThrow('stt-stream: voice engine unreachable');
    expect(s.failed).toBe(true);
    expect(f.detached).toEqual([s.id]);
  });
  test('exactly one terminal per id: frames after the final are inert', async () => {
    const f = fakeDeps();
    const partials: string[] = [];
    const s = new DcSttStream(f.deps, {onPartial: (text) => partials.push(text)});
    s.onFrame({t: 'stt-final', id: s.id, text: 'done'} as any);
    s.onFrame({t: 'stt-error', id: s.id, error: 'late'} as any);
    s.onFrame({t: 'stt-partial', id: s.id, text: 'ghost'} as any);
    await expect(s.finish()).resolves.toBe('done');
    expect(s.failed).toBe(false);
    expect(partials).toEqual([]);
  });
  test('no final within the deadline: finish rejects, caller falls back to batch', async () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    const final = s.finish();
    vi.advanceTimersByTime(14_999);

    vi.advanceTimersByTime(2);
    await expect(final).rejects.toThrow('no final within timeout');
    expect(s.failed).toBe(true);
  });
  test('backpressure: while the pipe drains, chunks are DROPPED, never queued', async () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    s.push(pcm());
    s.push(pcm());
    s.push(pcm());
    expect(s.dropped).toBe(2);
    expect(f.sent.filter((x) => x.t === 'stt-b').length).toBe(1);
    await f.drainDone();
    s.push(pcm());
    expect(s.dropped).toBe(2);
    expect(f.sent.filter((x) => x.t === 'stt-b').length).toBe(2);
    void s.finish().catch(() => {});
  });
  test('a seal that is not ready fails the open instead of exploding', async () => {
    const f = fakeDeps();
    f.refuseSends();
    const s = new DcSttStream(f.deps, {});
    expect(s.failed).toBe(true);
    await expect(s.finish()).rejects.toThrow('stt-stream: engine pipe not sealed');
    expect(f.detached).toEqual([s.id]);
  });
  test('the seal slipping away mid-capture fails the stream (no terminal will come)', async () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    f.refuseSends();
    s.push(pcm());
    expect(s.failed).toBe(true);
    await expect(s.finish()).rejects.toThrow('stt-stream: engine pipe closed');
  });
  test('the pipe dying with the stream live fails it: closed before final', async () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    const final = s.finish();
    s.onClosed();
    await expect(final).rejects.toThrow('closed before final');
    expect(s.failed).toBe(true);
  });
  test('abort still closes the engine session, then rejects finish', async () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    s.abort();

    expect(f.sent[f.sent.length - 1]).toEqual({t: 'stt-close', id: s.id});
    await expect(s.finish()).rejects.toThrow('aborted');
    expect(f.detached).toEqual([s.id]);
  });
  test('pushes after settle are ignored', () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    s.onFrame({t: 'stt-final', id: s.id, text: 'x'} as any);
    const sentBefore = f.sent.length;
    s.push(pcm());
    expect(f.sent.length).toBe(sentBefore);
    void s.finish().catch(() => {});
  });
  test('pushes after finish are ignored: stt-close is the last audio frame', () => {
    const f = fakeDeps();
    const s = new DcSttStream(f.deps, {});
    void s.finish().catch(() => {});
    const sentBefore = f.sent.length;
    s.push(pcm());
    expect(f.sent.length).toBe(sentBefore);
  });
});
