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
//   - atTop            the pager's other R7 question (is the view at the top of
//                      the loaded history?), read off the offsets, never the
//                      mounted window's edge.
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
//                      the finger lifts) is still live by the owner's scroll
//                      clock. While driving NOTHING writes scrollTop; the
//                      re-window banks its correction in the top spacer instead.
//   - rewindowWrite()  the re-window's single tagged, machine-marked write.
//   - settle on release: the moment the last finger/pointer lifts with the
//                      scroll already still, one re-window releases the bank (or
//                      re-pins the end). A release mid-momentum leaves it to the
//                      virtualizer's own scroll-end tick, which re-windows anyway.
//   - jump()           now spans a deliberate move's WHOLE async duration (the
//                      go-to-bottom walk), so its untagged scrolls never read as
//                      a reader driving.
//
// Step 5 folds the resize observer (W3 divider re-seat, W4 pin / top-pad carry)
// and storeBindings' arrival follow (R8) into the owner:
//
//   - settleResize()   every content / pad / box resize: re-seat a held divider,
//                      keep a pinned end, or carry a top-pad change for a reader
//                      in history. While a reader drives nothing is written; a
//                      top-pad change is banked in the spacer like a re-measure.
//   - followArrival()  a row arrived for a reader who was near the end: re-pin,
//                      unless a reader is driving or their input is that fresh.
//
// Step 6 makes the render bracket (W2) one owner settle (settlePaint: bank while
// driving, else one write and one re-window) and has a jump yield the moment a
// finger lands. Step 7 moves the reader's hands (finger/pointer holds, input
// freshness) here, replacing the scattered pointerHeld / touchHeld /
// readerInputPlausible gates, and answers the re-window's divider-hold question
// (dividerHeld) instead of a separate plumbing hook.

import {logBottomPin} from './machineScroll';

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
  // Whether a correction is banked in the list's top spacer.
  listBanked(): boolean;
  // The existing readers, so each owner answer is identical to today's.
  isMachineScroll(top: number): boolean;
  // The model offset of the viewport top (scrollTop plus any banked correction):
  // 0 is the start of the loaded history.
  modelTop(): number;
  nearBottomPx(): number;
  isPinned(): boolean;
  // Re-derive the pin from where the view stands (a travel landed).
  notePin(): void;
  // How far the view sits above the true end, in px.
  distToEnd(): number;
  isLanding(): boolean;
  isDividerHeld(): boolean;
  // Re-seat the held unread divider on its landing spot (false: none mounted),
  // and absorb a top-pad change in the list's spacer while a reader drives.
  reseatDivider(): boolean;
  bankShift(delta: number): void;
  onTeardown(d: () => void): void;
}

// A view within this many px of the start of the loaded history is at its top:
// the history pager loads older pages from there.
const HISTORY_TOP_PX = 100;

