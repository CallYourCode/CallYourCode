// Pointer-drag paging thresholds on the chat message surface (touch builds):
// micro-jitters and taps never move the surface, a mostly-vertical drag scrolls,
// a sub-threshold drag snaps back, a past-threshold drag commits (back to the
// list on a rightward swipe, the next chat on a leftward one).
import {beforeEach, describe, expect, test, vi} from 'vitest';
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
  touchCapable: true,
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
  active: (): null => null,
  allSessions: () => [...fake.sessions.values()],
  selectTabFor: () => 'e1#t1',
  isDead: () => false
}));
import {createChatSurface, type ChatSurfaceDeps} from '../features/chat/surface/chatSurface';
import {sessionState, dataState} from '../sessionState';

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
  const cs = createChatSurface(deps);
  // jsdom reports clientWidth 0, which would clamp the streamed drag offset to
  // 1px; give the surface a phone-ish width so tracking is observable.
  Object.defineProperty(cs.messageListScroll, 'clientWidth', {
    get: () => 400,
    configurable: true
  });
  return {deps, cs};
}
// jsdom advertises touch (not pointer) support, so the gesture wrapper binds
// touch events here; a real browser binds pointer events through the same
// wrapper. jsdom has TouchEvent but no Touch constructor, so we pass plain
// touch-shaped objects plus a controlled timeStamp for deterministic velocity.
interface Pt {
  x: number;
  y: number;
  t: number;
}
function tev(type: string, target: EventTarget, s: Pt): TouchEvent {
  const touch = {identifier: 1, target, clientX: s.x, clientY: s.y} as unknown as Touch;
  const ending = type === 'touchend' || type === 'touchcancel';
  const live = ending ? [] : [touch];
  const e = new TouchEvent(type, {
    touches: live,
    targetTouches: live,
    changedTouches: [touch],
    bubbles: true,
    cancelable: true
  });
  Object.defineProperty(e, 'timeStamp', {value: s.t, configurable: true});
  return e;
}
// Drive a full drag: start on `target`, moves + end on the window (the wrapper
// delegates move/end tracking to the window).
function drag(target: EventTarget, down: Pt, moves: Pt[], up: Pt) {
  target.dispatchEvent(tev('touchstart', target, down));
  for (const m of moves) window.dispatchEvent(tev('touchmove', target, m));
  window.dispatchEvent(tev('touchend', target, up));
}
beforeEach(() => {
  fake.sessions.clear();
  dataState.mode = 'live';
  sessionState.activeId = null;
  vi.clearAllMocks();
});

// Slow, non-flick timing: each event is >32ms apart with low per-move velocity,
// so only distance (never a velocity flick) can commit.
const SLOW: [Pt, Pt] = [
  {x: 0, y: 0, t: 120},
  {x: 0, y: 0, t: 240}
];
const at = (base: Pt, x: number, y: number): Pt => ({x, y, t: base.t});

