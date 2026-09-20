import {afterAll, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';
import type {CycSession} from '../types';

// Computed-style coverage for badges, the busy ring, and the scrollbar.

const fake = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  tabs: [] as Array<{id: string; label: string; state: string; unread: number; activity: boolean}>,
  windowActive: false,
  notify: true
}));
vi.hoisted(() => {
  (globalThis as unknown as {indexedDB: unknown}).indexedDB = {open: () => ({})};
});
vi.mock('../engine/store', () => ({
  tabs: () => fake.tabs,
  list: () => fake.sessions,
  get: (id: string) => fake.sessions.find((s) => s.id === id),
  activityMark: () => false,
  effectiveNotify: () => fake.notify,
  detachChat: vi.fn(),
  engineReachable: () => true,
  syncStatus: () => 'live',
  onSyncStatus: () => () => {},
  engineKeyOfTab: () => 'e1',
  exitSession: vi.fn(async () => true),
  newSessionPlaces: vi.fn(async () => ({places: [], home: '/home/u', def: null})),
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
import {createChatChrome} from '../features/chat/surface/chatChrome';
import {chatRow} from '../features/chat/navigation/chatRow';
import {createComposerBlocks} from '../features/composer/components/composerBlocks';
import {sessionState, dataState} from '../sessionState';

// Busy-ring classes emitted by the chat pane.
const CHAT_BUSY_RING_CLASS = [
  'cyc-loader-box cyc-loader-swing',
  'absolute inset-0 m-auto w-[54px] h-[54px] flex cursor-pointer overflow-hidden',
  'opacity-0 [transform:scale(0)] [--color:#fff]',
  '[transition:opacity_0.2s_ease-in-out,transform_0.2s_ease-in-out]',
  '[&.cyc-visible]:opacity-100! [&.cyc-visible]:[transform:scale(1)]!',
  '[&.cyc-loader-swing]:cursor-default'
].join(' ');

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const SHELL = resolve(SRC, 'shell');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

async function compileTailwind(candidates: string[]): Promise<string> {
  const entry = readFileSync(resolve(SHELL, 'tailwind.css'), 'utf8');
  const compiler = await compile(entry, {
    base: SHELL,
    async loadStylesheet(id: string, base: string) {
      const path =
        id === 'tailwindcss'
          ? resolve(TW_DIR, 'index.css')
          : resolve(base, id.replace(/^tailwindcss\//, `${TW_DIR}/`));
      return {base: dirname(path), content: readFileSync(path, 'utf8'), path};
    },
    async loadModule(id: string) {
      return {path: id, base: SHELL, module: {} as never};
    }
  });
  return compiler.build(candidates);
}

const tokenize = (className: string) => className.trim().split(/\s+/).filter(Boolean);

// Theme-specific accent sentinels.
const ENV = `
:root{ --cyc-accent: rgb(1,2,3); }
html[data-theme='dark']{ --cyc-accent: rgb(10,11,12); }
`;

const PROPS = [
  'position',
  'width',
  'height',
  'min-width',
  'padding-left',
  'padding-top',
  'display',
  'opacity',
  'transform',
  'cursor',
  'background-color',
  'font-size',
  'border-top-left-radius'
] as const;

type Probe = Record<(typeof PROPS)[number], string>;

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

async function measure(
  className: string,
  extraClass: string,
  theme: 'day' | 'night',
  attrs = ''
): Promise<Probe> {
  const full = (className + ' ' + extraClass).trim();
  const utilities = await compileTailwind(tokenize(full));
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/sessions/sessions.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/chat/chat.css'), 'utf8') +
    '\n' +
    ENV;
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  const html =
    `<!DOCTYPE html><html${themeAttr}><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
    `<body><div id="parent" style="position:relative;width:800px;height:800px">` +
    `<div id="n" class="${full}" ${attrs}></div></div></body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(
      (props) => {
        const cs = getComputedStyle(document.querySelector('#n')!);
        const o: Record<string, string> = {};
        for (const p of props) o[p] = cs.getPropertyValue(p);
        return o as never;
      },
      PROPS as unknown as string[]
    );
  } finally {
    await page.close();
  }
}

function mkListDeps(): ListPaneDeps {
  return {
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
}

const sess = (over: Partial<CycSession> = {}): CycSession =>
  ({
    id: 's1',
    name: 'Relay',
    messages: [],
    unread: 0,
    muted: false,
    cwd: '/srv',
    lastActivity: 0,
    ...over
  }) as unknown as CycSession;

// Capture classes from the real producers.
function producers() {
  // Two tabs surface the host strip (a single tab hides it); the second builds the
  // host-tab count pill (BADGE_COMPACT).
  fake.tabs = [
    {id: 'e1#t1', label: 'a', state: 'connected', unread: 0, activity: false},
    {id: 'e1#t2', label: 'b', state: 'connected', unread: 3, activity: true}
  ];
  const pane = createListPane(mkListDeps());
  pane.renderTabs();
  const badge20 = (pane.leftMain.querySelector('.cyc-seg-count') as HTMLElement).className;

  const chat = document.createElement('div');
  const scroll = document.createElement('div');
  const chrome = createChatChrome({chat, scroll, nearBottomPx: 100, closeSettleGrace: () => {}});
  const composerBox = document.createElement('div');
  chrome.mount(composerBox, () => {});
  const badge24 = (composerBox.querySelector('.cyc-jump-latest-badge') as HTMLElement).className;

  const dotRow = chatRow(sess({unread: 0, status: 'done'} as Partial<CycSession>), {mark: 'done'});
  const stateDot = (dotRow.querySelector('.cyc-state-badge') as HTMLElement).className;

  const blocks = createComposerBlocks({
    input: document.createElement('div'),
    composerRows: document.createElement('div'),
    btnAttach: document.createElement('button'),
    isDisabled: () => false,
    setEmpty: vi.fn(),
    applyPlaceholder: vi.fn()
  } as unknown as Parameters<typeof createComposerBlocks>[0]);
  const thumb = blocks.blocksThumb.className;

  const spinner = CHAT_BUSY_RING_CLASS;
  return {badge20, badge24, stateDot, thumb, spinner};
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  fake.sessions = [];
  fake.tabs = [];
  dataState.mode = 'live';
  sessionState.activeId = null;
  sessionState.activeTabId = 'e1#t1';
  vi.clearAllMocks();
});
afterAll(async () => {
  await browser?.close();
});

describe('badge reauthor: the owned dimension groups preserve the shipped box', () => {
  for (const theme of ['day', 'night'] as const) {
    test(`${theme}: host pill is compact, go-down pill is prominent, both are round`, async () => {
      const p = producers();
      const primary = theme === 'night' ? 'rgb(10, 11, 12)' : 'rgb(1, 2, 3)';

      const b20 = await measure(p.badge20, '', theme);
      expect(b20.height).toBe('18px');
      expect(b20['min-width']).toBe('18px');
      expect(b20['padding-left']).toBe('4px');
      expect(parseFloat(b20['border-top-left-radius'])).toBeGreaterThan(8);
      expect(b20['background-color']).toBe(primary);

      const b24 = await measure(p.badge24, '', theme);
      expect(b24.height).toBe('28px');
      expect(b24['min-width']).toBe('28px');
      expect(b24['padding-left']).toBe('10px');
      expect(parseFloat(b24['border-top-left-radius'])).toBeGreaterThan(8);
      expect(b24['background-color']).toBe(primary);
    });
  }

  test('the platform hidden attribute collapses the pill; clearing it restores the box', async () => {
    const p = producers();
    const empty = await measure(p.badge24, '', 'day', 'hidden');
    expect(empty.display).toBe('none');
    const shown = await measure(p.badge24, '', 'day');
    expect(shown.display).not.toBe('none');
  });

  test('the row state dot resolves the owned 0.625rem (9.375px) box inline', async () => {
    const p = producers();
    const dot = await measure(p.stateDot, '', 'day');
    expect(dot.height).toBe('10px'); // DOT_MD size-2.5
  });
});

describe('scroll-thumb residual: opacity cascade + final radius', () => {
  for (const theme of ['day', 'night'] as const) {
    test(`${theme}: absolute 5px thumb, scrollbar-color fill, radius from --cyc-radius`, async () => {
      const p = producers();
      const base = await measure(p.thumb, '', theme);
      expect(base.position).toBe('absolute');
      expect(base.width).toBe('5px');
      expect(base['border-top-left-radius']).toBe('6px');
      expect(base['background-color']).toBe(
        theme === 'night' ? 'rgba(228, 232, 240, 0.24)' : 'rgba(28, 32, 40, 0.24)'
      );
      expect(base.opacity).toBe('0');
    });
  }

  test('opacity-0! keeps the thumb hidden until its scroll surface is hovered', async () => {
    const p = producers();
    const shown = await measure(p.thumb, 'cyc-shown', 'day');
    expect(shown.opacity).toBe('0');
  });
});

describe('spinner box residual: base geometry + cyc-visible reveal + swing cursor', () => {
  test('hidden at rest (opacity 0, scale 0), 54px flex, cursor default', async () => {
    const p = producers();
    const base = await measure(p.spinner, '', 'day');
    expect(base.width).toBe('54px');
    expect(base.height).toBe('54px');
    expect(base.display).toBe('flex');
    expect(base.opacity).toBe('0');
    expect(base.transform).toBe('matrix(0, 0, 0, 0, 0, 0)'); // scale(0)
    expect(base.cursor).toBe('default'); // swing box
  });

  test('cyc-visible reveals to opacity 1 / scale 1', async () => {
    const p = producers();
    const on = await measure(p.spinner, 'cyc-visible', 'day');
    expect(on.opacity).toBe('1');
    expect(on.transform).toBe('matrix(1, 0, 0, 1, 0, 0)'); // scale(1)
  });
});
