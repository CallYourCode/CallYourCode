import {beforeEach, describe, expect, test, vi} from 'vitest';

// A VIDEO FILE CARD DOWNLOADS (fix-video-download, 2026-10-07). The owner tapped
// the download icon on an agent-sent "pharma-demo-v1.mp4" on laptop Chrome and
// got a full-screen "Downloading..." modal, then a blank inline player. A shown
// binary, video and audio included, goes through the card's download path.

const {tapDownloadCard} = vi.hoisted(() => ({tapDownloadCard: vi.fn()}));
vi.mock('../features/media/downloadCards', () => ({tapDownloadCard}));
vi.mock('../engine/store', () => ({
  docUrl: (sid: string, docId: string) => `doc://${sid}/${docId}`,
  uploadUrl: (sid: string, refId: string) => `up://${sid}/${refId}`
}));

import {createMediaViewers} from '../features/media/viewers';
import {dataState} from '../sessionState';
import type {CycFileRef, CycMessage, CycSession} from '../types';

const session = {id: 's1', messages: []} as unknown as CycSession;

function viewers() {
  return createMediaViewers({
    active: () => session,
    allSessions: () => [session],
    attachToComposer: vi.fn(),
    onShownDocNav: vi.fn(),
    restored: vi.fn(),
    restoreGraceMs: () => 0,
    setView: vi.fn(),
    goToMessage: vi.fn(async () => true)
  });
}

const card = (name: string): CycMessage =>
  ({file: {docId: 'd1', name, fileKind: 'binary', size: 15_700_000} as CycFileRef}) as CycMessage;

describe('a shown binary file card always downloads', () => {
  beforeEach(() => {
    tapDownloadCard.mockReset();
    document.body.replaceChildren();
    dataState.mode = 'live';
  });

  test.each(['pharma-demo-v1.mp4', 'song.mp3', 'pack.zip'])(
    '%s goes to the download path, never an inline player',
    (name) => {
      const m = card(name);
      viewers().onOpenFileCard(m);
      expect(tapDownloadCard).toHaveBeenCalledWith(m.file, 'doc://s1/d1/raw');
      expect(document.querySelector('.cyc-media-viewer')).toBeNull();
    }
  );
});
