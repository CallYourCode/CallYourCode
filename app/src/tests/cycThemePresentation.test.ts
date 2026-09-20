import {beforeEach, afterEach, describe, expect, test} from 'vitest';
import {applyCycTheme, currentCycTheme} from '../features/settings/preferences';
import {toggle} from '../components/widgets';
import {currentPresentationTheme, setPresentationTheme} from '../components/presentation';

beforeEach(() => {
  document.documentElement.dir = '';
  document.body.innerHTML = '';
  setPresentationTheme('day');
  try {
    localStorage.removeItem('cyc-skin');
  } catch {}
});

afterEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('applyCycTheme presentation seam', () => {
  test('drives the TS presentation state and legacy markers together', () => {
    applyCycTheme('night');
    expect(currentPresentationTheme()).toBe('night');
    expect(currentCycTheme()).toBe('night');
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyCycTheme('day');
    expect(currentPresentationTheme()).toBe('day');
    expect(currentCycTheme()).toBe('day');
  });

  test('repaints an already-mounted toggle when the theme is applied', () => {
    const {el} = toggle();
    document.body.append(el);
    const track = el.querySelector<HTMLElement>('.cyc-toggle-track')!;
    expect(track.className).toContain('bg-[#6b6b70]');
    applyCycTheme('night');
    expect(track.className).toContain('bg-[#a0a0a6]');
  });

  test('persists the chosen theme to localStorage (no regression)', () => {
    applyCycTheme('night');
    expect(localStorage.getItem('cyc-skin')).toBe('night');
    applyCycTheme('day');
    expect(localStorage.getItem('cyc-skin')).toBe('day');
  });
});
