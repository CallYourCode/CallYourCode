import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The image cache is a fake here (no IndexedDB in jsdom): a hit returns an
// object URL string, a miss null.
const cache = new Map<string, string>();
const putImage = vi.fn();
vi.mock('../features/media/imageCache', () => ({
  cachedImageUrl: vi.fn(async (url: string) => cache.get(url) ?? null),
  putImage: (...args: unknown[]) => putImage(...args)
}));

const logs: {event: string; fields: Record<string, unknown>}[] = [];
vi.mock('@/shared/logging', () => ({
  cyclog: (event: string, fields: Record<string, unknown> = {}) => logs.push({event, fields})
}));

import {clearEngineTunnel, setEngineTunnel, type EngineTunnel} from '../engine/contract';
import {
  ImageResolveError,
  MEDIA_RETRY_WINDOW_MS,
  MEDIA_WIRE_WAIT_MS,
  resolveImageSource,
  srcScheme
} from '../features/media/resolveImage';
import {openImageViewer} from '../features/media/imageViewer';

const BASE = 'http://10.0.0.7:7788';
const KEY = BASE + '/upload/srv-up-1';

function fakeTunnel(): EngineTunnel & {isReady: boolean; up(): void; fetches: string[]; reply: () => Response} {
  const waiters = new Set<(v: boolean) => void>();
  const t = {
    isReady: false,
    fetches: [] as string[],
    reply: () => new Response(new Blob([new Uint8Array(16)], {type: 'image/png'}), {status: 200}),
    ready() {
      return t.isReady;
    },
    up() {
      t.isReady = true;
      for (const w of [...waiters]) {
        waiters.delete(w);
        w(true);
      }
    },
    fetch(url: string) {
      t.fetches.push(url);
      return Promise.resolve(t.reply());
    },
    whenReady(graceMs: number, signal?: AbortSignal) {
      if (t.isReady) return Promise.resolve(true);
      if (signal?.aborted) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(false), graceMs);
        const settle = (v: boolean) => {
          waiters.delete(settle);
          clearTimeout(timer);
          resolve(v);
        };
        signal?.addEventListener('abort', () => settle(false), {once: true});
        waiters.add(settle);
      });
    }
  };
  return t;
}

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
};

