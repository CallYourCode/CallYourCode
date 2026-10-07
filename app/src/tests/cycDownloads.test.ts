import {afterEach, describe, expect, test, vi} from 'vitest';
import {canShareFile, copyText} from '../features/media/downloads';

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

describe('canShareFile: the OS share sheet takes the file', () => {
  const blob = () => new Blob(['0123456789'], {type: 'video/mp4'});

  afterEach(() => {
    delete (navigator as {canShare?: unknown}).canShare;
    delete (navigator as {share?: unknown}).share;
  });

  test('no Web Share support: false', () => {
    expect(canShareFile('clip.mp4', blob())).toBe(false);
  });

  test('canShare({files}) true: true', () => {
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
    Object.defineProperty(navigator, 'share', {configurable: true, value: vi.fn()});
    expect(canShareFile('clip.mp4', blob())).toBe(true);
  });
});
