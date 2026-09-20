import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycSession} from '../types';

// A JUMP-TO-MESSAGE MUST NOT ADD PADDING UNDER THE COMPOSER (same class as the
// go-to-bottom bug locked by cycGoDownPadding.test.ts): jumping to a quoted or
// replied-to message scrolled via scrollIntoView, and scrollIntoView scrolls
// EVERY scrollable ancestor box, overflow:hidden ones included. #cyc-columns
// (overflow hidden) overflows by the message list's pane-gap bleed at phone
// widths, so the jump also scrolled the columns box by that overflow; with no
// scrollbar there nothing could undo it, and the whole layout sat shifted up
// with a stuck background band under the composer.
//
// The contract locked here, against the REAL jumpToMessage and the REAL
// smoothScroll module: a jump scrolls ONLY the message scroller, seats the
// target message visibly (centered), and leaves every ancestor box's scrollTop
// at 0. The jsdom harness implements the browser's scroll entry points the way
// Chromium does -- scrollIntoView walks and scrolls the scrollable ancestor
// chain, scrollTo moves only its own element -- so the old scrollIntoView path
// fails these assertions and the container-only path passes them.
// grep token: `jump message padding`.

const fake = {active: null as CycSession | null, held: true};
vi.mock('../engine/store', () => ({
  pluginsOf: (): never[] => [],
  ensureMessageHeld: vi.fn(async () => fake.held),
  onReplayed: () => (): void => {},
  get: (): null => null,
  retrySend: vi.fn()
}));
vi.mock('../sessionSelectors', () => ({active: () => fake.active}));
vi.mock('../features/chat/surface/messageList', () => ({
  extendMessageWindow: vi.fn(() => false)
}));
vi.mock('../components/widgets', () => ({toast: vi.fn()}));

import {createMessageTravel, type MessageTravelDeps} from '../features/chat/surface/messageTravel';

const SCROLLER_CLIENT = 852;
const SCROLLER_CONTENT = 6019;
const COLUMNS_OVERFLOW = 12; // the pane-gap bleed the live repro measured
const MESSAGE_TOP = 3000; // the target's content-coordinate top
const MESSAGE_HEIGHT = 40;

type Geometry = {scrollHeight: number; clientHeight: number};

function setGeometry(el: HTMLElement, geo: Geometry) {
  Object.defineProperty(el, 'scrollHeight', {get: () => geo.scrollHeight, configurable: true});
  Object.defineProperty(el, 'clientHeight', {get: () => geo.clientHeight, configurable: true});
}

function setRect(el: HTMLElement, rect: {top: number; height: number}) {
  el.getBoundingClientRect = () => ({top: rect.top, height: rect.height}) as DOMRect;
}

// Chromium's programmatic scroll surface, faithfully enough for this contract:
// - el.scrollTo scrolls el and nothing else (clamped to its own range);
// - el.scrollIntoView walks EVERY scrollable ancestor (overflow auto/scroll/
//   hidden alike) and aligns the target inside each, so the overflow:hidden
//   columns box gets scrolled by its bleed too.
function installScrollSurface() {
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

  Element.prototype.scrollIntoView = function (
    this: Element,
    arg?: boolean | ScrollIntoViewOptions
  ) {
    const target = this as HTMLElement;
    const block = typeof arg === 'object' && arg?.block ? arg.block : 'start';
    const targetBox = target.getBoundingClientRect();
    let el = target.parentElement;
    while (el) {
      if (el.scrollHeight > el.clientHeight) {
        const box = el.getBoundingClientRect();
        const contentTop = targetBox.top - box.top + el.scrollTop;
        const aligned =
          block === 'center'
            ? contentTop - (el.clientHeight - targetBox.height) / 2
            : block === 'end'
              ? contentTop + targetBox.height - el.clientHeight
              : contentTop;
        el.scrollTop = clampTo(el, aligned);
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
  const inner = document.createElement('div');
  inner.className = 'cyc-message-list';
  const message = document.createElement('div');
  message.className = 'cyc-message';
  message.dataset.mid = '7';
  inner.append(message);
  scroll.append(inner);
  chat.append(scroll);
  columns.append(chat);
  document.body.append(columns);

  // The scroller sits at viewport top, scrolled to 0: the target's rect top IS
  // its content-coordinate top. The columns box overflows by the pane-gap
  // bleed, as measured live.
  setGeometry(scroll, {scrollHeight: SCROLLER_CONTENT, clientHeight: SCROLLER_CLIENT});
  setGeometry(columns, {
    scrollHeight: SCROLLER_CLIENT + COLUMNS_OVERFLOW,
    clientHeight: SCROLLER_CLIENT
  });
  setRect(scroll, {top: 0, height: SCROLLER_CLIENT});
  setRect(columns, {top: 0, height: SCROLLER_CLIENT});
  setRect(message, {top: MESSAGE_TOP, height: MESSAGE_HEIGHT});
  return {columns, chat, scroll, inner, message};
}

function mkTravel(inner: HTMLElement, scroll: HTMLElement, chat: HTMLElement) {
  const deps: MessageTravelDeps = {
    composer: {
      el: document.createElement('div'),
      addQuote: vi.fn(),
      setReplyTo: vi.fn(),
      focus: vi.fn()
    },
    messageListInner: inner,
    scroller: () => scroll,
    chatEl: chat,
    renderEarlier: vi.fn(),
    render: vi.fn(),
    openChat: vi.fn(),
    isChatViewOpen: () => true
  };
  return createMessageTravel(deps);
}

describe('jump message padding', () => {
  const originalMatchMedia = window.matchMedia;
  const originalScrollTo = Element.prototype.scrollTo;
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    // Reduced motion: the jump scrolls instantly, no settle timer.
    window.matchMedia = vi.fn().mockReturnValue({matches: true}) as never;
    fake.active = {
      id: 's1',
      name: 'p',
      cwd: '/x',
      unread: 0,
      muted: false,
      thinking: false,
      alive: true,
      messages: [{id: '7', role: 'claude', kind: 'text', text: 'hello there', ts: 500}]
    } as unknown as CycSession;
    fake.held = true;
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Element.prototype.scrollTo = originalScrollTo;
    Element.prototype.scrollIntoView = originalScrollIntoView;
    document.body.innerHTML = '';
  });

  test('a jump never scrolls an ancestor box and seats the target centered', () => {
    const {columns, chat, scroll, inner, message} = buildThread();
    installScrollSurface();
    const travel = mkTravel(inner, scroll, chat);

    expect(travel.jumpToMessage(500, 'claude')).toBe(true);

    // The layout must not shift: every ancestor of the target above the
    // scroller stays exactly where it was (the columns box most of all).
    expect(columns.scrollTop).toBe(0);
    expect(chat.scrollTop).toBe(0);
    expect(inner.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);

    // ...and the scroller alone moved, seating the target centered.
    const centered = MESSAGE_TOP - (SCROLLER_CLIENT - MESSAGE_HEIGHT) / 2;
    expect(scroll.scrollTop).toBe(centered);

    // The target is fully visible inside the scroller's viewport.
    expect(scroll.scrollTop).toBeLessThanOrEqual(MESSAGE_TOP);
    expect(MESSAGE_TOP + MESSAGE_HEIGHT).toBeLessThanOrEqual(scroll.scrollTop + SCROLLER_CLIENT);
  });
});
