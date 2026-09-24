import {sessionState, bootUrlNav} from './sessionState';
import {cyclog} from '@/shared/logging';
import {looksOpaque, opaqueKey, writeNav, type NavState} from '@/features/sessions/navigation';
import {installOutsideClose} from '@/shared/outsideClose';
import {active, isDead} from './sessionSelectors';
import {consumeSelfReload} from './shared/selfReload';

type RestoreKey = 'host' | 'chat' | 'list' | 'profile' | 'doc';

export const BOOT_FREEZE_CLASS = '[&_*]:!transition-none';

/* Reopening the app starts on the chats list, not the chat left open (owner,
 * 2026-09-24). iOS hands a standalone app back with its last URL (?chat=),
 * even after a force close, or keeps the page alive. So a launch that is not
 * the app's own reload drops the URL restore, and a resume after this long
 * away returns to the list; a quick hop away keeps the chat. */
export const AWAY_RESET_MS = 60_000;
export function awayLongEnough(hiddenAt: number, now: number): boolean {
  return hiddenAt > 0 && now - hiddenAt >= AWAY_RESET_MS;
}
// Phone layout only: on a wide screen the list and chat sit side by side.
const PHONE_MAX_WIDTH = 550;
const onPhone = () => typeof window !== 'undefined' && window.innerWidth <= PHONE_MAX_WIDTH;

export interface NavMachineDeps {
  onTeardown(d: () => void): void;
  mainColumns: HTMLElement;

  settingsEl(): HTMLElement;

  markSeen(id: string): void;
  updateFab(): void;

  refreshProfileAttachments(): void;
  retryProfileMedia(): void;
  speakUnheard(id: string): void;

  openChat(id: string): void;
}

