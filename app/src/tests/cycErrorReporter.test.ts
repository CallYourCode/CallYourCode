import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {installErrorReporter} from '../errorReporter';

// A field exception must name itself in app.log rather than vanishing into a
// phone's console. These pin the reporter's shape: an uncaught error and an
// unhandled rejection both emit app.error with the message, a bounded stack,
// and a source; and a repeating error is capped per page so it cannot flood.

let cyclogSpy: ReturnType<typeof vi.fn<(event: string, fields: Record<string, unknown>) => void>>;
vi.mock('../shared/logging', () => ({
  cyclog: (event: string, fields: Record<string, unknown>) => cyclogSpy(event, fields)
}));

beforeEach(() => {
  cyclogSpy = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// A fresh window-like target per test so the per-page dedupe map starts empty
// (installErrorReporter binds one target; each test installs onto its own).
function fakeWindow() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  return {
    addEventListener(type: string, fn: (e: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    emit(type: string, e: unknown) {
      for (const fn of listeners[type] ?? []) fn(e);
    }
  };
}

describe('the global error reporter', () => {
  test('an uncaught error emits app.error with message, stack, and source', () => {
    const w = fakeWindow();
    installErrorReporter(w as unknown as Window);
    const err = new Error('boom in render');
    w.emit('error', {
      message: 'boom in render',
      filename: 'https://x/app.js',
      lineno: 12,
      colno: 5,
      error: err
    });
    expect(cyclogSpy).toHaveBeenCalledTimes(1);
    const [event, fields] = cyclogSpy.mock.calls[0];
    expect(event).toBe('app.error');
    expect(fields.message).toBe('boom in render');
    expect(fields.source).toBe('https://x/app.js:12:5');
    expect(typeof fields.stack).toBe('string');
    expect((fields.stack as string).length).toBeLessThanOrEqual(400);
  });

  test('an unhandled rejection is reported with its reason', () => {
    const w = fakeWindow();
    installErrorReporter(w as unknown as Window);
    w.emit('unhandledrejection', {reason: new Error('async fail')});
    expect(cyclogSpy).toHaveBeenCalledWith(
      'app.error',
      expect.objectContaining({message: 'async fail', source: 'unhandledrejection'})
    );
  });

  test('the same error is logged at most five times per page', () => {
    const w = fakeWindow();
    installErrorReporter(w as unknown as Window);
    for (let i = 0; i < 20; i++) {
      w.emit('error', {
        message: 'every frame',
        filename: 'a.js',
        lineno: 1,
        colno: 1,
        error: new Error('every frame')
      });
    }
    expect(cyclogSpy).toHaveBeenCalledTimes(5);
    // The fifth (last kept) marks itself as capped so the log says it stopped.
    const last = cyclogSpy.mock.calls[4][1];
    expect(last.capped).toBe(true);
  });

  test('distinct errors are counted independently', () => {
    const w = fakeWindow();
    installErrorReporter(w as unknown as Window);
    for (let i = 0; i < 10; i++)
      w.emit('error', {message: 'A', filename: 'a.js', lineno: 1, colno: 1, error: new Error('A')});
    for (let i = 0; i < 10; i++)
      w.emit('error', {message: 'B', filename: 'b.js', lineno: 1, colno: 1, error: new Error('B')});
    expect(cyclogSpy).toHaveBeenCalledTimes(10);
  });
});
