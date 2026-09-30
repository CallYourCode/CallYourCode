import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const engineCapFetch = vi.fn();
vi.mock('../engine/contract', () => ({
  engineCapFetch: (...a: unknown[]) => engineCapFetch(...a),
  engineObjectUrl: vi.fn((u: string) => Promise.resolve(u)),
  whenEngineReady: vi.fn(() => Promise.resolve(true)),
  docUrl: (id: string) => `doc://${id}`
}));

import {fetchBinary, mediaKindOf, transferTimeoutMs} from '../features/media/binary';
import {openMediaViewer} from '../features/media/mediaViewer';
import type {CycFileRef} from '../types';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

type FakeRes = {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  blob?: Blob;
  chunks?: Uint8Array[];
};
function res(opts: FakeRes) {
  const headers = opts.headers ?? {};
  const chunks = opts.chunks;
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: {get: (k: string) => headers[k.toLowerCase()] ?? null},
    body: chunks
      ? {
          getReader() {
            let i = 0;
            return {
              read: async () =>
                i < chunks.length ? {done: false, value: chunks[i++]} : {done: true, value: undefined}
            };
          }
        }
      : null,
    blob: async () => opts.blob ?? new Blob([])
  };
}

describe('mediaKindOf: extension picks the playable kind', () => {
  test('video extensions', () => {
    expect(mediaKindOf('clip.mp4')).toBe('video');
    expect(mediaKindOf('scene.MOV')).toBe('video');
    expect(mediaKindOf('capture.webm')).toBe('video');
  });
  test('audio extensions', () => {
    expect(mediaKindOf('song.mp3')).toBe('audio');
    expect(mediaKindOf('note.m4a')).toBe('audio');
  });
  test('anything else is not playable', () => {
    expect(mediaKindOf('archive.zip')).toBeNull();
    expect(mediaKindOf('notes.txt')).toBeNull();
    expect(mediaKindOf('noext')).toBeNull();
  });
});

describe('transferTimeoutMs: no longer a flat 30 s', () => {
  test('a 7.5 MB file gets well over 30 s', () => {
    expect(transferTimeoutMs(7.5 * 1024 * 1024)).toBeGreaterThan(120_000);
  });
  test('unknown size gets a generous default', () => {
    expect(transferTimeoutMs(0)).toBe(300_000);
  });
  test('capped so it can never hang forever', () => {
    expect(transferTimeoutMs(10 * 1024 * 1024 * 1024)).toBe(30 * 60_000);
  });
});

describe('fetchBinary: streams progress and keeps the content-type', () => {
  beforeEach(() => engineCapFetch.mockReset());

  test('a readable body reports cumulative bytes and returns a typed blob', async () => {
    engineCapFetch.mockResolvedValue(
      res({
        headers: {'content-length': '10', 'content-type': 'video/mp4'},
        chunks: [new Uint8Array(5), new Uint8Array(5)]
      })
    );
    const seen: Array<[number, number]> = [];
    const blob = await fetchBinary('doc://d/raw', {onProgress: (r, t) => seen.push([r, t])});
    expect(seen).toEqual([
      [5, 10],
      [10, 10]
    ]);
    expect(blob.size).toBe(10);
    expect(blob.type).toBe('video/mp4');
  });

  test('no readable body falls back to a single .blob() read', async () => {
    const only = new Blob(['abcd'], {type: 'application/pdf'});
    engineCapFetch.mockResolvedValue(res({blob: only}));
    const seen: Array<[number, number]> = [];
    const blob = await fetchBinary('doc://d/raw', {onProgress: (r, t) => seen.push([r, t])});
    expect(blob).toBe(only);
    expect(seen).toEqual([[4, 4]]);
  });

  test('a non-ok response throws', async () => {
    engineCapFetch.mockResolvedValue(res({ok: false, status: 500}));
    await expect(fetchBinary('doc://d/raw')).rejects.toThrow('HTTP 500');
  });
});

