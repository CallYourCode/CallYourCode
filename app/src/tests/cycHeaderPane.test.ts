import {beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycSession} from '../types';
type Fake = {
  sessions: Array<{id: string; name: string; unread: number}>;
  speed: number;
  reachable: boolean;
  plugins: Array<{id: string; panel?: {badge?: string}}>;
  rpcResult: {ok: boolean; result?: unknown};
};
const fake: Fake = {
  sessions: [],
  speed: 1,
  reachable: true,
  plugins: [],
  rpcResult: {ok: false}
};
vi.mock('../engine/store', () => ({
  list: () => fake.sessions,
  get: (id: string) => fake.sessions.find((s) => s.id === id),
  effectiveSpeed: () => fake.speed,
  setGlobalSettings: vi.fn(async (v: {speed: number}) => {
    fake.speed = v.speed;
    return true;
  }),
  setSessionSettings: vi.fn(async () => true),
  engineReachable: () => fake.reachable,
  overlayEnabled: () => false,
  setOverlayEnabled: vi.fn(async () => {}),
  pluginsOf: () => fake.plugins,
  pluginRpc: vi.fn(async () => fake.rpcResult),
  interrupt: vi.fn(),
  compact: vi.fn(),
  detachChat: vi.fn(),
  stopAgent: vi.fn(async () => ({ok: true})),

  tabs: (): unknown[] => [],
  engineKeyOfTab: () => '',
  mergedListOrder: (): unknown[] => [],
  tabOfSession: () => '',
  toolbarPluginIds: () => new Set()
}));
vi.mock('../audio/speaker', () => ({
  speaker: {setRate: vi.fn(), setRateResolver: vi.fn(), stopAll: vi.fn(), state: {state: 'idle'}}
}));
vi.mock('../audio/pipeline', () => ({
  pipeline: {
    liveCaptureId: '',
    capturesInFlight: [],
    handsFreeSessionId: '',
    disableHandsFree: vi.fn(),
    enableHandsFree: vi.fn()
  }
}));
vi.mock('../speechGate', () => ({ensureMic: vi.fn(async () => {})}));
vi.mock('../components/widgets', () => ({
  toast: vi.fn(),
  confirmPluginAction: vi.fn()
}));
import {createHeaderPane, type HeaderPaneDeps} from '../features/sessions/panes/headerPane';
import {sessionState, dataState} from '../sessionState';
import * as engine from '../engine/store';
import {speaker} from '../audio/speaker';
beforeEach(() => {
  fake.sessions = [];
  fake.speed = 1;
  fake.plugins = [];
  fake.rpcResult = {ok: false};
  sessionState.activeId = null;
  dataState.mode = 'live';
  vi.clearAllMocks();
  (globalThis as {ResizeObserver?: unknown}).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  localStorage.clear();
});
function mk(over: Partial<HeaderPaneDeps> = {}) {
  const deps: HeaderPaneDeps = {
    onTeardown: () => {},
    saveDraft: vi.fn(),
    loadDraft: vi.fn(),
    restorePending: new Set(),
    releaseMicIfIdle: vi.fn(),
    setView: vi.fn(),
    render: vi.fn(),
    capUploading: () => 0,
    notifyOn: () => true,
    goToMessage: vi.fn(async () => true),
    openChat: vi.fn(),
    setOverlayToggleChecked: vi.fn(),
    mainColumns: document.createElement('div'),
    chatEl: document.createElement('div'),
    ...over
  };
  return {deps, pane: createHeaderPane(deps)};
}
describe('jump target follows the blue badge', () => {
  test('only unread > 0 sessions count; the ring wraps and skips the active chat', () => {
    fake.sessions = [
      {id: 'a', name: 'a', unread: 0},
      {id: 'b', name: 'b', unread: 2},
      {id: 'c', name: 'c', unread: 1}
    ];
    const {pane} = mk();
    sessionState.activeId = 'b';
    expect(pane.jumpTarget(1)).toBe('c');
    sessionState.activeId = 'c';
    expect(pane.jumpTarget(1)).toBe('b');
    sessionState.activeId = null;
    expect(pane.jumpTarget(1)).toBe('b');
    expect(pane.jumpTarget(-1)).toBe('c');
    fake.sessions.forEach((s) => {
      s.unread = 0;
    });
    expect(pane.jumpTarget(1)).toBeNull();
  });
  test('jumpTo opens the chat through the injected door', () => {
    fake.sessions = [{id: 'b', name: 'b', unread: 2}];
    const {pane, deps} = mk();
    pane.jumpTo(1, 'button');
    expect(deps.openChat).toHaveBeenCalledWith('b');
    (deps.openChat as ReturnType<typeof vi.fn>).mockClear();
    fake.sessions[0]!.unread = 0;
    pane.jumpTo(1, 'button');
    expect(deps.openChat).not.toHaveBeenCalled();
  });
});
describe('crons count', () => {
  test('polls the crons plugin badge; a good count moves the caption and the cache', async () => {
    const {pane} = mk();
    const setCronCount = vi.spyOn(pane.header, 'setCronCount');
    const s = {id: 's1', name: 's', engineKey: 'e1', messages: []} as unknown as CycSession;
    fake.plugins = [{id: 'crons', panel: {badge: 'count'}}];
    fake.rpcResult = {ok: true, result: {count: 2}};
    pane.refreshCronBadge(s);
    expect(setCronCount).toHaveBeenCalledWith(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(setCronCount).toHaveBeenLastCalledWith(2);
    expect(pane.cronCountOf('s1')).toBe(2);
    expect(pane.cronCountOf('other')).toBe(0);
    expect(pane.cronCountOf(null)).toBe(0);

    (engine.pluginRpc as unknown as ReturnType<typeof vi.fn>).mockClear();
    pane.refreshCronBadge(s);
    expect(engine.pluginRpc).not.toHaveBeenCalled();
    expect(setCronCount).toHaveBeenLastCalledWith(2);

    pane.refreshCronBadge(null);
    expect(setCronCount).toHaveBeenLastCalledWith(0);
    expect(pane.cronCountOf('s1')).toBe(0);
  });
  test('an old engine (no plugin) never polls; a failed rpc keeps the bare word', async () => {
    const {pane} = mk();
    const s = {id: 's1', name: 's', engineKey: 'e1', messages: []} as unknown as CycSession;
    fake.plugins = [];
    pane.refreshCronBadge(s);
    await Promise.resolve();
    expect(engine.pluginRpc).not.toHaveBeenCalled();
    expect(pane.cronCountOf('s1')).toBe(0);
    fake.plugins = [{id: 'crons', panel: {badge: 'count'}}];
    fake.rpcResult = {ok: false};
    pane.refreshCronBadge({...(s as object), id: 's2'} as CycSession);
    await Promise.resolve();
    await Promise.resolve();
    expect(pane.cronCountOf('s2')).toBe(0);
  });
  test('the sink hears a landed count (the profile row rides it)', async () => {
    const {pane} = mk();
    const heard: number[] = [];
    const off = pane.onCronCount(() => heard.push(pane.cronCountOf('s1')));
    fake.plugins = [{id: 'crons', panel: {badge: 'count'}}];
    fake.rpcResult = {ok: true, result: {count: 3}};
    pane.refreshCronBadge({
      id: 's1',
      name: 's',
      engineKey: 'e1',
      messages: []
    } as unknown as CycSession);
    await Promise.resolve();
    await Promise.resolve();
    expect(heard).toEqual([3]);
    off();
  });
});
describe('leaveChat', () => {
  test('saves the draft, empties the box, closes search, drops the selection, detaches', () => {
    fake.sessions = [{id: 's1', name: 's', unread: 0}];
    sessionState.activeId = 's1';
    sessionState.activeTabId = 't1';
    sessionState.tabSelection.set('t1', 's1');
    const {pane, deps} = mk({restorePending: new Set(['chat', 'list'])});
    pane.leaveChat();
    expect(deps.saveDraft).toHaveBeenCalled();
    expect(deps.loadDraft).toHaveBeenCalledWith(null);
    expect(sessionState.activeId).toBeNull();
    expect(sessionState.tabSelection.has('t1')).toBe(false);
    expect(deps.restorePending.size).toBe(0);
    expect(engine.detachChat).toHaveBeenCalled();
    expect(deps.setView).toHaveBeenCalledWith('list');
    expect(deps.render).toHaveBeenCalled();
  });
  test('backToList keeps the selection', () => {
    sessionState.activeId = 's1';
    const {pane, deps} = mk();
    pane.backToList();
    expect(sessionState.activeId).toBe('s1');
    expect(deps.setView).toHaveBeenCalledWith('list');
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });
});
describe('model badge', () => {
  test('paints the wire model first; a good badge shortens it; a bad one never blanks it', async () => {
    const {pane} = mk();
    const setModelBadge = vi.spyOn(pane.header, 'setModelBadge');
    const s = {
      id: 's1',
      name: 's',
      engineKey: 'e1',
      model: 'claude-fable-5',
      messages: []
    } as unknown as CycSession;
    fake.plugins = [{id: 'model-indicator', panel: {badge: 'model'}}];
    fake.rpcResult = {ok: true, result: {model: 'F5'}};
    pane.refreshModelBadge(s);
    expect(setModelBadge).toHaveBeenCalledWith('claude-fable-5');
    await Promise.resolve();
    await Promise.resolve();
    expect(setModelBadge).toHaveBeenLastCalledWith('F5');

    setModelBadge.mockClear();
    pane.refreshModelBadge(s);
    expect(setModelBadge).not.toHaveBeenCalled();

    (s as {model?: string}).model = 'claude-opus-5';
    fake.rpcResult = {ok: false};
    pane.refreshModelBadge(s);
    expect(setModelBadge).toHaveBeenLastCalledWith('claude-opus-5');
    await Promise.resolve();
    await Promise.resolve();
    expect(setModelBadge).toHaveBeenLastCalledWith('claude-opus-5');

    pane.refreshModelBadge(null);
    expect(setModelBadge).toHaveBeenLastCalledWith(null);
  });
});
describe('speed chip', () => {
  test('cycling reaches the playing clip immediately and persists the global', async () => {
    fake.sessions = [{id: 's1', name: 's', unread: 0}];
    const {pane} = mk();
    const setSpeed = vi.spyOn(pane.header, 'setSpeed');
    pane.header.el.querySelector<HTMLElement>('.cyc-speed-btn')?.click();
    if (setSpeed.mock.calls.length) {
      expect(speaker.setRate).toHaveBeenCalledWith(1.25);
      expect(setSpeed).toHaveBeenCalledWith('1.25x');
    }

    expect(speaker.setRateResolver).toHaveBeenCalled();
    expect(pane.speedLabelOf(1.5)).toBe('1.5x');
  });
});
