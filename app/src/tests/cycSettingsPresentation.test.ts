import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {eyeState} from '../components/widgets';
import {
  currentPresentationTheme,
  setPresentationTheme,
  themePainterCount
} from '../components/presentation';

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

const stubDeps = () => ({
  onTeardown: () => {},
  setSettingsOpen: () => {},
  archivedCount: () => 0,
  paintPluginCards: () => {},
  render: () => {},
  refreshToolbarActions: () => {}
});

beforeEach(() => {
  document.documentElement.dir = '';
  document.body.innerHTML = '';
  setPresentationTheme('day');
  try {
    localStorage.removeItem('cyc-keymap');
  } catch {}
});

afterEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('eyeState colour is chosen by TS per theme/state', () => {
  test('shown uses the primary-text literal; hidden uses secondary-text', () => {
    const {el} = eyeState(true);
    expect(el.className).toContain('text-[#1c1c1e]');
    expect(el.className).not.toContain('text-[#6b6b70]');
    expect(el.classList.contains('cyc-eye-hidden')).toBe(false);
  });

  test('set(false) swaps to the hidden colour and marks the state', () => {
    const eye = eyeState(true);
    eye.set(false);
    expect(eye.el.className).toContain('text-[#6b6b70]');
    expect(eye.el.className).not.toContain('text-[#1c1c1e]');
    expect(eye.el.classList.contains('cyc-eye-hidden')).toBe(true);
  });

  test('night theme picks the night literals', () => {
    setPresentationTheme('night');
    const shown = eyeState(true);
    const hidden = eyeState(false);
    expect(shown.el.className).toContain('text-[#ededee]');
    expect(hidden.el.className).toContain('text-[#a0a0a6]');
  });

  test('a mounted eye repaints when the theme changes, and prunes on detach', () => {
    const before = themePainterCount();
    const eye = eyeState(false);
    document.body.append(eye.el);
    expect(themePainterCount()).toBe(before + 1);
    expect(eye.el.className).toContain('text-[#6b6b70]');
    setPresentationTheme('night');
    expect(eye.el.className).toContain('text-[#a0a0a6]');
    expect(eye.el.className).not.toContain('text-[#6b6b70]');
    eye.el.remove();
    setPresentationTheme('day');
    expect(themePainterCount()).toBe(before);
  });

  test('carries no CSS-variable styling', () => {
    const {el} = eyeState(false);
    expect(el.className).not.toContain('var(--');
  });
});

describe('settings pane slide/subpage geometry is chosen by TS', () => {
  test('pane rests off-screen with the current transform/transition/pointer-events', () => {
    const pane = createSettingsPane(stubDeps());
    const cls = pane.el.className;
    expect(cls).toContain('[transform:translate3d(-105%,0,0)]');
    expect(cls).toContain('[transition:transform_0.3s_cubic-bezier(0.32,0.72,0,1)]');
    expect(cls).toContain('pointer-events-none');
    expect(cls).toContain('[.cyc-settings-open_&]:transform-[translate3d(0,0,0)]!');
    const scroll = pane.el.querySelector<HTMLElement>('.cyc-overflow-pane');
    expect(scroll).not.toBeNull();
    expect(scroll!.className).toContain('flex-auto');
  });

  test('opening a subpage paints the open transform, closing removes it', () => {
    const pane = createSettingsPane(stubDeps());
    document.body.append(pane.el);
    const nav = pane.el.querySelector<HTMLElement>('[data-cyc-page="keyboard"]')!;
    const subpages = [...pane.el.querySelectorAll<HTMLElement>('.cyc-settings-subpage')];
    expect(subpages.length).toBeGreaterThan(0);
    for (const s of subpages) {
      expect(s.className).toContain('[transform:translate3d(105%,0,0)]');
      expect(s.classList.contains('cyc-subpage-open')).toBe(false);
    }

    nav.click();
    expect(pane.hasOpenSubPage()).toBe(true);
    const open = pane.el.querySelector<HTMLElement>('.cyc-settings-subpage.cyc-subpage-open')!;
    expect(open).not.toBeNull();
    expect(open.className).toContain('[transform:translate3d(0,0,0)]!');
    expect(open.className).toContain('pointer-events-auto!');

    pane.closeSubPage();
    expect(pane.hasOpenSubPage()).toBe(false);
    expect(open.classList.contains('cyc-subpage-open')).toBe(false);
    expect(open.className).not.toContain('[transform:translate3d(0,0,0)]!');
  });
});

describe('the tips card paints its own headless geometry', () => {
  test('the headless tips card carries the current margin/padding/background', () => {
    const pane = createSettingsPane(stubDeps());
    const card = pane.el.querySelector<HTMLElement>('.cyc-hints.cyc-hints-headless')!;
    expect(card).not.toBeNull();
    for (const cls of ['my-0!', 'pt-1!', 'px-4!', 'pb-2!', 'bg-transparent!']) {
      expect(card.className).toContain(cls);
    }
    expect(pane.el.querySelector('.cyc-tips-page')).toBeNull();
  });
});

describe('keymap row state is painted by TS', () => {
  const rightOf = (pane: HTMLElement, action: string) =>
    pane.querySelector<HTMLElement>(
      `.cyc-keymap-row[data-cyc-action="${action}"] .cyc-list-row-right`
    )!;

  test('an unbound action fades its chord slot; a bound one does not', () => {
    const pane = createSettingsPane(stubDeps());
    document.body.append(pane.el);
    // listPrev binds Meta+ArrowUp.
    expect(rightOf(pane.el, 'tabPrev').className).toContain('opacity-[0.5]');
    expect(rightOf(pane.el, 'listPrev').className).not.toContain('opacity-[0.5]');
  });

  test('clicking a row records: primary tint + inherit face, cleared on cancel', () => {
    const pane = createSettingsPane(stubDeps());
    document.body.append(pane.el);
    const row = pane.el.querySelector<HTMLElement>('.cyc-keymap-row[data-cyc-action="listPrev"]')!;
    const right = rightOf(pane.el, 'listPrev');

    row.click();
    expect(row.classList.contains('cyc-keymap-recording')).toBe(true);
    expect(right.textContent).toBe('Press a key');
    expect(right.className).toContain('[font-family:inherit]!');
    expect(right.className).toContain('text-[#96602f]!');

    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(row.classList.contains('cyc-keymap-recording')).toBe(false);
    expect(right.className).not.toContain('[font-family:inherit]!');
    expect(right.className).not.toContain('text-[#96602f]!');
  });

  test('the recording tint follows a live theme change', () => {
    const pane = createSettingsPane(stubDeps());
    document.body.append(pane.el);
    const row = pane.el.querySelector<HTMLElement>('.cyc-keymap-row[data-cyc-action="listPrev"]')!;
    const right = rightOf(pane.el, 'listPrev');
    row.click();
    expect(currentPresentationTheme()).toBe('day');
    expect(right.className).toContain('text-[#96602f]!');
    setPresentationTheme('night');
    expect(right.className).toContain('text-[#c98652]!');
    expect(right.className).not.toContain('text-[#96602f]!');
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  });
});
