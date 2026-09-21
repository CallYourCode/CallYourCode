import {afterAll, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';
import type {CycSession} from '../types';
const fake = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  tabs: [] as Array<{id: string; label: string; state: string; unread: number; activity: boolean}>,
  windowActive: false,
  notify: true,
  merged: false,
  chip: {harness: true, model: true} as Record<string, boolean>,
  listOpts: null as Record<string, unknown> | null,
  status: 'live' as 'offline' | 'connecting' | 'syncing' | 'live',
  statusSubs: [] as Array<(s: 'offline' | 'connecting' | 'syncing' | 'live') => void>
}));
vi.mock('../engine/store', () => ({
  tabs: () => fake.tabs,
  list: () => fake.sessions,
  get: (id: string) => fake.sessions.find((s) => s.id === id),
  activityMark: () => false,
  effectiveNotify: () => fake.notify,
  detachChat: vi.fn(),
  engineKeyOfTab: () => 'e1',
  engineReachable: () => fake.status === 'live',
  syncStatus: () => fake.status,
  onSyncStatus: (cb: (typeof fake.statusSubs)[number]) => {
    fake.statusSubs.push(cb);
    return () => {
      fake.statusSubs = fake.statusSubs.filter((f) => f !== cb);
    };
  },
  exitSession: vi.fn(async () => true),
  newSessionPlaces: vi.fn(async () => ({
    places: [],
    home: '/home/u',
    def: null,
    harnesses: [],
    recent: []
  })),
  recentlyClosed: vi.fn(async () => []),
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
  startSettingsSync: vi.fn()
}));
vi.mock('../sessionSelectors', () => ({
  activeEngineKey: () => 'e1',
  sortedLive: () => fake.sessions as unknown as CycSession[],
  orderByLatest: (l: CycSession[]) => l,
  projectMembership: (l: CycSession[]) => l,
  projectRows: (l: CycSession[]) => l,
  projectArchive: (l: CycSession[]) => l.filter((s) => (s as {alive?: boolean}).alive === false),
  tabLabelOf: () => 'host',
  isPluginCardEngine: () => false,
  visibleTabs: () => fake.tabs
}));
vi.mock('../shared/browser', () => ({
  active: () => fake.windowActive,
  begin: vi.fn(),
  onSettle: vi.fn()
}));
vi.mock('../features/settings/preferences', () => ({
  sortByLatest: () => true,
  mergeTabs: () => fake.merged,
  rowChipShown: (id: string) => fake.chip[id] ?? true,
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
  createSessionList: (opts: Record<string, unknown>) => {
    fake.listOpts = opts;
    return {
      el: document.createElement('div'),
      update: vi.fn(),
      setConversationMode: vi.fn(),
      setRowAudioState: vi.fn()
    };
  }
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
import {openMenu} from '../components/popupMenu';
import {toast} from '../components/widgets';
import * as store from '../engine/store';
const row = (id: string, la: number) => ({id, name: id, unread: 0, lastActivity: la});
function mk(over: Partial<ListPaneDeps> = {}) {
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
    mainColumns: document.createElement('div'),
    ...over
  };
  return {deps, pane: createListPane(deps)};
}
beforeEach(() => {
  fake.sessions = [];
  fake.tabs = [];
  fake.windowActive = false;
  fake.status = 'live';
  fake.statusSubs = [];
  fake.merged = false;
  fake.chip = {harness: true, model: true};
  fake.listOpts = null;
  dataState.mode = 'live';
  sessionState.activeId = null;
  sessionState.activeTabId = 'e1#t1';
  vi.clearAllMocks();
});
describe('the S7 re-sort freeze', () => {
  test('a guarded list holds its captured order; the flush repaints once, only if it moved', () => {
    fake.sessions = [row('a', 2), row('b', 1)];
    const {pane, deps} = mk();
    fake.windowActive = true;
    pane.captureFrozen();
    expect(pane.tabSessions().map((s) => s.id)).toEqual(['a', 'b']);
    fake.sessions = [row('b', 9), row('a', 2)];
    expect(pane.tabSessions().map((s) => s.id)).toEqual(['a', 'b']);
    fake.windowActive = false;
    pane.flushResort();
    expect(deps.renderRows).toHaveBeenCalledTimes(1);
    expect(pane.tabSessions().map((s) => s.id)).toEqual(['b', 'a']);
    pane.flushResort();
    expect(deps.renderRows).toHaveBeenCalledTimes(1);
  });
  test('a row that arrives while held slots by recency instead of falling to the bottom', () => {
    fake.sessions = [row('a', 5), row('b', 3)];
    const {pane} = mk();
    fake.windowActive = true;
    pane.captureFrozen();
    fake.sessions = [row('c', 4), row('a', 5), row('b', 3)];
    expect(pane.tabSessions().map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });
});
describe('the host tab strip', () => {
  const tab = (id: string, over: Partial<(typeof fake.tabs)[0]> = {}) => ({
    id,
    label: id,
    state: 'connected',
    unread: 0,
    activity: false,
    ...over
  });
  test('two tabs show the strip; unread wears blue and beats the grey blob', () => {
    fake.tabs = [tab('e1#t1'), tab('e1#t2', {unread: 3, activity: true})];
    const {pane} = mk();
    pane.renderTabs();
    const tabs = pane.leftMain.querySelectorAll('.cyc-seg');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.classList.contains('active')).toBe(true);
    const badges = pane.leftMain.querySelectorAll('.cyc-seg-count');
    expect(badges[1]!.textContent).toBe('3');
    const dots = pane.leftMain.querySelectorAll<HTMLElement>('.cyc-seg-activity');
    expect(dots[1]!.hidden).toBe(true);
  });
  test('the first tab selected after the live hello gives engine-level cards a scope', () => {
    fake.tabs = [tab('e1#t1'), tab('e2#t1')];
    sessionState.activeTabId = null;
    const {pane} = mk();
    pane.renderTabs();
    expect(sessionState.activeTabId).toBe('e1#t1');
  });
  test('the URL host resolves once against the fleet, then the hold is released', () => {
    fake.tabs = [tab('e1#t1'), tab('e2#t1')];
    const {pane, deps} = mk({wantedHost: () => 'op:e2#t1'});
    pane.renderTabs();
    expect(sessionState.activeTabId).toBe('e2#t1');
    expect(deps.clearWantedHost).toHaveBeenCalledTimes(1);
    expect(deps.restored).toHaveBeenCalledWith('host');
  });
  test('switchTab on a stacked layout lands on the list, never inside the chat', () => {
    fake.tabs = [tab('e1#t1'), tab('e2#t1')];
    fake.sessions = [row('e2|p1', 1)];
    sessionState.tabSelection.set('e2#t1', 'e2|p1');
    const {pane, deps} = mk();
    pane.switchTab('e2#t1');
    expect(deps.cancelPendingOpens).toHaveBeenCalledWith('tab');
    expect(sessionState.activeTabId).toBe('e2#t1');
    expect(deps.setView).toHaveBeenCalledWith('list');
    expect(deps.openChat).not.toHaveBeenCalled();
    pane.switchTab('e2#t1');
    expect(deps.setView).toHaveBeenCalledTimes(1);
  });
});
describe('resolved bell and badge', () => {
  test('notifyOn asks the store resolver; updateBadge sums the unread counts', () => {
    const {pane} = mk();
    expect(pane.notifyOn('s1')).toBe(true);
    fake.notify = false;
    expect(pane.notifyOn('s1')).toBe(false);
    fake.notify = true;
    const set = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    (navigator as unknown as {setAppBadge: unknown; clearAppBadge: unknown}).setAppBadge = set;
    (navigator as unknown as {clearAppBadge: unknown}).clearAppBadge = clear;
    fake.sessions = [
      Object.assign(row('a', 1), {unread: 2}),
      Object.assign(row('b', 1), {unread: 7})
    ];
    pane.updateBadge();
    expect(set).toHaveBeenCalledWith(9);
    fake.sessions = [];
    pane.updateBadge();
    expect(clear).toHaveBeenCalled();
  });
});
describe('presentation current from sessions.css onto the pane producers', () => {
  test('the header status word says offline/connecting/syncing and nothing while live', () => {
    const {pane} = mk();
    expect(pane.syncStatusEl.className).toContain('cyc-sync-status');
    expect(pane.syncStatusEl.textContent).toBe('');
    const say = (st: typeof fake.status) => {
      fake.status = st;
      for (const cb of fake.statusSubs) cb(st);
    };
    say('connecting');
    expect(pane.syncStatusEl.textContent).toBe('connecting');
    say('offline');
    expect(pane.syncStatusEl.textContent).toBe('offline');
    say('syncing');
    expect(pane.syncStatusEl.textContent).toBe('syncing');
    say('live');
    expect(pane.syncStatusEl.textContent).toBe('');
  });

  test('the connectivity word is a bottom overlay band (out of flow), not a reserved header strip', () => {
    const {pane} = mk();
    const btnContainer = pane.burger.parentElement!;
    const headerRow = btnContainer.parentElement!;
    const leftHeader = headerRow.parentElement!;
    // Only the burger and the search bar are in the row, and the header column now
    // holds ONLY that row: no sync-status strip reserves any height below it.
    expect(headerRow.children.length).toBe(2);
    expect(leftHeader.contains(pane.syncStatusEl)).toBe(false);
    expect(headerRow.contains(pane.syncStatusEl)).toBe(false);
    // The band lives in the list content, pinned to the bottom and overlaying the
    // rows: absolute (out of flow), full-width, above the safe area, and it never
    // steals taps (pointer-events-none). No reserved min-height anywhere.
    expect(pane.leftContent.contains(pane.syncStatusEl)).toBe(true);
    expect(pane.syncStatusEl.className).toContain('absolute');
    expect(pane.syncStatusEl.className).toContain('bottom-0');
    expect(pane.syncStatusEl.className).toContain('pointer-events-none');
    expect(pane.syncStatusEl.className).toContain('var(--cyc-safe-bottom)');
    expect(pane.syncStatusEl.className).not.toMatch(/\bmin-h-\[/);
    // It is absent (slid + faded away via cyc-sync-live) while live, and present
    // only when there is a status word to show, so nothing ever jumps.
    const say = (st: typeof fake.status) => {
      fake.status = st;
      for (const cb of fake.statusSubs) cb(st);
    };
    say('connecting');
    expect(pane.syncStatusEl.classList.contains('cyc-sync-live')).toBe(false);
    expect(pane.syncStatusEl.textContent).toBe('connecting');
    say('live');
    expect(pane.syncStatusEl.classList.contains('cyc-sync-live')).toBe(true);
    expect(pane.syncStatusEl.textContent).toBe('');
  });

  test('the conversation FAB carries the conv-on green + pulse self variants', () => {
    const {pane} = mk();
    const fab = pane.floatingAction.className;
    expect(fab).toContain('bg-[var(--cyc-accent)]');
    expect(fab).toContain('[&.cyc-conv-on]:bg-[#4ec97b]!');
    expect(fab).toContain('[&.cyc-conv-on]:[animation:cyc-pulse_1.6s_infinite]');
  });
});

describe('the new-session menu', () => {
  const clickFab = async (pane: ReturnType<typeof mk>['pane']) => {
    const floatingAction = pane.leftContent.querySelector('.cyc-new-conversation') as HTMLElement;
    floatingAction.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await vi.waitFor(() => expect(openMenu).toHaveBeenCalled());
    return vi.mocked(openMenu).mock.calls[0]![0] as {text: string; onClick(): void}[];
  };
  // Old engine (harnesses/recent absent): the menu behaves byte-stable, no
  // harness step, and startSession is called with the harness arg undefined.
  test('the engine default place leads the menu; no Home row when def is known', async () => {
    vi.mocked(store.newSessionPlaces).mockResolvedValueOnce({
      places: ['/home/u/callyourcode', '/w/app'],
      home: '/home/u',
      def: '/home/u/callyourcode'
    } as never);
    const {pane} = mk();
    const items = await clickFab(pane);
    expect(items.map((i) => i.text)).toEqual(['u/callyourcode', 'w/app']);
    items[0]!.onClick();
    expect(store.startSession).toHaveBeenCalledWith(
      'e1',
      '/home/u/callyourcode',
      undefined,
      undefined
    );
  });
  test('an engine naming no def gives the old menu, Home first', async () => {
    vi.mocked(store.newSessionPlaces).mockResolvedValueOnce({
      places: ['/w/app'],
      home: '/home/u',
      def: null
    } as never);
    const {pane} = mk();
    const items = await clickFab(pane);
    expect(items.map((i) => i.text)).toEqual(['Home', 'w/app']);
  });

  test('only claude available: no harness step, starts with the claude harness', async () => {
    vi.mocked(store.newSessionPlaces).mockResolvedValueOnce({
      places: ['/w/app'],
      home: '/home/u',
      def: null,
      harnesses: [{kind: 'claude', available: true}],
      recent: []
    });
    const {pane} = mk();
    const items = await clickFab(pane);
    // The folder menu opened directly (only one openMenu call so far).
    expect(vi.mocked(openMenu)).toHaveBeenCalledTimes(1);
    expect(items.map((i) => i.text)).toEqual(['Home', 'w/app']);
    items[1]!.onClick();
    expect(store.startSession).toHaveBeenCalledWith('e1', '/w/app', undefined, 'claude');
  });

  test('none installed: no menu, the toast names the harnesses to install', async () => {
    // A current engine reports its list with NOTHING available (a fresh box):
    // the fab must not offer folders (a start would only be refused) and must
    // say what to install instead.
    vi.mocked(store.newSessionPlaces).mockResolvedValueOnce({
      places: ['/w/app'],
      home: '/home/u',
      def: null,
      harnesses: [
        {kind: 'claude', available: false},
        {kind: 'codex', available: false}
      ],
      recent: []
    });
    const {pane} = mk();
    const floatingAction = pane.leftContent.querySelector('.cyc-new-conversation') as HTMLElement;
    floatingAction.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Install a coding harness first: claude code, codex, opencode or pi'
      )
    );
    expect(vi.mocked(openMenu)).not.toHaveBeenCalled();
    expect(store.startSession).not.toHaveBeenCalled();
  });

  test('two available: harness step first (unavailable hidden), then the folder menu', async () => {
    vi.mocked(store.newSessionPlaces).mockResolvedValueOnce({
      places: ['/w/app'],
      home: '/home/u',
      def: null,
      harnesses: [
        {kind: 'claude', available: true},
        {kind: 'codex', available: true},
        {kind: 'opencode', available: false}
      ],
      recent: []
    });
    const {pane} = mk();
    const harnessItems = (await clickFab(pane)) as unknown as {
      text: string;
      onClick(e: MouseEvent): void;
    }[];
    // First menu is the harness picker: only available kinds, no OpenCode.
    expect(harnessItems.map((i) => i.text)).toEqual(['Claude', 'Codex']);
    expect(vi.mocked(openMenu)).toHaveBeenCalledTimes(1);
    // Tapping a harness row must DEFER the folder-menu open (popupMenu closes
    // the current menu right after onClick). Nothing happens until the timer.
    vi.useFakeTimers();
    try {
      harnessItems[1]!.onClick(new MouseEvent('click'));
      expect(vi.mocked(openMenu)).toHaveBeenCalledTimes(1);
      vi.runAllTimers();
      expect(vi.mocked(openMenu)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    const folderItems = vi.mocked(openMenu).mock.calls[1]![0] as {
      text: string;
      onClick(): void;
    }[];
    expect(folderItems.map((i) => i.text)).toEqual(['Home', 'w/app']);
    folderItems[1]!.onClick();
    expect(store.startSession).toHaveBeenCalledWith('e1', '/w/app', undefined, 'codex');
  });

  test('recent section renders under the live rows and starts in the recent cwd', async () => {
    vi.mocked(store.newSessionPlaces).mockResolvedValueOnce({
      places: ['/w/app'],
      home: '/home/u',
      def: null,
      harnesses: [{kind: 'claude', available: true}],
      recent: ['/old/proj']
    });
    const {pane} = mk();
    const items = (await clickFab(pane)) as unknown as {
      text: string;
      section?: boolean;
      onClick(): void;
    }[];
    const texts = items.map((i) => i.text);
    expect(texts).toEqual(['Home', 'w/app', 'Recent', 'old/proj']);
    const sectionRow = items.find((i) => i.section);
    expect(sectionRow?.text).toBe('Recent');
    items[3]!.onClick();
    expect(store.startSession).toHaveBeenCalledWith('e1', '/old/proj', undefined, 'claude');
  });

  test('recently-closed section renders above the folders and reopens the agent', async () => {
    vi.mocked(store.newSessionPlaces).mockResolvedValueOnce({
      places: ['/w/app'],
      home: '/home/u',
      def: null,
      harnesses: [{kind: 'claude', available: true}],
      recent: []
    });
    vi.mocked(store.recentlyClosed).mockResolvedValueOnce([
      {
        agentId: 'ag-AAAAAAAAAAAAAAAA',
        name: 'Ada',
        harness: 'claude',
        cwd: '/old/proj',
        canResume: true
      }
    ]);
    const {pane} = mk();
    const items = (await clickFab(pane)) as unknown as {
      text: string;
      section?: boolean;
      onClick(): void;
    }[];
    // The section leads the menu, above Home/w/app.
    expect(items.map((i) => i.text)).toEqual([
      'Recently closed',
      'Ada · claude · proj',
      'Home',
      'w/app'
    ]);
    expect(items.find((i) => i.section)?.text).toBe('Recently closed');
    // Tapping the agent reopens it with {agentId, resume:true}.
    items[1]!.onClick();
    expect(store.startSession).toHaveBeenCalledWith('e1', '/old/proj', undefined, undefined, {
      agentId: 'ag-AAAAAAAAAAAAAAAA',
      resume: true
    });
  });

  // The engine refuses when the chosen harness is not installed on its host
  // (session-ops /new-session typed refusal). startSession maps that to
  // {paneId:'', notInstalled:true, why:<server sentence>}; the menu must show
  // that sentence, NOT the misleading "Started it ... has not appeared" line
  // that a genuinely slow-to-register start would eventually toast.
  test('a harness-missing refusal toasts the engine sentence, not the timeout line', async () => {
    vi.mocked(store.newSessionPlaces).mockResolvedValueOnce({
      places: ['/w/app'],
      home: '/home/u',
      def: null,
      harnesses: [{kind: 'claude', available: true}],
      recent: []
    });
    vi.mocked(store.startSession).mockResolvedValueOnce({
      paneId: '',
      agentId: '',
      why: 'claude is not installed on this host',
      notInstalled: true
    });
    const {pane} = mk();
    const items = await clickFab(pane);
    items[1]!.onClick(); // "w/app"
    await vi.waitFor(() =>
      expect(vi.mocked(toast)).toHaveBeenCalledWith('claude is not installed on this host')
    );
    // never the generic wrapper, never the timeout sentence
    expect(vi.mocked(toast)).not.toHaveBeenCalledWith(
      'Could not start it: claude is not installed on this host'
    );
    for (const [arg] of vi.mocked(toast).mock.calls) {
      expect(String(arg)).not.toContain('has not appeared');
    }
  });
});

// Browser cascade coverage for the conversation FAB.
const CASCADE_HERE = dirname(fileURLToPath(import.meta.url));
const CASCADE_SHELL = resolve(CASCADE_HERE, '..', 'shell');
const cascadeRequire = createRequire(import.meta.url);
const CASCADE_TW_DIR = dirname(cascadeRequire.resolve('tailwindcss/package.json'));

async function compileFabUtilities(candidates: string[]): Promise<string> {
  const entry = readFileSync(resolve(CASCADE_SHELL, 'tailwind.css'), 'utf8');
  const compiler = await compile(entry, {
    base: CASCADE_SHELL,
    async loadStylesheet(id: string, base: string) {
      const path =
        id === 'tailwindcss'
          ? resolve(CASCADE_TW_DIR, 'index.css')
          : resolve(base, id.replace(/^tailwindcss\//, `${CASCADE_TW_DIR}/`));
      return {base: dirname(path), content: readFileSync(path, 'utf8'), path};
    },
    async loadModule(id: string) {
      return {path: id, base: CASCADE_SHELL, module: {} as never};
    }
  });
  return compiler.build(candidates);
}

const cascadeTokenize = (className: string) => className.trim().split(/\s+/).filter(Boolean);

const FAB_THEME_VARS = `
:root {
  --cyc-accent: rgb(1, 2, 3);
  --cyc-accent-pressed: rgb(4, 5, 6);
}
`;

let fabBrowser: Browser;
const getFabBrowser = async () => (fabBrowser ??= await chromium.launch());

// Render FAB states against the application cascade.
async function measureFab(fabClass: string): Promise<{
  resting: string;
  armed: string;
  hover: string;
}> {
  const utilities = await compileFabUtilities(cascadeTokenize(fabClass));
  const shell =
    readFileSync(resolve(CASCADE_SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CASCADE_SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    FAB_THEME_VARS;
  // Separate containers keep the test FABs independently targetable.
  const box = 'position:relative;display:inline-block;width:120px;height:120px';
  const html =
    `<!DOCTYPE html><html data-pointer="fine"><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell */\n${shell}</style></head><body>` +
    `<div style="${box}"><button id="rest" class="${fabClass}"></button></div>` +
    `<div style="${box}"><button id="armed" class="${fabClass} cyc-conv-on"></button></div>` +
    `</body></html>`;
  const page = await (await getFabBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    const bg = (sel: string) =>
      page.$eval(sel, (el) => getComputedStyle(el).getPropertyValue('background-color'));
    const resting = await bg('#rest');
    const armed = await bg('#armed');
    await page.hover('#rest'); // live :hover so the fine:hover utility applies
    const hover = await bg('#rest');
    return {resting, armed, hover};
  } finally {
    await page.close();
  }
}

afterAll(async () => {
  await fabBrowser?.close();
});

// Render the real list header (leftHeader > headerRow > search) under a
// #cyc-left-pane ancestor against the compiled cascade and measure the vertical
// gap above vs below the search row in a browser.
async function measureHeaderGeometry(
  leftHeaderClass: string,
  headerRowClass: string,
  searchClass: string
): Promise<{topGap: number; bottomGap: number}> {
  const candidates = cascadeTokenize(`${leftHeaderClass} ${headerRowClass} ${searchClass}`);
  const utilities = await compileFabUtilities(candidates);
  const reset = readFileSync(resolve(CASCADE_SHELL, 'reset.css'), 'utf8');
  const shell =
    reset +
    '\n' +
    readFileSync(resolve(CASCADE_SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CASCADE_SHELL, 'utilities.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell */\n${shell}\n:root{--cyc-safe-top:0px;--cyc-safe-bottom:0px}</style></head><body>` +
    `<div id="cyc-left-pane" style="width:320px">` +
    `<div id="header" class="${leftHeaderClass}">` +
    `<div id="row" class="${headerRowClass}">` +
    `<button style="width:40px;height:40px"></button>` +
    `<div id="search" class="${searchClass}">search</div></div></div></div></body></html>`;
  const page = await (await getFabBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    const gaps = await page.evaluate(() => {
      const header = document.getElementById('header')!;
      const search = document.getElementById('search')!;
      const cs = getComputedStyle(header);
      const hb = header.getBoundingClientRect();
      const sb = search.getBoundingClientRect();
      const padTop = parseFloat(cs.paddingTop);
      const padBottom = parseFloat(cs.paddingBottom);
      return {
        topGap: sb.top - (hb.top + padTop),
        bottomGap: hb.bottom - padBottom - sb.bottom
      };
    });
    return gaps;
  } finally {
    await page.close();
  }
}

describe('conversation FAB cascade: the armed green must beat the un-layered .cyc-action-float', () => {
  test('armed FAB paints #4ec97b; resting stays primary and hover stays dark-primary', async () => {
    const {pane} = mk();
    const s = await measureFab(pane.floatingAction.className);
    expect(s.armed).toBe('rgb(78, 201, 123)'); // #4ec97b
    expect(s.resting).toBe('rgb(1, 2, 3)'); // --cyc-accent, not green
    expect(s.hover).toBe('rgb(4, 5, 6)'); // --cyc-accent-pressed, not green
  });
});

describe('list header geometry: even padding around the search row', () => {
  test('the space above the search equals the space below it (even, not top-heavy)', async () => {
    const {pane} = mk();
    const btnContainer = pane.burger.parentElement!;
    const headerRow = btnContainer.parentElement!;
    const leftHeader = headerRow.parentElement!;
    const search = headerRow.children[1] as HTMLElement;
    const g = await measureHeaderGeometry(
      leftHeader.className,
      headerRow.className,
      search.className
    );
    // Real padding both sides, and within a pixel of each other (was 8px top /
    // 4px bottom before the fix).
    expect(g.topGap).toBeGreaterThan(0);
    expect(g.bottomGap).toBeGreaterThan(0);
    expect(Math.abs(g.topGap - g.bottomGap)).toBeLessThanOrEqual(1);
  });
});

describe('list wheel paging (local tab swipe)', () => {
  const stab = (id: string) => ({id, label: id, state: 'connected', unread: 0, activity: false});
  const wheel = (el: EventTarget, deltaX: number, deltaY = 0) => {
    const e = new Event('wheel', {bubbles: true, cancelable: true});
    Object.assign(e, {deltaX, deltaY});
    el.dispatchEvent(e);
    return e;
  };
  test('a committed horizontal wheel swipes to the neighbouring tab', async () => {
    fake.tabs = [stab('e1#t1'), stab('e2#t1')];
    sessionState.activeTabId = 'e1#t1';
    const {pane} = mk();
    pane.renderTabs();
    wheel(pane.listScroll, 100);
    await new Promise((r) => setTimeout(r, 150));
    expect(sessionState.activeTabId).toBe('e2#t1');
  });
  test('a single tab ignores the horizontal wheel (nothing to page)', () => {
    fake.tabs = [stab('e1#t1')];
    sessionState.activeTabId = 'e1#t1';
    const {pane} = mk();
    pane.renderTabs();
    const e = wheel(pane.listScroll, 100);
    expect(e.defaultPrevented).toBe(false);
    expect(sessionState.activeTabId).toBe('e1#t1');
  });
});

describe('agent chips (own settings toggles, host chip stays merged-only)', () => {
  type ChipOpts = {
    mergedSubtitle: (s: CycSession) => string | null;
    harnessChip: (s: CycSession) => string | null;
    modelChip: (s: CycSession) => string | null;
  };
  const seed = () => {
    fake.sessions = [
      {id: 'a', name: 'a', unread: 0, lastActivity: 1, agentName: 'Codex', model: 'Fable 5'}
    ];
    mk();
    return {
      opts: fake.listOpts as unknown as ChipOpts,
      s: fake.sessions[0] as unknown as CycSession
    };
  };
  test('harness and model chips paint in the per-host (non-merged) list too', () => {
    const {opts, s} = seed();
    fake.merged = false;
    // The HOST chip keeps its merged-only rule; the agent chips do not.
    expect(opts.mergedSubtitle(s)).toBeNull();
    expect(opts.harnessChip(s)).toBe('Codex');
    expect(opts.modelChip(s)).toBe('Fable 5');
    fake.merged = true;
    expect(opts.mergedSubtitle(s)).toBe('host');
    expect(opts.harnessChip(s)).toBe('Codex');
    expect(opts.modelChip(s)).toBe('Fable 5');
  });
  test('each chip follows its own toggle, independently', () => {
    const {opts, s} = seed();
    fake.chip = {harness: false, model: true};
    expect(opts.harnessChip(s)).toBeNull();
    expect(opts.modelChip(s)).toBe('Fable 5');
    fake.chip = {harness: true, model: false};
    expect(opts.harnessChip(s)).toBe('Codex');
    expect(opts.modelChip(s)).toBeNull();
    fake.chip = {harness: false, model: false};
    expect(opts.harnessChip(s)).toBeNull();
    expect(opts.modelChip(s)).toBeNull();
  });
  test('an absent fact stays chipless even with the toggle on', () => {
    const {opts} = seed();
    const bare = {id: 'b', name: 'b'} as unknown as CycSession;
    expect(opts.harnessChip(bare)).toBeNull();
    expect(opts.modelChip(bare)).toBeNull();
  });
});

// Touch-swipe paging thresholds on the list surface: micro-jitters and taps never
// page, a mostly-vertical drag scrolls, a sub-threshold drag snaps back, a
// past-threshold drag pages to the neighbouring tab. jsdom advertises touch (not
// pointer) support, so the gesture wrapper binds touch events here; a real
// browser binds pointer events through the same wrapper. jsdom has no Touch
// constructor, so we pass plain touch-shaped objects plus a controlled timeStamp.
describe('list swipe paging thresholds (local tab swipe)', () => {
  const stab = (id: string) => ({id, label: id, state: 'connected', unread: 0, activity: false});
  interface Pt {
    x: number;
    y: number;
    t: number;
  }
  const tev = (type: string, target: EventTarget, s: Pt): TouchEvent => {
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
  };
  const drag = (target: EventTarget, down: Pt, moves: Pt[], up: Pt) => {
    target.dispatchEvent(tev('touchstart', target, down));
    for (const m of moves) window.dispatchEvent(tev('touchmove', target, m));
    window.dispatchEvent(tev('touchend', target, up));
  };
  const twoTabs = () => {
    fake.tabs = [stab('e1#t1'), stab('e2#t1')];
    sessionState.activeTabId = 'e1#t1';
    const {pane} = mk();
    pane.renderTabs();
    // jsdom reports clientWidth 0, which clamps the streamed offset to 1px and
    // hides the raw-vs-slop difference; give the surface a phone-ish width so
    // the painted transform is observable.
    Object.defineProperty(pane.listScroll, 'clientWidth', {get: () => 400, configurable: true});
    return pane;
  };
  test('a 5px movement never pages', async () => {
    const pane = twoTabs();
    drag(pane.listScroll, {x: 100, y: 100, t: 0}, [{x: 95, y: 100, t: 120}], {
      x: 95,
      y: 100,
      t: 360
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(sessionState.activeTabId).toBe('e1#t1');
  });
  test('a mostly-vertical drag never activates paging', async () => {
    const pane = twoTabs();
    pane.listScroll.dispatchEvent(tev('touchstart', pane.listScroll, {x: 100, y: 100, t: 0}));
    window.dispatchEvent(tev('touchmove', pane.listScroll, {x: 96, y: 140, t: 120})); // dy leads
    window.dispatchEvent(tev('touchmove', pane.listScroll, {x: 220, y: 140, t: 240})); // dead
    window.dispatchEvent(tev('touchend', pane.listScroll, {x: 220, y: 140, t: 360}));
    await new Promise((r) => setTimeout(r, 150));
    expect(sessionState.activeTabId).toBe('e1#t1');
  });
  test('a sub-threshold drag snaps back without paging', async () => {
    const pane = twoTabs();
    // 30px left = 7.5% of 400, well under the 50% commit line.
    drag(pane.listScroll, {x: 100, y: 100, t: 0}, [{x: 70, y: 100, t: 120}], {
      x: 70,
      y: 100,
      t: 360
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(sessionState.activeTabId).toBe('e1#t1');
  });
  test('a partial (~17%) drag no longer pages: it snaps back', async () => {
    // The old fixed 60px line paged this 70px release; the fraction rule holds it.
    const pane = twoTabs();
    drag(
      pane.listScroll,
      {x: 200, y: 100, t: 0},
      [
        {x: 165, y: 100, t: 120},
        {x: 130, y: 100, t: 240}
      ], // 70px = 17.5%
      {x: 130, y: 100, t: 360}
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(sessionState.activeTabId).toBe('e1#t1');
  });
  test('a past-threshold drag pages to the neighbouring tab', async () => {
    const pane = twoTabs();
    drag(
      pane.listScroll,
      {x: 300, y: 100, t: 0},
      [
        {x: 170, y: 100, t: 120},
        {x: 40, y: 100, t: 240}
      ], // 260px left = 65%
      {x: 40, y: 100, t: 360}
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(sessionState.activeTabId).toBe('e2#t1');
  });
  test('an 11px movement stays under the arm gate: zero transform', () => {
    const pane = twoTabs();
    pane.listScroll.dispatchEvent(tev('touchstart', pane.listScroll, {x: 200, y: 100, t: 0}));
    window.dispatchEvent(tev('touchmove', pane.listScroll, {x: 189, y: 100, t: 120})); // 11px < arm
    expect(pane.sessionListTop.style.transform).toBe('');
    window.dispatchEvent(tev('touchend', pane.listScroll, {x: 189, y: 100, t: 360}));
  });
  test('a 13px horizontal-dominant drag arms with the slop subtracted: near-zero displacement', () => {
    const pane = twoTabs();
    pane.listScroll.dispatchEvent(tev('touchstart', pane.listScroll, {x: 200, y: 100, t: 0}));
    window.dispatchEvent(tev('touchmove', pane.listScroll, {x: 187, y: 100, t: 120})); // 13px left
    // Armed (13 >= 12, horizontal-dominant), but the strip starts from the arm
    // point: 13px of travel minus the 12px slop leaves 1px, not 13px.
    expect(pane.sessionListTop.style.transform).toBe('translateX(-1px)');
    window.dispatchEvent(tev('touchend', pane.listScroll, {x: 187, y: 100, t: 360}));
  });
  test('a 40px vertical-dominant drag never arms: zero transform', () => {
    const pane = twoTabs();
    pane.listScroll.dispatchEvent(tev('touchstart', pane.listScroll, {x: 100, y: 100, t: 0}));
    window.dispatchEvent(tev('touchmove', pane.listScroll, {x: 110, y: 138, t: 120})); // dy 38 vs dx 10
    expect(pane.sessionListTop.style.transform).toBe('');
    window.dispatchEvent(tev('touchmove', pane.listScroll, {x: 110, y: 180, t: 240}));
    expect(pane.sessionListTop.style.transform).toBe('');
    window.dispatchEvent(tev('touchend', pane.listScroll, {x: 110, y: 180, t: 360}));
  });
});
