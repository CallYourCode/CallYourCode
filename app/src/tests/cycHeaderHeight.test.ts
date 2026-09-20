// Header-height selection, resize, measurement, and browser coverage.

import {afterAll, afterEach, beforeAll, describe, expect, test} from 'vitest';
import {chromium, type Browser} from 'playwright';

import {
  headerHeightValue,
  headerResizePainterCount,
  headerWidthBucket,
  paintHeaderHeight
} from '../features/sessions/header/headerHeight';
import {createHeaderActions} from '../features/sessions/header/actions';
import {setPresentationTheme} from '../components/presentation';

const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});

beforeAll(() => {
  (globalThis as {ResizeObserver?: unknown}).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  localStorage.clear();
  document.body.textContent = '';
  // Clear detached resize hooks between tests.
  window.dispatchEvent(new Event('resize'));
  setPresentationTheme('day');
});

describe('headerWidthBucket draws the subphone / phone / wide boundaries', () => {
  test('subphone at and below 360, phone up to 550, wide from 551', () => {
    expect(headerWidthBucket(320)).toBe('subphone');
    expect(headerWidthBucket(360)).toBe('subphone');
    expect(headerWidthBucket(361)).toBe('phone');
    expect(headerWidthBucket(500)).toBe('phone');
    expect(headerWidthBucket(550)).toBe('phone');
    expect(headerWidthBucket(551)).toBe('wide');
    expect(headerWidthBucket(1000)).toBe('wide');
  });
});

describe('headerHeightValue reproduces the old fork table for every bucket x extra', () => {
  const calc = (rem: string) => `calc(${rem}rem + var(--cyc-safe-top))`;
  const MATRIX: Array<[ReturnType<typeof headerWidthBucket>, number, string]> = [
    ['wide', 0, '4'],
    ['wide', 1, '7.125'],
    ['wide', 2, '10.25'],
    ['wide', 3, '4'],
    ['wide', 5, '4'],
    ['phone', 0, '3.625'],
    ['phone', 1, '6.625'],
    ['phone', 2, '9.9375'],
    ['phone', 3, '6.625'],
    ['phone', 5, '6.625'],
    ['subphone', 0, '3.625'],
    ['subphone', 1, '6.625'],
    ['subphone', 2, '9.9375'],
    ['subphone', 3, '9.9375'],
    ['subphone', 5, '9.9375']
  ];
  for (const [bucket, extra, rem] of MATRIX) {
    test(`${bucket} extra=${extra} -> ${rem}rem`, () => {
      expect(headerHeightValue(bucket, extra)).toBe(calc(rem));
    });
  }

  test('the subphone/phone divergence lives only in the extra>=3 fallback leg', () => {
    for (const extra of [0, 1, 2])
      expect(headerHeightValue('subphone', extra)).toBe(headerHeightValue('phone', extra));
    expect(headerHeightValue('subphone', 3)).not.toBe(headerHeightValue('phone', 3));
  });
});

describe('paintHeaderHeight writes the owning .cyc-thread and re-selects on width change', () => {
  const mount = () => {
    const chat = document.createElement('div');
    chat.className = 'cyc-thread';
    const headerEl = document.createElement('div');
    chat.append(headerEl);
    document.body.append(chat);
    return {chat, headerEl};
  };

  test('a live resize crossing the phone boundary re-selects for the same extra', () => {
    const {chat, headerEl} = mount();
    setWidth(800);
    const setExtra = paintHeaderHeight(headerEl);
    setExtra(1);
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('wide', 1)
    );
    setWidth(400);
    setExtra(1);
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('phone', 1)
    );
  });

  test('a shared presentation change repaints via the registered snapshot painter', () => {
    const {chat, headerEl} = mount();
    setWidth(800);
    const setExtra = paintHeaderHeight(headerEl);
    setExtra(2);
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('wide', 2)
    );
    setWidth(340);
    setPresentationTheme('night');
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('subphone', 2)
    );
  });

  test('a raw resize crossing 361<->360 reselects subphone with extra + bar width constant', () => {
    const {chat, headerEl} = mount();
    setWidth(361);
    const setExtra = paintHeaderHeight(headerEl);
    setExtra(3); // extra>=3 fallback diverges: phone 6.625rem vs subphone 9.9375rem.
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('phone', 3)
    );
    setWidth(360);
    window.dispatchEvent(new Event('resize'));
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('subphone', 3)
    );
    setWidth(361);
    window.dispatchEvent(new Event('resize'));
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('phone', 3)
    );
  });

  test('the raw resize hook self-tears-down once its header detaches', () => {
    const before = headerResizePainterCount();
    const {chat, headerEl} = mount();
    setWidth(361);
    const setExtra = paintHeaderHeight(headerEl);
    setExtra(3);
    expect(headerResizePainterCount()).toBe(before + 1);
    // Detached headers must not repaint on resize.
    chat.remove();
    setWidth(360);
    window.dispatchEvent(new Event('resize'));
    expect(headerResizePainterCount()).toBe(before);
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('phone', 3)
    );
  });

  test('a header not yet appended to a .cyc-thread paints nothing (no throw)', () => {
    const orphan = document.createElement('div');
    document.body.append(orphan);
    setWidth(500);
    const setExtra = paintHeaderHeight(orphan);
    expect(() => setExtra(1)).not.toThrow();
    expect(orphan.closest('.cyc-thread')).toBeNull();
  });
});

