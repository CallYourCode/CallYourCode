import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
const writes: Array<Record<string, unknown>> = [];
vi.mock('../features/sessions/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  looksOpaque: (v: string | null) => !!v && /^[0-9a-f]{13}$/.test(v),
  opaqueKey: (raw: string) => `key(${raw})`,
  writeNav: (state: Record<string, unknown>) => {
    writes.push({...state});
  }
}));
vi.mock('../shared/logging', () => ({cyclog: vi.fn(), setLogAutoShip: vi.fn()}));
import {createNavMachine, BOOT_FREEZE_CLASS, type NavMachineDeps} from '../navMachine';
import {sessionState, bootUrlNav, dataState} from '../sessionState';
import type {CycSession} from '../types';
const OPAQUE = 'abc123def4567';
beforeEach(() => {
  writes.length = 0;
  sessionState.activeId = null;
  sessionState.activeTabId = null;
  sessionState.shownDoc = null;
  bootUrlNav.host = null;
  bootUrlNav.chat = null;
  bootUrlNav.list = false;
  bootUrlNav.profile = false;
  bootUrlNav.doc = null;
  bootUrlNav.settings = false;
  dataState.mode = 'live';
  dataState.demoSessions = [];
  document.body.className = '';
  vi.clearAllMocks();
});
function mk(over: Partial<NavMachineDeps> = {}) {
  const mainColumns = document.createElement('div');
  const settingsEl = document.createElement('div');
  const disposers: Array<() => void> = [];
  const deps = {
    onTeardown: (d: () => void) => disposers.push(d),
    mainColumns,
    settingsEl: () => settingsEl,
    markSeen: vi.fn(),
    updateFab: vi.fn(),
    refreshProfileAttachments: vi.fn(),
    retryProfileMedia: vi.fn(),
    speakUnheard: vi.fn(),
    openChat: vi.fn(),
    ...over
  };
  return {deps, disposers, settingsEl, mainColumns, nav: createNavMachine(deps)};
}
describe('navState and setView', () => {
  test('construction paints the list view and writes the URL once', () => {
    const {mainColumns} = mk();
    expect(mainColumns.dataset.view).toBe('list');
    expect(mainColumns.classList.contains('view-list')).toBe(true);
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatchObject({chat: null, list: false, settings: false, profile: false});
  });
  test('the view moves, the classes and URL follow, and leaving a chat marks it seen', () => {
    const {nav, deps, mainColumns} = mk();
    sessionState.activeId = 's1';
    sessionState.activeTabId = 't1';
    nav.setView('chat');
    expect(mainColumns.dataset.view).toBe('chat');
    expect(mainColumns.classList.contains('view-chat')).toBe(true);
    expect(mainColumns.classList.contains('view-list')).toBe(false);
    expect(writes.at(-1)).toMatchObject({chat: 'key(s1)', host: 'key(t1)', list: false});
    expect(deps.markSeen).not.toHaveBeenCalled();

    nav.setView('list');
    expect(deps.markSeen).toHaveBeenCalledWith('s1');
    expect(writes.at(-1)).toMatchObject({chat: 'key(s1)', list: true});
    expect(deps.updateFab).toHaveBeenCalled();
  });
  test('opening the profile refreshes shared media and retries its thumbnails', () => {
    const {nav, deps, mainColumns} = mk();
    nav.setView('profile');
    expect(deps.refreshProfileAttachments).toHaveBeenCalledTimes(1);
    expect(deps.retryProfileMedia).toHaveBeenCalledTimes(1);
    expect(mainColumns.dataset.view).toBe('profile');
    expect(mainColumns.classList.contains('view-profile')).toBe(true);
    expect(writes.at(-1)).toMatchObject({profile: true});
  });
  test('becoming the chat view speaks the unheard, unless the chat changed under the timer', () => {
    vi.useFakeTimers();
    try {
      const {nav, deps} = mk();
      sessionState.activeId = 's1';
      nav.setView('chat');
      vi.advanceTimersByTime(60);
      expect(deps.speakUnheard).toHaveBeenCalledWith('s1');

      nav.setView('list');
      nav.setView('chat');
      sessionState.activeId = 's2';
      vi.advanceTimersByTime(60);
      expect(deps.speakUnheard).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe('boot-restore holds', () => {
  test('held keys keep the boot values in the URL until restored()', () => {
    bootUrlNav.chat = OPAQUE;
    bootUrlNav.list = true;
    bootUrlNav.doc = 'doc1';
    const {nav} = mk();

    expect(nav.navState()).toMatchObject({chat: OPAQUE, list: true, doc: 'doc1'});
    nav.restored('chat');
    expect(nav.navState().chat).toBe(null);
    expect(nav.navState().list).toBe(true);
    nav.restored('list');
    expect(nav.navState().list).toBe(false);

    const n = writes.length;
    nav.restored('host');
    expect(writes.length).toBe(n);
  });
  test('a non-opaque boot chat (a deep link) is not held', () => {
    bootUrlNav.chat = 'my-session-name';
    bootUrlNav.list = true;
    const {nav} = mk();
    expect(nav.restorePending.has('chat')).toBe(false);
    expect(nav.restorePending.has('list')).toBe(false);
    expect(nav.navState().chat).toBe(null);
  });
});
describe('a dead open session leaves the URL', () => {
  const sess = (id: string, over: Record<string, unknown> = {}): CycSession =>
    ({
      id,
      name: id,
      unread: 0,
      muted: false,
      thinking: false,
      messages: [],
      ...over
    }) as unknown as CycSession;
  test('the open session ending drops chat= and keeps host=; the view stays put', () => {
    dataState.mode = 'test';
    dataState.demoSessions = [sess('s1', {alive: true})];
    const {nav, mainColumns} = mk();
    sessionState.activeId = 's1';
    sessionState.activeTabId = 't1';
    nav.setView('chat');
    expect(writes.at(-1)).toMatchObject({chat: 'key(s1)', host: 'key(t1)'});

    dataState.demoSessions = [sess('s1', {alive: false})];
    nav.syncNavUrl();
    expect(writes.at(-1)).toMatchObject({chat: null, host: 'key(t1)'});

    expect(mainColumns.dataset.view).toBe('chat');
    expect(sessionState.activeId).toBe('s1');
  });
  test('a NON-open session ending changes nothing in the URL', () => {
    dataState.mode = 'test';
    dataState.demoSessions = [sess('s1', {alive: true}), sess('s2', {alive: true})];
    const {nav} = mk();
    sessionState.activeId = 's1';
    sessionState.activeTabId = 't1';
    nav.setView('chat');
    dataState.demoSessions = [sess('s1', {alive: true}), sess('s2', {alive: false})];
    nav.syncNavUrl();
    expect(writes.at(-1)).toMatchObject({chat: 'key(s1)', host: 'key(t1)'});
  });
  test('a boot restore that lands on an already-dead session writes no chat', () => {
    bootUrlNav.chat = OPAQUE;
    dataState.mode = 'test';
    dataState.demoSessions = [sess('s1', {alive: false})];
    const {nav} = mk();
    sessionState.activeId = 's1';
    nav.restored('chat');
    expect(nav.navState().chat).toBe(null);
  });
});
describe('writeNav uses replaceState, never pushState', () => {
  test('the real writer replaces in place and drops an absent chat from the bar', async () => {
    const real = await vi.importActual<typeof import('../features/sessions/navigation')>(
      '../features/sessions/navigation'
    );
    const replace = vi.spyOn(history, 'replaceState');
    const push = vi.spyOn(history, 'pushState');
    try {
      real.writeNav({
        host: 'a'.repeat(13),
        chat: null,
        list: false,
        settings: false,
        profile: false,
        doc: null
      });
      expect(replace).toHaveBeenCalledTimes(1);
      expect(push).not.toHaveBeenCalled();
      const url = new URL(String(replace.mock.calls[0][2]));
      expect(url.searchParams.get('host')).toBe('a'.repeat(13));
      expect(url.searchParams.has('chat')).toBe(false);
    } finally {
      replace.mockRestore();
      push.mockRestore();
    }
  });
});
describe('requestOpen and cancelPendingOpens', () => {
  test('user navigation is final: a late boot opener is refused', () => {
    bootUrlNav.host = OPAQUE;
    bootUrlNav.chat = OPAQUE;
    bootUrlNav.list = true;
    const {nav, deps} = mk();
    expect(nav.wantedHost()).toBe(OPAQUE);
    expect(nav.requestOpen('restore', 'a')).toBe(true);
    expect(deps.openChat).toHaveBeenCalledWith('a');
    nav.cancelPendingOpens('tab-switch');
    expect(nav.isUserNavigated()).toBe(true);
    expect(nav.requestOpen('notification', 'b')).toBe(false);
    expect(deps.openChat).toHaveBeenCalledTimes(1);

    expect(nav.wantedHost()).toBe(null);
    expect(nav.restorePending.has('chat')).toBe(false);
    expect(nav.restorePending.has('list')).toBe(false);
  });
});
describe('boot settle', () => {
  test('boot freeze holds until settleBoot, lifts two frames later, and is idempotent', () => {
    const raf: FrameRequestCallback[] = [];
    const realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      raf.push(cb);
      return raf.length;
    }) as never;
    try {
      const {nav, disposers, mainColumns} = mk();
      expect(mainColumns.classList.contains(BOOT_FREEZE_CLASS)).toBe(true);
      nav.settleBoot();
      nav.settleBoot();
      expect(raf.length).toBe(1);
      raf.shift()!(0);
      raf.shift()!(0);
      expect(mainColumns.classList.contains(BOOT_FREEZE_CLASS)).toBe(false);
      for (const d of disposers) d();
      expect(mainColumns.classList.contains(BOOT_FREEZE_CLASS)).toBe(false);
    } finally {
      window.requestAnimationFrame = realRaf;
    }
  });
});
describe('the Settings door', () => {
  test('one door: flag, class, sub-page reset and URL all move together', () => {
    const {nav, settingsEl} = mk();
    const closeSub = vi.fn();
    nav.setCloseSettingsSubPage(closeSub);
    nav.setSettingsOpen(true);
    expect(nav.settingsOpen()).toBe(true);
    expect(settingsEl.classList.contains('cyc-settings-open')).toBe(true);
    expect(writes.at(-1)).toMatchObject({settings: true});
    expect(closeSub).not.toHaveBeenCalled();
    nav.setSettingsOpen(false);
    expect(closeSub).toHaveBeenCalledTimes(1);
    expect(settingsEl.classList.contains('cyc-settings-open')).toBe(false);
    expect(writes.at(-1)).toMatchObject({settings: false});
  });
});
describe('settings close on outside pointer (desktop)', () => {
  const ORIGINAL_WIDTH = window.innerWidth;
  const setWidth = (px: number) =>
    Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});
  const pointerDown = (el: Element) =>
    el.dispatchEvent(new Event('pointerdown', {bubbles: true, cancelable: true}));

  let cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups = [];
    setWidth(ORIGINAL_WIDTH);
  });

  // The real leftPane (settingsEl) sits inside mainColumns; the outside
  // listener only sees events that reach the document, so mount for real.
  function mkMounted() {
    const made = mk();
    const {mainColumns, settingsEl, nav, disposers} = made;
    mainColumns.append(settingsEl);
    const chatArea = document.createElement('div');
    mainColumns.append(chatArea);
    document.body.append(mainColumns);
    cleanups.push(() => {
      disposers.forEach((d) => d());
      mainColumns.remove();
    });
    setWidth(1200);
    nav.setSettingsOpen(true);
    return {...made, chatArea};
  }

  test('a pointerdown outside the left column closes settings', () => {
    const {nav, settingsEl, chatArea} = mkMounted();
    pointerDown(chatArea);
    expect(nav.settingsOpen()).toBe(false);
    expect(settingsEl.classList.contains('cyc-settings-open')).toBe(false);
  });

  test('a pointerdown inside the left column keeps settings open', () => {
    const {nav, settingsEl} = mkMounted();
    const inside = document.createElement('div');
    settingsEl.append(inside);
    pointerDown(inside);
    expect(nav.settingsOpen()).toBe(true);
  });

  test('overlays mounted outside the columns (menus, popups) do not close settings', () => {
    const {nav} = mkMounted();
    const overlay = document.createElement('div');
    document.body.append(overlay);
    cleanups.push(() => overlay.remove());
    pointerDown(overlay);
    expect(nav.settingsOpen()).toBe(true);
  });

  test('below the desktop width the chat pane click path stays in charge', () => {
    const {nav, chatArea} = mkMounted();
    setWidth(800);
    pointerDown(chatArea);
    expect(nav.settingsOpen()).toBe(true);
  });

  test('the opening gesture cannot self-close: pointerdown lands before open', () => {
    const {nav, chatArea} = mkMounted();
    nav.setSettingsOpen(false);
    pointerDown(chatArea);
    nav.setSettingsOpen(true);
    expect(nav.settingsOpen()).toBe(true);
  });

  test('teardown removes the listener', () => {
    const {nav, disposers, chatArea} = mkMounted();
    disposers.forEach((d) => d());
    disposers.length = 0;
    pointerDown(chatArea);
    expect(nav.settingsOpen()).toBe(true);
  });
});

