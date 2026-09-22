import {beforeEach, expect, test, vi} from 'vitest';

/* THE PAIR TAP MUST NEVER DIE IN AN OPTIONAL CHAIN (live 2026-09-22, hosted
 * first-open): pairEngine used to be `connOf(engineKey)?.client.paired(...)`,
 * so a key miss (a config row without a url hands the screen '' as the engine
 * key) silently dropped the tap. The refused client stays parked on
 * held='pairing' forever, "Pairing..." until a reload. The fallback unparks
 * every NOT-connected client with the fresh key and never touches connected
 * ones. */

/* vi.mock factories are hoisted above every declaration, so the fakes must
 * come from vi.hoisted() or the factory reads them before initialization. */
const {paired, fakeConns} = vi.hoisted(() => {
  const paired = {a: vi.fn(), b: vi.fn(), c: vi.fn()};
  const fakeConns = [
    {key: 'ws://a.test/ws', state: 'disconnected', client: {paired: paired.a}},
    {key: 'ws://b.test/ws', state: 'connected', client: {paired: paired.b}},
    {key: 'ws://c.test/ws', state: 'connecting', client: {paired: paired.c}}
  ];
  return {paired, fakeConns};
});

vi.mock('../engine/store/registry', () => ({
  conns: fakeConns,
  connOf: (k: string) => fakeConns.find((c) => c.key === k)
}));
vi.mock('@/shared/logging', () => ({cyclog: vi.fn()}));

import {pairEngine} from '../engine/store/handlers/security';

beforeEach(() => {
  paired.a.mockClear();
  paired.b.mockClear();
  paired.c.mockClear();
});

test('a matching engine key pairs exactly that client', async () => {
  await pairEngine('ws://b.test/ws', 'user@host');
  expect(paired.b).toHaveBeenCalledWith('user@host');
  expect(paired.a).not.toHaveBeenCalled();
  expect(paired.c).not.toHaveBeenCalled();
});

test("a missed key ('' from a url-less config row) unparks every non-connected client", async () => {
  await pairEngine('', 'user@host');
  expect(paired.a).toHaveBeenCalledWith('user@host'); // disconnected: unparked
  expect(paired.c).toHaveBeenCalledWith('user@host'); // mid-dial: rekeyed
  expect(paired.b).not.toHaveBeenCalled(); // connected: never blipped
});
