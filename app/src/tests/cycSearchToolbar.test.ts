import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {createHeaderActions, type HeaderActions} from '../features/sessions/header/actions';
import {
  CORE_TOOLBAR_ACTION_IDS,
  TOOLBAR_ACTIONS,
  engineToolbarActions,
  orderedToolbarActions,
  toolbarActionById,
  toolbarActionShown,
  type CycToolbarActionId
} from '../features/settings/preferences';

const ENGINE = 'search-engine';
const WITH_SEARCH = new Set(['search']);
const WITHOUT_SEARCH = new Set<string>();

beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const ORIGINAL_WIDTH = window.innerWidth;
afterEach(() => {
  localStorage.clear();
  document.body.textContent = '';
  window.innerWidth = ORIGINAL_WIDTH;
});

function makeBar(
  plugins: ReadonlySet<string>,
  onPluginAction?: (id: CycToolbarActionId) => void
): {utils: HTMLElement; actions: HeaderActions} {
  const el = document.createElement('div');
  const utils = document.createElement('div');
  el.append(utils);
  document.body.append(el);
  const actions = createHeaderActions({
    el,
    utils,
    sessionId: () => 'sess-1',
    toolbarEngine: () => ({engineKey: ENGINE, plugins}),
    onPluginAction
  });
  utils.append(actions.headerBreak);
  return {utils, actions};
}

describe('Search toolbar action catalog', () => {
  test('is a plugin-gated catalog row placed just before Stop', () => {
    const search = TOOLBAR_ACTIONS.find((a) => a.id === 'search');
    expect(search).toEqual({
      id: 'search',
      icon: 'search',
      label: 'Search',
      needsEngine: true,
      plugin: 'search'
    });
    const ids = TOOLBAR_ACTIONS.map((a) => a.id);
    expect(ids.indexOf('search')).toBe(ids.indexOf('stop') - 1);
  });

  test('lives in the core id set between persona and crons', () => {
    expect(CORE_TOOLBAR_ACTION_IDS).toContain('search');
    const ids = CORE_TOOLBAR_ACTION_IDS as readonly string[];
    expect(ids.indexOf('persona')).toBeLessThan(ids.indexOf('search'));
    expect(ids.indexOf('search')).toBeLessThan(ids.indexOf('crons'));
  });

  test('canonical order for a search-capable engine includes it', () => {
    expect(orderedToolbarActions(ENGINE).map((a) => a.id)).toContain('search');
  });
});

describe('Search toolbar action plugin gating', () => {
  test('shows only when the engine declares the search panel plugin', () => {
    expect(engineToolbarActions(ENGINE, WITH_SEARCH).map((a) => a.id)).toContain('search');
    expect(engineToolbarActions(ENGINE, WITHOUT_SEARCH).map((a) => a.id)).not.toContain('search');
  });

  test('resolves to the generic panel action when declared, nothing when absent', () => {
    expect(toolbarActionById(ENGINE, 'search', WITH_SEARCH)?.plugin).toBe('search');
    expect(toolbarActionById(ENGINE, 'search', WITHOUT_SEARCH)).toBeUndefined();
  });
});

describe('Search toolbar slot rendering and invocation', () => {
  test('a declared search panel yields a visible data-cyc-action=search slot', () => {
    localStorage.setItem('cyc-toolbar-search', '1');
    const {utils, actions} = makeBar(WITH_SEARCH);
    actions.refreshToolbarActions();
    const slot = utils.querySelector<HTMLElement>('[data-cyc-action="search"]');
    expect(slot).not.toBeNull();
    expect(slot!.classList.contains('cyc-off')).toBe(false);
  });

  test('an engine without the search plugin never lands a search slot', () => {
    localStorage.setItem('cyc-toolbar-search', '1');
    const {utils, actions} = makeBar(WITHOUT_SEARCH);
    actions.refreshToolbarActions();
    expect(utils.querySelector('[data-cyc-action="search"]')).toBeNull();
  });

  test('clicking the search slot opens the Search panel via the generic path', () => {
    localStorage.setItem('cyc-toolbar-search', '1');
    const onPluginAction = vi.fn();
    const {utils, actions} = makeBar(WITH_SEARCH, onPluginAction);
    actions.refreshToolbarActions();
    const btn = actions.actionButton('search');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onPluginAction).toHaveBeenCalledWith('search');
    expect(utils.querySelector('[data-cyc-action="search"]')).toBe(
      actions.actionButton('search')!.closest('[data-cyc-action]')
    );
  });
});

describe('Search default visibility and order migration', () => {
  test('is shown by default on every device: one default set, no device classes', () => {
    window.innerWidth = 400;
    expect(toolbarActionShown(ENGINE, 'search')).toBe(true);
    window.innerWidth = 1400;
    expect(toolbarActionShown(ENGINE, 'search')).toBe(true);
  });

  test('a stored drag order keeps search when the engine declares its plugin', () => {
    localStorage.setItem('cyc-toolbar-search', '1');
    localStorage.setItem(`cyc-mast-order::${ENGINE}`, JSON.stringify(['search', 'speed', 'stop']));
    const {utils, actions} = makeBar(WITH_SEARCH);
    actions.refreshToolbarActions();
    const first = utils.querySelector<HTMLElement>('[data-cyc-action]');
    expect(first?.dataset.cycAction).toBe('search');
  });
});
