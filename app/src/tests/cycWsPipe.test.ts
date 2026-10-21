import {describe, it, expect, vi} from 'vitest';
import {wsPipe, MSG_MAX, QUEUE_MAX, type WsLike} from '../../../engine/shared/ws-pipe';
function socket(): WsLike & {sent: string[]; bufferedAmount: number} {
  const sent: string[] = [];
  return {readyState: 1, bufferedAmount: 0, sent, send(s) {sent.push(s);}, close: vi.fn(),
    onopen: null, onmessage: null, onclose: null, onerror: null};
}
describe('one sealed frame per WS message', () => {
  it('preserves Unicode, escaped strings and message order without framing', () => {
    const ws = socket(); const pipe = wsPipe(ws); const frames: string[] = [];
    pipe.onmessage = (s) => frames.push(s);
    for (const s of ['hello', '"\\\n雪"', 'x'.repeat(400_000)]) {
      expect(pipe.send(s)).toBe(true); ws.onmessage!({data: s});
    }
    expect(frames).toEqual(ws.sent);
    expect(ws.sent).toHaveLength(3);
  });
  it('closes once on binary, overflow or socket failure', () => {
    const ws = socket(); const pipe = wsPipe(ws); const close = vi.fn(); pipe.onclose = close;
    ws.onmessage!({data: new Uint8Array([1])});
    ws.onclose!({code: 1003, reason: 'text-only'});
    expect(close).toHaveBeenCalledTimes(1);
    expect(pipe.send('late')).toBe(false);
    const slow = socket(); slow.bufferedAmount = QUEUE_MAX;
    const p = wsPipe(slow); expect(p.send('x')).toBe(false); expect(p.open).toBe(false);
    const large = wsPipe(socket()); expect(large.send('雪'.repeat(MSG_MAX / 3 + 1))).toBe(false);
  });
  it('drains with bounded polling and wakes waiters on close', async () => {
    vi.useFakeTimers();
    try {
      const ws = socket(); ws.bufferedAmount = 1024 * 1024;
      const pipe = wsPipe(ws); let done = false;
      const draining = pipe.drain().then(() => {done = true;});
      await vi.advanceTimersByTimeAsync(20); expect(done).toBe(false);
      ws.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(10); await draining;
      ws.bufferedAmount = 1024 * 1024;
      const closed = pipe.drain(); pipe.close(); await closed;
      expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
  });
});
