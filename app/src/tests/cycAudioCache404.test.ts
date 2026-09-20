import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {resolveAudioUrl} from '../audio/audioCache';
import {setEngineTunnel, clearEngineTunnel, type EngineTunnel} from '../engine/contract';

// A 404 on an audio-clip fetch means the clip is absent (a message that
// references audio but has no stored clip, common when voice is off). That is a
// normal degradable condition: the awaiting caller still sees the rejection and
// shows no audio, but the inflight-cleanup promise (which no caller awaits) must
// not leak its rejection to the window as an uncaught "audio 404" page error.
const BASE = 'http://engine-a.test:7788';
const clipUrl = (id: string) => `${BASE}/audio/${id}.mp3`;

describe('an absent (404) audio clip degrades gracefully', () => {
  let respond: (url: string) => Response;
  let minted: number;
  const tunnel: EngineTunnel = {
    ready: () => true,
    whenReady: () => Promise.resolve(true),
    fetch: (url) => Promise.resolve(respond(url))
  };

  beforeEach(() => {
    minted = 0;
    setEngineTunnel(BASE, tunnel);
    URL.createObjectURL = vi.fn(() => `blob:cyc/${++minted}`);
    URL.revokeObjectURL = vi.fn(() => {});
  });
  afterEach(() => {
    clearEngineTunnel(BASE);
    vi.restoreAllMocks();
  });

  test('a 404 rejects the awaiting caller but never leaks an unhandled rejection', async () => {
    respond = () => new Response(null, {status: 404});

    const leaked: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      leaked.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // A single caller: the inflight-cleanup promise has no second consumer, so
      // this is exactly the path that used to escape to window.onunhandledrejection.
      await expect(resolveAudioUrl('gone1', clipUrl('gone1'))).rejects.toThrow('audio 404');
      // Give any leaked rejection two macrotask boundaries to surface.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(leaked).toEqual([]);
  });

  test('a successful clip still resolves to a sealed blob url', async () => {
    respond = () => new Response(new Uint8Array([1, 2, 3]));
    const url = await resolveAudioUrl('ok1', clipUrl('ok1'));
    expect(url.startsWith('blob:')).toBe(true);
  });

  test('a non-404 failure still surfaces to the caller', async () => {
    respond = () => new Response(null, {status: 500});
    await expect(resolveAudioUrl('err1', clipUrl('err1'))).rejects.toThrow('audio 500');
  });
});