describe('openMediaViewer: progress, playback, save-path and error states', () => {
  const file = (name: string): CycFileRef => ({docId: 'd', name, fileKind: 'binary', size: 5});

  beforeEach(() => {
    engineCapFetch.mockReset();
    document.body.innerHTML = '';
    vi.stubGlobal('URL', {createObjectURL: vi.fn(() => 'blob:v'), revokeObjectURL: vi.fn()});
  });
  afterEach(() => {
    document.querySelector<HTMLElement>('.cyc-mv-back')?.click();
    vi.unstubAllGlobals();
    delete (navigator as {canShare?: unknown}).canShare;
    delete (navigator as {share?: unknown}).share;
    delete (navigator as {userAgent?: unknown}).userAgent;
    delete (navigator as {maxTouchPoints?: unknown}).maxTouchPoints;
    document.body.innerHTML = '';
  });

  test('a slow fetch shows a loading spinner and status line', async () => {
    engineCapFetch.mockReturnValue(new Promise(() => {}));
    openMediaViewer(file('clip.mp4'), 'doc://d/raw', 'video');
    await flush();
    expect(document.querySelector('.cyc-mv-loading')).not.toBeNull();
    expect(document.querySelector('.cyc-mv-status')?.textContent).toBe('Downloading\u2026');
    expect(document.querySelector('.cyc-mv-video')).toBeNull();
  });

  test('a video plays inline once the bytes arrive', async () => {
    engineCapFetch.mockResolvedValue(res({blob: new Blob(['x'], {type: 'video/mp4'})}));
    openMediaViewer(file('clip.mp4'), 'doc://d/raw', 'video');
    await flush();
    const v = document.querySelector<HTMLVideoElement>('video.cyc-mv-video');
    expect(v).not.toBeNull();
    expect(v!.hasAttribute('playsinline')).toBe(true);
    expect(v!.src).toContain('blob:');
    expect(document.querySelector<HTMLElement>('.cyc-mv-save')!.hidden).toBe(false);
  });

  test('a non-playable file on an iOS share-capable device offers a Save button', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {configurable: true, value: 5});
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
    Object.defineProperty(navigator, 'share', {configurable: true, value: vi.fn(() => Promise.resolve())});
    engineCapFetch.mockResolvedValue(res({blob: new Blob(['x'])}));
    openMediaViewer(file('archive.zip'), 'doc://d/raw', null);
    await flush();
    expect(document.querySelector('.cyc-mv-btn')?.textContent).toBe('Save');
    expect(document.querySelector('.cyc-mv-saved')).toBeNull();
  });

  test('a non-playable file on desktop (share API present) saves at once, no share sheet', async () => {
    // Desktop Chrome reports canShare({files}) true; the viewer must still save
    // straight to disk rather than offer a Save button that opens the share sheet.
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
    Object.defineProperty(navigator, 'share', {configurable: true, value: share});
    engineCapFetch.mockResolvedValue(res({blob: new Blob(['x'])}));
    openMediaViewer(file('archive.zip'), 'doc://d/raw', null);
    await flush();
    expect(document.querySelector('.cyc-mv-saved')).not.toBeNull();
    expect(document.querySelector('.cyc-mv-btn')).toBeNull();
    expect(share).not.toHaveBeenCalled();
  });

  test('a non-playable file with only a download link saves at once', async () => {
    engineCapFetch.mockResolvedValue(res({blob: new Blob(['x'])}));
    openMediaViewer(file('archive.zip'), 'doc://d/raw', null);
    await flush();
    expect(document.querySelector('.cyc-mv-saved')).not.toBeNull();
    expect(document.querySelector('.cyc-mv-btn')).toBeNull();
  });

  test('a failed fetch shows an error with a Retry button', async () => {
    engineCapFetch.mockResolvedValue(res({ok: false, status: 500}));
    openMediaViewer(file('clip.mp4'), 'doc://d/raw', 'video');
    await flush();
    expect(document.querySelector('.cyc-mv-error')).not.toBeNull();
    expect(document.querySelector('.cyc-mv-btn')?.textContent).toBe('Retry');
  });
});
