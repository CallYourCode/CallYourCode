// Pure inset math for keeping the composer flush above the on-screen keyboard.
//
// When the soft keyboard opens, the visual viewport shrinks below the box the
// composer is positioned in (the 100dvh root). The composer's `bottom:
// var(--cyc-kb-inset)` is measured up from that box's BOTTOM EDGE, so the lift
// that puts it exactly on the keyboard is the distance between the two bottom
// edges, both taken in the same (layout-viewport client) coordinates:
//
//   inset = rootBottom - (vv.offsetTop + vv.height)
//
// rootBottom is documentElement.getBoundingClientRect().bottom, i.e. where the
// 100dvh box actually ends AFTER the iOS `top: var(--cyc-vv-top)` pin has been
// written for this frame. vv.offsetTop + vv.height is where the visual viewport
// (whose bottom edge IS the keyboard's top edge) ends. Subtracting edges, not
// heights, keeps the composer flush for EVERY pin/reveal combination: when the
// pin tracks offsetTop exactly the two offsetTop terms cancel and this equals
// the classic height difference; on a frame where WebKit has pushed the visual
// viewport (its caret-reveal scroll) and the pin has not followed, the smaller
// inset keeps the composer ON the keyboard instead of floating above it.
//
// This value is per-frame TRACKING of a browser animation, not a user-visible
// state change: it must be applied instantly, never through a CSS transition
// (a transition on the composer's bottom, or on the root pin, would turn the
// keyboard slide into a laggy rubber-band of the whole layout).
//
// We gate on composer focus so toolbar show/hide -- which also shrinks the
// visual viewport on iOS but must not lift the composer -- never produces a
// spurious inset, and clamp a small threshold of noise plus any negative to
// zero.
export function keyboardInsetFrom(
  vv: {height: number; offsetTop?: number} | null,
  rootBottom: number,
  focused: boolean,
  threshold = 8
): number {
  if (!focused || !vv) return 0;
  const vvBottom = (vv.offsetTop ?? 0) + vv.height;
  const raw = Math.round(rootBottom - vvBottom);
  return raw > threshold ? raw : 0;
}
