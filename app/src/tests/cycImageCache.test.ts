import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const {transactionOn} = vi.hoisted(() => ({transactionOn: vi.fn()}));
vi.mock('../shared/browser', () => ({IMAGES: 'images', transactionOn}));

import {cachedImageUrl} from '../features/media/imageCache';

describe('image cache', () => {
  beforeEach(() => {
    transactionOn.mockReset();
    vi.stubGlobal('URL', {createObjectURL: vi.fn(() => 'blob:cached')});
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('ignores non-http sources', async () => {
    await expect(cachedImageUrl('data:image/png;base64,x')).resolves.toBeNull();
    expect(transactionOn).not.toHaveBeenCalled();
  });

  test('returns an object URL for a fresh cached image', async () => {
    const blob = new Blob(['image']);
    transactionOn.mockResolvedValue({
      url: 'https://image.test/a.png',
      blob,
      bytes: blob.size,
      at: 999
    });
    await expect(cachedImageUrl('https://image.test/a.png')).resolves.toBe('blob:cached');
    expect(transactionOn).toHaveBeenCalledWith('images', 'readonly', expect.any(Function));
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  });

  test('expires stale cached images', async () => {
    const remove = vi.fn();
    transactionOn.mockImplementation(async (_store, mode, run) => {
      if (mode === 'readonly')
        return {url: 'https://image.test/a.png', blob: new Blob(), bytes: 0, at: -604_799_001};
      run({delete: remove} as unknown as IDBObjectStore);
      return null;
    });
    await expect(cachedImageUrl('https://image.test/a.png')).resolves.toBeNull();
    expect(remove).toHaveBeenCalledWith('https://image.test/a.png');
  });
});
