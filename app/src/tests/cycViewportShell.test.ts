import {beforeAll, describe, expect, test} from 'vitest';
describe('installShell', () => {
  beforeAll(async () => {
    document.body.innerHTML = '<div id="cyc-app"></div>';
    const {installShell} = await import('../shell/viewport');
    installShell(document.getElementById('cyc-app')!);
  });
  test('root height is CSS-owned (100dvh): the shell writes no --vh custom property', () => {
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('');
  });
  test('writes the visual-viewport top offset immediately (first write is not deferred)', () => {
    const top = document.documentElement.style.getPropertyValue('--cyc-vv-top');
    expect(top).toMatch(/px$/);
    expect(parseFloat(top)).toBeGreaterThanOrEqual(0);
  });
  test('publishes the keyboard inset immediately, zero with no composer focused', () => {
    const kb = document.documentElement.style.getPropertyValue('--cyc-kb-inset');
    expect(kb).toBe('0px');
  });
  test('pins the wallpaper pattern variables', () => {
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--cyc-pattern')).toContain('url(');
    expect(style.getPropertyValue('--cyc-pattern-size')).toBe('1000px 1000px');
  });
  test('sets pointer and theme data on the document', () => {
    const ptr = document.documentElement.dataset.pointer;
    expect(ptr === 'fine' || ptr === 'coarse').toBe(true);
  });
});
