import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The image cache is a fake here (no IndexedDB in jsdom): a hit returns an
// object URL string, a miss null.
const cache = new Map<string, string>();
vi.mock('../features/media/imageCache', () => ({
  cachedImageUrl: vi.fn(async (url: string) => cache.get(url) ?? null),
  putImage: vi.fn()
}));

import {clearEngineTunnel, setEngineTunnel, whenEngineReady, type EngineTunnel} from '../engine/contract';
import {MEDIA_RETRY_WINDOW_MS, MEDIA_WIRE_WAIT_MS, setTunnelSrc} from '../features/media/mediaBox';

const BASE = 'http://10.0.0.7:7788';
const URL_A = BASE + '/upload/srv-up-1';

// A tunnel whose readiness the test flips; whenReady waiters resolve on the
// flip (the real TunnelClient's signalReady), on their grace, or on abort.
function fakeTunnel(): EngineTunnel & {
  isReady: boolean;
  up(): void;
  fetches: string[];
  reply: () => Response;
  waiters: number;
} {
  const waiters = new Set<{resolve: (v: boolean) => void; cleanup: () => void}>();
  const t = {
    isReady: false,
    fetches: [] as string[],
    reply: () => new Response(new Blob([new Uint8Array(16)], {type: 'image/png'}), {status: 200}),
    get waiters() {
      return waiters.size;
    },
    ready() {
      return t.isReady;
    },
    up() {
      t.isReady = true;
      for (const w of [...waiters]) {
        waiters.delete(w);
        w.cleanup();
        w.resolve(true);
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
        const w = {resolve, cleanup: () => {}};
        const timer = setTimeout(() => settle(false), graceMs);
        const onAbort = () => settle(false);
        const settle = (v: boolean) => {
          waiters.delete(w);
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        };
        w.cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, {once: true});
        waiters.add(w);
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

describe('whenEngineReady: the wire gate for a media fetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    clearEngineTunnel(BASE);
    vi.useRealTimers();
  });

  test('a ready tunnel answers true at once', async () => {
    const t = fakeTunnel();
    t.isReady = true;
    setEngineTunnel(BASE, t);
    await expect(whenEngineReady(URL_A, 1000)).resolves.toBe(true);
  });

  test('no tunnel registered yet (a reload paints before the client exists): waits for the registration, then for the seal', async () => {
    let settled: boolean | null = null;
    void whenEngineReady(URL_A, 30_000).then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBeNull();

    const t = fakeTunnel();
    setEngineTunnel(BASE, t);
    await flush();
    expect(settled).toBeNull(); // registered, not sealed
    expect(t.waiters).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    t.up();
    await flush();
    expect(settled).toBe(true);
    expect(t.waiters).toBe(0);
  });

  test('the wire never comes up: false at maxMs, and the tunnel waiter is dropped', async () => {
    const t = fakeTunnel();
    setEngineTunnel(BASE, t);
    let settled: boolean | null = null;
    void whenEngineReady(URL_A, 10_000).then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    await flush();
    expect(settled).toBe(false);
    expect(t.waiters).toBe(0);
  });

  test('a tunnel for another origin does not open the gate', async () => {
    const other = fakeTunnel();
    other.isReady = true;
    setEngineTunnel('http://10.0.0.9:7788', other);
    let settled: boolean | null = null;
    void whenEngineReady(URL_A, 2_000).then((v) => (settled = v));
    await flush();
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(2_001);
    await flush();
    expect(settled).toBe(false);
    clearEngineTunnel('http://10.0.0.9:7788');
  });

  test('a re-registered tunnel (new client, same base) is the one asked', async () => {
    const first = fakeTunnel();
    setEngineTunnel(BASE, first);
    let settled: boolean | null = null;
    void whenEngineReady(URL_A, 30_000).then((v) => (settled = v));
    await flush();
    expect(first.waiters).toBe(1);

    const second = fakeTunnel();
    setEngineTunnel(BASE, second);
    await flush();
    expect(first.waiters).toBe(0); // the stale waiter is aborted
    expect(second.waiters).toBe(1);
    second.up();
    await flush();
    expect(settled).toBe(true);
  });

  test('an aborted signal settles false and frees the waiter', async () => {
    const t = fakeTunnel();
    setEngineTunnel(BASE, t);
    const ac = new AbortController();
    let settled: boolean | null = null;
    void whenEngineReady(URL_A, 30_000, ac.signal).then((v) => (settled = v));
    await flush();
    expect(t.waiters).toBe(1);
    ac.abort();
    await flush();
    expect(settled).toBe(false);
    expect(t.waiters).toBe(0);
  });
});

