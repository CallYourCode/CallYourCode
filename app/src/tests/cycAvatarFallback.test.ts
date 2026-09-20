import {beforeEach, describe, expect, test, vi} from 'vitest';

// The real photo loader lives behind engineObjectUrl; stub it so we can drive
// the success/error paths without a tunnel. Same seam cycAvatarCascade.test.ts
// mocks. cachedImageObjectUrls feeds the boot-time warm (durable cache ->
// synchronous map).
vi.mock('../engine/contract', () => ({
  engineObjectUrl: vi.fn((url: string) => Promise.resolve(url)),
  cachedImageObjectUrls: vi.fn(() => Promise.resolve(new Map<string, string>()))
}));

import {cachedImageObjectUrls, engineObjectUrl} from '../engine/contract';
import {avatarFallbackSvg, avatarView, warmAvatarPhotoCache} from '../components/avatarView';

const objUrl = vi.mocked(engineObjectUrl);
const warmSrc = vi.mocked(cachedImageObjectUrls);
const tick = () => new Promise((r) => setTimeout(r, 0));
const robotOf = (el: HTMLElement) => el.querySelector('svg.cyc-robot');
const photoOf = (el: HTMLElement) => el.querySelector<HTMLImageElement>('img.cyc-face-photo');

beforeEach(() => {
  objUrl.mockReset();
  warmSrc.mockReset();
  warmSrc.mockResolvedValue(new Map());
});

describe('fallback: the name-derived robot SVG, never a bot asset', () => {
  test('a photo-less session draws the deterministic robot for its seed', () => {
    const a = avatarView('Relay', 48, '', undefined, 'seed-shared');
    const b = avatarView('Relay Elsewhere', 42, '', undefined, 'seed-shared');
    expect(robotOf(a)).not.toBeNull();
    // Same seed, same robot markup: the icon derives from the seed, not chance.
    expect(robotOf(a)!.innerHTML).toBe(robotOf(b)!.innerHTML);
    // No bundled bot-avatar asset anywhere (av1-5 are deleted).
    expect(a.querySelector('img')).toBeNull();
  });

  test('while a photo loads, the base is the robot fallback, not a bot asset', () => {
    objUrl.mockImplementation(() => new Promise<string>(() => {})); // never resolves
    const el = avatarView('Relay', 48, '', 'https://a.example/photo', 'seed-shared');
    expect(robotOf(el)).not.toBeNull();
    expect(el.querySelector('img[data-cyc-auto]')).toBeNull();
    expect(photoOf(el)).toBeNull(); // the photo img holds no src until the loader resolves
  });

  test('the loader failing keeps the robot -- no photo img, no broken glyph', async () => {
    objUrl.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('gone'), {status: 404}))
    );
    const el = avatarView('Zephyr', 48, '', 'https://err.example/photo', 'seed-err');
    const robot = robotOf(el);
    expect(robot).not.toBeNull();

    await tick(); // let the rejected loader settle

    expect(robotOf(el)).toBe(robot);
    expect(el.querySelectorAll('img').length).toBe(0);
  });

  test('a decoded photo swaps in only on load and clears the robot', async () => {
    objUrl.mockImplementation(() => Promise.resolve('blob:ok-load'));
    const el = avatarView('Beacon', 48, '', 'https://ok.example/photo-load', 'seed-ok');
    expect(robotOf(el)).not.toBeNull();

    await tick(); // loader resolves, photo img is appended (still hidden)

    const photo = photoOf(el);
    expect(photo).not.toBeNull();
    expect(photo!.getAttribute('src')).toBe('blob:ok-load');
    expect(photo!.classList.contains('invisible')).toBe(true);
    expect(robotOf(el)).not.toBeNull(); // robot still there pre-decode

    photo!.dispatchEvent(new Event('load')); // actual decode

    expect(photo!.classList.contains('invisible')).toBe(false);
    expect(robotOf(el)).toBeNull(); // robot removed after the swap
  });
});

describe('cache: a known photo renders synchronously, no placeholder swap', () => {
  test('once a photo has loaded, the next render of the same url is synchronous', async () => {
    objUrl.mockImplementation(() => Promise.resolve('blob:ok-revisit'));
    const first = avatarView('Beacon', 48, '', 'https://ok.example/photo-revisit', 'seed-ok');
    expect(robotOf(first)).not.toBeNull(); // first-ever load: fallback allowed
    await tick(); // the loader settles, the resolved src is remembered

    // The revisit: same session rendered again (row rebuild, header, reopen).
    const again = avatarView('Beacon', 48, '', 'https://ok.example/photo-revisit', 'seed-ok');
    const photo = photoOf(again);
    expect(photo).not.toBeNull();
    expect(photo!.getAttribute('src')).toBe('blob:ok-revisit'); // src set synchronously
    expect(photo!.classList.contains('invisible')).toBe(false); // visible at once
    expect(robotOf(again)).toBeNull(); // no placeholder was ever drawn
  });

  test('the boot warm lifts the durable cache into synchronous first paints', async () => {
    // The durable image cache holds the 48px thumbnail variant of this url.
    const url = 'https://eng.example/session-photo/abc?v=7';
    warmSrc.mockResolvedValue(new Map([[url + '&w=128', 'blob:warmed']]));
    await warmAvatarPhotoCache();
    expect(warmSrc).toHaveBeenCalledWith('/session-photo/');

    const el = avatarView('Abc', 48, '', url, 'seed-abc');
    const photo = photoOf(el);
    expect(photo).not.toBeNull();
    expect(photo!.getAttribute('src')).toBe('blob:warmed');
    expect(photo!.dataset.cycCached).toBe('1');
    expect(robotOf(el)).toBeNull(); // cached photo: no fallback, no flash
    expect(objUrl).not.toHaveBeenCalled(); // and no wire fetch
  });
});

describe('avatarFallbackSvg: standalone, deterministic, self-contained', () => {
  test('same name+seed yields byte-identical SVG; the paints are literal colors', () => {
    const a = avatarFallbackSvg('Relay', 'seed-shared');
    expect(avatarFallbackSvg('Relay', 'seed-shared')).toBe(a);
    expect(a.startsWith('<svg')).toBe(true);
    // Standalone documents render with no CSS cascade around them: no CSS
    // variables, no color-mix, everything a literal paint.
    expect(a).not.toContain('var(');
    expect(a).not.toContain('color-mix');
    expect(a).not.toContain('currentColor');
    expect(a).toMatch(/#[0-9a-f]{6}/);
  });

  test('a name with no robot glyph falls back to an initials tile', () => {
    const svg = avatarFallbackSvg('42crunch', 'seed-num');
    expect(svg).toContain('<text');
    expect(svg).toContain('>4<');
  });
});
