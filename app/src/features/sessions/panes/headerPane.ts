import type {CycSession} from '../../../types';
import * as engine from '../../../engine/store';
import type {CycEngineSession} from '../../../engine/store';
import {sessionState, dataState} from '../../../sessionState';
import {speaker} from '../../../audio/speaker';
import {pipeline} from '../../../audio/pipeline';
import {ensureMic} from '../../../speechGate';
import {cyclog} from '@/shared/logging';
import {lazy} from '@/shared/lazy';
import {relTicker} from '@/shared/relTicker';
import {toast, confirmPluginAction} from '../../../components/widgets';
import {createHeader} from '../header/header';
import {createAgentsBar} from '../components/agentsBar';
import {createJumpBar} from '@/features/chat/navigation/jumpBar';
import {openPluginPanelById} from '../../../components/pluginPanel';
import {toolbarActionById, type CycToolbarActionId} from '@/features/settings/preferences';
import {active, allSessions, toolbarEngineOf, selectTabFor} from '../../../sessionSelectors';

export interface HeaderPaneDeps {
  onTeardown(d: () => void): void;

  saveDraft(): void;
  loadDraft(id: string | null): void;

  restorePending: Set<'host' | 'chat' | 'list' | 'profile' | 'doc'>;
  releaseMicIfIdle(): void;
  setView(view: 'list' | 'chat' | 'profile'): void;
  render(): void;
  capUploading(): number;
  notifyOn(sessionId: string): boolean;
  goToMessage(
    sessionId: string,
    ref: {ts: number; role: 'user' | 'claude'; seq?: number}
  ): Promise<boolean>;
  openChat(id: string): void;

  setOverlayToggleChecked(checked: boolean): void;
  mainColumns: HTMLElement;
  chatEl: HTMLElement;
}

