import * as engine from './engine/store';
import type {CycEngineSession} from './engine/store';
import {sessionState, dataState, bootUrlNav, bootUrlIsOurs} from './sessionState';
import {speaker} from './audio/speaker';
import {pipeline} from './audio/pipeline';
import {ensureMic, mayStartSpeech} from './speechGate';
import {clientId} from './engine/contract';
import {cyclog} from '@/shared/logging';
import {looksOpaque, opaqueKey} from '@/features/sessions/navigation';
import {onNotificationOpen} from './engine/pushNotify';
import {isAction, actionFor} from '@/features/settings/preferences';
import {
  migrateToolbarKeys,
  setDeclaredToolbarDefaults,
  setDeclaredPluginActions,
  TOOLBAR_ACTIONS,
  pluginToolbarAction,
  type CycToolbarAction,
  type CycToolbarActionId
} from '@/features/settings/preferences';
import {installSpeakerEvents} from './speakerEvents';
import {installVoiceCapture} from './features/composer/voice/capture';
import {transcriptOf} from '@/features/chat/surface/audioPlayback';
import {active, selectTabFor} from './sessionSelectors';
import type {createChatSurface} from '@/features/chat/surface/chatSurface';
import type {createListPane} from './features/sessions/panes/listPane';
import type {createHeaderPane} from './features/sessions/panes/headerPane';
import type {createAudioPlayback} from '@/features/chat/surface/audioPlayback';
import type {createComposerWiring} from './features/composer/wiring';

const TOOLBAR_ACTION_IDS = new Set<string>(TOOLBAR_ACTIONS.map((a) => a.id));

type ComposerWiring = ReturnType<typeof createComposerWiring>;

export interface StoreBindingsDeps {
  onTeardown(d: () => void): void;
  cs: ReturnType<typeof createChatSurface>;
  list: ReturnType<typeof createListPane>;
  tp: ReturnType<typeof createHeaderPane>;
  audio: ReturnType<typeof createAudioPlayback>;
  hub: {render(fromStore?: boolean): void};
  settingsUI: {hasOpenSubPage(): boolean; closeSubPage(): void};
  composer: ComposerWiring['composer'];
  cap: ComposerWiring['cap'];
  putBlocksBack: ComposerWiring['putBlocksBack'];
  restoreVoiceBlock: ComposerWiring['restoreVoiceBlock'];
  clipCid: ComposerWiring['clipCid'];
  vaultKeyOf: ComposerWiring['vaultKeyOf'];
  releaseMicIfIdle(): void;
  markHeard: (sessionId: string, msgId: string) => void;
  reportViewedThrough(id: string): void;
  setSuppressAutoSpeak(v: boolean): void;
  restored(key: 'host' | 'chat' | 'list' | 'profile' | 'doc'): void;
  settleBoot(): void;
  requestOpen(source: 'restore' | 'notification' | 'newSession' | 'usageLink', id: string): boolean;
  isUserNavigated(): boolean;
  /** This boot is a launch on a phone: start on the chats list, restore nothing. */
  bootToList?(): boolean;
  rebuildToolbarSettings(): void;
  profileRefreshToolbar(): void;
  settingsOpen(): boolean;
  setView(view: 'list' | 'chat' | 'profile'): void;
  mainColumns: HTMLElement;
}

