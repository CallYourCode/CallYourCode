import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {setPresentationTheme} from '../components/presentation';

/* The push toggle never lies: a tap paints a pending half-state (tap-proof),
 * lands on only when the whole enable chain succeeded, returns off with a
 * step-naming toast otherwise, and on open reflects the real state (live
 * subscription plus permission), not the stored flag. The pane is real; the
 * push seam and toast are fakes. */

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

const push = vi.hoisted(() => ({
  state: 'off' as 'on' | 'off' | 'blocked' | 'unsupported',
  installed: true,
  real: vi.fn(async (): Promise<'on' | 'off' | 'blocked' | 'unsupported'> => 'off'),
  enable: vi.fn(
    async (): Promise<'on' | 'unsupported' | 'denied' | 'subscribe-failed' | 'register-failed'> =>
      'on'
  ),
  disable: vi.fn(async (): Promise<'off' | 'off-server-failed' | 'failed'> => 'off')
}));
vi.mock('../engine/pushNotify', () => ({
  pushState: () => push.state,
  pushRealState: push.real,
  installedForPush: () => push.installed,
  enablePush: push.enable,
  disablePush: push.disable
}));

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('../components/widgets', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../components/widgets')>();
  return {...orig, toast: toastSpy};
});

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

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return {promise, resolve};
};

const pushRowOf = (pane: HTMLElement) =>
  [...pane.querySelectorAll<HTMLElement>('.cyc-list-row')].find(
    (r) => r.querySelector('.cyc-list-row-title')?.textContent === 'Push notifications'
  )!;

const partsOf = (row: HTMLElement) => ({
  row,
  label: row.querySelector<HTMLElement>('.cyc-tick-toggle')!,
  input: row.querySelector<HTMLInputElement>('input')!,
  track: row.querySelector<HTMLElement>('.cyc-toggle-track')!,
  knob: row.querySelector<HTMLElement>('.cyc-toggle-knob')!,
  caption: () => row.querySelector<HTMLElement>('.cyc-list-row-subtitle')!.textContent
});

const buildPane = async () => {
  const pane = createSettingsPane(stubDeps());
  document.body.append(pane.el);
  await flush();
  return {pane, ...partsOf(pushRowOf(pane.el))};
};

beforeEach(() => {
  document.documentElement.dir = '';
  document.body.innerHTML = '';
  setPresentationTheme('day');
  toastSpy.mockClear();
  push.state = 'off';
  push.installed = true;
  push.real.mockReset().mockResolvedValue('off');
  push.enable.mockReset().mockResolvedValue('on');
  push.disable.mockReset().mockResolvedValue('off');
  try {
    localStorage.removeItem('cyc-keymap');
  } catch {}
});

afterEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('a tap holds a pending half-state until the chain settles', () => {
  test('pending is painted as neither on nor off, and blocks a second tap', async () => {
    const gate = deferred<'on'>();
    push.enable.mockReturnValue(gate.promise);
    const t = await buildPane();

    t.row.click();
    expect(push.enable).toHaveBeenCalledTimes(1);
    expect(t.label.classList.contains('cyc-toggle-pending')).toBe(true);
    expect(t.input.disabled).toBe(true);
    // Not painted as on: no on-track colour, knob half-way, not at the end.
    expect(t.track.className).not.toContain('bg-[#96602f]');
    expect(t.knob.className).toContain('translate-x-2');
    expect(t.knob.className).not.toContain('translate-x-4');

    t.row.click();
    expect(push.enable).toHaveBeenCalledTimes(1);

    push.real.mockResolvedValue('on');
    gate.resolve('on');
    await flush();
    expect(t.input.checked).toBe(true);
    expect(t.label.classList.contains('cyc-toggle-pending')).toBe(false);
    expect(t.input.disabled).toBe(false);
    expect(t.track.className).toContain('bg-[#96602f]');
    expect(t.knob.className).toContain('translate-x-4');
    expect(toastSpy).toHaveBeenCalledWith('Push on for this device');
  });

  test('on lands only after the promise resolves, never at tap time', async () => {
    const gate = deferred<'on'>();
    push.enable.mockReturnValue(gate.promise);
    const t = await buildPane();
    t.row.click();
    await flush();
    expect(t.track.className).not.toContain('bg-[#96602f]');
    push.real.mockResolvedValue('on');
    gate.resolve('on');
    await flush();
    expect(t.track.className).toContain('bg-[#96602f]');
  });
});

