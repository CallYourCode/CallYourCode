import './shell/tailwind.css';
import './shell/reset.css';
import './shell/chrome.css';
import './shell/utilities.css';
import './features/settings/settings.css';
import './features/sessions/sessions.css';
import './features/composer/composer.css';
import './features/chat/chat.css';
import './features/media/media.css';
import './features/plugins/plugins.css';
import './features/pairing/pairing';

import {touchCapable} from '@/shared/capabilities';

import {installShell} from './shell/viewport';
import {registerOfflineWorker} from './swBoot';
import {sessionState, bootUrlNav, dataState} from './sessionState';
import {installStaleTabReload} from './bundleReload';
import {installErrorReporter} from './errorReporter';
import {setLazyNotifier} from './shared/lazy';
import {installSpeechGate} from './speechGate';
import {installComposerTestHooks, installTestHooks} from './testHooks';
import {installIdleProbe} from './testing/idleProbe';
import {applyTestMode, isTestMode} from './testing/testMode';
import {createHeardProgress} from './heardProgress';
import {createAudioPlayback} from '@/features/chat/surface/audioPlayback';
import {installMessageMenu} from '@/features/chat/surface/messageMenu';
import {createChatSurface} from '@/features/chat/surface/chatSurface';
import {createMessageTravel} from '@/features/chat/surface/messageTravel';
import {createWaveformHydrator} from './features/composer/voice/waveformHydrate';
import {createMediaViewers} from './features/media/viewers';
import './replyModel';
import {createSettingsPane} from './features/settings/pane';
import {createListPane} from './features/sessions/panes/listPane';
import {createRenderHub} from './renderHub';
import {installStoreBindings} from './storeBindings';
import {installGeomOverlay} from './shell/geomOverlay';
import {installPresenceBeat} from './presenceBeat';
import {createComposerWiring} from './features/composer/wiring';
import {createHeaderPane} from './features/sessions/panes/headerPane';
import './speakerEvents';
import {createProfilePane} from './features/profile/pane';
import {createNavMachine} from './navMachine';
import './features/composer/voice/capture';
import {allSessions, active, projectArchive} from './sessionSelectors';

import './types';
import {h} from './components/domHelpers';
import {makeIcon, makeIconButton} from './components/iconGlyphs';
import {warmAvatarPhotoCache} from './components/avatarView';
import '@/features/chat/surface/messageList';
import '@/features/chat/content';
import './audio/audioCache';
import './audio/turnTones';
import './audio/clipVault';
import './features/composer/persistence/vault';
import * as showVault from './engine/showVault';
import {installLayout} from '@/features/sessions/layout';
import {currentCycTheme} from '@/features/settings/preferences';
import {paintChatWallpaper, paintAppBackgroundWidth} from '@/features/chat/wallpaper';
import {cyclog, logSizeBeacon} from '@/shared/logging';
import {requestPersistence} from '@/shared/browser';
import '@/features/diagnostics/reporting';
import {installComposerDropZone} from '@/features/composer/fileCollection';
import {installAndroidIntentLinks} from '@/shared/browser';
import './features/profile/profile';
import './components/popupMenu';
import './features/media/fileViewer';
import '@/features/media/downloads';
import './features/media/htmlViewer';
import {toast} from './components/widgets';
import * as engine from './engine/store';
import './engine/contract';
import {speaker} from './audio/speaker';
import {warmClipPlayback} from './audio/webAudioClip';
import './components/pluginCard';
import './components/pluginPanel';
import './engine/limitsAge';
import './engine/hostNames';
import './components/askPanel';
import './components/hintsCard';
import './features/media/imageViewer';
import {mountPairingScreen} from './features/pairing/screen';
import {trackComposerHeight, trackKeyboardInset} from '@/features/chat/scrolling';
import {repairPush} from './engine/pushNotify';

installIdleProbe();

const root = document.getElementById('cyc-app')!;

installShell(root);
registerOfflineWorker();
void warmAvatarPhotoCache();

if (isTestMode()) applyTestMode();
else engine.start();

installTestHooks();

