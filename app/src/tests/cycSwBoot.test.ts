import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {registerOfflineWorker} from '../swBoot';

vi.mock('../shared/logging', () => ({cyclog: vi.fn()}));
const update = vi.fn(async () => undefined);
const reg = {update, addEventListener: vi.fn()};
const register = vi.fn(async () => reg);
const getRegistration = vi.fn(async () => reg);
let foreground: () => void;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', {serviceWorker: {register, getRegistration, controller: null}});
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'visibilitychange') foreground = handler as () => void;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('boot registers and nudges the worker without engine sync', async () => {
  registerOfflineWorker();
  await flush();
  expect(register).toHaveBeenCalledWith('/cyc-sw.js', {scope: '/'});
  expect(update).toHaveBeenCalledOnce();
});

test('every foreground edge nudges the registration without engine sync', async () => {
  registerOfflineWorker();
  await flush();
  update.mockClear();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  foreground();
  await flush();
  expect(update).not.toHaveBeenCalled();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  foreground();
  await flush();
  foreground();
  await flush();
  expect(update).toHaveBeenCalledTimes(2);
});

test('a failed update is best effort and retries next foreground', async () => {
  update.mockRejectedValueOnce(new Error('offline'));
  registerOfflineWorker();
  await flush();
  foreground();
  await flush();
  expect(update).toHaveBeenCalledTimes(2);
});