describe('every failed enable step returns off and names itself', () => {
  test('permission denied: off, blocked caption, dead toggle', async () => {
    push.enable.mockResolvedValue('denied');
    const t = await buildPane();
    t.row.click();
    push.real.mockResolvedValue('blocked');
    await flush();
    expect(t.input.checked).toBe(false);
    expect(t.input.disabled).toBe(true);
    expect(t.caption()).toBe('Blocked: allow notifications for this site.');
    expect(toastSpy).toHaveBeenCalledWith('Notifications are blocked in browser settings');
  });

  test('browser subscribe failed: off with its own reason', async () => {
    push.enable.mockResolvedValue('subscribe-failed');
    const t = await buildPane();
    t.row.click();
    await flush();
    expect(t.input.checked).toBe(false);
    expect(t.input.disabled).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith('Push subscribe failed in this browser');
  });

  test('server registration failed: off with its own reason', async () => {
    push.enable.mockResolvedValue('register-failed');
    const t = await buildPane();
    t.row.click();
    await flush();
    expect(t.input.checked).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith('Push server did not accept the registration');
  });

  test('an uninstalled iOS web app never even starts the chain', async () => {
    push.installed = false;
    const t = await buildPane();
    t.row.click();
    await flush();
    expect(push.enable).not.toHaveBeenCalled();
    expect(t.input.checked).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith('On iPhone and iPad, add this to your home screen first');
  });
});

describe('the disable path is just as honest', () => {
  const startOn = async () => {
    push.state = 'on';
    push.real.mockResolvedValue('on');
    return buildPane();
  };

  test('a failed unsubscribe puts the toggle back on', async () => {
    const t = await startOn();
    expect(t.input.checked).toBe(true);
    push.disable.mockResolvedValue('failed');
    t.row.click();
    await flush();
    expect(push.disable).toHaveBeenCalledTimes(1);
    expect(t.input.checked).toBe(true);
    expect(toastSpy).toHaveBeenCalledWith('Could not turn push off');
  });

  test('a clean disable lands off, through a pending stretch', async () => {
    const t = await startOn();
    const gate = deferred<'off'>();
    push.disable.mockReturnValue(gate.promise);
    t.row.click();
    expect(t.label.classList.contains('cyc-toggle-pending')).toBe(true);
    expect(t.input.disabled).toBe(true);
    push.real.mockResolvedValue('off');
    gate.resolve('off');
    await flush();
    expect(t.input.checked).toBe(false);
    expect(t.label.classList.contains('cyc-toggle-pending')).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith('Push off for this device');
  });

  test('off with a deaf server still says so', async () => {
    const t = await startOn();
    push.disable.mockResolvedValue('off-server-failed');
    t.row.click();
    push.real.mockResolvedValue('off');
    await flush();
    expect(t.input.checked).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith('Push off here, but the server could not be told');
  });
});

describe('open reflects the real state, not the stored flag', () => {
  test('flag says off but a live subscription exists: paints on', async () => {
    push.state = 'off';
    push.real.mockResolvedValue('on');
    const t = await buildPane();
    expect(t.input.checked).toBe(true);
  });

  test('flag says on but the subscription is gone: paints off', async () => {
    push.state = 'on';
    push.real.mockResolvedValue('off');
    const t = await buildPane();
    expect(t.input.checked).toBe(false);
  });

  test('blocked permission renders the blocked state and a dead toggle', async () => {
    push.real.mockResolvedValue('blocked');
    const t = await buildPane();
    expect(t.input.checked).toBe(false);
    expect(t.input.disabled).toBe(true);
    expect(t.caption()).toBe('Blocked: allow notifications for this site.');
    t.row.click();
    await flush();
    expect(push.enable).not.toHaveBeenCalled();
  });

  test('refreshPushRow re-reads reality for the open hook', async () => {
    const t = await buildPane();
    expect(t.input.checked).toBe(false);
    push.real.mockResolvedValue('on');
    await t.pane.refreshPushRow();
    expect(t.input.checked).toBe(true);
  });
});
