import type {CycMediaItem, CycSession} from '@/types';
import {h} from '@/components/domHelpers';
import {toast} from '@/components/widgets';
import {createProfile} from './profile';
import type {CycToolbarActionId} from '@/features/settings/preferences';
import * as engine from '@/engine/store';
import {failed} from '@/engine/fsFail';
import {sessionState, dataState} from '@/sessionState';
import {active, toolbarEngineOf} from '@/sessionSelectors';
import {installOutsideClose} from '@/shared/outsideClose';

export interface ProfilePaneDeps {
  onTeardown(d: () => void): void;
  setView(view: 'list' | 'chat' | 'profile'): void;
  openProfileAttachments(item: CycMediaItem): void;

  header: {
    actionButton(id: CycToolbarActionId): HTMLElement | undefined | null;
  };
  placeholderSession: CycSession;

  cronCountOf(id: string | null | undefined): number;

  onCronCount(fn: () => void): () => void;
  mainColumns: HTMLElement;
}

export function createProfilePane(deps: ProfilePaneDeps) {
  const {
    onTeardown,
    setView,
    openProfileAttachments,
    header,
    placeholderSession,
    cronCountOf,
    onCronCount,
    mainColumns
  } = deps;

  const rightPane = h(
    'div',
    [
      'cyc-pane cyc-pane-right cyc-column',
      // Column slide/fade (was shell.css `.cyc-stage .cyc-column`); `!` mirrors the
      // un-layered rule that overrode the transform transition below.
      '[transition:transform_0.2s_ease-in-out,translate_0.2s_ease-in-out,opacity_0.2s_ease-in-out]!',
      '!absolute end-[var(--cyc-pane-gap)] inset-y-[var(--cyc-pane-gap)]',
      '!flex flex-col !w-[var(--cyc-aside-pane-width)] max-w-full bg-[var(--cyc-surface)] z-[4]',
      'translate-x-[calc(var(--cyc-aside-pane-width)+var(--cyc-pane-gap))]',
      'transition-transform duration-0',
      'group-[.view-profile]/cols:translate-x-0 group-[.view-profile]/cols:duration-0',
      'group-[.view-profile]/cols:[transform:translateZ(0)]'
    ].join(' ')
  );
  rightPane.id = 'cyc-right-pane';
  const profile = createProfile({
    session: placeholderSession,
    onClose: () => setView('chat'),
    onOpenMedia: (item) => openProfileAttachments(item),

    onNeedOlderMedia: async () => {
      const s = active();
      if (!s || dataState.mode !== 'live') return false;
      if (!engine.canOlder(s.id)) return false;
      await engine.loadOlder(s.id);
      return engine.canOlder(s.id);
    },

    onToolbarAction: (id) => header.actionButton(id)?.click(),

    toolbarEngine: (sessionId) => toolbarEngineOf(sessionId),

    onSetPhoto: (photo) => {
      const s = active();
      if (!s || dataState.mode !== 'live') {
        toast('Needs a live engine');
        return;
      }
      profile.setPhotoBusy(true);
      void engine.setSessionPhoto(s.id, photo).then((r) => {
        profile.setPhotoBusy(false);

        if (!failed(r)) {
          toast(photo ? 'Photo set' : 'Photo removed');
          return;
        }
        toast((photo ? 'Photo not set: ' : 'Photo not removed: ') + r.error, 8000);
      });
    }
  });
  rightPane.append(profile.el);

  onTeardown(() => profile.destroy());

  onTeardown(onCronCount(() => profile.setCronCount(cronCountOf(sessionState.activeId))));

  // Pointer outside the pane closes it. The chat header (.cyc-mast) holds the
  // control that toggles the profile, so it stays a toggle; overlays the pane
  // spawns (viewers, menus, popups) mount outside mainColumns and do not count
  // as outside (see installOutsideClose).
  onTeardown(
    installOutsideClose({
      isOpen: () => mainColumns.dataset.view === 'profile',
      within: () => mainColumns,
      inside: (t) => rightPane.contains(t) || !!t.closest('.cyc-mast'),
      close: () => setView('chat')
    })
  );

  return {rightPane, profile};
}
