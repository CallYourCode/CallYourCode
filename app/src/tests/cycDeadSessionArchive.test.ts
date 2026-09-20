import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycSession} from '../types';

/* Dead-session archive (WhatsApp-like ended threads): a session whose pane
 * ended leaves the LIVE conversation list after a brief grey grace, but its
 * row and full chat history stay reachable behind the archive lens, whose
 * entry point is the Settings "Archived (n)" row (the conversation list
 * itself carries NO archive affordance; cycArchiveSettingsEntry covers the
 * settings row). Nothing is deleted: the engine keeps listing the dead
 * session, and a restart returns it to the live list.
 *
 * Three layers, each against the REAL code it guards:
 *  - the store handler's death grace (alive -> dead edge greys, then drops),
 *  - the archive projection and lens in sessionSelectors,
 *  - the list pane's "Chats" back row and lens-projected visible set.
 * The engine store module is mocked only for the list-pane layer (the same
 * scaffolding as cycListVisibleRows); the handler layer drives the real
 * registry, and the selectors run unmocked throughout. */
const fake = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  tabs: [] as Array<{id: string; label: string; state: string; unread: number; activity: boolean}>,
  // Announced engines (contract mock) and keyring listeners, for the pair
  // banner sitting in the same pane: an announced engine with no key in the
  // (empty) fake keyring is "known but unpaired" and paints a banner row.
  engines: [] as Array<Record<string, unknown>>,
  keyringListeners: [] as Array<() => void>
}));
vi.mock('../engine/keyring', () => ({
  onKeyringChange: (fn: () => void) => {
    fake.keyringListeners.push(fn);
    return () => {
      const i = fake.keyringListeners.indexOf(fn);
      if (i >= 0) fake.keyringListeners.splice(i, 1);
    };
  },
  pairedUserHosts: async () => new Set<string>(),
  putKey: vi.fn(async () => {}),
  getByUserHost: async (): Promise<null> => null,
  listKeys: async (): Promise<unknown[]> => [],
  deleteKey: vi.fn(async () => {}),
  pinEngineIdentity: vi.fn(async () => {}),
  storeGenerations: vi.fn(async () => {})
}));
vi.mock('../engine/store', () => ({
  tabs: () => fake.tabs,
  list: () => fake.sessions,
  get: (id: string) => fake.sessions.find((s) => s.id === id),
  activityMark: () => false,
  effectiveNotify: () => true,
  detachChat: vi.fn(),
  engineKeyOfTab: () => 'e1',
  engineReachable: () => true,
  syncStatus: () => 'live',
  onSyncStatus: () => () => {},
  exitSession: vi.fn(async () => true),
  newSessionPlaces: vi.fn(async () => ({
    places: [],
    home: '/home/u',
    def: null,
    harnesses: [],
    recent: []
  })),
  pluginRpc: vi.fn(async () => ({ok: true})),
  pluginsOf: (): unknown[] => [],
  renameSession: vi.fn(async () => true),
  reorderSessions: vi.fn(async () => true),
  reorderTabs: vi.fn(),
  restartSession: vi.fn(async () => null),
  setMergedListOrder: vi.fn(async () => true),
  setReplyDial: vi.fn(async () => {}),
  setSessionUnread: vi.fn(async () => true),
  startSession: vi.fn(async () => ({paneId: null, why: 'no'})),
  startSettingsSync: vi.fn(),
  mergedListOrder: (): string[] => [],
  tabOfSession: (): string | null => null,
  toolbarPluginIds: () => new Set<string>()
}));
vi.mock('../shared/browser', () => ({
  active: () => false,
  begin: vi.fn(),
  onSettle: vi.fn()
}));
vi.mock('../features/settings/preferences', () => ({
  sortByLatest: () => true,
  mergeTabs: () => false,
  seedKeymapFromServer: vi.fn(async () => {})
}));
vi.mock('../features/sessions/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  opaqueKey: (s: string) => 'op:' + s
}));
vi.mock('../features/sessions/layout', () => ({deviceClass: () => 'phone'}));
// Partial: listPane wants a null enginePin, but the REAL registry (driven by
// the handler layer below) still needs engineUrls and friends.
vi.mock('../engine/contract', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enginePin: (): string | null => null,
  configuredEngines: () => fake.engines
}));
vi.mock('../audio/speaker', () => ({
  speaker: {state: {state: 'idle'}, pause: vi.fn(), resume: vi.fn(), stopAll: vi.fn()}
}));
vi.mock('../audio/pipeline', () => ({
  pipeline: {handsFreeSessionId: '', disableHandsFree: vi.fn()}
}));
vi.mock('../components/widgets', () => ({
  inputSearch: () => document.createElement('div'),
  toast: vi.fn(),
  confirmExitSession: vi.fn()
}));
vi.mock('../features/sessions/panes/pluginCardsPane', () => ({
  createPluginCardsPane: () => ({
    paintPluginCards: vi.fn(),
    paintLimits: vi.fn(),
    refreshUsage: vi.fn(async () => {}),
    markUsageReady: vi.fn(),
    retainedAnswer: (): null => null,
    flashCards: vi.fn()
  })
}));
vi.mock('../features/sessions/components/sessionList', () => ({
  createSessionList: () => ({
    el: document.createElement('div'),
    update: vi.fn(),
    setConversationMode: vi.fn(),
    setRowAudioState: vi.fn()
  })
}));
vi.mock('../features/chat/navigation/audioPlayerBar', () => ({
  createAudioPlayerBar: () => ({
    el: document.createElement('div'),
    show: vi.fn(),
    progress: vi.fn()
  })
}));
vi.mock('../components/hintsCard', () => ({
  createHintsCard: () => document.createElement('div'),
  hintsDismissed: () => false
}));
vi.mock('../features/sessions/controls/tabSort', () => ({
  default: class {
    constructor(_: unknown) {}
  }
}));
vi.mock('../components/popupMenu', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openMenu: vi.fn()
}));

