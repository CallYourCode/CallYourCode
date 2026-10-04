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
  /* Whether this device has already had the row on screen or heard it to the
   * end (heardProgress's seen set). The marker only moves through a contiguous
   * seen run, so a clip heard to the end can still sit after it; speech must not
   * pick it again. Absent: nothing is known seen beyond the marker. */
  heardOrSeen?(sessionId: string, rowId: string): boolean;
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
    // NEVER decide what is unheard from a stale or unknown read state. At a cold
    // boot / reconnect / notification-tap open the marker and the count on the
    // session are the CACHED roster values, and those can be stale: the owner
    // read the chat on the laptop while the phone slept, so the phone's persisted
    // unread is 0 and its marker is undefined (readThrough is not persisted) even
    // though a live reply is genuinely unheard. Selecting then either replays the
    // whole loaded window (the old `!marker -> start=0`) or a `ts` scan queues an
    // ALREADY-HEARD clip -- the owner's "back on the phone it plays some old audio
    // message". Wait until the engine has refreshed THIS session's read state on
    // THIS connection (the sessions/catchup frame); its arrival re-invokes this
    // (readState.onReadStateFresh -> renderHub), so speech runs once, on truth.
    if (!engine.readStateFreshOnConn(sessionId)) return;
    const msgs = session.messages;
    if (!msgs.length) return;
    // WHETHER anything is unheard is the engine's unread COUNT alone -- the same
    // authority the divider uses (nothingUnseen). The attached chat's own badge
    // is zeroed in the store (you are reading it), so read the engine count kept
    // beside it (engineUnread), falling back to the session count off that path.
    // unread === 0 means caught up: speak nothing, exactly like the divider.
    const unread = session.engineUnread ?? session.unread;
    if (unread <= 0) return;
    // WHERE the unheard run is, is the read-through ROW IDENTITY -- the same
    // anchor the divider lands on (firstUnheardId), never a `ts >` scan. Two
    // shapes, both selecting exactly the clips the engine counts unread:
    //   - the read-through row is in the loaded window: speak the claude rows
    //     AFTER it.
    //   - the marker is unknown, or its row aged out of the window to an older
    //     page: speak the NEWEST `unread` claude rows -- the engine's count --
    //     never nothing (the old `idx < 0 -> return` went silent on a genuine new
    //     reply) and never the whole window (the old `!marker -> start=0`).
    const marker = furthestMarker(msgs, openMarker(), deps.readMarkerOf(session));
    const idx = marker ? markerIndex(msgs, marker) : -1;
    const claudeFrom = (from: number): CycEngineMessage[] => {
      const out: CycEngineMessage[] = [];
      for (let i = from; i < msgs.length; i++) {
        const m = msgs[i] as CycEngineMessage;
        if (m.role === 'claude' && m.msgId) out.push(m);
      }
      return out;
    };
    //   - the marker aged out of the window: speak the newest `unread` claude rows
    //     that sit AT OR AFTER the read-through INSTANT. The instant is the floor a
    //     stale cache needs: a device that slept while the owner read on another
    //     device opens onto a window whose newest loaded row is BEHIND the engine's
    //     read-through, so the genuinely-unheard reply is on a NEWER unloaded page
    //     and NOTHING loaded is unread. The old `slice(-unread)` with no floor then
    //     spoke the newest OLD clip still in the stale window -- the owner's "it
    //     played a very old audio" (the newest msgId-bearing claude row there was a
    //     two-day-old finalised speak clip). Both ts are the engine's, not a client
    //     clock, so this floor is the same AT-OR-AFTER the index gives, extended to
    //     a marker whose row is not loaded. When the marker is on an OLDER page the
    //     floor keeps every loaded row, so a genuine catch-up still speaks.
    const candidates =
      idx >= 0
        ? claudeFrom(idx + 1)
        : claudeFrom(0)
            .filter((m) => !marker || m.ts >= marker.ts)
            .slice(-unread);
    if (!candidates.length) return;
    /* NOT A CLIP ALREADY HEARD (release-1 B1). A clip heard to the end is in the
     * seen set but can sit after the marker (the marker waits for every unread
     * row before it to be seen too), so the marker alone would pick it again:
     * the replay edge, the back-live timer and a return to the page each re-ran
     * this, cut the clip playing and replayed the heard one. */
    const pending = speaker.pending();
    const queue = candidates.filter(
      (m) => !pending.has(m.msgId!) && !deps.heardOrSeen?.(sessionId, m.id)
    );
    if (!queue.length) return; // nothing new: leave whatever is playing alone
    /* Already speaking this chat: add the new clips behind it, never restart
     * it. Only audio from another chat (or none) is replaced. */
    const ownRun = pending.size > 0 && (speaker.state.sessionId ?? sessionId) === sessionId;
    if (!ownRun) speaker.stopAll();
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
