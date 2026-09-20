import {describe, expect, test} from 'vitest';
import {createTypingIndicator} from '../features/chat/navigation/typing';
import {busyDotsGlyph} from '../components/domHelpers';

// Typing and transcript motion DOM coverage.

describe('the typing indicator is a dots glyph with an optional trailing label', () => {
  test('the dots glyph, not a word, carries the busy state', () => {
    const {el} = createTypingIndicator();
    expect(el.querySelector('.cyc-busy-dots')).not.toBeNull();
    expect(el.textContent).not.toContain('thinking');
    expect(el.getAttribute('aria-label')).toBe('thinking');
  });

  test('setText appends the label past the dots (a plain space, no middot), and updates the aria-label', () => {
    const {el, setText} = createTypingIndicator('thinking');
    setText('2m');
    expect(el.querySelector('.cyc-typing-suffix')?.textContent).toBe(' 2m');
    expect(el.getAttribute('aria-label')).toBe('thinking, 2m');
    setText('');
    expect(el.querySelector('.cyc-typing-suffix')?.textContent).toBe('');
    expect(el.getAttribute('aria-label')).toBe('thinking');
  });

  test('a different ariaBase (e.g. "working") carries through to the aria-label', () => {
    const {el} = createTypingIndicator('working', '3m');
    expect(el.getAttribute('aria-label')).toBe('working, 3m');
  });
});

describe('busyDotsGlyph is three real dot spans on the plain-CSS dot-flashing animation', () => {
  test('three dot spans, each carrying the cyc-busy-dot class and a distinct stagger', () => {
    const glyph = busyDotsGlyph();
    expect(glyph.className).toContain('cyc-busy-dots');
    const dots = [...glyph.children] as HTMLElement[];
    expect(dots).toHaveLength(3);
    for (const d of dots) expect(d.className).toContain('cyc-busy-dot');
    expect(dots.map((d) => d.style.animationDelay)).toEqual(['0s', '0.2s', '0.4s']);
  });
});