import {projectArchive, projectMembership, projectRows} from '../sessionSelectors';
import {sessionState, dataState} from '../sessionState';
import {createListPane, type ListPaneDeps} from '../features/sessions/panes/listPane';
import {
  conns,
  engineThinking,
  lastSettledTabs,
  renderSubs,
  seen,
  sessions,
  type Conn
} from '../engine/store/registry';
import {DEATH_GRACE_MS, wireSessions} from '../engine/store/handlers/sessions';
import type {HandlerCtx} from '../engine/store/handlers/types';
import type {CycEngineSession} from '../engine/store/types';

const KEY = 'ws://fake-archive.test:7788/ws';
const SID = KEY + '|p1';
type Fired = Record<string, (...a: never[]) => void>;
function fakeConn(): {conn: Conn; fire: (ev: string, ...a: unknown[]) => void} {
  const handlers: Fired = {};
  const conn = {
    key: KEY,
    state: 'connected',
    user: 'u',
    host: 'h',
    hostname: 'h',
    tabs: [],
    plugins: [],
    voiceHealthy: true,
    helloSettled: true,
    client: {
      on: (ev: string, fn: (...a: never[]) => void) => {
        handlers[ev] = fn;
      },
      setSessionTail: vi.fn()
    }
  } as unknown as Conn;
  conns.push(conn);
  const fire = (ev: string, ...a: unknown[]) => {
    if (!handlers[ev]) throw new Error('no handler for ' + ev);
    (handlers[ev] as (...x: unknown[]) => void)(...a);
  };
  return {conn, fire};
}
function mkSession(paneId = 'p1'): CycEngineSession {
  const s = {
    id: KEY + '|' + paneId,
    engineKey: KEY,
    paneId,
    tabKey: '',
    name: paneId,
    cwd: '/x',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}
function spyCtx(over: Partial<HandlerCtx> = {}): HandlerCtx {
  const base = {
    ensureSession: (ek: string, paneId: string) =>
      sessions.get(ek + '|' + paneId) ?? mkSession(paneId),
    admitEngineMessage: vi.fn(() => true),
    settleTranscript: vi.fn(),
    stripInstruction: (t: string) => t,
    insertSorted: vi.fn(),
    cacheTail: vi.fn(),
    releaseQueued: vi.fn(() => true),
    releaseQueuedBefore: vi.fn(() => false),
    endReplayHold: vi.fn(),
    firstPaint: vi.fn(),
    pageSizeOf: () => 50,
    overlayOn: () => false,
    insertEvents: vi.fn(),
    notifyChat: vi.fn(),
    rekeySession: vi.fn(() => null),
    reclaimDead: vi.fn(() => true),
    attachedId: () => '',
    fireCompactResult: vi.fn(),
    fireAnswerResult: vi.fn(),
    fireSay: vi.fn(),
    fireSayGrow: vi.fn(),
    fireSayDone: vi.fn(),
    fireSayLive: vi.fn(),
    fireSayLiveFail: vi.fn()
  } as unknown as HandlerCtx;
  return {...base, ...over};
}
const frameRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'p1',
  cwd: '/x',
  settings: {},
  alive: true,
  unread: 0,
  claudeSessionId: null as string | null,
  ...over
});

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

