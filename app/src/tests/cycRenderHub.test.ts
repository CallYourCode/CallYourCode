import {beforeEach, describe, expect, test, vi} from 'vitest';
const fake = vi.hoisted(() => ({
  tabs: [] as unknown[],
  sessions: [] as Array<{id: string}>,
  gestureActive: false,
  status: 'live' as 'offline' | 'connecting' | 'syncing' | 'live',
  statusSubs: [] as Array<(s: 'offline' | 'connecting' | 'syncing' | 'live') => void>,
  settles: [] as Array<() => void>,
  version: 'v1',
  active: null as {
    id: string;
    messages?: Record<string, unknown>[];
    events?: Record<string, unknown>[];
  } | null,
  cvCalls: [] as string[],
  plugins: [] as unknown[],
  overlayOn: false,
  windowFrom: 0,
  domEpoch: 0,
  merged: false,
  chip: {harness: true, model: true} as Record<string, boolean>
}));
vi.mock('../engine/store', () => ({
  tabs: () => fake.tabs,
  list: () => fake.sessions,
  contentVersion: (s: {id: string}) => {
    fake.cvCalls.push(s.id);
    return fake.version;
  },
  globalSettings: () => ({replyLevel: 1, complexity: 1, verbosityOn: false, complexityOn: false}),
  overlayEnabled: () => false,
  overlayOn: () => fake.overlayOn,
  engineReachable: () => fake.status === 'live',
  syncStatus: () => fake.status,
  onSyncStatus: (cb: (typeof fake.statusSubs)[number]) => {
    fake.statusSubs.push(cb);
    return () => {
      fake.statusSubs = fake.statusSubs.filter((f) => f !== cb);
    };
  },
  pluginsOf: (): unknown[] => fake.plugins,
  effectiveSpeed: () => 1,
  voiceEngineHealthy: () => true,
  uploadUrl: () => '',
  docUrl: () => '',
  activityMark: (s: {status?: string}) =>
    s.status === 'done' || s.status === 'blocked' || s.status === 'unknown' ? s.status : null,
  effectiveNotify: (s?: {settings?: {notify?: boolean}}) => s?.settings?.notify ?? true
}));
vi.mock('../shared/browser', () => ({
  active: (name: string) => name === 'gesture' && fake.gestureActive,
  onSettle: (fn: () => void) => fake.settles.push(fn)
}));
vi.mock('../components/domHelpers', () => ({
  h: () => document.createElement('div')
}));
vi.mock('../features/chat/surface/messageList', () => ({
  renderMessages: vi.fn(),
  clearMessages: vi.fn(),
  messageWindowFrom: () => fake.windowFrom,
  messageDomEpoch: () => fake.domEpoch
}));
vi.mock('../features/settings/preferences', () => ({
  sortByLatest: () => false,
  mergeTabs: () => fake.merged,
  rowChipShown: (id: string) => fake.chip[id] ?? true
}));
vi.mock('../engine/contract', () => ({enginePin: (): string | null => null}));
vi.mock('../features/chat/content', () => ({uploadKey: (id: string) => id}));
vi.mock('../sessionSelectors', async () => {
  // The real (unmocked) sessionState: the same instance the tests flip, so
  // the mocked projections read the same activeId and archive lens.
  const {sessionState} = await import('../sessionState');
  type Row = {id?: string; alive?: boolean; churnGrey?: boolean};
  // Mirrors the real projectMembership: live rows plus dead ones that are the
  // open chat or churnGrey (the archive-lens tests lean on the active clause).
  const membership = (base: Row[]) =>
    base.filter((s) => s.alive !== false || s.id === sessionState.activeId || s.churnGrey === true);
  const archive = (base: Row[]) => base.filter((s) => s.alive === false);
  return {
    active: (): unknown => fake.active,
    allSessions: () => fake.sessions,
    activeEngineKey: () => 'e1',
    isDead: (s: {alive?: boolean} | null) => !!s && s.alive === false,
    projectMembership: membership,
    projectArchive: archive,
    projectRows: (base: Row[]) => (sessionState.archiveOpen ? archive(base) : membership(base)),
    hostChipLabel: () => 'host',
    tabLabelOf: (): string | null => null
  };
});
import {createRenderHub, type RenderHubDeps} from '../renderHub';
import {sessionState, dataState} from '../sessionState';
function mk() {
  const listEl = document.createElement('div');
  const list = {
    projectList: vi.fn(() => ({rows: fake.sessions, cards: {hints: false}})),
    sessionList: {el: listEl, update: vi.fn()},
    hintsCardEl: document.createElement('div'),
    sessionListTop: document.createElement('div'),
    listFilter: {query: ''},
    tabSessions: () => fake.sessions,
    // Mirrors the real listPane.visibleSessions: the projected rows narrowed
    // by the search filter (no test here sets a query, so it passes through).
    visibleSessions: (rows?: Array<Record<string, unknown>>) => rows ?? fake.sessions,
    renderTabs: vi.fn(),
    updateBadge: vi.fn(),
    updateArchiveEntry: vi.fn(),
    paintLimits: vi.fn(),
    syncStatusEl: document.createElement('span'),
    floatingAction: document.createElement('div'),
    pluginComposerWidgets: (): unknown[] => []
  };
  const tp = {
    header: {update: vi.fn(), setSpeed: vi.fn(), setCronCount: vi.fn(), setVoiceState: vi.fn()},
    convToggleBtn: document.createElement('div'),
    updateJumpBar: vi.fn(),
    updateAgentsBar: vi.fn(),
    refreshModelBadge: vi.fn(),
    refreshCronBadge: vi.fn(),
    cronCountOf: () => 0,
    speedLabelOf: (r: number) => `${r}x`
  };
  const cs = {
    bracketMessageRender: vi.fn((_id: string, paint: () => void) => paint()),
    firstUnread: (): number | undefined => undefined,
    renderEarlier: vi.fn(),
    showChatBusy: vi.fn(),
    hideChatBusy: vi.fn(),
    messageListEl: document.createElement('div'),
    messageListInner: document.createElement('div'),
    openPaintIsPending: () => false,
    openPaintStartedAt: () => 0,
    clearOpenPaint: vi.fn(),
    speakUnheard: vi.fn(),
    stickyDates: {refresh: vi.fn()}
  };
  const audio = {
    onMessagePlay: vi.fn(),
    onMessageSeek: vi.fn(),
    updateRowAudio: vi.fn(),
    updatePlayerBar: vi.fn(),
    updateMessagePlays: vi.fn(),
    updateVoiceStrip: vi.fn()
  };
  const deps = {
    whole: document.createElement('div'),
    mainColumns: document.createElement('div'),
    list,
    tp,
    cs,
    audio,
    media: {
      sessionAttachments: (): unknown[] => [],
      onOpenFileCard: vi.fn(),
      openAlbumAt: vi.fn(),
      openDocAttachment: vi.fn()
    },
    composer: {setPluginWidgets: vi.fn(), setDisabled: vi.fn(), setVoiceEnabled: vi.fn()},
    askPanel: {update: vi.fn()},
    profile: {
      update: vi.fn(),
      setCronCount: vi.fn(),
      setEngineReachable: vi.fn(),
      setMedia: vi.fn()
    },
    hydrateWaveforms: vi.fn(),
    syncNavUrl: vi.fn()
  } as unknown as RenderHubDeps;
  return {deps, list, tp, cs, hub: createRenderHub(deps)};
}
beforeEach(() => {
  fake.tabs = [];
  fake.sessions = [];
  fake.gestureActive = false;
  fake.status = 'live';
  fake.statusSubs = [];
  fake.settles.length = 0;
  fake.version = 'v1';
  fake.active = null;
  fake.cvCalls = [];
  fake.plugins = [];
  fake.overlayOn = false;
  fake.windowFrom = 0;
  fake.domEpoch = 0;
  fake.merged = false;
  fake.chip = {harness: true, model: true};
  dataState.mode = 'live';
  sessionState.activeId = null;
  sessionState.archiveOpen = false;
  vi.clearAllMocks();
});
describe('the settle-regime choke point', () => {
  test('a store paint during a gesture defers whole; one settle flush repaints once', () => {
    const {hub, deps} = mk();
    fake.gestureActive = true;
    hub.render(true);
    hub.render(true);
    expect(deps.syncNavUrl).not.toHaveBeenCalled();
    expect(fake.settles).toHaveLength(1);
    fake.gestureActive = false;
    fake.settles[0]!();
    expect(deps.syncNavUrl).toHaveBeenCalledTimes(1);
  });
  test('a direct render (the user acting) paints through the gesture', () => {
    const {hub, deps} = mk();
    fake.gestureActive = true;
    hub.render();
    expect(deps.syncNavUrl).toHaveBeenCalledTimes(1);
  });
});
describe('surface version gates (#403a)', () => {
  test('an unchanged tabs version skips renderTabs on the store path, never on a direct render', () => {
    const {hub, list} = mk();
    hub.render(true);
    expect(list.renderTabs).toHaveBeenCalledTimes(1);
    hub.render(true);
    expect(list.renderTabs).toHaveBeenCalledTimes(1);
    hub.render();
    expect(list.renderTabs).toHaveBeenCalledTimes(2);
    fake.sessions = [{id: 's1'}];
    hub.render(true);
    expect(list.renderTabs).toHaveBeenCalledTimes(2);
  });
  test('flipping a chip toggle re-keys the list surface (listRowVersion folds the toggles)', () => {
    const {hub, list} = mk();
    fake.sessions = [{id: 's1'}];
    hub.render(true);
    const painted = () => (list.sessionList.update as ReturnType<typeof vi.fn>).mock.calls.length;
    const before = painted();
    // Nothing changed: the store path skips the list surface entirely.
    hub.render(true);
    expect(painted()).toBe(before);
    // A chip toggle flips: the fold makes the version differ, the list repaints.
    fake.chip = {harness: true, model: false};
    hub.render(true);
    expect(painted()).toBe(before + 1);
    // The other toggle is independent: flipping it repaints again.
    fake.chip = {harness: false, model: false};
    hub.render(true);
    expect(painted()).toBe(before + 2);
  });
});
describe('render-heat: contentVersion memo (one hash per session per pass)', () => {
  test('the active session is hashed once per render, not once for the list and again for the chat', () => {
    const {hub} = mk();
    // The active session is also a list row: chatSurfaceVersion hashes its
    // whole history once through the memo, and the list surface (now keyed on
    // the coarse listRowVersion) adds no second O(messages) pass.
    fake.sessions = [{id: 's1'}];
    fake.active = {id: 's1'};
    sessionState.activeId = 's1';
    hub.render();
    const s1Hashes = fake.cvCalls.filter((id) => id === 's1').length;
    expect(s1Hashes).toBe(1);
  });
  test('only the ACTIVE session is content-hashed; list rows are never hashed at all', () => {
    const {hub} = mk();
    // The list surface keys on the coarse listRowVersion (O(1) per row), so a
    // render pass hashes exactly one session's history: the active one, for
    // chatSurfaceVersion. The other rows cost no O(messages) pass anywhere.
    fake.sessions = [{id: 's1'}, {id: 's2'}, {id: 's3'}];
    fake.active = {id: 's2'};
    sessionState.activeId = 's2';
    hub.render();
    expect(fake.cvCalls.filter((x) => x === 's2').length).toBe(1);
    expect(fake.cvCalls.filter((x) => x === 's1').length).toBe(0);
    expect(fake.cvCalls.filter((x) => x === 's3').length).toBe(0);
  });
  test('the memo does not leak between render passes', () => {
    const {hub} = mk();
    fake.sessions = [{id: 's1'}];
    fake.active = {id: 's1'};
    sessionState.activeId = 's1';
    hub.render();
    fake.cvCalls = [];
    hub.render();
    expect(fake.cvCalls.filter((id) => id === 's1').length).toBe(1);
  });
});
describe('render-heat: chat-pane scan guards (fix #4)', () => {
  const msg = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 1,
    role: 'claude',
    kind: 'text',
    text: '',
    ts: 1000,
    ...over
  });
  const openChat = (messages: Record<string, unknown>[]) => {
    fake.sessions = [{id: 's1'}];
    fake.active = {id: 's1', messages};
    sessionState.activeId = 's1';
  };
  const scanCounts = (deps: RenderHubDeps, cs: {stickyDates: {refresh: () => void}}) => ({
    hydrate: (deps.hydrateWaveforms as ReturnType<typeof vi.fn>).mock.calls.length,
    sticky: (cs.stickyDates.refresh as ReturnType<typeof vi.fn>).mock.calls.length,
    plays: (deps as unknown as {audio: {updateMessagePlays: ReturnType<typeof vi.fn>}}).audio
      .updateMessagePlays.mock.calls.length
  });

  test('a text-append-only update to the growing tail does NOT re-run the scans', () => {
    const {hub, deps, cs} = mk();
    const growing = msg({id: 7, text: 'he', growing: true});
    openChat([msg({id: 1, text: 'hi'}), growing]);
    hub.render();
    const before = scanCounts(deps, cs);
    // The reply streams: only the growing tail's body grows.
    growing.text = 'hello there, this is a longer chunk';
    hub.render();
    expect(scanCounts(deps, cs)).toEqual(before);
  });

  test('a NEW message (a voice clip) DOES re-run the scans', () => {
    const {hub, deps, cs} = mk();
    const messages = [msg({id: 1, text: 'hi'})];
    openChat(messages);
    hub.render();
    const before = scanCounts(deps, cs);
    messages.push(msg({id: 2, kind: 'voice', durationS: 3, ts: 2000}));
    hub.render();
    const after = scanCounts(deps, cs);
    expect(after.hydrate).toBe(before.hydrate + 1);
    expect(after.sticky).toBe(before.sticky + 1);
    expect(after.plays).toBe(before.plays + 1);
  });

  test('the growing tail settling (growing -> false) DOES re-run the scans', () => {
    const {hub, deps, cs} = mk();
    const tail = msg({id: 9, kind: 'voice', text: 'note', growing: true});
    openChat([tail]);
    hub.render();
    const before = scanCounts(deps, cs);
    tail.growing = false;
    hub.render();
    expect(scanCounts(deps, cs).hydrate).toBe(before.hydrate + 1);
  });

  test('a tail status change (a clip upload completing) DOES re-run the scans', () => {
    const {hub, deps, cs} = mk();
    const tail = msg({id: 5, kind: 'voice', status: 'sending'});
    openChat([tail]);
    hub.render();
    const before = scanCounts(deps, cs);
    tail.status = 'sent';
    hub.render();
    expect(scanCounts(deps, cs).hydrate).toBe(before.hydrate + 1);
  });

  test('a session switch DOES re-run the scans', () => {
    const {hub, deps, cs} = mk();
    openChat([msg({id: 1, text: 'hi'})]);
    hub.render();
    const before = scanCounts(deps, cs);
    fake.sessions = [{id: 's2'}];
    fake.active = {id: 's2', messages: [msg({id: 1, text: 'yo'})]};
    sessionState.activeId = 's2';
    hub.render();
    expect(scanCounts(deps, cs).hydrate).toBe(before.hydrate + 1);
  });

  test('the plugins-composer JSON is stringified once per plugins array reference', () => {
    const {hub} = mk();
    let reads = 0;
    fake.plugins = [
      {
        id: 'p1',
        get composer() {
          reads++;
          return [{kind: 'button'}];
        }
      }
    ];
    openChat([msg({id: 1, text: 'hi'})]);
    hub.render();
    // A second render recomputes chatSurfaceVersion but the plugins array is the
    // same reference, so the composer JSON is served from cache, not rebuilt.
    hub.render();
    expect(reads).toBe(1);
    // A new plugins array (the engine re-announced) invalidates the cache.
    fake.plugins = [
      {
        id: 'p1',
        get composer() {
          reads++;
          return [{kind: 'button'}];
        }
      }
    ];
    hub.render();
    expect(reads).toBe(2);
  });

  test('a history-pagination window move DOES re-run the scans (same messages)', () => {
    const {hub, deps, cs} = mk();
    openChat([msg({id: 1, kind: 'voice', durationS: 3})]);
    fake.windowFrom = 300;
    hub.render();
    const before = scanCounts(deps, cs);
    // The Earlier pill / scroll pager / jumpToMessage moved the window origin
    // and forced a render: every row frame is discarded and the whole list is
    // rebuilt with the message array untouched.
    fake.windowFrom = 0;
    hub.render();
    const after = scanCounts(deps, cs);
    expect(after.hydrate).toBe(before.hydrate + 1);
    expect(after.sticky).toBe(before.sticky + 1);
    expect(after.plays).toBe(before.plays + 1);
  });

  test('a clearMessages teardown (open-landing correction) DOES re-run the scans', () => {
    const {hub, deps, cs} = mk();
    openChat([msg({id: 1, kind: 'voice', durationS: 3})]);
    hub.render();
    const before = scanCounts(deps, cs);
    // chatSurface's failed unread-landing path calls clearMessages then a
    // forced render; the real clearMessages bumps the DOM epoch (proven in
    // cycMessageListReuse.test.ts), rebuilding the node set with no store
    // change at all.
    fake.domEpoch++;
    hub.render();
    const after = scanCounts(deps, cs);
    expect(after.hydrate).toBe(before.hydrate + 1);
    expect(after.sticky).toBe(before.sticky + 1);
    expect(after.plays).toBe(before.plays + 1);
  });

  test('overlay toggle and event arrival DO re-run the scans', () => {
    const {hub, deps, cs} = mk();
    const events = [{uuid: 'e1', ts: 1500, kind: 'tool', text: 'ls'}];
    fake.sessions = [{id: 's1'}];
    fake.active = {id: 's1', messages: [msg({id: 1, kind: 'voice', durationS: 3})], events};
    sessionState.activeId = 's1';
    hub.render();
    const off = scanCounts(deps, cs);
    // Toggling the TUI overlay on swaps event rows into the list.
    fake.overlayOn = true;
    hub.render();
    const on = scanCounts(deps, cs);
    expect(on.hydrate).toBe(off.hydrate + 1);
    // An arriving event rebuilds the suffix rows; ts and kind are folded.
    events.push({uuid: 'e2', ts: 2500, kind: 'reply', text: 'done'});
    hub.render();
    const after = scanCounts(deps, cs);
    expect(after.hydrate).toBe(on.hydrate + 1);
    expect(after.sticky).toBe(on.sticky + 1);
    expect(after.plays).toBe(on.plays + 1);
  });

  test('a row adopting a msgId (voice-upload resume) DOES re-run the scans', () => {
    const {hub, deps, cs} = mk();
    const clip = msg({id: 5, kind: 'voice', durationS: 2});
    openChat([clip]);
    hub.render();
    const before = scanCounts(deps, cs);
    // voiceUpload's resume branch sets msgId with no other folded field moving;
    // that is the exact moment the clip becomes hydratable.
    clip.msgId = 'm-42';
    hub.render();
    const after = scanCounts(deps, cs);
    expect(after.hydrate).toBe(before.hydrate + 1);
    expect(after.plays).toBe(before.plays + 1);
  });
});

