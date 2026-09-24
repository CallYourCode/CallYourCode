import {beforeEach, describe, expect, test, vi} from 'vitest';
type Handler = (...a: never[]) => void;
const fake = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  sessions: new Map<string, Record<string, unknown>>(),
  clientId: 'me'
}));
vi.mock('../engine/store', () => ({
  onReplayed: (fn: Handler) => {
    fake.handlers.replayed = fn;
    return () => {};
  },
  onIdChange: (fn: Handler) => {
    fake.handlers.idChange = fn;
    return () => {};
  },
  onSay: (fn: Handler) => {
    fake.handlers.say = fn;
    return () => {};
  },
  onSayGrow: (fn: Handler) => {
    fake.handlers.sayGrow = fn;
    return () => {};
  },
  onSayDone: (fn: Handler) => {
    fake.handlers.sayDone = fn;
    return () => {};
  },
  onSayLive: (fn: Handler) => {
    fake.handlers.sayLive = fn;
    return () => {};
  },
  onSayLiveFail: (fn: Handler) => {
    fake.handlers.sayLiveFail = fn;
    return () => {};
  },
  subscribe: (fn: Handler) => {
    fake.handlers.store = fn;
    return () => {};
  },
  get: (id: string) => fake.sessions.get(id),
  list: () => [...fake.sessions.values()],
  tabs: (): unknown[] => [],
  tabForHost: (): string | null => null,
  sessionFromNotifyKey: (): string | null => null,
  overlayOn: () => false,
  pluginsOf: (): unknown[] => [],
  toolbarPluginIds: () => new Set<string>()
}));
vi.mock('../engine/contract', () => ({clientId: () => fake.clientId}));
vi.mock('../speechGate', () => ({
  ensureMic: vi.fn(async () => {}),
  mayStartSpeech: () => true
}));
vi.mock('../audio/speaker', () => ({
  speaker: {
    state: {state: 'idle', sessionId: null as string | null},
    noteGrowth: vi.fn(),
    pending: () => new Set(),
    unlock: vi.fn(async () => {})
  }
}));
vi.mock('../audio/pipeline', () => ({
  pipeline: {initialized: true, enableHandsFree: vi.fn(), disableHandsFree: vi.fn()}
}));
vi.mock('../engine/pushNotify', () => ({onNotificationOpen: () => () => {}}));
vi.mock('../components/widgets', () => ({toast: vi.fn()}));
vi.mock('../speakerEvents', () => ({installSpeakerEvents: vi.fn()}));
vi.mock('../features/composer/voice/capture', () => ({installVoiceCapture: vi.fn()}));
vi.mock('../features/chat/surface/audioPlayback', () => ({transcriptOf: (): null => null}));
vi.mock('../sessionSelectors', () => ({
  active: (): unknown => null,
  selectTabFor: () => 'e1#t1'
}));
vi.mock('../features/settings/preferences', () => ({
  migrateToolbarKeys: vi.fn(),
  setDeclaredToolbarDefaults: vi.fn(),
  setDeclaredPluginActions: vi.fn(),
  TOOLBAR_ACTIONS: [],
  pluginToolbarAction: (): null => null,
  setToolbarActionShown: vi.fn(),
  // The default chords: listNext = Meta+ArrowDown, listPrev = Meta+ArrowUp.
  actionFor: (e: KeyboardEvent, among?: readonly string[]) => {
    const a =
      e.metaKey && e.key === 'ArrowDown'
        ? 'listNext'
        : e.metaKey && e.key === 'ArrowUp'
          ? 'listPrev'
          : null;
    return a && (!among || among.includes(a)) ? a : null;
  },
  isAction: () => false
}));
import {installStoreBindings, type StoreBindingsDeps} from '../storeBindings';
import {sessionState, dataState} from '../sessionState';
function mk(over: Partial<StoreBindingsDeps> = {}) {
  const cs = {
    settleNow: vi.fn(),
    armDeepLinkSpeak: vi.fn(),
    openChat: vi.fn(),
    openOwned: () => false,
    graceOpen: () => false,
    holdGraceGrowth: vi.fn(),
    landingOwed: () => false,
    readerTook: () => false,
    firstUnread: (): number | undefined => undefined,
    scrollToFirstUnread: vi.fn(() => true),
    scrollToBottom: vi.fn(),
    setNewBelow: vi.fn(),
    newBelowCount: () => 0,
    refreshSettleGrace: vi.fn(),
    OVERLAY_SCROLL_NEAR_PX: 100,
    messageListScroll: document.createElement('div'),
    messageListInner: document.createElement('div')
  };
  const audio = {
    play: vi.fn(),
    updateRowAudio: vi.fn(),
    updateMessagePlays: vi.fn(),
    updatePlayerBar: vi.fn(),
    updateVoiceStrip: vi.fn()
  };
  const deps = {
    onTeardown: () => {},
    cs,
    audio,
    list: {
      switchTab: vi.fn(),
      flashCards: vi.fn(),
      tabNeighbour: (): string | null => null,
      tabSessions: (): unknown[] => [],
      visibleSessions: (): unknown[] => []
    },
    tp: {jumpTo: vi.fn(), leaveChat: vi.fn(), header: {refreshToolbarActions: vi.fn()}},
    hub: {render: vi.fn()},
    settingsUI: {hasOpenSubPage: () => false, closeSubPage: vi.fn()},
    composer: {},
    cap: {},
    putBlocksBack: vi.fn(),
    restoreVoiceBlock: vi.fn(),
    clipCid: vi.fn(),
    vaultKeyOf: new WeakMap(),
    releaseMicIfIdle: vi.fn(),
    markHeard: vi.fn(),
    reportViewedThrough: vi.fn(),
    setSuppressAutoSpeak: vi.fn(),
    restored: vi.fn(),
    settleBoot: vi.fn(),
    requestOpen: vi.fn(() => true),
    isUserNavigated: () => false,
    rebuildToolbarSettings: vi.fn(),
    profileRefreshToolbar: vi.fn(),
    settingsOpen: () => false,
    setView: vi.fn(),
    mainColumns: document.createElement('div'),
    ...over
  } as unknown as StoreBindingsDeps;
  return {deps, cs, audio, sb: installStoreBindings(deps)};
}
beforeEach(() => {
  fake.handlers = {};
  fake.sessions.clear();
  dataState.mode = 'live';
  sessionState.activeId = null;
  localStorage.clear();
  vi.clearAllMocks();
});
describe('the say autoplay controller', () => {
  test('a reply for the open on-screen chat plays; a prompted reply from another device stays silent', () => {
    const {audio, deps} = mk();
    deps.mainColumns.dataset.view = 'chat';
    sessionState.activeId = 's1';
    sessionState.autoSpeak = true;
    (fake.handlers.say as Handler)(...(['s1', 'm1', 'hello', undefined, false] as never[]));
    expect(audio.play).toHaveBeenCalledWith('s1', 'm1', 'hello');
    (audio.play as ReturnType<typeof vi.fn>).mockClear();
    (fake.handlers.say as Handler)(...(['s1', 'm2', 'theirs', 'other-device', false] as never[]));
    expect(audio.play).not.toHaveBeenCalled();
  });
  test('a growing reply held back is played whole at say-done, once', () => {
    const {audio, deps, sb} = mk();
    deps.mainColumns.dataset.view = 'list';
    sessionState.activeId = null;
    (fake.handlers.say as Handler)(...(['s1', 'm1', 'partial words', undefined, true] as never[]));
    expect(audio.play).not.toHaveBeenCalled();
    expect(sb.growingOf('m1')).toMatchObject({sessionId: 's1', played: false});

    deps.mainColumns.dataset.view = 'chat';
    sessionState.activeId = 's1';
    sessionState.autoSpeak = true;
    (fake.handlers.sayDone as Handler)(...(['s1', 'm1', 6.5] as never[]));
    expect(audio.play).toHaveBeenCalledWith('s1', 'm1', 'partial words');
    expect(sb.growingOf('m1')).toBeUndefined();
  });
});
describe('live-call suppression (say-live / say-live-fail)', () => {
  const openOnScreen = (deps: {mainColumns: HTMLElement}) => {
    deps.mainColumns.dataset.view = 'chat';
    sessionState.activeId = 's1';
    sessionState.autoSpeak = true;
  };
  test('say-live suppresses the clip auto-play, permanently without a fail', () => {
    const {audio, deps} = mk();
    openOnScreen(deps);
    (fake.handlers.sayLive as Handler)(...(['s1', 'm1'] as never[]));
    (fake.handlers.say as Handler)(...(['s1', 'm1', 'streamed live', undefined, false] as never[]));
    expect(audio.play).not.toHaveBeenCalled();

    expect(audio.updateRowAudio).toHaveBeenCalled();
  });
  test('say-live-fail after the clip arrived plays the held clip now', () => {
    const {audio, deps} = mk();
    openOnScreen(deps);
    (fake.handlers.sayLive as Handler)(...(['s1', 'm1'] as never[]));
    (fake.handlers.say as Handler)(...(['s1', 'm1', 'stream broke', undefined, false] as never[]));
    expect(audio.play).not.toHaveBeenCalled();
    (fake.handlers.sayLiveFail as Handler)(...(['s1', 'm1'] as never[]));
    expect(audio.play).toHaveBeenCalledWith('s1', 'm1', 'stream broke');
  });
  test('say-live-fail before the clip arrived lets the say play normally', () => {
    const {audio, deps} = mk();
    openOnScreen(deps);
    (fake.handlers.sayLive as Handler)(...(['s1', 'm1'] as never[]));
    (fake.handlers.sayLiveFail as Handler)(...(['s1', 'm1'] as never[]));
    expect(audio.play).not.toHaveBeenCalled();
    (fake.handlers.say as Handler)(...(['s1', 'm1', 'late clip', undefined, false] as never[]));
    expect(audio.play).toHaveBeenCalledWith('s1', 'm1', 'late clip');
  });
  test('a suppressed growing reply stays silent through say-done', () => {
    const {audio, deps, sb} = mk();
    openOnScreen(deps);
    (fake.handlers.sayLive as Handler)(...(['s1', 'm1'] as never[]));
    (fake.handlers.say as Handler)(...(['s1', 'm1', 'partial', undefined, true] as never[]));
    expect(sb.growingOf('m1')).toBeUndefined();
    (fake.handlers.sayDone as Handler)(...(['s1', 'm1', 4.2] as never[]));
    expect(audio.play).not.toHaveBeenCalled();
  });
  test('no call, no frames: another msgId is unaffected by a suppression', () => {
    const {audio, deps} = mk();
    openOnScreen(deps);
    (fake.handlers.sayLive as Handler)(...(['s1', 'm1'] as never[]));
    (fake.handlers.say as Handler)(
      ...(['s1', 'm2', 'ordinary reply', undefined, false] as never[])
    );
    expect(audio.play).toHaveBeenCalledWith('s1', 'm2', 'ordinary reply');
  });
});
describe('id change carry', () => {
  test('the open chat, its stored id, tab selection and hands-free follow the rekey', () => {
    mk();
    sessionState.activeId = 'old';
    localStorage.setItem('cyc-engaged', 'old');
    sessionState.tabSelection.set('e1#t1', 'old');
    sessionState.chatConversationMode.add('old');
    (fake.handlers.idChange as Handler)(...(['old', 'new'] as never[]));
    expect(sessionState.activeId).toBe('new');
    expect(localStorage.getItem('cyc-engaged')).toBe('new');
    expect(sessionState.tabSelection.get('e1#t1')).toBe('new');
    expect(sessionState.chatConversationMode.has('new')).toBe(true);
    expect(sessionState.chatConversationMode.has('old')).toBe(false);
  });
});
describe('the boot restore', () => {
  test('he got there first: an open chat or any navigation answers both URL keys', () => {
    const {sb, deps} = mk();
    sessionState.activeId = 's1';
    expect(sb.tryRestoreActive()).toBe('none');
    expect(deps.restored).toHaveBeenCalledWith('chat');
    expect(deps.restored).toHaveBeenCalledWith('list');
    expect(deps.requestOpen).not.toHaveBeenCalled();
  });
  test('a stored chat known to the store opens through the one door, speech suppressed', () => {
    const {sb, deps} = mk();
    fake.sessions.set('s1', {id: 's1'});
    localStorage.setItem('cyc-engaged', 's1');
    expect(sb.tryRestoreActive()).toBe('opened');
    expect(deps.setSuppressAutoSpeak).toHaveBeenCalledWith(true);
    expect(deps.requestOpen).toHaveBeenCalledWith('restore', 's1');
    expect(deps.settleBoot).toHaveBeenCalled();
  });
  test('a phone launch (bootToList) reopens nothing, not even the last engaged chat', () => {
    const {sb, deps} = mk({bootToList: () => true});
    fake.sessions.set('s1', {id: 's1'});
    localStorage.setItem('cyc-engaged', 's1');
    expect(sb.tryRestoreActive()).toBe('none');
    expect(deps.requestOpen).not.toHaveBeenCalled();
    expect(deps.restored).toHaveBeenCalledWith('chat');
  });
  test('the replay settle runs only for the open chat', () => {
    const {cs} = mk();
    sessionState.activeId = 's1';
    (fake.handlers.replayed as Handler)(...(['s2'] as never[]));
    expect(cs.settleNow).not.toHaveBeenCalled();
    (fake.handlers.replayed as Handler)(...(['s1'] as never[]));
    expect(cs.settleNow).toHaveBeenCalledWith('s1');
  });
});
describe('the follow binding', () => {
  test('a store notify renders on the store path', () => {
    const {deps} = mk();
    sessionState.activeId = null;
    (fake.handlers.store as Handler)();
    expect(deps.hub.render).toHaveBeenCalledWith(true);
  });
});
describe('conversation-list keyboard nav walks only the visible rows', () => {
  // The bug: nav iterated list.tabSessions(), the raw tab set that still
  // holds dead sessions the list never paints, so ArrowDown stepped onto
  // unlisted offline agents. The fix iterates list.visibleSessions(), the
  // exact painted set. These tests capture the keydown handler at install
  // time and invoke it directly, so leftover listeners from earlier tests
  // in this file can never intercept the event.
  const r = (id: string) => ({id});
  function mkNav(list: Record<string, unknown>) {
    const captured: Array<(e: KeyboardEvent) => void> = [];
    const orig = document.addEventListener;
    (document as {addEventListener: unknown}).addEventListener = (t: string, fn: unknown) => {
      if (t === 'keydown') captured.push(fn as (e: KeyboardEvent) => void);
      // Deliberately not registered on the document: no listener leftovers.
    };
    let out: ReturnType<typeof mk>;
    try {
      out = mk({
        list: {
          switchTab: vi.fn(),
          flashCards: vi.fn(),
          tabNeighbour: (): string | null => null,
          ...list
        }
      } as never);
    } finally {
      (document as {addEventListener: unknown}).addEventListener = orig;
    }
    const press = (key: 'ArrowDown' | 'ArrowUp') => {
      const e = new KeyboardEvent('keydown', {key, metaKey: true});
      for (const fn of captured) fn(e);
    };
    return {...out, press};
  }
  test('ArrowDown from the last visible row never reaches the unlisted dead session', () => {
    const visible = [r('a'), r('b')];
    const raw = [r('a'), r('b'), r('dead1')];
    const {cs, deps, press} = mkNav({
      visibleSessions: () => visible,
      tabSessions: () => raw
    });
    // Non-vacuity: in the raw set the old code walked, 'dead1' sits right
    // after 'b', so the old nav opened it from here.
    const l = (deps as unknown as {list: {tabSessions: () => Array<{id: string}>}}).list;
    expect(l.tabSessions()[2]!.id).toBe('dead1');
    sessionState.activeId = 'b';
    press('ArrowDown');
    expect(cs.openChat).not.toHaveBeenCalled();
  });
  test('nav follows the painted order, not the raw tab order', () => {
    const visible = [r('b'), r('a')];
    const {cs, press} = mkNav({
      visibleSessions: () => visible,
      tabSessions: () => [r('a'), r('b'), r('dead1')]
    });
    sessionState.activeId = 'b';
    press('ArrowDown');
    expect(cs.openChat).toHaveBeenCalledWith('a');
    (cs.openChat as ReturnType<typeof vi.fn>).mockClear();
    sessionState.activeId = 'a';
    press('ArrowUp');
    expect(cs.openChat).toHaveBeenCalledWith('b');
  });
  test('no active chat: ArrowDown enters at the first painted row, ArrowUp at the last', () => {
    const visible = [r('b'), r('a'), r('c')];
    const {cs, press} = mkNav({visibleSessions: () => visible, tabSessions: () => visible});
    sessionState.activeId = null;
    press('ArrowDown');
    expect(cs.openChat).toHaveBeenCalledWith('b');
    (cs.openChat as ReturnType<typeof vi.fn>).mockClear();
    sessionState.activeId = null;
    press('ArrowUp');
    expect(cs.openChat).toHaveBeenCalledWith('c');
  });
  test('a search-filtered list constrains nav to the filtered rows', () => {
    // The filter left only 'a' painted; the raw set still has both.
    const {cs, press} = mkNav({
      visibleSessions: () => [r('a')],
      tabSessions: () => [r('a'), r('b')]
    });
    sessionState.activeId = 'a';
    press('ArrowDown');
    press('ArrowUp');
    expect(cs.openChat).not.toHaveBeenCalled();
  });
});