describe('coming back after a long absence opens the chats list (phone)', () => {
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
    document.dispatchEvent(new Event('visibilitychange'));
  };
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(window, 'innerWidth', {configurable: true, value: 390});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  test('resume after more than a minute away leaves the chat for the list', () => {
    const {nav, mainColumns, disposers} = mk();
    sessionState.activeId = 's1';
    nav.setView('chat');
    setHidden(true);
    vi.advanceTimersByTime(61_000);
    setHidden(false);
    expect(mainColumns.dataset.view).toBe('list');
    disposers.forEach((d) => d());
  });

  test('a quick hop away keeps the chat', () => {
    const {nav, mainColumns, disposers} = mk();
    sessionState.activeId = 's1';
    nav.setView('chat');
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    setHidden(false);
    expect(mainColumns.dataset.view).toBe('chat');
    disposers.forEach((d) => d());
  });

  test('wide screens keep the chat however long the absence', () => {
    Object.defineProperty(window, 'innerWidth', {configurable: true, value: 1200});
    const {nav, mainColumns, disposers} = mk();
    sessionState.activeId = 's1';
    nav.setView('chat');
    setHidden(true);
    vi.advanceTimersByTime(10 * 60_000);
    setHidden(false);
    expect(mainColumns.dataset.view).toBe('chat');
    disposers.forEach((d) => d());
  });

  test('a launch (even seconds after a force close) drops the ?chat= restore; our own reload keeps it', () => {
    bootUrlNav.chat = OPAQUE;
    const launch = mk();
    expect(launch.nav.restorePending.has('chat')).toBe(false);
    launch.disposers.forEach((d) => d());

    sessionStorage.setItem('cyc-self-reload', String(Date.now() - 500));
    const reload = mk();
    expect(reload.nav.restorePending.has('chat')).toBe(true);
    reload.disposers.forEach((d) => d());
  });
});