beforeEach(() => {
  fake.sessions = [];
  fake.tabs = [];
  fake.engines = [];
  fake.keyringListeners.length = 0;
  dataState.mode = 'live';
  sessionState.activeId = null;
  sessionState.activeTabId = 'e1#t1';
  sessionState.archiveOpen = false;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  sessionState.archiveOpen = false;
  const c = conns.find((x) => x.key === KEY);
  if (c) conns.splice(conns.indexOf(c), 1);
  sessions.clear();
  seen.clear();
  engineThinking.clear();
  lastSettledTabs.delete(KEY);
});

describe('the death grace (store handler)', () => {
  test('alive -> dead greys the row for the grace, THEN drops it to the archive', () => {
    vi.useFakeTimers();
    const {conn, fire} = fakeConn();
    wireSessions(conn, spyCtx());
    const s = mkSession();
    const paints = vi.fn();
    renderSubs.add(paints);
    try {
      fire('sessions', [frameRow({alive: false})], []);
      expect(s.alive).toBe(false);
      // The grace: the row is NOT yanked on the death frame; it greys.
      expect(s.churnGrey).toBe(true);
      expect(projectMembership([s]).map((x) => x.id)).toEqual([SID]);
      // A re-broadcast inside the grace must not yank the grey row early.
      fire('sessions', [frameRow({alive: false})], []);
      expect(s.churnGrey).toBe(true);
      // Drain the frames' own notify flushes, so the assertion below can only
      // be satisfied by the grace-end notify itself.
      vi.advanceTimersByTime(250);
      expect(s.churnGrey).toBe(true);
      paints.mockClear();
      vi.advanceTimersByTime(DEATH_GRACE_MS + 300);
      // Grace over: grey lifts, the live list drops it, the archive holds it,
      // and the flip notified the render subscribers (the repaint that
      // removes the row; without it the grey row lingered).
      expect(s.churnGrey).toBe(false);
      expect(projectMembership([s])).toEqual([]);
      expect(projectArchive([s]).map((x) => x.id)).toEqual([SID]);
      expect(paints).toHaveBeenCalled();
    } finally {
      renderSubs.delete(paints);
    }
  });

  test('a restart inside the grace cancels it; the row is back alive with no late flip', () => {
    vi.useFakeTimers();
    const {conn, fire} = fakeConn();
    wireSessions(conn, spyCtx());
    const s = mkSession();
    fire('sessions', [frameRow({alive: false})], []);
    expect(s.churnGrey).toBe(true);
    fire('sessions', [frameRow({alive: true})], []);
    expect(s.alive).toBe(true);
    expect(s.churnGrey).toBe(false);
    vi.advanceTimersByTime(DEATH_GRACE_MS + 300);
    expect(s.alive).toBe(true);
    expect(s.churnGrey).toBe(false);
    expect(projectMembership([s]).map((x) => x.id)).toEqual([SID]);
    expect(projectArchive([s])).toEqual([]);
  });

  test('a session first listed already dead gets NO grace (a cold archive listing)', () => {
    vi.useFakeTimers();
    const {conn, fire} = fakeConn();
    wireSessions(conn, spyCtx());
    // No pre-existing session: the frame itself introduces it, dead.
    fire('sessions', [frameRow({alive: false})], []);
    const s = sessions.get(SID)!;
    expect(s.alive).toBe(false);
    expect(s.churnGrey).toBe(false);
    expect(projectMembership([s])).toEqual([]);
    expect(projectArchive([s]).map((x) => x.id)).toEqual([SID]);
  });

  test('a settled prune of the session clears its pending grace timer', () => {
    vi.useFakeTimers();
    const {conn, fire} = fakeConn();
    wireSessions(conn, spyCtx());
    mkSession();
    fire('sessions', [frameRow({alive: false})], []);
    expect(sessions.has(SID)).toBe(true);
    // The engine stops listing it on a settled frame: the app deletes the row.
    fire('sessions', [], []);
    expect(sessions.has(SID)).toBe(false);
    // The armed grace timer must not act on the deleted id.
    expect(() => vi.advanceTimersByTime(DEATH_GRACE_MS + 300)).not.toThrow();
    expect(sessions.has(SID)).toBe(false);
  });
});

