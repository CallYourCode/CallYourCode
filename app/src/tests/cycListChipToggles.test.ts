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
import {rowChipShown} from '../features/settings/preferences';

const stubDeps = () => ({
  onTeardown: () => {},
  setSettingsOpen: () => {},
  archivedCount: () => 0,
  paintPluginCards: () => {},
  render: vi.fn(),
  refreshToolbarActions: vi.fn()
});

const chipInput = (pane: {el: HTMLElement}, id: string): HTMLInputElement => {
  const input = pane.el.querySelector<HTMLInputElement>(
    `[data-cyc-chip-row="${id}"] input.cyc-tick-input`
  );
  expect(input).not.toBeNull();
  return input!;
};

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});
afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('list-row chip toggles (one global bit per chip)', () => {
  test('both chips default ON with nothing stored', () => {
    expect(rowChipShown('harness')).toBe(true);
    expect(rowChipShown('model')).toBe(true);
  });
  test('each toggle writes its own shared-storage bit, independently', () => {
    const deps = stubDeps();
    const pane = createSettingsPane(deps);
    document.body.append(pane.el);

    const model = chipInput(pane, 'model');
    expect(model.checked).toBe(true);
    model.click();
    expect(localStorage.getItem('cyc-chip-model')).toBe('0');
    expect(rowChipShown('model')).toBe(false);
    // The other chip's bit is untouched: the toggles are independent.
    expect(localStorage.getItem('cyc-chip-harness')).toBeNull();
    expect(rowChipShown('harness')).toBe(true);
    expect(deps.render).toHaveBeenCalled();

    const harness = chipInput(pane, 'harness');
    harness.click();
    expect(localStorage.getItem('cyc-chip-harness')).toBe('0');
    expect(rowChipShown('harness')).toBe(false);
    expect(rowChipShown('model')).toBe(false);

    model.click();
    expect(localStorage.getItem('cyc-chip-model')).toBe('1');
    expect(rowChipShown('model')).toBe(true);
    expect(rowChipShown('harness')).toBe(false);
  });
  test('a stored bit survives a fresh pane (persistence via the shared storage)', () => {
    localStorage.setItem('cyc-chip-harness', '0');
    const pane = createSettingsPane(stubDeps());
    document.body.append(pane.el);
    expect(chipInput(pane, 'harness').checked).toBe(false);
    expect(chipInput(pane, 'model').checked).toBe(true);
    expect(rowChipShown('harness')).toBe(false);
  });
});
