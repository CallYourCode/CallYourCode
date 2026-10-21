import {expect, test} from 'vitest';
import {WsEngineClient} from '../engine/client';

test('a fast sealed hello burst is published only after the connected lifecycle edge', async () => {
  const client = new WsEngineClient('ws://scratch.test/ws', {schedule() {}});
  const internal = client as any;
  const events: string[] = [];
  client.on('status', (s) => events.push(s));
  internal.handle = (frame: {t: string}) => events.push(frame.t);
  const pipe = {open: true, close() {}, drain: async () => {}, send: () => true};
  const hs = {pipe, doneSeen: true, chan: {open: async (f: {inner: unknown}) => f.inner},
    earlyFrames: [] as unknown[], earlyBytes: 0, rejectSec() {}, rejectDone() {}};
  internal.pipe = pipe;
  internal.hs = hs;
  internal.onHandshakeFrame(hs, JSON.stringify({t: 'x', inner: {t: 'host'}}));
  internal.onHandshakeFrame(hs, JSON.stringify({t: 'x', inner: {t: 'sessions'}}));
  await Promise.resolve();
  expect(events).toEqual([]);
  internal.sendPostHello();
  expect(events).toEqual(['connected', 'host', 'sessions']);
  // An already-opening frame finishes after finalization: no second queue,
  // and it cannot be lost behind the now-completed handshake.
  internal.onHandshakeFrame(hs, JSON.stringify({t: 'x', inner: {t: 'plugins'}}));
  await Promise.resolve();
  expect(events).toEqual(['connected', 'host', 'sessions', 'plugins']);
  client.close();
});
