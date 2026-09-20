import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {engineFetch} from '../engine/store/engineFetch';
import {
  EngineOffline,
  setEngineTunnel,
  clearEngineTunnel,
  type EngineTunnel
} from '../engine/contract';
const WS = 'ws://engine-a.test:7788/ws';
const BASE = 'http://engine-a.test:7788';
describe('engineFetch seam', () => {
  let calls: {url: string; init?: RequestInit}[];
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const tunnel: EngineTunnel = {
    ready: () => true,
    fetch: (url, init) => {
      calls.push({url, init});
      return Promise.resolve(new Response('{}', {status: 200}));
    },
    whenReady: () => Promise.resolve(true)
  };
  beforeEach(() => {
    calls = [];
    setEngineTunnel(BASE, tunnel);

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('plaintext fetch: the fallback is dead');
    });
  });
  afterEach(() => {
    clearEngineTunnel(BASE);
    vi.restoreAllMocks();
  });
  test('builds the engine-origin URL from the ws key and rides the sealed tunnel', async () => {
    await engineFetch(WS, '/session/p1/rename', {method: 'POST'});
    expect(calls[0].url).toBe(BASE + '/session/p1/rename');
    expect(calls[0].init?.method).toBe('POST');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test('an origin with no tunnel rejects EngineOffline, never a plain fetch', async () => {
    await expect(engineFetch('ws://other.test:7788/ws', '/limits')).rejects.toBeInstanceOf(
      EngineOffline
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test('timeoutMs folds into an AbortSignal', async () => {
    await engineFetch(WS, '/x', {timeoutMs: 8000});
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);

    expect('timeoutMs' in (calls[0].init as object)).toBe(false);
  });
  test('an explicit signal wins over timeoutMs (the ...init spread contract)', async () => {
    const ctl = new AbortController();
    await engineFetch(WS, '/x', {timeoutMs: 8000, signal: ctl.signal});
    expect(calls[0].init?.signal).toBe(ctl.signal);
  });
  test('no timeout asked for: no signal invented', async () => {
    await engineFetch(WS, '/x');
    expect(calls[0].init?.signal).toBeUndefined();
  });
});