describe('render-heat: coarse list-row version (fix #2)', () => {
  type AnyRow = Record<string, unknown> & {id: string; messages: Record<string, unknown>[]};
  const msg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 1,
    role: 'claude',
    kind: 'text',
    text: '',
    ts: 1000,
    ...over
  });
  const row = (over: Record<string, unknown> = {}): AnyRow => ({
    id: 's1',
    name: 'builder',
    cwd: '/repo',
    unread: 0,
    muted: false,
    thinking: false,
    messages: [],
    ...over
  });
  const openList = (rows: AnyRow[]) => {
    fake.sessions = rows;
    fake.active = rows[0] as never;
    sessionState.activeId = rows[0]?.id ?? null;
  };
  const listPaints = (list: {sessionList: {update: ReturnType<typeof vi.fn>}}) =>
    list.sessionList.update.mock.calls.length;
  const chatPaints = (cs: {bracketMessageRender: ReturnType<typeof vi.fn>}) =>
    cs.bracketMessageRender.mock.calls.length;

  test('a growing-tail body append does NOT repaint the list; the chat still repaints', () => {
    const {hub, list, cs} = mk();
    const tail = msg({id: 2, ts: 2000, text: 'partial', growing: true});
    openList([
      row({title: {text: 'Claude', detail: null}, thinking: true, messages: [msg(), tail]})
    ]);
    hub.render(true);
    const lp = listPaints(list);
    const cp = chatPaints(cs);
    // A chunk lands: the body grows and the session's contentVersion bumps.
    tail.text = 'partial plus a whole new streamed chunk of reply text';
    fake.version = 'v2';
    hub.render(true);
    expect(listPaints(list)).toBe(lp);
    expect(chatPaints(cs)).toBe(cp + 1);
  });

  test('a no-title row repaints while the visible preview forms, then goes quiet past the bound', () => {
    const {hub, list} = mk();
    const tail = msg({id: 2, ts: 2000, text: 'he', growing: true});
    openList([row({messages: [tail]})]);
    hub.render(true);
    const lp = listPaints(list);
    // Within the preview window the row's visible text is actually changing,
    // so the list repaints: the row shows the live text.
    tail.text = 'hello there';
    fake.version = 'v2';
    hub.render(true);
    expect(listPaints(list)).toBe(lp + 1);
    // Fill past the preview bound, then append beyond it: the visible prefix
    // no longer changes, so the list goes quiet while the body keeps growing.
    tail.text = 'x'.repeat(240);
    fake.version = 'v3';
    hub.render(true);
    const settled = listPaints(list);
    tail.text = 'x'.repeat(240) + ' streamed on far past what one row line can show';
    fake.version = 'v4';
    hub.render(true);
    expect(listPaints(list)).toBe(settled);
  });

  test('a contentVersion-only bump (events or token churn) no longer repaints the list', () => {
    const {hub, list, cs} = mk();
    openList([row({title: {text: 'Claude', detail: null}, messages: [msg()]})]);
    hub.render(true);
    const lp = listPaints(list);
    const cp = chatPaints(cs);
    // A TUI event or agent-run token tick bumps contentVersion with no
    // row-visible change: the chat surface repaints, the list stays quiet.
    fake.version = 'v2';
    hub.render(true);
    expect(listPaints(list)).toBe(lp);
    expect(chatPaints(cs)).toBe(cp + 1);
  });

  test('a row reorder DOES repaint the list (order-sensitive surface join)', () => {
    const {hub, list} = mk();
    const a = row({id: 's1'});
    const b = row({id: 's2', name: 'other'});
    openList([a, b]);
    hub.render(true);
    const lp = listPaints(list);
    fake.sessions = [b, a];
    hub.render(true);
    expect(listPaints(list)).toBe(lp + 1);
  });

  test('a churnGrey zombie row settling away DOES repaint the list', () => {
    const {hub, list} = mk();
    // A dead-but-churnGrey session is RENDERED (projectMembership keeps it),
    // so the version must iterate the same membership: with the old
    // `!isDead || active` filter this non-active zombie was invisible to the
    // key, its settle-frame deletion changed nothing, and the grey row stayed
    // painted indefinitely on a quiet list.
    const a = row({id: 's1'});
    const zombie = row({id: 's2', name: 'grey', alive: false, churnGrey: true});
    fake.sessions = [a, zombie];
    fake.active = a as never;
    sessionState.activeId = 's1';
    hub.render(true);
    const lp = listPaints(list);
    // The engine settle frame deletes the dead session; no other folded field
    // moves anywhere.
    fake.sessions = [a];
    hub.render(true);
    expect(listPaints(list)).toBe(lp + 1);
  });

  // Every datum a session row paints, each proven to re-key the list when it
  // moves. The fixture is a mirror row (title set) with a growing tail, the
  // exact state a streaming reply leaves the list in.
  const tailOf = (r: AnyRow) => r.messages[r.messages.length - 1];
  const cases: Array<[string, (r: AnyRow) => void]> = [
    ['an unread bump', (r) => (r.unread = 3)],
    ['a thinking flip', (r) => (r.thinking = true)],
    ['a status change (activity dot)', (r) => (r.status = 'done')],
    ['a working status', (r) => (r.status = 'working')],
    ['a rename', (r) => (r.name = 'renamed')],
    ['a title text change', (r) => (r.title = {text: 'New', detail: null})],
    ['a title detail change', (r) => (r.title = {text: 'Claude', detail: 'branch'})],
    ['an agent label change', (r) => (r.agentLabel = 'codex')],
    ['a harness change (harness chip text)', (r) => (r.agentName = 'Codex')],
    ['a model change (model chip text)', (r) => (r.model = 'Fable 5')],
    ['an ask arriving', (r) => (r.ask = {question: 'merge it?'})],
    ['askUnknown arriving', (r) => (r.askUnknown = true)],
    ['a mute flip', (r) => (r.muted = true)],
    ['an avatar change', (r) => (r.avatarUrl = 'http://x/a.png')],
    ['turnSince set', (r) => (r.turnSince = 123456)],
    ['lastActivity moving', (r) => (r.lastActivity = 999999)],
    ['a manual order change', (r) => (r.order = 5)],
    ['the session dying', (r) => (r.alive = false)],
    ['churnGrey set', (r) => (r.churnGrey = true)],
    ['heardTs moving (audio badge finished)', (r) => (r.heardTs = 2001)],
    ['a per-session notify pref flip', (r) => (r.settings = {notify: false})],
    ['a new message', (r) => r.messages.push(msg({id: 9, ts: 3000, text: 'new'}))],
    ['the last message deleted', (r) => r.messages.pop()],
    [
      'the last message replaced',
      (r) => r.messages.splice(-1, 1, msg({id: 8, ts: 2500, text: 'redo'}))
    ],
    ['a tail status change', (r) => (tailOf(r).status = 'sent')],
    ['a queued flip on the tail', (r) => (tailOf(r).queued = true)],
    ['the tail adopting a msgId (audio speakable)', (r) => (tailOf(r).msgId = 'm-1')],
    ['the tail adopting a dedupeKey (delivered)', (r) => (tailOf(r).dedupeKey = 'mid:1')],
    ['a file landing on the tail', (r) => (tailOf(r).file = {fileKind: 'image', name: 'a.png'})],
    ['an upload landing on the tail', (r) => (tailOf(r).upload = {image: false, name: 'doc.pdf'})],
    ['the tail settling (growing off)', (r) => delete tailOf(r).growing]
  ];
  for (const [name, mutate] of cases)
    test(`${name} DOES repaint the list`, () => {
      const {hub, list} = mk();
      const base = row({
        title: {text: 'Claude', detail: null},
        status: 'idle',
        messages: [msg(), msg({id: 2, ts: 2000, text: 'tail', growing: true})]
      });
      openList([base]);
      hub.render(true);
      const lp = listPaints(list);
      mutate(base);
      hub.render(true);
      expect(listPaints(list)).toBe(lp + 1);
    });

  test('flipping merge-tabs DOES repaint the list (the chips appear and vanish with it)', () => {
    // The chips (host, harness, model) paint only in the merged list, so the
    // gate itself is a painted input. tabLabelOf is mocked null here, so
    // without the explicit gate term nothing else re-keys this flip.
    const {hub, list} = mk();
    openList([row({agentName: 'Codex', model: 'Fable 5'})]);
    hub.render(true);
    const lp = listPaints(list);
    fake.merged = true;
    hub.render(true);
    expect(listPaints(list)).toBe(lp + 1);
  });
});

