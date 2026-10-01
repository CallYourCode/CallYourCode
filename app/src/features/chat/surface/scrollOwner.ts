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
// Steps 2 and 3 routed the pager (R7), storeBindings (R8) and the two jump entry
// points through the owner. Step 4 makes it the writer for the message
// re-window (anchoredRewindow's bottom pin W5 and anchor hold W6):
//
//   - driving()        a reader owns the offset: a finger or pointer is down, or
//                      the reader's own scroll (a drag, a wheel, momentum after
//                      the finger lifts) is still live by the virtualizer's
//                      scroll clock. While driving NOTHING writes scrollTop; the
//                      re-window banks its correction in the top spacer instead.
//   - rewindowWrite()  the re-window's single tagged, machine-marked write.
//   - settle on release: the moment the last finger/pointer lifts with the
//                      scroll already still, one re-window releases the bank (or
//                      re-pins the end). A release mid-momentum leaves it to the
//                      virtualizer's own scroll-end tick, which re-windows anyway.
//   - jump()           now spans a deliberate move's WHOLE async duration (the
//                      go-to-bottom walk), so its untagged scrolls never read as
//                      a reader driving.

export type ScrollOwnerState =
  | 'landing'
  | 'pinned-bottom'
  | 'reader-driving'
  | 'reading-held'
  | 'jumping';

export interface ScrollOwnerDeps {
  scroll: HTMLElement;
  // The writers the owner wraps.
  silentScrollTo(v: number, tag?: string, reason?: string): void;
  scrollToBottom(reason?: string): void;
  // The message re-window's raw tagged write (no pin re-derivation), and a
  // re-window at the current offset that applies any banked correction.
  rewindowWrite(v: number, tag: string): void;
  rewindow(): void;
  // The list's virtual-scroll clock: true while the box is still scrolling, and
  // whether a correction is banked in its top spacer.
  listScrolling(): boolean;
  listBanked(): boolean;
  // The existing readers, so each owner answer is identical to today's.
  isMachineScroll(top: number): boolean;
  nearBottomPx(): number;
  isPinned(): boolean;
  // How far the view sits above the true end, in px.
  distToEnd(): number;
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

  // Whether the last scroll event was the reader's: not the offset of a machine
  // write and not inside a deliberate move (the go-to-bottom walk scrolls
  // untagged). Read with the list's scroll clock, it is the reader's own scroll
  // or momentum still running, which no timer of ours has to end: the clock runs
  // out on its own once the scroll events stop.
  let lastScrollByReader = false;
  const noteScroll = () => {
    lastScrollByReader = jumpDepth === 0 && !deps.isMachineScroll(scroll.scrollTop);
  };
  scroll.addEventListener('scroll', noteScroll, {passive: true});
  deps.onTeardown(() => scroll.removeEventListener('scroll', noteScroll));

  // A reader owns the offset: a finger or pointer down, or their own scroll
  // (drag, wheel, momentum) still live. No programmatic scrollTop while true.
  const driving = (): boolean =>
    deps.isReaderHolding() || (lastScrollByReader && deps.listScrolling());

  // The reader let go. If the list is already still, release the banked
  // correction (or re-pin a pinned end that content grew past) in one re-window
  // now; mid-momentum the virtualizer's scroll-end tick does it instead.
  const settle = () => {
    if (driving()) return;
    if (deps.listBanked() || (deps.isPinned() && deps.distToEnd() > 0.5)) deps.rewindow();
  };
  window.addEventListener('touchend', settle, {passive: true});
  window.addEventListener('touchcancel', settle, {passive: true});
  window.addEventListener('pointerup', settle, {passive: true});
  window.addEventListener('pointercancel', settle, {passive: true});
  deps.onTeardown(() => {
    window.removeEventListener('touchend', settle);
    window.removeEventListener('touchcancel', settle);
    window.removeEventListener('pointerup', settle);
    window.removeEventListener('pointercancel', settle);
  });

  const state = (): ScrollOwnerState => {
    // A finger/pointer owning the offset, or the reader's own live scroll, is
    // the reader driving: it outranks every machine intent.
    if (driving()) return 'reader-driving';
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
    driving,
    // A deliberate move (go-to-bottom W13, unread landing W14). The owner runs the
    // existing routine verbatim and holds the jump for its WHOLE duration: a
    // routine that returns a promise (the go-to-bottom walk) stays a jump until
    // it settles, so its untagged scrolls never read as a reader driving.
    // Returns the routine's result.
    jump<T>(_kind: string, run: () => T): T {
      jumpDepth++;
      const end = () => {
        jumpDepth--;
        lastScrollByReader = false;
      };
      let result: T;
      try {
        result = run();
      } catch (e) {
        end();
        throw e;
      }
      const pending = result as {then?: unknown} | null | undefined;
      if (pending && typeof pending.then === 'function') {
        (result as unknown as Promise<unknown>).then(end, end);
      } else {
        end();
      }
      return result;
    },
    // The message re-window's single write (anchoredRewindow W5/W6). Never
    // called while driving: the re-window banks instead.
    rewindowWrite: (v: number, tag: string) => deps.rewindowWrite(v, tag),
    pinned: () => deps.isPinned(),
    // Wraps the existing silentScrollTo so later steps can route every write
    // through the owner; identical to calling silentScrollTo today.
    write(v: number, tag?: string, reason?: string): void {
      deps.silentScrollTo(v, tag, reason);
    }
  };
}

export type ScrollOwner = ReturnType<typeof createScrollOwner>;
