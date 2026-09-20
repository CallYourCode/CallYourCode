import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The image cache is a fake here (no IndexedDB in jsdom): a hit returns an
// object URL string, a miss null; putImage records what the wire cached.
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
import {openImageViewer} from '../features/media/imageViewer';

const BASE = 'http://10.0.0.7:7788';
// The one URL a shown picture lives under: the original bytes, no thumb rung.
const RAW = BASE + '/doc/8b495c30-aa39-49c5-95c4-596b40d83a6c/raw';

function fakeTunnel(): EngineTunnel & {isReady: boolean; fetches: string[]; reply: () => Response} {
  const t = {
    isReady: false,
    fetches: [] as string[],
    reply: () =>
      new Response(new Uint8Array(16), {status: 200, headers: {'content-type': 'image/png'}}),
    ready() {
      return t.isReady;
    },
    fetch(url: string) {
      t.fetches.push(url);
      return Promise.resolve(t.reply());
    },
    whenReady() {
      return Promise.resolve(t.isReady);
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

const mainImg = () =>
  document.querySelector<HTMLImageElement>('.cyc-imgview-img:not(.cyc-imgview-neighbour)')!;
const stageEl = () => document.querySelector<HTMLElement>('.cyc-imgview-stage')!;

const STAGE_W = 390;
const STAGE_H = 700;
// Stub the stage's border box (rect + client sizes; jsdom lays nothing out).
// `pad` puts real padding on the stage, the way the live stage carries
// --cyc-imgview-pad plus the safe-area bottom: the content box the picture
// fits in is then smaller than the stage rect.
function stubStage(pad = 0): void {
  const el = stageEl();
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: STAGE_W,
      bottom: STAGE_H,
      width: STAGE_W,
      height: STAGE_H,
      toJSON: () => ({})
    }) as DOMRect;
  Object.defineProperty(el, 'clientWidth', {value: STAGE_W, configurable: true});
  Object.defineProperty(el, 'clientHeight', {value: STAGE_H, configurable: true});
  if (pad) el.style.padding = `${pad}px`;
}

// Open the viewer on one picture and land its decode: stub the stage box,
// give the img its natural pixel size, fire load (jsdom never decodes).
async function openAt(natW: number, natH: number, pad = 0): Promise<HTMLImageElement> {
  cache.set(RAW, 'blob:cached/full');
  openImageViewer([{url: RAW, name: 'chart.png'}], 0);
  stubStage(pad);
  await flush();
  const img = mainImg();
  Object.defineProperty(img, 'naturalWidth', {value: natW, configurable: true});
  Object.defineProperty(img, 'naturalHeight', {value: natH, configurable: true});
  img.dispatchEvent(new Event('load'));
  return img;
}

const wheelZoom = (deltaY: number, times: number) => {
  for (let i = 0; i < times; i++) {
    stageEl().dispatchEvent(
      new WheelEvent('wheel', {deltaY, ctrlKey: true, bubbles: true, cancelable: true})
    );
  }
};

const closeViewer = async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  await flush();
};

