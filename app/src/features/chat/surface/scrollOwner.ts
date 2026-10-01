// The ScrollOwner for the message scroller (.cyc-message-list-scroll).
//
// Phase 2, step 1: the owner is introduced OWNING NOTHING. It wraps the existing
// writers (silentScrollTo / scrollToBottom) and exposes a single place for the
// scroll-position readers to ASK their questions, each answer deliberately
// identical to the value today's scattered flags imply:
//
//   - state()          the explicit state (landing / pinned-bottom /
//                      reader-driving / reading-held / jumping) derived from the
//                      existing flags. Informational for now; nothing changes
//                      behaviour off it yet.
//   - isMachineScroll  the history pager's R7 question (was this offset a machine
//                      re-seat?), delegated to the shared machine-top tag.
//   - nearBottom       storeBindings' R8 question (is the reader near the end?),
//                      tracked off the scroll event with the SAME formula and the
//                      same "no synchronous measure in the notify path" property.
//   - jump()           wraps a deliberate move (go-to-bottom, unread landing) so
//                      later steps can own it; for now it runs the existing
//                      routine verbatim and only records that a jump is in flight.
//   - write()          wraps silentScrollTo so later steps can route every write
//                      through the owner without touching each call site.
//
// No path is rerouted through the owner in step 1: it adds one passive scroll
// listener (updating a flag nobody reads yet) and nothing else, so behaviour is
// unchanged. Later steps flip the pager (R7), storeBindings (R8) and the jump
// entry points to ask the owner, then move the writers behind it.

export type ScrollOwnerState =
  | 'landing'
  | 'pinned-bottom'
  | 'reader-driving'
  | 'reading-held'
  | 'jumping';

export interface ScrollOwnerDeps {
  scroll: HTMLElement;
  // The writers the owner wraps (owning nothing yet: these are the existing ones).
  silentScrollTo(v: number, tag?: string, reason?: string): void;
  scrollToBottom(reason?: string): void;
  // The existing readers, so each owner answer is identical to today's.
  isMachineScroll(top: number): boolean;
  nearBottomPx(): number;
  isPinned(): boolean;
  isReaderHolding(): boolean;
  isReaderDriving(): boolean;
  isLanding(): boolean;
  isDividerHeld(): boolean;
  onTeardown(d: () => void): void;
}

export function createScrollOwner(deps: ScrollOwnerDeps) {
  const {scroll} = deps;

  // storeBindings tracked "near the bottom" off the scroll event rather than
  // measuring in the notify path (reading scrollTop/scrollHeight while the store
  // applies a change forces a synchronous layout on every push). The owner tracks
  // the identical value the identical way, so a reader asking owner.nearBottom()
  // gets the same answer with the same no-measure-in-notify property. Starts true,
  // matching the pre-first-scroll default.
  let nearBottomFlag = true;
  const updateNearBottom = () => {
    nearBottomFlag =
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= deps.nearBottomPx();
  };
  scroll.addEventListener('scroll', updateNearBottom, {passive: true});
  deps.onTeardown(() => scroll.removeEventListener('scroll', updateNearBottom));

  // Depth of active jump() calls. A deliberate move can nest (an unread landing
  // that falls back to a bottom scroll), so count rather than toggle.
  let jumpDepth = 0;

  const state = (): ScrollOwnerState => {
    // A finger/pointer owning the offset, or a fresh touch/wheel, is the reader
    // driving: it outranks every machine intent.
    if (deps.isReaderHolding() || deps.isReaderDriving()) return 'reader-driving';
    if (jumpDepth > 0) return 'jumping';
    if (deps.isLanding()) return 'landing';
    if (deps.isPinned()) return 'pinned-bottom';
    return 'reading-held';
  };

  return {
    state,
    // R7 (historyPager): was the upward move a machine re-seat (ignore) or a real
    // reader flick (load older)? Delegates to the shared machine-top tag, so the
    // answer is identical to calling isMachineScroll directly.
    isMachineScroll: (top: number) => deps.isMachineScroll(top),
    // R8 (storeBindings): the reader is near the end and a live reply should keep
    // the view pinned. Same formula, same scroll-tracked value.
    nearBottom: () => nearBottomFlag,
    // Recompute nearBottom synchronously. storeBindings refreshes it at the end of
    // its notify rAF (after a possible re-pin) so the next push reads the
    // post-change position even before the async scroll event fires; this is the
    // same synchronous update it did locally.
    recomputeNearBottom: updateNearBottom,
    // A deliberate move (go-to-bottom W13, unread landing W14). The owner runs the
    // existing routine verbatim and only records that a jump is in flight; later
    // steps give the owner the settle itself. Returns the routine's result.
    jump<T>(_kind: string, run: () => T): T {
      jumpDepth++;
      try {
        return run();
      } finally {
        jumpDepth--;
      }
    },
    // Wraps the existing silentScrollTo so later steps can route every write
    // through the owner; identical to calling silentScrollTo today.
    write(v: number, tag?: string, reason?: string): void {
      deps.silentScrollTo(v, tag, reason);
    }
  };
}

export type ScrollOwner = ReturnType<typeof createScrollOwner>;