export function createHeaderPane(deps: HeaderPaneDeps) {
  const placeholderSession =
    allSessions()[0] ??
    ({
      id: '',
      name: 'CallYourCode',
      cwd: '',
      unread: 0,
      muted: false,
      thinking: false,
      messages: []
    } as CycSession);

  function leaveChat() {
    cyclog('chat.closed', {
      session: sessionState.activeId,
      liveCapture: pipeline.liveCaptureId || undefined,
      capturesInFlight: pipeline.capturesInFlight.length || undefined,
      uploading: deps.capUploading() || undefined,
      why:
        'the chat was left; anything still in flight for it loses its messageNode ' +
        'when this view is torn down'
    });

    cyclog('nav.tap', {
      control: 'back',
      kind: 'leave-chat',
      session: sessionState.activeId ?? undefined,
      keepsSelection: false,
      rendered: 'list'
    });
    deps.saveDraft();
    deps.loadDraft(null);

    if (sessionState.activeTabId) sessionState.tabSelection.delete(sessionState.activeTabId);
    sessionState.activeId = null;

    deps.restorePending.delete('chat');
    deps.restorePending.delete('list');
    localStorage.removeItem('cyc-engaged');
    if (dataState.mode === 'live') engine.detachChat();
    if (pipeline.handsFreeSessionId) pipeline.disableHandsFree();
    deps.releaseMicIfIdle();
    deps.setView('list');
    deps.render();
  }

  const backToList = () => {
    cyclog('nav.tap', {
      control: 'back',
      kind: 'back-to-list',
      session: sessionState.activeId ?? undefined,
      keepsSelection: true,
      rendered: 'list'
    });
    deps.setView('list');
  };

  const inDrawerRegime = () => window.innerWidth > 550 && window.innerWidth <= 899;
  const drawerOpen = () => deps.mainColumns.dataset.view === 'list';

  const TTS_SPEEDS = [1, 1.25, 1.5, 1.75, 2, 3];
  const speedLabelOf = (r: number) => `${r}x`;

  const firePluginToolbarAction = (id: CycToolbarActionId) => {
    const s = active();
    if (!s) return;
    const headerConfig = toolbarEngineOf(s.id);
    const action = toolbarActionById(headerConfig.engineKey, id, headerConfig.plugins);
    if (!action?.plugin) return;
    if (dataState.mode !== 'live' || !headerConfig.engineKey) {
      toast('That action needs a live session');
      return;
    }
    const pluginId = action.plugin;

    if (!action.run) {
      const open = () => {
        const opened = openPluginPanelById(pluginId, s.id, (ref) =>
          deps
            .goToMessage(s.id, ref)
            .then((ok) => ({ok, message: ok ? '' : 'That message is not loaded here yet'}))
        );
        if (!opened) toast('This engine does not offer that panel');
      };

      if (pluginId === 'git') {
        void engine.pluginRpc(headerConfig.engineKey!, 'git', 'pane', s.id, null).then(
          (r) => {
            const res =
              r.ok && r.result && typeof r.result === 'object'
                ? (r.result as {repo?: unknown})
                : null;
            if (res && res.repo === false) {
              toast('Not a git repository');
              return;
            }
            open();
          },
          () => open()
        );
        return;
      }
      open();
      return;
    }

    const runOp = action.run;
    const go = () => {
      void engine.pluginRpc(headerConfig.engineKey!, pluginId, runOp, s.id, null).then((r) => {
        if (!r.ok) toast(r.message || 'Action failed');
      });
    };
    if (action.confirm) {
      confirmPluginAction({
        title: action.label,
        confirm: action.confirm,
        className: 'cyc-confirm-plugin',
        onConfirm: go
      });
      return;
    }
    go();
  };

  const header = createHeader({
    session: placeholderSession,

    engineReachable: (s) =>
      dataState.mode !== 'live' || engine.engineReachable((s as CycEngineSession).engineKey),

    toolbarEngine: (sessionId) => toolbarEngineOf(sessionId),
    onPluginAction: (id) => firePluginToolbarAction(id),
    onCycleSpeed: () => {
      const cur = engine.effectiveSpeed();
      const next = TTS_SPEEDS[(TTS_SPEEDS.indexOf(cur) + 1) % TTS_SPEEDS.length];
      speaker.setRate(next);
      header.setSpeed(speedLabelOf(next));

      void engine.setGlobalSettings({speed: next}).then((ok) => {
        if (ok) {
          toast(`Speed ${speedLabelOf(next)}`);
          return;
        }
        const now = engine.effectiveSpeed();
        speaker.setRate(now);
        if (now === cur) toast('Could not reach the server: the speed is unchanged');
      });
    },

    onBack: () => backToList(),
    onToggleConversation: () => {
      const s = active();
      if (!s) return;
      const turnOn = !sessionState.chatConversationMode.has(s.id);
      if (turnOn) {
        sessionState.chatConversationMode.add(s.id);
        if (dataState.mode === 'live') {
          void ensureMic()
            .then(() => {
              if (sessionState.activeId === s.id && sessionState.chatConversationMode.has(s.id)) {
                pipeline.enableHandsFree(s.id);

                toast('Hands-free on for this chat');
              }
            })
            .catch(() => {
              sessionState.chatConversationMode.delete(s.id);
              toast('Microphone unavailable');
              deps.render();
            });
        } else {
          toast('Hands-free on for this chat');
        }
      } else {
        sessionState.chatConversationMode.delete(s.id);
        if (pipeline.handsFreeSessionId === s.id) pipeline.disableHandsFree();
        deps.releaseMicIfIdle();

        toast('Hands-free off for this chat');
      }
      deps.render();
    },

    onToggleMute: () => {
      const s = active();
      if (!s) return;
      const nextMuted = !s.muted;

      const mutedOn = 'Muted: this chat does not play out loud';
      const mutedOff = 'This chat plays replies out loud';
      const muteFail = 'Could not reach the engine: mute for this chat is unchanged';
      if (dataState.mode === 'live') {
        void engine.setSessionSettings(s.id, {muted: nextMuted}).then((ok) => {
          if (ok) toast(nextMuted ? mutedOn : mutedOff);
          else {
            toast(muteFail);
            deps.render();
          }
        });
      } else {
        s.muted = nextMuted;
        const es = s as CycEngineSession;
        es.settings = {...(es.settings ?? {}), muted: nextMuted};
        toast(nextMuted ? mutedOn : mutedOff);
      }
      if (nextMuted && speaker.state.sessionId === s.id) speaker.stopAll();
      deps.render();
    },

    notifyOn: (id) => deps.notifyOn(id),
    onToggleNotify: () => {
      const s = active();
      if (!s) return;
      const next = !deps.notifyOn(s.id);
      if (dataState.mode === 'live') {
        void engine.setSessionSettings(s.id, {notify: next}).then((ok) => {
          if (!ok) {
            toast('Could not reach the engine: the bell for this chat is unchanged');
            deps.render();
          }
        });
      } else {
        const es = s as CycEngineSession;
        es.settings = {...(es.settings ?? {}), notify: next};
      }
      deps.render();
      toast(next ? 'Notifications on for this chat' : 'Notifications off for this chat');
    },
    onOpenProfile: () => {
      if (inDrawerRegime() && drawerOpen() && sessionState.activeId) {
        deps.setView('chat');
        return;
      }
      deps.setView(deps.mainColumns.dataset.view === 'profile' ? 'chat' : 'profile');
    },

    onInterrupt: () => {
      const s = active();
      if (!s) return;

      if (!s.thinking && s.status !== 'blocked') {
        toast('Nothing running to interrupt');
        return;
      }
      if (dataState.mode === 'live') {
        engine.interrupt(s.id);
        toast('Interrupted this chat');
      } else {
        s.thinking = false;
        deps.render();
      }
    },

    onCompact: () => {
      const s = active();
      if (!s) return;
      if (dataState.mode !== 'live') {
        toast('Compacting needs a live session');
        return;
      }
      engine.compact(s.id);
    },

    overlay: () => {
      const s = active() as CycEngineSession | null;
      const live = !!s && dataState.mode === 'live';
      return {
        on: live && engine.overlayEnabled(),
        available: live && !!s!.claudeSessionId
      };
    },
    onToggleOverlay: () => {
      const s = active() as CycEngineSession | null;
      if (!s || dataState.mode !== 'live') return;

      const next = !engine.overlayEnabled();

      void engine.setOverlayEnabled(next);
      toast(next ? 'Session activity on' : 'Session activity off');
      deps.setOverlayToggleChecked(next);
      deps.render();
    },

    onOpenTerminal: () => {
      const s = active();
      if (!s) return;
      if (dataState.mode !== 'live') {
        toast('The terminal needs a live session');
        return;
      }
      void lazy(() => import('../../../components/terminalViewer'), 'the terminal').then(
        ({openTerminalViewer}) => openTerminalViewer(s.id, s.name)
      );
    }
  });
  const convToggleBtn = header.el.querySelector<HTMLElement>('.cyc-conv-toggle')!;

  speaker.setRateResolver(() => engine.effectiveSpeed());
  header.setSpeed(speedLabelOf(engine.effectiveSpeed()));

  let cronBadgeKey = '';
  let cronBadgeCount = 0;
  const cronCountSinks = new Set<() => void>();

  const onCronCount = (fn: () => void): (() => void) => {
    cronCountSinks.add(fn);
    return () => {
      cronCountSinks.delete(fn);
    };
  };

  const cronCountOf = (id: string | null | undefined) =>
    id && id === cronBadgeKey ? cronBadgeCount : 0;
  const refreshCronBadge = (s: CycSession | null | undefined) => {
    if (!s || dataState.mode !== 'live') {
      cronBadgeKey = '';
      cronBadgeCount = 0;
      header.setCronCount(0);
      return;
    }
    const es = s as CycEngineSession;
    const key = es.id;
    if (key === cronBadgeKey) {
      header.setCronCount(cronBadgeCount);
      return;
    }
    cronBadgeKey = key;
    cronBadgeCount = 0;
    header.setCronCount(0);
    const plugin = engine.pluginsOf(es.engineKey).find((p) => p.id === 'crons' && p.panel?.badge);
    const op = plugin?.panel?.badge;
    if (!plugin || !op) return;
    void engine
      .pluginRpc(es.engineKey, plugin.id, op, es.id, null)
      .then((r) => {
        if (cronBadgeKey !== key) return;
        const res =
          r.ok && r.result && typeof r.result === 'object'
            ? (r.result as {count?: unknown}).count
            : null;

        if (typeof res !== 'number' || !Number.isFinite(res)) return;
        cronBadgeCount = res;
        header.setCronCount(res);
        for (const fn of cronCountSinks) fn();
      })
      .catch(() => {});
  };

  let modelBadgeKey = '';
  const refreshModelBadge = (s: CycSession | null | undefined) => {
    if (!s || dataState.mode !== 'live') {
      header.setModelBadge(null);
      modelBadgeKey = '';
      return;
    }
    const es = s as CycEngineSession;
    const key = `${es.id}\0${es.model ?? ''}`;
    if (key === modelBadgeKey) return;
    modelBadgeKey = key;

    header.setModelBadge(es.model ?? null);
    const plugin = engine
      .pluginsOf(es.engineKey)
      .find((p) => p.id === 'model-indicator' && p.panel?.badge);
    const op = plugin?.panel?.badge;
    if (!plugin || !op) return;
    void engine
      .pluginRpc(es.engineKey, plugin.id, op, es.id, null)
      .then((r) => {
        if (modelBadgeKey !== key) return;
        const res =
          r.ok && r.result && typeof r.result === 'object'
            ? (r.result as {model?: unknown}).model
            : null;

        if (typeof res === 'string' && res) header.setModelBadge(res);
      })
      .catch(() => {});
  };

  const agentsBar = createAgentsBar({
    onStopPi: (agentId) => {
      const s = active() as CycEngineSession | null;
      if (dataState.mode !== 'live' || !s) return;
      void engine.stopAgent(s.id, agentId).then((r) => {
        if (!r.ok)
          toast(
            r.error === 'not running'
              ? 'That agent is no longer running'
              : 'Could not stop the agent'
          );
      });
    }
  });
  // Producer-owned reservation: the strip floats over the message list, so the
  // list must pad its top by the strip's height (3.25rem == the wrapper's
  // `h-11`/44px + the root `p-1`/8px) plus a small 0.375rem breathing gap so the
  // first row (a date chip / activity pill) does not sit flush against the strip.
  // `chatRootPaint` seeds this var inline on `chatEl`, so a stylesheet rule cannot
  // beat it -- the value is set here on every path that can show or hide the strip.
  function syncAgentsDock() {
    const on = !agentsBar.el.classList.contains('cyc-off');
    deps.chatEl.style.setProperty('--cyc-overlay-stack-height', on ? '3.625rem' : '0px');
  }
  function updateAgentsBar() {
    const s = active() as CycEngineSession | null;
    if (dataState.mode !== 'live' || !s) {
      agentsBar.reset();
    } else {
      agentsBar.update(s.agentRuns ?? []);
    }
    const visible = !agentsBar.el.classList.contains('cyc-off');
    deps.chatEl.classList.toggle('cyc-has-agents-bar', visible);
    syncAgentsDock();
  }

  // Elapsed "Ns"/"Nm" labels move on the one shared ticker: 1 s only while a run
  // is under a minute, 60 s after that, and paused while the tab is hidden. The
  // bar paints only when the label it would show actually changes.
  const runningRuns = (): number[] => {
    const s = active() as CycEngineSession | null;
    if (dataState.mode !== 'live' || !s) return [];
    const now = Date.now();
    return (s.agentRuns ?? []).filter((r) => r.endedTs === null).map((r) => now - r.ts);
  };
  deps.onTeardown(
    relTicker().register({
      needsSeconds: () => runningRuns().some((age) => age < 60_000),
      value: () => {
        const ages = runningRuns();
        if (!ages.length) return 'idle';
        const now = Date.now();
        const secs = ages.some((age) => age < 60_000);
        return ages.length + ':' + (secs ? Math.floor(now / 1000) : Math.floor(now / 60_000));
      },
      paint: updateAgentsBar
    })
  );

  if (new URLSearchParams(location.search).get('testhooks')) {
    (
      window as never as {__cycAgentsBar: {el: HTMLElement; update: (runs: unknown[]) => void}}
    ).__cycAgentsBar = {
      el: agentsBar.el,
      update: (runs) => {
        agentsBar.update(runs as never);
        syncAgentsDock();
      }
    };
  }

  const jumpBar = createJumpBar((id) => {
    if (!engine.get(id)) return;
    cyclog('nav.jump', {trigger: 'button', from: sessionState.activeId, to: id});
    selectTabFor(id);
    deps.openChat(id);
  });

  const waitingChats = () =>
    dataState.mode !== 'live'
      ? []
      : engine
          .list()
          .filter((s) => s.unread > 0)
          .map((s) => ({id: s.id, name: s.name}));

  const jumpTarget = (dir: 1 | -1): string | null => {
    const list = waitingChats();
    if (!list.length) return null;
    const at = list.findIndex((t) => t.id === sessionState.activeId);
    if (at < 0) return (dir > 0 ? list[0] : list[list.length - 1]).id;
    const to = list[(at + dir + list.length) % list.length];
    return to.id === sessionState.activeId ? null : to.id;
  };
  const jumpTo = (
    dir: 1 | -1,
    trigger: 'wheel' | 'touch' | 'button',
    wheel?: {sinceLastMs: number; peakAbs: number}
  ) => {
    const id = jumpTarget(dir);
    if (!id) return;
    if (!engine.get(id)) return;
    cyclog('nav.jump', {
      trigger,
      from: sessionState.activeId,
      to: id,
      ...(trigger === 'wheel'
        ? {
            sinceLastMs: wheel?.sinceLastMs ?? 0,
            peakAbs: wheel?.peakAbs ?? 0
          }
        : {})
    });
    selectTabFor(id);
    deps.openChat(id);
  };

  function updateJumpBar() {
    if (dataState.mode !== 'live') jumpBar.update([], null);
    else jumpBar.update(waitingChats(), sessionState.activeId);

    agentsBar.slot.classList.toggle('cyc-off', jumpBar.el.classList.contains('cyc-off'));
    agentsBar.refresh();

    deps.chatEl.classList.toggle('cyc-has-jump-bar', !agentsBar.el.classList.contains('cyc-off'));
    syncAgentsDock();
  }
  return {
    header,
    placeholderSession,
    convToggleBtn,
    leaveChat,
    backToList,
    cronCountOf,
    refreshCronBadge,
    onCronCount,
    refreshModelBadge,
    agentsBar,
    updateAgentsBar,
    jumpBar,
    jumpTarget,
    jumpTo,
    updateJumpBar,
    inDrawerRegime,
    drawerOpen,
    speedLabelOf
  };
}
