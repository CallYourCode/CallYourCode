import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {placeMenu, type PopupAnchor} from '../features/chat/placeMenu';

// jsdom layout values are stubbed for placement tests.

const ORIGINAL_W = window.innerWidth;
const ORIGINAL_H = window.innerHeight;

const setViewport = (w: number, h: number) => {
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: w});
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: h});
};

const menu = (width: number, height: number) => {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', {configurable: true, value: width});
  Object.defineProperty(el, 'offsetHeight', {configurable: true, value: height});
  return el;
};

const at = (x: number, y: number): PopupAnchor => ({x, y});

beforeEach(() => setViewport(1024, 768));

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: ORIGINAL_W});
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: ORIGINAL_H});
});

describe('placeMenu horizontal placement', () => {
  test('opens to the right when the menu fits, origin at the left-top corner', () => {
    const el = menu(200, 300);
    placeMenu(at(100, 120), el);
    expect(el.style.left).toBe('100px');
    expect(el.style.top).toBe('120px');
    expect(el.style.transformOrigin).toBe('left top');
  });

  test('flips to the left when there is no room on the right, origin at right-top', () => {
    const el = menu(200, 300);
    placeMenu(at(924, 120), el);
    expect(el.style.left).toBe(`${924 - 200}px`);
    expect(el.style.transformOrigin).toBe('right top');
  });
});

describe('placeMenu clamping to the edge inset', () => {
  test('clamps the top so the menu stays on-screen near the bottom edge', () => {
    const el = menu(200, 300);
    placeMenu(at(100, 700), el);
    expect(el.style.top).toBe('461px');
  });

  test('honours a configurable edge inset for the left clamp', () => {
    const el = menu(1000, 300);
    placeMenu(at(100, 120), el, 24);
    expect(el.style.left).toBe('24px');
    expect(el.style.transformOrigin).toBe('right top');
  });
});
