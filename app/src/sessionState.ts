import type {CycSession} from './types';
import type {CycTabInfo} from './engine/store';
import {bootNav, bootWasOurs} from '@/features/sessions/navigation';

export const sessionState = {
  activeId: null as string | null,

  activeTabId: null as string | null,
  tabSelection: new Map<string, string>(),
  appConversationMode: false,
  chatConversationMode: new Set<string>(),
  autoSpeak: true,
  /** The archive lens: while true the list pane shows the ARCHIVED (dead)
   *  sessions instead of the live conversations. A transient view state, not
   *  persisted and not in the URL; toggled by the list's archive entry row. */
  archiveOpen: false,

  shownDoc: null as string | null
};

export const bootUrlNav = bootNav();

export const bootUrlIsOurs = bootWasOurs();

export const dataState = {
  mode: 'live' as 'live' | 'test',
  demoSessions: [] as CycSession[],
  testTabs: [] as CycTabInfo[]
};

export const unsentWork = {
  until: 0,
  inFlight: (): boolean => false,
  hold(ms: number) {
    this.until = Math.max(this.until, Date.now() + ms);
  },
  busy() {
    return Date.now() < this.until || this.inFlight();
  }
};

export const vaultHolds = {writing: 0};

export const stagedBlocks = {held: (() => false) as () => boolean};

export const orphanSweep = {started: false};