describe('createHeaderActions flows the measured wrap count to the header-height var', () => {
  const ENGINE = 'test-engine';
  const mountBar = (innerWidth: number) => {
    setWidth(innerWidth);
    const chat = document.createElement('div');
    chat.className = 'cyc-thread';
    const el = document.createElement('div');
    Object.defineProperty(el, 'offsetWidth', {configurable: true, value: 500});
    const utils = document.createElement('div');
    el.append(utils);
    chat.append(el);
    document.body.append(chat);
    const actions = createHeaderActions({
      el,
      utils,
      sessionId: () => 'sess-1',
      toolbarEngine: () => ({engineKey: ENGINE, plugins: new Set<string>()})
    });
    utils.append(actions.headerBreak);
    return {chat, el, utils, actions};
  };

  test('no wrap (flat row) selects the extra=0 literal and sets no body attribute', () => {
    const {chat} = mountBar(500);
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('phone', 0)
    );
    expect(document.body.hasAttribute('data-cyc-header-extra')).toBe(false);
  });

  test('two wrapped rows (stubbed slot geometry) select the extra=2 literal', () => {
    const {chat, utils, actions} = mountBar(500);
    // Stub three toolbar rows.
    utils.append(slotAt(0), slotAt(0), slotAt(20), slotAt(20), slotAt(40));
    actions.refreshToolbarActions();
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('phone', 2)
    );
    expect(document.body.hasAttribute('data-cyc-header-extra')).toBe(false);
  });

  function slotAt(top: number): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'cyc-mast-slot';
    Object.defineProperty(slot, 'offsetWidth', {configurable: true, value: 40});
    slot.getBoundingClientRect = () =>
      ({top, bottom: top + 20, left: 0, right: 40, width: 40, height: 20, x: 0, y: top}) as DOMRect;
    return slot;
  }
});

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

describe('cascade: a --cyc-chat-header-height consumer resolves to the historical pixels', () => {
  const mount = (innerWidth: number, extra: number) => {
    setWidth(innerWidth);
    const chat = document.createElement('div');
    chat.className = 'cyc-thread';
    const headerEl = document.createElement('div');
    chat.append(headerEl);
    document.body.append(chat);
    paintHeaderHeight(headerEl)(extra);
    const value = chat.style.getPropertyValue('--cyc-chat-header-height');
    document.body.textContent = '';
    return value;
  };

  // The fixture uses a 16px root and zero safe-area inset.
  const CASES: Array<[string, number, number, number]> = [
    ['subphone extra=3 -> 9.9375rem', 340, 3, 9.9375 * 16],
    ['phone extra=3 -> 6.625rem', 500, 3, 6.625 * 16],
    ['wide extra=0 -> 4rem (base)', 1000, 0, 4 * 16],
    ['phone extra=2 -> 9.9375rem', 500, 2, 9.9375 * 16]
  ];

  for (const [label, width, extra, px] of CASES) {
    test(label, async () => {
      const value = mount(width, extra);
      const html =
        `<!DOCTYPE html><html style="font-size:16px"><head><meta charset="utf-8"></head>` +
        `<body style="margin:0"><div class="cyc-thread" ` +
        `style="--cyc-safe-top:0px;--cyc-chat-header-height:${value}">` +
        `<div id="c" style="height:var(--cyc-chat-header-height)"></div></div></body></html>`;
      const page = await (await getBrowser()).newPage();
      try {
        await page.setContent(html, {waitUntil: 'load'});
        const h = await page.$eval('#c', (el) => getComputedStyle(el).height);
        expect(parseFloat(h)).toBeCloseTo(px, 2);
      } finally {
        await page.close();
      }
    });
  }
});
