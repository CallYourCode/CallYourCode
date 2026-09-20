import {beforeEach, describe, expect, test, vi} from 'vitest';

/* engineImageBlob (contract.ts), the byte loader under avatars and
 * notification icons, run REAL against a mocked durable cache and a fake
 * sealed tunnel: cache-first (a hit answers with no wire at all, which is what
 * "serves offline" means), fill-on-fetch, offline rejection on a miss. */

const {cachedImageBlob, putImage} = vi.hoisted(() => ({
  cachedImageBlob: vi.fn(),
  putImage: vi.fn()
}));
vi.mock('../features/media/imageCache', () => ({
  cachedImageBlob,
  putImage,
  cachedImageUrl: vi.fn(() => Promise.resolve(null)),
  cachedImagesMatching: vi.fn(() => Promise.resolve(new Map<string, Blob>()))
}));

import {
  clearEngineTunnel,
  engineImageBlob,
  EngineOffline,
  setEngineTunnel,
  type EngineTunnel
} from '../engine/contract';

const BASE = 'https://eng.test';
const URL_A = BASE + '/session-photo/a?v=1&w=128';

beforeEach(() => {
  cachedImageBlob.mockReset();
  putImage.mockReset();
  clearEngineTunnel(BASE);
});

describe('engineImageBlob: durable cache first, wire fills, offline still serves', () => {
  test('a cache hit answers with NO tunnel registered: cached avatars work offline', async () => {
    const cached = new Blob(['bytes'], {type: 'image/jpeg'});
    cachedImageBlob.mockResolvedValue(cached);
    await expect(engineImageBlob(URL_A)).resolves.toBe(cached);
    expect(putImage).not.toHaveBeenCalled();
  });

  test('a miss goes over the sealed tunnel and fills the cache', async () => {
    cachedImageBlob.mockResolvedValue(null);
    const fresh = new Blob(['wire-bytes'], {type: 'image/jpeg'});
    const tunnel: EngineTunnel = {
      ready: () => true,
      whenReady: async () => true,
      fetch: vi.fn(async () => ({ok: true, blob: async () => fresh}) as unknown as Response)
    };
    setEngineTunnel(BASE, tunnel);
    await expect(engineImageBlob(URL_A)).resolves.toBe(fresh);
    expect(tunnel.fetch).toHaveBeenCalledWith(URL_A, undefined);
    expect(putImage).toHaveBeenCalledWith(URL_A, fresh);
  });

  test('a miss with no tunnel rejects EngineOffline (the caller keeps its fallback)', async () => {
    cachedImageBlob.mockResolvedValue(null);
    await expect(engineImageBlob(URL_A)).rejects.toBeInstanceOf(EngineOffline);
    expect(putImage).not.toHaveBeenCalled();
  });
});
