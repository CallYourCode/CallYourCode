import {afterEach, describe, expect, test, vi} from 'vitest';
import {
  canShareFile,
  copyText,
  saveMethodFor,
  shareOrSaveBlob
} from '../features/media/downloads';

const clipboard = {writeText: vi.fn()};

afterEach(() => {
  vi.restoreAllMocks();
  delete (document as {execCommand?: unknown}).execCommand;
  clipboard.writeText.mockReset();
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: clipboard});
});

describe('copyText', () => {
  test('returns true when the Clipboard API write resolves', async () => {
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: clipboard});
    clipboard.writeText.mockResolvedValue(undefined);

    await expect(copyText('hello')).resolves.toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('hello');
  });

  test('returns false when the Clipboard API rejects and selection copy fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: clipboard});
    clipboard.writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false)
    });

    await expect(copyText('hello')).resolves.toBe(false);
  });
});

describe('save-path choice: share sheet on iOS, download link elsewhere', () => {
  const blob = () => new Blob(['0123456789'], {type: 'video/mp4'});

  const DESKTOP_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  const setUA = (ua: string) =>
    Object.defineProperty(navigator, 'userAgent', {configurable: true, value: ua});
  const setTouch = (n: number) =>
    Object.defineProperty(navigator, 'maxTouchPoints', {configurable: true, value: n});

  // Desktop Chrome also reports canShare({files}) true, so the OS platform, not
  // the presence of the share API, must decide the save path.
  const asDesktop = () => {
    setUA(DESKTOP_UA);
    setTouch(0);
  };
  const asIphone = () => {
    setUA(IPHONE_UA);
    setTouch(5);
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as {canShare?: unknown}).canShare;
    delete (navigator as {share?: unknown}).share;
    delete (navigator as {userAgent?: unknown}).userAgent;
    delete (navigator as {maxTouchPoints?: unknown}).maxTouchPoints;
  });

  function withShare(canShare: boolean, share: () => Promise<void>) {
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => canShare});
    Object.defineProperty(navigator, 'share', {configurable: true, value: vi.fn(share)});
  }

  test('no Web Share support: the method is a plain download link', () => {
    asDesktop();
    expect(canShareFile('clip.mp4', blob())).toBe(false);
    expect(saveMethodFor('clip.mp4', blob())).toBe('download');
  });

  test('desktop with canShare({files}) true still downloads, never the share sheet', () => {
    asDesktop();
    withShare(true, () => Promise.resolve());
    // canShareFile only reports the API capability; the save path must ignore it
    // off iOS so a desktop PDF downloads instead of opening the OS share sheet.
    expect(canShareFile('clip.mp4', blob())).toBe(true);
    expect(saveMethodFor('clip.mp4', blob())).toBe('download');
  });

  test('iPhone with canShare({files}) true: the method is the OS share sheet', () => {
    asIphone();
    withShare(true, () => Promise.resolve());
    expect(canShareFile('clip.mp4', blob())).toBe(true);
    expect(saveMethodFor('clip.mp4', blob())).toBe('share');
  });

  test('iPhone with canShare rejecting the file: nothing, never a link to the bytes', () => {
    // A link to a blob in a home-screen app opens the file as a page inside the
    // app with no way back (the owner's report, 2026-10-03).
    asIphone();
    withShare(false, () => Promise.resolve());
    expect(saveMethodFor('clip.mp4', blob())).toBe('none');
  });

  test('shareOrSaveBlob without share support saves through a blob URL link', async () => {
    asDesktop();
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', {createObjectURL, revokeObjectURL: vi.fn()});
    await expect(shareOrSaveBlob('clip.mp4', blob())).resolves.toBe('download');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  test('shareOrSaveBlob on desktop downloads and never calls navigator.share', async () => {
    asDesktop();
    const share = vi.fn((_d?: {files?: File[]; title?: string}) => Promise.resolve());
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
    Object.defineProperty(navigator, 'share', {configurable: true, value: share});
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', {createObjectURL, revokeObjectURL: vi.fn()});
    await expect(shareOrSaveBlob('doc.pdf', blob())).resolves.toBe('download');
    expect(share).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  test('shareOrSaveBlob on iPhone shares the file when the share sheet accepts it', async () => {
    asIphone();
    const share = vi.fn((_d?: {files?: File[]; title?: string}) => Promise.resolve());
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
    Object.defineProperty(navigator, 'share', {configurable: true, value: share});
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', {createObjectURL, revokeObjectURL: vi.fn()});
    await expect(shareOrSaveBlob('clip.mp4', blob())).resolves.toBe('share');
    expect(share).toHaveBeenCalledTimes(1);
    const arg = share.mock.calls[0][0];
    expect(arg?.files?.[0]).toBeInstanceOf(File);
    // A share means NO download link was minted.
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('iPhone: a dismissed share (AbortError) is handled, not downloaded behind the user', async () => {
    asIphone();
    const share = vi.fn(() => Promise.reject(Object.assign(new Error('x'), {name: 'AbortError'})));
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
    Object.defineProperty(navigator, 'share', {configurable: true, value: share});
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', {createObjectURL, revokeObjectURL: vi.fn()});
    await expect(shareOrSaveBlob('clip.mp4', blob())).resolves.toBe('share');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('iPhone: a share that throws for a real reason never falls back to a link', async () => {
    asIphone();
    const share = vi.fn(() => Promise.reject(new Error('boom')));
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
    Object.defineProperty(navigator, 'share', {configurable: true, value: share});
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', {createObjectURL, revokeObjectURL: vi.fn()});
    await expect(shareOrSaveBlob('clip.mp4', blob())).resolves.toBe('none');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('iPhone: a file the share sheet will not take is not linked either', async () => {
    asIphone();
    withShare(false, () => Promise.resolve());
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', {createObjectURL, revokeObjectURL: vi.fn()});
    await expect(shareOrSaveBlob('clip.mp4', blob())).resolves.toBe('none');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
