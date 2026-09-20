import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The keyboard-OPEN page push (device-confirmed on iPhone): WebKit pans the
// visual viewport to reveal the caret while the keyboard rises, and the html
// `top: var(--cyc-vv-top)` pin chased it through a deferred rAF, so the whole
// page (header included) excursioned up and snapped back. The shell applies
// viewport writes SYNCHRONOUSLY while the composer is focused (the rAF
// coalescing stays for unfocused browser-chrome tracking).
//
// A preemptive focusin lift from a learned keyboard height (localStorage
// cyc.kb.predict) was tried alongside the sync writes and device-rejected
// (2026-09-05): the lift itself was a visible jump on every open after the
// first. These tests pin the sync-write ordering AND pin that no focus-time
// lift exists (including with a stale cyc.kb.predict key left by the
// reverted build).

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  constructor(height: number) {
    super();
    this.height = height;
  }
}

const LAYOUT = 844;
// The reverted prediction machinery persisted under this key; installs from
// that build may have left it behind on real devices.
const STALE_PREDICT_KEY = 'cyc.kb.predict';
let originalVv: PropertyDescriptor | undefined;

function setVv(vvObj: FakeVisualViewport | null) {
  Object.defineProperty(window, 'visualViewport', {value: vvObj, configurable: true});
}

function inset() {
  return document.documentElement.style.getPropertyValue('--cyc-kb-inset');
}

function vvTop() {
  return document.documentElement.style.getPropertyValue('--cyc-vv-top');
}

function focusComposer() {
  const input = document.getElementById('ci') as HTMLInputElement;
  input.focus();
  // jsdom's focusin delivery has varied across versions; dispatch explicitly.
  // The shell's focusin handler only recomputes, so a double delivery is
  // harmless.
  input.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
}

// Each install's disposer detaches its listeners so a stale closure from an
// earlier test (or the first install inside a test) cannot keep writing the
// viewport vars underneath the assertions.
let dispose: (() => void) | null = null;

async function install() {
  dispose?.();
  const {installShell} = await import('../shell/viewport');
  dispose = installShell(document.getElementById('cyc-app')!);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  localStorage.removeItem(STALE_PREDICT_KEY);
  originalVv = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  document.documentElement.style.removeProperty('--cyc-kb-inset');
  document.documentElement.style.removeProperty('--cyc-vv-top');
  document.documentElement.getBoundingClientRect = () =>
    ({
      height: LAYOUT,
      width: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: LAYOUT,
      x: 0,
      y: 0,
      toJSON() {}
    }) as DOMRect;
  document.body.innerHTML =
    '<div id="cyc-app"></div>' + '<div class="cyc-composer"><input id="ci" type="text"></div>';
  Object.defineProperty(window, 'scrollX', {value: 0, configurable: true});
  Object.defineProperty(window, 'scrollY', {value: 0, configurable: true});
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

afterEach(() => {
  dispose?.();
  dispose = null;
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.removeItem(STALE_PREDICT_KEY);
  if (originalVv) Object.defineProperty(window, 'visualViewport', originalVv);
});

describe('write ordering: synchronous while the composer is focused', () => {
  test('a vv pan with the composer focused lands in the same task (no rAF wait)', async () => {
    const vvObj = new FakeVisualViewport(544);
    setVv(vvObj);
    await install();
    focusComposer();

    vvObj.offsetTop = 50;
    vvObj.dispatchEvent(new Event('scroll'));
    // No timer/rAF flush: the pin write must already be there.
    expect(vvTop()).toBe('50px');
  });

  test('non-vacuity: the same pan unfocused stays rAF-deferred', async () => {
    const vvObj = new FakeVisualViewport(LAYOUT);
    setVv(vvObj);
    await install();
    expect(vvTop()).toBe('0px');

    vvObj.offsetTop = 50;
    vvObj.dispatchEvent(new Event('scroll'));
    // Still the pre-event value before the rAF fires: proves the focused
    // assertion above is not passing because everything is synchronous.
    expect(vvTop()).toBe('0px');
    vi.advanceTimersByTime(50);
    expect(vvTop()).toBe('50px');
  });
});

describe('no preemptive focus-time lift (the reverted regression)', () => {
  test('focusin with the keyboard closed leaves the inset at zero', async () => {
    const vvObj = new FakeVisualViewport(LAYOUT); // keyboard closed
    setVv(vvObj);
    await install();
    focusComposer();
    expect(inset()).toBe('0px');
    // No delayed lift either: no timer may raise the inset without geometry.
    vi.advanceTimersByTime(2000);
    expect(inset()).toBe('0px');
  });

  test('a stale cyc.kb.predict key from the reverted build is ignored', async () => {
    localStorage.setItem(STALE_PREDICT_KEY, JSON.stringify({p: 300, l: 300, soft: true}));
    const vvObj = new FakeVisualViewport(LAYOUT);
    setVv(vvObj);
    await install();
    focusComposer();
    expect(inset()).toBe('0px');
    vi.advanceTimersByTime(2000);
    expect(inset()).toBe('0px');
  });
});

describe('real geometry still drives the inset', () => {
  test('a real open computes the inset synchronously; close returns it to zero', async () => {
    const vvObj = new FakeVisualViewport(LAYOUT);
    setVv(vvObj);
    await install();
    focusComposer();
    expect(inset()).toBe('0px');

    // The keyboard opens for real: the edge math computes the height, in the
    // same task (the sync-write path, composer focused).
    vvObj.height = 544;
    vvObj.dispatchEvent(new Event('resize'));
    expect(inset()).toBe('300px');
    // Nothing is persisted for a future preemptive lift.
    expect(localStorage.getItem(STALE_PREDICT_KEY)).toBeNull();

    // Close path: blur + full-height viewport drop the inset back to zero.
    (document.getElementById('ci') as HTMLInputElement).blur();
    document.dispatchEvent(new Event('focusout', {bubbles: true}));
    vvObj.height = LAYOUT;
    vvObj.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(300);
    expect(inset()).toBe('0px');
  });
});
