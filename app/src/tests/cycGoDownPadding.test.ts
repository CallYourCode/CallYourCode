import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createChatChrome} from '../features/chat/surface/chatChrome';

// THE GO-TO-BOTTOM ARROW MUST NOT ADD PADDING UNDER THE COMPOSER (owner report,
// laptop screenshot, 2026-09-05): hitting the arrow left a stuck band of
// background below the input box.
//
// Confirmed cause (live Chromium, e2e/offline/godown-bottom-land.spec.ts): the
// handler scrolled via scrollIntoView, and scrollIntoView scrolls EVERY
// scrollable ancestor box, overflow:hidden ones included. #cyc-columns
// (overflow hidden) overflows by the message list's pane-gap bleed at phone
// widths, so the click also scrolled the columns box by that overflow; with no
// scrollbar there nothing could undo it, and the whole layout sat shifted up
// with a background band under the composer. A second wrongness of the same
// call: scrollIntoView aligns the pad-bottom spacer's BORDER box, so with a
// clearance margin on the spacer (keyboard open) the landing stopped short of
// the true bottom by the margin.
//
// The contract locked here, against the REAL click handler: the go-to-bottom
// click scrolls ONLY the message scroller, and lands it on the exact end of its
// content (scrollHeight - clientHeight), margin included. The jsdom harness
// implements the browser's scroll entry points the way Chromium does --
// scrollIntoView walks and scrolls the scrollable ancestor chain, scrollTo
// moves only its own element -- so the old handler fails these assertions and
// the fixed one passes them.
// grep token: `go down padding`.

const SCROLLER_CLIENT = 852;
const COLUMNS_OVERFLOW = 12; // the pane-gap bleed the live repro measured

type Geometry = {scrollHeight: number; clientHeight: number};

function setGeometry(el: HTMLElement, geo: Geometry) {
  Object.defineProperty(el, 'scrollHeight', {get: () => geo.scrollHeight, configurable: true});
  Object.defineProperty(el, 'clientHeight', {get: () => geo.clientHeight, configurable: true});
}

// Chromium's programmatic scroll surface, faithfully enough for this contract:
// - el.scrollTo scrolls el and nothing else (clamped to its own range);
// - el.scrollIntoView({block:'end'}) aligns el's border-box end inside EVERY
//   scrollable ancestor (overflow auto/scroll/hidden alike), walking up the
//   chain -- the message scroller AND the overflow:hidden columns box.
function installScrollSurface(margins: Map<HTMLElement, number>) {
  const clampTo = (el: HTMLElement, top: number) =>
    Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));

  Element.prototype.scrollTo = function (
    this: Element,
    options?: ScrollToOptions | number,
    y?: number
  ) {
    const el = this as HTMLElement;
    const top = typeof options === 'number' ? (y ?? 0) : (options?.top ?? el.scrollTop);
    el.scrollTop = clampTo(el, top);
    el.dispatchEvent(new Event('scroll'));
  } as typeof Element.prototype.scrollTo;

  Element.prototype.scrollIntoView = function (this: Element) {
    // Border-box end of the target within each ancestor's content: the content
    // end minus the target's margin-bottom (margins sit outside the border box).
    const target = this as HTMLElement;
    let el = target.parentElement;
    while (el) {
      if (el.scrollHeight > el.clientHeight) {
        const borderEnd = el.scrollHeight - (margins.get(target) ?? 0);
        el.scrollTop = clampTo(el, borderEnd - el.clientHeight);
        el.dispatchEvent(new Event('scroll'));
      }
      el = el.parentElement;
    }
  };
}

function buildThread() {
  document.body.innerHTML = '';
  const columns = document.createElement('div');
  columns.id = 'cyc-columns';
  columns.style.overflow = 'hidden';
  const chat = document.createElement('div');
  chat.className = 'cyc-thread';
  const scroll = document.createElement('div');
  scroll.className = 'cyc-message-list-scroll';
  const padBottom = document.createElement('div');
  padBottom.className = 'cyc-message-list-pad-bottom';
  scroll.append(padBottom);
  const composerBox = document.createElement('div');
  composerBox.className = 'cyc-composer-box';
  chat.append(scroll, composerBox);
  columns.append(chat);
  document.body.append(columns);
  return {columns, chat, scroll, padBottom, composerBox};
}

function mountChrome(chat: HTMLElement, scroll: HTMLElement, composerBox: HTMLElement) {
  const chrome = createChatChrome({
    chat,
    scroll,
    nearBottomPx: 100,
    closeSettleGrace: () => {}
  });
  chrome.mount(composerBox, () => {});
  return composerBox.querySelector('.cyc-jump-latest') as HTMLButtonElement;
}

describe('go down padding', () => {
  const originalMatchMedia = window.matchMedia;
  const originalScrollTo = Element.prototype.scrollTo;
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    // Reduced motion: the click path scrolls instantly, no settle timer.
    window.matchMedia = vi.fn().mockReturnValue({matches: true}) as never;
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Element.prototype.scrollTo = originalScrollTo;
    Element.prototype.scrollIntoView = originalScrollIntoView;
    document.body.innerHTML = '';
  });

  test('the click never scrolls an ancestor box (no band under the composer)', () => {
    const {columns, chat, scroll, padBottom, composerBox} = buildThread();
    const margins = new Map<HTMLElement, number>();
    installScrollSurface(margins);
    setGeometry(scroll, {scrollHeight: 6019, clientHeight: SCROLLER_CLIENT});
    // The columns box overflows by the pane-gap bleed, as measured live.
    setGeometry(columns, {
      scrollHeight: SCROLLER_CLIENT + COLUMNS_OVERFLOW,
      clientHeight: SCROLLER_CLIENT
    });
    margins.set(padBottom, 0);

    const button = mountChrome(chat, scroll, composerBox);
    scroll.scrollTop = 3000; // scrolled up into history
    scroll.dispatchEvent(new Event('scroll'));

    button.click();

    // The layout must not shift: the columns box stays where it was...
    expect(columns.scrollTop).toBe(0);
    // ...and the message scroller lands on the exact end of its content.
    expect(scroll.scrollTop).toBe(6019 - SCROLLER_CLIENT);
  });

  test('with a clearance margin on the spacer (keyboard open) the landing is the true bottom', () => {
    const {columns, chat, scroll, padBottom, composerBox} = buildThread();
    const margins = new Map<HTMLElement, number>();
    installScrollSurface(margins);
    const KB = 300;
    // The spacer carries the keyboard claim as margin-bottom: the content end
    // is 300px past the spacer's border box.
    setGeometry(scroll, {scrollHeight: 6019 + KB, clientHeight: SCROLLER_CLIENT});
    setGeometry(columns, {scrollHeight: SCROLLER_CLIENT, clientHeight: SCROLLER_CLIENT});
    padBottom.style.marginBottom = KB + 'px';
    margins.set(padBottom, KB);

    const button = mountChrome(chat, scroll, composerBox);
    scroll.scrollTop = 3000;
    scroll.dispatchEvent(new Event('scroll'));

    button.click();

    // The true bottom, margin included: distanceToEnd 0, not KB short.
    const distToEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    expect(distToEnd).toBe(0);
  });
});
