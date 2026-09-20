import {afterAll, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';
import type {CycSession} from '../types';

// Cascade coverage for floating action controls.
const fake = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  tabs: [] as Array<{id: string; label: string; state: string; unread: number; activity: boolean}>,
  windowActive: false,
  notify: true
}));
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
import {sessionState, dataState} from '../sessionState';

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

// Theme sentinels for computed-style assertions.
const ENV = `
:root{
  --cyc-surface:rgb(30,31,32);
  --cyc-accent:rgb(1,2,3);
  --cyc-accent-pressed:rgb(101,102,103);
  --cyc-text-muted:rgb(4,5,6);
  --cyc-text-muted-tint:rgb(7,8,9);
  --cyc-text:rgb(20,21,22);
  --cyc-fill-color:rgb(50,51,52);
  --cyc-action-float-size:3.5rem;
  --cyc-action-float-offset:1rem;
  --cyc-safe-bottom:11px;
}
html[data-theme='dark']{
  --cyc-surface:rgb(40,41,42);
  --cyc-accent:rgb(10,11,12);
  --cyc-text-muted:rgb(13,14,15);
  --cyc-text:rgb(60,61,62);
}
@media (max-width:550px){ :root{ --cyc-action-float-offset:1.5rem; } }
`;

const PROPS = [
  'position',
  'z-index',
  'left',
  'right',
  'bottom',
  'transform',
  'transition-property',
  'box-shadow',
  'background-color',
  'color',
  'display',
  'opacity',
  'visibility',
  'cursor',
  'text-align',
  'font-size',
  'line-height',
  'align-items',
  'justify-content',
  'border-top-left-radius'
] as const;

type Probe = Record<(typeof PROPS)[number], string>;

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

// Render a producer in the app stylesheet order for computed-style checks.
async function measure(
  className: string,
  opts: {extraClass?: string; wrapClass?: string; wrapAttr?: string},
  theme: 'day' | 'night',
  dir: 'ltr' | 'rtl',
  viewport: number
): Promise<Probe> {
  const full = (className + ' ' + (opts.extraClass ?? '')).trim();
  const utilities = await compileTailwind(tokenize(full + ' ' + (opts.wrapClass ?? '')));
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
  const dirAttr = dir === 'rtl' ? " dir='rtl'" : '';
  const parent = `<div id="parent" style="position:relative;width:${viewport}px;height:800px"><button id="n" class="${full}"></button></div>`;
  const wrapAttr = opts.wrapAttr ? ` ${opts.wrapAttr}` : '';
  const body = opts.wrapClass
    ? `<div class="${opts.wrapClass}"${wrapAttr}>${parent}</div>`
    : parent;
  const html =
    `<!DOCTYPE html><html${themeAttr}${dirAttr}><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head><body>${body}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setViewportSize({width: viewport, height: 800});
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

function producerClasses(): {
  goDown: string;
  audioJump: string;
  floatingAction: string;
  newConversation: string;
} {
  const pane = createListPane(mkListDeps());
  const floatingAction = pane.floatingAction.className;
  const newConversation = (pane.leftContent.querySelector('.cyc-new-conversation') as HTMLElement)
    .className;

  const chat = document.createElement('div');
  const scroll = document.createElement('div');
  const chrome = createChatChrome({chat, scroll, nearBottomPx: 100, closeSettleGrace: () => {}});
  const composerBox = document.createElement('div');
  const {audioJumpChip} = chrome.mount(composerBox, () => {});
  const goDown = (composerBox.querySelector('.cyc-jump-latest') as HTMLElement).className;
  const audioJump = audioJumpChip.className;
  return {goDown, audioJump, floatingAction, newConversation};
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

const OFFSET = '20px';
// The scroll-down button is nudged closer to the trailing edge (end-3 = 0.75rem).
const GO_DOWN_OFFSET = '12px';
const FONT = '24px';

describe('action-float cascade: all four FABs preserve the final base geometry', () => {
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'day'],
    ['ltr', 'night'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: z=1, absolute, centered, primary/fill paint, no revived reset`, async () => {
      const c = producerClasses();

      const fab = await measure(c.floatingAction, {}, theme, dir, 800);
      // z flattened to 1 (authored z-[3] was dead under the un-layered base z-index:1).
      expect(fab['z-index']).toBe('1');
      expect(fab.position).toBe('absolute');
      expect(fab.display).toBe('flex');
      expect(fab['align-items']).toBe('center');
      expect(fab['justify-content']).toBe('center');
      expect(fab['text-align']).toBe('center');
      // font-size must stay 1.5rem: the layered text utility is important so it beats
      // the un-layered `button{font-size:inherit}` reset the base used to shadow.
      expect(fab['font-size']).toBe(FONT);
      // Primary fill survives `button{background:none}` (needs important); white ink.
      expect(fab['background-color']).toBe(theme === 'night' ? 'rgb(10, 11, 12)' : 'rgb(1, 2, 3)');
      expect(fab.color).toBe('rgb(255, 255, 255)');
      expect(fab['border-top-left-radius']).toBe('12px'); // rounded-[12px]! beats radius machine
      // Fixed 1.25rem offset on both axes; RTL swaps physical left/right.
      expect(fab.bottom).toBe(OFFSET);
      if (dir === 'ltr') expect(fab.right).toBe(OFFSET);
      else expect(fab.left).toBe(OFFSET);
      expect(fab.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');

      const nc = await measure(c.newConversation, {}, theme, dir, 800);
      expect(nc['z-index']).toBe('1');
      expect(nc.position).toBe('absolute');
      expect(nc['font-size']).toBe(FONT);
      expect(nc['background-color']).toBe(
        theme === 'night' ? 'rgb(50, 51, 52)' : 'rgb(50, 51, 52)'
      );
      expect(nc['box-shadow']).toBe('none');
      expect(nc.bottom).toBe(OFFSET);
      if (dir === 'ltr') expect(nc.right).toBe(OFFSET);
      else expect(nc.left).toBe(OFFSET);
      expect(nc.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
    });
  }
});

