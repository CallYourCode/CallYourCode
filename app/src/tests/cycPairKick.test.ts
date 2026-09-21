import {expect, test, vi} from 'vitest';
import {WsEngineClient} from '../engine/client';

/* THE STUCK-AT-PAIRING RACE (engine/client.ts). The engine refuses an unpaired
 * device, the client parks on held='pairing' and waits for PAIR. But a PAIR
 * tapped while a dial attempt was still in flight had its redial swallowed by
 * dial()'s in-flight guard, and when that attempt then failed the client
 * parked forever: "Pairing..." until a reload. paired()/trustEngine() now
 * leave a rekey kick, and the failure path turns the park into a reconnect.
 * These pin the park-or-retry seam both ways. */

/* eslint-disable @typescript-eslint/no-explicit-any */
function mk() {
  const c = new WsEngineClient('ws://pair-kick.test:7791/ws', {schedule: () => {}}) as any;
  c.scheduleReconnect = vi.fn();
  return c;
}

test('a PAIR that landed during the failed attempt turns the park into a reconnect', async () => {
  const c = mk();
  c.dialing = true; // an attempt in flight: paired()'s own dial() is swallowed
  await c.paired('user@host');
  c.held = 'pairing'; // that in-flight attempt now fails with unknown-device

  expect(c.retryAfterRekey()).toBe(true);
  expect(c.held).toBeNull();
  expect(c.scheduleReconnect).toHaveBeenCalledTimes(1);

  // the kick is spent: a later failure parks normally again
  c.held = 'pairing';
  expect(c.retryAfterRekey()).toBe(false);
  expect(c.held).toBe('pairing');
});

test('with no rekey the pairing park stands: waiting on the user is correct', () => {
  const c = mk();
  c.held = 'pairing';
  expect(c.retryAfterRekey()).toBe(false);
  expect(c.held).toBe('pairing');
  expect(c.scheduleReconnect).not.toHaveBeenCalled();
});

test('trustEngine during the failed attempt retries instead of re-asking', async () => {
  const c = mk();
  c.dialing = true;
  await c.trustEngine();
  c.held = 'identity';
  expect(c.retryAfterRekey()).toBe(true);
  expect(c.held).toBeNull();
  expect(c.scheduleReconnect).toHaveBeenCalledTimes(1);
});