export function createScrollOwner(deps: ScrollOwnerDeps) {
  const {scroll} = deps;

  // THE READER'S HANDS (step 7: one place instead of the scattered pointerHeld /
  // touchHeld / readerInputPlausible gates). A finger or pointer down on the list
  // owns the offset until it lifts. On a touch build Chrome fires pointercancel
  // the instant it claims a vertical pan as a native scroll, which clears the
  // pointer while the finger is STILL dragging (a re-pin firing in that gap
  // snapped the reader back to the end every frame: the stuck-at-bottom
  // report), so the raw touch sequence, down through the whole pan, is held too.
  // Released by the last lifted finger, the pointer's up/cancel, the window
  // losing focus or the page going hidden mid-drag (either can swallow the
  // up), so no hold is left stuck down.
  //
  // A finger's touchend and touchcancel go to the node it LANDED on, even once
  // that node has left the DOM (a far scroll re-windows the finger's own row
  // away), and a detached node's events never reach the window: the hold stuck
  // down and a pinned reader stopped following replies. So the lift is also
  // heard on each finger's own target, and a new touch sequence anywhere (one
  // finger down) proves every earlier finger lifted.
  let pointerHeld = false;
  let touchHeld = false;
  const holding = () => pointerHeld || touchHeld;
  // The last real reader input (a finger drag or a wheel): with a hold, the
  // evidence that a scroll is the reader's. Without it an untagged app write or
  // a browser clamp can look exactly like a reader.
  const READER_INPUT_MS = 150;
  let lastInputAt = 0;
  const readerInputFresh = () => holding() || Date.now() - lastInputAt <= READER_INPUT_MS;
  const notePointer = () => {
    pointerHeld = true;
  };
  const touchTargets = new Set<EventTarget>();
  const noteTouch = (e: Event) => {
    touchHeld = true;
    const t = e.target;
    if (!t || touchTargets.has(t)) return;
    touchTargets.add(t);
    t.addEventListener('touchend', releaseTouch, {passive: true});
    t.addEventListener('touchcancel', releaseTouch, {passive: true});
  };
  const dropTouch = () => {
    touchHeld = false;
    for (const t of touchTargets) {
      t.removeEventListener('touchend', releaseTouch);
      t.removeEventListener('touchcancel', releaseTouch);
    }
    touchTargets.clear();
  };
  // Whether reader input landed since the browser's last scrollend. A scroll
  // after a scrollend with none (the content shrank under a view at its end
  // and the browser clamped it, 14 ms after a wheel stopped) is no reader's.
  let inputSinceScrollend = true;
  const noteInput = () => {
    lastInputAt = Date.now();
    inputSinceScrollend = true;
  };
  scroll.addEventListener('pointerdown', notePointer, {passive: true});
  scroll.addEventListener('touchstart', noteTouch, {passive: true});
  scroll.addEventListener('touchmove', noteInput, {passive: true});
  scroll.addEventListener('wheel', noteInput, {passive: true});

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

  // The go-to-bottom or travel to a message in flight. One at a time: a newer
  // one supersedes it, and its routine then reads `readerTook` as true and
  // stops writing (both writing in turn was the jitter). While a travel flies
  // the pin stays dropped: nothing follows or snaps to the end under it, and
  // the pin is re-derived where it lands.
  let inFlight: {kind: string} | null = null;
  const travelling = () => inFlight?.kind === 'to-message';
  const pinned = () => !travelling() && deps.isPinned();

  // Whether the last scroll event was the reader's: not the offset of a machine
  // write, not inside a deliberate move (the go-to-bottom walk scrolls
  // untagged), and backed by reader input -- a finger/pointer down or a fresh
  // touch/wheel, or the continuation of a scroll that was (momentum keeps
  // scrolling after the finger lifts, with no input of its own). A browser
  // clamp or an untagged app write with no reader behind it is not the reader.
  //
  // The reader's scroll runs on the owner's OWN clock, stamped from the current
  // scroll event. (It read the virtualizer's 150 ms scrolling flag, whose
  // listener runs after this one, so the flag still described the previous
  // event: one gap over 150 ms between momentum's scroll events ended driving
  // mid-fling and the re-window wrote under the moving content.) The scroll is
  // over once READER_SCROLL_QUIET_MS pass with no scroll event: the
  // virtualizer's own reset delay, so its scroll-end tick, which re-windows
  // anyway, is the settle and no timer of ours has to end it. But momentum
  // keeps scrolling through a main-thread stall, and where the browser has
  // scrollend it says when the sequence truly stopped: until then a quiet gap
  // of up to READER_SCROLL_STALL_MS is still the reader's (bounded, so a lost
  // scrollend cannot hold it). An event that did not move the offset gets no
  // scrollend, so it opens no such allowance.
  const READER_SCROLL_QUIET_MS = 150;
  const READER_SCROLL_STALL_MS = 1000;
  const hasScrollend = 'onscrollend' in window;
  let lastScrollByReader = false;
  let readerScrollAt = 0;
  let awaitingScrollend = false;
  let lastTop = scroll.scrollTop;
  const readerScrolling = (): boolean => {
    if (!lastScrollByReader) return false;
    const quiet = performance.now() - readerScrollAt;
    return (
      quiet < READER_SCROLL_QUIET_MS || (awaitingScrollend && quiet < READER_SCROLL_STALL_MS)
    );
  };
  const noteScroll = () => {
    const top = scroll.scrollTop;
    const moved = top !== lastTop;
    lastTop = top;
    // The reader's sequence already ended and no input of theirs came since:
    // not their scroll, so it neither extends their clock nor reopens the
    // allowance (it did, and a pinned reader skipped arrivals for 1 s).
    if (!inputSinceScrollend && !holding() && jumpDepth === 0 && !deps.isMachineScroll(top)) {
      return;
    }
    lastScrollByReader =
      jumpDepth === 0 && !deps.isMachineScroll(top) && (readerInputFresh() || readerScrolling());
    if (lastScrollByReader) readerScrollAt = performance.now();
    awaitingScrollend = lastScrollByReader && moved && hasScrollend;
  };
  // The sequence stopped. The virtualizer's scroll-end tick settles it once
  // the quiet runs out; if that tick already came and went inside a long
  // stall (it found the reader still driving), settle here.
  const noteScrollEnd = () => {
    awaitingScrollend = false;
    // A finger or pointer still down: the gesture has not ended (a browser
    // fires no scrollend mid-drag; a programmatic step can), so its input
    // still stands for the fling that follows the lift.
    if (!holding()) inputSinceScrollend = false;
    settle();
  };
  scroll.addEventListener('scroll', noteScroll, {passive: true});
  scroll.addEventListener('scrollend', noteScrollEnd, {passive: true});
  deps.onTeardown(() => {
    scroll.removeEventListener('scroll', noteScroll);
    scroll.removeEventListener('scrollend', noteScrollEnd);
  });

  // A reader owns the offset: a finger or pointer down, or their own scroll
  // (drag, wheel, momentum) still live. No programmatic scrollTop while true.
  const driving = (): boolean => holding() || readerScrolling();

  // A go-to-bottom or travel tapped while the reader's fling still coasts: the
  // browser keeps flinging under every programmatic write (Chromium measured;
  // the iPhone's log showed the same), so the fling and the move wrote in turn,
  // the jitter (CYC Builder, iPhone, 2026-10-04). A box the hand cannot scroll for
  // a moment ends the fling (Chromium: two frames were not enough, the fling
  // resumed; three and more ended it); machine writes still land on it. Only
  // where the scrollbar takes no room (overlay bars), so the width never changes.
  const FLING_END_MS = 100;
  let flingTimer: ReturnType<typeof setTimeout> | undefined;
  const flingEnded = () => {
    clearTimeout(flingTimer);
    scroll.style.overflowY = '';
  };
  const endFling = () => {
    if (!readerScrolling() || scroll.offsetWidth !== scroll.clientWidth) return;
    clearTimeout(flingTimer);
    scroll.style.overflowY = 'hidden';
    flingTimer = setTimeout(flingEnded, FLING_END_MS);
  };
  deps.onTeardown(flingEnded);

  // The reader let go. If the list is already still, release the banked
  // correction (or re-pin a pinned end that content grew past) in one re-window
  // now; mid-momentum the virtualizer's scroll-end tick does it instead.
  //
  // An arrival (or growth under a pinned end) skipped while the reader drove
  // is OWED, not dropped: this settle pays it if the reader ended at the end.
  // Driving can also end by the clock alone (the quiet or the stall allowance
  // running out, input going stale with no scroll), where no event settles, so
  // while a follow is owed one timer wakes the settle when driving can lapse.
  let followOwed = false;
  let owedTimer: ReturnType<typeof setTimeout> | undefined;
  const owe = () => {
    followOwed = true;
    clearTimeout(owedTimer);
    // A held finger or pointer settles on its own release.
    if (holding()) return;
    let wait = READER_INPUT_MS - (Date.now() - lastInputAt);
    if (lastScrollByReader) {
      const allow = awaitingScrollend ? READER_SCROLL_STALL_MS : READER_SCROLL_QUIET_MS;
      wait = Math.max(wait, allow - (performance.now() - readerScrollAt));
    }
    owedTimer = setTimeout(settle, Math.max(0, wait) + 1);
  };
  deps.onTeardown(() => clearTimeout(owedTimer));
  const settle = () => {
    if (driving() || (followOwed && readerInputFresh())) {
      if (followOwed) owe();
      return;
    }
    followOwed = false;
    clearTimeout(owedTimer);
    if (deps.listBanked() || (pinned() && deps.distToEnd() > 0.5)) deps.rewindow();
  };
  // The finger owns the offset until the LAST touch lifts (a multi-touch
  // release leaves one finger still down). A lift on a still-attached target
  // is heard there and again on the window: handled once.
  let lastRelease: Event | null = null;
  function releaseTouch(e: Event) {
    if (e === lastRelease) return;
    lastRelease = e;
    const touches = (e as TouchEvent).touches;
    // The lift does not judge whether a fling follows. The age of the last
    // scroll event is no evidence (one long frame made a moving finger look
    // held still, and the settle wrote under the fling); the browser's
    // scrollend is: it fires at the lift of a finger that held still, and at
    // the end of the fling otherwise, and closes the allowance either way.
    if (!touches || touches.length === 0) dropTouch();
    settle();
  }
  // The first finger of a new sequence: any hold still down is stale.
  const newTouchSequence = (e: Event) => {
    const touches = (e as TouchEvent).touches;
    if (touchHeld && touches && touches.length === 1) dropTouch();
  };
  const releasePointer = () => {
    pointerHeld = false;
    settle();
  };
  const releaseAll = () => {
    pointerHeld = false;
    dropTouch();
    awaitingScrollend = false;
    settle();
  };
  const releaseOnHidden = () => {
    if (document.visibilityState === 'hidden') releaseAll();
  };
  window.addEventListener('touchstart', newTouchSequence, {capture: true, passive: true});
  window.addEventListener('touchend', releaseTouch, {passive: true});
  window.addEventListener('touchcancel', releaseTouch, {passive: true});
  window.addEventListener('pointerup', releasePointer, {passive: true});
  window.addEventListener('pointercancel', releasePointer, {passive: true});
  window.addEventListener('blur', releaseAll, {passive: true});
  document.addEventListener('visibilitychange', releaseOnHidden, {passive: true});
  deps.onTeardown(() => {
    dropTouch();
    window.removeEventListener('touchstart', newTouchSequence, {capture: true});
    window.removeEventListener('touchend', releaseTouch);
    window.removeEventListener('touchcancel', releaseTouch);
    window.removeEventListener('pointerup', releasePointer);
    window.removeEventListener('pointercancel', releasePointer);
    window.removeEventListener('blur', releaseAll);
    document.removeEventListener('visibilitychange', releaseOnHidden);
  });

  const state = (): ScrollOwnerState => {
    // A finger/pointer owning the offset, or the reader's own live scroll, is
    // the reader driving: it outranks every machine intent.
    if (driving()) return 'reader-driving';
    if (jumpDepth > 0) return 'jumping';
    if (deps.isLanding()) return 'landing';
    if (pinned()) return 'pinned-bottom';
    return 'reading-held';
  };

  return {
    state,
    // R7 (historyPager): was the upward move a machine re-seat (ignore) or a real
    // reader flick (load older)? Delegates to the shared machine-top tag, so the
    // answer is identical to calling isMachineScroll directly.
    isMachineScroll: (top: number) => deps.isMachineScroll(top),
    // R7's other half: older history loads only at the top of the LOADED
    // history: the view's model offset within HISTORY_TOP_PX of 0, or the box's
    // own offset while a reader drives with the rows above banked out of the
    // spacer (the box's top is then as high as the reader can go; the settle
    // hands the bank back). Not the first MOUNTED row near the viewport: in the
    // virtual window that is the window's own top edge, met anywhere in the
    // history whenever the view outruns the window (BZ Distributor, 2026-10-03:
    // older history loaded 24 times at scrollTop 56k to 203k while the owner
    // scrolled down).
    atTop: () => Math.min(scroll.scrollTop, deps.modelTop()) <= HISTORY_TOP_PX,
    // R8 (storeBindings): the reader is near the end and a live reply should keep
    // the view pinned. Same formula, same scroll-tracked value.
    nearBottom: () => nearBottomFlag,
    // Recompute nearBottom synchronously. storeBindings refreshes it at the end of
    // its notify rAF (after a possible re-pin) so the next push reads the
    // post-change position even before the async scroll event fires; this is the
    // same synchronous update it did locally.
    recomputeNearBottom: updateNearBottom,
    driving,
    readerInputFresh,
    // A content, pad or box resize (the list's ResizeObserver, W3/W4). A reader
    // driving owns the offset: nothing is written, a top-pad change is banked in
    // the spacer so the rows under them hold still, and a pinned end that grew is
    // left for the settle (the scroll-end re-window keeps the pin). Otherwise the
    // held divider is re-seated, a pinned end re-pinned, or a top-pad change
    // carried for a reader in history.
    settleResize(padDelta: number): void {
      // A pinned end that grew while the reader's input was live: the re-pin
      // waits (their async, coalesced scroll may be about to leave the end),
      // owed to the settle, and is NAMED so a recurrence is not a ghost.
      const skipPin = () => {
        if (pinned() && deps.distToEnd() > 0) {
          logBottomPin('toBottom', 'resize.reader-active', scroll.scrollTop, scroll.scrollHeight);
          owe();
        }
      };
      if (driving()) {
        if (padDelta) deps.bankShift(padDelta);
        // Silent under a held finger (it plainly owns the offset); named when
        // only the reader's scroll or momentum is live.
        if (!holding()) skipPin();
        return;
      }
      if (deps.isDividerHeld() && !pinned() && deps.reseatDivider()) return;
      if (pinned()) {
        if (readerInputFresh()) skipPin();
        else if (deps.distToEnd() > 0) deps.scrollToBottom('resize.pin');
      } else if (padDelta) {
        deps.silentScrollTo(scroll.scrollTop + padDelta, 'resize.pad');
      }
    },
    // A store paint of the open chat moved the reader's held anchor by `drift`
    // px on screen (the render bracket, W2): bank it in the spacer while a
    // reader drives, otherwise write it once and re-window once so the window
    // and spacer match the held offset.
    settlePaint(drift: number): void {
      if (Math.abs(drift) <= 0.5) return;
      if (driving()) {
        deps.bankShift(drift);
        return;
      }
      deps.rewindowWrite(scroll.scrollTop + drift, 'bracket');
      deps.rewindow();
    },
    // A row arrived (storeBindings' rAF, R8) for a reader who was near the end:
    // keep them at the end, unless a reader is driving or their input is fresh
    // enough that their own scroll may not have landed yet. Then the follow is
    // owed to the settle, which pays it if the reader ends at the end.
    followArrival(): void {
      if (travelling()) return;
      if (driving() || readerInputFresh()) {
        owe();
        return;
      }
      deps.scrollToBottom();
    },
    // A deliberate move (go-to-bottom W13, unread landing W14). The owner runs the
    // existing routine verbatim and holds the jump for its WHOLE duration: a
    // routine that returns a promise (the go-to-bottom walk) stays a jump until
    // it settles, so its untagged scrolls never read as a reader driving. The
    // routine is handed `readerTook`: the moment a finger or pointer lands, the
    // reader owns the offset and the move stops writing. A go-to-bottom or a
    // travel also stops once a newer go-to-bottom or travel starts.
    // Returns its result.
    jump<T>(kind: string, run: (readerTook: () => boolean) => T): T {
      jumpDepth++;
      const own = kind === 'to-bottom' || kind === 'to-message' ? {kind} : null;
      if (own) {
        endFling();
        inFlight = own;
      }
      const end = () => {
        jumpDepth--;
        lastScrollByReader = false;
        awaitingScrollend = false;
        if (own && inFlight === own) {
          inFlight = null;
          if (own.kind === 'to-message') deps.notePin();
        }
      };
      let result: T;
      try {
        result = run(own ? () => holding() || inFlight !== own : holding);
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
    pinned,
    travelling,
    // Wraps the existing silentScrollTo so later steps can route every write
    // through the owner; identical to calling silentScrollTo today.
    write(v: number, tag?: string, reason?: string): void {
      deps.silentScrollTo(v, tag, reason);
    }
  };
}

export type ScrollOwner = ReturnType<typeof createScrollOwner>;
