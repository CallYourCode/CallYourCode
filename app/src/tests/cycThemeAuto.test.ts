import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {setPresentationTheme} from '../components/presentation';
import {applyCycTheme, currentCycTheme, storedCycTheme} from '../features/settings/preferences';

// Minimal engine seams needed to construct the pane in jsdom.
vi.mock('../engine/store', () => ({
  overlayEnabled: () => false,
  setOverlayEnabled: vi.fn(async () => {}),
  globalSettings: () => ({sound: false, geom: false, speed: 1, keymap: {}}),
  setGlobalSettings: vi.fn(async () => true),
  onGlobalSettings: vi.fn(),
  engineReachable: () => true,
  syncStatus: () => 'live',
  subscribe: () => () => {},
  toolbarPluginIds: () => new Set<string>()
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
  activeEngineKey: (): string | null => null,
  visibleTabs: (): unknown[] => []
}));

import {createSettingsPane} from '../features/settings/pane';
import {installShell} from '../shell/viewport';

// A controllable prefers-color-scheme: flip() fires 'change' like the OS does.
function fakeDevice(dark: boolean) {
  let isDark = dark;
  const listeners = new Set<() => void>();
  const scheme = {
    get matches() {
      return isDark;
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb)
  };
  const other = {matches: false, addEventListener() {}, removeEventListener() {}};
  window.matchMedia = ((q: string) =>
    q === '(prefers-color-scheme: dark)' ? scheme : other) as unknown as typeof window.matchMedia;
  return {
    listeners,
    flip(next: boolean) {
      isDark = next;
      listeners.forEach((cb) => cb());
    }
  };
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
  localStorage.removeItem('cyc-skin');
});

afterEach(() => {
  // Drop any device listener left by an 'auto' test before the next fake lands.
  applyCycTheme('day');
  localStorage.removeItem('cyc-skin');
  window.matchMedia = realMatchMedia;
  document.body.innerHTML = '';
});

describe('auto theme follows prefers-color-scheme', () => {
  test('auto resolves to the media query and is stored as auto', () => {
    fakeDevice(true);
    applyCycTheme('auto');
    expect(currentCycTheme()).toBe('night');
    expect(document.documentElement.style.getPropertyValue('--cyc-surface')).toBe('#17171a');
    expect(localStorage.getItem('cyc-skin')).toBe('auto');
    expect(storedCycTheme()).toBe('auto');
  });

  test('a device change while auto repaints at once through applyCycTheme', () => {
    const device = fakeDevice(false);
    applyCycTheme('auto');
    expect(currentCycTheme()).toBe('day');
    device.flip(true);
    expect(currentCycTheme()).toBe('night');
    expect(document.documentElement.style.getPropertyValue('--cyc-surface')).toBe('#17171a');
    device.flip(false);
    expect(currentCycTheme()).toBe('day');
    expect(localStorage.getItem('cyc-skin')).toBe('auto');
  });

  test('a manual choice stops following the device', () => {
    const device = fakeDevice(false);
    applyCycTheme('auto');
    applyCycTheme('day');
    expect(device.listeners.size).toBe(0);
    device.flip(true);
    expect(currentCycTheme()).toBe('day');
    expect(localStorage.getItem('cyc-skin')).toBe('day');
  });
});

describe('boot default', () => {
  const boot = () => {
    document.body.innerHTML = '<div id="cyc-app"></div>';
    return installShell(document.getElementById('cyc-app')!);
  };

  test('stored day/night are kept as they are', () => {
    fakeDevice(true);
    localStorage.setItem('cyc-skin', 'day');
    const stopDay = boot();
    expect(currentCycTheme()).toBe('day');
    expect(localStorage.getItem('cyc-skin')).toBe('day');
    stopDay();
    fakeDevice(false);
    localStorage.setItem('cyc-skin', 'night');
    const stopNight = boot();
    expect(currentCycTheme()).toBe('night');
    expect(localStorage.getItem('cyc-skin')).toBe('night');
    stopNight();
  });

  test('nothing stored starts on auto and resolves to the device', () => {
    fakeDevice(true);
    const stop = boot();
    expect(localStorage.getItem('cyc-skin')).toBe('auto');
    expect(currentCycTheme()).toBe('night');
    stop();
  });
});

describe('settings rows', () => {
  const stubDeps = () => ({
    onTeardown: () => {},
    setSettingsOpen: () => {},
    archivedCount: () => 0,
    paintPluginCards: vi.fn(),
    render: () => {},
    refreshToolbarActions: () => {}
  });
  const mount = () => {
    const deps = stubDeps();
    const pane = createSettingsPane(deps);
    document.body.append(pane.el);
    const input = (title: string) => {
      const row = [...pane.el.querySelectorAll<HTMLElement>('.cyc-list-row')].find(
        (r) => r.querySelector('.cyc-list-row-title')?.textContent === title
      );
      return row!.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    };
    return {deps, device: input('Match device theme'), night: input('Theme')};
  };
  const click = (el: HTMLInputElement) => {
    el.checked = !el.checked;
    el.dispatchEvent(new Event('change'));
  };

  test('Match device theme sits right above Theme', () => {
    const pane = createSettingsPane(stubDeps());
    const titles = [...pane.el.querySelectorAll('.cyc-list-row-title')]
      .map((t) => t.textContent)
      .filter(Boolean);
    expect(titles.indexOf('Match device theme') + 1).toBe(titles.indexOf('Theme'));
  });

  test('turning it on follows the device; Theme shows the effective theme, disabled', () => {
    const device = fakeDevice(true);
    applyCycTheme('day');
    const {deps, device: auto, night} = mount();
    expect(auto.checked).toBe(false);
    expect(night.disabled).toBe(false);
    click(auto);
    expect(localStorage.getItem('cyc-skin')).toBe('auto');
    expect(currentCycTheme()).toBe('night');
    expect(night.checked).toBe(true);
    expect(night.disabled).toBe(true);
    deps.paintPluginCards.mockClear();
    device.flip(false);
    expect(night.checked).toBe(false);
    expect(night.disabled).toBe(true);
    expect(deps.paintPluginCards).toHaveBeenCalled();
  });

  test('turning it off keeps the current theme as a manual choice', () => {
    const device = fakeDevice(true);
    applyCycTheme('auto');
    const {device: auto, night} = mount();
    expect(auto.checked).toBe(true);
    expect(night.checked).toBe(true);
    expect(night.disabled).toBe(true);
    click(auto);
    expect(localStorage.getItem('cyc-skin')).toBe('night');
    expect(night.disabled).toBe(false);
    device.flip(false);
    expect(currentCycTheme()).toBe('night');
    click(night);
    expect(currentCycTheme()).toBe('day');
    expect(localStorage.getItem('cyc-skin')).toBe('day');
  });
});
