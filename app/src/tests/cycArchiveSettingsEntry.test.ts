import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

/* The dead-session archive's ENTRY POINT lives in Settings (the conversation
 * list carries no archive affordance; cycDeadSessionArchive proves that side):
 * one "Archived (n)" row at the bottom of the pane, directly ABOVE the
 * "Clear cached data" action. Hidden while nothing is archived. Tapping it
 * opens the archive lens (sessionState.archiveOpen) and closes settings; the
 * lens's "Chats" back row returns to the live list. The count repaints on
 * settings open and through a light store subscription, never through the hot
 * list render key. The pane is real; the engine seams are fakes. */

const fake = vi.hoisted(() => ({
  archived: 0,
  subs: [] as Array<() => void>
}));

// Minimal engine seams needed to construct the settings pane in jsdom.
vi.mock('../engine/store', () => ({
  overlayEnabled: () => false,
  setOverlayEnabled: vi.fn(async () => {}),
  globalSettings: () => ({sound: false, geom: false, speed: 1, keymap: {}}),
  setGlobalSettings: vi.fn(async () => true),
  onGlobalSettings: vi.fn(),
  engineReachable: () => true,
  syncStatus: () => 'live',
  subscribe: (fn: () => void) => {
    fake.subs.push(fn);
    return () => {
      const i = fake.subs.indexOf(fn);
      if (i >= 0) fake.subs.splice(i, 1);
    };
  },
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
import {sessionState} from '../sessionState';

const stubDeps = () => ({
  onTeardown: () => {},
  setSettingsOpen: vi.fn(),
  archivedCount: () => fake.archived,
  paintPluginCards: () => {},
  render: vi.fn(),
  refreshToolbarActions: () => {}
});

const notify = () => fake.subs.forEach((f) => f());
const archivedRowOf = (pane: {el: HTMLElement}): HTMLElement =>
  pane.el.querySelector<HTMLElement>('[data-cyc-row="archived"]')!;

beforeEach(() => {
  document.body.innerHTML = '';
  fake.archived = 0;
  fake.subs.length = 0;
  sessionState.archiveOpen = false;
});
afterEach(() => {
  document.body.innerHTML = '';
  sessionState.archiveOpen = false;
});

describe('the Settings "Archived (n)" row (the archive entry point)', () => {
  test('sits directly ABOVE "Clear cached data", at the bottom of the pane', () => {
    fake.archived = 2;
    const pane = createSettingsPane(stubDeps());
    document.body.append(pane.el);
    const row = archivedRowOf(pane);
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('Archived');
    // The very next row is the delete-data action, in the same card.
    const next = row.nextElementSibling as HTMLElement;
    expect(next.textContent).toContain('Clear cached data');
    expect(next.nextElementSibling).toBeNull();
  });

  test('hidden while nothing is archived; a store notify with a count shows it with the number', () => {
    const pane = createSettingsPane(stubDeps());
    const row = archivedRowOf(pane);
    expect(row.classList.contains('cyc-off')).toBe(true);

    // Non-vacuity: the pane registered a live store subscription.
    expect(fake.subs.length).toBeGreaterThan(0);
    fake.archived = 3;
    notify();
    expect(row.classList.contains('cyc-off')).toBe(false);
    expect(row.querySelector('.cyc-list-row-right')!.textContent).toBe('3');

    // The archive empties: the row tucks itself away again.
    fake.archived = 0;
    notify();
    expect(row.classList.contains('cyc-off')).toBe(true);
  });

  test('refreshArchivedRow (the settings-open repaint) reflects a count change with no notify', () => {
    fake.archived = 1;
    const pane = createSettingsPane(stubDeps());
    const row = archivedRowOf(pane);
    expect(row.querySelector('.cyc-list-row-right')!.textContent).toBe('1');
    // A tab switch changes the scope without a store notify; opening
    // settings re-counts through this hook (main.ts openSettings).
    fake.archived = 4;
    pane.refreshArchivedRow();
    expect(row.querySelector('.cyc-list-row-right')!.textContent).toBe('4');
  });

  test('tapping it opens the archive lens and closes settings', () => {
    fake.archived = 1;
    const deps = stubDeps();
    const pane = createSettingsPane(deps);
    document.body.append(pane.el);
    expect(sessionState.archiveOpen).toBe(false);
    archivedRowOf(pane).click();
    expect(sessionState.archiveOpen).toBe(true);
    expect(deps.setSettingsOpen).toHaveBeenCalledWith(false);
    // The render pass repaints the list into archive mode:
    // listSurfaceVersion folds archiveOpen, proven in cycRenderHub.
    expect(deps.render).toHaveBeenCalled();
  });
});
