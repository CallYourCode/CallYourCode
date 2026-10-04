import {beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycSession} from '../types';

// The owner's bug: keyboard nav walked the RAW tab set (tabSessions), which
// still holds dead sessions the list never paints, so ArrowDown stepped onto
// unlisted, offline agents. The fix is one shared source, visibleSessions
// (projectList -> projectMembership, then the search filter), that both the
// renderer and the nav iterate. This file exercises it with the REAL
// sessionSelectors (real projectMembership, real orderByLatest): mocking the
// projection would make every assertion here vacuous.
const fake = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  tabs: [] as Array<{id: string; label: string; state: string; unread: number; activity: boolean}>
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
// sessionSelectors is deliberately NOT mocked; see the header comment.
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
vi.mock('../engine/contract', () => ({enginePin: (): string | null => null}));
vi.mock('../features/pairing/pairBanner', () => ({
  createPairBanner: () => document.createElement('div')
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
import {createListPane, type ListPaneDeps} from '../features/sessions/panes/listPane';
import {sessionState, dataState} from '../sessionState';

const row = (id: string, la: number, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  unread: 0,
  lastActivity: la,
  ...over
});
function mk() {
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
beforeEach(() => {
  fake.sessions = [];
  fake.tabs = [];
  dataState.mode = 'live';
  sessionState.activeId = null;
  sessionState.activeTabId = 'e1#t1';
  vi.clearAllMocks();
});

describe('visibleSessions: the one row set keyboard nav may walk', () => {
  test('dead rows outside membership sit in the raw tab set but never in the visible set', () => {
    fake.sessions = [
      row('a', 3),
      row('dead1', 5, {alive: false}),
      row('b', 2),
      row('grey', 4, {alive: false, churnGrey: true}),
      row('c', 1)
    ];
    const {pane} = mk();
    // Non-vacuity: the raw set the OLD nav iterated really contains the dead
    // row, so old nav from 'grey' (its neighbour by recency) landed on it.
    expect(pane.tabSessions().map((s) => s.id)).toContain('dead1');
    // The visible set drops it, keeps the churnGrey dead row the list paints,
    // and comes back in painted order (latest first).
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['grey', 'a', 'b', 'c']);
  });

  test('the open dead chat stays a visible row (membership keeps the active id)', () => {
    fake.sessions = [row('a', 2), row('deadOpen', 3, {alive: false})];
    const {pane} = mk();
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['a']);
    sessionState.activeId = 'deadOpen';
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['deadOpen', 'a']);
  });

  test('the search filter constrains the set the same way the renderer paints it', () => {
    fake.sessions = [
      row('alpha', 3),
      row('beta', 2, {title: {text: 'alpine build'}}),
      row('gamma', 1)
    ];
    const {pane} = mk();
    pane.listFilter.query = 'alp';
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['alpha', 'beta']);
    pane.listFilter.query = 'gam';
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['gamma']);
    pane.listFilter.query = '';
    expect(pane.visibleSessions().map((s) => s.id)).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('the renderer path (precomputed projected rows) agrees with the nav path', () => {
    fake.sessions = [row('a', 2), row('dead1', 3, {alive: false}), row('b', 1)];
    const {pane} = mk();
    pane.listFilter.query = 'a';
    const projected = pane.projectList(sessionState.activeTabId ?? undefined).rows;
    expect(pane.visibleSessions(projected).map((s: CycSession) => s.id)).toEqual(
      pane.visibleSessions().map((s: CycSession) => s.id)
    );
    expect(pane.visibleSessions(projected).map((s: CycSession) => s.id)).toEqual(['a']);
  });
});