describe('action-float cascade: the chat FABs keep their feature-override behavior', () => {
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'day'],
    ['ltr', 'night'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: go-down surface/primary-ink override + audio-jump transform transition`, async () => {
      const c = producerClasses();

      // Both corner buttons float 1rem above the top edge of the box they live
      // in (here the 800px #parent): bottom = 800 + 16. Squarish with a fixed
      // 14px radius and the low elevation shadow (the un-layered 6px
      // `.cyc-action-float` radius loses to the later `.cyc-corner-btn` 14px).
      const FLOAT_BOTTOM = '816px';
      // Squarish, not a circle: the shared `.cyc-corner-btn` rule pins 14px.
      const CORNER_RADIUS = '14px';
      const SHADOW = 'rgba(0, 0, 0, 0.18) 0px 1px 3px 0px, rgba(0, 0, 0, 0.12) 0px 4px 12px 0px';

      // go-down: trailing offset is the nudged inset-inline-end (0.75rem, end-3),
      // NOT the shared 1.25rem; bg/ink owned by the important `html body .cyc-jump-latest`;
      // its transition stays the chat-owned opacity/transform/visibility (important),
      // not a revived transform-only.
      const gd = await measure(
        c.goDown,
        {wrapClass: 'cyc-thread', wrapAttr: 'data-cyc-godown'},
        theme,
        dir,
        800
      );
      expect(gd['z-index']).toBe('1');
      expect(gd.position).toBe('absolute');
      expect(gd['font-size']).toBe(FONT);
      expect(gd['box-shadow']).toBe(SHADOW);
      expect(gd['border-top-left-radius']).toBe(CORNER_RADIUS);
      const surface = theme === 'night' ? 'rgb(40, 41, 42)' : 'rgb(30, 31, 32)';
      const primaryText = theme === 'night' ? 'rgb(60, 61, 62)' : 'rgb(20, 21, 22)';
      expect(gd['background-color']).toBe(surface);
      expect(gd.color).toBe(primaryText);
      expect(gd['transition-property']).toBe('opacity');
      if (dir === 'ltr') expect(gd.right).toBe(GO_DOWN_OFFSET);
      else expect(gd.left).toBe(GO_DOWN_OFFSET);
      expect(gd.visibility).toBe('visible'); // data-cyc-godown parent state
      expect(gd.opacity).toBe('1');
      expect(gd.cursor).toBe('pointer'); // data-cyc-godown flips cursor-default!->pointer!
      expect(gd.bottom).toBe(FLOAT_BOTTOM);

      const gdRest = await measure(c.goDown, {}, theme, dir, 800);
      expect(gdRest.opacity).toBe('0');
      expect(gdRest.visibility).toBe('hidden');
      expect(gdRest.cursor).toBe('default');
      expect(gdRest.bottom).toBe(FLOAT_BOTTOM);

      // audio-jump: its authored opacity/visibility transition was dead under the base

      // that transform-only transition (transition-property MUST be `transform`).
      const aj = await measure(
        c.audioJump,
        {wrapClass: 'cyc-thread', wrapAttr: 'data-cyc-audiojump'},
        theme,
        dir,
        800
      );
      expect(aj['z-index']).toBe('1');
      expect(aj.position).toBe('absolute');
      expect(aj['font-size']).toBe(FONT);
      expect(aj['box-shadow']).toBe(SHADOW);
      expect(aj['border-top-left-radius']).toBe(CORNER_RADIUS);
      expect(aj['background-color']).toBe(surface);
      expect(aj.color).toBe(primaryText);
      expect(aj['transition-property']).toBe('opacity');
      // audio-jump now shares the go-down trailing inset (end-3 = 0.75rem) so
      // both corner buttons line up on one vertical axis.
      if (dir === 'ltr') expect(aj.right).toBe(GO_DOWN_OFFSET);
      else expect(aj.left).toBe(GO_DOWN_OFFSET);

      expect(aj.bottom).toBe(FLOAT_BOTTOM);
      expect(aj.opacity).toBe('1'); // data-cyc-audiojump parent state
      expect(aj.visibility).toBe('visible');
      expect(aj.cursor).toBe('pointer');

      const ajRest = await measure(c.audioJump, {}, theme, dir, 800);
      expect(ajRest.opacity).toBe('0');
      expect(ajRest.visibility).toBe('hidden');
      expect(ajRest.cursor).toBe('default');
      expect(ajRest.bottom).toBe(FLOAT_BOTTOM);
    });
  }
});

describe('action-float cascade: self-state + breakpoint invariance', () => {
  test('floatingAction dock state drives translateY; cyc-conv-on paints green', async () => {
    const c = producerClasses();
    const hidden = await measure(
      c.floatingAction.replace(/\bcyc-dock-shown\b/, ''),
      {},
      'day',
      'ltr',
      800
    );
    expect(hidden.transform).toBe('matrix(1, 0, 0, 1, 0, 68)');
    const visible = await measure(c.floatingAction, {}, 'day', 'ltr', 800);
    expect(visible.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
    // Armed self-state swaps the important green (#4ec97b) over the important primary.
    const armed = await measure(c.floatingAction, {extraClass: 'cyc-conv-on'}, 'day', 'ltr', 800);
    expect(armed['background-color']).toBe('rgb(78, 201, 123)');
  });

  test('newConversation hidden translateY consumes the dock inset', async () => {
    const c = producerClasses();
    const hidden = await measure(
      c.newConversation.replace(/\bcyc-dock-shown\b/, ''),
      {},
      'day',
      'ltr',
      800
    );
    expect(hidden.transform).toBe('matrix(1, 0, 0, 1, 0, 68)');
  });

  test('offset is a fixed 1.25rem across <=550 / 551-899 / >=900 (no responsive shift)', async () => {
    const c = producerClasses();
    const small = await measure(c.floatingAction, {}, 'day', 'ltr', 560);
    const mid = await measure(c.floatingAction, {}, 'day', 'ltr', 800);
    const wide = await measure(c.floatingAction, {}, 'day', 'ltr', 1200);
    expect(small.right).toBe(OFFSET);
    expect(mid.right).toBe(OFFSET);
    expect(wide.right).toBe(OFFSET);
    expect(small.bottom).toBe(OFFSET);
    // 551..899 and >=900 render byte-identically (single unconditional box).
    expect(mid.right).toBe(wide.right);
    expect(mid.bottom).toBe(wide.bottom);
  });

  test('RTL flips the physical side without disturbing bottom', async () => {
    const c = producerClasses();
    for (const cls of [c.floatingAction, c.newConversation, c.goDown]) {
      const wrap = cls === c.goDown ? {wrapClass: 'cyc-thread', wrapAttr: 'data-cyc-godown'} : {};
      const expected = cls === c.goDown ? GO_DOWN_OFFSET : OFFSET;
      const ltr = await measure(cls, wrap, 'day', 'ltr', 800);
      const rtl = await measure(cls, wrap, 'day', 'rtl', 800);
      // end- logicalization: physical right in ltr becomes physical left in rtl.
      expect(ltr.right).toBe(expected);
      expect(rtl.left).toBe(expected);
      expect(rtl.bottom).toBe(ltr.bottom);
    }
  });
});

describe('chat corner button reveal', () => {
  const chrome = readFileSync(resolve(SRC, 'features/chat/surface/chatChrome.ts'), 'utf8');
  const audio = readFileSync(resolve(SRC, 'features/chat/surface/audioPlayback.ts'), 'utf8');

  test('uses the chat data-state attributes', () => {
    expect(chrome).toContain("chat.toggleAttribute('data-cyc-godown'");
    expect(audio).toContain("chatEl.toggleAttribute('data-cyc-audiojump'");
    expect(chrome).toContain('[.cyc-thread[data-cyc-godown]_&]:opacity-100');
    expect(chrome).toContain('[.cyc-thread[data-cyc-audiojump]_&]:opacity-100');
  });
});
