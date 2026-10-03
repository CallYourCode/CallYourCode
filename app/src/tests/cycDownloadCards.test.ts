import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// ONE TAP ON A SHOWN FILE'S CARD (download-lane, 2026-10-03). The owner: "when
// I click download why doesn't it just trigger a download", and on iPhone "it
// should just NOT try to open the file in the in-app browser itself". The card
// carries the progress; a laptop gets the browser's own download (the service
// worker path, proven in the rig: no worker here, so the memory fallback saves
// through one link); an iPhone gets the share sheet and NEVER a link, a new
// window or a navigation to the bytes.

const {engineCapFetch} = vi.hoisted(() => ({engineCapFetch: vi.fn()}));
vi.mock('../engine/contract', () => ({
  EngineOffline: class EngineOffline extends Error {},
  engineCapFetch: (...a: unknown[]) => engineCapFetch(...a),
  whenEngineReady: vi.fn(async () => true),
  engineObjectUrl: vi.fn(async (u: string) => u)
}));

import {
  __resetDownloadCardsForTest,
  cancelDownload,
  downloadLive,
  paintDownloadCard,
  tapDownloadCard
} from '../features/media/downloadCards';
import type {CycFileRef} from '../types';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const SIZE = 300_000;
const BODY = new Uint8Array(SIZE).map((_, i) => i % 251);
const FILE: CycFileRef = {docId: 'doc-1', name: 'pack.zip', fileKind: 'binary', size: SIZE};

const rangeOf = (init: unknown) =>
  (init as {headers?: Record<string, string>} | undefined)?.headers?.range ?? '';
function part(range: string) {
  const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), SIZE - 1);
  const headers: Record<string, string> = {'content-range': `bytes ${start}-${end}/${SIZE}`};
  return {
    ok: true,
    status: 206,
    headers: {get: (k: string) => headers[k.toLowerCase()] ?? null},
    arrayBuffer: async () => BODY.slice(start, end + 1).buffer
  };
}

// The card fileMessages draws, reduced to what the painter touches.
function card(): HTMLElement {
  const c = document.createElement('div');
  c.className = 'cyc-download-card';
  const size = document.createElement('div');
  size.className = 'cyc-doc-size';
  const btn = document.createElement('button');
  btn.className = 'cyc-download-btn';
  c.append(size, btn);
  document.body.append(c);
  paintDownloadCard(c, FILE);
  return c;
}
const sizeText = (c: HTMLElement) => c.querySelector('.cyc-doc-size')!.textContent;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

let anchorClicks: string[];
let opened: unknown[];
beforeEach(() => {
  document.body.innerHTML = '';
  engineCapFetch.mockReset();
  anchorClicks = [];
  opened = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    anchorClicks.push(this.download || this.href);
  });
  vi.spyOn(window, 'open').mockImplementation((...a: unknown[]) => {
    opened.push(a);
    return null;
  });
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {createObjectURL: () => 'blob:x', revokeObjectURL: () => {}})
  );
});
afterEach(() => {
  __resetDownloadCardsForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as {userAgent?: unknown}).userAgent;
  delete (navigator as {maxTouchPoints?: unknown}).maxTouchPoints;
  delete (navigator as {canShare?: unknown}).canShare;
  delete (navigator as {share?: unknown}).share;
});

function asIphone(share: (d: {files: File[]}) => Promise<void>) {
  Object.defineProperty(navigator, 'userAgent', {configurable: true, value: IPHONE_UA});
  Object.defineProperty(navigator, 'maxTouchPoints', {configurable: true, value: 5});
  Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
  const fn = vi.fn(share);
  Object.defineProperty(navigator, 'share', {configurable: true, value: fn});
  return fn;
}

describe('iPhone: progress on the card, then the save sheet, never the file opened', () => {
  test('a quick download opens the save sheet once with the whole file; no link, no window', async () => {
    const share = asIphone(async () => {});
    engineCapFetch.mockImplementation(async (_u: string, init: unknown) => part(rangeOf(init)));
    const c = card();
    tapDownloadCard(FILE, 'doc://doc-1/raw');
    await settle();
    expect(share).toHaveBeenCalledTimes(1);
    const files = share.mock.calls[0][0].files;
    expect(files[0].name).toBe('pack.zip');
    expect(files[0].size).toBe(SIZE);
    expect(anchorClicks, 'a link to the bytes opens them inside the app on iOS').toEqual([]);
    expect(opened).toEqual([]);
    expect(document.querySelector('iframe')).toBeNull();
    expect(sizeText(c)).toBe('Downloaded');
  });

  test('a slow download shows its progress, then "Tap to save"; that tap opens the sheet', async () => {
    const share = asIphone(async () => {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    engineCapFetch.mockImplementation(async (_u: string, init: unknown) => {
      const r = rangeOf(init);
      if (!r.startsWith('bytes=0-')) await gate;
      return part(r);
    });
    const c = card();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    tapDownloadCard(FILE, 'doc://doc-1/raw');
    await settle();
    // the first part is in: the card says how far
    expect(sizeText(c)).toBe('256 KB / 293 KB \u00b7 87%');
    expect(downloadLive(FILE.docId)).toBe(true);
    // the tap's activation is long gone by the time the rest arrives
    vi.spyOn(Date, 'now').mockReturnValue(1_005_000);
    release();
    await settle();
    expect(share).not.toHaveBeenCalled();
    expect(sizeText(c)).toBe('Tap to save');
    tapDownloadCard(FILE, 'doc://doc-1/raw');
    await settle();
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].files[0].size).toBe(SIZE);
    expect(anchorClicks).toEqual([]);
    expect(opened).toEqual([]);
  });

  test('a file the share sheet will not take is refused up front: nothing downloaded, nothing opened', async () => {
    asIphone(async () => {});
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => false});
    const c = card();
    tapDownloadCard(FILE, 'doc://doc-1/raw');
    await settle();
    expect(engineCapFetch).not.toHaveBeenCalled();
    expect(anchorClicks).toEqual([]);
    expect(sizeText(c)).toBe('Cannot be saved on this device');
  });
});

describe('laptop with no worker to stream through: one tap, one save', () => {
  test('the parts collect and save through a single link, with progress on the card', async () => {
    engineCapFetch.mockImplementation(async (_u: string, init: unknown) => part(rangeOf(init)));
    const c = card();
    tapDownloadCard(FILE, 'doc://doc-1/raw');
    await settle();
    expect(anchorClicks).toEqual(['pack.zip']);
    expect(sizeText(c)).toBe('Downloaded');
  });

  test('a second tap while it downloads starts nothing new; the button cancels it', async () => {
    engineCapFetch.mockReturnValue(new Promise(() => {}));
    const c = card();
    tapDownloadCard(FILE, 'doc://doc-1/raw');
    await settle();
    const calls = engineCapFetch.mock.calls.length;
    tapDownloadCard(FILE, 'doc://doc-1/raw');
    await settle();
    expect(engineCapFetch.mock.calls.length).toBe(calls);
    expect(c.querySelector('.cyc-download-btn')!.getAttribute('aria-label')).toBe(
      'Cancel download'
    );
    cancelDownload(FILE.docId);
    await settle();
    expect(downloadLive(FILE.docId)).toBe(false);
    expect(sizeText(c)).toBe('293 KB');
    expect(anchorClicks).toEqual([]);
  });
});