describe('setTunnelSrc: cache first, wire gate before the retry window, tap-to-load after', () => {
  let createObjectURL: typeof URL.createObjectURL;
  let revokeObjectURL: typeof URL.revokeObjectURL;
  let minted = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    cache.clear();
    minted = 0;
    createObjectURL = URL.createObjectURL;
    revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = () => `blob:test/${++minted}`;
    URL.revokeObjectURL = () => {};
  });
  afterEach(() => {
    clearEngineTunnel(BASE);
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    vi.useRealTimers();
  });

  function box(): {holder: HTMLDivElement; img: HTMLImageElement} {
    const holder = document.createElement('div');
    holder.className = 'cyc-media-box';
    const img = document.createElement('img');
    img.className = 'cyc-still';
    holder.append(img);
    document.body.append(holder);
    return {holder, img};
  }

  test('a cache hit paints from the cache and never touches the wire (no tunnel needed)', async () => {
    cache.set(URL_A, 'blob:cached/1');
    const {holder, img} = box();
    setTunnelSrc(img, URL_A);
    await flush();
    expect(img.getAttribute('src')).toBe('blob:cached/1');
    expect(holder.querySelector('.cyc-media-tap')).toBeNull();
    img.dispatchEvent(new Event('load'));
    expect(img.classList.contains('invisible')).toBe(false);
  });

  test('a miss with the wire down: no fetch attempt burns while it dials; the fetch goes once the wire is up', async () => {
    const t = fakeTunnel();
    setEngineTunnel(BASE, t);
    const {holder, img} = box();
    setTunnelSrc(img, URL_A);
    await flush();
    // The retry window would have run out here; the gate is still waiting.
    await vi.advanceTimersByTimeAsync(MEDIA_RETRY_WINDOW_MS + 5_000);
    await flush();
    expect(t.fetches).toEqual([]);
    expect(holder.querySelector('.cyc-media-tap')).toBeNull();
    expect(holder.querySelector('.cyc-media-gone')).toBeNull();
    expect(img.classList.contains('invisible')).toBe(true);
    // The wait is a visible loading surface: it has to beat the box's own
    // `bg-[#000]!` letterbox, so it is inline and important, not black.
    expect(holder.style.getPropertyValue('background-color')).toBe('rgb(255, 255, 255)');
    expect(holder.style.getPropertyPriority('background-color')).toBe('important');
    expect(holder.className).toContain('cyc-media-pulse');

    t.up();
    await flush();
    expect(t.fetches).toEqual([URL_A]);
    expect(img.getAttribute('src')).toMatch(/^blob:test\//);
    expect(holder.style.getPropertyValue('background-color')).toBe('');
    expect(holder.className).not.toContain('cyc-media-pulse');
  });

  test('the wire never comes up: a tap-to-load card, not an error (no "no longer on disk"); a tap retries', async () => {
    const t = fakeTunnel();
    setEngineTunnel(BASE, t);
    const {holder, img} = box();
    const errors = vi.fn();
    img.addEventListener('error', errors);
    setTunnelSrc(img, URL_A);
    await flush();
    await vi.advanceTimersByTimeAsync(MEDIA_WIRE_WAIT_MS + 10);
    await flush();
    const card = holder.querySelector('.cyc-media-tap') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.textContent).toMatch(/tap to load/i);
    expect(errors).not.toHaveBeenCalled();
    expect(holder.querySelector('.cyc-media-gone')).toBeNull();
    expect(t.fetches).toEqual([]);

    // The tap is not the box's own click (which opens the viewer).
    const boxClicks = vi.fn();
    holder.addEventListener('click', boxClicks);
    t.up();
    card!.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
    await flush();
    expect(boxClicks).not.toHaveBeenCalled();
    expect(holder.querySelector('.cyc-media-tap')).toBeNull();
    expect(t.fetches).toEqual([URL_A]);
    expect(img.getAttribute('src')).toMatch(/^blob:test\//);
  });

  test('a 404 from an engine that is up is still the failure cascade (the error event), not tap-to-load', async () => {
    const t = fakeTunnel();
    t.isReady = true;
    t.reply = () => new Response('', {status: 404});
    setEngineTunnel(BASE, t);
    const {holder, img} = box();
    const errors = vi.fn();
    img.addEventListener('error', errors);
    setTunnelSrc(img, URL_A);
    await flush();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(img.dataset.cycMediaUrl).toBe(URL_A);
    expect(holder.querySelector('.cyc-media-tap')).toBeNull();
  });

  test('the wire drops after the gate and stays down through the window: tap-to-load, not the error cascade', async () => {
    const t = fakeTunnel();
    t.isReady = true;
    t.reply = () => {
      throw new Error('pipe closed');
    };
    t.fetch = () => Promise.reject(new Error('pipe closed'));
    setEngineTunnel(BASE, t);
    const {holder, img} = box();
    const errors = vi.fn();
    img.addEventListener('error', errors);
    setTunnelSrc(img, URL_A);
    await flush();
    await vi.advanceTimersByTimeAsync(MEDIA_RETRY_WINDOW_MS + 1_000);
    await flush();
    expect(holder.querySelector('.cyc-media-tap')).not.toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  test('a grid tile (no media box) keeps its error path when the wire never comes up', async () => {
    const t = fakeTunnel();
    setEngineTunnel(BASE, t);
    const tile = document.createElement('div');
    tile.className = 'cyc-tile';
    const img = document.createElement('img');
    tile.append(img);
    document.body.append(tile);
    const errors = vi.fn();
    img.addEventListener('error', errors);
    setTunnelSrc(img, URL_A);
    await flush();
    await vi.advanceTimersByTimeAsync(MEDIA_WIRE_WAIT_MS + 10);
    await flush();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(tile.querySelector('.cyc-media-tap')).toBeNull();
  });
});
