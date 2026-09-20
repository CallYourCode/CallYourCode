import glyphsAUrl from '../assets/glyphs-a.svg?url';
import {installCodeBlockActions} from '@/features/code/viewer';
import {installCodeCopy} from '@/features/code/viewer';
import {applyCycTheme, currentCycTheme, storedCycTheme} from '@/features/settings/preferences';
import {installPresentationReactivity} from '../components/presentation';
import {keyboardInsetFrom} from './keyboardInset';
import {toast} from '../components/widgets';
import {openCodeViewer} from '../features/code/codeViewer';

// ---- keyboard-open push prevention ------------------------------------------
// On iPhone (PWA, WebKit), opening the soft keyboard could shove the WHOLE
// page (fixed header included) up and let it settle back. Frame-measured from
// the owner's 2026-09-05 screen recordings (header-band cross-correlation, 60
// and 30 fps):
//
//   - rAF-deferred viewport writes (the 76d2b2b build): the page rides up to
//     ~39pt during the keyboard rise, then relaxes back to exactly 0 in an
//     exponential decay over ~320ms. CONFIRMED (recording 1).
//   - The same inset/clamp code with SYNCHRONOUS writes while the composer is
//     focused, and no predictive lift: shift stayed +0 on every frame through
//     an entire keyboard open. CONFIRMED (recording 2, first open).
//   - A PREEMPTIVE focusin lift by a learned keyboard height: clean first
//     open (nothing learned yet), then a ~47pt shove landing right at the END
//     of the keyboard rise on every later open. CONFIRMED (recording 2, opens
//     two through four). The guess-driven lift is itself the jump. Do not
//     reintroduce prediction here.
//
// Mechanism (the WebKit side is INFERRED, not directly observable from JS):
// the caret still sits at the keyboard-covered bottom at focus time (our lift
// lands only when the first visualViewport event arrives), so WebKit scrolls
// to reveal it; on this unscrollable fixed 100dvh document that surfaces as a
// visual-viewport pan / overscroll excursion the `top: var(--cyc-vv-top)` pin
// does not counter until our write lands. The decay tail in recording 1 with
// no matching pin write is why the remedy is write LATENCY, not write math:
// while the composer is focused, viewport writes run synchronously in the
// event handler instead of through the coalescing rAF (WebKit delivers
// visualViewport events as ordinary tasks, so a rAF queued from one can miss
// the next rendering update; a sync write never lands later than the deferred
// one). The window.scrollTo(0, 0) clamp in writeVvTop covers a reveal that
// lands on the layout viewport instead.
//
// Support notes, checked 2026-09 (be suspicious of these aging):
//   - `interactive-widget=resizes-content` is already in the viewport meta; it
//     is honored by Chrome on Android 108+ and NOT by iOS Safari (any iOS up
//     to 18), so it cannot prevent this pan on iPhone.
//   - The VirtualKeyboard API (navigator.virtualKeyboard) is Chromium-only;
//     unavailable in iOS Safari.
//   - overscroll-behavior / overflow-anchor govern user-scroll chaining and
//     scroll anchoring, not the UA's focus-reveal scroll, and iOS Safari does
//     not implement overflow-anchor at all: neither can suppress the reveal.

