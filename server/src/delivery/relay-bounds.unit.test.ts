import {test, expect} from 'bun:test';
import {Relay, type RelayWsData} from './relay';
import {QUEUE_MAX, MSG_MAX} from '../../../engine/shared/ws-pipe';
function socket(data: RelayWsData) {
  return {data, frames: [] as string[], codes: [] as number[], bufferedAmount: 0,
    send(raw: string) {this.frames.push(raw); return raw.length;},
    close(code = 1000) {this.codes.push(code);}};
}
function rig() {
  const relay = new Relay(() => {});
  const engine = socket({relay: 'engine', engineId: 'e'});
  const device = socket({relay: 'device', engineId: 'e', connId: 'c'});
  relay.open(engine); relay.open(device);
  relay.message(device, JSON.stringify({t: 'r-auth', spki: 'scratch', sig: 'scratch'}));
  relay.message(engine, JSON.stringify({t: 'r-accept', c: 'c'}));
  return {relay, engine, device};
}
test('a slow device is closed at the byte bound rather than queued forever', () => {
  const {relay, engine, device} = rig();
  device.bufferedAmount = QUEUE_MAX;
  relay.message(engine, JSON.stringify({t: 'r', c: 'c', f: 'opaque'}));
  expect(device.codes).toEqual([1009]);
  expect(engine.codes).toEqual([]);
  expect(JSON.parse(engine.frames.at(-1)!)).toEqual({t: 'r-close', c: 'c', code: 1009});
  relay.close(engine);
});
test('the shared engine send queue is bounded too, and releases all affected devices', () => {
  const {relay, engine, device} = rig();
  engine.bufferedAmount = QUEUE_MAX;
  relay.message(device, 'opaque');
  expect(engine.codes).toEqual([1009]);
  expect(device.codes).toEqual([4404]);
});
test('logical payload bounds use Unicode bytes independently of envelope escaping', () => {
  const {relay, engine, device} = rig();
  const payload = '"\\\n雪'.repeat(50_000);
  relay.message(device, payload);
  expect(JSON.parse(engine.frames.at(-1)!).f).toBe(payload);
  relay.message(engine, JSON.stringify({t: 'r', c: 'c', f: '雪'.repeat(Math.floor(MSG_MAX / 3) + 1)}));
  expect(device.codes).toEqual([1009]);
  relay.close(engine);
});
test('binary and oversized pre-auth proofs are refused without forwarding', () => {
  const relay = new Relay(() => {});
  const engine = socket({relay: 'engine', engineId: 'e'});
  relay.open(engine);
  const device = socket({relay: 'device', engineId: 'e', connId: 'c'});
  relay.open(device);
  relay.message(device, 'x'.repeat(16 * 1024 + 1));
  expect(device.codes).toEqual([1009]);
  expect(engine.frames.every((f) => JSON.parse(f).t !== 'r-open')).toBe(true);
  const binary = socket({relay: 'device', engineId: 'e', connId: 'b'});
  relay.open(binary); relay.message(binary, new Uint8Array([1]));
  expect(binary.codes).toEqual([1003]);
  relay.close(binary); relay.close(engine);
});
