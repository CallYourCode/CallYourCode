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
import {
  clearMessages,
  attachStickyDates,
  rewindowMessages,
  setMessageScrollOwner,
  messageListBanked,
  messageModelTop,
  bankMessageShift
} from './messageList';
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
import {createScrollOwner} from './scrollOwner';
import {createReaderLanding} from './readerLanding';
import type {PlayReason} from './audioPlayback';
import {
  markMachineTop,
  isMachineTop as machineTopMatches,
  machineTopOf,
  logScrollWrite,
  logScrollUpUser
} from './machineScroll';
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
  play(sessionId: string, msgId: string, text: string, reason?: PlayReason): void;
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
// Loosened 2026-09-24 (owner: "requires swiping too wide", misses sometimes):
// a quarter-width drag or a gentler, slower flick now commits.
const CHAT_COMMIT_PCT = 0.25;
const CHAT_FLICK_VELOCITY = 0.3;
const CHAT_FLICK_MS = 400;
// A back-swipe must begin within this many px of the surface's left edge. Sized
// for a thumb that lands a little inside the bezel, still well short of the
// message column so a mid-surface drag never navigates back.
const CHAT_EDGE_INSET_PX = 56;
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
        flickMs: CHAT_FLICK_MS,
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
        flickMs: CHAT_FLICK_MS,
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
    // The reader owns the offset (a finger down, their scroll or momentum
    // live): no re-pin under them.
    if (scrollOwner.driving()) return;
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
  // The list and box heights as last laid out for the resize observer or the
  // scroll listener: a change past them is not yet absorbed (no re-pin has run
  // for it), and a scroll event read after it happened in the same frame.
  let listHeightSeen = 0;
  let boxHeightSeen = 0;
  let padTopSeen = 0;
  const notePinAfterWrite = () => {
    pinnedToBottom = distToEnd() <= PIN_PX;
    padTopSeen = messageListPadTop.offsetHeight;
  };
  // A jump to a message (a reply tap, a pill, the audio chip) deliberately
  // scrolls the view away from the bottom. Its scroll writes are machine-tagged,
  // so the scroll listener never DROPS the pin for them (it may only confirm
  // one). Left pinned, the resize observer re-pins to the bottom on every
  // re-window the jump's settle triggers -- yanking the target back off-screen
  // and unmounting it (jump-to-old failed). The traveller calls this to release
  // the pin as it leaves the bottom; if the jump lands at the bottom anyway the
  // scroll listener re-confirms it.
  const releaseBottomPin = () => {
    pinnedToBottom = false;
  };

  const SCROLL_TRACE = new URLSearchParams(location.search).get('cycscroll') === '1';
  const silentScrollTo = (v: number, tag = 'silent', reason?: string) => {
    const from = messageListScroll.scrollTop;
    if (SCROLL_TRACE) {
      const at = (new Error().stack ?? '').split('\n').slice(2, 5).join(' | ');

      console.debug(
        `[cyc-overflow] write v=${Math.round(v)} from=${Math.round(from)}` +
          `${openOwned() ? '' : ' UNOWNED'} ${at}`
      );
    }
    messageListScroll.scrollTop = v;
    logScrollWrite(messageListScroll, tag, from, messageListScroll.scrollTop, reason);
    markMachineTop(messageListScroll);
    notePinAfterWrite();
  };
  const isMachineTop = (top: number) => machineTopMatches(messageListScroll, top);
  // The message re-window's write (anchoredRewindow W5/W6), performed by the
  // ScrollOwner: the same raw tagged, machine-marked write the re-window did
  // inline. It does not re-derive the pin; the scroll listener confirms it.
  const rewindowWrite = (v: number, tag: string) => {
    const from = messageListScroll.scrollTop;
    messageListScroll.scrollTop = v;
    logScrollWrite(messageListScroll, tag, from, messageListScroll.scrollTop);
    markMachineTop(messageListScroll);
  };

  // Run a paint holding the reader's seat: capture on-screen anchors (by mid,
  // rect based) just before it, and return how far the first one that survives
  // drifted on screen across it. In order: the unread DIVIDER when on screen (a
  // landing holds it a third down; a message arriving or older history loading
  // reindexes the rows, so the generic anchor can miss and slide it off its
  // seat); the first message row at or below the fold; the topmost mounted row
  // (older history prepended shifts it DOWN by the height carried before, a tail
  // append leaves it PUT). Null when none survived (a trim, a chat switch).
  //
  // Found and held by SCREEN rect, never by row.offsetTop: offsetTop is measured
  // against the row's positioned GROUP, not the scroll content, so comparing it
  // to scrollTop picked an arbitrary row, and re-seating by it put the reader's
  // row wherever its group happened to sit (arrival-held: 140-220 px).
  const holdAcrossPaint = (paint: () => void): number | null => {
    const boxTop = messageListScroll.getBoundingClientRect().top;
    const held: {mid: string; top: number}[] = [];
    const note = (row: HTMLElement | null | undefined) => {
      const mid = row?.dataset.mid;
      if (row && mid) held.push({mid, top: row.getBoundingClientRect().top - boxTop});
    };
    const dividerRow = messageListScroll.querySelector<HTMLElement>(
      '.cyc-message[data-cyc-unread][data-mid]'
    );
    if (dividerRow) {
      const dr = dividerRow.getBoundingClientRect();
      if (dr.bottom > boxTop && dr.top < boxTop + messageListScroll.clientHeight) note(dividerRow);
    }
    const rows = messageListScroll.querySelectorAll<HTMLElement>('.cyc-message[data-mid]');
    for (const row of rows) {
      if (row.getBoundingClientRect().top >= boxTop) {
        note(row);
        break;
      }
    }
    note(rows[0]);
    paint();
    for (const a of held) {
      const el = messageListInner.querySelector<HTMLElement>(
        `.cyc-message[data-mid="${CSS.escape(a.mid)}"]`
      );
      if (el) return el.getBoundingClientRect().top - boxTop - a.top;
    }
    return null;
  };

  /* WHAT HAS BEEN ON SCREEN, the one answer every read path asks (owner,
   * 2026-10-03: a row is read only when it has actually been on screen; the
   * chat being open and visible is not that). The newest message row whose top
   * has come SEEN_PX into the viewport, as its row id; rows above it were
   * scrolled past to get here. Undefined when the viewport is not showing this
   * chat: another chat painted, the page hidden, or the box not laid out (the
   * list view on a phone). Found by SCREEN rect, for the reason holdAcrossPaint
   * gives above. */
  const SEEN_PX = 16;
  const newestOnScreen = (id: string): string | undefined => {
    if (messageListInner.dataset.cycChat !== id) return undefined;
    if (document.visibilityState !== 'visible') return undefined;
    const clientH = messageListScroll.clientHeight;
    if (clientH <= 0) return undefined;
    const fold = messageListScroll.getBoundingClientRect().top + clientH - SEEN_PX;
    const rows = messageListScroll.querySelectorAll<HTMLElement>('.cyc-message[data-mid]');
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].getBoundingClientRect().top < fold) return rows[i].dataset.mid;
    }
    return undefined;
  };

  /* A SCROLL brings rows on screen, so it is a read path like any other: the
   * reader scrolling down to a reply sights it, and so does the machine's own
   * follow to the end. Coalesced to one sighting per pause; never while the
   * open landing still owns the chat (it reports when it places). */
  const SCROLL_SIGHT_MS = 150;
  let scrollSightTimer: ReturnType<typeof setTimeout> | undefined;
  const sightAfterScroll = () => {
    clearTimeout(scrollSightTimer);
    scrollSightTimer = setTimeout(() => {
      const id = sessionState.activeId;
      if (!id || dataState.mode !== 'live' || openOwned() || openLanding) return;
      deps.reportViewedThrough(id);
    }, SCROLL_SIGHT_MS);
  };
  deps.onTeardown(() => clearTimeout(scrollSightTimer));

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
    // Paint, then ONE owner settle (phase 3 step 6). The reader's seat is held
    // by an on-screen anchor captured just before the paint and re-found by mid
    // after it; the drift it shows is handed to the owner, which banks it in the
    // spacer while a reader drives and otherwise writes it once and re-windows
    // once. A pinned reader takes the SAME hold: the post-layout pin (the arrival
    // follow, the resize settle) then lands the end once at the settled height.
    // An earlier revision pinned to the bottom HERE, off the paint-time
    // scrollHeight; on a sliding window that height is a from-estimate rebuild, so
    // the pin overshot and the measured-height settle re-pinned a SECOND time --
    // two scrolls per message (D1).
    const before = messageListScroll.scrollTop;
    const hBefore = messageListScroll.scrollHeight;
    const drift = holdAcrossPaint(paint);
    // The paint already re-seated the scroll itself (messageList's front-prepend
    // hold under a live selection, which rides the virtualizer's offsets): defer.
    if (messageListScroll.scrollTop === before) {
      scrollOwner.settlePaint(drift ?? messageListScroll.scrollHeight - hBefore);
    } else {
      logScrollWrite(messageListScroll, 'bracket', before, messageListScroll.scrollTop);
      markMachineTop(messageListScroll);
    }
    const after = messageListScroll.scrollTop;
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

  const scrollToBottom = (reason?: string) => {
    silentScrollTo(messageListScroll.scrollHeight, 'toBottom', reason);
  };

  // Runs after layout whenever the list content, either pad, or the scroller's
  // own box changes size. Pinned: any distance to the end is drift, re-pin.
  // Not pinned: carry a top pad change so the rows under the reader's eyes do
  // not slide. A finger on the surface owns the offset until it lifts.
  const onListResize = () => {
    listHeightSeen = messageListScroll.scrollHeight;
    boxHeightSeen = messageListScroll.clientHeight;
    const padNow = messageListPadTop.offsetHeight;
    const padDelta = padNow - padTopSeen;
    padTopSeen = padNow;
    if (!messageListInner.childElementCount) return;
    // The owner settles every content/pad/box resize (phase 3 step 5): it
    // re-seats a held divider, keeps a pinned end, or carries a top-pad change
    // for a reader in history -- and while a reader drives it writes nothing.
    scrollOwner.settleResize(padDelta);
  };
  // Hold the unread divider on its landing seat through async row-height changes
  // ABOVE the fold. A waveform/image/markdown row hydrating a beat after the
  // open reflows its height; when that does not change the visible index range
  // the virtualizer fires no re-window, so nothing re-seats the divider and it
  // slides off screen (measured on the larger viewports, where more hydratable
  // rows mount above the fold). The resize observer DOES see the content resize,
  // so while the landing holds (until the reader's own scroll releases it) the
  // owner re-seats the divider a third of the way down and re-windows so it
  // stays mounted. False when no divider is mounted (nothing to hold).
  const reseatDivider = (): boolean => {
    const divider = messageListInner.querySelector<HTMLElement>('[data-cyc-unread]');
    if (!divider) return false;
    // A live selection means the reader is here and reading: end the hold
    // and never scroll or re-window the row their selection lives in.
    if (selectionInList()) {
      endDividerHold();
      return true;
    }
    const seat = messageListScroll.clientHeight / 3;
    const now = divider.getBoundingClientRect().top - messageListScroll.getBoundingClientRect().top;
    if (Math.abs(now - seat) > 1) {
      silentScrollTo(messageListScroll.scrollTop + (now - seat), 'resize.divider');
      rewindowMessages(messageListInner);
    }
    return true;
  };
  if (typeof ResizeObserver !== 'undefined') {
    const listResize = new ResizeObserver(onListResize);
    listResize.observe(messageListInner);
    listResize.observe(messageListPadTop);
    listResize.observe(messageListPadBottom);
    listResize.observe(messageListScroll);
    deps.onTeardown(() => listResize.disconnect());
  }

  // Any user interaction ends the divider hold at once, so it can never re-seat
  // (and wipe a selection) once the reader is doing anything in the chat. The
  // reader's hands themselves (finger/pointer down, fresh input) are tracked by
  // the ScrollOwner.
  const endHoldOnInput = () => endDividerHold();
  const endHoldOnSelection = () => {
    if (selectionInList()) endDividerHold();
  };
  messageListScroll.addEventListener('pointerdown', endHoldOnInput, {passive: true});
  messageListScroll.addEventListener('wheel', endHoldOnInput, {passive: true});
  messageListScroll.addEventListener('touchstart', endHoldOnInput, {passive: true});
  window.addEventListener('keydown', endHoldOnInput, {passive: true});
  document.addEventListener('selectionchange', endHoldOnSelection, {passive: true});
  deps.onTeardown(() => {
    window.removeEventListener('keydown', endHoldOnInput);
    document.removeEventListener('selectionchange', endHoldOnSelection);
  });

  const chrome = createChatChrome({
    chat: deps.chatEl,
    scroll: messageListScroll,
    nearBottomPx: OVERLAY_SCROLL_NEAR_PX,
    closeSettleGrace,
    // W13 go-to-bottom behind the owner's jump (phase 2 step 3). The handler only
    // fires at click time, long after the owner is created, so the reference is
    // safe. The owner runs the existing smooth-scroll routine verbatim.
    wrapJump: (run) => scrollOwner.jump('to-bottom', run)
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
    silentScrollTo: (v: number) => silentScrollTo(v, 'landing'),
    openMarker: () => openMarker,
    setOpenMarker: (marker) => {
      openMarker = marker;
    }
  });
  const {
    nothingUnseen,
    firstUnheardId,
    speakUnheard,
    scrollToFirstUnread: scrollToFirstUnreadRaw,
    noteHeardMarked
  } = readerLanding;

  // True from an unread landing until the reader takes over: the onListResize
  // observer re-seats the divider on its landing spot through async row-height
  // changes above the fold (content hydration reflows a row without changing the
  // visible index range, so no re-window fires to re-seat it). Released on the
  // reader's own scroll, so it never fights a real gesture; also on a pin, a chat
  // switch, or the anchor being answered/cleared.
  let holdDivider = false;

  // The divider hold must be strictly bounded: it re-seats the divider on every
  // content resize, and if a row above the fold keeps reflowing (or the re-seat's
  // own rewindow changes heights) it oscillates -- a machine scroll every couple
  // of seconds that wipes the owner's text selection and re-windows rows under
  // their cursor (the phantom scrolls). So the hold ENDS at the first user
  // interaction of any kind (pointerdown, keydown, wheel, touch, or a non-empty
  // selection) and, failing that, after a short fixed window, and it never
  // re-seats over a live selection.
  const HOLD_DIVIDER_MAX_MS = 1500;
  let holdDividerTimer: ReturnType<typeof setTimeout> | null = null;
  const endDividerHold = () => {
    holdDivider = false;
    if (holdDividerTimer !== null) {
      clearTimeout(holdDividerTimer);
      holdDividerTimer = null;
    }
  };

  // A non-empty text selection anchored inside the message list. A machine
  // re-seat or row rebuild must never touch the row it lives in, so the hold
  // checks this before it scrolls or re-windows, and a selection ends the hold.
  const selectionInList = (): boolean => {
    const sel = typeof getSelection === 'function' ? getSelection() : null;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    if (!sel.toString().trim()) return false;
    const node = sel.anchorNode;
    const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
    return !!el && messageListScroll.contains(el);
  };

  // Pass the current anchor id so the landing can mount the divider row when it
  // sits outside the virtual window (see readerLanding.scrollToFirstUnread).
  const scrollToFirstUnread = (): boolean => {
    // W14 unread landing behind the owner's jump (phase 2 step 3). This runs only
    // at settle/open time, after the owner is created; the owner runs the existing
    // landing routine verbatim and returns its result.
    const ok = scrollOwner.jump('unread-landing', () => scrollToFirstUnreadRaw(firstUnreadId));
    if (ok && firstUnreadId !== undefined) {
      holdDivider = true;
      if (holdDividerTimer !== null) clearTimeout(holdDividerTimer);
      holdDividerTimer = setTimeout(endDividerHold, HOLD_DIVIDER_MAX_MS);
    }
    return ok;
  };

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

      // An upward scroll not attributed to a machine write: a real reader scroll
      // (or an untagged writer). readerTrackTop still holds the PREVIOUS offset.
      const readerUp = !machine && top < readerTrackTop - 1;
      if (readerUp) logScrollUpUser(readerTrackTop, top);
      // A CLAMP is not the reader: the content shrank under a view at its end
      // and the browser pulled the offset up to the new end, so it lands AT the
      // end. It must never drop the pin. It did at nearly every open (rows that
      // measure shorter than their estimate shrink the list right after the
      // landing), so a pinned reader was left unpinned and the next resize (the
      // phone keyboard opening, a late image) no longer kept the end.
      // The clamp happened in the box it was laid out in: when the box shrank
      // before this event was delivered (the keyboard opening right as a row
      // measured shorter), it sits at the end of the OLD box height, and the
      // new box reads it as a reader's scroll 320 px up (the pin dropped and
      // the keyboard and the reply were never followed).
      const atSeenBoxEnd = clientH < boxHeightSeen - 1 && height - top - boxHeightSeen <= 1;
      const clamp =
        readerUp && height < readerTrackHeight - 1 && (distToEnd() <= 1 || atSeenBoxEnd);

      // The reader's own scroll ends the divider hold: a real gesture owns the
      // offset from here on. Machine writes (the hold's own re-seat, the landing)
      // are tagged, so they never release it.
      if (!machine) holdDivider = false;

      if (
        openLanding &&
        openToken &&
        !openToken.readerTook &&
        !machine &&
        // Evidence a reader drove it (a finger/pointer down, or a touch/wheel
        // within the last breath): an untagged app write or a browser clamp
        // can look exactly like a reader taking the open landing, and must not.
        scrollOwner.readerInputFresh() &&
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
      // so it can only confirm a pin, never drop one. A reader's UPWARD drag
      // leaves the bottom AT ONCE -- even a few px, before it clears PIN_PX --
      // so a re-pin cannot race its (async, coalesced) scroll event back to the end.
      // A scroll that reached the end of the list as last laid out is at the
      // end, even when this event is read after an arrival grew the list in
      // the same frame (the reader who had just come back to the end lost the
      // pin and never followed the reply), and so is one at the end of the box
      // as last laid out, read after the box shrank (the open landing's scroll
      // event delivered after the keyboard opened).
      if (readerUp && !clamp) pinnedToBottom = false;
      else if (!machine && !clamp) {
        const grewUnseen = listHeightSeen > 0 && height > listHeightSeen + 1;
        pinnedToBottom =
          distToEnd() <= PIN_PX ||
          atSeenBoxEnd ||
          (grewUnseen && top + clientH >= listHeightSeen - PIN_PX);
      } else if (distToEnd() <= PIN_PX) pinnedToBottom = true;
      readerTrackTop = top;
      readerTrackHeight = height;
      readerTrackClientH = clientH;
      listHeightSeen = height;
      boxHeightSeen = clientH;
      sightAfterScroll();
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
    holdDivider = false;
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

  // The ScrollOwner for this message scroller (phase 2). Step 1: it owns nothing
  // yet. It wraps the existing writers and exposes the readers' questions
  // (R7 isMachineScroll, R8 nearBottom, state()) so later steps can reroute them
  // through one place; today each answer is identical to the scattered flags.
  const scrollOwner = createScrollOwner({
    scroll: messageListScroll,
    silentScrollTo,
    scrollToBottom,
    rewindowWrite,
    rewindow: () => rewindowMessages(messageListInner),
    listBanked: () => messageListBanked(messageListInner),
    isMachineScroll: isMachineTop,
    modelTop: () => messageModelTop(messageListInner),
    nearBottomPx: () => Math.max(OVERLAY_SCROLL_NEAR_PX, messageListScroll.clientHeight / 3),
    isPinned: () => pinnedToBottom,
    distToEnd,
    reseatDivider,
    bankShift: (d) => bankMessageShift(messageListInner, d),
    isLanding: () => openLanding,
    isDividerHeld: () => holdDivider,
    onTeardown: deps.onTeardown
  });

  // The owner is the message re-window's one writer (phase 3 step 4): the
  // re-window asks it whether a reader is driving (then it banks, never writes),
  // whether the end is pinned, and hands it the write.
  setMessageScrollOwner(messageListInner, {
    driving: scrollOwner.driving,
    pinned: scrollOwner.pinned,
    dividerHeld: () => holdDivider,
    write: scrollOwner.rewindowWrite
  });

  const historyPager = installHistoryPager({
    container: messageListScroll,
    render: deps.render,
    ownsOpening: openOwned,
    isAnchoring: () => anchorHopPending,
    // R7 through the ScrollOwner: the pager asks the owner whether an upward move
    // was a machine re-seat and whether the view is at the top of the loaded
    // history, never reading the mounted rows itself.
    isMachineScroll: (top) => scrollOwner.isMachineScroll(top),
    atTop: scrollOwner.atTop
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
      holdDivider = false;
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
      listHeightSeen = messageListScroll.scrollHeight;
      boxHeightSeen = messageListScroll.clientHeight;

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
          ownerState: string;
        };
      }
    ).__cycScrollDiag = () => ({
      bracketMoves,
      machineTop: machineTopOf(messageListScroll),
      landingOwed: openLanding,
      readerTook: !!openToken?.readerTook,
      scrolledUp: !!openToken?.readerTook,
      pinned: pinnedToBottom,
      // Phase 2 step 1: the ScrollOwner's derived state (informational; nothing
      // changes behaviour off it yet).
      ownerState: scrollOwner.state()
    });
    // Whether the unread-divider hold is still active. The hold must end at the
    // first user interaction and after a short bounded window (fix-sync FIX 6),
    // so a test can arm it and assert each release path.
    (window as never as {__cycDividerHeld: () => boolean}).__cycDividerHeld = () => holdDivider;
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
    // R8 (storeBindings): is the reader near the end so a live reply keeps the
    // view pinned? Answered by the ScrollOwner (phase 2 step 2), tracked off the
    // scroll event with the same formula and the same no-measure-in-notify
    // property storeBindings had locally.
    nearBottom: scrollOwner.nearBottom,
    recomputeNearBottom: scrollOwner.recomputeNearBottom,
    // The one "what has been on screen" answer every read path sights through.
    newestOnScreen,
    bracketMessageRender,
    scrollToBottom,
    releaseBottomPin,
    // A row arrived for a reader who was near the end (storeBindings, R8): the
    // owner re-pins unless a reader is driving (phase 3 step 5).
    followArrival: scrollOwner.followArrival,
    // A deliberate move owned for its whole duration (the jump-to-message
    // travel); it yields the moment a finger lands.
    ownerJump: scrollOwner.jump,
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