let createObjectURL: typeof URL.createObjectURL;
let revokeObjectURL: typeof URL.revokeObjectURL;
let mintedN = 0;
const revoked: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  cache.clear();
  logs.length = 0;
  revoked.length = 0;
  putImage.mockClear();
  mintedN = 0;
  createObjectURL = URL.createObjectURL;
  revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:test/${++mintedN}`;
  URL.revokeObjectURL = (u: string) => {
    revoked.push(u);
  };
});
afterEach(() => {
  clearEngineTunnel(BASE);
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const png = () => new Blob([new Uint8Array(8)], {type: 'image/png'});

describe('resolveImageSource: one order for the bubble and the viewer', () => {
  test('a non-http key is applied as-is, nothing is asked', async () => {
    const bytes = vi.fn(async () => png());
    const found = await resolveImageSource({key: 'data:image/png;base64,AAAA', bytes});
    expect(found).toEqual({src: 'data:image/png;base64,AAAA', how: 'direct', minted: false});
    expect(bytes).not.toHaveBeenCalled();
  });

  test('the cache under the engine key wins over the bytes, the local URL and the wire', async () => {
    cache.set(KEY, 'blob:cached/1');
    const bytes = vi.fn(async () => png());
    const local = vi.fn(() => 'blob:local/1');
    const t = fakeTunnel();
    t.isReady = true;
    setEngineTunnel(BASE, t);
    const found = await resolveImageSource({key: KEY, bytes, local});
    expect(found).toEqual({src: 'blob:cached/1', how: 'cache', minted: true});
    expect(bytes).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(t.fetches).toEqual([]);
  });

  test('a cache miss takes the bytes this device holds (a vaulted shown picture) before the local URL', async () => {
    const bytes = vi.fn(async () => png());
    const local = vi.fn(() => 'blob:local/1');
    const found = await resolveImageSource({key: KEY, bytes, local});
    expect(found).toEqual({src: 'blob:test/1', how: 'bytes', minted: true});
    expect(local).not.toHaveBeenCalled();
  });

  test('bytes that throw or come back empty are a miss, not a failure', async () => {
    const local = vi.fn(() => 'blob:local/1');
    const found = await resolveImageSource({
      key: KEY,
      bytes: async () => {
        throw new Error('vault closed');
      },
      local
    });
    expect(found).toEqual({src: 'blob:local/1', how: 'local', minted: false});
    const again = await resolveImageSource({key: KEY, bytes: async () => null, local});
    expect(again.how).toBe('local');
  });

  test('the local URL is read at resolve time (never a URL captured when the item was built) and is not the resolver to revoke', async () => {
    let current: string | undefined = undefined;
    const local = vi.fn(() => current);
    const t = fakeTunnel();
    t.isReady = true;
    setEngineTunnel(BASE, t);
    current = 'blob:local/live';
    const found = await resolveImageSource({key: KEY, local});
    expect(local).toHaveBeenCalledTimes(1);
    expect(found).toEqual({src: 'blob:local/live', how: 'local', minted: false});
    expect(t.fetches).toEqual([]);
  });

  test('nothing held and the wire up: one fetch, the cache is filled under the same key', async () => {
    const t = fakeTunnel();
    t.isReady = true;
    setEngineTunnel(BASE, t);
    const found = await resolveImageSource({key: KEY, local: () => undefined});
    expect(found).toEqual({src: 'blob:test/1', how: 'wire', minted: true});
    expect(t.fetches).toEqual([KEY]);
    expect(putImage).toHaveBeenCalledTimes(1);
    expect(putImage.mock.calls[0][0]).toBe(KEY);
  });

  test('nothing held and the wire down: no fetch burns while it dials; wire-down after the gate', async () => {
    const t = fakeTunnel();
    setEngineTunnel(BASE, t);
    const waiting = vi.fn();
    const p = resolveImageSource({key: KEY}, {onWaiting: waiting});
    const outcome = p.then(
      () => 'resolved',
      (e: unknown) => e
    );
    await flush();
    expect(waiting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MEDIA_RETRY_WINDOW_MS + 5_000);
    await flush();
    expect(t.fetches).toEqual([]);
    await vi.advanceTimersByTimeAsync(MEDIA_WIRE_WAIT_MS);
    await flush();
    const err = await outcome;
    expect(err).toBeInstanceOf(ImageResolveError);
    expect((err as ImageResolveError).reason).toBe('wire-down');
  });

  test('the engine answers 404: gone, at once, no retry window', async () => {
    const t = fakeTunnel();
    t.isReady = true;
    t.reply = () => new Response('', {status: 404});
    setEngineTunnel(BASE, t);
    const outcome = resolveImageSource({key: KEY}).then(
      () => 'resolved',
      (e: unknown) => e
    );
    await flush();
    const err = await outcome;
    expect(err).toBeInstanceOf(ImageResolveError);
    expect((err as ImageResolveError).reason).toBe('gone');
    expect((err as ImageResolveError).status).toBe(404);
    expect(t.fetches).toEqual([KEY]);
  });

  test('fresh skips the cache, the bytes and the local URL: the wire refills the cache row', async () => {
    cache.set(KEY, 'blob:cached/stale');
    const bytes = vi.fn(async () => png());
    const local = vi.fn(() => 'blob:local/dead');
    const t = fakeTunnel();
    t.isReady = true;
    setEngineTunnel(BASE, t);
    const found = await resolveImageSource({key: KEY, bytes, local}, {fresh: true});
    expect(found.how).toBe('wire');
    expect(bytes).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(t.fetches).toEqual([KEY]);
    expect(putImage).toHaveBeenCalledTimes(1);
    expect(putImage.mock.calls[0][0]).toBe(KEY);
  });

  test('srcScheme names what the img was handed', () => {
    expect(srcScheme('blob:http://x/abc')).toBe('blob');
    expect(srcScheme('http://x/a.png')).toBe('http');
    expect(srcScheme('data:image/png;base64,AA')).toBe('data');
    expect(srcScheme('')).toBe('(none)');
  });
});

describe('image viewer: resolves like the bubble, tap to load instead of a broken picture', () => {
  const viewer = () => document.querySelector<HTMLElement>('.cyc-imgview');
  const mainImg = () => document.querySelector<HTMLImageElement>('.cyc-imgview-img:not(.cyc-imgview-neighbour)')!;
  const tap = () => document.querySelector<HTMLElement>('.cyc-imgview-tap');
  const closeViewer = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    await flush();
  };
  const logged = (event: string) => logs.filter((l) => l.event === event);

  test('a cache hit under the engine key paints and is logged as such; the local URL is never asked', async () => {
    cache.set(KEY, 'blob:cached/1');
    const local = vi.fn(() => 'blob:local/1');
    openImageViewer([{url: KEY, name: 'one.png', local}], 0);
    await flush();
    expect(mainImg().getAttribute('src')).toBe('blob:cached/1');
    expect(local).not.toHaveBeenCalled();
    expect(logged('viewer.image.src')).toEqual([
      {event: 'viewer.image.src', fields: {key: KEY, how: 'cache', scheme: 'blob', name: 'one.png', fresh: false}}
    ]);
    expect(tap()).toBeNull();
    await closeViewer();
    expect(revoked).toContain('blob:cached/1');
  });

  test('nothing held and the wire down: a visible tap card, no src; a tap once the wire is back paints', async () => {
    const t = fakeTunnel();
    setEngineTunnel(BASE, t);
    openImageViewer([{url: KEY, name: 'one.png', local: () => undefined}], 0);
    await flush();
    // While the wire dials the stage says so (no silent black box).
    const waiting = document.querySelector<HTMLElement>('.cyc-imgview-waiting');
    expect(waiting).not.toBeNull();
    expect(waiting!.textContent).toMatch(/waiting for the engine/i);
    expect(tap()).toBeNull();
    await vi.advanceTimersByTimeAsync(MEDIA_WIRE_WAIT_MS + 10);
    await flush();
    expect(document.querySelector('.cyc-imgview-waiting')).toBeNull();
    expect(mainImg().getAttribute('src')).toBeNull();
    const card = tap();
    expect(card).not.toBeNull();
    expect(card!.textContent).toMatch(/tap to load/i);
    expect(viewer()).not.toBeNull();
    expect(logged('viewer.image.error')).toEqual([
      expect.objectContaining({fields: expect.objectContaining({key: KEY, scheme: '(none)', reason: 'wire-down'})})
    ]);

    t.up();
    // The stage captures the pointer on pointerdown and a captured click lands
    // on the stage (which the overlay reads as close); the card keeps the
    // pointer so the tap is a tap on the card.
    const stage = document.querySelector<HTMLElement>('.cyc-imgview-stage')!;
    const stageDown = vi.fn();
    stage.addEventListener('pointerdown', stageDown);
    card!.dispatchEvent(new Event('pointerdown', {bubbles: true, cancelable: true}));
    expect(stageDown).not.toHaveBeenCalled();
    card!.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
    await flush();
    expect(viewer()).not.toBeNull();
    expect(tap()).toBeNull();
    expect(t.fetches).toEqual([KEY]);
    expect(mainImg().getAttribute('src')).toMatch(/^blob:test\//);
    expect(logged('viewer.image.src').at(-1)!.fields).toMatchObject({how: 'wire', scheme: 'blob'});
    await closeViewer();
  });

  test('a released local URL (the img errors on it) goes straight to the wire, never the broken icon', async () => {
    const t = fakeTunnel();
    t.isReady = true;
    setEngineTunnel(BASE, t);
    openImageViewer([{url: KEY, name: 'one.png', local: () => 'blob:local/released'}], 0);
    await flush();
    expect(mainImg().getAttribute('src')).toBe('blob:local/released');
    expect(t.fetches).toEqual([]);

    mainImg().dispatchEvent(new Event('error'));
    await flush();
    expect(t.fetches).toEqual([KEY]);
    expect(mainImg().getAttribute('src')).toMatch(/^blob:test\//);
    expect(tap()).toBeNull();
    expect(logged('viewer.image.error')).toEqual([
      expect.objectContaining({fields: expect.objectContaining({scheme: 'blob', how: 'local', reason: 'img-error'})})
    ]);
    expect(logged('viewer.image.src').map((l) => l.fields.how)).toEqual(['local', 'wire']);
    await closeViewer();
  });

  test('the engine says gone: a plain line, not a tap card, not a broken picture', async () => {
    const t = fakeTunnel();
    t.isReady = true;
    t.reply = () => new Response('', {status: 404});
    setEngineTunnel(BASE, t);
    openImageViewer([{url: KEY, name: 'one.png'}], 0);
    await flush();
    expect(mainImg().getAttribute('src')).toBeNull();
    expect(tap()).toBeNull();
    const gone = document.querySelector<HTMLElement>('.cyc-imgview-gone');
    expect(gone).not.toBeNull();
    expect(gone!.textContent).toMatch(/no longer on disk/i);
    await closeViewer();
  });

  test('paging away clears the card; the slot that failed resolves again when paged back to', async () => {
    const t = fakeTunnel();
    setEngineTunnel(BASE, t);
    cache.set(KEY + '-two', 'blob:cached/2');
    openImageViewer(
      [
        {url: KEY, name: 'one.png'},
        {url: KEY + '-two', name: 'two.png'}
      ],
      0
    );
    await flush();
    await vi.advanceTimersByTimeAsync(MEDIA_WIRE_WAIT_MS + 10);
    await flush();
    expect(tap()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
    await flush();
    expect(tap()).toBeNull();
    expect(mainImg().getAttribute('src')).toBe('blob:cached/2');
    await closeViewer();
  });
});