export function createNavMachine(deps: NavMachineDeps) {
  let wantedHost = bootUrlNav.host;

  let settingsOpen = false;

  const restorePending = new Set<RestoreKey>([
    ...(looksOpaque(bootUrlNav.host) ? (['host'] as const) : []),
    ...(looksOpaque(bootUrlNav.chat) ? (['chat'] as const) : []),
    ...(looksOpaque(bootUrlNav.chat) && bootUrlNav.list ? (['list'] as const) : []),
    ...(bootUrlNav.profile ? (['profile'] as const) : []),
    ...(bootUrlNav.doc ? (['doc'] as const) : [])
  ]);
  // A launch (not our own reload) on a phone opens on the list: no URL restore
  // and no reopening of the last engaged chat (storeBindings reads bootToList).
  const bootToList = !consumeSelfReload() && onPhone();
  if (bootToList) {
    for (const k of ['chat', 'list', 'profile', 'doc'] as const) restorePending.delete(k);
    cyclog('nav.away-reset', {at: 'launch'});
  }
  const restored = (key: RestoreKey) => {
    if (!restorePending.delete(key)) return;
    syncNavUrl();
  };

  let userNavigated = false;
  const cancelPendingOpens = (source: string) => {
    if (userNavigated) return;
    userNavigated = true;
    restorePending.delete('chat');
    restorePending.delete('list');
    wantedHost = null;
    cyclog('nav.cancelled', {source});
  };

  const requestOpen = (
    source: 'restore' | 'notification' | 'newSession' | 'usageLink',
    id: string
  ): boolean => {
    if (userNavigated) {
      cyclog('nav.open.refused', {source, id});
      return false;
    }
    deps.openChat(id);
    return true;
  };

  const openChatKey = (): string | null => {
    if (!sessionState.activeId) return null;
    if (isDead(active())) return null;
    return opaqueKey(sessionState.activeId);
  };
  const navState = (): NavState => ({
    host: restorePending.has('host')
      ? bootUrlNav.host
      : sessionState.activeTabId && opaqueKey(sessionState.activeTabId),
    chat: restorePending.has('chat') ? bootUrlNav.chat : openChatKey(),

    list: restorePending.has('list')
      ? true
      : !!sessionState.activeId && deps.mainColumns.dataset.view === 'list',
    settings: settingsOpen,
    profile: restorePending.has('profile')
      ? bootUrlNav.profile
      : deps.mainColumns.dataset.view === 'profile',
    doc: restorePending.has('doc') ? bootUrlNav.doc : sessionState.shownDoc
  });
  const syncNavUrl = () => writeNav(navState());

  const setView = (view: 'list' | 'chat' | 'profile') => {
    const leavingChat = view !== 'chat' && deps.mainColumns.dataset.view === 'chat';
    const enteringChat = view === 'chat' && deps.mainColumns.dataset.view !== 'chat';
    if (leavingChat && sessionState.activeId) deps.markSeen(sessionState.activeId);
    deps.mainColumns.dataset.view = view;
    deps.mainColumns.classList.remove('view-list', 'view-chat', 'view-profile');
    deps.mainColumns.classList.add(`view-${view}`);
    deps.mainColumns.scrollLeft = 0;
    deps.updateFab();
    if (view === 'profile') {
      deps.refreshProfileAttachments();
      deps.retryProfileMedia();
    }
    if (enteringChat && sessionState.activeId) {
      const id = sessionState.activeId;
      setTimeout(() => {
        if (sessionState.activeId === id) deps.speakUnheard(id);
      }, 60);
    }
    syncNavUrl();
  };
  setView('list');

  let hiddenSince = 0;
  const onVisibility = () => {
    if (document.hidden) {
      hiddenSince = Date.now();
      return;
    }
    const away = awayLongEnough(hiddenSince, Date.now());
    hiddenSince = 0;
    if (away && onPhone() && deps.mainColumns.dataset.view !== 'list') {
      cyclog('nav.away-reset', {at: 'resume', from: deps.mainColumns.dataset.view});
      setView('list');
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  deps.onTeardown(() => document.removeEventListener('visibilitychange', onVisibility));

  deps.mainColumns.classList.add(BOOT_FREEZE_CLASS);
  let bootSettled = false;
  const settleBoot = () => {
    if (bootSettled) return;
    bootSettled = true;

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        deps.mainColumns.classList.remove(BOOT_FREEZE_CLASS);
      })
    );
  };
  const bootTimer = setTimeout(settleBoot, 4000);
  deps.onTeardown(() => {
    clearTimeout(bootTimer);
    deps.mainColumns.classList.remove(BOOT_FREEZE_CLASS);
  });

  deps.mainColumns.addEventListener(
    'scroll',
    () => {
      if (deps.mainColumns.scrollLeft !== 0) deps.mainColumns.scrollLeft = 0;
    },
    {passive: true}
  );
  let closeSettingsSubPage: () => void = () => {};
  const setCloseSettingsSubPage = (fn: () => void) => {
    closeSettingsSubPage = fn;
  };
  const setSettingsOpen = (open: boolean) => {
    settingsOpen = open;
    if (!open) closeSettingsSubPage();
    deps.settingsEl().classList.toggle('cyc-settings-open', open);
    syncNavUrl();
  };

  // Desktop only (past headerPane's 899px drawer regime): a pointer outside
  // the left column closes settings. The settings pane covers that column
  // edge to edge, burger included, so any pointer inside it stays a no-op;
  // narrower widths keep the chat pane's own click-to-close (main.ts), which
  // also handles the tablet drawer, unchanged.
  deps.onTeardown(
    installOutsideClose({
      isOpen: () => settingsOpen && window.innerWidth > 899,
      within: () => deps.mainColumns,
      inside: (t) => deps.settingsEl().contains(t),
      close: () => setSettingsOpen(false)
    })
  );

  return {
    restorePending,
    restored,
    cancelPendingOpens,
    requestOpen,
    navState,
    syncNavUrl,
    setView,
    settleBoot,
    setSettingsOpen,
    setCloseSettingsSubPage,
    settingsOpen: () => settingsOpen,
    isUserNavigated: () => userNavigated,
    bootToList: () => bootToList,
    wantedHost: () => wantedHost,
    clearWantedHost: () => {
      wantedHost = null;
    }
  };
}
