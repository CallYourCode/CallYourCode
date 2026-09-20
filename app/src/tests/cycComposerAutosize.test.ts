import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';


import {autosize} from '../features/composer/editor';

// Provide deterministic `scrollHeight` values for detached fields.
function stubScrollHeight(el: HTMLElement, content: number) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get() {
      if (el.style.height === 'auto' || el.style.height === '') return content;
      return Math.max(content, parseFloat(el.style.height) || 0);
    }
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('autosize measures the live field (no measuring clone)', () => {
  test('does not create or return a hidden clone element', () => {
    const input = document.createElement('div');
    input.contentEditable = 'true';
    document.body.append(input);

    const sizer = autosize(input);

    expect('fake' in sizer).toBe(false);
    expect(document.body.children.length).toBe(1);

    sizer.destroy();
  });

  test('keeps the live field in flow and carrying the scroll geometry', () => {
    const input = document.createElement('div');
    const sizer = autosize(input);

    expect(input.style.position).toBe('relative');
    expect(input.classList.contains('cyc-overflow')).toBe(true);
    expect(input.classList.contains('cyc-overflow-y')).toBe(true);
    expect(input.classList.contains('overflow-y-auto')).toBe(true);

    sizer.destroy();
  });

  test('update() writes the measured content height and reports it once', () => {
    const input = document.createElement('div');
    input.contentEditable = 'true';
    document.body.append(input);
    stubScrollHeight(input, 84);

    const heights: number[] = [];
    const sizer = autosize(input, {onHeightChange: (h) => heights.push(h)});

    sizer.update(true);

    expect(input.style.height).toBe('84px');
    expect(heights).toEqual([84]);
    expect(input.style.height).not.toBe('auto');
    expect(input.style.overflowY).toBe('');

    sizer.destroy();
  });

  test('clamps the height to the max-height contract and re-clamps on setMaxHeight', () => {
    const input = document.createElement('div');
    input.contentEditable = 'true';
    document.body.append(input);
    stubScrollHeight(input, 300);

    const sizer = autosize(input, {maxHeight: 120});
    sizer.update(true);
    expect(input.style.height).toBe('120px');
    expect(input.style.maxHeight).toBe('120px');

    sizer.setMaxHeight(undefined);
    expect(input.style.height).toBe('300px');
    expect(input.style.maxHeight).toBe('');

    sizer.destroy();
  });

  test('an input event drives a fresh measurement', () => {
    const input = document.createElement('div');
    input.contentEditable = 'true';
    document.body.append(input);
    stubScrollHeight(input, 40);

    const sizer = autosize(input);
    input.dispatchEvent(new Event('input'));
    expect(input.style.height).toBe('40px');

    sizer.destroy();
  });

  test('destroy() detaches the input listener and clears a pending height timeout', () => {
    vi.useFakeTimers();
    const input = document.createElement('div');
    input.contentEditable = 'true';
    document.body.append(input);
    stubScrollHeight(input, 200);

    const sizer = autosize(input);
    sizer.update();
    expect(input.classList.contains('cyc-field-resizing')).toBe(true);

    sizer.destroy();

    input.style.height = '';
    input.dispatchEvent(new Event('input'));
    expect(input.style.height).toBe('');

    expect(() => vi.runAllTimers()).not.toThrow();
  });
});
