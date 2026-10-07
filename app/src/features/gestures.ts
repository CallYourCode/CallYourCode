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
import {cyclog} from '@/shared/logging';

// How near the named edge (in CSS px, measured from the target's own box) a drag
// must START for an edge-gated swipe to be captured at all.
const DEFAULT_EDGE_INSET_PX = 24;
// Movement (in px) a drag must travel before it is treated as intentional and
// before its axis is locked. Matches the old hand-rolled arm slop.
const DEFAULT_ARM_PX = 12;
// A run of drags this recogniser never owned (a scroll, a mid-screen start for the
// edge swipe) logs its first swipe.cancel; repeats of the same reason inside this
// window are only counted, into `sup` on the next one that logs.
const QUIET_REPEAT_MS = 30_000;

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
  /** Names the owning surface in the swipe.* log lines (e.g. `chat-back`). */
  name?: string;
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
  /** Longest gesture (ms) that can still count as a flick. Defaults to 250. */
  flickMs?: number;
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
// Read-only peek at the recogniser's private press state, for the swipe.stuck probe.
type GesturePeek = {
  _ctrl?: {state?: {drag?: {_pointerActive?: boolean}}; pointerIds?: Set<number>};
};

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
    name = 'swipe',
    edge,
    edgeInsetPx = DEFAULT_EDGE_INSET_PX,
    direction,
    thresholdPct,
    velocityCommit,
    flickMs = 250,
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

  // Diagnostics only (swipe.* lines): one line when this recogniser takes a drag,
  // one when it lets go, and the reason a drag it never took was left alone.
  let owned = false;
  let ownedAt = 0;
  let startX = 0;
  let quietReason = '';
  let quietAt = 0;
  let quietSkipped = 0;
  const pointerKind = (event: Event) =>
    'pointerType' in event ? (event as PointerEvent).pointerType : event.type.slice(0, 5);
  const endLine = (line: string, fields: Record<string, unknown>) => {
    owned = false;
    cyclog(line, {s: name, ...fields, ms: Date.now() - ownedAt});
  };
  const quiet = (reason: string, fields: Record<string, unknown> = {}) => {
    const now = Date.now();
    if (reason === quietReason && now - quietAt < QUIET_REPEAT_MS) {
      quietSkipped++;
      return;
    }
    cyclog('swipe.cancel', {s: name, reason, ...fields, sup: quietSkipped || undefined});
    quietReason = reason;
    quietAt = now;
    quietSkipped = 0;
  };

  const handler = (state: DragHandlerState) => {
    const {first, last, movement, swipe, axis, event, initial, cancel, canceled} = state;

    if (canceled) {
      // The library ended a drag this recogniser had taken, without a release.
      if (owned) endLine('swipe.cancel', {reason: 'canceled', ev: event?.type});
      return;
    }

    if (first) {
      // `initial` is the pointer position where the drag began; measure it against
      // the target's own left/right so the gate follows the surface, not the page.
      const rect = target.getBoundingClientRect();
      startX = Math.round(initial[0] - rect.left);
      if (edge === 'left') edgeEligible = initial[0] - rect.left <= edgeInsetPx;
      else if (edge === 'right') edgeEligible = rect.right - initial[0] <= edgeInsetPx;
      else edgeEligible = true;
      if (!edgeEligible) quiet('off-edge', {x0: startX});
      // A start-of-gesture veto (e.g. an inner horizontal scroller owns the pan).
      if (edgeEligible && canStart && !canStart(state.target)) {
        edgeEligible = false;
        quiet('veto', {x0: startX});
      }
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
    if (axis === 'y') {
      if (last) quiet('vertical', {ev: event.type});
      return;
    }

    const dx = movement[0];
    const dir: -1 | 1 = dx < 0 ? -1 : 1;

    // Wrong direction for a single-direction handler: leave it for the sibling.
    if (direction !== undefined && dir !== direction) {
      // A taken drag that came back past its origin ends here with no callback.
      if (last && owned) endLine('swipe.cancel', {reason: 'reversed', ev: event.type});
      else if (last) quiet('wrong-dir');
      return;
    }

    // Now we own a horizontal drag: keep the browser from turning it into text
    // selection or a native fling.
    if (event.cancelable) event.preventDefault();

    const width = widthOf();
    const pct = Math.abs(dx) / width;

    if (!owned) {
      owned = true;
      ownedAt = Date.now();
      cyclog('swipe.start', {s: name, dir, x0: startX, pt: pointerKind(event)});
    }

    if (!last) {
      onProgress?.({dx, dir, pct});
      return;
    }

    const flick = swipe[0] === dir;
    const pctOut = Math.round(pct * 100) / 100;
    if (pct >= thresholdPct || flick) {
      endLine('swipe.commit', {dir, flick: flick ? 1 : 0, pct: pctOut, ev: event.type});
      onCommit?.({dir, flick, pct});
    } else {
      const reason = /cancel/.test(event.type) ? event.type : 'short';
      endLine('swipe.cancel', {reason, pct: pctOut, ev: event.type});
      onCancel?.();
    }
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
    swipe: {velocity: velocityCommit, distance: armPx, duration: flickMs}
  };

  // swipe.stuck: a new press that finds the recogniser still holding an earlier
  // one (its release never arrived) is ignored by the library, and its capture
  // click filter then eats clicks on this surface. Registered before the
  // recogniser binds so it reads the state the library is about to act on.
  let stuckSeen = false;
  const probe = () => {
    const ctrl = (gesture as unknown as GesturePeek)._ctrl;
    const held = !!ctrl?.state?.drag?._pointerActive;
    if (held && !stuckSeen) cyclog('swipe.stuck', {s: name, ids: ctrl?.pointerIds?.size});
    stuckSeen = held;
  };
  target.addEventListener('pointerdown', probe, {passive: true});

  const gesture = new DragGesture(target, handler, config as UserDragConfig);
  return () => {
    target.removeEventListener('pointerdown', probe);
    gesture.destroy();
  };
}