// Returns a disposer that detaches the shell's window/document/visualViewport
// listeners. The app never calls it (the shell lives for the page); tests that
// install repeatedly use it so stale closures stop writing viewport vars.
export function installShell(root: HTMLElement): () => void {
  const listeners = new AbortController();
  const signal = listeners.signal;
  installCodeBlockActions(
    root,
    (copied) => toast(copied ? 'Code copied to clipboard' : 'Copy failed'),
    openCodeViewer
  );

  installCodeCopy(document);

  // The document/root height comes from CSS (100dvh) now; the shell only tracks the
  // visual-viewport offset so the iOS fixed-position pin below can follow the browser
  // chrome as it shows/hides.
  const vv = window.visualViewport;
  let vvQueued = 0;
  let vvTopLast = -1;
  let kbLast = -1;

  // True when the focused element is an editable inside the chat composer, so the
  // keyboard inset lifts the composer only for the composer (not search or sheets).
  const composerFocused = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !el.closest('.cyc-composer')) return false;
    return el.isContentEditable || el.matches('input, textarea');
  };

  const writeVvTop = () => {
    vvQueued = 0;
    const top = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;
    if (top !== vvTopLast) {
      vvTopLast = top;
      document.documentElement.style.setProperty('--cyc-vv-top', `${top}px`);
    }
    const focused = composerFocused();
    // WebKit's caret-reveal: at focus time the caret still sits at the
    // keyboard-covered bottom (the lift below only lands once the first
    // visualViewport event arrives), so iOS scrolls the page to expose it.
    // When that reveal lands on the LAYOUT viewport (window.scrollY), the whole
    // fixed-position document is shoved and the entire UI visibly slides, then
    // snaps as our writes catch up. This page never legitimately window-scrolls
    // (a fixed 100dvh box with inner scrollers), so while the composer is
    // focused any window scroll is that push: undo it instead of riding it.
    // Once the composer is lifted the caret is visible, so WebKit does not
    // re-push and this settles at 0.
    if (focused && (window.scrollX !== 0 || window.scrollY !== 0)) window.scrollTo(0, 0);
    // The composer is positioned inside the 100dvh root box (`bottom:
    // var(--cyc-kb-inset)` measured up from that box's bottom, main.ts's
    // .cyc-thread h-full chain -> #cyc-app height:100dvh, chrome.css:258). The
    // lift must therefore be measured against THAT box's rendered BOTTOM EDGE,
    // not the layout viewport: `documentElement.clientHeight` special-cases the
    // root to the layout viewport, which on iOS can differ from the 100dvh box
    // while the keyboard/toolbar transition is in flight (the over-lift band),
    // and a height alone assumes the `top: var(--cyc-vv-top)` pin has exactly
    // cancelled vv.offsetTop, which is false on any frame where WebKit moved
    // the visual viewport before our pin write. getBoundingClientRect().bottom,
    // read AFTER the pin write above, is where the composer's containing block
    // actually ends this frame; keyboardInsetFrom subtracts the visual
    // viewport's bottom edge from it, so the composer lands flush on the
    // keyboard for every pin/reveal combination. Both writes are per-frame
    // tracking and are applied instantly (no CSS transition covers them).
    const rootBottom = document.documentElement.getBoundingClientRect().bottom;
    const kb = keyboardInsetFrom(vv, rootBottom, focused);
    if (kb !== kbLast) {
      kbLast = kb;
      document.documentElement.style.setProperty('--cyc-kb-inset', `${kb}px`);
      window.dispatchEvent(new CustomEvent('cyc:kbinset', {detail: kb}));
    }
  };
  const scheduleVvTop = () => {
    // Composer focused means a keyboard transition may be in flight: write
    // synchronously so the pin and inset land in THIS frame's render instead
    // of chasing the pan through a deferred rAF (the visible excursion).
    // Unfocused work (browser chrome show/hide) keeps the rAF coalescing.
    if (composerFocused()) {
      if (vvQueued) {
        cancelAnimationFrame(vvQueued);
        vvQueued = 0;
      }
      writeVvTop();
      return;
    }
    if (vvQueued) return;
    vvQueued = requestAnimationFrame(writeVvTop);
  };
  writeVvTop();
  window.addEventListener('resize', scheduleVvTop, {signal});
  vv?.addEventListener('resize', scheduleVvTop, {signal});

  vv?.addEventListener('scroll', scheduleVvTop, {signal});
  // A keyboard caret-reveal that lands on the layout viewport fires only a
  // window scroll (offsetTop is untouched, so no visualViewport event): listen
  // for it so the writeVvTop clamp above can undo the push promptly. Only the
  // document's own scroll reaches window; inner scrollers do not bubble here.
  window.addEventListener('scroll', scheduleVvTop, {passive: true, signal});

  // Focus changes alone move the inset (the viewport may not fire on focus).
  document.addEventListener('focusin', scheduleVvTop, {signal});
  document.addEventListener('focusout', scheduleVvTop, {signal});

  // iOS can dismiss the keyboard WITHOUT a focusout and WITHOUT a visualViewport
  // resize back to full height, which would strand --cyc-kb-inset > 0 forever
  // (the composer stays lifted, the pad-bottom spacer keeps its margin). Guard
  // against a missed event with a coalesced recompute a beat after any blur or
  // focusout: keyboardInsetFrom already returns 0 once the visual viewport is
  // full height, so re-invoking it clears the inset even if the focus read is
  // stale (composer keeps focus on a chevron-dismiss). A short delay also catches
  // a viewport resize that lands a frame or two after the blur.
  let recomputeTimer = 0;
  const recomputeSoon = () => {
    if (recomputeTimer) return;
    recomputeTimer = window.setTimeout(() => {
      recomputeTimer = 0;
      writeVvTop();
    }, 250);
  };
  document.addEventListener('focusout', recomputeSoon, {signal});
  window.addEventListener('blur', recomputeSoon, {capture: true, signal});

  document.documentElement.style.setProperty('--cyc-pattern', `url("${glyphsAUrl}")`);
  document.documentElement.style.setProperty('--cyc-pattern-size', '1000px 1000px');
  {
    const root = document.documentElement;
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    root.dataset.pointer = isTouch ? 'coarse' : 'fine';
    const platform = navigator.platform || navigator.userAgent;
    const isAppleMobile =
      /iPad|iPhone|iPod/.test(platform) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isAppleMobile) {
      // Pin the page against iOS rubber-band scroll and follow the visual
      // viewport when the browser chrome shows/hides (--cyc-vv-top above).
      root.style.position = 'fixed';
      root.style.top = 'var(--cyc-vv-top, 0px)';
      root.style.setProperty('-webkit-user-select', 'none');
    }
  }

  applyCycTheme(storedCycTheme() ?? currentCycTheme());

  // painters repaint on resize and pointer changes. The shell owns this for the
  // life of the page.
  installPresentationReactivity();

  return () => listeners.abort();
}
