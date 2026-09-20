import type {CycSession} from '@/types';
import * as engine from '@/engine/store';
import type {CycEngineMessage} from '@/engine/store';
import type {ReadMarker} from '@/engine/store/readState';
import {dataState, sessionState} from '@/sessionState';
import {speaker} from '@/audio/speaker';
import {mayStartSpeech} from '@/speechGate';
import {UNREAD_LANDING_SELECTOR} from '../messages/messageFrame';

interface ReaderLandingDeps {
  heardTsOf(session: CycSession): number;
  readMarkerOf(session: CycSession): ReadMarker | undefined;
  play(sessionId: string, msgId: string, text: string): void;
  suppressAutoSpeak(): boolean;
  isChatViewOpen(): boolean;
}

interface ReaderLandingOptions {
  deps: ReaderLandingDeps;
  messages: HTMLElement;
  scroll: HTMLElement;
  silentScrollTo(position: number): void;
  openMarker(): ReadMarker | undefined;
  setOpenMarker(marker: ReadMarker | undefined): void;
}

/* THE STORE INDEX of the marker's row, resolved by durable IDENTITY ALONE: the
 * engine's read-through `mid`. This answers "where is this known row", never "is
 * anything unread" (the count answers that). There is NO ts-equality fallback:
 * time is never identity. When the marker has no mid, or its mid is not in the
 * loaded window, this returns -1 and firstUnheardId places no divider here (it
 * lands per the engine count), rather than anchoring on a DIFFERENT row that
 * merely shares the marker's instant -- the exact mis-anchor the owner's Shalu
 * chat hit (a mid-history ts twin stole the marker while the tail reply was the
 * one unread row). */
function markerIndex(
  messages: readonly CycSession['messages'][number][],
  marker: ReadMarker
): number {
  const mid = marker.mid;
  if (!mid) return -1;
  return messages.findIndex((m) => (m as CycEngineMessage).mid === mid);
}

export function createReaderLanding(options: ReaderLandingOptions) {
  const {deps, messages, scroll, silentScrollTo, openMarker, setOpenMarker} = options;

  /* THE ENGINE'S UNREAD COUNT is the sole authority for WHETHER anything is
   * unread (fix-unread, extended to the landing). `unread === 0` means the
   * owner is caught up: no divider, land at bottom -- full stop. There is NO
   * timestamp fallback: the old `last.ts <= marker.ts` branch conjured a
   * divider on a chat the engine reported read whenever a stale/mis-ordered
   * marker resolved mid-window, anchoring ~mid-history up and tripping the
   * pager. WHERE the divider then sits (firstUnheardId) stays identity-based;
   * the count only decides IF it exists. The caller may pass the count that
   * was authoritative at open (the store zeroes the attached chat's badge),
   * otherwise the session's own count is used. */
  const nothingUnseen = (session: CycSession, unread: number = session.unread): boolean =>
    unread === 0;

  /* The divider and the landing anchor sit at the FIRST ROW THE COUNT COUNTS:
   * the first CLAUDE-role message after the marker IDENTITY in store order
   * (fix-anchor). The engine count (readstate.unreadOf) counts only claude rows
   * after the marker, so the anchor must too -- else a run of non-claude rows
   * (user rows from other paths, any non-claude message rows) sitting between
   * the marker and the tail claude reply steals the anchor while the badge
   * counts just the claude row: the field open that landed 19039px up on a
   * unread=1 chat. The row is found by id and role, never by a `ts >` scan: a
   * restamp or a mis-sorted legacy page moves timestamps, not identities.
   * `pinned` freezes the marker captured at open so rows arriving while the
   * chat is open fall below the divider rather than dragging it down. */
  const firstUnheardId = (
    session: CycSession,
    pinned?: ReadMarker,
    unread: number = session.unread
  ): string | undefined => {
    if (nothingUnseen(session, unread)) return undefined;
    const marker = pinned ?? deps.readMarkerOf(session);
    const msgs = session.messages;
    if (!marker) {
      const first = msgs.find((m) => m.role === 'claude');
      return first ? first.id : undefined;
    }
    const idx = markerIndex(msgs, marker);
    // The marker row is not in the loaded window: its divider belongs to an
    // older page. Land at bottom (return undefined) rather than force a fetch
    // to the top just to place it; the owner reaches it by scrolling.
    if (idx < 0) return undefined;
    // Scan forward to the first claude row after the marker; none found means
    // every trailing row is non-claude (nothing the count counts) -> undefined,
    // land at bottom, no divider.
    for (let i = idx + 1; i < msgs.length; i++) {
      if (msgs[i].role === 'claude') return msgs[i].id;
    }
    return undefined;
  };

  const speakUnheard = (sessionId: string) => {
    if (dataState.mode !== 'live' || deps.suppressAutoSpeak() || !deps.isChatViewOpen()) return;
    if (sessionId !== sessionState.activeId || !mayStartSpeech(sessionId)) return;
    const session = engine.get(sessionId);
    if (!session) return;
    const speakable = session.messages.filter(
      (message): message is CycEngineMessage =>
        message.role === 'claude' && !!(message as CycEngineMessage).msgId
    );
    if (!speakable.length) return;
    // Speech starts at the SAME marker the divider does: the engine's, overlaid
    // with this device's sightings, pinned to where the chat was opened.
    const heard = Math.max(openMarker()?.ts ?? 0, deps.heardTsOf(session));
    const pending = speaker.pending();
    const queue = speakable.filter((message) => message.ts > heard && !pending.has(message.msgId!));
    if (!queue.length) return;
    speaker.stopAll();
    for (const message of queue) deps.play(sessionId, message.msgId!, message.text);
  };

  const scrollToFirstUnread = (): boolean => {
    const marker = messages.querySelector<HTMLElement>(UNREAD_LANDING_SELECTOR);
    if (!marker) return false;
    const box = scroll;
    const headroom = box.clientHeight / 3;
    const delta = marker.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const target = Math.max(0, box.scrollTop + delta - headroom);
    silentScrollTo(Math.min(target, box.scrollHeight - box.clientHeight));
    return true;
  };

  const noteHeardMarked = (sessionId: string, marker: ReadMarker) => {
    if (sessionId === sessionState.activeId && marker.ts > (openMarker()?.ts ?? 0)) {
      setOpenMarker(marker);
    }
  };

  return {nothingUnseen, firstUnheardId, speakUnheard, scrollToFirstUnread, noteHeardMarked};
}
