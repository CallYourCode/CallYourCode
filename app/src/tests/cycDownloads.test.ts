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

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as {canShare?: unknown}).canShare;
    delete (navigator as {share?: unknown}).share;
  });

  function withShare(canShare: boolean, share: () => Promise<void>) {
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => canShare});
    Object.defineProperty(navigator, 'share', {configurable: true, value: vi.fn(share)});
  }

  test('no Web Share support: the method is a plain download link', () => {
    expect(canShareFile('clip.mp4', blob())).toBe(false);
    expect(saveMethodFor('clip.mp4', blob())).toBe('download');
  });

  test('canShare({files}) true: the method is the OS share sheet', () => {
    withShare(true, () => Promise.resolve());
    expect(canShareFile('clip.mp4', blob())).toBe(true);
    expect(saveMethodFor('clip.mp4', blob())).toBe('share');
  });

  test('canShare present but rejecting the file: falls back to a download', () => {
    withShare(false, () => Promise.resolve());
    expect(saveMethodFor('clip.mp4', blob())).toBe('download');
  });

  test('shareOrSaveBlob without share support saves through a blob URL link', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', {createObjectURL, revokeObjectURL: vi.fn()});
    await expect(shareOrSaveBlob('clip.mp4', blob())).resolves.toBe('download');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  test('shareOrSaveBlob shares the file when the share sheet accepts it', async () => {
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

  test('a dismissed share (AbortError) is handled, not downloaded behind the user', async () => {
    const share = vi.fn(() => Promise.reject(Object.assign(new Error('x'), {name: 'AbortError'})));
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
    Object.defineProperty(navigator, 'share', {configurable: true, value: share});
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', {createObjectURL, revokeObjectURL: vi.fn()});
    await expect(shareOrSaveBlob('clip.mp4', blob())).resolves.toBe('share');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('a share that throws for a real reason falls back to a download', async () => {
    const share = vi.fn(() => Promise.reject(new Error('boom')));
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
    Object.defineProperty(navigator, 'share', {configurable: true, value: share});
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', {createObjectURL, revokeObjectURL: vi.fn()});
    await expect(shareOrSaveBlob('clip.mp4', blob())).resolves.toBe('download');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});
