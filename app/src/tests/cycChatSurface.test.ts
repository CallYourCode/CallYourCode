import {beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycSession} from '../types';
const fake = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  notifyKey: 'host:p1'
}));
const mkEl = (cls = '') => {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  return el;
};
vi.mock('../engine/store', () => ({
  get: (id: string) => fake.sessions.get(id),
  attach: vi.fn(),
  notifyKey: () => fake.notifyKey,
  onReplayed: () => () => {},
  canOlder: () => false,
  loadOlder: vi.fn(async () => 0),
  overlayOn: () => false
}));
vi.mock('../components/domHelpers', () => ({
  h: (_tag: string, cls: string) => mkEl(cls)
}));
vi.mock('../components/iconGlyphs', () => ({
  makeIcon: () => mkEl('icon')
}));
vi.mock('../features/chat/surface/messageList', () => ({
  renderMessages: vi.fn(),
  clearMessages: vi.fn(),
  attachStickyDates: () => ({refresh: vi.fn()}),
  extendMessageWindow: () => false,
  messageWindowFrom: () => 0
}));
vi.mock('../shared/smoothScroll', () => ({smoothScrollTo: vi.fn()}));
vi.mock('../features/chat/scrolling', () => ({trackComposerHeight: () => () => {}}));
vi.mock('../shared/capabilities', () => ({
  touchCapable: false,
  prefersMotion: () => false
}));
vi.mock('../components/widgets', () => ({toast: vi.fn()}));
vi.mock('../audio/speaker', () => ({
  speaker: {
    state: {state: 'idle', sessionId: null as string | null},
    stopAll: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}));
vi.mock('../audio/pipeline', () => ({
  pipeline: {handsFreeSessionId: '', enableHandsFree: vi.fn(), disableHandsFree: vi.fn()}
}));
vi.mock('../speechGate', () => ({
  ensureMic: vi.fn(async () => {}),
  mayStartSpeech: () => true
}));
vi.mock('../engine/pushNotify', () => ({
  clearNotifications: vi.fn(async () => {}),
  reportRead: vi.fn(async () => {})
}));
vi.mock('../sessionSelectors', () => ({
  active: () => (appStateRef.activeId ? fake.sessions.get(appStateRef.activeId) : null),
  allSessions: () => [...fake.sessions.values()],
  selectTabFor: () => 'e1#t1',
  isDead: () => false
}));
import {createChatSurface, type ChatSurfaceDeps} from '../features/chat/surface/chatSurface';
import {sessionState, dataState} from '../sessionState';
import * as engine from '../engine/store';
import {clearNotifications, reportRead} from '../engine/pushNotify';
const appStateRef = sessionState;
function mkSession(id: string, over: Record<string, unknown> = {}) {
  const s = {
    id,
    name: id,
    cwd: '/x',
    unread: 3,
    muted: false,
    thinking: false,
    alive: true,
    messages: [] as unknown[],
    ...over
  };
  fake.sessions.set(id, s);
  return s as unknown as CycSession;
}
function mk(over: Partial<ChatSurfaceDeps> = {}) {
  const deps: ChatSurfaceDeps = {
    onTeardown: () => {},
    render: vi.fn(),
    chatEl: mkEl('cyc-thread'),
    backToList: vi.fn(),
    jumpTo: vi.fn(),
    jumpTarget: (): string | null => null,
    markSeen: vi.fn(),
    heardTsOf: () => 0,
    readMarkerOf: () => undefined,
    reportViewedThrough: vi.fn(),
    play: vi.fn(),
    suppressAutoSpeak: () => false,
    clearSuppressAutoSpeak: vi.fn(),
    isChatViewOpen: () => true,
    draftOwner: (): string | null => null,
    saveDraft: vi.fn(),
    loadDraft: vi.fn(),
    rebuildToolbarSettings: vi.fn(),
    restorePending: new Set(),
    agentsBarReset: vi.fn(),
    releaseMicIfIdle: vi.fn(),
    composerFocus: vi.fn(),
    setView: vi.fn(),
    armSettleResort: vi.fn(),
    ...over
  };
  return {deps, cs: createChatSurface(deps)};
}
beforeEach(() => {
  fake.sessions.clear();
  dataState.mode = 'live';
  sessionState.activeId = null;
  sessionState.tabSelection.clear();
  sessionState.chatConversationMode.clear();
  localStorage.clear();
  vi.clearAllMocks();
});
describe('openChat, fresh open', () => {
  test('takes the landing, hands the draft over, attaches, zeroes unread, takes the banner down', () => {
    const s = mkSession('s1');
    const after = vi.fn();
    const {cs, deps} = mk();
    expect(cs.landingOwed()).toBe(false);
    cs.openChat('s1', after);
    expect(sessionState.activeId).toBe('s1');
    expect(deps.saveDraft).toHaveBeenCalled();
    expect(deps.loadDraft).toHaveBeenCalledWith('s1');
    expect(cs.openPaintIsPending()).toBe(true);
    expect(cs.openPaintStartedAt()).toBeGreaterThan(0);
    expect((s as {unread: number}).unread).toBe(0);
    expect(engine.attach).toHaveBeenCalledWith('s1');
    expect(sessionState.tabSelection.get('e1#t1')).toBe('s1');
    expect(localStorage.getItem('cyc-engaged')).toBe('s1');
    expect(deps.setView).toHaveBeenCalledWith('chat');
    expect(deps.render).toHaveBeenCalled();
    expect(clearNotifications).toHaveBeenCalledWith('host:p1');
    expect(reportRead).toHaveBeenCalledWith('host:p1');
    expect(after).toHaveBeenCalledTimes(1);
  });
  test('switching chats marks the previous one seen', () => {
    mkSession('s1');
    mkSession('s2');
    const {cs, deps} = mk({draftOwner: () => 's1'});
    sessionState.activeId = 's1';
    cs.openChat('s2');
    expect(deps.markSeen).toHaveBeenCalledWith('s1');
    expect(deps.rebuildToolbarSettings).toHaveBeenCalled();
  });
  test('an unknown session opens nothing', () => {
    const {cs, deps} = mk();
    cs.openChat('nope');
    expect(sessionState.activeId).toBeNull();
    expect(deps.setView).not.toHaveBeenCalled();
  });
});
describe('openChat, refocus', () => {
  test('arriving at the open chat re-arms speech, settles in place and keeps the view', () => {
    mkSession('s1');
    const {cs, deps} = mk({draftOwner: () => 's1'});
    sessionState.activeId = 's1';
    const after = vi.fn();
    cs.openChat('s1', after);
    expect(deps.clearSuppressAutoSpeak).toHaveBeenCalled();
    expect(deps.setView).not.toHaveBeenCalled();
    expect(deps.saveDraft).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
function wheel(el: EventTarget, deltaX: number, deltaY = 0) {
  const e = new Event('wheel', {bubbles: true, cancelable: true});
  Object.assign(e, {deltaX, deltaY});
  el.dispatchEvent(e);
  return e;
}
describe('chat wheel paging (local gesture)', () => {
  test('a committed horizontal wheel pages forward to the next chat', () => {
    mkSession('s1');
    const jumpTo = vi.fn();
    const {cs} = mk({jumpTo, jumpTarget: () => 'next'});
    wheel(cs.messageListScroll, 100);
    expect(jumpTo).toHaveBeenCalledWith(1, 'wheel', expect.anything());
  });
  test('no forward target -> the wheel does not page', () => {
    mkSession('s1');
    const jumpTo = vi.fn();
    const {cs} = mk({jumpTo, jumpTarget: (): string | null => null});
    wheel(cs.messageListScroll, 100);
    expect(jumpTo).not.toHaveBeenCalled();
  });
  test('a vertical wheel is left to scroll, not paged', () => {
    mkSession('s1');
    const jumpTo = vi.fn();
    const {cs} = mk({jumpTo, jumpTarget: () => 'next'});
    wheel(cs.messageListScroll, 0, 100);
    expect(jumpTo).not.toHaveBeenCalled();
  });
});
describe('named accessors', () => {
  test('noteHeardMarked moves the frozen snapshot forward for the active chat only', () => {
    const s = mkSession('s1', {unread: 1});
    const {cs} = mk({heardTsOf: () => 100});
    cs.openChat('s1');
    expect(cs.firstUnread()).toBeUndefined();
    cs.noteHeardMarked('other', {ts: 500});
    cs.noteHeardMarked('s1', {ts: 500});
    expect(s).toBeTruthy();
  });
  test('newBelow count and clear', () => {
    const {cs} = mk();
    expect(cs.newBelowCount()).toBe(0);
    cs.setNewBelow(4);
    expect(cs.newBelowCount()).toBe(4);
    cs.setNewBelow(0);
    expect(cs.newBelowCount()).toBe(0);
  });
  // grep token: `column align`. A classic scrollbar takes space at the inline
  // end only; the column centres in the remainder and lands half a scrollbar
  // toward the inline start of the composer unless the inline start mirrors it.
  test('the list scroller mirrors its scrollbar width as inline-start padding', () => {
    // Every observer that watches the scroller (the surface has more than one).
    const watchers = new Map<Element, Array<() => void>>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
        }
        observe(el: Element) {
          watchers.set(el, [...(watchers.get(el) ?? []), this.cb]);
        }
        disconnect() {}
      }
    );
    try {
      const {cs} = mk();
      const scroll = cs.messageListScroll;
      expect(watchers.has(scroll)).toBe(true);
      Object.defineProperty(scroll, 'offsetWidth', {get: () => 740, configurable: true});
      Object.defineProperty(scroll, 'clientWidth', {get: () => 730, configurable: true});
      for (const cb of watchers.get(scroll)!) cb();
      expect(scroll.style.paddingInlineStart).toBe('10px');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('mountChrome hangs the go-down button and audio chip off the composer box', () => {
    const {cs} = mk();
    const box = mkEl('cyc-composer-box');
    const {audioJumpChip} = cs.mountChrome({composerBox: box, openPlayingMessage: vi.fn()});
    expect(box.querySelector('.cyc-jump-latest')).toBeTruthy();
    expect(box.contains(audioJumpChip)).toBe(true);
  });
});

// PINNED TO THE BOTTOM: growth that lands after a pin with no store notify
// (image bytes, the agents bar or a header row reserving more top pad) is
// caught by the list's ResizeObserver and re-pinned; a reader who scrolled up
// is never moved by content growth, only carried across a top pad change.
// grep token: `scroll pin`.
describe('pinned to the bottom across late growth', () => {
  type Box = {scrollHeight: number; clientHeight: number; padTop: number};
  function geometry(cs: ReturnType<typeof mk>['cs'], box: Box) {
    const scroll = cs.messageListScroll;
    const pad = cs.messageListEl.querySelector('.cyc-message-list-pad-top') as HTMLElement;
    let top = 0;
    const maxTop = () => Math.max(0, box.scrollHeight - box.clientHeight);
    Object.defineProperty(scroll, 'scrollHeight', {
      get: () => box.scrollHeight,
      configurable: true
    });
    Object.defineProperty(scroll, 'clientHeight', {
      get: () => box.clientHeight,
      configurable: true
    });
    Object.defineProperty(scroll, 'scrollTop', {
      get: () => top,
      set: (v: number) => {
        top = Math.min(maxTop(), Math.max(0, v));
      },
      configurable: true
    });
    Object.defineProperty(pad, 'offsetHeight', {get: () => box.padTop, configurable: true});
    // A row so the surface counts as painted.
    cs.messageListInner.append(mkEl('cyc-message'));
    return {
      top: () => top,
      // The reader's own scroll: a top the machine did not write.
      readerScrollTo: (v: number) => {
        top = v;
        scroll.dispatchEvent(new Event('scroll'));
      }
    };
  }
  let fire: () => void = () => {};
  beforeEach(() => {
    fire = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
          fire = cb;
        }
        observe() {}
        disconnect() {}
      }
    );
  });
  test('content growth after a pin re-pins the view', () => {
    const box: Box = {scrollHeight: 5000, clientHeight: 800, padTop: 66};
    const {cs} = mk();
    const g = geometry(cs, box);
    cs.scrollToBottom();
    expect(g.top()).toBe(4200);
    box.scrollHeight = 5100;
    fire();
    expect(g.top()).toBe(4300);
  });
  test('the top pad growing after a pin re-pins the view', () => {
    const box: Box = {scrollHeight: 5000, clientHeight: 800, padTop: 66};
    const {cs} = mk();
    const g = geometry(cs, box);
    cs.scrollToBottom();
    box.padTop = 118;
    box.scrollHeight = 5052;
    fire();
    expect(g.top()).toBe(4252);
  });
  test('a reader who scrolled up is not moved by content growth', () => {
    const box: Box = {scrollHeight: 5000, clientHeight: 800, padTop: 66};
    const {cs} = mk();
    const g = geometry(cs, box);
    cs.scrollToBottom();
    g.readerScrollTo(2000);
    box.scrollHeight = 5100;
    fire();
    expect(g.top()).toBe(2000);
  });
  test('a reader who scrolled up is carried across a top pad change so the rows stay put', () => {
    const box: Box = {scrollHeight: 5000, clientHeight: 800, padTop: 66};
    const {cs} = mk();
    const g = geometry(cs, box);
    cs.scrollToBottom();
    g.readerScrollTo(2000);
    box.padTop = 118;
    box.scrollHeight = 5052;
    fire();
    expect(g.top()).toBe(2052);
    box.padTop = 66;
    box.scrollHeight = 5000;
    fire();
    expect(g.top()).toBe(2000);
  });
  test('a reader who came back to the bottom is pinned again', () => {
    const box: Box = {scrollHeight: 5000, clientHeight: 800, padTop: 66};
    const {cs} = mk();
    const g = geometry(cs, box);
    cs.scrollToBottom();
    g.readerScrollTo(2000);
    g.readerScrollTo(4200);
    box.scrollHeight = 5100;
    fire();
    expect(g.top()).toBe(4300);
  });
});
