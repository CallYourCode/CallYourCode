import {afterEach, describe, expect, test, vi} from 'vitest';
import {copyText} from '../features/media/downloads';

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
