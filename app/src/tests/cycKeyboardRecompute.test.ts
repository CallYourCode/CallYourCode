import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// Regression guard for the stranded keyboard inset (H1): iOS can dismiss the
// keyboard WITHOUT a focusout and WITHOUT a visualViewport resize back to full
// height, so nothing re-invokes the inset math and --cyc-kb-inset stays > 0 (the
// composer stays lifted, the pad-bottom spacer keeps its margin). installShell
// now coalesces a recompute a beat after any blur/focusout, and keyboardInsetFrom
// returns 0 for a full-height visual viewport even if the composer still reads as
// focused, so a missed event cannot strand the inset.

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  constructor(height: number) {
    super();
    this.height = height;
  }
}

const LAYOUT = 844;
let originalVv: PropertyDescriptor | undefined;

function setVv(vv: FakeVisualViewport | null) {
  Object.defineProperty(window, 'visualViewport', {value: vv, configurable: true});
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  originalVv = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  document.documentElement.style.removeProperty('--cyc-kb-inset');
  // The inset is measured against the composer's containing block: the RENDERED
  // height of the 100dvh root box (getBoundingClientRect), not the layout
  // viewport clientHeight. Mock the box height here so the shell reads it.
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
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  if (originalVv) Object.defineProperty(window, 'visualViewport', originalVv);
});

describe('keyboard inset recompute on blur/focusout', () => {
  test('a blur re-zeroes a stranded inset when the visual viewport is full height', async () => {
    // Keyboard is up at install time: focused composer + a shrunk visual viewport.
    const vv = new FakeVisualViewport(544);
    setVv(vv);
    const input = document.getElementById('ci') as HTMLInputElement;
    input.focus();

    const {installShell} = await import('../shell/viewport');
    installShell(document.getElementById('cyc-app')!);
    expect(document.documentElement.style.getPropertyValue('--cyc-kb-inset')).toBe('300px');

    // iOS dismisses the keyboard: the visual viewport returns to full height but
    // NO resize/focusout event is delivered. The inset is stranded.
    vv.height = LAYOUT;
    expect(document.documentElement.style.getPropertyValue('--cyc-kb-inset')).toBe('300px');

    // A window blur alone must now drive the coalesced recompute to 0.
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(300);
    expect(document.documentElement.style.getPropertyValue('--cyc-kb-inset')).toBe('0px');
  });

  test('a focusout also drives the recompute to 0', async () => {
    const vv = new FakeVisualViewport(544);
    setVv(vv);
    const input = document.getElementById('ci') as HTMLInputElement;
    input.focus();

    const {installShell} = await import('../shell/viewport');
    installShell(document.getElementById('cyc-app')!);
    expect(document.documentElement.style.getPropertyValue('--cyc-kb-inset')).toBe('300px');

    vv.height = LAYOUT;
    document.dispatchEvent(new Event('focusout', {bubbles: true}));
    // Flush both the existing rAF path and the new coalesced timeout.
    vi.advanceTimersByTime(300);
    expect(document.documentElement.style.getPropertyValue('--cyc-kb-inset')).toBe('0px');
  });
});

describe('keyboard inset uses the composer box height, not the layout viewport', () => {
  // The open-keyboard over-lift band: the composer is positioned inside the
  // 100dvh root box, but on iOS `documentElement.clientHeight` (the layout
  // viewport) can read LARGER than that box mid keyboard/toolbar transition.
  // Using clientHeight then lifts the composer by more than the true keyboard
  // occlusion, opening the band that shows chat content + the keyboard's own
  // accessory pill. The inset must come from the rendered 100dvh box instead.
  test('a layout viewport larger than the 100dvh box does not over-lift', async () => {
    const BOX = 800; // the rendered 100dvh containing block
    const KEYBOARD = 320; // real occlusion above which the composer must rest
    // clientHeight reads the STALE/large layout viewport (the bug trigger).
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 900,
      configurable: true
    });
    document.documentElement.getBoundingClientRect = () =>
      ({
        height: BOX,
        width: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: BOX,
        x: 0,
        y: 0,
        toJSON() {}
      }) as DOMRect;

    const vv = new FakeVisualViewport(BOX - KEYBOARD);
    setVv(vv);
    (document.getElementById('ci') as HTMLInputElement).focus();

    const {installShell} = await import('../shell/viewport');
    installShell(document.getElementById('cyc-app')!);

    // Exactly the keyboard height (BOX - vv.height = 320), NOT the clientHeight
    // reading (900 - 480 = 420) that would strand a 100px band below the composer.
    expect(document.documentElement.style.getPropertyValue('--cyc-kb-inset')).toBe('320px');
  });
});
