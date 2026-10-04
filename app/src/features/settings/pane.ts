import * as engine from '@/engine/store';
import {h} from '@/components/domHelpers';
import {makeIcon} from '@/components/iconGlyphs';
import {
  currentPresentationTheme,
  registerThemePainter,
  type PresentationTheme
} from '@/components/presentation';
import {paneHeader} from '@/features/sessions/components/paneHeader';
import {scrollSurface} from '@/shared/dom';
import {
  toggle,
  type Toggle,
  eyeState,
  settingsCard,
  row,
  toast,
  confirmPopup
} from '@/components/widgets';
import {openMenu} from '@/components/popupMenu';
import {createHintsCard} from '@/components/hintsCard';
import RowSortable from '@/features/sessions/controls/rowSort';
import {applyCycTheme, currentCycTheme, type CycThemeName} from '@/features/settings/preferences';
import {
  KEYMAP,
  binding as keyBinding,
  chordLabel,
  chordOf,
  hasHardwareKeys,
  hasModifier,
  isBareModifier,
  isDefault as keyIsDefault,
  resetKeymap,
  setBinding,
  setBindings,
  type KeymapAction
} from '@/features/settings/preferences';
import {
  setToolbarActionShown,
  setToolbarActionOrder,
  toolbarActionShown,
  engineToolbarActions,
  type CycToolbarAction,
  type CycToolbarActionId
} from '@/features/settings/preferences';
import {
  sortByLatest,
  setSortByLatest,
  mergeTabs,
  setMergeTabs,
  rowChipShown,
  setRowChipShown
} from '@/features/settings/preferences';
import {
  pushState,
  pushRealState,
  installedForPush,
  enablePush,
  disablePush
} from '@/engine/pushNotify';
import {enginePin, clearEnginePinAndReload} from '@/engine/contract';
import {isClerkAuth} from '@/engine/appFetch';
import {clerkSignOut, isSignedIn} from '@/engine/clerkSession';
import {createEnginesSection} from '@/features/pairing/enginesSettings';
import {fileReport, waitingReports, startReportOutbox} from '@/features/diagnostics/reporting';
import {clearCachedData} from '@/features/settings/preferences';
import {cyclog} from '@/shared/logging';
import {sessionState, dataState} from '@/sessionState';
import {bundleInfo} from '@/bundleReload';
import {active, activeEngineKey, visibleTabs} from '@/sessionSelectors';

interface SettingsPaneDeps {
  onTeardown(d: () => void): void;

  setSettingsOpen(open: boolean): void;

  // The dead-session archive size on the active tab scope: what the archive
  // lens would list right now. Feeds the "Archived (n)" row only.
  archivedCount(): number;

  paintPluginCards(): void;

  render(): void;

  refreshToolbarActions(): void;
}

function srow(opts: Parameters<typeof row>[0]): HTMLElement {
  const r = row(opts);
  // Settings-only type scale: one notch below the shared row() title so long
  // labels with a right-side toggle ("Push notifications", "Show harness chip")
  // stop ellipsizing in the narrow settings pane. Title 0.9375rem -> 0.875rem,
  // description kept proportionally smaller 0.8125rem -> 0.75rem. Important
  // beats the same-specificity text-[length:...] utility row() set. Chat and
  // session-list rows use row() directly and are untouched. (2026-09-07)
  r.querySelectorAll('.cyc-list-row-title').forEach((t) => {
    t.classList.add('text-[length:0.875rem]!');
  });
  r.querySelectorAll('.cyc-list-row-subtitle').forEach((sub) => {
    sub.classList.add(
      'whitespace-normal!',
      'overflow-visible',
      'text-clip',
      '[overflow-wrap:anywhere]',
      'min-w-0',
      'text-[length:0.75rem]!'
    );
  });
  if (
    r.classList.contains('cyc-list-row-has-icon') &&
    !r.classList.contains('cyc-list-row-title-only')
  ) {
    r.classList.add('justify-start', 'pt-[0.4375rem]!', 'pb-[0.4375rem]!');
    const ic = r.querySelector('.cyc-list-row-icon');
    ic?.classList.remove('[transform:translateY(-50%)]');
    ic?.classList.add('top-[0.4375rem]', '[transform:none]');
  }
  return r;
}

