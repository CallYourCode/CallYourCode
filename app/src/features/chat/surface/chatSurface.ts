import {touchCapable, prefersMotion} from '@/shared/capabilities';
import {paintChatRoot} from './chatRootPaint';
import {paintMessageFrameWidth} from '@/features/chat/messages/messageFrame';
import {mirrorScrollbarGutter} from './scrollbarGutter';
import type {CycSession} from '@/types';
import * as engine from '@/engine/store';
import type {CycEngineSession} from '@/engine/store';
import type {ReadMarker} from '@/engine/store/readState';
import {sessionState, dataState} from '@/sessionState';
import {h} from '@/components/domHelpers';
import {clearMessages, attachStickyDates} from './messageList';
import {scrollSurface} from '@/shared/dom';
import {cyclog} from '@/shared/logging';
import {clampNumber} from '@/shared/numbers';
import * as interactionWindow from '@/shared/browser';
import {toast} from '@/components/widgets';
import {speaker} from '@/audio/speaker';
import {pipeline} from '@/audio/pipeline';
import {ensureMic} from '@/speechGate';
import {clearNotifications, reportRead} from '@/engine/pushNotify';
import {active, allSessions, selectTabFor} from '@/sessionSelectors';
import {createChatChrome} from './chatChrome';
import {installHistoryPager} from './historyPager';
import {createReaderLanding} from './readerLanding';
import {markMachineTop, isMachineTop as machineTopMatches, machineTopOf} from './machineScroll';
import {onHorizontalSwipe} from '@/features/gestures';

export interface ChatSurfaceDeps {
  onTeardown(d: () => void): void;
  render(): void;
  chatEl: HTMLElement;
  backToList(): void;
  jumpTo(
    dir: 1 | -1,
    trigger: 'wheel' | 'touch' | 'button',
    wheel?: {sinceLastMs: number; peakAbs: number}
  ): void;
  jumpTarget(dir: 1 | -1): string | null;
  markSeen(id: string): void;
  heardTsOf(s: CycSession): number;
  readMarkerOf(s: CycSession): ReadMarker | undefined;
  reportViewedThrough(id: string): void;
  play(sessionId: string, msgId: string, text: string): void;
  suppressAutoSpeak(): boolean;
  clearSuppressAutoSpeak(): void;
  isChatViewOpen(): boolean;
  draftOwner(): string | null;
  saveDraft(): void;
  loadDraft(id: string | null): void;
  rebuildToolbarSettings(): void;
  restorePending: Set<'host' | 'chat' | 'list' | 'profile' | 'doc'>;
  agentsBarReset(): void;
  releaseMicIfIdle(): void;
  composerFocus(): void;
  setView(view: 'list' | 'chat' | 'profile'): void;
  armSettleResort(): void;
}

const CHAT_ARM_PX = 12;
// Pointer/touch back-swipe commit rule (owned by the gesture wrapper): a release
// past this fraction of the surface width, OR a flick faster than this velocity
// (px/ms), commits; anything short snaps back. Fraction-of-travel (not a fixed
// px) is what stops a partial edge swipe committing on a narrow phone.
const CHAT_COMMIT_PCT = 0.5;
const CHAT_FLICK_VELOCITY = 0.5;
// A back-swipe must begin within this many px of the surface's left edge. Sized
// for a thumb contact near the bezel: generous enough that a real edge swipe
// still commits, tight enough that a mid-surface drag never navigates back.
const CHAT_EDGE_INSET_PX = 32;
const CHAT_COMMIT_PX = 60;
const CHAT_WHEEL_COMMIT_PX = CHAT_COMMIT_PX * 1.5;
const CHAT_WHEEL_QUIET_MS = 160;
const CHAT_PAGE_ANIM_MS = 110;

