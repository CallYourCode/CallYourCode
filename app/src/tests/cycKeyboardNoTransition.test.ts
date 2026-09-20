import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// Keyboard-open glitch guards (the "whole UI does a weird animation" report):
//
// 1. The keyboard-driven geometry -- the composer root's `bottom:
//    var(--cyc-kb-inset)` and the html pin `top: var(--cyc-vv-top)` -- is
//    per-frame tracking of the keyboard slide. It must apply INSTANTLY: any
//    CSS transition on it turns each visualViewport step into its own lagging
//    animation (rubber-band of the composer, and of the whole layout through
//    the thread spacer). The composer root therefore carries NO transition
//    utility at all, and the shell never writes an inline transition on html.
//
// 2. WebKit's caret-reveal can push the layout viewport (window scroll) when
//    the keyboard opens, shoving the whole fixed document; the shell must undo
//    that push (window.scrollTo(0,0)) while the composer is focused, and must
//    hear about it (a layout-viewport push fires only a window scroll event).

(globalThis as {ResizeObserver?: unknown}).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import {createComposer} from '../features/composer/components/messageComposer';

// Any Tailwind transition utility: bare `transition`, `transition-*`,
// arbitrary `[transition:...]`, with or without a variant prefix.
const TRANSITION_UTILITY = /(^|[\s:!])(\[transition:|transition\b)/;

function makeComposer() {
  return createComposer({
    onSend: () => {},
    onJumpToReply: () => {},
    onAttach: () => {},
    onStage: () => {},
    onVoiceStart: () => {},
    onVoiceEnd: () => {},
    onLiveSend: () => {},
    onVoiceCancel: () => {}
  } as never);
}

describe('composer root: keyboard-driven geometry is never transitioned', () => {
  test('the root rides --cyc-kb-inset and carries no transition utility', () => {
    const c = makeComposer();
    expect(c.el.className).toContain('bottom-[var(--cyc-kb-inset,0px)]');
    expect(c.el.className).not.toMatch(TRANSITION_UTILITY);
  });

  test('non-vacuity: the detector does flag a transition-carrying descendant', () => {
    const c = makeComposer();
    // The input keeps its height transition (autosize glide); the matcher must
    // catch it, proving the root assertion above would catch a reintroduction.
    const input = c.el.querySelector('.cyc-composer-input') as HTMLElement;
    expect(input.className).toMatch(TRANSITION_UTILITY);
  });
});

// ---- shell: caret-reveal push clamp ----------------------------------------

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

function setVv(vvObj: FakeVisualViewport | null) {
  Object.defineProperty(window, 'visualViewport', {value: vvObj, configurable: true});
}

function setWindowScroll(x: number, y: number) {
  Object.defineProperty(window, 'scrollX', {value: x, configurable: true});
  Object.defineProperty(window, 'scrollY', {value: y, configurable: true});
}

describe('shell clamps the keyboard caret-reveal push while the composer is focused', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
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
    setWindowScroll(0, 0);
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    if (originalVv) Object.defineProperty(window, 'visualViewport', originalVv);
  });

  test('a window-scroll push with the composer focused is scrolled back to 0,0', async () => {
    const vvObj = new FakeVisualViewport(544);
    setVv(vvObj);
    (document.getElementById('ci') as HTMLInputElement).focus();

    const {installShell} = await import('../shell/viewport');
    installShell(document.getElementById('cyc-app')!);
    expect(window.scrollTo).not.toHaveBeenCalled(); // nothing to undo yet

    // WebKit pushes the layout viewport to reveal the caret: only a window
    // scroll event fires (offsetTop untouched, so no visualViewport event).
    setWindowScroll(0, 120);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(50); // flush the rAF-coalesced write
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  test('unfocused: a window scroll is left alone (no composer, no clamp)', async () => {
    const vvObj = new FakeVisualViewport(544);
    setVv(vvObj);
    (document.getElementById('ci') as HTMLInputElement).blur();

    const {installShell} = await import('../shell/viewport');
    installShell(document.getElementById('cyc-app')!);

    setWindowScroll(0, 120);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(50);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  test('the shell never writes an inline transition on the pinned root', async () => {
    const vvObj = new FakeVisualViewport(544);
    setVv(vvObj);
    (document.getElementById('ci') as HTMLInputElement).focus();

    const {installShell} = await import('../shell/viewport');
    installShell(document.getElementById('cyc-app')!);
    vvObj.height = 500;
    vvObj.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(50);

    expect(document.documentElement.style.getPropertyValue('transition')).toBe('');
    // The keyboard vars did move through that resize (the guard is not vacuous).
    expect(document.documentElement.style.getPropertyValue('--cyc-kb-inset')).toBe('344px');
  });
});
