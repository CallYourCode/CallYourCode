import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycSession} from '../types';

vi.mock('../engine/store', () => ({
  list: (): unknown[] => [],
  get: (): undefined => undefined,
  canOlder: () => false,
  loadOlder: vi.fn(async () => {}),
  setSessionPhoto: vi.fn(async () => ({ok: true})),
  tabs: (): unknown[] => [],
  engineKeyOfTab: () => '',
  mergedListOrder: (): unknown[] => [],
  tabOfSession: () => '',
  toolbarPluginIds: () => new Set()
}));
vi.mock('../engine/fsFail', () => ({failed: () => false}));
vi.mock('../components/widgets', () => ({toast: vi.fn()}));

const profileFake = {
  el: document.createElement('div'),
  destroy: vi.fn(),
  setPhotoBusy: vi.fn(),
  setCronCount: vi.fn(),
  retryMedia: vi.fn()
};
vi.mock('../features/profile/profile', () => ({createProfile: () => profileFake}));

import {createProfilePane, type ProfilePaneDeps} from '../features/profile/pane';
import {sessionState} from '../sessionState';

const pointerDown = (el: Element) =>
  el.dispatchEvent(new Event('pointerdown', {bubbles: true, cancelable: true}));

let mounted: HTMLElement[] = [];
let disposers: Array<() => void> = [];

beforeEach(() => {
  sessionState.activeId = null;
  vi.clearAllMocks();
});
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
  mounted.forEach((el) => el.remove());
  mounted = [];
});

function mk() {
  const mainColumns = document.createElement('div');
  mainColumns.dataset.view = 'profile';
  const elsewhere = document.createElement('div');
  const mast = document.createElement('div');
  mast.className = 'cyc-mast';
  const toggle = document.createElement('button');
  mast.append(toggle);
  mainColumns.append(elsewhere, mast);
  document.body.append(mainColumns);
  mounted.push(mainColumns);

  const setView = vi.fn();
  const deps: ProfilePaneDeps = {
    onTeardown: (d: () => void) => disposers.push(d),
    setView,
    openProfileAttachments: vi.fn(),
    header: {actionButton: () => null},
    placeholderSession: {
      id: '',
      name: 'CallYourCode',
      cwd: '',
      unread: 0,
      muted: false,
      thinking: false,
      messages: []
    } as CycSession,
    cronCountOf: () => 0,
    onCronCount: () => () => {},
    mainColumns
  };
  const {rightPane} = createProfilePane(deps);
  const insidePane = document.createElement('div');
  rightPane.append(insidePane);
  mainColumns.append(rightPane);
  return {mainColumns, rightPane, insidePane, elsewhere, toggle, setView};
}

describe('profile pane outside close', () => {
  test('a pointerdown in the columns but outside the pane closes the profile', () => {
    const {elsewhere, setView} = mk();
    pointerDown(elsewhere);
    expect(setView).toHaveBeenCalledTimes(1);
    expect(setView).toHaveBeenCalledWith('chat');
  });

  test('a pointerdown inside the pane keeps it open', () => {
    const {insidePane, setView} = mk();
    pointerDown(insidePane);
    expect(setView).not.toHaveBeenCalled();
  });

  test('the chat header keeps working as the toggle: a pointerdown there does not close', () => {
    const {toggle, setView} = mk();
    pointerDown(toggle);
    expect(setView).not.toHaveBeenCalled();
  });

  test('overlays mounted outside the columns (menus, popups, viewers) do not close it', () => {
    const {setView} = mk();
    const overlay = document.createElement('div');
    document.body.append(overlay);
    mounted.push(overlay);
    pointerDown(overlay);
    expect(setView).not.toHaveBeenCalled();
  });

  test('with the profile closed the listener does nothing', () => {
    const {mainColumns, elsewhere, setView} = mk();
    mainColumns.dataset.view = 'chat';
    pointerDown(elsewhere);
    expect(setView).not.toHaveBeenCalled();
  });

  test('teardown removes the listener', () => {
    const {elsewhere, setView} = mk();
    disposers.forEach((d) => d());
    disposers = [];
    pointerDown(elsewhere);
    expect(setView).not.toHaveBeenCalled();
  });
});