describe('the archive projection and lens (sessionSelectors)', () => {
  test('projectArchive keeps exactly the dead rows; projectRows flips on the lens', () => {
    const live = sess('live');
    const dead = sess('dead', {alive: false});
    const grey = sess('grey', {alive: false, churnGrey: true});
    const base = [live, dead, grey];
    expect(projectArchive(base).map((s) => s.id)).toEqual(['dead', 'grey']);
    // Live lens: the membership (grey grace still shown, plain dead dropped).
    expect(projectRows(base).map((s) => s.id)).toEqual(['live', 'grey']);
    // Archive lens: the dead rows, nothing else.
    sessionState.archiveOpen = true;
    expect(projectRows(base).map((s) => s.id)).toEqual(['dead', 'grey']);
  });

  test('a restarted (re-alive) session returns to the live lens and leaves the archive', () => {
    const s = sess('back', {alive: false});
    expect(projectRows([s])).toEqual([]);
    expect(projectArchive([s]).map((x) => x.id)).toEqual(['back']);
    (s as CycSession & {alive?: boolean}).alive = true;
    expect(projectRows([s]).map((x) => x.id)).toEqual(['back']);
    expect(projectArchive([s])).toEqual([]);
  });

  test('the open dead chat stays in the LIVE lens while open (active-row exception)', () => {
    const deadOpen = sess('deadOpen', {alive: false});
    sessionState.activeId = 'deadOpen';
    expect(projectRows([deadOpen]).map((x) => x.id)).toEqual(['deadOpen']);
    // And it is an archived row too: one dead session, both lists.
    sessionState.archiveOpen = true;
    expect(projectRows([deadOpen]).map((x) => x.id)).toEqual(['deadOpen']);
  });
});

// Drain the pair banner's async discovery paint (real timers only).
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

const row = (id: string, la: number, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  unread: 0,
  lastActivity: la,
  ...over
});
function mkPane() {
  const deps: ListPaneDeps = {
    onTeardown: () => {},
    render: vi.fn(),
    renderRows: vi.fn(),
    openChat: vi.fn(),
    saveDraft: vi.fn(),
    loadDraft: vi.fn(),
    releaseMicIfIdle: vi.fn(),
    rowAudioClick: vi.fn(),
    openPlayingMessage: vi.fn(),
    restored: vi.fn(),
    cancelPendingOpens: vi.fn(),
    restorePending: new Set(),
    setView: vi.fn(),
    wantedHost: () => null,
    clearWantedHost: vi.fn(),
    forgetProgress: vi.fn(),
    paintKeymapFromGlobals: vi.fn(),
    mainColumns: document.createElement('div')
  };
  return {deps, pane: createListPane(deps)};
}

