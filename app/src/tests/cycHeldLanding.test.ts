import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycSession} from '../types';

// heldbug: open agent A, message it, go to B, A replies, tap back to A with one
// unread -> the view landed at a random point far from the unread anchor. The
// phone dismisses its keyboard by animating the inset down in steps (cyc:kbinset
// 240/160/80/0); each step runs the clearance settle() in features/chat/
// scrolling.ts, whose compensating scrollTop write was NOT tagged as a machine
// scroll. Firing inside the next chat's open-landing window, the surface's scroll
// listener read the decreasing top as a reader taking the scroll and set
// openToken.readerTook, so the landing skipped to a meaningless leftover offset
// and logged target=held. The fix tags every programmatic write on the message
// scroller through the shared owner AND demands real input evidence before the
// readerTook guard concludes a reader is driving. These tests use the REAL
// scrolling.ts wired to the REAL chat surface over one shared scroller.

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
// The clearance engine (scrolling.ts) is REAL here: its settle() write is the
// event under test.
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
    resume: vi.fn(),
    pending: () => new Set<string>()
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
  active: () => (sessionState.activeId ? fake.sessions.get(sessionState.activeId) : null),
  allSessions: () => [...fake.sessions.values()],
  selectTabFor: () => 'e1#t1',
  isDead: () => false
}));
// Spy cyclog so a spec can read the scroll.landing target the landing emits;
// every other logging export stays real.
vi.mock('../shared/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/logging')>();
  return {...actual, cyclog: vi.fn()};
});

import {createChatSurface, type ChatSurfaceDeps} from '../features/chat/surface/chatSurface';
import {trackKeyboardInset} from '../features/chat/scrolling';
import {sessionState, dataState} from '../sessionState';
import {cyclog} from '../shared/logging';

function mkSession(id: string, over: Record<string, unknown> = {}) {
  const s = {
    id,
    name: id,
    cwd: '/x',
    unread: 1,
    muted: false,
    thinking: false,
    alive: true,
    heardTs: 0,
    historyPending: true,
    messages: [{id: 'm1', role: 'claude', ts: 1000, text: 'hi', mid: 'mid1'}] as unknown[],
    ...over
  };
  fake.sessions.set(id, s);
  return s as unknown as CycSession & {historyPending: boolean; unread: number};
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

const SCROLL_HEIGHT = 20000;
const CLIENT_HEIGHT = 800;

// Wire the real clearance engine onto the surface's own scroller: append the
// message list into the thread, add a composer bar, and bind trackKeyboardInset
// to it so cyc:kbinset drives real settle() writes on the shared scroller.
function wire(cs: ReturnType<typeof mk>['cs'], chatEl: HTMLElement) {
  chatEl.append(cs.messageListEl);
  const composer = mkEl('cyc-composer cyc-composer-main');
  const bar = mkEl('cyc-composer-bar');
  composer.append(bar);
  chatEl.append(composer);
  document.body.append(chatEl);
  const scroll = cs.messageListScroll;
  Object.defineProperty(scroll, 'scrollHeight', {value: SCROLL_HEIGHT, configurable: true});
  Object.defineProperty(scroll, 'clientHeight', {value: CLIENT_HEIGHT, configurable: true});
  const teardown = trackKeyboardInset(bar);
  return {scroll, teardown};
}

function kbinset(px: number) {
  window.dispatchEvent(new CustomEvent('cyc:kbinset', {detail: px}));
}
function fireScroll(scroll: HTMLElement) {
  scroll.dispatchEvent(new Event('scroll'));
}
function landingTarget(): string | undefined {
  const calls = (cyclog as unknown as {mock: {calls: unknown[][]}}).mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === 'scroll.landing') return (calls[i][1] as {target?: string}).target;
  }
  return undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  fake.sessions.clear();
  dataState.mode = 'live';
  sessionState.activeId = null;
  sessionState.tabSelection.clear();
  sessionState.chatConversationMode.clear();
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('heldbug: keyboard-dismissal steps must not steal the open landing', () => {
  test('a stepped kbinset shrink during the open window still lands at the unread anchor', () => {
    const s = mkSession('s1');
    const {cs, deps} = mk();
    const {scroll, teardown} = wire(cs, deps.chatEl);

    // The keyboard was open in the previous chat: apply the full inset near the
    // bottom so the clearance total is a non-zero margin ready to shrink.
    scroll.scrollTop = 19200;
    kbinset(240);
    expect(scroll.scrollTop).toBe(19440);

    // Tap into the next chat. Its landing is deferred (historyPending) so the
    // open-landing window stays open while the dismissal fires.
    cs.openChat('s1');
    expect(cs.landingOwed()).toBe(true);
    expect(cs.readerTook()).toBe(false);

    // The keyboard finishes dismissing in steps; each settle() write shrinks the
    // scroller and the browser fires a scroll event inside the open window.
    for (const px of [160, 80, 0]) {
      kbinset(px);
      fireScroll(scroll);
    }

    // Replay arrives: run the landing. Before the fix, the dismissal writes have
    // set readerTook and the landing logs held; after the fix the writes are
    // tagged machine (and lack input evidence) so the landing reaches unread.
    s.historyPending = false;
    cs.settleNow('s1');

    expect(cs.readerTook()).toBe(false);
    expect(cs.firstUnread()).toBe('m1');
    expect(landingTarget()).toBe('unread');

    teardown();
  });

  test('a genuine reader scroll during the open window still sets readerTook', () => {
    const {cs, deps} = mk();
    mkSession('s1');
    const {scroll, teardown} = wire(cs, deps.chatEl);
    scroll.scrollTop = 19440;

    cs.openChat('s1');
    expect(cs.landingOwed()).toBe(true);

    // Real input evidence: a finger drag on the scroller, then a decreasing top
    // the machine never wrote. The anti-yank behavior must survive the fix.
    const touch = new Event('touchmove');
    Object.assign(touch, {touches: [{clientY: 10}]});
    scroll.dispatchEvent(touch);
    scroll.scrollTop = 19000;
    fireScroll(scroll);

    expect(cs.readerTook()).toBe(true);

    teardown();
  });
});
