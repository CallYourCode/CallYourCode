import {beforeEach, describe, expect, test, vi} from 'vitest';

// The wire and the store are seams: engineImageBlob is the cache-first byte
// loader (contract.ts), putNotifIcon the cyc-avatars row writer. Everything
// between them (key derivation, data-URI encoding, dedupe, retry) runs real.
const {engineImageBlob, putNotifIcon} = vi.hoisted(() => ({
  engineImageBlob: vi.fn(),
  putNotifIcon: vi.fn((_row: unknown) => Promise.resolve(null))
}));
vi.mock('../engine/contract', () => ({
  engineImageBlob,
  engineObjectUrl: vi.fn(),
  cachedImageObjectUrls: vi.fn(() => Promise.resolve(new Map<string, string>()))
}));
vi.mock('../features/media/notifIconDb', () => ({putNotifIcon}));

import {notifIconKey, syncNotifAvatar} from '../features/media/notifAvatars';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  engineImageBlob.mockReset();
  putNotifIcon.mockClear();
  putNotifIcon.mockResolvedValue(null);
});

describe('notification icons: the page prepares what the sealed push cannot carry', () => {
  test('a photo-less session stores the deterministic name-derived SVG data URI', async () => {
    await syncNotifAvatar({id: 'sess-fallback', name: 'Relay'});
    expect(putNotifIcon).toHaveBeenCalledTimes(1);
    const row = putNotifIcon.mock.calls[0][0] as {sessionId: string; icon: string; key: string};
    expect(row.sessionId).toBe('sess-fallback');
    expect(row.key).toBe('fallback:Relay');
    // jsdom has no canvas, so the raster step yields the SVG data URI itself;
    // either way the icon is a self-contained data URI, fetchable by no one.
    expect(row.icon.startsWith('data:image/')).toBe(true);
    expect(decodeURIComponent(row.icon)).toContain('<svg');
    expect(engineImageBlob).not.toHaveBeenCalled();
  });

  test('a session with a photo stores the thumbnail bytes as a data URI', async () => {
    engineImageBlob.mockResolvedValue(new Blob(['jpeg-bytes'], {type: 'image/jpeg'}));
    const avatarUrl = 'https://eng.example/session-photo/abc?v=3';
    await syncNotifAvatar({id: 'sess-photo', name: 'Beacon', avatarUrl});
    await flush(); // FileReader settles on a macrotask

    expect(engineImageBlob).toHaveBeenCalledWith(avatarUrl + '&w=128');
    expect(putNotifIcon).toHaveBeenCalledTimes(1);
    const row = putNotifIcon.mock.calls[0][0] as {sessionId: string; icon: string; key: string};
    expect(row.sessionId).toBe('sess-photo');
    expect(row.key).toBe('photo:' + avatarUrl);
    expect(row.icon.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  test('unchanged sessions write once; a photo edit (new ?v) writes again', async () => {
    const s = {id: 'sess-dedupe', name: 'Quiet'};
    await syncNotifAvatar(s);
    await syncNotifAvatar(s);
    expect(putNotifIcon).toHaveBeenCalledTimes(1);

    engineImageBlob.mockResolvedValue(new Blob(['x'], {type: 'image/png'}));
    await syncNotifAvatar({...s, avatarUrl: 'https://eng.example/session-photo/q?v=9'});
    expect(putNotifIcon).toHaveBeenCalledTimes(2);
    expect(
      notifIconKey({name: 'Quiet', avatarUrl: 'https://eng.example/session-photo/q?v=9'})
    ).toBe('photo:https://eng.example/session-photo/q?v=9');
  });

  test('a failed fetch writes nothing and the next roster pass retries', async () => {
    engineImageBlob.mockRejectedValue(new Error('offline'));
    const s = {
      id: 'sess-retry',
      name: 'Flaky',
      avatarUrl: 'https://eng.example/session-photo/f?v=1'
    };
    await syncNotifAvatar(s);
    expect(putNotifIcon).not.toHaveBeenCalled();

    engineImageBlob.mockResolvedValue(new Blob(['ok'], {type: 'image/png'}));
    await syncNotifAvatar(s);
    await flush();
    expect(putNotifIcon).toHaveBeenCalledTimes(1);
  });
});
