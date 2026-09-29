import type {CycSession} from '@/types';
import * as engine from '@/engine/store';
import type {CycEngineMessage} from '@/engine/store';
import type {ReadMarker} from '@/engine/store/readState';
import {dataState, sessionState} from '@/sessionState';
import {speaker} from '@/audio/speaker';
import {mayStartSpeech} from '@/speechGate';
import {UNREAD_LANDING_SELECTOR} from '../messages/messageFrame';
import {scrollMessageIntoView, repaintMessagesAtScroll, rewindowMessages} from './messageList';
import type {PlayReason} from './audioPlayback';

interface ReaderLandingDeps {
  heardTsOf(session: CycSession): number;
  readMarkerOf(session: CycSession): ReadMarker | undefined;
  play(sessionId: string, msgId: string, text: string, reason?: PlayReason): void;
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

/* Which of two markers sits FURTHER FORWARD by ROW identity (readState.furthest,
 * mirrored here for the surface): both resolve to a row index and the higher
 * wins; an unresolved row falls back to its instant so a marker past the loaded
 * tail still wins. Speech starts at the most-advanced read position -- the pin
 * captured at open, or this device's live marker once a clip has been heard --
 * so a re-run after a clip plays does not re-queue it. */
function furthestMarker(
  messages: readonly CycSession['messages'][number][],
  a: ReadMarker | undefined,
  b: ReadMarker | undefined
): ReadMarker | undefined {
  if (!a) return b;
  if (!b) return a;
  const ia = markerIndex(messages, a);
  const ib = markerIndex(messages, b);
  if (ia >= 0 && ib >= 0) return ib > ia ? b : a;
  return b.ts > a.ts ? b : a;
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
    const msgs = session.messages;
    // The to-play set derives from the SAME read-through IDENTITY the divider and
    // the count anchor on (readState / firstUnheardId), never a `ts >` scan. A
    // restamp, a mis-sorted legacy page, or a read-through row that aged out of
    // the loaded window while a ts twin sits in it made the ts scan replay an
    // ALREADY-HEARD clip -- the owner coming back on the phone to an old audio
    // message, the count reading 0 while speech played on. The start is the row
    // AFTER the marker; speech and the divider now select the identical rows.
    if (!msgs.length) return;
    const marker = furthestMarker(msgs, openMarker(), deps.readMarkerOf(session));
    let start: number;
    if (!marker) {
      start = 0; // nothing read here: speak every claude row from the top
    } else {
      const idx = markerIndex(msgs, marker);
      // Marker present but its row is not in the loaded window (it aged out to an
      // older page): the divider lands at bottom, and speech gives up here too
      // rather than replaying whatever a ts scan would sweep in. He reaches the
      // tail by scrolling to it or tapping.
      if (idx < 0) return;
      start = idx + 1;
    }
    const candidates: CycEngineMessage[] = [];
    for (let i = start; i < msgs.length; i++) {
      const m = msgs[i] as CycEngineMessage;
      if (m.role === 'claude' && m.msgId) candidates.push(m);
    }
    if (!candidates.length) return;
    const pending = speaker.pending();
    const queue = candidates.filter((m) => !pending.has(m.msgId!));
    if (!queue.length) return;
    speaker.stopAll();
    for (const m of queue) deps.play(sessionId, m.msgId!, m.text, 'autoplay-open');
  };

