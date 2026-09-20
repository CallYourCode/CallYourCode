import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// Minimal engine seams needed to construct the settings pane in jsdom.
vi.mock('../engine/store', () => ({
  overlayEnabled: () => false,
  setOverlayEnabled: vi.fn(async () => {}),
  globalSettings: () => ({sound: false, geom: false, speed: 1, keymap: {}}),
  setGlobalSettings: vi.fn(async () => true),
  onGlobalSettings: vi.fn(),
  engineReachable: () => true,
  syncStatus: () => 'live',
  subscribe: () => () => {},
  toolbarPluginIds: () => new Set<string>(['files', 'git'])
}));
vi.mock('../engine/pushNotify', () => ({
  pushState: () => 'off',
  pushRealState: vi.fn(async () => 'off'),
  installedForPush: () => true,
  enablePush: vi.fn(async () => 'on'),
  disablePush: vi.fn(async () => 'off')
}));
vi.mock('../engine/contract', () => ({
  enginePin: (): string | null => null,
  clearEnginePinAndReload: vi.fn(),
  engineUrls: (): string[] => []
}));
vi.mock('../features/pairing/enginesSettings', () => ({
  createEnginesSection: () => document.createElement('div')
}));
vi.mock('../features/diagnostics/reporting', () => ({
  fileReport: vi.fn(async () => ({state: 'sent', id: 'x'})),
  waitingReports: () => 0,
  startReportOutbox: vi.fn()
}));
vi.mock('../sessionSelectors', () => ({
  active: (): null => null,
  activeEngineKey: (): string | null => 'e1#t1',
  visibleTabs: (): unknown[] => [{engineKey: 'e1#t1', label: 'homebox'}]
}));

import {createSettingsPane} from '../features/settings/pane';
import {toolbarActionShown, TOOLBAR_ACTIONS} from '../features/settings/preferences';
import {sessionState} from '../sessionState';

const stubDeps = () => ({
  onTeardown: () => {},
  setSettingsOpen: () => {},
  archivedCount: () => 0,
  paintPluginCards: () => {},
  render: () => {},
  refreshToolbarActions: vi.fn()
});

function sessionKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith('cyc-mast-session::') || k.startsWith('cyc-mast::')) out.push(k);
  }
  return out;
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});
afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  sessionState.activeId = null;
});

describe('toolbar visibility is one global setting for every agent', () => {
  test('toggling in settings with an agent open writes the global bit, no per-session key', () => {
    sessionState.activeId = 'sess-A';
    const deps = stubDeps();
    const pane = createSettingsPane(deps);
    document.body.append(pane.el);
    const row = pane.el.querySelector<HTMLElement>(
      '.cyc-toolbar-visibility [data-cyc-action="files"]'
    );
    expect(row).not.toBeNull();
    expect(toolbarActionShown('e1#t1', 'files')).toBe(false);
    row!.click();
    expect(localStorage.getItem('cyc-toolbar-files')).toBe('1');
    expect(sessionKeys()).toEqual([]);
    // The bit now reads shown for EVERY engine and every session, not just
    // the one that was open when it was flipped.
    expect(toolbarActionShown('e1#t1', 'files')).toBe(true);
    expect(toolbarActionShown('another-engine', 'files')).toBe(true);
    expect(toolbarActionShown(null, 'files')).toBe(true);
    expect(deps.refreshToolbarActions).toHaveBeenCalled();
    row!.click();
    expect(localStorage.getItem('cyc-toolbar-files')).toBe('0');
    expect(toolbarActionShown('another-engine', 'files')).toBe(false);
  });
});

describe('one default set on every device class', () => {
  const defaultsAt = (width: number): string[] => {
    (window as {innerWidth: number}).innerWidth = width;
    return TOOLBAR_ACTIONS.map((a) => a.id).filter((id) => toolbarActionShown(null, id));
  };
  test('phone, tablet and laptop widths all get the same simple set', () => {
    const want = ['speed', 'ctx', 'search', 'stop'];
    expect(defaultsAt(400).sort()).toEqual([...want].sort());
    expect(defaultsAt(700).sort()).toEqual([...want].sort());
    expect(defaultsAt(1400).sort()).toEqual([...want].sort());
  });
});
