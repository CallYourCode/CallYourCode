import {test, expect} from 'bun:test';
import {wsPipe, MSG_MAX, QUEUE_MAX, type WsLike} from '../../../shared/ws-pipe';
function socket(): WsLike & {sent: string[]; bufferedAmount: number} {
  const sent: string[] = [];
  return {readyState: 1, bufferedAmount: 0, sent, send(s) {sent.push(s);}, close() {},
    onopen: null, onmessage: null, onclose: null, onerror: null};
}
test('WS sends whole logical strings and refuses binary or oversized frames', () => {
  const ws = socket(); const pipe = wsPipe(ws); const received: string[] = [];
  pipe.onmessage = (s) => received.push(s);
  for (const s of ['hello', '雪"\\\n', 'x'.repeat(400_000)]) {
    expect(pipe.send(s)).toBe(true); ws.onmessage!({data: s});
  }
  expect(received).toEqual(ws.sent);
  let closes = 0; pipe.onclose = () => closes++;
  ws.onmessage!({data: new Uint8Array([0])});
  ws.onclose!({code: 1003, reason: ''});
  expect(closes).toBe(1); expect(pipe.send('late')).toBe(false);
  expect(wsPipe(socket()).send('x'.repeat(MSG_MAX + 1))).toBe(false);
});
test('bounded queue and close release every drain waiter', async () => {
  const ws = socket(); ws.bufferedAmount = QUEUE_MAX;
  const pipe = wsPipe(ws); const pending = pipe.drain();
  expect(pipe.send('one too many')).toBe(false);
  await pending;
  expect(pipe.open).toBe(false);
});