describe('the list pane archive view', () => {
  test('the archive lens shows exactly the dead rows through the one visible set', () => {
    fake.sessions = [
      row('a', 3),
      row('gone1', 5, {alive: false}),
      row('b', 2),
      row('gone2', 4, {alive: false}),
      row('c', 1)
    ];
    const {pane} = mkPane();
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['a', 'b', 'c']);
    sessionState.archiveOpen = true;
    // Latest-first, dead only: the same projector the renderer paints.
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['gone1', 'gone2']);
    // No hints card in the archive.
    expect(pane.projectList(sessionState.activeTabId ?? undefined).cards.hints).toBe(false);
  });

  test('the conversation list carries NO archive affordance; the lens keeps the "Chats" back row above the rows', () => {
    fake.sessions = [row('a', 2)];
    const {pane} = mkPane();
    pane.updateArchiveEntry();
    expect(pane.archiveEntry.hidden).toBe(true);

    // Non-vacuity: archived sessions EXIST, and the live list still shows
    // no entry point (it lives in Settings now) and no pull-down clip.
    fake.sessions = [row('a', 2), row('gone', 3, {alive: false})];
    pane.updateArchiveEntry();
    expect(pane.archiveEntry.hidden).toBe(true);
    expect(pane.sessionListTop.querySelector('.cyc-archive-pull')).toBeNull();

    sessionState.archiveOpen = true;
    pane.updateArchiveEntry();
    expect(pane.archiveEntry.hidden).toBe(false);
    expect(pane.archiveEntry.textContent).toContain('Chats');
    expect(pane.archiveEntry.textContent).toContain('1');
    // A plain visible row directly above the archived rows.
    expect(pane.archiveEntry.nextSibling).toBe(pane.sessionList.el);
  });

  test('the entry stays visible in an EMPTIED archive (the way back), and tapping it flips the lens', () => {
    fake.sessions = [row('gone', 1, {alive: false})];
    const {deps, pane} = mkPane();
    sessionState.archiveOpen = true;
    pane.updateArchiveEntry();
    expect(pane.archiveEntry.hidden).toBe(false);
    // The one archived session restarts: the archive empties, the back row stays.
    fake.sessions = [row('gone', 1, {alive: true})];
    pane.updateArchiveEntry();
    expect(pane.archiveEntry.hidden).toBe(false);
    expect(pane.visibleSessions()).toEqual([]);
    pane.archiveEntry.click();
    expect(sessionState.archiveOpen).toBe(false);
    expect(deps.render).toHaveBeenCalled();
    // Back on the live list the restarted session is a plain row again and
    // the entry hides (nothing archived any more).
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['gone']);
    pane.updateArchiveEntry();
    expect(pane.archiveEntry.hidden).toBe(true);
  });

  test('the pair banner is a live-list affordance: the archive lens hides it, closing it brings it back', async () => {
    fake.engines = [
      {url: 'wss://beta.example', engineId: 'eng-b', host: 'beta', user: 'ub', userHost: 'ub@beta'}
    ];
    fake.sessions = [row('a', 2), row('gone', 3, {alive: false})];
    const {pane} = mkPane();
    const banner = pane.sessionListTop.querySelector<HTMLElement>('.cyc-pair-banner');
    expect(banner).not.toBeNull();
    await settle();
    // Non-vacuity: the unpaired engine actually painted a row, and the
    // banner is visible on the live list (both gates off).
    expect(banner!.querySelectorAll('.cyc-pair-banner-row').length).toBe(1);
    expect(banner!.classList.contains('cyc-off')).toBe(false);
    expect(banner!.hidden).toBe(false);

    // Lens open: renderRows' updateArchiveEntry pass (the surface re-keys on
    // archiveOpen, proven in cycRenderHub) hides the banner.
    sessionState.archiveOpen = true;
    pane.updateArchiveEntry();
    expect(banner!.hidden).toBe(true);

    // A discovery repaint inside the lens must not resurrect it: the banner's
    // own paint only toggles cyc-off, never the lens gate.
    fake.keyringListeners.forEach((f) => f());
    await settle();
    expect(banner!.hidden).toBe(true);
    expect(banner!.querySelectorAll('.cyc-pair-banner-row').length).toBe(1);

    // Lens closed: the same pass shows it again, live-list state intact.
    sessionState.archiveOpen = false;
    pane.updateArchiveEntry();
    expect(banner!.hidden).toBe(false);
    expect(banner!.classList.contains('cyc-off')).toBe(false);
    expect(banner!.querySelectorAll('.cyc-pair-banner-row').length).toBe(1);
  });

  test('a pane built with the lens already open starts with the banner hidden', async () => {
    fake.engines = [
      {url: 'wss://beta.example', engineId: 'eng-b', host: 'beta', user: 'ub', userHost: 'ub@beta'}
    ];
    fake.sessions = [row('gone', 1, {alive: false})];
    sessionState.archiveOpen = true;
    const {pane} = mkPane();
    const banner = pane.sessionListTop.querySelector<HTMLElement>('.cyc-pair-banner')!;
    expect(banner.hidden).toBe(true);
    await settle();
    // The async discovery paint landed a row but did not unhide the banner.
    expect(banner.querySelectorAll('.cyc-pair-banner-row').length).toBe(1);
    expect(banner.hidden).toBe(true);
    sessionState.archiveOpen = false;
    pane.updateArchiveEntry();
    expect(banner.hidden).toBe(false);
  });

  test('reading an archived chat is the ordinary row open; the open dead chat also stays on the live list', () => {
    fake.sessions = [row('a', 2), row('gone', 3, {alive: false})];
    const {pane} = mkPane();
    sessionState.activeId = 'gone';
    // Live lens keeps the open dead chat visible (existing exception).
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['gone', 'a']);
    // Archive lens lists it too, where its history is read.
    sessionState.archiveOpen = true;
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['gone']);
  });
});