  const scrollToFirstUnread = (firstUnreadId?: string): boolean => {
    const box = scroll;
    const virtualized = !!messages.closest('.cyc-message-list-scroll');
    const H = box.clientHeight;
    const headroom = H / 3;
    // Everything below is anchored to the DISTANCE-TO-END, never to a raw
    // scrollTop. The unread divider sits near the end of a heavy chat, and the
    // rows below it are already mounted and MEASURED on a bottom-pinned open, so
    // its distance to the content end is stable. The rows ABOVE it are only
    // estimated (EST_MSG is far off a wrapped bubble), so scrollHeight swings by
    // tens of thousands of px as they mount and measure -- a scrollTop-anchored
    // jump chased that moving total and either ran away up or clamped back to the
    // end (measured: the open never left the bottom, or shot to the top).
    // Anchoring to distance-to-end absorbs every upper-row change: scrollTop is
    // recomputed from the live scrollHeight each step, so the divider holds its
    // seat regardless of what the history above measures to.
    const dteOf = () => box.scrollHeight - box.scrollTop - H;
    // Move to a target distance-to-end and RE-ASSERT it: each repaint remeasures
    // the newly mounted rows and shifts scrollHeight, which would otherwise leave
    // the actual distance-to-end off the target (scrollTop was written against the
    // pre-repaint total). Recompute scrollTop from the live scrollHeight until it
    // stops moving, so the seat is by distance-to-end, not by a stale total.
    const setDte = (dte: number): void => {
      for (let k = 0; k < 5; k++) {
        const top = Math.max(0, Math.min(box.scrollHeight - H, box.scrollHeight - H - dte));
        if (Math.abs(top - box.scrollTop) <= 0.5) break;
        silentScrollTo(top);
        if (!virtualized) break;
        repaintMessagesAtScroll(messages);
      }
    };
    // Reveal the divider by walking up from the end in bounded distance-to-end
    // steps until it mounts. Bounded per step so no jump overshoots into a
    // clamp; bounded in count so a pathological geometry cannot spin.
    let marker = messages.querySelector<HTMLElement>(UNREAD_LANDING_SELECTOR);
    if (!marker && firstUnreadId && virtualized) {
      const step = Math.max(1, H * 0.9);
      for (let dte = step, pass = 0; !marker && pass < 40; dte += step, pass++) {
        if (dte >= box.scrollHeight - H) break;
        setDte(dte);
        marker = messages.querySelector<HTMLElement>(UNREAD_LANDING_SELECTOR);
      }
    }
    // A detached / non-virtual list mounts every row: scroll straight to it.
    if (!marker && firstUnreadId) {
      scrollMessageIntoView(messages, firstUnreadId, 'start');
      marker = messages.querySelector<HTMLElement>(UNREAD_LANDING_SELECTOR);
    }
    if (!marker) return false;
    // Seat the divider a third of the way down and HOLD it there through the
    // measurement settle, correcting by its live distance-to-end so upper-row
    // growth cannot drift it. Bounded so it cannot spin; the divider node is
    // re-found each pass in case a window slide recreated it.
    for (let pass = 0; pass < 12; pass++) {
      const found = messages.querySelector<HTMLElement>(UNREAD_LANDING_SELECTOR);
      if (!found) break;
      marker = found;
      const delta = marker.getBoundingClientRect().top - box.getBoundingClientRect().top;
      if (Math.abs(delta - headroom) <= 1) break;
      const targetDte = Math.max(0, dteOf() + (headroom - delta));
      const prevTop = box.scrollTop;
      setDte(targetDte);
      if (Math.abs(box.scrollTop - prevTop) <= 1) break;
    }
    // Final settle under the app's OWN re-window, to a FIXED POINT. The
    // positioning above used a plain repaint (no anchor hold) to move freely; the
    // app then settles measurements with an ANCHORED re-window (it holds the
    // topmost visible row) on a debounced scroll-end tick ~half a second later.
    // That later re-window mounts the row the window edge now reaches, measures
    // it away from its estimate, and re-seats onto the top row -- which drifts
    // the divider (below that top row) off its seat, out of view (measured: it
    // slid ~a long row up). So run the SAME anchored re-window here until it is a
    // no-op: mount and measure the edge row it would, re-seat the divider by its
    // distance-to-end, and repeat until an anchored re-window changes neither the
    // scroll offset nor the mounted-row count AND the divider still sits at its
    // seat. The app's later tick then finds nothing to move. Bounded so it cannot
    // spin.
    if (virtualized) {
      let prevKey = '';
      for (let pass = 0; pass < 12; pass++) {
        rewindowMessages(messages);
        const found = messages.querySelector<HTMLElement>(UNREAD_LANDING_SELECTOR);
        if (!found) break;
        marker = found;
        const delta = marker.getBoundingClientRect().top - box.getBoundingClientRect().top;
        if (Math.abs(delta - headroom) > 2) {
          setDte(Math.max(0, dteOf() + (headroom - delta)));
          prevKey = '';
          continue;
        }
        const key =
          Math.round(box.scrollTop) + ':' + messages.querySelectorAll('[data-index]').length;
        if (key === prevKey) break;
        prevKey = key;
      }
    }
    return true;
  };

  const noteHeardMarked = (sessionId: string, marker: ReadMarker) => {
    if (sessionId === sessionState.activeId && marker.ts > (openMarker()?.ts ?? 0)) {
      setOpenMarker(marker);
    }
  };

  return {nothingUnseen, firstUnheardId, speakUnheard, scrollToFirstUnread, noteHeardMarked};
}