describe('chat swipe paging thresholds (touch build)', () => {
  test('a 5px movement neither moves the surface nor commits', () => {
    const {cs, deps} = mk();
    drag(cs.messageListScroll, {x: 10, y: 100, t: 0}, [at(SLOW[0], 15, 100)], {
      x: 15,
      y: 100,
      t: 360
    });
    expect(cs.messageListInner.style.transform).toBe('');
    expect(deps.backToList).not.toHaveBeenCalled();
    expect(deps.jumpTo).not.toHaveBeenCalled();
  });
  test('a mostly-vertical drag never activates paging, even with later horizontal travel', () => {
    const {cs, deps} = mk();
    cs.messageListScroll.dispatchEvent(
      tev('touchstart', cs.messageListScroll, {x: 100, y: 100, t: 0})
    );
    window.dispatchEvent(tev('touchmove', cs.messageListScroll, {x: 104, y: 140, t: 120})); // dy leads
    expect(cs.messageListInner.style.transform).toBe('');
    window.dispatchEvent(tev('touchmove', cs.messageListScroll, {x: 220, y: 140, t: 240})); // dead
    expect(cs.messageListInner.style.transform).toBe('');
    window.dispatchEvent(tev('touchend', cs.messageListScroll, {x: 220, y: 140, t: 360}));
    expect(deps.backToList).not.toHaveBeenCalled();
    expect(deps.jumpTo).not.toHaveBeenCalled();
  });
  test('an 11px horizontal movement stays under the arm gate: zero transform', () => {
    const {cs, deps} = mk();
    drag(cs.messageListScroll, {x: 10, y: 100, t: 0}, [at(SLOW[0], 21, 100)], {
      x: 21,
      y: 100,
      t: 360
    });
    expect(cs.messageListInner.style.transform).toBe('');
    expect(deps.backToList).not.toHaveBeenCalled();
    expect(deps.jumpTo).not.toHaveBeenCalled();
  });
  test('a 13px edge back-swipe arms with the slop subtracted: near-zero displacement', () => {
    const {cs} = mk();
    cs.messageListScroll.dispatchEvent(
      tev('touchstart', cs.messageListScroll, {x: 10, y: 100, t: 0})
    );
    window.dispatchEvent(tev('touchmove', cs.messageListScroll, {x: 23, y: 100, t: 120}));
    // Armed (13 >= 12, horizontal-dominant), but the visual starts from the arm
    // point: 13px of travel minus the 12px slop leaves 1px, not 13px.
    expect(cs.messageListInner.style.transform).toBe('translateX(1px)');
    window.dispatchEvent(tev('touchend', cs.messageListScroll, {x: 23, y: 100, t: 360}));
  });
  test('a 13px leftward drag toward the next chat also starts near zero', () => {
    const {cs} = mk({jumpTarget: () => 'next'});
    cs.messageListScroll.dispatchEvent(
      tev('touchstart', cs.messageListScroll, {x: 300, y: 100, t: 0})
    );
    window.dispatchEvent(tev('touchmove', cs.messageListScroll, {x: 287, y: 100, t: 120}));
    expect(cs.messageListInner.style.transform).toBe('translateX(-1px)');
    window.dispatchEvent(tev('touchend', cs.messageListScroll, {x: 287, y: 100, t: 360}));
  });
  test('a 40px vertical-dominant drag never arms: zero transform throughout', () => {
    const {cs, deps} = mk();
    cs.messageListScroll.dispatchEvent(
      tev('touchstart', cs.messageListScroll, {x: 100, y: 100, t: 0})
    );
    window.dispatchEvent(tev('touchmove', cs.messageListScroll, {x: 110, y: 138, t: 120})); // dy 38 vs dx 10
    expect(cs.messageListInner.style.transform).toBe('');
    window.dispatchEvent(tev('touchmove', cs.messageListScroll, {x: 110, y: 180, t: 240}));
    expect(cs.messageListInner.style.transform).toBe('');
    window.dispatchEvent(tev('touchend', cs.messageListScroll, {x: 110, y: 180, t: 360}));
    expect(deps.backToList).not.toHaveBeenCalled();
    expect(deps.jumpTo).not.toHaveBeenCalled();
  });
  test('a sub-threshold edge back-swipe tracks, then snaps back on release', () => {
    const {cs, deps} = mk();
    cs.messageListScroll.dispatchEvent(
      tev('touchstart', cs.messageListScroll, {x: 10, y: 100, t: 0})
    );
    window.dispatchEvent(tev('touchmove', cs.messageListScroll, {x: 40, y: 100, t: 120})); // 30px raw
    // 30px of travel minus the 12px arm slop paints 18px.
    expect(cs.messageListInner.style.transform).toBe('translateX(18px)');
    window.dispatchEvent(tev('touchend', cs.messageListScroll, {x: 40, y: 100, t: 360}));
    expect(cs.messageListInner.style.transform).toBe('');
    expect(deps.backToList).not.toHaveBeenCalled();
    expect(deps.jumpTo).not.toHaveBeenCalled();
  });
  test('a short (~15%) slow edge back-swipe SNAPS BACK below the threshold (G2)', () => {
    const {cs, deps} = mk();
    drag(
      cs.messageListScroll,
      {x: 10, y: 100, t: 0},
      [at(SLOW[0], 40, 100), at(SLOW[1], 70, 100)], // 60px raw = 15% of 400
      {x: 70, y: 100, t: 360}
    );
    expect(deps.backToList).not.toHaveBeenCalled();
    expect(cs.messageListInner.style.transform).toBe('');
  });
  test('a quarter-width slow edge back-swipe now commits (2026-09-24: was 50%)', () => {
    const {cs, deps} = mk();
    drag(
      cs.messageListScroll,
      {x: 10, y: 100, t: 0},
      [at(SLOW[0], 60, 100), at(SLOW[1], 115, 100)], // 105px raw = 26% of 400
      {x: 115, y: 100, t: 360}
    );
    expect(deps.backToList).toHaveBeenCalledTimes(1);
  });
  test('a back-swipe starting a thumb-width in (50px) still counts as an edge swipe', () => {
    const {cs, deps} = mk();
    drag(
      cs.messageListScroll,
      {x: 50, y: 100, t: 0},
      [at(SLOW[0], 120, 100), at(SLOW[1], 200, 100)], // 150px raw
      {x: 200, y: 100, t: 360}
    );
    expect(deps.backToList).toHaveBeenCalledTimes(1);
  });
  test('a past-threshold edge back-swipe commits back to the list (G1)', () => {
    const {cs, deps} = mk();
    drag(
      cs.messageListScroll,
      {x: 10, y: 100, t: 0},
      [at(SLOW[0], 140, 100), at(SLOW[1], 270, 100)], // 260px raw = 65% of 400
      {x: 270, y: 100, t: 360}
    );
    expect(deps.backToList).toHaveBeenCalledTimes(1);
  });
  test('a fast edge flick commits early, below the distance threshold (G5)', () => {
    const {cs, deps} = mk();
    drag(
      cs.messageListScroll,
      {x: 10, y: 100, t: 0},
      [
        {x: 40, y: 100, t: 200},
        {x: 90, y: 100, t: 210} // 50px in 10ms = fast last move
      ],
      {x: 90, y: 100, t: 214} // released immediately: only ~20% travelled
    );
    expect(deps.backToList).toHaveBeenCalledTimes(1);
  });
  test('a past-threshold leftward drag commits to the next chat', () => {
    const jumpTo = vi.fn();
    const {cs} = mk({jumpTo, jumpTarget: () => 'next'});
    drag(
      cs.messageListScroll,
      {x: 300, y: 100, t: 0},
      [at(SLOW[0], 170, 100), at(SLOW[1], 40, 100)], // 260px left
      {x: 40, y: 100, t: 360}
    );
    expect(jumpTo).toHaveBeenCalledWith(1, 'touch', undefined);
  });
  test('a rightward drag that does not start at the left edge never commits back', () => {
    const {cs, deps} = mk();
    drag(
      cs.messageListScroll,
      {x: 200, y: 100, t: 0}, // far from the left edge
      [at(SLOW[0], 330, 100), at(SLOW[1], 440, 100)], // full-width rightward
      {x: 440, y: 100, t: 360}
    );
    expect(deps.backToList).not.toHaveBeenCalled();
    expect(cs.messageListInner.style.transform).toBe('');
  });
  test('the surface carries touch-action pan-y after mount', () => {
    const {cs} = mk();
    expect(cs.messageListScroll.style.touchAction).toBe('pan-y');
  });
  test('an under-threshold drag that ends in touchcancel snaps back, never commits', () => {
    const {cs, deps} = mk();
    cs.messageListScroll.dispatchEvent(
      tev('touchstart', cs.messageListScroll, {x: 10, y: 100, t: 0})
    );
    window.dispatchEvent(tev('touchmove', cs.messageListScroll, {x: 40, y: 100, t: 120})); // 30px, armed
    window.dispatchEvent(tev('touchcancel', cs.messageListScroll, {x: 45, y: 100, t: 240}));
    expect(cs.messageListInner.style.transform).toBe('');
    expect(deps.backToList).not.toHaveBeenCalled();
    expect(deps.jumpTo).not.toHaveBeenCalled();
  });
  test('a drag starting on an inner horizontal scroller never arms the pager', () => {
    const {cs, deps} = mk();
    const inner = document.createElement('div');
    inner.style.overflowX = 'auto';
    Object.defineProperty(inner, 'scrollWidth', {get: () => 500, configurable: true});
    Object.defineProperty(inner, 'clientWidth', {get: () => 100, configurable: true});
    cs.messageListInner.append(inner);
    drag(
      inner,
      {x: 10, y: 100, t: 0},
      [at(SLOW[0], 140, 100), at(SLOW[1], 270, 100)], // past threshold, but off-limits
      {x: 270, y: 100, t: 360}
    );
    expect(cs.messageListInner.style.transform).toBe('');
    expect(deps.backToList).not.toHaveBeenCalled();
    expect(deps.jumpTo).not.toHaveBeenCalled();
  });
});
