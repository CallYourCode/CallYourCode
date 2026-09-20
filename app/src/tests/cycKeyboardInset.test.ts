import {describe, expect, test} from 'vitest';
import {keyboardInsetFrom} from '../shell/keyboardInset';

// The inset is the distance between two BOTTOM edges in layout-viewport client
// coordinates: the composer's 100dvh containing box (rootBottom, from
// documentElement.getBoundingClientRect().bottom after the pin write) and the
// visual viewport (offsetTop + height, whose bottom edge is the keyboard's top).
// When the box top sits at 0 and offsetTop is 0 this reduces to the classic
// height difference, which is what most cases below use.
describe('keyboardInsetFrom', () => {
  test('unfocused is always zero regardless of viewport shrink', () => {
    expect(keyboardInsetFrom({height: 544}, 844, false)).toBe(0);
    expect(keyboardInsetFrom(null, 844, false)).toBe(0);
  });

  test('focused with a shrunk visual viewport lifts by the difference', () => {
    expect(keyboardInsetFrom({height: 544}, 844, true)).toBe(300);
  });

  test('equal heights (keyboard closed) is zero while focused', () => {
    expect(keyboardInsetFrom({height: 844}, 844, true)).toBe(0);
  });

  test('sub-threshold noise is clamped to zero', () => {
    expect(keyboardInsetFrom({height: 840}, 844, true)).toBe(0);
  });

  test('never negative when the visual viewport is taller than layout', () => {
    expect(keyboardInsetFrom({height: 900}, 844, true)).toBe(0);
  });

  test('missing visual viewport yields no inset', () => {
    expect(keyboardInsetFrom(null, 844, true)).toBe(0);
  });

  // The composer lift (--cyc-kb-inset) is exactly this value, and the composer's
  // home-indicator safe-area floor is then subtracted by it in CSS so the two are
  // never added together (the double-count that showed as a gap). These cases lock
  // the inset math on a device that HAS a bottom safe-area inset, open vs closed.
  describe('device with a home-indicator safe area (open vs closed)', () => {
    // iPhone-class layout viewport that already includes the ~34px home-indicator
    // safe area at the bottom.
    const LAYOUT = 844;

    test('keyboard closed: inset is zero, so the composer keeps its full safe-area floor', () => {
      // Visual viewport equals the layout viewport; no keyboard.
      expect(keyboardInsetFrom({height: LAYOUT}, LAYOUT, true)).toBe(0);
    });

    test('keyboard open (SwiftKey): inset is the full shrink, keyboard + suggestion bar', () => {
      // A third-party keyboard whose visualViewport height includes the keyboard
      // AND its suggestion bar; the shrink covers the home-indicator area too, so
      // the lift must equal exactly this and the safe-area floor must NOT be added
      // on top of it.
      const withKeyboard = 396; // visible area above a 448px keyboard stack
      expect(keyboardInsetFrom({height: withKeyboard}, LAYOUT, true)).toBe(LAYOUT - withKeyboard);
      expect(keyboardInsetFrom({height: withKeyboard}, LAYOUT, true)).toBe(448);
    });
  });

  // WebKit's caret-reveal pushes the visual viewport down (offsetTop > 0)
  // during the keyboard-open animation. The inset must use the visual
  // viewport's BOTTOM EDGE, not its height, or the composer floats above the
  // keyboard by exactly offsetTop on every frame where the root pin has not
  // (yet) followed the push.
  describe('caret-reveal push (offsetTop > 0)', () => {
    test('pin not yet applied: the inset shrinks by offsetTop so the composer stays ON the keyboard', () => {
      // Root box still at top 0 (bottom 844); visual viewport pushed down 100.
      // vv bottom edge = 100 + 544 = 644; the composer must sit 200 up, not 300.
      expect(keyboardInsetFrom({height: 544, offsetTop: 100}, 844, true)).toBe(200);
    });

    test('pin caught up: the offsetTop terms cancel and the classic lift holds', () => {
      // Pin moved the root box down by the same 100 (bottom 944); vv bottom is
      // 644, so the lift is back to the full 300 keyboard height.
      expect(keyboardInsetFrom({height: 544, offsetTop: 100}, 944, true)).toBe(300);
    });

    test('omitted offsetTop behaves as zero (back-compat with height-only callers)', () => {
      expect(keyboardInsetFrom({height: 544}, 844, true)).toBe(
        keyboardInsetFrom({height: 544, offsetTop: 0}, 844, true)
      );
    });
  });
});