export function installStoreBindings(deps: StoreBindingsDeps) {
  const {cs, list, tp, audio, hub, settingsUI} = deps;

  const showUsageFor = (host: string): boolean => {
    const tabId = engine.tabForHost(host);
    if (!tabId) return false;
    list.switchTab(tabId, {stayOnList: true, src: 'usage'});
    deps.setView('list');

    list.flashCards();
    return true;
  };

  const openFromNotification = (key: string) => {
    if (key.startsWith('usage:')) {
      showUsageFor(key.split(':')[1] ?? '');
      return true;
    }
    const id = engine.get(key) ? key : engine.sessionFromNotifyKey(key);
    const s = id ? engine.get(id) : undefined;
    if (!s || !id) return false;
    selectTabFor(id);
    cs.openChat(id);
    return true;
  };

  deps.onTeardown(
    onNotificationOpen((key) => {
      openFromNotification(key);
    })
  );

  {
    const wanted = bootUrlNav.chat;
    if (wanted?.startsWith('usage:')) {
      let tries = 0;
      const tryUsage = () => {
        if (deps.isUserNavigated()) return;
        if (showUsageFor(wanted.split(':')[1] ?? '')) return;
        if (++tries < 40) setTimeout(tryUsage, 250);
      };
      tryUsage();
    } else if (wanted && !bootUrlIsOurs) {
      let tries = 0;
      const tryOpen = () => {
        if (deps.isUserNavigated()) return;
        const id = engine.get(wanted) ? wanted : engine.sessionFromNotifyKey(wanted);
        if (id && engine.get(id)) {
          selectTabFor(id);

          cyclog('nav.deeplink', {
            why:
              'a URL this app did not write named a conversation, so it is a ' +
              'notification tap: the chat opens and the reply is spoken'
          });

          cs.armDeepLinkSpeak(id);
          deps.requestOpen('notification', id);
          return;
        }
        if (++tries < 40) setTimeout(tryOpen, 250);
      };
      tryOpen();
    }
  }

  deps.onTeardown(
    engine.onReplayed((sessionId) => {
      if (dataState.mode !== 'live' || sessionState.activeId !== sessionId) return;
      cs.settleNow(sessionId);
    })
  );

  deps.onTeardown(
    engine.onIdChange((oldId, newId) => {
      if (sessionState.activeId === oldId) {
        sessionState.activeId = newId;
        if (localStorage.getItem('cyc-engaged') === oldId)
          localStorage.setItem('cyc-engaged', newId);
      }

      for (const [tabId, selId] of sessionState.tabSelection) {
        if (selId === oldId) sessionState.tabSelection.set(tabId, newId);
      }
      if (sessionState.chatConversationMode.has(oldId)) {
        sessionState.chatConversationMode.delete(oldId);
        sessionState.chatConversationMode.add(newId);
      }
    })
  );

  const wouldAutoPlay = (sessionId: string, origin?: string): boolean => {
    if (origin && origin !== clientId()) return false;
    if (!mayStartSpeech(sessionId)) return false;
    const st = speaker.state;

    const continuing =
      st.sessionId === sessionId && (st.state === 'speaking' || st.state === 'paused');

    const openHere =
      sessionState.activeId === sessionId &&
      deps.mainColumns.dataset.view === 'chat' &&
      (sessionState.autoSpeak || sessionState.chatConversationMode.has(sessionId));
    return continuing || openHere;
  };

  const growingReplies = new Map<
    string,
    {
      sessionId: string;
      text: string;
      origin?: string;
      played?: boolean;

      durS?: number;
      chars?: number;
    }
  >();

  const liveSuppressed = new Set<string>();
  const suppressedSays = new Map<
    string,
    {sessionId: string; text: string; origin?: string; growing?: boolean}
  >();

  const handleSay = (
    sessionId: string,
    msgId: string,
    text: string,
    origin?: string,
    growing?: boolean
  ) => {
    if (growing) {
      const played = wouldAutoPlay(sessionId, origin);
      if (played) audio.play(sessionId, msgId, text);
      growingReplies.set(msgId, {sessionId, text, origin, played});
      audio.updateRowAudio();
      return;
    }

    if (wouldAutoPlay(sessionId, origin)) audio.play(sessionId, msgId, text);
    audio.updateRowAudio();
  };
  deps.onTeardown(
    engine.onSay((sessionId, msgId, text, origin, growing) => {
      if (dataState.mode !== 'live') return;

      if (liveSuppressed.has(msgId)) {
        suppressedSays.set(msgId, {sessionId, text, origin, growing});
        audio.updateRowAudio();
        return;
      }
      handleSay(sessionId, msgId, text, origin, growing);
    })
  );
  deps.onTeardown(
    engine.onSayLive((_sessionId, msgId) => {
      if (dataState.mode !== 'live') return;
      liveSuppressed.add(msgId);
    })
  );
  deps.onTeardown(
    engine.onSayLiveFail((_sessionId, msgId) => {
      if (dataState.mode !== 'live') return;
      liveSuppressed.delete(msgId);

      const held = suppressedSays.get(msgId);
      if (held) {
        suppressedSays.delete(msgId);
        handleSay(held.sessionId, msgId, held.text, held.origin, held.growing);
      }
    })
  );

  deps.onTeardown(
    engine.onSayGrow((sessionId, msgId, durS, chars) => {
      if (dataState.mode !== 'live') return;
      const g = growingReplies.get(msgId);
      if (g) {
        if (durS !== undefined && durS > 0) g.durS = durS;
        if (chars !== undefined && chars >= 0) g.chars = chars;
      }
      if (durS !== undefined && durS > 0) speaker.noteGrowth(msgId, durS);
    })
  );

  deps.onTeardown(
    engine.onSayDone((sessionId, msgId, durationS) => {
      if (dataState.mode !== 'live') return;
      const pending = growingReplies.get(msgId);

      growingReplies.delete(msgId);
      if (durationS !== undefined && durationS > 0) speaker.noteGrowth(msgId, durationS);

      if (
        pending &&
        !pending.played &&
        !speaker.pending().has(msgId) &&
        wouldAutoPlay(sessionId, pending.origin)
      ) {
        audio.play(sessionId, msgId, pending.text);
      }
      audio.updateRowAudio();
    })
  );

  let lastActiveMsgCount = -1;

  let lastHistory = 0;
  let lastActiveEvCount = -1;

  let lastActiveSessionId: string | null = null;

  let lastActiveScrollH = -1;

  // Pin state, tracked off the scroll event instead of read in the notify path:
  // reading scrollTop/scrollHeight while the store is applying a change forces a
  // synchronous layout on every push. The scroll listener runs after layout is
  // already settled, so this read is free, and the notify path never measures.
  let nearBottom = true;
  const updateNearBottom = () => {
    const el = cs.messageListScroll;
    const px = Math.max(cs.OVERLAY_SCROLL_NEAR_PX, el.clientHeight / 3);
    nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= px;
  };
  {
    const el = cs.messageListScroll;
    el.addEventListener('scroll', updateNearBottom, {passive: true});
    deps.onTeardown(() => el.removeEventListener('scroll', updateNearBottom));
  }

  let restoredActive = false;
  const bootAt = Date.now();

  const RESTORE_GRACE_MS = 8000;

  window.setTimeout(() => {
    if (restoredActive || !engine.list().length) return;
    if (tryRestoreActive() !== 'opened') hub.render();
  }, RESTORE_GRACE_MS + 200);

  function chatFromUrl(): string | null {
    if (!bootUrlIsOurs || !looksOpaque(bootUrlNav.chat)) return null;
    return engine.list().find((s) => opaqueKey(s.id) === bootUrlNav.chat)?.id ?? null;
  }

  function tryRestoreActive(): 'opened' | 'none' | 'wait' {
    if (sessionState.activeId || deps.isUserNavigated() || deps.bootToList?.()) {
      restoredActive = true;
      deps.restored('chat');
      deps.restored('list');
      return 'none';
    }

    const stored = bootUrlIsOurs ? chatFromUrl() : localStorage.getItem('cyc-engaged');

    const wants = bootUrlIsOurs
      ? looksOpaque(bootUrlNav.chat)
      : !!localStorage.getItem('cyc-engaged');
    const known = !!stored && !!engine.get(stored);
    if (!known && wants && Date.now() - bootAt < RESTORE_GRACE_MS) return 'wait';
    restoredActive = true;
    if (stored && engine.get(stored)) {
      deps.setSuppressAutoSpeak(true);
      setTimeout(() => {
        deps.setSuppressAutoSpeak(false);
      }, 2500);
      deps.requestOpen('restore', stored);

      if (bootUrlNav.list && sessionState.activeId) deps.setView('list');
      deps.settleBoot();
      deps.restored('chat');

      deps.restored('list');
      return 'opened';
    }

    if (wants) {
      cyclog('nav.chat.gone', {
        why:
          'the URL or the store named a conversation no engine answered for within ' +
          `${RESTORE_GRACE_MS}ms, so the list is what opens`
      });
    }
    deps.settleBoot();
    deps.restored('chat');
    deps.restored('list');
    return 'none';
  }

  let lastToolbarSig = '';
  const syncDeclaredToolbarDefaults = () => {
    const engineKeys = [...new Set(engine.tabs().map((t) => t.engineKey))];

    migrateToolbarKeys();
    const byEngine = new Map<string, Partial<Record<CycToolbarActionId, boolean>>>();
    const extrasByEngine = new Map<string, CycToolbarAction[]>();
    const setSig: string[] = [];
    for (const ek of engineKeys) {
      const m: Partial<Record<CycToolbarActionId, boolean>> = {};
      const extras: CycToolbarAction[] = [];
      for (const p of engine.pluginsOf(ek)) {
        const actionId = p.id;

        const extra = p.action ? pluginToolbarAction(p.id, p.action) : null;
        if (extra) extras.push(extra);
        if (!TOOLBAR_ACTION_IDS.has(actionId) && !extra) continue;
        const d = p.panel?.toolbarDefault ?? p.action?.toolbarDefault ?? p.tui?.toolbarDefault;
        if (typeof d === 'boolean') m[actionId] = d;
      }
      if (Object.keys(m).length) byEngine.set(ek, m);
      if (extras.length) extrasByEngine.set(ek, extras);
      setSig.push(
        ek +
          ':' +
          [...engine.toolbarPluginIds(ek)].sort().join(',') +
          ':' +
          extras
            .map((a) => a.id)
            .sort()
            .join(',')
      );
    }
    const sig = JSON.stringify([...byEngine].sort()) + '|' + setSig.sort().join(';');
    if (sig === lastToolbarSig) return;
    lastToolbarSig = sig;
    setDeclaredToolbarDefaults(byEngine);
    setDeclaredPluginActions(extrasByEngine);
    tp.header.refreshToolbarActions();
    deps.rebuildToolbarSettings();
    deps.profileRefreshToolbar();
  };

  deps.onTeardown(
    engine.subscribe(() => {
      syncDeclaredToolbarDefaults();

      if (!restoredActive && engine.list().length && tryRestoreActive() === 'opened') return;
      const s = active();
      const count = s ? s.messages.length : -1;

      const history = s ? ((s as CycEngineSession).historyAdded ?? 0) : 0;

      const overlayActive = !!s && engine.overlayOn(s.id);
      const evCount = overlayActive ? (s as CycEngineSession).events.length : -1;

      const owned = !!s && cs.openOwned();
      const grewCount =
        !!s && (count !== lastActiveMsgCount || (evCount !== -1 && evCount !== lastActiveEvCount));

      // Snapshot the store-derived inputs and the previous marks; the scroll
      // work reads and writes layout, so it is batched into one rAF where the
      // reads happen after the render has already laid out -- never interleaved
      // with a store write.
      const prevMsgCount = lastActiveMsgCount;
      const prevSessionId = lastActiveSessionId;
      const prevEvCount = lastActiveEvCount;
      const prevScrollH = lastActiveScrollH;
      const prevHistory = lastHistory;
      const wasNearBottom = nearBottom;
      const arrived = count - prevMsgCount - Math.max(0, history - prevHistory);
      const sameSession = !!s && s.id === prevSessionId;
      // graceOpen/openOwned are store state, not layout; read them now so the
      // unread bookkeeping matches the branch the rAF will take.
      const ownedLike = owned || cs.graceOpen();

      hub.render(true);

      // Bookkeeping the next notify needs is settled synchronously (it reads no
      // layout); only lastActiveScrollH waits for the rAF's post-render measure.
      lastActiveMsgCount = count;
      lastHistory = history;
      lastActiveEvCount = evCount;
      lastActiveSessionId = s ? s.id : null;

      requestAnimationFrame(() => {
        const scrollEl = cs.messageListScroll;

        if (owned || cs.graceOpen()) {
          if (
            !cs.landingOwed() &&
            (grewCount ||
              (s &&
                s.id === prevSessionId &&
                prevScrollH >= 0 &&
                scrollEl.scrollHeight > prevScrollH))
          ) {
            cs.holdGraceGrowth();
          }
          if (grewCount) cs.refreshSettleGrace();

          if (cs.landingOwed() && grewCount && !cs.readerTook()) {
            if (!(cs.firstUnread() !== undefined && cs.scrollToFirstUnread())) cs.scrollToBottom();
          }
        } else if (
          s &&
          s.id === prevSessionId &&
          count > 0 &&
          count !== prevMsgCount &&
          wasNearBottom
        ) {
          cs.scrollToBottom();
        } else if (s && prevEvCount !== -1 && evCount > prevEvCount && wasNearBottom) {
          cs.scrollToBottom();
        } else if (
          s &&
          s.id === prevSessionId &&
          wasNearBottom &&
          count === prevMsgCount &&
          prevScrollH >= 0 &&
          scrollEl.scrollHeight > prevScrollH
        ) {
          cs.scrollToBottom();
        }

        if (s && dataState.mode === 'live' && cs.landingOwed()) cs.settleNow(s.id);
        lastActiveScrollH = s ? scrollEl.scrollHeight : -1;
        updateNearBottom();
      });

      // The unread counter and the read report are store facts, not layout:
      // they stay synchronous so a burst of pushes accumulates them exactly.
      // New rows raise "new below" when the chat is owned, or when the reader
      // is not pinned to the bottom (a pinned reader is scrolled down instead,
      // in the rAF, and owes no badge).
      if (
        sameSession &&
        prevMsgCount >= 0 &&
        count > prevMsgCount &&
        arrived > 0 &&
        (ownedLike || !wasNearBottom)
      ) {
        cs.setNewBelow(cs.newBelowCount() + arrived);
      }

      if (
        s &&
        dataState.mode === 'live' &&
        !cs.openOwned() &&
        !cs.landingOwed() &&
        sameSession &&
        count > prevMsgCount &&
        document.visibilityState === 'visible'
      ) {
        if (arrived > 0) deps.reportViewedThrough(s.id);
      }
    })
  );

  installSpeakerEvents({
    onTeardown: deps.onTeardown,
    markHeard: deps.markHeard,
    messageListInner: cs.messageListInner,
    transcriptOf,
    updateRowAudio: audio.updateRowAudio,
    updateMessagePlays: audio.updateMessagePlays,
    updatePlayerBar: audio.updatePlayerBar,
    updateVoiceStrip: audio.updateVoiceStrip
  });

  installVoiceCapture({
    cap: deps.cap,
    onTeardown: deps.onTeardown,
    composer: deps.composer,
    releaseMicIfIdle: deps.releaseMicIfIdle,
    scrollToBottom: () => cs.scrollToBottom(),
    updateVoiceStrip: audio.updateVoiceStrip,
    putBlocksBack: deps.putBlocksBack,
    restoreVoiceBlock: deps.restoreVoiceBlock,
    clipCid: deps.clipCid,
    vaultKeyOf: deps.vaultKeyOf
  });

  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;

    if (deps.settingsOpen() && settingsUI.hasOpenSubPage()) {
      settingsUI.closeSubPage();
      return;
    }

    const view = deps.mainColumns.dataset.view;
    if (view === 'profile') {
      deps.setView('chat');
      return;
    }
    if (view !== 'chat' || !sessionState.activeId) return;
    tp.leaveChat();
  };
  document.addEventListener('keydown', onEscape);
  deps.onTeardown(() => document.removeEventListener('keydown', onEscape));

  const NAV_ACTIONS = ['listPrev', 'listNext', 'tabPrev', 'tabNext'] as const;
  const onNavKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;

    if (isAction(e, 'nextWaiting')) {
      e.preventDefault();
      tp.jumpTo(1, 'button');
      return;
    }
    const action = actionFor(e, NAV_ACTIONS);
    if (!action) return;

    e.preventDefault();

    const dir = action === 'listNext' || action === 'tabNext' ? 1 : -1;
    if (action === 'tabPrev' || action === 'tabNext') {
      const key = list.tabNeighbour(dir);
      if (key) list.switchTab(key, {src: 'chord'});
      return;
    }

    // Iterate EXACTLY the painted rows (membership projection + search
    // filter), never the raw tab set: raw tabSessions includes offline
    // sessions the list does not show, and nav must not reach those.
    const rows = list.visibleSessions();
    if (!rows.length) return;
    const at = rows.findIndex((x) => x.id === sessionState.activeId);

    const to = at < 0 ? (dir > 0 ? 0 : rows.length - 1) : at + dir;
    if (to < 0 || to >= rows.length) return;
    cs.openChat(rows[to].id);
  };
  document.addEventListener('keydown', onNavKey);
  deps.onTeardown(() => document.removeEventListener('keydown', onNavKey));

  const gestureInit = () => {
    void speaker.unlock();
  };
  document.addEventListener('pointerdown', gestureInit, {once: true, capture: true});
  deps.onTeardown(() => document.removeEventListener('pointerdown', gestureInit, true));

  const onVisibility = () => {
    if (document.hidden) {
      deps.releaseMicIfIdle();
      return;
    }
    const id = sessionState.activeId;
    if (
      id &&
      sessionState.chatConversationMode.has(id) &&
      !pipeline.initialized &&
      dataState.mode === 'live'
    ) {
      void ensureMic()
        .then(() => {
          if (sessionState.activeId === id && sessionState.chatConversationMode.has(id)) {
            pipeline.enableHandsFree(id);
          }
        })
        .catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  deps.onTeardown(() => document.removeEventListener('visibilitychange', onVisibility));

  return {
    growingOf: (msgId: string) => growingReplies.get(msgId),
    RESTORE_GRACE_MS,
    showUsageFor,
    openFromNotification,
    tryRestoreActive
  };
}
