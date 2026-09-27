import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycSession} from '../types';

// FIX 6: after an unread landing the divider hold re-seated the divider on every
// content resize; if a row above the fold kept reflowing it oscillated -- a
// machine scroll every couple of seconds that wiped the owner's text selection.
// The hold must now END at the first user interaction of ANY kind (pointerdown,
// keydown, wheel, touch, or a non-empty selection) and, failing that, after a
// short bounded window, and it must never re-seat over a live selection.

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
vi.mock('../components/domHelpers', () => ({h: (_t: string, cls: string) => mkEl(cls)}));
vi.mock('../components/iconGlyphs', () => ({makeIcon: () => mkEl('icon')}));
vi.mock('../features/chat/surface/messageList', () => ({
  renderMessages: vi.fn(),
  clearMessages: vi.fn(),
  attachStickyDates: () => ({refresh: vi.fn()}),
  scrollMessageIntoView: vi.fn(() => false),
  repaintMessagesAtScroll: vi.fn(),
  rewindowMessages: vi.fn(),
  messageVisibleRangeKey: () => '0:0',
  setMessageWindowHook: vi.fn()
}));
vi.mock('../shared/smoothScroll', () => ({smoothScrollTo: vi.fn()}));
vi.mock('../features/chat/scrolling', () => ({
  trackComposerHeight: () => () => {},
  trackKeyboardInset: () => () => {}
}));
vi.mock('../shared/capabilities', () => ({touchCapable: false, prefersMotion: () => false}));
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
vi.mock('../speechGate', () => ({ensureMic: vi.fn(async () => {}), mayStartSpeech: () => true}));
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

import {createChatSurface, type ChatSurfaceDeps} from '../features/chat/surface/chatSurface';
import {sessionState, dataState} from '../sessionState';

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

const held = () =>
  (window as never as {__cycDividerHeld?: () => boolean}).__cycDividerHeld?.() ?? false;

// Arm the divider hold: open the chat, settle so the first-unread anchor is
// captured, mount a divider row, then run the landing (which sets the hold).
function armHold(cs: ReturnType<typeof mk>['cs'], s: {historyPending: boolean}) {
  cs.openChat('s1');
  s.historyPending = false;
  cs.settleNow('s1');
  const divider = mkEl('cyc-message');
  divider.setAttribute('data-cyc-unread', '');
  divider.setAttribute('data-mid', 'mid1');
  divider.append(document.createTextNode('a selectable line of message text'));
  cs.messageListInner.append(divider);
  cs.scrollToFirstUnread();
  return divider;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  history.replaceState({}, '', '?testhooks=1');
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
  getSelection()?.removeAllRanges();
});

describe('FIX 6: the unread-divider hold ends at the first interaction and after a bounded time', () => {
  test('a keydown ends the hold', () => {
    const s = mkSession('s1');
    const {cs, deps} = mk();
    deps.chatEl.append(cs.messageListEl);
    document.body.append(deps.chatEl);
    armHold(cs, s);
    expect(held()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'a'}));
    expect(held()).toBe(false);
  });

  test('a pointerdown on the scroller ends the hold', () => {
    const s = mkSession('s1');
    const {cs, deps} = mk();
    deps.chatEl.append(cs.messageListEl);
    document.body.append(deps.chatEl);
    armHold(cs, s);
    expect(held()).toBe(true);
    cs.messageListScroll.dispatchEvent(new Event('pointerdown'));
    expect(held()).toBe(false);
  });

  test('a wheel gesture ends the hold', () => {
    const s = mkSession('s1');
    const {cs, deps} = mk();
    deps.chatEl.append(cs.messageListEl);
    document.body.append(deps.chatEl);
    armHold(cs, s);
    expect(held()).toBe(true);
    cs.messageListScroll.dispatchEvent(new Event('wheel'));
    expect(held()).toBe(false);
  });

  test('a non-empty selection inside the list ends the hold', () => {
    const s = mkSession('s1');
    const {cs, deps} = mk();
    deps.chatEl.append(cs.messageListEl);
    document.body.append(deps.chatEl);
    const divider = armHold(cs, s);
    expect(held()).toBe(true);
    const textNode = divider.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 10);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    expect(held()).toBe(false);
  });

  test('a collapsed (empty) selection does NOT end the hold', () => {
    const s = mkSession('s1');
    const {cs, deps} = mk();
    deps.chatEl.append(cs.messageListEl);
    document.body.append(deps.chatEl);
    armHold(cs, s);
    expect(held()).toBe(true);
    getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(held()).toBe(true);
  });

  test('the hold self-releases after the bounded window with no interaction', () => {
    const s = mkSession('s1');
    const {cs, deps} = mk();
    deps.chatEl.append(cs.messageListEl);
    document.body.append(deps.chatEl);
    armHold(cs, s);
    expect(held()).toBe(true);
    vi.advanceTimersByTime(1600);
    expect(held()).toBe(false);
  });
});