void showVault.stats().then((s) => {
  if (!s.docs && !s.evicted) return;
  cyclog('shown.vault.boot', {
    docs: s.docs,
    bytes: s.bytes,

    evicted: s.evicted,
    lastEviction: s.lastEviction
      ? {
          name: s.lastEviction.name,
          cap: s.lastEviction.cap,

          kind: s.lastEviction.kind,
          at: new Date(s.lastEviction.ts).toISOString()
        }
      : null,
    why:
      'documents and pictures pushed with `show` that this device is holding; opening ' +
      'any of them again costs no network'
  });
});

setLazyNotifier((message) => toast(message, 4000));
installErrorReporter();
installStaleTabReload();

installSpeechGate();

type Disposer = () => void;
let disposers: Disposer[] = [];
const onTeardown = (d: Disposer) => disposers.push(d);

function route() {
  disposers.forEach((d) => d());
  disposers = [];
  root.textContent = '';
  buildApp();
}

route();

function buildApp() {
  const whole = h('div', 'cyc-stage relative flex mx-auto h-full min-h-full w-full');
  whole.id = 'cyc-stage';
  const mainColumns = h(
    'div',
    'group/cols relative h-full min-h-full max-h-full w-full overflow-hidden opacity-100 transition-opacity tab:flex'
  );
  mainColumns.id = 'cyc-columns';
  mainColumns.dataset.view = 'list';
  mainColumns.classList.add('view-list');
  whole.append(mainColumns);
  root.append(whole);

  if (!isTestMode()) mountPairingScreen(whole, () => {});

  sessionState.activeTabId ??=
    (isTestMode() ? dataState.testTabs[0]?.id : engine.tabs()[0]?.id) ?? null;

  let updateFab = () => {};

  const nav = createNavMachine({
    onTeardown,
    mainColumns,
    settingsEl: () => leftPane,
    markSeen: (id) => markSeen(id),
    updateFab: () => updateFab(),
    refreshProfileAttachments: () => refreshProfileAttachments(),
    retryProfileMedia: () => profile.retryMedia(),
    speakUnheard: (id) => speakUnheard(id),
    openChat: (id) => openChat(id)
  });
  const {
    restorePending,
    restored,
    cancelPendingOpens,
    requestOpen,
    syncNavUrl,
    setView,
    settleBoot,
    setSettingsOpen
  } = nav;
  if (isTestMode()) settleBoot();

  const leftPane = h(
    'div',
    [
      'cyc-stack-column relative cyc-pane cyc-pane-left cyc-column',
      '[transition:transform_0.2s_ease-in-out,translate_0.2s_ease-in-out,opacity_0.2s_ease-in-out]!',
      'flex h-full flex-col overflow-hidden z-[1] bg-[var(--cyc-surface)]',
      'w-[var(--cyc-rail-width)]',
      'max-tab:absolute max-tab:inset-0 max-tab:!flex max-tab:z-[1] max-tab:m-0 max-tab:w-full max-tab:max-w-full max-tab:rounded-none',
      'tab:m-0 tab:rounded-none tab:shadow-none',
      'tab:max-desk:absolute tab:max-desk:inset-y-0 tab:max-desk:start-0',
      'tab:max-desk:-translate-x-[calc(var(--cyc-rail-width)+var(--cyc-pane-gap))]',
      'group-[.view-list]/cols:tab:max-desk:translate-x-0',
      'desk:relative desk:flex-none desk:!w-[var(--cyc-rail-width)] desk:translate-x-0',
      'group-[.view-chat]/cols:max-tab:-translate-x-full group-[.view-chat]/cols:max-tab:opacity-0',
      'group-[.view-profile]/cols:max-tab:-translate-x-full group-[.view-profile]/cols:max-tab:opacity-0'
    ].join(' ')
  );
  leftPane.id = 'cyc-left-pane';

  const listPane = createListPane({
    onTeardown,
    render: () => render(),
    renderRows: () => renderRows(),
    openChat: (id, after, opts) => openChat(id, after, opts),
    saveDraft: () => saveDraft(),
    loadDraft: (id) => loadDraft(id),
    releaseMicIfIdle: () => releaseMicIfIdle(),
    rowAudioClick: (id) => rowAudioClick(id),
    openPlayingMessage: () => openPlayingMessage(),
    restored,
    cancelPendingOpens,
    restorePending,
    setView,
    wantedHost: nav.wantedHost,
    clearWantedHost: nav.clearWantedHost,
    forgetProgress: (id) => {
      engine.forgetSighting(id);
    },
    paintKeymapFromGlobals: () => settingsUI.paintKeymapFromGlobals(),
    mainColumns
  });
  const {
    leftMain,
    leftContent,
    burger,
    listFilter,
    sessionList,
    sessionListTop,
    floatingAction,
    hintsCardEl,
    playerBar,
    notifyOn,
    pluginComposerWidgets,
    updateBadge,
    renderTabs,
    switchTab,
    tabNeighbour,
    tabSessions,
    projectList,
    armSettleResort,
    paintPluginCards,
    paintLimits,
    refreshUsage,
    flashCards
  } = listPane;
  updateFab = listPane.updateFab;

  const settingsUI = createSettingsPane({
    onTeardown,
    setSettingsOpen,
    paintPluginCards,
    // The Settings "Archived (n)" row counts what the archive lens would
    // list: the active tab scope's dead sessions, the same projection the
    // lens paints through.
    archivedCount: () => projectArchive(listPane.tabSessions()).length,
    render: () => render(),
    refreshToolbarActions: () => header.refreshToolbarActions()
  });
  const settingsPane = settingsUI.el;
  const rebuildToolbarSettings = () => settingsUI.rebuildToolbarSettings();
  nav.setCloseSettingsSubPage(settingsUI.closeSubPage);
  // Opening settings re-reads the real push state (permission plus live
  // subscription) so the toggle never shows a stale stored flag, and
  // re-counts the Archived row (a tab switch changes the scope with no
  // store notify).
  const openSettings = () => {
    void settingsUI.refreshPushRow();
    settingsUI.refreshArchivedRow();
    setSettingsOpen(true);
  };
  burger.addEventListener('click', openSettings);

  if (bootUrlNav.settings) openSettings();

  leftPane.append(leftMain, settingsPane);

  const chatPane = h(
    'div',
    [
      'cyc-column absolute inset-[var(--cyc-pane-gap)]',
      '[transition:transform_0.2s_ease-in-out,translate_0.2s_ease-in-out,opacity_0.2s_ease-in-out]!',
      'max-tab:absolute max-tab:inset-0 max-tab:!flex max-tab:z-[2] max-tab:m-0 max-tab:w-full max-tab:max-w-full max-tab:rounded-none',
      'desk:inset-y-[var(--cyc-pane-gap)] desk:start-[calc(var(--cyc-rail-width)+var(--cyc-pane-gap))] desk:end-[var(--cyc-pane-gap)]',
      'max-tab:translate-x-full max-tab:opacity-0 max-tab:bg-[var(--cyc-background-color,#0f0f0f)]',
      'tab:!flex',
      'desk:transition-transform desk:duration-0',
      'group-[.view-list]/cols:tab:max-desk:translate-x-[calc(var(--cyc-rail-width)+var(--cyc-pane-gap))]',
      'group-[.view-list]/cols:pointer-events-none group-[.view-chat]/cols:pointer-events-auto',
      'group-[.view-chat]/cols:max-tab:translate-x-0 group-[.view-chat]/cols:max-tab:opacity-100',
      'group-[.view-profile]/cols:max-tab:-translate-x-full group-[.view-profile]/cols:max-tab:opacity-0'
    ].join(' ')
  );
  chatPane.id = 'cyc-thread-pane';
  const threadStage = h(
    'div',
    'cyc-thread-stage relative flex h-full min-w-0 w-full flex-1 flex-col'
  );

  const chatBackground = h(
    'div',
    'cyc-thread-background pointer-events-none absolute inset-0 z-0 overflow-hidden bg-[#ece9e3] tab:hidden'
  );
  paintChatWallpaper(chatBackground, currentCycTheme() === 'night');
  const chatEl = h(
    'div',
    [
      'cyc-thread active',
      'relative !flex h-full w-full min-h-0 flex-1 flex-col items-stretch',
      'transition-[opacity,translate] duration-150 ease-out',
      '[&:not(.active)]:opacity-0 [&:not(.active)]:translate-x-8',
      '[&:not(.active):last-child]:-translate-x-8',
      '[#cyc-stage.cyc-no-thread_&]:[&>:not(.cyc-vacant)]:invisible',
      '[#cyc-stage.cyc-no-thread_&]:[&>:not(.cyc-vacant)_*]:invisible!'
    ].join(' ')
  );
  threadStage.append(chatBackground, chatEl);
  chatPane.append(threadStage);

  const tp = createHeaderPane({
    onTeardown,
    saveDraft: () => saveDraft(),
    loadDraft: (id) => loadDraft(id),
    restorePending,
    releaseMicIfIdle: () => releaseMicIfIdle(),
    setView,
    render: () => render(),
    capUploading: () => cap.uploading,
    notifyOn: (id) => notifyOn(id),
    goToMessage: (sid, ref) => goToMessage(sid, ref),
    openChat: (id) => openChat(id),
    setOverlayToggleChecked: (checked) => {
      settingsUI.setOverlayToggleChecked(checked);
    },
    mainColumns,
    chatEl
  });
  const {
    header,
    placeholderSession,
    convToggleBtn,
    leaveChat,
    backToList,
    cronCountOf,
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
  } = tp;

  const cs = createChatSurface({
    onTeardown,
    render: () => render(),
    chatEl,
    backToList: () => backToList(),
    jumpTo: (dir, trigger, wheel) => jumpTo(dir, trigger, wheel),
    jumpTarget: (dir) => jumpTarget(dir),
    markSeen: (id) => markSeen(id),
    heardTsOf: (s) => heardTsOf(s),
    readMarkerOf: (s) => readMarkerOf(s),
    reportViewedThrough: (id) => reportViewedThrough(id),
    play: (sid, mid, text) => play(sid, mid, text),
    suppressAutoSpeak: () => suppressAutoSpeak,
    clearSuppressAutoSpeak: () => {
      suppressAutoSpeak = false;
    },
    isChatViewOpen: () => mainColumns.dataset.view === 'chat',
    draftOwner: () => vaultBridge.draftOwner(),
    saveDraft: () => saveDraft(),
    loadDraft: (id) => loadDraft(id),
    rebuildToolbarSettings: () => rebuildToolbarSettings(),
    restorePending,
    agentsBarReset: () => agentsBar.reset(),
    releaseMicIfIdle: () => releaseMicIfIdle(),
    composerFocus: () => composer.focus(),
    setView,
    armSettleResort: () => armSettleResort()
  });
  const {
    messageListEl,
    messageListScroll,
    messageListInner,
    renderEarlier,
    stickyDates,
    OVERLAY_SCROLL_NEAR_PX,
    openChat,
    openOwned,
    closeSettleGrace,
    refreshSettleGrace,
    bracketMessageRender,
    scrollToBottom,
    setNewBelow,
    hideUnreadBanner,
    settleNow,
    settleUnheard,
    clearUnreadAnchor,
    firstUnheardId,
    speakUnheard,
    scrollToFirstUnread,
    noteHeardMarked,
    armDeepLinkSpeak,
    landingOwed,
    readerTook,
    graceOpen,
    holdGraceGrowth,
    firstUnread,
    newBelowCount,
    openPaintIsPending,
    openPaintStartedAt,
    clearOpenPaint,
    mountChrome
  } = cs;

  const {
    releaseMicIfIdle,
    cap,
    composer,
    askPanel,
    vaultBridge,
    saveDraft,
    loadDraft,
    putBlocksBack,
    restoreVoiceBlock,
    clipCid,
    vaultKeyOf
  } = createComposerWiring({
    onTeardown,
    clearUnreadAnchor: () => clearUnreadAnchor(),
    scrollToBottom: () => scrollToBottom(),
    render: () => render(),
    jumpToReply: (r) => jumpToReply(r)
  });

  const {audioJumpChip} = mountChrome({
    composerBox: composer.el.querySelector('.cyc-composer-box')!,
    openPlayingMessage: () => openPlayingMessage()
  });

  installComposerTestHooks(composer);

  const {quoteInto, startReply, jumpToMessage, goToMessage, jumpToReply} = createMessageTravel({
    composer,
    messageListInner,
    scroller: () => messageListScroll,
    chatEl,
    renderEarlier: () => renderEarlier(),
    render: () => render(),
    openChat: (id, after) => openChat(id, after),
    isChatViewOpen: () => mainColumns.dataset.view === 'chat'
  });

  installMessageMenu({
    messageListInner,
    scroller: () => messageListScroll,
    active,
    quoteInto,
    startReply,
    jumpToReply,
    retrySend: (sessionId, mid) => engine.retrySend(sessionId, mid),
    cancelSend: (sessionId, mid) => {
      const s = engine.get(sessionId);
      const m = s?.messages.find((x) => x.id === mid);
      if (!m) return;
      if (m.kind === 'voice') {
        // A canceled voice upload never silently discards the recording: it
        // goes back into the composer box, exactly like the E1 recovery path.
        void engine.cancelVoiceUpload(sessionId, mid).then((rec) => {
          if (!rec) return;
          const file = new File([rec.blob], `voice-${rec.cid ?? rec.key}.webm`, {
            type: rec.mime || 'audio/webm'
          });
          vaultKeyOf.set(file, rec.key);
          clipCid.set(file, rec.cid ?? rec.key);
          restoreVoiceBlock(sessionId, file, {
            durationS: rec.durationS ?? 0,
            text: '',
            blob: rec.blob,
            restored: true
          });
          toast('Upload cancelled; the recording is back in the composer');
        });
      } else {
        engine.cancelAttachmentSend(sessionId, mid);
      }
    },
    removeMessage: (s, m) => {
      s.messages.splice(s.messages.indexOf(m), 1);
      render();
    },
    isTouch: touchCapable,
    onTeardown
  });

  const empty = h(
    'div',
    'cyc-vacant hidden absolute inset-0 items-center justify-center z-[1] group-[.view-chat]/cols:[#cyc-stage.cyc-no-thread_&]:flex'
  );
  const emptyPill = h(
    'span',
    'cyc-vacant-pill bg-[rgba(0,0,0,0.35)] text-white rounded-2xl px-3 py-1 text-[0.875rem]'
  );
  emptyPill.textContent = 'Select a session to start talking';
  empty.append(emptyPill);

  agentsBar.slot.append(jumpBar.el);

  chatEl.append(header.el, agentsBar.el, messageListEl, composer.el, empty);

  onTeardown(trackComposerHeight(composer.el));
  onTeardown(trackKeyboardInset(composer.el));

  onTeardown(
    installComposerDropZone({
      pane: chatEl,
      onFiles: (files) => {
        for (const f of files) composer.attach(f);
      },
      canDrop: () => dataState.mode === 'live' && !!active()
    })
  );

  composer.mountAsk(askPanel.el);

  chatEl.addEventListener('click', (e) => {
    if (nav.settingsOpen()) {
      setSettingsOpen(false);
      return;
    }

    if ((e.target as HTMLElement).closest('.cyc-pane-header')) return;
    if (inDrawerRegime() && drawerOpen() && sessionState.activeId) setView('chat');
  });

  const {rightPane, profile} = createProfilePane({
    onTeardown,
    setView,
    openProfileAttachments: (item) => openProfileAttachments(item),
    header,
    placeholderSession,
    cronCountOf: (id) => cronCountOf(id),
    onCronCount,
    mainColumns
  });

  installAndroidIntentLinks();

  const storeHandle = {...engine} as Partial<typeof engine>;
  delete storeHandle.injectFrame;
  (window as unknown as {__cycEngine: unknown}).__cycEngine = storeHandle;

  // The push subscription repair talks to the app server: once, the first
  // time the sync is live (offline design v2, section 7).
  if (dataState.mode === 'live') {
    let repaired = false;
    const repairOnLive = (st: engine.SyncStatus) => {
      if (st !== 'live' || repaired) return;
      repaired = true;
      offRepair();
      void repairPush();
    };
    const offRepair = engine.onSyncStatus(repairOnLive);
    onTeardown(offRepair);
    repairOnLive(engine.syncStatus());
  }

  installGeomOverlay();

  installPresenceBeat({onTeardown, speakUnheard: (id) => speakUnheard(id)});

  const appBackground = h('div', 'cyc-thread-background cyc-app-background z-0');
  paintChatWallpaper(appBackground, currentCycTheme() === 'night');
  paintAppBackgroundWidth(appBackground);
  mainColumns.append(appBackground, leftPane, chatPane, rightPane);

  onTeardown(installLayout(chatPane));

  let suppressAutoSpeak = false;

  const {heardTsOf, readMarkerOf, markSeen, reportViewedThrough, markHeard} = createHeardProgress({
    store: engine,
    isLive: () => dataState.mode === 'live',
    activeId: () => sessionState.activeId,
    isChatViewOpen: () => mainColumns.dataset.view === 'chat',
    onHeardMarked: (sessionId, marker) => noteHeardMarked(sessionId, marker)
  });

  const {
    sessionAttachments,
    openAlbumAt,
    openDocAttachment,
    openProfileAttachments,
    onOpenFileCard
  } = createMediaViewers({
    active,
    allSessions,
    attachToComposer: (file, fromPage) => composer.attach(file, fromPage),
    onShownDocNav: () => {
      restorePending.delete('doc');
      syncNavUrl();
    },
    restored,
    restoreGraceMs: () => RESTORE_GRACE_MS,
    setView,
    goToMessage: (sessionId, ref) => goToMessage(sessionId, ref)
  });

  const {hydrateWaveforms, decodedDurations} = createWaveformHydrator({
    messageListInner,
    isLive: () => dataState.mode === 'live',
    activeId: () => sessionState.activeId,
    audioUrl: (sessionId, msgId) => engine.audioUrl(sessionId, msgId)
  });

  const audioUi = createAudioPlayback({
    messageListInner,
    chatEl,
    audioJumpChip,
    leftContent,
    scrollContainer: () => messageListScroll,
    sessionList,
    header,
    playerBar,
    speaker,
    store: engine,
    isLive: () => dataState.mode === 'live',
    isChatViewOpen: () => mainColumns.dataset.view === 'chat',
    appConversationMode: () => sessionState.appConversationMode,
    chatConversationModeHas: (id) => sessionState.chatConversationMode.has(id),
    active,
    allSessions,
    heardTsOf,
    decodedDurations,
    growingOf: (msgId) => growingOf(msgId),
    capRecState: () => cap.recState,
    goToMessage: (sessionId, ref, msgId) => goToMessage(sessionId, ref, msgId),
    onTeardown
  });
  const {
    play,
    updateRowAudio,
    rowAudioClick,
    onMessagePlay,
    onMessageSeek,
    updateMessagePlays,
    updatePlayerBar,
    openPlayingMessage,
    updateVoiceStrip
  } = audioUi;

  const {render, renderRows, renderChatPane, refreshProfileAttachments} = createRenderHub({
    whole,
    mainColumns,
    list: listPane,
    tp,
    cs,
    audio: audioUi,
    media: {sessionAttachments, onOpenFileCard, openAlbumAt, openDocAttachment},
    composer,
    askPanel,
    profile,
    hydrateWaveforms: () => hydrateWaveforms(),
    syncNavUrl: () => syncNavUrl()
  });

  const {growingOf, RESTORE_GRACE_MS, tryRestoreActive} = installStoreBindings({
    onTeardown,
    cs,
    list: listPane,
    tp,
    audio: audioUi,
    hub: {render: (fromStore) => render(fromStore)},
    settingsUI,
    composer,
    cap,
    putBlocksBack,
    restoreVoiceBlock,
    clipCid,
    vaultKeyOf,
    releaseMicIfIdle: () => releaseMicIfIdle(),
    markHeard: (sessionId, msgId) => markHeard(sessionId, msgId),
    reportViewedThrough: (id) => reportViewedThrough(id),
    setSuppressAutoSpeak: (v) => {
      suppressAutoSpeak = v;
    },
    restored,
    settleBoot,
    requestOpen,
    isUserNavigated: nav.isUserNavigated,
    rebuildToolbarSettings: () => rebuildToolbarSettings(),
    profileRefreshToolbar: () => profile.refreshToolbar(),
    settingsOpen: nav.settingsOpen,
    setView,
    mainColumns
  });

  logSizeBeacon();

  requestPersistence();

  warmClipPlayback();

  render();
}
