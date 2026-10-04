import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {lazy, setLazyNotifier} from '../shared/lazy';
import {cyclog} from '../shared/logging';
import {resetSelfNavForTests} from '../shared/selfReload';

vi.mock('../shared/logging', () => ({cyclog: vi.fn()}));

// A rebuild removes the hashed chunks an open page still references. The lazy()
// wrapper turns that silent failure into one reload of the page, and refuses to
// loop when the reload does not fix it.

const reload = vi.fn();
const notified: string[] = [];

beforeEach(() => {
  resetSelfNavForTests();
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

// The reload goes through the self-navigation gate, which decides on its own
// tick (no service worker in jsdom: nothing pending, so it goes at once).
const reloaded = (n: number) => vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(n));
const settle = () => new Promise((r) => setTimeout(r, 30));
const logged = (event: string) => vi.mocked(cyclog).mock.calls.filter((c) => c[0] === event);

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
    expect(logged('chunk.missing')).toEqual([
      [
        'chunk.missing',
        {what: 'the terminal', err: 'TypeError: Failed to fetch dynamically imported module'}
      ]
    ]);
    expect(notified).toEqual(['The app was updated; reloading']);
    await reloaded(1);
    expect(logged('nav.go')[0]?.[1]).toMatchObject({why: 'chunk-missing'});
  });

  test('a second failure in the same page re-uses the pending reload', async () => {
    await expect(lazy(missing, 'the terminal')).rejects.toThrow();
    await expect(lazy(missing, 'the QR scanner')).rejects.toThrow();
    await reloaded(1);
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(logged('chunk.missing')).toHaveLength(2);
    expect(notified).not.toContain('Could not load the QR scanner; reload the app');
  });

  test('after the reload, a failure again tells the user instead of looping', async () => {
    await expect(lazy(missing, 'the terminal')).rejects.toThrow();
    await reloaded(1);

    // The reload happened: a fresh page, but the sessionStorage mark survives.
    resetSelfNavForTests();
    reload.mockClear();
    notified.length = 0;

    await expect(lazy(missing, 'the terminal')).rejects.toThrow();
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(notified).toEqual(['Could not load the terminal; reload the app']);
    expect(logged('chunk.missing').pop()?.[1]).toMatchObject({what: 'the terminal'});
  });

  test('a stale mark from an earlier rebuild does not block the next one-shot reload', async () => {
    sessionStorage.setItem('cyc:chunk-reloaded', String(Date.now() - 6 * 60_000));
    await expect(lazy(missing, 'the terminal')).rejects.toThrow();
    await reloaded(1);
    expect(notified).toEqual(['The app was updated; reloading']);
  });
});
