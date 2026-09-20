import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {
  EngineOffline,
  engineCapFetch,
  setEngineTunnel,
  clearEngineTunnel,
  type EngineTunnel
} from '../engine/contract';
const BASE = 'http://10.0.0.7:7788';

function fakeTunnel(): EngineTunnel & {
  isReady: boolean;
  graceOutcome: boolean;
  graceCalls: number;
  fetches: string[];
} {
  const t = {
    isReady: false,
    graceOutcome: false,
    graceCalls: 0,
    fetches: [] as string[],
    ready() {
      return t.isReady;
    },
    fetch(url: string) {
      t.fetches.push(url);
      return Promise.resolve(new Response('{}'));
    },
    whenReady(_graceMs: number, signal?: AbortSignal) {
      t.graceCalls++;
      if (t.isReady) return Promise.resolve(true);
      if (signal?.aborted) return Promise.resolve(false);
      return Promise.resolve(t.graceOutcome);
    }
  };
  return t;
}
describe('engineCapFetch: sealed tunnel only', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('plaintext fetch to an engine origin: the fallback is dead');
    });
  });
  afterEach(() => {
    clearEngineTunnel(BASE);
    vi.restoreAllMocks();
  });
  test('a ready tunnel carries the request; the global fetch is never touched', async () => {
    const t = fakeTunnel();
    t.isReady = true;
    setEngineTunnel(BASE, t);
    const res = await engineCapFetch(BASE + '/session/p/rename', {method: 'POST'});
    expect(res.ok).toBe(true);
    expect(t.fetches).toEqual([BASE + '/session/p/rename']);
    expect(t.graceCalls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test('no tunnel for the origin: EngineOffline, no plaintext', async () => {
    await expect(engineCapFetch('http://unknown:1/x', {method: 'POST'})).rejects.toBeInstanceOf(
      EngineOffline
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test('pipe down but reseals within the grace: the request rides the fresh pipe', async () => {
    const t = fakeTunnel();
    t.isReady = false;
    t.graceOutcome = true;
    setEngineTunnel(BASE, t);
    const res = await engineCapFetch(BASE + '/plugin/usage/card');
    expect(res.ok).toBe(true);
    expect(t.graceCalls).toBe(1);
    expect(t.fetches).toEqual([BASE + '/plugin/usage/card']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test('pipe stays down through the grace: EngineOffline, never plaintext', async () => {
    const t = fakeTunnel();
    t.isReady = false;
    t.graceOutcome = false;
    setEngineTunnel(BASE, t);
    await expect(
      engineCapFetch(BASE + '/session/p/rename', {method: 'POST'})
    ).rejects.toBeInstanceOf(EngineOffline);
    expect(t.graceCalls).toBe(1);
    expect(t.fetches).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test('the caller AbortSignal cuts the grace short to EngineOffline', async () => {
    const t = fakeTunnel();
    t.isReady = false;
    setEngineTunnel(BASE, t);
    const ac = new AbortController();
    ac.abort();
    await expect(engineCapFetch(BASE + '/history', {signal: ac.signal})).rejects.toBeInstanceOf(
      EngineOffline
    );
    expect(t.fetches).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
