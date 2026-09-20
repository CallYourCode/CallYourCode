import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {mirrorScrollbarGutter} from '@/features/chat/surface/scrollbarGutter';

// grep token: `column align`. A classic scrollbar takes layout width at the
// scroller's inline end only; the column centres in what is left and lands
// half a scrollbar toward the inline start of the composer. The mirror pads
// the inline start by the scrollbar's width so the client box is symmetric.

type Box = {offsetWidth: number; clientWidth: number};

function scroller(box: Box) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', {get: () => box.offsetWidth, configurable: true});
  Object.defineProperty(el, 'clientWidth', {get: () => box.clientWidth, configurable: true});
  return el;
}

describe('mirrorScrollbarGutter', () => {
  let fire: () => void = () => {};
  let observed: Element[] = [];
  let disconnected = 0;
  beforeEach(() => {
    fire = () => {};
    observed = [];
    disconnected = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe(el: Element) {
          observed.push(el);
        }
        disconnect() {
          disconnected++;
        }
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  test('a classic scrollbar is mirrored as inline-start padding', () => {
    const el = scroller({offsetWidth: 414, clientWidth: 404});
    mirrorScrollbarGutter(el);
    expect(el.style.paddingInlineStart).toBe('10px');
    expect(observed).toEqual([el]);
  });

  test('an overlay scrollbar (no layout width) gets no padding', () => {
    const el = scroller({offsetWidth: 414, clientWidth: 414});
    mirrorScrollbarGutter(el);
    expect(el.style.paddingInlineStart).toBe('');
  });

  test('the padding follows the scrollbar as it appears and goes', () => {
    const box: Box = {offsetWidth: 740, clientWidth: 740};
    const el = scroller(box);
    const stop = mirrorScrollbarGutter(el);
    expect(el.style.paddingInlineStart).toBe('');
    box.clientWidth = 730;
    fire();
    expect(el.style.paddingInlineStart).toBe('10px');
    // The padding sits inside the client box, so the observer's second pass
    // (the content box shrank by the padding) measures the same scrollbar.
    fire();
    expect(el.style.paddingInlineStart).toBe('10px');
    box.clientWidth = 740;
    fire();
    expect(el.style.paddingInlineStart).toBe('');
    stop();
    expect(disconnected).toBe(1);
  });

  test('without ResizeObserver it measures once and returns a no-op stop', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const el = scroller({offsetWidth: 414, clientWidth: 408});
    const stop = mirrorScrollbarGutter(el);
    expect(el.style.paddingInlineStart).toBe('6px');
    expect(() => stop()).not.toThrow();
  });
});
