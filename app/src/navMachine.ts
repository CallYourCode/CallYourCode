import {sessionState, bootUrlNav} from './sessionState';
import {cyclog} from '@/shared/logging';
import {looksOpaque, opaqueKey, writeNav, type NavState} from '@/features/sessions/navigation';
import {installOutsideClose} from '@/shared/outsideClose';
import {active, isDead} from './sessionSelectors';

type RestoreKey = 'host' | 'chat' | 'list' | 'profile' | 'doc';

export const BOOT_FREEZE_CLASS = '[&_*]:!transition-none';

/* Coming back to the app after this long away opens the chats list, not the
 * chat left open (owner, 2026-09-24). iOS hands a standalone app back with its
 * last URL (?chat=) or keeps the page alive, so both the boot restore and the
 * resume honour it. A shorter hop away (copying something) keeps the chat. */
export const AWAY_RESET_MS = 60_000;
const HIDDEN_AT_KEY = 'cyc-hidden-at';
// Phone layout only: on a wide screen the list and chat sit side by side.
const PHONE_MAX_WIDTH = 550;

function readHiddenAt(): number {
  try {
    const n = Number(localStorage.getItem(HIDDEN_AT_KEY) ?? '');
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
function writeHiddenAt(at: number): void {
  try {
    localStorage.setItem(HIDDEN_AT_KEY, String(at));
  } catch {}
}
export function awayLongEnough(hiddenAt: number, now: number): boolean {
  return hiddenAt > 0 && now - hiddenAt >= AWAY_RESET_MS;
}
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
  // Relaunched after a long absence: open on the list, not the restored chat.
  // An update reload while the app is on screen has no hidden mark and keeps it.
  if (onPhone() && awayLongEnough(readHiddenAt(), Date.now())) {
    for (const k of ['chat', 'list', 'profile', 'doc'] as const) restorePending.delete(k);
    cyclog('nav.away-reset', {at: 'boot'});
  }
  writeHiddenAt(0);
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

  // The resume check keeps its own clock; the stored mark is only for a relaunch.
  let hiddenSince = 0;
  const onVisibility = () => {
    if (document.hidden) {
      hiddenSince = Date.now();
      writeHiddenAt(hiddenSince);
      return;
    }
    const away = awayLongEnough(hiddenSince, Date.now());
    hiddenSince = 0;
    writeHiddenAt(0);
    if (away && onPhone() && deps.mainColumns.dataset.view !== 'list') {
      cyclog('nav.away-reset', {at: 'resume', from: deps.mainColumns.dataset.view});
      setView('list');
    }
  };
  const onPageHide = () => writeHiddenAt(Date.now());
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  deps.onTeardown(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  });

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
    wantedHost: () => wantedHost,
    clearWantedHost: () => {
      wantedHost = null;
    }
  };
}
