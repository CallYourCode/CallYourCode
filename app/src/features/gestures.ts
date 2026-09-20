// THE ONE OWNER OF THE GESTURE LIBRARY. Every horizontal-swipe call site depends
// on this module's interface, never on @use-gesture directly, so the recogniser
// can be swapped without touching a single surface. The library gives us the hard
// parts we used to hand-roll and get wrong: axis-intent locking (a mostly-vertical
// drag stays a native scroll), a movement threshold before a gesture is
// intentional, and velocity flick detection on release.
//
// grep token: `gesture wrapper`.
import {DragGesture} from '@use-gesture/vanilla';
import type {FullGestureState, UserDragConfig} from '@use-gesture/vanilla';

// How near the named edge (in CSS px, measured from the target's own box) a drag
// must START for an edge-gated swipe to be captured at all.
const DEFAULT_EDGE_INSET_PX = 24;
// Movement (in px) a drag must travel before it is treated as intentional and
// before its axis is locked. Matches the old hand-rolled arm slop.
const DEFAULT_ARM_PX = 12;

export interface HorizontalSwipeProgress {
  /** Raw horizontal travel from the gesture origin, in px (sign carries direction). */
  dx: number;
  /** -1 when travelling left, 1 when travelling right. */
  dir: -1 | 1;
  /** Fraction of the travel width covered so far (0..1+, unclamped). */
  pct: number;
}

export interface HorizontalSwipeCommit {
  dir: -1 | 1;
  /** True when the commit was won by a velocity flick rather than by distance. */
  flick: boolean;
  pct: number;
}

export interface HorizontalSwipeOptions {
  /**
   * Gate the gesture to drags that START within `edgeInsetPx` of this edge of the
   * target box. Omit to accept a horizontal drag beginning anywhere. This is what
   * keeps the back-swipe an edge gesture.
   */
  edge?: 'left' | 'right';
  edgeInsetPx?: number;
  /**
   * Restrict to a single horizontal direction (-1 left, 1 right). A drag that
   * locks to the opposite direction is left untouched (no capture, no
   * preventDefault, no callbacks) so a second handler can own it.
   */
  direction?: -1 | 1;
  /** Fraction of the travel width (0..1) at release that commits. */
  thresholdPct: number;
  /** Minimum release velocity (px/ms) that commits early, regardless of distance. */
  velocityCommit: number;
  /** Movement before the gesture arms and its axis locks. Defaults to 12px. */
  armPx?: number;
  /** The width the threshold fraction and progress are measured against. */
  travelWidth?: () => number;
  /**
   * Vetoed at gesture start: return false to leave the drag alone (e.g. it began
   * over an inner horizontal scroller that should own its own pan). Receives the
   * element the drag started on.
   */
  canStart?: (startTarget: EventTarget | null) => boolean;
  onProgress?: (p: HorizontalSwipeProgress) => void;
  onCommit?: (c: HorizontalSwipeCommit) => void;
  onCancel?: () => void;
}

type DragHandlerState = FullGestureState<'drag'>;
// The library omits `axisThreshold` from its drag config type (it is a shared
// coordinates option), but the core drag engine reads it, per pointer type, to
// delay the axis lock until the dominant component clears the threshold. We opt
// into it deliberately so a stray first pixel cannot mislock a vertical drag.
type DragAxisThreshold = {mouse?: number; touch?: number; pen?: number};
type DragConfigWithAxisThreshold = UserDragConfig & {axisThreshold?: DragAxisThreshold};

/**
 * Attach a horizontal-swipe recogniser to `target` and return a disposer.
 *
 * Semantics encoded here (identical across every surface that calls it):
 *  - Axis lock: the drag's axis is fixed the moment its dominant component clears
 *    the arm threshold. A predominantly VERTICAL drag locks to `y` and is never
 *    captured, so the browser keeps scrolling natively; only a predominantly
 *    HORIZONTAL drag locks to `x`, captures, and may preventDefault.
 *  - Commit: on release, travel past `thresholdPct` of the width OR a velocity
 *    flick commits; anything short calls `onCancel` so the surface can snap back.
 *  - Edge gating: with `edge` set, only a drag that began near that edge is ever
 *    captured.
 */
export function onHorizontalSwipe(
  target: HTMLElement,
  options: HorizontalSwipeOptions
): () => void {
  const {
    edge,
    edgeInsetPx = DEFAULT_EDGE_INSET_PX,
    direction,
    thresholdPct,
    velocityCommit,
    armPx = DEFAULT_ARM_PX,
    travelWidth,
    canStart,
    onProgress,
    onCommit,
    onCancel
  } = options;

  const widthOf = () => travelWidth?.() || target.clientWidth || 1;

  // Decided once per gesture on its first event, then held for the gesture's life.
  let edgeEligible = true;

  const handler = (state: DragHandlerState) => {
    const {first, last, movement, swipe, axis, event, initial, cancel, canceled} = state;

    if (canceled) return;

    if (first) {
      // `initial` is the pointer position where the drag began; measure it against
      // the target's own left/right so the gate follows the surface, not the page.
      const rect = target.getBoundingClientRect();
      if (edge === 'left') edgeEligible = initial[0] - rect.left <= edgeInsetPx;
      else if (edge === 'right') edgeEligible = rect.right - initial[0] <= edgeInsetPx;
      else edgeEligible = true;
      // A start-of-gesture veto (e.g. an inner horizontal scroller owns the pan).
      if (edgeEligible && canStart && !canStart(state.target)) edgeEligible = false;
    }

    // A drag that did not begin at the gated edge is not ours: drop it so native
    // scroll / a sibling handler proceeds untouched.
    if (!edgeEligible) {
      if (!canceled) cancel();
      return;
    }

    // Axis not locked yet (still under the arm threshold): wait, touching nothing.
    if (!axis) return;
    // Locked vertical: never capture. The browser keeps scrolling natively.
    if (axis === 'y') return;

    const dx = movement[0];
    const dir: -1 | 1 = dx < 0 ? -1 : 1;

    // Wrong direction for a single-direction handler: leave it for the sibling.
    if (direction !== undefined && dir !== direction) return;

    // Now we own a horizontal drag: keep the browser from turning it into text
    // selection or a native fling.
    if (event.cancelable) event.preventDefault();

    const width = widthOf();
    const pct = Math.abs(dx) / width;

    if (!last) {
      onProgress?.({dx, dir, pct});
      return;
    }

    const flick = swipe[0] === dir;
    if (pct >= thresholdPct || flick) onCommit?.({dir, flick, pct});
    else onCancel?.();
  };

  const config: DragConfigWithAxisThreshold = {
    // Lock to whichever axis leads once the arm threshold is cleared.
    axis: 'lock',
    // Arm slop before the gesture is intentional...
    threshold: armPx,
    // ...and before the axis is chosen, so a stray first pixel cannot mislock it.
    // Drag reads this per pointer type, so set every kind to the same slop.
    axisThreshold: {mouse: armPx, touch: armPx, pen: armPx},
    // A tap (no real travel) must never read as a swipe.
    filterTaps: true,
    // Delegate move/up tracking to the window so two recognisers on one element
    // never fight over pointer capture.
    pointer: {capture: false},
    // We call preventDefault ourselves, only once a horizontal drag is owned.
    preventDefault: false,
    eventOptions: {passive: false},
    // The library owns velocity: a fast enough release past the arm slop flicks.
    swipe: {velocity: velocityCommit, distance: armPx, duration: 250}
  };

  const gesture = new DragGesture(target, handler, config as UserDragConfig);
  return () => gesture.destroy();
}