export function createSettingsPane(deps: SettingsPaneDeps) {
  // Off-screen until `.cyc-settings-open`; then it slides in.
  const settingsPane = h(
    'div',
    'cyc-left-settings absolute inset-0 z-[3] flex flex-col overflow-hidden bg-[var(--cyc-surface)] ' +
      '[transform:translate3d(-105%,0,0)] pointer-events-none [transition:transform_0.3s_cubic-bezier(0.32,0.72,0,1)] ' +
      '[.cyc-settings-open_&]:transform-[translate3d(0,0,0)]! [.cyc-settings-open_&]:pointer-events-auto!'
  );

  const settingsHeader = paneHeader('Settings', () => deps.setSettingsOpen(false)).el;

  const nightToggle = toggle({
    checked: currentCycTheme() === 'night',
    onChange: (checked) => setTheme(checked ? 'night' : 'day')
  });

  function setTheme(name: CycThemeName) {
    applyCycTheme(name);
    nightToggle.set(name === 'night');

    deps.paintPluginCards();
  }

  const saveFailed = () => toast('Not saved: nothing was changed');

  const overlayToggle = toggle({
    checked: engine.overlayEnabled(),
    onChange: (checked) => {
      void engine.setOverlayEnabled(checked);
      deps.render();
    }
  });

  const sortToggles: Toggle[] = [];
  const mergeToggles: Toggle[] = [];
  const makeSortToggle = () => {
    const t = toggle({
      checked: sortByLatest(),
      onChange: (checked) => {
        setSortByLatest(checked);
        sortToggles.forEach((s) => s.set(checked));
        deps.render();
      }
    });
    sortToggles.push(t);
    return t.el;
  };
  const makeMergeToggle = () => {
    const t = toggle({
      checked: mergeTabs(),
      onChange: (checked) => {
        setMergeTabs(checked);
        mergeToggles.forEach((m) => m.set(checked));

        deps.render();
      }
    });
    mergeToggles.push(t);
    return t.el;
  };

  const soundToggle = toggle({
    checked: engine.globalSettings().sound,
    onChange: (checked) => {
      sessionState.autoSpeak = checked;
      void engine.setGlobalSettings({sound: checked}).then((ok) => {
        if (!ok) {
          saveFailed();
          return;
        }
        toast(checked ? 'Autoplay on by default' : 'Autoplay off by default');
      });
      deps.render();
    }
  });

  sessionState.autoSpeak = engine.globalSettings().sound;

  const geomToggle = toggle({
    checked: engine.globalSettings().geom,
    onChange: (checked) => {
      void engine.setGlobalSettings({geom: checked}).then((ok) => {
        if (!ok) {
          saveFailed();
          return;
        }
        toast(checked ? 'Geometry readout on' : 'Geometry readout off');
      });
      deps.render();
    }
  });

  const reportRow = srow({
    icon: 'bug',
    title: 'Report a bug',

    subtitle: ' ',
    clickable: () => openBugReport()
  });
  const paintReportRow = () => {
    const waiting = waitingReports();
    const sub = reportRow.querySelector('.cyc-list-row-subtitle');
    if (!sub) return;
    sub.textContent = waiting
      ? `${waiting} report${waiting === 1 ? '' : 's'} still on this device, not sent`
      : "what just happened, with this device's log";
    reportRow.classList.toggle('cyc-report-waiting', waiting > 0);
  };
  paintReportRow();

  const reportContext = () => {
    const s = active();
    return {
      session: s ? {id: s.id, title: s.title?.text ?? s.name} : null,
      engine: {
        state: dataState.mode === 'live' ? engine.syncStatus() : dataState.mode,
        key: activeEngineKey()
      },
      build: bundleInfo.stamp
    };
  };

  async function sendBugReport(text: string) {
    if (!text.trim()) {
      toast('Nothing sent: say what went wrong');
      return;
    }
    const r = await fileReport(text, reportContext());
    paintReportRow();

    toast(
      r.state === 'sent'
        ? `Report sent: ${r.id}`
        : 'Not sent. Kept on this device and it will go when the app server is back.'
    );
  }

  function openBugReport() {
    confirmPopup({
      title: 'Report a bug',
      description:
        'What just went wrong? This goes to the app server with the last few ' +
        'hundred log lines from this device, the build it is running, the open chat and ' +
        'the time.',
      className: 'cyc-bug-popup',
      input: {placeholder: 'What you saw, in your own words', rows: 4, maxLength: 2000},
      buttons: [{text: 'Send', callback: (text) => void sendBugReport(text)}, {text: 'Cancel'}]
    });
  }

  function openClearCache() {
    confirmPopup({
      title: 'Clear cached data',
      description:
        "Drops this device's cached chats and voice clips and reloads. Your login, " +
        'hosts, theme, shortcuts, toolbar order and playback settings are kept, and nothing ' +
        'on the engines is touched.',
      buttons: [
        {
          text: 'Clear',
          danger: true,
          callback: () => void clearCachedData().then(() => location.reload())
        },
        {text: 'Cancel'}
      ]
    });
  }

  startReportOutbox(paintReportRow);

  const GLOBAL_SPEEDS = [1, 1.25, 1.5, 1.75, 2, 3];
  const speedRow = srow({
    icon: 'equalizer',
    title: 'Speed',
    subtitle: `${engine.globalSettings().speed}x`,
    clickable: (e) => {
      openMenu(
        GLOBAL_SPEEDS.map((r) => ({
          icon: (r === engine.globalSettings().speed ? 'check' : 'equalizer') as
            'check' | 'equalizer',
          text: `${r}x`,
          onClick: () => {
            void engine.setGlobalSettings({speed: r}).then((ok) => {
              if (!ok) {
                saveFailed();
                return;
              }
              toast(`Speed ${r}x`);
            });
            speedRow.querySelector('.cyc-list-row-subtitle')!.textContent = `${r}x`;
            deps.render();
          }
        })),
        e as MouseEvent
      );
    }
  });

  let paintKeymapFromGlobals: () => void = () => {};

  engine.onGlobalSettings(() => {
    const g = engine.globalSettings();
    soundToggle.set(g.sound);
    sessionState.autoSpeak = g.sound;
    geomToggle.set(g.geom);
    const sub = speedRow.querySelector('.cyc-list-row-subtitle');
    if (sub) sub.textContent = `${g.speed}x`;

    paintKeymapFromGlobals();
    deps.render();
  });

  const pushToggle = toggle({
    checked: pushState() === 'on',
    onChange: (checked) => void setPushEnabled(checked)
  });
  type PushPaneState = 'on' | 'off' | 'blocked' | 'unsupported';
  function pushCaption(state: PushPaneState): string {
    if (state === 'unsupported') return 'This browser cannot do push.';
    if (state === 'blocked') return 'Blocked: allow notifications for this site.';

    if (!installedForPush())
      return 'On iPhone and iPad, add this to your home screen first: Safari only pushes to installed apps.';

    return 'when a reply lands in a chat you are not watching';
  }

  const paintPushRow = (state: PushPaneState) => {
    const cap = pushRow.querySelector<HTMLElement>('.cyc-list-row-subtitle');
    if (cap) cap.textContent = pushCaption(state);
    pushToggle.set(state === 'on');
    // Blocked or unsupported: a tap cannot work, so do not invite one.
    pushToggle.setDisabled(state === 'blocked' || state === 'unsupported');
  };

  // On open the toggle shows what is actually true (permission plus a live
  // subscription), never a stored flag.
  let pushBusy = false;
  async function refreshPushRow() {
    if (pushBusy) return;
    const state = await pushRealState();
    if (pushBusy) return;
    paintPushRow(state);
  }
  void refreshPushRow();

  async function setPushEnabled(on: boolean) {
    if (pushBusy) return;
    if (on && !installedForPush()) {
      pushToggle.set(false);
      toast('On iPhone and iPad, add this to your home screen first');
      return;
    }
    pushBusy = true;
    pushToggle.setPending(true);
    try {
      if (!on) {
        const r = await disablePush();
        pushToggle.setPending(false);
        // 'failed' leaves the live subscription in place, so the row paints
        // back on; both off results really are off.
        paintPushRow(await pushRealState());
        toast(
          r === 'off'
            ? 'Push off for this device'
            : r === 'off-server-failed'
              ? 'Push off here, but the server could not be told'
              : 'Could not turn push off'
        );
        return;
      }
      const r = await enablePush();
      pushToggle.setPending(false);
      // On lands only on full success; failures paint off (blocked and
      // unsupported keep their own caption and a dead toggle).
      const real = await pushRealState();
      paintPushRow(r === 'on' || real === 'blocked' || real === 'unsupported' ? real : 'off');
      toast(
        r === 'on'
          ? 'Push on for this device'
          : r === 'denied'
            ? 'Notifications are blocked in browser settings'
            : r === 'unsupported'
              ? 'This browser cannot do push'
              : r === 'subscribe-failed'
                ? 'Push subscribe failed in this browser'
                : 'Push server did not accept the registration'
      );
    } finally {
      pushToggle.setPending(false);
      pushBusy = false;
    }
  }

  const pushRow = srow({
    icon: 'unmute',
    title: 'Push notifications',
    subtitle: pushCaption(pushState()),
    rightContent: pushToggle.el
  });

  const pinnedHost = enginePin();
  const clearPinBtn = h(
    'button',
    'cyc-ctl-primary cyc-ctl-flat primary cyc-pin-clear absolute top-1/2 end-4 -translate-y-1/2 z-[1] w-auto min-h-9 px-3.5 text-sm font-medium border-0 rounded-[0.625rem] text-(--cyc-accent) bg-transparent cursor-pointer flex-none flex items-center text-center overflow-hidden relative! w-full! h-12! px-4! font-normal! leading-[var(--cyc-line-height)]! [transition:opacity_0.25s_cubic-bezier(0.32,0.72,0,1),background-color_0.25s_cubic-bezier(0.32,0.72,0,1),color_0.25s_cubic-bezier(0.32,0.72,0,1)] fine:hover:bg-(--cyc-accent-tint)! fine:active:bg-(--cyc-accent-tint)! hover:bg-(--cyc-text-muted-tint)!'
  );
  clearPinBtn.textContent = 'Clear';
  clearPinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearEnginePinAndReload();
  });

  let pinRow: HTMLElement | null = null;
  if (pinnedHost) {
    pinRow = srow({icon: 'lock', title: 'Pinned to one host', subtitle: pinnedHost});
    pinRow.classList.add('cyc-list-row-with-preview', 'cyc-pin-row');
    pinRow
      .querySelectorAll(':scope > .cyc-list-row-title, :scope > .cyc-list-row-subtitle')
      .forEach((n) => n.classList.add('pe-12'));
    pinRow.append(clearPinBtn);
  }

  let recording: KeymapAction | null = null;
  let stopRecording: (() => void) | null = null;
  const keymapRows = new Map<KeymapAction, HTMLElement>();

  const KEYMAP_RECORDING_COLOR: Record<PresentationTheme, string> = {
    day: 'text-[#96602f]!',
    night: 'text-[#c98652]!'
  };
  const KEYMAP_STATE_CLASSES = [
    'opacity-[0.5]',
    '[font-family:inherit]!',
    'text-[#96602f]!',
    'text-[#c98652]!'
  ];
  const keymapRight = (el: HTMLElement) => el.querySelector<HTMLElement>('.cyc-list-row-right')!;
  const paintKeymapRow = (action: KeymapAction) => {
    const el = keymapRows.get(action);
    if (!el) return;
    const right = keymapRight(el);
    right.classList.remove(...KEYMAP_STATE_CLASSES);
    if (recording === action) {
      right.textContent = 'Press a key';
      el.classList.add('cyc-keymap-recording');
      right.classList.add(
        '[font-family:inherit]!',
        KEYMAP_RECORDING_COLOR[currentPresentationTheme()]
      );
    } else {
      const chord = keyBinding(action);
      right.textContent = chordLabel(chord);
      el.classList.remove('cyc-keymap-recording');
      const unbound = !chord;
      el.classList.toggle('cyc-keymap-unbound', unbound);
      if (unbound) right.classList.add('opacity-[0.5]');
    }
    el.dataset.cycChord = keyBinding(action);
  };

  let paintKeymapReset: () => void = () => {};

  let paintKeymapCaption: () => void = () => {};
  const paintKeymap = () => {
    KEYMAP.forEach((k) => paintKeymapRow(k.action));
    paintKeymapReset();
    paintKeymapCaption();
  };

  const keymapWrite = (write: Promise<boolean>, done: string) => {
    void write.then((ok) =>
      toast(
        ok ? done : 'Not saved: this browser will not let the app store settings (private mode?)'
      )
    );
  };

  const endRecording = () => {
    const was = recording;
    recording = null;
    stopRecording?.();
    stopRecording = null;
    if (was) paintKeymapRow(was);
  };

  const beginRecording = (action: KeymapAction) => {
    if (recording === action) {
      endRecording();
      return;
    }
    endRecording();
    recording = action;
    paintKeymapRow(action);

    const onKey = (e: KeyboardEvent) => {
      if (isBareModifier(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        endRecording();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        keymapWrite(setBinding(action, ''), 'Unbound');
        endRecording();
        paintKeymap();
        return;
      }
      const chord = chordOf(e);
      if (!chord) return;
      if (!hasModifier(chord)) {
        toast('Hold Ctrl, Alt, Shift or Cmd as well: a plain key would swallow typing');
        return;
      }

      const clash = KEYMAP.find((k) => k.action !== action && keyBinding(k.action) === chord);
      keymapWrite(
        setBindings(clash ? {[clash.action]: '', [action]: chord} : {[action]: chord}),
        clash
          ? `${chordLabel(chord)} set, and taken off ${clash.title.toLowerCase()}`
          : `${chordLabel(chord)} set`
      );
      endRecording();
      paintKeymap();
    };
    window.addEventListener('keydown', onKey, {capture: true});

    const onPoke = (e: Event) => {
      if (keymapRows.get(action)?.contains(e.target as Node)) return;
      endRecording();
    };
    window.addEventListener('pointerdown', onPoke, {capture: true});
    stopRecording = () => {
      window.removeEventListener('keydown', onKey, {capture: true});
      window.removeEventListener('pointerdown', onPoke, {capture: true});
    };
  };
  deps.onTeardown(() => endRecording());

  for (const entry of KEYMAP) {
    const el = srow({
      icon: 'keyboard',
      title: entry.title,
      subtitle: entry.subtitle,
      rightContent: '',
      clickable: () => beginRecording(entry.action)
    });
    el.classList.add('cyc-keymap-row');
    el.querySelector('.cyc-list-row-right-muted')?.classList.add(
      'font-[ui-monospace,SFMono-Regular,Menlo,Consolas,monospace]',
      'text-[0.9375rem]',
      'whitespace-nowrap'
    );
    el.dataset.cycAction = entry.action;
    keymapRows.set(entry.action, el);
  }

  const keymapResetRow = srow({
    icon: 'replace',
    title: 'Reset shortcuts',
    subtitle: 'back to the defaults',
    clickable: () => {
      endRecording();
      keymapWrite(resetKeymap(), 'Shortcuts reset');
      paintKeymap();
    }
  });
  keymapResetRow.classList.add('cyc-keymap-reset');
  paintKeymapReset = () => {
    keymapResetRow.classList.toggle(
      'cyc-off',
      KEYMAP.every((k) => keyIsDefault(k.action))
    );
  };

  const keymapCaption = hasHardwareKeys()
    ? 'Tap a row, press the keys. Escape backs out, Backspace unbinds. This device only.'
    : 'These need a keyboard, and stay on the device you set them on. On a phone, return sends, so a second line wants one.';
  const keymapSection = settingsCard(
    {heading: 'Keyboard', footer: keymapCaption},
    ...KEYMAP.map((k) => keymapRows.get(k.action)!),
    keymapResetRow
  );

  paintKeymapCaption = () => {};
  paintKeymapFromGlobals = paintKeymap;
  paintKeymap();
  // The recording tint is a per-theme literal, so repaint the keymap when the
  // theme changes (the pane persists across theme toggles).
  registerThemePainter(settingsPane, () => paintKeymap());

  let rebuildToolbarSettings: () => void = () => {};
  const toolbarVisibility = h('div', 'cyc-toolbar-visibility');
  const connectedToolbarEngines = (): {engineKey: string | null; label: string}[] => {
    const tabList = visibleTabs();
    const engines: {engineKey: string | null; label: string}[] = [];
    const seen = new Set<string>();
    for (const t of tabList) {
      if (seen.has(t.engineKey)) continue;
      seen.add(t.engineKey);
      engines.push({engineKey: t.engineKey, label: t.label});
    }
    if (!engines.length) engines.push({engineKey: null, label: ''});
    return engines;
  };
  const buildToolbarRow = (
    engineKey: string | null,
    a: CycToolbarAction,
    getSortable: () => RowSortable
  ): HTMLElement => {
    let shown = toolbarActionShown(engineKey, a.id);
    const eye = eyeState(shown);
    const r = srow({
      icon: a.icon,
      title: a.label,
      rightContent: eye.el,
      clickable: () => {
        shown = !shown;

        // Global bit: one write applies to every agent on every engine.
        setToolbarActionShown(a.id, shown);
        deps.refreshToolbarActions();
        eye.set(shown);
        // With several hosts listed, the same action has a row per host
        // section; rebuild so their eyes track the shared bit.
        if (toolbarVisibility.childElementCount > 1) rebuildToolbarSettings();
      }
    });
    r.dataset.cycAction = a.id;
    r.classList.add('min-h-[2.375rem]');
    // paintRowChrome stamps an important ps-[3.5rem]!/ps-[4rem]! inset on every
    // cyc-list-row-inset row; a plain ps-[5.25rem] utility loses that cascade
    // fight (measured: label pad stayed 56px), so the icon (start-12 = 48px,
    // ~68px wide at text-xl) painted onto the label's first letters. An inline
    // important beats the stylesheet important deterministically. (2026-09-07)
    r.style.setProperty('padding-inline-start', '5.25rem', 'important');
    r.querySelector('.cyc-list-row-icon')?.classList.add('start-12', 'text-xl');

    const handle = h(
      'span',
      'cyc-drag-handle absolute start-0 top-1/2 -translate-y-1/2 box-border flex h-11 w-11 items-center justify-start ps-2 cursor-grab active:cursor-grabbing touch-none text-[var(--cyc-text-muted)] opacity-50'
    );
    handle.append(
      h(
        'span',
        'w-[7px] h-3 [background-image:radial-gradient(currentColor_1px,transparent_1.4px)] [background-size:3.5px_4px] bg-repeat'
      )
    );
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      getSortable().pickUp(r, (e as PointerEvent).clientY, (e as PointerEvent).pointerId);
    });
    handle.addEventListener('click', (e) => e.stopPropagation());
    r.prepend(handle);
    return r;
  };
  const buildActionList = (
    engineKey: string | null,
    actions: readonly CycToolbarAction[],
    onSort: (ids: CycToolbarActionId[]) => void
  ): HTMLElement => {
    const list = h('div', 'cyc-toolbar-engine-list');
    const sortable = new RowSortable({
      list,
      dragClasses: 'relative! z-3! bg-(--cyc-text-muted-tint)!',
      onSort: () => {
        const ids = ([...list.children] as HTMLElement[])
          .map((el) => el.dataset.cycAction)
          .filter((x): x is CycToolbarActionId => !!x);
        onSort(ids);
      }
    });
    for (const a of actions) list.append(buildToolbarRow(engineKey, a, () => sortable));
    return list;
  };
  rebuildToolbarSettings = () => {
    const engines = connectedToolbarEngines();
    const withHostName = engines.length > 1;
    const sections: HTMLElement[] = [];
    for (const e of engines) {
      const plugins = e.engineKey ? engine.toolbarPluginIds(e.engineKey) : new Set<string>();
      const actions = engineToolbarActions(e.engineKey, plugins);
      const scope = h('div', 'cyc-toolbar-scope');
      scope.dataset.cycToolbarScope = 'host';
      if (withHostName && e.label) {
        const heading = h(
          'div',
          'cyc-toolbar-scope-heading px-4 pt-3 pb-1 text-[0.9375rem] font-semibold'
        );
        heading.textContent = e.label;
        scope.append(heading);
      }
      scope.append(
        buildActionList(e.engineKey, actions, (ids) => {
          setToolbarActionOrder(e.engineKey, ids);
          deps.refreshToolbarActions();
        })
      );
      sections.push(scope);
    }
    toolbarVisibility.replaceChildren(...sections);
  };
  rebuildToolbarSettings();

  const themeRow = srow({
    icon: 'darkMode',
    title: 'Theme',
    subtitle: 'dark or light on this device',
    rightContent: nightToggle.el
  });

  const sortRow = srow({
    icon: 'sortByDate',
    title: 'Sort by latest',
    subtitle: 'newest activity on top',
    rightContent: makeSortToggle()
  });

  const mergeRow = srow({
    icon: 'group',
    title: 'Merge host tabs',
    subtitle: 'one list, each row named by its host',
    rightContent: makeMergeToggle()
  });

  // One global bit per chip (rowChipShown), like the toolbar bits: flipping
  // it applies to every agent on every engine. deps.render() repaints the
  // list; listRowVersion folds the bit so the rows actually re-key.
  const harnessChipToggle = toggle({
    checked: rowChipShown('harness'),
    onChange: (checked) => {
      setRowChipShown('harness', checked);
      deps.render();
    }
  });
  const modelChipToggle = toggle({
    checked: rowChipShown('model'),
    onChange: (checked) => {
      setRowChipShown('model', checked);
      deps.render();
    }
  });

  const harnessChipRow = srow({
    icon: 'tools',
    title: 'Show harness chip',
    subtitle: 'the agent kind on each conversation row',
    rightContent: harnessChipToggle.el
  });
  harnessChipRow.dataset.cycChipRow = 'harness';

  const modelChipRow = srow({
    icon: 'robot',
    title: 'Show model chip',
    subtitle: 'the model name on each conversation row',
    rightContent: modelChipToggle.el
  });
  modelChipRow.dataset.cycChipRow = 'model';

  const autoplayRow = srow({
    icon: 'speaker',
    title: 'Autoplay',
    subtitle: 'unless a chat is muted',
    rightContent: soundToggle.el
  });
  const toolbarSection = settingsCard(
    {
      heading: 'Toolbar',
      footer:
        "Hide or drag to reorder a chat's top-bar buttons. A hidden one still works from the chat's profile."
    },
    toolbarVisibility
  );

  const geomRow = srow({
    icon: 'info',
    title: 'Geometry readout',
    subtitle: 'on every device, until you turn it off',
    rightContent: geomToggle.el
  });

  const clearCacheRow = srow({
    icon: 'delete',
    title: 'Clear cached data',
    subtitle: 'keeps login, theme, shortcuts and settings',
    clickable: () => openClearCache()
  });

  /* The dead-session archive's ENTRY POINT: the conversation list carries no
   * archive affordance any more, this one row does, at the bottom of Settings
   * directly ABOVE "Clear cached data". Hidden while nothing is archived (an
   * empty archive has no affordance, same rule the old list entry kept).
   * Tapping it opens the archive lens; the lens's "Chats" back row returns
   * to the live list. */
  const archivedRow = srow({
    icon: 'folder',
    title: 'Archived',
    subtitle: 'ended sessions, kept readable',
    rightContent: '',
    clickable: () => {
      sessionState.archiveOpen = true;
      cyclog('nav.tap', {control: 'archive', open: true});
      deps.setSettingsOpen(false);
      deps.render();
    }
  });
  archivedRow.dataset.cycRow = 'archived';
  // Count reflection stays OFF the hot list render key: the row repaints from
  // a light store subscription (a DOM write only when the count actually
  // changes) and on every settings open, never through listSurfaceVersion.
  let archivedShown = -1;
  const refreshArchivedRow = () => {
    const n = deps.archivedCount();
    if (n === archivedShown) return;
    archivedShown = n;
    archivedRow.classList.toggle('cyc-off', n === 0);
    const right = archivedRow.querySelector('.cyc-list-row-right');
    if (right) right.textContent = String(n);
  };
  refreshArchivedRow();
  deps.onTeardown(engine.subscribe(refreshArchivedRow));

  const tipsCard = createHintsCard({dismissible: false, headless: true});
  tipsCard.classList.add('my-0!', 'pt-1!', 'px-4!', 'pb-2!', 'bg-transparent!');
  const tipsSection = settingsCard({heading: 'Things worth knowing'}, tipsCard);

  // The transform legs a subpage slides through, chosen here (was
  // `.cyc-settings-subpage` / `.cyc-subpage-open`): resting one screen past the
  // end, sliding to zero when open. `cyc-subpage-open` stays as a state marker.
  const SUBPAGE_OPEN_PAINT = ['[transform:translate3d(0,0,0)]!', 'pointer-events-auto!'];
  let openSubPage: HTMLElement | null = null;
  const closeSubPage = () => {
    if (!openSubPage) return;
    openSubPage.classList.remove('cyc-subpage-open', ...SUBPAGE_OPEN_PAINT);
    openSubPage = null;
  };
  deps.onTeardown(() => closeSubPage());

  const subPageEls: HTMLElement[] = [];

  const drillRow = (
    key: string,
    ico: Icon,
    title: string,
    subtitle: string,
    body: HTMLElement
  ): HTMLElement => {
    const pane = h(
      'div',
      'cyc-settings-subpage absolute inset-0 z-[4] flex flex-col bg-[var(--cyc-surface)] ' +
        '[transform:translate3d(105%,0,0)] pointer-events-none [transition:transform_0.3s_cubic-bezier(0.4,0,0.2,1)]'
    );
    const scroll = scrollSurface();
    scroll.classList.add('relative!', 'flex-auto');
    scroll.append(body);
    pane.append(paneHeader(title, () => closeSubPage()).el, scroll);
    subPageEls.push(pane);
    const navRow = srow({
      icon: ico,
      title,
      subtitle,
      clickable: () => {
        openSubPage = pane;
        pane.classList.add('cyc-subpage-open', ...SUBPAGE_OPEN_PAINT);
      }
    });
    navRow.classList.add('cyc-settings-nav-row');
    navRow
      .querySelectorAll(':scope > .cyc-list-row-title, :scope > .cyc-list-row-subtitle')
      .forEach((n) => n.classList.add('pe-10'));
    navRow.append(
      makeIcon(
        'next',
        'cyc-settings-nav-chevron pointer-events-none absolute top-1/2 end-4 -translate-y-1/2 text-2xl text-[var(--cyc-text-muted)]'
      )
    );
    navRow.dataset.cycPage = key;
    return navRow;
  };

  const thisDeviceSection = settingsCard(
    {heading: 'Settings'},
    pushRow,
    themeRow,
    sortRow,
    mergeRow,
    harnessChipRow,
    modelChipRow,

    srow({
      icon: 'sessions',
      title: 'Session activity',
      subtitle: 'pills, and marks on rows and tabs',
      rightContent: overlayToggle.el
    }),
    drillRow('toolbar', 'settings', 'Toolbar', 'Top-bar buttons and order', toolbarSection),
    drillRow('keyboard', 'keyboard', 'Keyboard', 'Shortcuts', keymapSection),
    autoplayRow,
    speedRow,
    ...(pinRow ? [pinRow] : [])
  );

  const helpSection = settingsCard(
    {
      heading: 'Help',
      footer:
        "The readout is a box of layout numbers to photograph when something sits wrong; a report sends your words with this device's log."
    },
    geomRow,
    reportRow,
    archivedRow,
    clearCacheRow
  );

  const enginesSection = createEnginesSection({onTeardown: deps.onTeardown});

  // Log out sits at the very bottom, and ONLY on the hosted app with Clerk auth
  // active and a real session. In LOCAL mode (auth 'none') it never appears; the
  // card starts hidden and reveals itself once a live token is confirmed.
  const logoutRow = srow({
    icon: 'user',
    title: 'Log out',
    subtitle: 'sign out of this device',
    clickable: () => void clerkSignOut()
  });
  logoutRow.dataset.cycRow = 'logout';
  const logoutSection = settingsCard({heading: 'Account'}, logoutRow);
  logoutSection.classList.add('cyc-off');
  if (isClerkAuth()) {
    void isSignedIn().then((signedIn) => {
      if (signedIn) logoutSection.classList.remove('cyc-off');
    });
  }

  const settingsScroll = scrollSurface();
  settingsScroll.classList.add('relative!', 'flex-auto');
  settingsScroll.append(thisDeviceSection, enginesSection, helpSection, tipsSection, logoutSection);
  settingsPane.append(settingsHeader, settingsScroll, ...subPageEls);

  return {
    el: settingsPane,

    rebuildToolbarSettings: () => rebuildToolbarSettings(),

    paintKeymapFromGlobals: () => paintKeymapFromGlobals(),

    closeSubPage,

    refreshPushRow,

    refreshArchivedRow,

    hasOpenSubPage: () => !!openSubPage,

    setOverlayToggleChecked: (checked: boolean) => overlayToggle.set(checked)
  };
}
