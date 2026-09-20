import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {lazy, resetLazyForTests, setLazyNotifier} from '../shared/lazy';
import {cyclog} from '../shared/logging';

vi.mock('../shared/logging', () => ({cyclog: vi.fn()}));

// A rebuild removes the hashed chunks an open page still references. The lazy()
// wrapper turns that silent failure into one reload of the page, and refuses to
// loop when the reload does not fix it.

const reload = vi.fn();
const notified: string[] = [];

beforeEach(() => {
  resetLazyForTests();
  sessionStorage.clear();
  reload.mockClear();
  notified.length = 0;
  vi.mocked(cyclog).mockClear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {...window.location, reload}
  });
  setLazyNotifier((m) => notified.push(m));
});

afterEach(() => {
  setLazyNotifier(() => {});
});

const missing = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));

describe('lazy chunk loading', () => {
  test('a loader that resolves passes its module through untouched', async () => {
    const mod = {openTerminalViewer: () => {}};
    await expect(lazy(() => Promise.resolve(mod), 'the terminal')).resolves.toBe(mod);
    expect(reload).not.toHaveBeenCalled();
    expect(cyclog).not.toHaveBeenCalled();
  });

  test('a failing loader logs chunk.missing, toasts, reloads once and rethrows', async () => {
    await expect(lazy(missing, 'the terminal')).rejects.toThrow('dynamically imported');
    expect(cyclog).toHaveBeenCalledTimes(1);
    expect(cyclog).toHaveBeenCalledWith('chunk.missing', {
      what: 'the terminal',
      err: 'TypeError: Failed to fetch dynamically imported module'
    });
    expect(notified).toEqual(['The app was updated; reloading']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a second failure in the same page does not reload again', async () => {
    await expect(lazy(missing, 'the terminal')).rejects.toThrow();
    await expect(lazy(missing, 'the QR scanner')).rejects.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(cyclog).toHaveBeenCalledTimes(2);
    expect(notified).toEqual(['The app was updated; reloading']);
  });

  test('after the reload, a failure again tells the user instead of looping', async () => {
    await expect(lazy(missing, 'the terminal')).rejects.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);

    // The reload happened: a fresh page, but the sessionStorage mark survives.
    resetLazyForTests();
    reload.mockClear();
    notified.length = 0;

    await expect(lazy(missing, 'the terminal')).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
    expect(notified).toEqual(['Could not load the terminal; reload the app']);
    expect(cyclog).toHaveBeenLastCalledWith(
      'chunk.missing',
      expect.objectContaining({what: 'the terminal'})
    );
  });

  test('a stale mark from an earlier rebuild does not block the next one-shot reload', async () => {
    sessionStorage.setItem('cyc:chunk-reloaded', String(Date.now() - 6 * 60_000));
    await expect(lazy(missing, 'the terminal')).rejects.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(notified).toEqual(['The app was updated; reloading']);
  });
});