describe('the #554 list hold', () => {
  test('a wire event that zeroes the tab while every shown row is model-backed is held', () => {
    const {hub, list} = mk();
    fake.sessions = [{id: 's1'}];
    const row = document.createElement('div');
    row.dataset.sessionId = 's1';
    list.sessionList.el.append(row);
    list.projectList.mockReturnValue({rows: [], cards: {hints: false}});
    hub.renderRows(false);
    expect(list.sessionList.update).not.toHaveBeenCalled();
    hub.renderRows(true);
    expect(list.sessionList.update).toHaveBeenCalledTimes(1);
  });
});
describe('coming back live', () => {
  const say = (st: typeof fake.status) => {
    fake.status = st;
    for (const cb of fake.statusSubs) cb(st);
  };
  test('the first live edge is silent; a later one reads out what arrived unheard', () => {
    vi.useFakeTimers();
    try {
      const {cs} = mk();
      sessionState.activeId = 's1';
      say('live');
      vi.advanceTimersByTime(1000);
      expect(cs.speakUnheard).not.toHaveBeenCalled();
      say('offline');
      say('connecting');
      say('syncing');
      say('live');
      expect(cs.speakUnheard).not.toHaveBeenCalled();
      vi.advanceTimersByTime(900);
      expect(cs.speakUnheard).toHaveBeenCalledWith('s1');
      // Staying live is not an edge.
      say('live');
      vi.advanceTimersByTime(1000);
      expect(cs.speakUnheard).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dead-session archive: the list surface key folds the lens', () => {
  type AnyRow = Record<string, unknown> & {id: string; messages: Record<string, unknown>[]};
  const row = (over: Record<string, unknown> = {}): AnyRow => ({
    id: 's1',
    name: 'builder',
    cwd: '/repo',
    unread: 0,
    muted: false,
    thinking: false,
    messages: [],
    ...over
  });
  const listPaints = (list: {sessionList: {update: ReturnType<typeof vi.fn>}}) =>
    list.sessionList.update.mock.calls.length;

  test('flipping the archive lens repaints even with byte-identical projected rows', () => {
    const {hub, list} = mk();
    // One dead session that is ALSO the open chat: the live membership keeps
    // it (active exception) and the archive projection holds it too, so the
    // projected row set is byte-identical under both lenses. Only the lens
    // fold can re-key the surface; without it the entry row and its position
    // go stale.
    const dead = row({id: 's1', alive: false});
    fake.sessions = [dead];
    fake.active = dead as never;
    sessionState.activeId = 's1';
    hub.render(true);
    const lp = listPaints(list);
    hub.render(true);
    expect(listPaints(list)).toBe(lp);
    sessionState.archiveOpen = true;
    const ae = list.updateArchiveEntry.mock.calls.length;
    hub.render(true);
    expect(listPaints(list)).toBe(lp + 1);
    // The lens-flip repaint runs updateArchiveEntry, the pass that also gates
    // the pair banner out of the archive lens (listPane hides it there).
    expect(list.updateArchiveEntry.mock.calls.length).toBe(ae + 1);
  });

  test('a session dying into the archive repaints the live list (the entry row appears)', () => {
    const {hub, list} = mk();
    const a = row({id: 's1'});
    fake.sessions = [a];
    fake.active = a as never;
    sessionState.activeId = 's1';
    hub.render(true);
    const lp = listPaints(list);
    // A dead, non-active, non-churnGrey row: the LIVE projection is unchanged
    // ([a] before and after), so only the archived-count fold can re-key the
    // surface for the "Archived (1)" entry to appear.
    fake.sessions = [a, row({id: 's2', name: 'gone', alive: false})];
    hub.render(true);
    expect(listPaints(list)).toBe(lp + 1);
  });

  test('the death grace ending repaints the row out of the live list', () => {
    const {hub, list} = mk();
    const a = row({id: 's1'});
    const dying = row({id: 's2', name: 'dying', alive: false, churnGrey: true});
    fake.sessions = [a, dying];
    fake.active = a as never;
    sessionState.activeId = 's1';
    hub.render(true);
    const lp = listPaints(list);
    // The grace timer lifts churnGrey with the session still listed: the row
    // leaves the live membership, so the fold set shrinks and the list
    // repaints the row away (the archived count is 1 before and after).
    dying.churnGrey = false;
    hub.render(true);
    expect(listPaints(list)).toBe(lp + 1);
  });
});