let createObjectURL: typeof URL.createObjectURL;
let revokeObjectURL: typeof URL.revokeObjectURL;
let mintedN = 0;
beforeEach(() => {
  vi.useFakeTimers();
  cache.clear();
  logs.length = 0;
  putImage.mockClear();
  mintedN = 0;
  createObjectURL = URL.createObjectURL;
  revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:test/${++mintedN}`;
  URL.revokeObjectURL = () => {};
  Object.defineProperty(window, 'devicePixelRatio', {value: 2, configurable: true});
});
afterEach(() => {
  clearEngineTunnel(BASE);
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  Object.defineProperty(window, 'devicePixelRatio', {value: 1, configurable: true});
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('image viewer zoom: the full-resolution original is what a zoom shows', () => {
  test('a big picture zooms past the fixed floor, to one image pixel per device pixel', async () => {
    // 7000x2600 (the real BZ Builder chart) on a 390x700 stage at dpr 2:
    // fit width 390, so device 1:1 needs 7000 / (390 * 2) = 8.97x. The old
    // fixed cap of 6 could never get there.
    const img = await openAt(7000, 2600);
    wheelZoom(-100, 30);
    await vi.advanceTimersByTimeAsync(300);

    // The settled zoom is baked into the LAYOUT size (that is what the browser
    // rasterizes), capped at the picture's own pixels: 7000 / dpr 2 = 3500 CSS
    // px wide, with the transform left at scale(1), translate only.
    expect(img.style.maxWidth).toBe('none');
    expect(parseFloat(img.style.width)).toBeCloseTo(3500, 0);
    expect(parseFloat(img.style.height)).toBeCloseTo(1300, 0);
    expect(img.style.transform).toMatch(/scale\(1\)$/);
    await closeViewer();
  });

  test('zooming back out to 1 restores the fit layout and clears the transform', async () => {
    const img = await openAt(7000, 2600);
    wheelZoom(-100, 30);
    await vi.advanceTimersByTimeAsync(300);
    expect(img.style.width).not.toBe('');

    wheelZoom(100, 40);
    await vi.advanceTimersByTimeAsync(300);
    expect(img.style.width).toBe('');
    expect(img.style.maxWidth).toBe('');
    expect(img.style.transform).toBe('');
    await closeViewer();
  });

  test('a double tap bakes its zoom at once (no gesture end to wait for)', async () => {
    const img = await openAt(7000, 2600);
    img.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    img.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    expect(parseFloat(img.style.width)).toBeCloseTo(390 * 2.5, 0);
    expect(img.style.transform).toMatch(/scale\(1\)$/);
    await closeViewer();
  });

  test('a small picture never rasters past its own pixels: zoom stays a transform stretch', async () => {
    // 200x100 at dpr 2: the layout already covers every pixel the picture
    // has, so the 6x look-closer zoom is a stretch, not a bigger raster.
    const img = await openAt(200, 100);
    wheelZoom(-100, 30);
    await vi.advanceTimersByTimeAsync(300);
    expect(img.style.width).toBe('');
    expect(img.style.maxWidth).toBe('');
    expect(img.style.transform).toMatch(/scale\(6\)$/);
    await closeViewer();
  });

  test('paging away from a zoomed picture drops its baked full-res layout', async () => {
    cache.set(RAW, 'blob:cached/full');
    cache.set(RAW + '-two', 'blob:cached/two');
    openImageViewer(
      [
        {url: RAW, name: 'one.png'},
        {url: RAW + '-two', name: 'two.png'}
      ],
      0
    );
    stubStage();
    await flush();
    const img = mainImg();
    Object.defineProperty(img, 'naturalWidth', {value: 7000, configurable: true});
    Object.defineProperty(img, 'naturalHeight', {value: 2600, configurable: true});
    img.dispatchEvent(new Event('load'));
    wheelZoom(-100, 30);
    await vi.advanceTimersByTimeAsync(300);
    expect(img.style.width).not.toBe('');

    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
    await flush();
    expect(img.style.width).toBe('');
    expect(img.style.maxWidth).toBe('');
    expect(img.style.transform).toBe('');
    await closeViewer();
  });

  test('a padded stage fits the content box: the bake does not overshoot by the padding', async () => {
    // 8px padding all round: the picture fits 374x684, not the 390x700 stage
    // rect. The old stage-rect measure baked the double-tap 2.5x at
    // 2.5 * 390 = 975 CSS px; the content-box fit bakes 2.5 * 374 = 935.
    const img = await openAt(7000, 2600, 8);
    img.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    img.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(parseFloat(img.style.width)).toBeCloseTo(2.5 * (STAGE_W - 16), 0);
    await closeViewer();
  });

  test('padding does not move the 1:1 ceiling: max zoom still bakes natural/dpr', async () => {
    const img = await openAt(7000, 2600, 8);
    wheelZoom(-100, 30);
    await vi.advanceTimersByTimeAsync(300);
    expect(parseFloat(img.style.width)).toBeCloseTo(3500, 0);
    expect(parseFloat(img.style.height)).toBeCloseTo(1300, 0);
    await closeViewer();
  });

  test('a pathological huge picture bakes only up to the area budget, not its own pixels', async () => {
    // 40000x40000 at dpr 2: device 1:1 layout would be 20000 CSS px square
    // (a multi-GB raster). The bake is clamped so its area tops out at 32x
    // the stage content box's area; the rest of the zoom stays a transform
    // stretch over that budget-sized raster.
    const img = await openAt(40000, 40000);
    wheelZoom(-100, 30);
    await vi.advanceTimersByTimeAsync(300);
    const w = parseFloat(img.style.width);
    const h = parseFloat(img.style.height);
    expect(img.style.maxWidth).toBe('none');
    expect(w).toBeCloseTo(STAGE_W * Math.sqrt((32 * STAGE_W * STAGE_H) / (STAGE_W * STAGE_W)), 0);
    expect(w * h).toBeLessThanOrEqual(32 * STAGE_W * STAGE_H * 1.001);
    expect(img.style.transform).toContain('scale(');
    expect(img.style.transform).not.toMatch(/scale\(1\)$/);
    await closeViewer();
  });
});

describe('image viewer bytes: the original over the sealed wire, cached for offline', () => {
  test('the viewer asks the wire for the original /raw URL, nothing else', async () => {
    const t = fakeTunnel();
    t.isReady = true;
    setEngineTunnel(BASE, t);
    openImageViewer([{url: RAW, name: 'chart.png'}], 0);
    await flush();
    expect(t.fetches).toEqual([RAW]);
    expect(mainImg().getAttribute('src')).toMatch(/^blob:test\//);
    await closeViewer();
  });

  test('what the wire delivers is cached under the original URL (offline afterward)', async () => {
    const t = fakeTunnel();
    t.isReady = true;
    setEngineTunnel(BASE, t);
    openImageViewer([{url: RAW, name: 'chart.png'}], 0);
    await flush();
    expect(putImage).toHaveBeenCalledTimes(1);
    expect(putImage.mock.calls[0][0]).toBe(RAW);
    // Not instanceof Blob: the fetch realm's Blob is not jsdom's global one.
    const cached = putImage.mock.calls[0][1] as Blob;
    expect(cached.size).toBe(16);
    expect(cached.type).toContain('image/png');
    await closeViewer();
  });

  test('offline with the original cached: it paints at once, no wire, no waiting card', async () => {
    cache.set(RAW, 'blob:cached/full');
    const t = fakeTunnel();
    setEngineTunnel(BASE, t);
    openImageViewer([{url: RAW, name: 'chart.png'}], 0);
    await flush();
    expect(mainImg().getAttribute('src')).toBe('blob:cached/full');
    expect(t.fetches).toEqual([]);
    expect(document.querySelector('.cyc-imgview-waiting')).toBeNull();
    await closeViewer();
  });
});