// True when an inner horizontal scroller under `target` still has room to consume
// a wheel `deltaX`, so the chat wheel-pager should defer the whole run to it.
function innerScrollerHasRoomX(
  target: EventTarget | null,
  surface: HTMLElement,
  deltaX: number
): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== surface) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const {overflowX} = window.getComputedStyle(el);
      if (overflowX === 'auto' || overflowX === 'scroll') {
        const room = deltaX > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft;
        if (room > 1) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

export function createChatSurface(deps: ChatSurfaceDeps) {
  const OVERLAY_SCROLL_NEAR_PX = 100;

  // day/night theme painter) on the surface root.
  paintChatRoot(deps.chatEl);

  const messageListEl = h(
    'div',
    [
      'cyc-message-list',
      'absolute z-[1] flex-auto',
      '[&_.cyc-message-content]:select-text',
      '[&_.cyc-message-content]:[-webkit-user-select:text]',
      '[&_.cyc-message-content]:[-webkit-touch-callout:none]',
      '[inset-block:calc(var(--cyc-pane-gap)*-1)]',
      '[inset-inline:calc(var(--cyc-pane-gap)*-1)]'
    ].join(' ')
  );
  const messageListScroll = scrollSurface();
  // Distance from the current scroll offset to the bottom of the content.
  const distToEnd = () =>
    messageListScroll.scrollHeight - messageListScroll.scrollTop - messageListScroll.clientHeight;

  messageListScroll.classList.add(
    'cyc-message-list-scroll',
    'block',
    'h-auto',
    '[overflow-anchor:none]'
  );
  // The surface is a vertical scroller: let the browser own vertical panning
  // natively (pan-y) but keep horizontal drags with the app so it can page
  // between chats. Without this, iOS Safari claims a slightly-vertical
  // horizontal drag as a native scroll and fires pointercancel mid-gesture,
  // which snapped an in-progress back-swipe home. Inner horizontal scrollers
  // (wide code blocks, tables) carry their own pan-x so they still scroll.
  messageListScroll.style.touchAction = 'pan-y';
  // The column centres in the scroller's client box; a classic scrollbar
  // narrows that box at the inline end only. Mirror its width at the inline
  // start so the column shares the composer's edges (see scrollbarGutter.ts).
  deps.onTeardown(mirrorScrollbarGutter(messageListScroll));
  const messageListInner = h(
    'div',
    [
      'cyc-message-list-inner',
      'mx-auto flex w-full flex-col justify-end',
      'min-h-[calc(100%-var(--cyc-chat-pad-top)-var(--cyc-chat-pad-bottom))]',
      'max-w-[var(--cyc-chat-width)]'
    ].join(' ')
  );
  // Owns `--cyc-msg-frame-max` for every message frame by inheritance (messageFrame.ts).
  paintMessageFrameWidth(messageListInner);
  const messageListPadBottom = h(
    'div',

    'cyc-message-list-pad cyc-message-list-pad-bottom w-full flex-none h-[var(--cyc-chat-pad-bottom)]'
  );
  const messageListPadTop = h(
    'div',
    'cyc-message-list-pad cyc-message-list-pad-top w-full flex-none h-[var(--cyc-chat-pad-top)]'
  );
  messageListScroll.append(messageListPadTop, messageListInner, messageListPadBottom);
  messageListEl.append(messageListScroll);

  const renderEarlier = () => {
    deps.render();
  };

  // A compact non-interactive activity indicator for history pagination.
  const chatBusyRing = h(
    'div',
    [
      'cyc-history-loader pointer-events-none absolute inset-0 grid place-items-center',
      'opacity-0 transition-opacity duration-150 [&.cyc-visible]:opacity-100'
    ].join(' ')
  );
  chatBusyRing.innerHTML =
    '<span class="cyc-history-loader-mark block size-9 rounded-full ' +
    'border-[3px] border-solid border-white/20 border-t-white [animation:cyc-spin_0.7s_linear_infinite]"></span>';
  let chatBusyShown = false;
  const revealChatBusy = (show: boolean, onEnd?: () => void) => {
    void chatBusyRing.offsetWidth;
    if (onEnd && prefersMotion()) {
      const done = (event: TransitionEvent) => {
        if (event.target !== chatBusyRing) return;
        chatBusyRing.removeEventListener('transitionend', done);
        onEnd();
      };
      chatBusyRing.addEventListener('transitionend', done);
      chatBusyRing.classList.toggle('cyc-visible', show);
      return;
    }
    chatBusyRing.classList.toggle('cyc-visible', show);
    onEnd?.();
  };
  const showChatBusy = () => {
    if (chatBusyShown) return;
    chatBusyShown = true;
    if (chatBusyRing.parentElement !== messageListEl) messageListEl.append(chatBusyRing);
    revealChatBusy(true);
  };
  const hideChatBusy = () => {
    if (!chatBusyShown) return;
    chatBusyShown = false;
    if (!chatBusyRing.parentElement) return;
    revealChatBusy(false, () => chatBusyRing.remove());
  };

  // Horizontal paging on the message surface. `touch` builds gives it a pointer
  // drag plus wheel; pointerless builds page forward on a horizontal wheel only.
  // dir>0 pages to the next chat; dir<0 (touch only) pages back to the list.
  const installChatPaging = (touch: boolean) => {
    const surface = messageListScroll;
    const moves = messageListInner;
    const surfaceWidth = () => surface.clientWidth || 1;
    const canGo = (dir: 1 | -1) =>
      touch ? (dir < 0 ? true : !!deps.jumpTarget(1)) : dir > 0 && !!deps.jumpTarget(1);
    // When the destination reveals immediately we snap the surface home and swap;
    // otherwise we page the surface fully over before swapping the content in.
    const reveals = (dir: 1 | -1) => (touch ? dir < 0 || window.innerWidth > 550 : true);
    const runGo = (dir: 1 | -1, wheel?: {sinceLastMs: number; peakAbs: number}) =>
      dir < 0 ? deps.backToList() : deps.jumpTo(1, wheel ? 'wheel' : 'touch', wheel);

    let windowToken = 0;
    const openWindow = () => {
      if (!windowToken) windowToken = interactionWindow.begin('gesture', 'chat-page');
    };
    const closeWindow = () => {
      if (windowToken) {
        interactionWindow.end(windowToken);
        windowToken = 0;
      }
    };

    const paint = (offset: number, animate: boolean, w: number = surfaceWidth()) => {
      moves.style.transition = animate
        ? `transform ${CHAT_PAGE_ANIM_MS}ms ease, opacity ${CHAT_PAGE_ANIM_MS}ms ease`
        : 'none';
      moves.style.transform = offset === 0 ? '' : `translateX(${offset}px)`;
      moves.style.opacity = !offset ? '' : String(Math.max(0.4, 1 - Math.abs(offset) / w));
    };

    // The visual starts at zero displacement once the gesture crosses the arm
    // slop, instead of jumping to the full accumulated delta: the surface tracks
    // travel BEYOND the threshold, not from the first unit of movement. Applied
    // to both the pointer drag and the wheel run; commit still measures raw
    // travel, so its thresholds are unchanged.
    const slopSubtracted = (d: number) => Math.sign(d) * Math.max(0, Math.abs(d) - CHAT_ARM_PX);

    // Wheel: accumulate a horizontal run, commit past the threshold, then cool off
    // until the run reverses or goes quiet.
    let wheelOffset = 0;
    let quietTimer: number | undefined;
    let cooling = false;
    let cooldownDir: 1 | -1 = 1;
    let deferToInner = false;
    let baseWidth = 0;
    let peakAbs = 0;
    let prevCommitMs = 0;
    let wheelOpen = false;
    const finishWheel = () => {
      wheelOffset = 0;
      cooling = false;
      deferToInner = false;
      peakAbs = 0;
      baseWidth = 0;
      paint(0, true);
      if (wheelOpen) {
        wheelOpen = false;
        closeWindow();
      }
    };
    surface.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        // On touch builds a horizontal scroller under the pointer (a wide code
        // block, a table) owns the wheel, so the chat must not page under it.
        if (touch) {
          let el = e.target instanceof Element ? e.target : null;
          while (el && el !== surface) {
            if (el.scrollWidth > el.clientWidth + 1) {
              const {overflowX} = window.getComputedStyle(el);
              if (overflowX === 'auto' || overflowX === 'scroll') return;
            }
            el = el.parentElement;
          }
        }
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        if (
          !deferToInner &&
          !wheelOffset &&
          !cooling &&
          innerScrollerHasRoomX(e.target, surface, e.deltaX)
        )
          deferToInner = true;
        window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(finishWheel, CHAT_WHEEL_QUIET_MS);
        if (deferToInner) return;

        const absX = Math.abs(e.deltaX);
        const incomingDir: 1 | -1 = e.deltaX > 0 ? 1 : -1;
        if (cooling) {
          if (incomingDir === cooldownDir) return;
          cooling = false;
          wheelOffset = 0;
          peakAbs = 0;
        }
        e.preventDefault();

        const dir: 1 | -1 = wheelOffset - e.deltaX < 0 ? 1 : -1;
        if (!canGo(dir)) {
          wheelOffset = 0;
          paint(0, false);
          return;
        }
        wheelOffset -= e.deltaX;
        if (!baseWidth) baseWidth = surfaceWidth();
        if (!wheelOpen) {
          wheelOpen = true;
          openWindow();
        }
        if (absX > peakAbs) peakAbs = absX;
        paint(clampNumber(slopSubtracted(wheelOffset), -baseWidth, baseWidth), false, baseWidth);
        if (Math.abs(wheelOffset) <= CHAT_WHEEL_COMMIT_PX) return;

        cooling = true;
        cooldownDir = dir;
        const now = Date.now();
        const wheel = {sinceLastMs: prevCommitMs ? now - prevCommitMs : 0, peakAbs};
        prevCommitMs = now;
        const w = baseWidth;
        if (reveals(dir)) {
          paint(0, true, w);
          runGo(dir, wheel);
          return;
        }
        paint(dir > 0 ? -w : w, true, w);
        window.setTimeout(() => {
          runGo(dir, wheel);
          paint(0, false);
        }, CHAT_PAGE_ANIM_MS);
      },
      {passive: false}
    );

    if (!touch) return;

    // Pointer/touch drag: axis-lock, threshold and velocity are owned by the
    // gesture wrapper (features/gestures.ts); this surface only paints the offset
    // and runs the page action. The wrapper hands back travel already past the arm
    // slop, so we paint it directly (no second slop subtraction) for the same
    // visual progress the wheel path shows. A back-swipe (rightward, wrapper
    // dir 1) is gated to a start near the left edge; paging to the next chat
    // (leftward, wrapper dir -1) is not. commitPage takes the surface's own dir
    // convention (dir<0 back, dir>0 next), so we flip the wrapper's sign.
    let dragOpen = false;
    const beginDrag = () => {
      if (dragOpen) return;
      dragOpen = true;
      openWindow();
    };
    const endDrag = () => {
      if (!dragOpen) return;
      dragOpen = false;
      closeWindow();
    };
    const paintDrag = (dx: number) => {
      beginDrag();
      paint(clampNumber(dx, -surfaceWidth(), surfaceWidth()), false);
    };
    const snapBack = () => {
      endDrag();
      paint(0, true);
    };
    const commitPage = (dir: 1 | -1) => {
      endDrag();
      const w = surfaceWidth();
      if (reveals(dir)) {
        paint(0, true);
        runGo(dir);
        return;
      }
      paint(dir > 0 ? -w : w, true);
      setTimeout(() => {
        runGo(dir);
        paint(dir > 0 ? w : -w, false);
        requestAnimationFrame(() => paint(0, true));
      }, CHAT_PAGE_ANIM_MS);
    };
    // A `.cyc-steprange` slider or an inner horizontal scroller under the start
    // owns its own drag; leave chat paging off it.
    const startEligible = (start: EventTarget | null): boolean => {
      if (start instanceof Element && start.closest('.cyc-steprange')) return false;
      let el = start instanceof Element ? start : null;
      while (el && el !== surface) {
        if (el.scrollWidth > el.clientWidth + 1) {
          const {overflowX} = window.getComputedStyle(el);
          if (overflowX === 'auto' || overflowX === 'scroll') return false;
        }
        el = el.parentElement;
      }
      return true;
    };

    deps.onTeardown(
      onHorizontalSwipe(surface, {
        edge: 'left',
        edgeInsetPx: CHAT_EDGE_INSET_PX,
        direction: 1,
        thresholdPct: CHAT_COMMIT_PCT,
        velocityCommit: CHAT_FLICK_VELOCITY,
        armPx: CHAT_ARM_PX,
        travelWidth: surfaceWidth,
        canStart: startEligible,
        onProgress: ({dx}) => paintDrag(dx),
        onCommit: () => commitPage(-1),
        onCancel: snapBack
      })
    );
    deps.onTeardown(
      onHorizontalSwipe(surface, {
        direction: -1,
        thresholdPct: CHAT_COMMIT_PCT,
        velocityCommit: CHAT_FLICK_VELOCITY,
        armPx: CHAT_ARM_PX,
        travelWidth: surfaceWidth,
        canStart: (start) => startEligible(start) && !!deps.jumpTarget(1),
        onProgress: ({dx}) => paintDrag(dx),
        onCommit: () => commitPage(1),
        onCancel: snapBack
      })
    );
  };
  installChatPaging(touchCapable);

  const stickyDates = attachStickyDates(messageListEl, messageListScroll);
  deps.onTeardown(stickyDates.destroy);

  type OpenToken = {seq: number; id: string; readerTook: boolean; win: number};
  let openToken: OpenToken | null = null;
  let openTokenSeq = 0;

  let openAbandoning = false;

  const openOwned = (): boolean => !!openToken && interactionWindow.active('open');
  const OPEN_ABANDON_MS = 14000;
  let openAbandonTimer: ReturnType<typeof setTimeout> | undefined;
  const closeOpen = (reason: string) => {
    clearTimeout(openAbandonTimer);
    if (openToken?.win) {
      interactionWindow.end(openToken.win);
      openToken.win = 0;
      if (SCROLL_TRACE) console.debug(`[cyc-overflow] open closed: ${reason}`);
    }
  };

  const SETTLE_IDLE_MS = 600;
  let settleGraceOpen = false;
  let graceHeldGrowth = false;
  let graceIdleTimer: ReturnType<typeof setTimeout> | undefined;

  const reconcileGrace = () => {
    const s = active();
    if (!s || !messageListInner.childElementCount) return;
    if (!graceHeldGrowth || firstUnreadId !== undefined) return;
    const nearPx = Math.max(OVERLAY_SCROLL_NEAR_PX, messageListScroll.clientHeight / 3);
    const dist = distToEnd();
    if (dist > 1 && dist <= nearPx) scrollToBottom();
  };
  const closeSettleGrace = (reconcile: boolean) => {
    clearTimeout(graceIdleTimer);
    if (!settleGraceOpen) return;
    settleGraceOpen = false;
    if (reconcile) reconcileGrace();
    graceHeldGrowth = false;
  };
  const refreshSettleGrace = () => {
    if (!settleGraceOpen) return;
    clearTimeout(graceIdleTimer);
    graceIdleTimer = setTimeout(() => closeSettleGrace(true), SETTLE_IDLE_MS);
  };
  const openSettleGrace = () => {
    settleGraceOpen = true;
    graceHeldGrowth = false;
    clearTimeout(graceIdleTimer);
    graceIdleTimer = setTimeout(() => closeSettleGrace(true), SETTLE_IDLE_MS);
  };

  // PINNED TO THE BOTTOM. True while the reader sits at the very end of the
  // list: every machine write derives it from where the write landed, and the
  // reader's own scrolls re-derive it. Growth that lands after a pin with no
  // store notify to re-pin it (image bytes, the agents bar or a header row
  // reserving more top pad, a viewport resize) shifts the rows and leaves the
  // last bubble under the composer; `listResize` below catches every such
  // change after layout and re-pins. A reader who is not pinned is never moved
  // by content growth; only a change of the top pad shifts their offset by the
  // same amount so what they are reading stays put. No timers on this path.
  const PIN_PX = 4;
  let pinnedToBottom = false;
  let padTopSeen = 0;
  let pointerHeld = false;
  const notePinAfterWrite = () => {
    pinnedToBottom = distToEnd() <= PIN_PX;
    padTopSeen = messageListPadTop.offsetHeight;
  };

  const SCROLL_TRACE = new URLSearchParams(location.search).get('cycscroll') === '1';
  const silentScrollTo = (v: number) => {
    if (SCROLL_TRACE) {
      const at = (new Error().stack ?? '').split('\n').slice(2, 5).join(' | ');

      console.debug(
        `[cyc-overflow] write v=${Math.round(v)} from=${Math.round(messageListScroll.scrollTop)}` +
          `${openOwned() ? '' : ' UNOWNED'} ${at}`
      );
    }
    messageListScroll.scrollTop = v;
    markMachineTop(messageListScroll);
    notePinAfterWrite();
  };
  const isMachineTop = (top: number) => machineTopMatches(messageListScroll, top);

  let bracketMoves = 0;
  const bracketMessageRender = (id: string, paint: () => void) => {
    const keep = messageListInner.dataset.cycChat === id && messageListInner.childElementCount > 0;
    // Written only on a change: a paint that keeps every row must leave the
    // list without a single mutation, and a same-value write still fires one.
    if (messageListInner.dataset.cycChat !== id) messageListInner.dataset.cycChat = id;
    if (!keep) {
      paint();
      return;
    }
    // Pin the on-screen position across the render: anchor to the first message
    // whose top sits at or below the fold, captured immediately before the paint.
    const before = messageListScroll.scrollTop;
    const hBefore = messageListScroll.scrollHeight;
    let anchor: HTMLElement | null = null;
    let anchorDelta = 0;
    for (const row of messageListScroll.querySelectorAll<HTMLElement>('.cyc-message')) {
      if (row.offsetTop >= before) {
        anchor = row;
        anchorDelta = row.offsetTop - before;
        break;
      }
    }
    paint();
    if (anchor?.isConnected) {
      // The anchor survived: re-seat so it keeps the same offset from the top.
      messageListScroll.scrollTop = anchor.offsetTop - anchorDelta;
    } else {
      // The anchor is gone -- an upward-growing list shifted its history down by
      // the height added at the top, so carry that growth into the offset.
      const grew = messageListScroll.scrollHeight - hBefore;
      if (grew) messageListScroll.scrollTop = messageListScroll.scrollTop + grew;
    }
    const after = messageListScroll.scrollTop;
    markMachineTop(messageListScroll);
    // A paint never speaks for the reader: it can confirm a pin (a shrink
    // clamped the view to the end) but not drop one. The top pad may already
    // have grown earlier in this same render (the agents bar), which leaves the
    // pinned view short of the end here; the observer re-pins it after layout,
    // and carries an unpinned reader by the pad change it still sees.
    pinnedToBottom = pinnedToBottom || distToEnd() <= PIN_PX;
    if (Math.abs(after - before) > 1) bracketMoves++;
    if (SCROLL_TRACE) {
      const hAfter = messageListScroll.scrollHeight;
      if (hAfter !== hBefore || after !== before) {
        console.debug(
          `[cyc-overflow] bracket top ${Math.round(before)}->${Math.round(after)} h ${hBefore}->${hAfter}`
        );
      }
    }
  };

  const scrollToBottom = () => {
    silentScrollTo(messageListScroll.scrollHeight);
  };

  // Runs after layout whenever the list content, either pad, or the scroller's
  // own box changes size. Pinned: any distance to the end is drift, re-pin.
  // Not pinned: carry a top pad change so the rows under the reader's eyes do
  // not slide. A finger on the surface owns the offset until it lifts.
  const onListResize = () => {
    const padNow = messageListPadTop.offsetHeight;
    const padDelta = padNow - padTopSeen;
    padTopSeen = padNow;
    if (pointerHeld || !messageListInner.childElementCount) return;
    if (pinnedToBottom) {
      if (distToEnd() > 0) scrollToBottom();
    } else if (padDelta) {
      silentScrollTo(messageListScroll.scrollTop + padDelta);
    }
  };
  if (typeof ResizeObserver !== 'undefined') {
    const listResize = new ResizeObserver(onListResize);
    listResize.observe(messageListInner);
    listResize.observe(messageListPadTop);
    listResize.observe(messageListPadBottom);
    listResize.observe(messageListScroll);
    deps.onTeardown(() => listResize.disconnect());
  }

  const holdPointer = () => {
    pointerHeld = true;
  };
  const releasePointer = () => {
    pointerHeld = false;
  };
  messageListScroll.addEventListener('pointerdown', holdPointer, {passive: true});
  window.addEventListener('pointerup', releasePointer, {passive: true});
  window.addEventListener('pointercancel', releasePointer, {passive: true});
  deps.onTeardown(() => {
    window.removeEventListener('pointerup', releasePointer);
    window.removeEventListener('pointercancel', releasePointer);
  });

  // The last time a real reader input (a finger drag or a wheel) touched the
  // scroller. The readerTook guard uses it as evidence that a reader is
  // plausibly driving a scroll: a touchmove/wheel within ~150ms, or a pointer
  // still held. Without evidence, an untagged app write (a keyboard-inset
  // clearance step) or a browser adjustment (clamp, scroll anchoring) can look
  // exactly like a reader taking the open landing, and must not.
  const READER_INPUT_MS = 150;
  let lastReaderInputAt = 0;
  const noteReaderInput = () => {
    lastReaderInputAt = Date.now();
  };
  messageListScroll.addEventListener('touchmove', noteReaderInput, {passive: true});
  messageListScroll.addEventListener('wheel', noteReaderInput, {passive: true});
  const readerInputPlausible = () =>
    pointerHeld || Date.now() - lastReaderInputAt <= READER_INPUT_MS;

  const chrome = createChatChrome({
    chat: deps.chatEl,
    scroll: messageListScroll,
    nearBottomPx: OVERLAY_SCROLL_NEAR_PX,
    closeSettleGrace
  });
  const {setNewBelow, updateGoDown, hideUnreadBanner, showUnreadBanner} = chrome;

  let firstUnreadId: string | undefined;

  // The read marker captured at open, as a ROW IDENTITY (fix-unread), and
  // whether the engine had spoken a read state to capture. `openCaptured` is
  // the state the old `openHeardTs !== undefined` stood in for: a marker of
  // `undefined` is a real captured value (nothing read here yet), so presence
  // of the value can no longer be the flag.
  let openMarker: ReadMarker | undefined;
  let openCaptured = false;
  const readerLanding = createReaderLanding({
    deps,
    messages: messageListInner,
    scroll: messageListScroll,
    silentScrollTo,
    openMarker: () => openMarker,
    setOpenMarker: (marker) => {
      openMarker = marker;
    }
  });
  const {nothingUnseen, firstUnheardId, speakUnheard, scrollToFirstUnread, noteHeardMarked} =
    readerLanding;

  const anchorSourceKnown = (s: CycSession): boolean =>
    dataState.mode !== 'live' || (s as CycEngineSession).heardTs !== undefined;

  let openUnreadCount = 0;

  let anchorHopSpent = false;
  let anchorHopPending = false;
  let anchorSuppressed = false;

  let openLanding = false;

  let openPaintPending = false;
  let openPaintAt = 0;

  let deepLinkSpeakId: string | null = null;

  let readerTrackTop = 0;
  let readerTrackHeight = 0;
  let readerTrackClientH = 0;
  messageListScroll.addEventListener(
    'scroll',
    () => {
      const top = messageListScroll.scrollTop;
      const height = messageListScroll.scrollHeight;
      const clientH = messageListScroll.clientHeight;
      const machine = isMachineTop(top);

      if (
        openLanding &&
        openToken &&
        !openToken.readerTook &&
        !machine &&
        readerInputPlausible() &&
        top < readerTrackTop - 1 &&
        height >= readerTrackHeight - 1 &&
        clientH <= readerTrackClientH + 1
      ) {
        openToken.readerTook = true;
        closeOpen('readerTook');
      }

      if (settleGraceOpen && !machine && distToEnd() <= 4) {
        closeSettleGrace(false);
      }
      // The reader's own scroll (or a browser clamp) decides whether the view
      // is still pinned. A machine write already recorded where it landed and
      // its event may arrive after a growth the observer is about to absorb,
      // so it can only confirm a pin, never drop one.
      if (!machine) pinnedToBottom = distToEnd() <= PIN_PX;
      else if (distToEnd() <= PIN_PX) pinnedToBottom = true;
      readerTrackTop = top;
      readerTrackHeight = height;
      readerTrackClientH = clientH;
    },
    {passive: true}
  );

  let markReadOnComplete = false;
  const settleNow = (id: string) => {
    if (sessionState.activeId !== id) return;

    const s = dataState.mode === 'live' ? engine.get(id) : active();
    if (!s) return;

    if ((s as CycEngineSession).historyPending) return;
    if (anchorHopPending) return;
    let changed = false;

    if (anchorSuppressed) {
    } else if (openCaptured) {
      // The store zeroes the attached chat's badge, so settle passes the count
      // captured at open (openUnreadCount) as the read-state authority.
      const pinned = firstUnheardId(s, openMarker, openUnreadCount);

      if (
        pinned !== undefined &&
        pinned !== firstUnreadId &&
        (openLanding || firstUnreadId === undefined)
      ) {
        firstUnreadId = pinned;
        changed = true;
      }
    } else if (firstUnreadId === undefined) {
      if (anchorSourceKnown(s)) {
        firstUnreadId = firstUnheardId(s, undefined, openUnreadCount);
        changed = firstUnreadId !== undefined;
      }
    }
    if (openLanding) {
      if (
        !anchorSuppressed &&
        firstUnreadId !== undefined &&
        openCaptured &&
        dataState.mode === 'live' &&
        engine.canOlder(id)
      ) {
        const heard = openMarker?.ts ?? 0;
        const oldestMessage = s.messages[0];
        if (oldestMessage && oldestMessage.ts > heard) {
          if (!anchorHopSpent) {
            anchorHopSpent = true;
            anchorHopPending = true;
            deps.render();
            const tok = openTokenSeq;
            void engine.loadOlder(id).then(() => {
              if (openTokenSeq !== tok) return;
              anchorHopPending = false;
              settleNow(id);
            });
            return;
          }

          openLanding = false;
          anchorSuppressed = true;
          firstUnreadId = undefined;
          deps.render();
          if (!openToken?.readerTook) scrollToBottom();
          const held = s.messages.filter((m) => m.ts > heard).length;
          showUnreadBanner(Math.max(openUnreadCount, held));
          if (dataState.mode === 'live') {
            cyclog('scroll.landing', {
              session: id,
              target: 'bottom',
              actual: Math.round(distToEnd()),
              corrected: false,
              deep: true
            });
          }

          closeOpen('placement:deep');
          if (!openToken?.readerTook) openSettleGrace();

          speakUnheard(id);

          /* No mode gate: the report queues a durable intent, so an open that
           * lands from cache while the pipe reconnects still marks the chat
           * read the moment the engine is reachable again. */
          if (!openAbandoning && document.visibilityState === 'visible') {
            deps.reportViewedThrough(id);
          }
          return;
        }
      }

      openLanding = false;

      let landCorrected = false;
      deps.render();
      if (openToken?.readerTook) {
      } else if (firstUnreadId !== undefined) {
        if (!scrollToFirstUnread()) {
          clearMessages(messageListInner);
          deps.render();
          landCorrected = true;
          if (!scrollToFirstUnread()) scrollToBottom();
        }
      } else {
        scrollToBottom();
      }

      if (dataState.mode === 'live') {
        cyclog('scroll.landing', {
          session: id,
          target: openToken?.readerTook
            ? 'held'
            : firstUnreadId !== undefined
              ? 'unread'
              : 'bottom',
          actual: Math.round(distToEnd()),
          corrected: landCorrected
        });
      }

      closeOpen('placement');
      if (!openToken?.readerTook) openSettleGrace();

      markReadOnComplete = !openAbandoning;
    } else if (changed) {
      deps.render();

      const followed = distToEnd() < 4;
      if (followed) scrollToFirstUnread();

      if (dataState.mode === 'live') {
        cyclog('scroll.landing', {
          session: id,
          target: followed ? 'unread' : 'held',
          actual: Math.round(distToEnd()),
          corrected: true
        });
      }
    }
    speakUnheard(id);

    if (markReadOnComplete) {
      markReadOnComplete = false;
      if (document.visibilityState === 'visible') deps.reportViewedThrough(id);
    }
  };

  let settleTimers: ReturnType<typeof setTimeout>[] = [];
  const OPEN_DEADLINE_MS = 2000;
  const settleUnheard = (id: string) => {
    settleTimers.forEach(clearTimeout);
    const tok = openTokenSeq;
    settleTimers = [
      setTimeout(() => {
        if (openTokenSeq === tok) settleNow(id);
      }, OPEN_DEADLINE_MS)
    ];
  };

  const clearUnreadAnchor = () => {
    if (sessionState.activeId) deps.markSeen(sessionState.activeId);
    openMarker = undefined;
    openCaptured = false;
    openLanding = false;
    closeOpen('answered');
    closeSettleGrace(false);
    openToken = null;
    deepLinkSpeakId = null;
    anchorSuppressed = false;
    hideUnreadBanner();
    if (firstUnreadId === undefined) return;
    firstUnreadId = undefined;
    deps.render();
  };

  const historyPager = installHistoryPager({
    container: messageListScroll,
    messages: messageListInner,
    render: deps.render,
    ownsOpening: openOwned,
    isAnchoring: () => anchorHopPending,
    isMachineScroll: isMachineTop
  });
  deps.onTeardown(historyPager.destroy);

  let messageListSwapToken = 0;
  function zoomFadeMessages(commit: () => void) {
    const token = ++messageListSwapToken;
    messageListEl.classList.add('cyc-msg-swapping', 'cyc-msg-swap-out');
    setTimeout(() => {
      if (token !== messageListSwapToken) return;
      commit();
      messageListEl.classList.remove('cyc-msg-swap-out');
      setTimeout(() => {
        if (token === messageListSwapToken) messageListEl.classList.remove('cyc-msg-swapping');
      }, 160);
    }, 90);
  }

  function openChat(id: string, after?: () => void, opts?: {keepList?: boolean}) {
    const s = dataState.mode === 'live' ? engine.get(id) : allSessions().find((x) => x.id === id);
    if (!s) {
      cyclog('nav.tap', {
        control: 'open',
        session: id,
        decision: 'unknown-session',
        rendered: 'none'
      });
      return;
    }
    const prevId = sessionState.activeId;

    const wasActive = prevId === id && deps.isChatViewOpen();

    cyclog('nav.tap', {
      control: 'open',
      session: id,
      decision: wasActive ? 'refocus' : 'fresh-open',
      rendered: 'chat',
      unread: (s as {unread?: number}).unread ?? 0
    });

    if (prevId && prevId !== id && deps.isChatViewOpen()) deps.markSeen(prevId);

    if (deps.draftOwner() !== id) {
      deps.saveDraft();
      deps.loadDraft(id);
    }

    sessionState.activeId = id;
    if (prevId !== id) deps.rebuildToolbarSettings();

    deps.restorePending.delete('chat');
    localStorage.setItem('cyc-engaged', id);

    if (dataState.mode === 'live') {
      const tabId = selectTabFor(id);
      if (tabId) sessionState.tabSelection.set(tabId, id);
      if (!wasActive) deps.agentsBarReset();
    }

    if (!wasActive) {
      // Capture the engine's unread count BEFORE the attach below zeroes the
      // open chat's badge: it is the read-state authority the landing uses.
      openUnreadCount = s.unread;
      openMarker = anchorSourceKnown(s) ? deps.readMarkerOf(s) : undefined;
      openCaptured = anchorSourceKnown(s);
      firstUnreadId = openCaptured ? firstUnheardId(s, openMarker, openUnreadCount) : undefined;

      anchorHopSpent = false;
      anchorHopPending = false;
      anchorSuppressed = false;
      hideUnreadBanner();

      openLanding = true;
      // The landing decides the pin for this chat; until it runs, nothing
      // carried over from the last chat may move the view.
      pinnedToBottom = false;
      padTopSeen = messageListPadTop.offsetHeight;

      closeOpen('superseded');
      closeSettleGrace(false);
      openToken = {
        seq: ++openTokenSeq,
        id,
        readerTook: false,
        win: interactionWindow.begin('open', 'openchat:' + id)
      };

      deps.armSettleResort();
      clearTimeout(openAbandonTimer);
      openAbandonTimer = setTimeout(() => {
        if (openOwned()) {
          cyclog('open.abandoned', {session: id, ms: OPEN_ABANDON_MS});
          openAbandoning = true;
          settleNow(id);
          openAbandoning = false;
          closeOpen('abandoned');
        }
      }, OPEN_ABANDON_MS);

      openPaintPending = true;
      openPaintAt = Date.now();

      if (deepLinkSpeakId && deepLinkSpeakId !== id) deepLinkSpeakId = null;

      readerTrackTop = messageListScroll.scrollTop;
      readerTrackHeight = messageListScroll.scrollHeight;
      readerTrackClientH = messageListScroll.clientHeight;

      setNewBelow(0);

      const st = speaker.state;
      if (st.sessionId && st.sessionId !== id) speaker.stopAll();
    }
    s.unread = 0;
    if (dataState.mode === 'live') {
      cyclog('chat.opened', {
        session: id,
        name: s.name,
        unread: openUnreadCount,
        messages: s.messages.length
      });
      engine.attach(id);

      if (sessionState.chatConversationMode.has(id)) {
        void ensureMic()
          .then(() => {
            if (sessionState.activeId === id && sessionState.chatConversationMode.has(id)) {
              pipeline.enableHandsFree(id);
            }
          })
          .catch(() => {
            sessionState.chatConversationMode.delete(id);
            toast('Microphone unavailable');
            deps.render();
          });
      } else if (pipeline.handsFreeSessionId) {
        pipeline.disableHandsFree();
        deps.releaseMicIfIdle();
      }
    }

    const takeBannerDown = () => {
      const nk = engine.notifyKey(s.id);
      if (!nk) return;
      void clearNotifications(nk);
      void reportRead(nk);
    };

    if (wasActive) {
      deps.clearSuppressAutoSpeak();

      openMarker = anchorSourceKnown(s) ? deps.readMarkerOf(s) : undefined;
      openCaptured = anchorSourceKnown(s);
      firstUnreadId = openCaptured ? firstUnheardId(s, openMarker) : undefined;
      deps.render();
      takeBannerDown();
      speakUnheard(id);

      settleNow(id);
      after?.();
      return;
    }
    const commit = () => {
      deps.setView(opts?.keepList ? 'list' : 'chat');
      deps.render();

      // Only a populated local window waits for replay to choose its first
      // placement. An empty view places at bottom immediately and can safely
      // upgrade to an unread anchor when replay supplies content.
      if (dataState.mode === 'live' && !(s as CycEngineSession).historyPending) {
        if (firstUnreadId !== undefined && scrollToFirstUnread()) {
        } else scrollToBottom();
      }
      settleNow(s.id);

      if (!touchCapable) deps.composerFocus();

      speakUnheard(s.id);
      settleUnheard(s.id);
      takeBannerDown();
      after?.();
    };
    const animateSwap = prevId !== null && !wasActive && window.innerWidth > 550 && prefersMotion();
    if (animateSwap) zoomFadeMessages(commit);
    else commit();
  }

  const landingOwed = () => openLanding;
  const readerTook = () => !!openToken?.readerTook;
  const graceOpen = () => settleGraceOpen;
  const holdGraceGrowth = () => {
    graceHeldGrowth = true;
  };
  const firstUnread = () => firstUnreadId;
  const newBelowCount = chrome.newBelowCount;
  const openPaintIsPending = () => openPaintPending;
  const openPaintStartedAt = () => openPaintAt;
  const clearOpenPaint = () => {
    openPaintPending = false;
  };

  const armDeepLinkSpeak = (id: string) => {
    deepLinkSpeakId = id;
  };

  if (new URLSearchParams(location.search).get('testhooks')) {
    (
      window as never as {
        __cycScrollDiag: () => {
          bracketMoves: number;
          machineTop: number;
          landingOwed: boolean;
          readerTook: boolean;
          scrolledUp: boolean;
          pinned: boolean;
        };
      }
    ).__cycScrollDiag = () => ({
      bracketMoves,
      machineTop: machineTopOf(messageListScroll),
      landingOwed: openLanding,
      readerTook: !!openToken?.readerTook,
      scrolledUp: !!openToken?.readerTook,
      pinned: pinnedToBottom
    });
  }

  const mountChrome = ({
    composerBox,
    openPlayingMessage
  }: {
    composerBox: HTMLElement;
    openPlayingMessage: () => void;
  }) => chrome.mount(composerBox, openPlayingMessage);

  return {
    messageListEl,
    messageListScroll,
    messageListInner,
    showChatBusy,
    hideChatBusy,
    renderEarlier,
    stickyDates,
    OVERLAY_SCROLL_NEAR_PX,
    openChat,
    openOwned,
    closeOpen,
    closeSettleGrace,
    refreshSettleGrace,
    silentScrollTo,
    isMachineTop,
    bracketMessageRender,
    scrollToBottom,
    setNewBelow,
    updateGoDown,
    hideUnreadBanner,
    showUnreadBanner,
    settleNow,
    settleUnheard,
    clearUnreadAnchor,
    nothingUnseen,
    firstUnheardId,
    speakUnheard,
    scrollToFirstUnread,
    noteHeardMarked,
    armDeepLinkSpeak,
    landingOwed,
    readerTook,
    graceOpen,
    holdGraceGrowth,
    firstUnread,
    newBelowCount,
    openPaintIsPending,
    openPaintStartedAt,
    clearOpenPaint,
    mountChrome
  };
}
