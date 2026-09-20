import type {CycMessage, CycSession, CycSessionEvent} from '@/types';
import {RENDERABLE_EVENT_KINDS} from '@/engine/store/rows/core';

import {h} from '@/components/domHelpers';
import {cyclog} from '@/shared/logging';
import {DEFAULT_AGENT_NAME} from '../navigation/chatRow';
import {dayLabel} from '@/features/chat/content';
import {isAudioUpload, uploadsOf, isResumeControlRow} from '@/features/chat/content';
import {
  textMessage,
  photoMessage,
  SERVICE_CONTENT_UTILS,
  SERVICE_MSG_UTILS,
  attachMessageHighlight,
  unreadBannerEl,
  queuedBannerEl,
  sendProgressNode,
  sendProgressText
} from '../messages/messageContent';
import {markUnreadLanding, setMessageLast} from '../messages/messageFrame';
import {audioMessage} from '../messages/audioMessages';
import {attachmentMessage, uploadMessage} from '../messages/attachmentMessages';
import {snippetMessage, fileMessage, downloadMessage} from '../messages/fileMessages';
import {
  dateMessage,
  sessionEventMessage,
  sessionEventRunMessages,
  sessionEventFoldMessages,
  extendFold,
  SERVICE_TEXT_UTILS
} from '../messages/sessionEventMessages';

function itemSig(
  m: CycMessage | undefined,
  ev: CycSessionEvent | undefined,
  ts: number,
  firstUnreadId?: string
): string {
  if (ev) return `e|${ts}|${ev.kind}|${(ev as {uuid?: string}).uuid ?? ''}|${ev.text ?? ''}`;
  const x = m as CycMessage & {
    msgId?: string;
    durationS?: number;
    growing?: boolean;
    sendPct?: number;
  };
  const f = m!.file;
  return [
    'm',
    m!.id,
    ts,
    m!.role,
    m!.status ?? '',
    m!.failReason ?? '',
    m!.kind ?? '',
    m!.queued ? 1 : 0,
    m!.draftCommitted ?? '',

    x.growing ? 'g' : '',
    x.msgId ?? '',
    x.durationS ?? '',
    // Transfer progress: only its PRESENCE re-keys the row (the progress line
    // appears or leaves with it). The per-chunk value is patched into the kept
    // node's text in place (renderMessages), never by a rebuild; rebuilding
    // per chunk recreated the bubble's <img> each tick and the pending photo
    // blinked for the whole send (the image-send flicker bug).
    typeof x.sendPct === 'number' ? 'p' : '',
    m!.upload?.uploadId ?? '',
    f ? `${f.fileKind ?? ''}:${f.name ?? ''}:${f.inline ? 1 : 0}:${f.content?.length ?? ''}` : '',
    m!.id === firstUnreadId ? 'U' : '',

    m!.replyTo ? `${m!.replyTo.ts}:${m!.replyTo.quote ? 'q' : ''}:${m!.replyTo.text}` : '',
    m!.text
  ].join('|');
}

// An attachment bubble's send state (Lane A): "sending NN%" while its files
// move over the transfer queue, and the failed mark once any of them is
// refused. Voice notes paint their own (audioMessages).
function paintAttachmentSend(node: HTMLElement, m: CycMessage, hasFiles: boolean): void {
  if (!hasFiles || m.role !== 'user' || m.kind === 'voice') return;
  if (m.status === 'failed') {
    node.classList.add('cyc-msg-failed');
    return;
  }
  if (m.status !== 'sending' || typeof m.sendPct !== 'number') return;
  const stamp = node.querySelector('.cyc-stamp');
  if (!stamp) return;
  stamp.before(sendProgressNode(m.sendPct));
}

// A row rebuilt for the same message adopts the dropped row's <img> elements
// wherever the picture source is unchanged: the old element keeps its decoded
// bitmap, its object URL and its pending load/reveal listeners, so the repaint
// (a delivery tick, the engine's adopted timestamp) never blanks the photo
// behind a fresh decode. Sources are matched by data-cyc-src, stamped by
// setTunnelSrc with the URL the row was painted from. An old element that
// errored (cyc-off) is left behind so the fresh one retries.
function carryStillImages(oldNode: HTMLElement | undefined, next: HTMLElement): void {
  if (!oldNode) return;
  const bySrc = new Map<string, HTMLImageElement[]>();
  for (const im of oldNode.querySelectorAll<HTMLImageElement>('img.cyc-still')) {
    const k = im.dataset.cycSrc;
    if (!k || im.classList.contains('cyc-off')) continue;
    const list = bySrc.get(k);
    if (list) list.push(im);
    else bySrc.set(k, [im]);
  }
  if (!bySrc.size) return;
  for (const im of next.querySelectorAll<HTMLImageElement>('img.cyc-still')) {
    const k = im.dataset.cycSrc;
    const old = k ? bySrc.get(k)?.shift() : undefined;
    if (!old) continue;
    // The rebuilt row's styling wins (a shape change restyles the element),
    // but the old element's own visibility is the truth: a fresh build starts
    // invisible until load, and the carried element may already be shown.
    const hidden = old.classList.contains('invisible');
    old.className = im.className;
    old.classList.toggle('invisible', hidden);
    old.alt = im.alt;
    im.replaceWith(old);
  }
}

// The unread divider and the "first queued" banner are stamped INTO a message
// row at build time (paintMessages). The incremental walk keeps already-built
// rows verbatim, so a row that is no longer the anchor (the divider moved, or a
// second copy of the anchor id arrived on an overlapping history page) or no
// longer the first queued row (a reply landed below it, so it sits behind the
// agent now) would carry a banner it should have shed; a later paint stamping
// the new row then leaves the transcript showing two. These strip a stale stamp
// off a reused row so every repaint converges on at most one of each.
function stripUnreadStamp(node: HTMLElement): void {
  node.querySelector(':scope > .cyc-msg-unread')?.remove();
  delete node.dataset.cycUnread;
  node.classList.remove('max-tab:!max-w-none');
}

function stripQueuedStamp(node: HTMLElement): void {
  node.querySelector(':scope > .cyc-msg-queued')?.remove();
  node.classList.remove('cyc-first-queued');
}

// One painted item: a message row or a session-event run. The group and the
// day section it sits in are shared with its neighbours, so a frame only ever
// owns (and removes) its own node; a wrapper left empty is pruned afterwards,
// or handed back to the row rebuilt in its place.
type ItemFrame = {
  sig: string;

  sigs: string[];
  node: HTMLElement;
  dayKey: string;
  dateGroup: HTMLElement | null;
  group: HTMLDivElement | null;
  prevRole: string | null;
  prevQueued: boolean;
  consumed: number;
  // A session-event frame (a lone pill, a tool run, or a fold). `fold` marks
  // the expandable "N background updates" head specifically. Both are read by
  // the reuse walk to keep a tail fold current as its run grows.
  se?: boolean;
  fold?: boolean;
  // The group-end state a message row was painted with. A same-role
  // neighbour arriving below it flips this in place (setMessageLast) instead
  // of rebuilding the row. Absent on session-event frames.
  last?: boolean;
};

type RenderState = {
  sessionId: string;
  frames: ItemFrame[];

  from: number;

  count: number;

  // The item index at which each RENDER-VISIBLE row begins for the current
  // items list (visibleRowStarts). The window budget counts these, not raw
  // items, and extendMessageWindow moves the floor up by whole visible rows so
  // one step past a huge collapsed run reveals real content, not more of the
  // same chip.
  starts: number[];
};

const renderStates = new WeakMap<HTMLElement, RenderState>();

// The window budget, measured in RENDER-VISIBLE rows: a message is one row, a
// collapsed "N background updates" run is one row (one chip), a short tool run
// is one row. Counting visible rows (not raw items) is what keeps a fresh open
// of a status-heavy chat painting a screen of real bubbles instead of the
// newest 300 ITEMS collapsing to a single chip (the field failure).
const WINDOW_ITEMS = 300;

const WINDOW_CHUNK = 300;

// The item index at which each render-visible row begins, walking the merged
// item list EXACTLY as the build loop groups it: a maximal same-day run of
// >= COLLAPSE_MIN session events is one fold row; a shorter same-day tool run
// (with an optional trailing interrupt) is one run row; any other lone event is
// one pill row; each message is one row. The result's length is the total
// visible-row count, and each entry is a legal window floor (a row boundary).
export function visibleRowStarts(
  items: {m?: CycMessage; ev?: CycSessionEvent; ts: number}[]
): number[] {
  // One Date per item (the run scans below compare these strings, never re-parse)
  // so the whole-list pass stays O(n) even on a chat with thousands of events.
  const day = new Array<string>(items.length);
  for (let k = 0; k < items.length; k++) day[k] = new Date(items[k].ts).toDateString();
  const starts: number[] = [];
  let i = 0;
  while (i < items.length) {
    starts.push(i);
    const it = items[i];
    if (it.ev) {
      const key = day[i];
      let runEnd = i;
      while (runEnd + 1 < items.length && items[runEnd + 1].ev && day[runEnd + 1] === key) runEnd++;
      if (runEnd - i + 1 >= COLLAPSE_MIN) {
        i = runEnd + 1;
        continue;
      }
      if (it.ev.kind === 'tool') {
        let j = i;
        while (j + 1 < items.length && items[j + 1].ev?.kind === 'tool' && day[j + 1] === key) j++;
        if (j + 1 < items.length && items[j + 1].ev?.kind === 'interrupt' && day[j + 1] === key)
          j++;
        i = j + 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return starts;
}

// The window floor that leaves `target` visible rows painted (or 0 when the
// whole list already fits the budget). Returns a row boundary from `starts`.
function floorForVisibleRows(starts: number[], target: number): number {
  if (starts.length <= target) return 0;
  return starts[starts.length - target];
}

// The largest row-start <= `idx` (a legal window floor at or before `idx`), or 0.
// Used to snap a floor computed from a raw item index (the landing-anchor pull)
// back onto a visible-row boundary so the build loop's grouping is clean.
function rowStartAtOrBefore(starts: number[], idx: number): number {
  if (idx <= 0 || !starts.length) return 0;
  let lo = 0;
  let hi = starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= idx) {
      ans = starts[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// The number of visible rows painted by a window whose floor is item index
// `from` (rows at or after `from`).
function visibleRowsFrom(starts: number[], from: number): number {
  if (from <= 0) return starts.length;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return starts.length - lo;
}

export function extendMessageWindow(inner: HTMLElement, by = WINDOW_CHUNK): boolean {
  const st = renderStates.get(inner);
  if (!st || st.from <= 0) return false;
  const starts = st.starts;
  if (starts && starts.length) {
    // Move the floor up by `by` VISIBLE rows, not raw items: above a huge
    // collapsed run one chunk of items could all sit inside a single fold, so
    // an item-step would reveal nothing. Find the floor's current row, step
    // back `by` rows, and land on that row's start.
    let curRow = 0;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= st.from) {
        curRow = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const targetRow = Math.max(0, curRow - Math.max(1, by));
    st.from = starts[targetRow] ?? 0;
  } else {
    st.from = Math.max(0, st.from - Math.max(1, by));
  }
  st.frames = [];
  return true;
}

export function messageWindowFrom(inner: HTMLElement): number {
  return renderStates.get(inner)?.from ?? 0;
}

const EAGER_TAIL = 12;

/** The record kinds the activity overlay paints as pills. The log carries more
 *  (status edges, asks, mux and harness facts, delivery receipts); those are
 *  held with their pages and left off the surface, which shows them elsewhere
 *  (the row's status, the ask sheet) or not at all. */
// The full pre-2026-09-05 set, restored whole (owner, 2026-09-06: "keep it
// simple. even the echos and whatever can show. nothing needs to be hidden").
// prompt and reply pills are back unconditionally: a cron firing, one agent
// messaging this one, a pane-typed line, and the agent's terminal answers all
// show as plain grey session pills, echoes included. The one thing machine
// input never gets is a chat BUBBLE: user/agent/session messages all ride the
// same messages API and pages, and role stays truthful.
//
// The canonical set lives in the store's row core (RENDERABLE_EVENT_KINDS) and is
// re-exported here under its long-standing name so the paint path and the store
// share ONE definition of which event kinds become pills. These pills paint only
// under the agent-activity overlay; the store's open-window floor deliberately
// does NOT anchor on them (anchorsOpenWindow anchors on messages alone), so a
// cold open lands on the conversation's bubbles whether or not the overlay is on.
export const VISIBLE_EVENT_KINDS = RENDERABLE_EVENT_KINDS;

/** A maximal run of consecutive session events this long (any mix of
 *  VISIBLE_EVENT kinds, within one day) folds into a single expandable
 *  "N background updates" head instead of rendering N pills. Below this the run
 *  renders exactly as before (individual pills, with the short tool burst still
 *  grouped by sessionEventRunMessages). BZ Builder's chat is ~87% autonomous
 *  session pills; 6 keeps the human's real messages from being buried while a
 *  handful of updates between them still show inline. */
export const COLLAPSE_MIN = 6;

/** Monotonic count of message-list DOM teardowns. clearMessages and the
 *  empty-items wipe below rebuild the node set from scratch with no message
 *  change behind them; the render hub folds this into its scan key so the DOM
 *  sweeps (waveform hydration, sticky dates, play-state paint) re-run over the
 *  fresh nodes instead of trusting a stale key. */
let domEpoch = 0;

export function messageDomEpoch(): number {
  return domEpoch;
}

export function clearMessages(inner: HTMLElement) {
  domEpoch++;
  renderStates.delete(inner);
  inner.textContent = '';
}

export function renderMessages(
  inner: HTMLElement,
  s: CycSession,
  onPlay: (m: CycMessage, el: HTMLElement) => void,
  firstUnreadId?: string,
  onSeek?: (m: CycMessage, ratio: number) => void,
  onOpenFile?: (m: CycMessage) => void,
  events?: CycSessionEvent[],
  uploadSrc?: (m: CycMessage) => string,
  onOpenUpload?: (u: NonNullable<CycMessage['upload']>) => void,
  fileSrc?: (m: CycMessage) => string,
  onEarlier?: () => void,
  uploadUrlOf?: (m: CycMessage, u: NonNullable<CycMessage['upload']>) => string
) {
  // Safety net: the incremental reuse walk must NEVER leave the list frozen. If
  // any pass throws (a frame/DOM invariant we did not foresee), drop the reuse
  // state, wipe the node set, and repaint once from scratch, logging
  // `render.rebuild-fallback` so the field names itself. A full rebuild has no
  // reuse state to trip over; if it too throws the input is genuinely broken
  // and the error propagates to the global reporter.
  try {
    paintMessages(
      inner,
      s,
      onPlay,
      firstUnreadId,
      onSeek,
      onOpenFile,
      events,
      uploadSrc,
      onOpenUpload,
      fileSrc,
      onEarlier,
      uploadUrlOf
    );
  } catch (e) {
    cyclog('render.rebuild-fallback', {
      session: s.id,
      error: String((e as {message?: string})?.message ?? e).slice(0, 200)
    });
    renderStates.delete(inner);
    inner.textContent = '';
    domEpoch++;
    paintMessages(
      inner,
      s,
      onPlay,
      firstUnreadId,
      onSeek,
      onOpenFile,
      events,
      uploadSrc,
      onOpenUpload,
      fileSrc,
      onEarlier,
      uploadUrlOf
    );
  }
}

function paintMessages(
  inner: HTMLElement,
  s: CycSession,
  onPlay: (m: CycMessage, el: HTMLElement) => void,
  firstUnreadId?: string,
  onSeek?: (m: CycMessage, ratio: number) => void,
  onOpenFile?: (m: CycMessage) => void,
  events?: CycSessionEvent[],
  uploadSrc?: (m: CycMessage) => string,
  onOpenUpload?: (u: NonNullable<CycMessage['upload']>) => void,
  fileSrc?: (m: CycMessage) => string,
  onEarlier?: () => void,
  uploadUrlOf?: (m: CycMessage, u: NonNullable<CycMessage['upload']>) => string
) {
  // A control-answer row (a terminal prompt the owner answered from the app)
  // stays in the store as real history but paints no bubble: it is a control
  // input, not a message. Filtered here so it never becomes a transcript item,
  // without shifting any other row's id or store order.
  const msgs = s.messages.filter((m) => !isResumeControlRow(m));
  const evs = events ? events.filter((ev) => VISIBLE_EVENT_KINDS.has(ev.kind)) : [];

  let lastClaudeMi = -1;
  for (let j = msgs.length - 1; j >= 0; j--)
    if (msgs[j].role === 'claude') {
      lastClaudeMi = j;
      break;
    }
  type Item = {m?: CycMessage; mi?: number; ev?: CycSessionEvent; ts: number};
  const items: Item[] = [];
  {
    let mi = 0,
      ei = 0;
    while (mi < msgs.length || ei < evs.length) {
      if (ei >= evs.length || (mi < msgs.length && msgs[mi].ts <= evs[ei].ts)) {
        items.push({m: msgs[mi], mi, ts: msgs[mi].ts});
        mi++;
      } else {
        items.push({ev: evs[ei], ts: evs[ei].ts});
        ei++;
      }
    }

    for (let i = 1; i < items.length; i++) {
      if (items[i].ev?.kind !== 'interrupt') continue;
      let j = i - 1;
      while (j >= 0 && !items[j].ev) j--;
      if (j < 0 || j === i - 1 || items[j].ev!.kind !== 'tool') continue;
      if (new Date(items[j].ts).toDateString() !== new Date(items[i].ts).toDateString()) continue;
      items.splice(j + 1, 0, items.splice(i, 1)[0]);
    }
  }

  if (!items.length) {
    domEpoch++;
    renderStates.delete(inner);
    inner.textContent = '';

    if ((s as {historyPending?: boolean}).historyPending) return;
    const wrap = h('div', 'cyc-vacant-chat flex flex-auto items-center justify-center');
    const messageNode = h(
      'div',
      'cyc-message cyc-msg-system relative z-[1] mx-auto mb-0.5 flex flex-wrap ' +
        SERVICE_MSG_UTILS +
        ' max-w-[var(--cyc-chat-width)]'
    );
    const content = h('div', 'cyc-message-content ' + SERVICE_CONTENT_UTILS);
    const msg = h('div', 'cyc-service-text ' + SERVICE_TEXT_UTILS);
    msg.textContent = 'No messages here yet';
    content.append(msg);
    messageNode.append(content);
    attachMessageHighlight(messageNode);
    wrap.append(messageNode);
    inner.append(wrap);
    return;
  }

  const prev = renderStates.get(inner);
  const sameChat = !!(prev && prev.sessionId === s.id);
  const starts = visibleRowStarts(items);
  const budgetFloor = floorForVisibleRows(starts, WINDOW_ITEMS);
  let from = sameChat ? Math.min(prev!.from, Math.max(0, items.length - 1)) : budgetFloor;

  // A sameChat repaint whose reader sits at the bottom and whose window has
  // grown well past the budget resnaps to the newest WINDOW_ITEMS VISIBLE rows,
  // bounding the painted DOM. Measured in visible rows (a collapsed run is one),
  // never raw items, so the resnap keeps a screen of real content, not one chip.
  // The near-bottom guard leaves a reader who scrolled up untouched.
  if (sameChat && prev!.frames.length && from < budgetFloor) {
    const wayOver = visibleRowsFrom(starts, from) > WINDOW_ITEMS * 2;
    const grew = items.length - prev!.count >= WINDOW_CHUNK;
    if (wayOver || grew) {
      const sc = inner.closest('.cyc-message-list-scroll');
      if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 200) {
        from = budgetFloor;
      }
    }
  }

  // LANDING ANCHOR (fix-msgwindow, shape 3). A firstUnreadId that falls outside
  // the current window EXTENDS the window to include it, on EVERY paint, not
  // only a fresh open: a tab-return repaint (or the landing's own second paint)
  // is a sameChat repaint, and the reader-at-bottom resnap above can push the
  // floor past an old anchor. Runs AFTER the resnap so the resnap still bounds
  // DOM, then this guarantees the anchor is landable (its divider is painted)
  // instead of the landing skipping to the window edge on weeks-old rows. Pull
  // back to ~3 messages before the anchor for lead-in, then snap to a row start.
  if (firstUnreadId !== undefined && from > 0) {
    const u = items.findIndex((it) => it.m?.id === firstUnreadId);
    if (u >= 0 && u < from) {
      const WANT = 3;
      const LOOK_BACK = 60;
      let seen = 0;
      let i = u;
      while (i > 0 && seen < WANT && u - i < LOOK_BACK) {
        i--;
        if (items[i]?.m) seen++;
      }
      from = rowStartAtOrBefore(starts, Math.max(0, i));
    }
  }
  const winItems = from > 0 ? items.slice(from) : items;

  const sigs = winItems.map((it) => itemSig(it.m, it.ev, it.ts, firstUnreadId));

  const reusable = sameChat && prev!.from === from ? prev!.frames : null;
  let start = 0;
  if (reusable) {
    while (start < reusable.length) {
      const f = reusable[start];
      if (!f) break;
      const own = f.sigs;
      if (start + own.length > sigs.length) break;
      let same = true;
      for (let k = 0; k < own.length; k++) {
        if (own[k] !== sigs[start + k]) {
          same = false;
          break;
        }
      }
      if (!same) break;
      start += own.length;
    }
  }

  // The tail session-event run has grown. Reusing the trailing frames verbatim
  // is what stalled the field list: a fold's "N background updates" head froze
  // at its old count while the newly arrived same-day events accreted as loose
  // pills below it (and, unbounded, those extra pill nodes were kept alive
  // through their presentation painters, growing the heap until repaint
  // stalled). Two shapes are corrected here, both only when the run reaches the
  // very tail of what was reused (nothing reused past it):
  //   - a fold at the tail whose run extended: grow it IN PLACE (no rebuild, no
  //     churn) so the head count tracks the run and nothing accretes below it;
  //   - a sub-COLLAPSE_MIN run at the tail that has now grown to or past the
  //     threshold: rewind to the run's start so the grouping loop rebuilds it
  //     as a fold, exactly as a fresh paint would.
  let grown: ItemFrame[] | null = null;
  if (reusable && start === reusable.length && start > 0 && start < winItems.length) {
    const next = winItems[start];
    if (next?.ev) {
      const day = new Date(next.ts).toDateString();
      let li = start - 1;
      while (li > 0 && !reusable[li]) li--;
      const foldFrame = reusable[li];
      if (
        foldFrame?.fold &&
        new Date(winItems[li].ts).toDateString() === day &&
        foldFrame.node.isConnected
      ) {
        const add: CycSessionEvent[] = [];
        let end = start;
        while (
          end < winItems.length &&
          winItems[end].ev &&
          new Date(winItems[end].ts).toDateString() === day
        ) {
          add.push(winItems[end].ev!);
          end++;
        }
        if (add.length && extendFold(foldFrame.node, add)) {
          grown = reusable.slice(0, start);
          for (let k = start; k < end; k++) {
            foldFrame.sigs.push(sigs[k]);
            grown.push(undefined as unknown as ItemFrame);
          }
          start = end;
        }
      } else {
        // Trailing same-day session-event pills (no fold yet): find the run's
        // start among the reused frames and count how long it is once the new
        // events are included.
        let runStart = start;
        let j = start - 1;
        while (j >= 0) {
          while (j >= 0 && !reusable[j]) j--;
          if (j < 0) break;
          const f = reusable[j];
          if (!f.se || new Date(winItems[j].ts).toDateString() !== day) break;
          runStart = j;
          j--;
        }
        let end = runStart;
        while (
          end < winItems.length &&
          winItems[end].ev &&
          new Date(winItems[end].ts).toDateString() === day
        )
          end++;
        if (runStart < start && end - runStart >= COLLAPSE_MIN) start = runStart;
      }
    }
  }

  const frames: ItemFrame[] = grown ?? (reusable ? reusable.slice(0, start) : []);
  const dbg = (globalThis as unknown as {__cycRenderDiff?: unknown[]}).__cycRenderDiff;
  if (dbg) {
    dbg.push({
      items: winItems.length,
      from,
      had: reusable?.length ?? -1,
      start,
      a: reusable?.[start]?.sig?.slice(0, 90) ?? null,
      b: sigs[start]?.slice(0, 90) ?? null
    });
  }

  // Wrappers the dropped rows leave behind. The ones the rebuilt tail does
  // not move back into are pruned once the tail is painted.
  const emptied: HTMLElement[] = [];
  // The wrappers of the first rebuilt item, kept in place so the row painted
  // there again (a growing reply closing out) lands in the same group and
  // day section rather than a fresh pair.
  const spare = reusable?.[start];
  // The dropped rows themselves, by row id: a row rebuilt for the same
  // message (a status edge, the engine's adopted timestamp) carries its
  // still-loaded <img> elements over from here, so the picture never blanks
  // and reloads for a repaint that did not change it.
  const dropped = new Map<string, HTMLElement>();
  if (reusable) {
    for (let i = start; i < reusable.length; i++) {
      const f = reusable[i];
      const mid = f?.node.dataset.mid;
      if (mid && !dropped.has(mid)) dropped.set(mid, f!.node);
    }
  }
  if (!frames.length) {
    inner.textContent = '';
  } else {
    for (let i = reusable!.length - 1; i >= start; i--) {
      const f = reusable![i];
      if (!f) continue;
      f.node.remove();
      if (f.group) emptied.push(f.group);
      if (f.dateGroup) emptied.push(f.dateGroup);
    }
  }

  // No manual "Earlier messages" pill (fix-msgwindow, shape 1). Reaching the top
  // of the rendered window auto-extends it (historyPager -> extendMessageWindow,
  // scroll position preserved by the render bracket) and pulls older store pages
  // in on its own; a click-to-load pill is the non-WhatsApp behavior the owner
  // hit. Any pill a prior build left in the DOM is swept here.
  inner.querySelector<HTMLElement>(':scope > .cyc-earlier')?.remove();

  let bi = frames.length - 1;
  while (bi > 0 && frames[bi] === undefined) bi--;
  const base = frames.length ? (frames[bi] ?? null) : null;
  let dayKey = base?.dayKey ?? '';
  let dateGroup: HTMLElement | null = base?.dateGroup ?? null;
  let group: HTMLDivElement | null = base?.group ?? null;
  let prevRole: string | null = base?.prevRole ?? null;

  let prevQueued = base?.prevQueued ?? (from > 0 ? !!items[from - 1].m?.queued : false);

  const onlyChip = (section: HTMLElement) => section.childElementCount <= 1;

  // The one row this paint's "first queued" banner belongs on: the first
  // message that opens a queued run sitting ahead of the agent (past the last
  // claude row). Mirrors the stamp condition in the build loop so the reuse
  // sweep and the build agree on the single row that may carry it.
  let firstQueuedMid: string | undefined;
  {
    let pq = from > 0 ? !!items[from - 1].m?.queued : false;
    for (const it of winItems) {
      const m = it.m;
      if (!m) continue;
      if (m.queued && !pq && it.mi! > lastClaudeMi) {
        firstQueuedMid = m.id;
        break;
      }
      pq = !!m.queued;
    }
  }

  // Sweep the rows the walk reused verbatim: strip an unread or queued stamp off
  // any that is not this paint's anchor, and off a second row that duplicates
  // the anchor id. The freshly built tail below is stamped correctly; seeding
  // these flags from the kept rows keeps the build from adding a second banner
  // when the anchor already carries one.
  let unreadStamped = false;
  let queuedStamped = false;
  for (let j = 0; j < start; j++) {
    const f = frames[j];
    if (!f) continue;
    const node = f.node;
    const mid = node.dataset.mid ?? '';
    if (node.dataset.cycUnread !== undefined) {
      if (!unreadStamped && firstUnreadId !== undefined && mid === firstUnreadId)
        unreadStamped = true;
      else stripUnreadStamp(node);
    }
    if (node.classList.contains('cyc-first-queued')) {
      if (!queuedStamped && firstQueuedMid !== undefined && mid === firstQueuedMid)
        queuedStamped = true;
      else stripQueuedStamp(node);
    }
  }

  for (let i = frames.length; i < winItems.length; i++) {
    const it = winItems[i];
    const from = i;
    const key = new Date(it.ts).toDateString();
    if (key !== dayKey) {
      dayKey = key;
      if (spare?.dateGroup?.isConnected && spare.dayKey === key && onlyChip(spare.dateGroup)) {
        dateGroup = spare.dateGroup;
      } else {
        dateGroup = h('section', 'cyc-date-group relative');
        const label = dayLabel(it.ts);
        dateGroup.append(dateMessage(label));
        inner.append(dateGroup);
      }
      group = null;
      prevRole = null;
    }

    if (it.ev) {
      let node: HTMLElement;
      let isFold = false;

      // A maximal run of consecutive session events within this same day (any
      // mix of VISIBLE_EVENT kinds; a message item breaks it because the outer
      // loop advances per item). At or above COLLAPSE_MIN the whole run folds
      // into one expandable head; below it, fall through to today's behavior
      // (the short tool burst still groups via sessionEventRunMessages, a lone
      // event stays a single pill).
      let runEnd = i;
      while (
        runEnd + 1 < winItems.length &&
        winItems[runEnd + 1].ev &&
        new Date(winItems[runEnd + 1].ts).toDateString() === key
      )
        runEnd++;

      if (runEnd - i + 1 >= COLLAPSE_MIN) {
        const events: CycSessionEvent[] = [];
        for (let k = i; k <= runEnd; k++) events.push(winItems[k].ev!);
        node = sessionEventFoldMessages(events);
        isFold = true;
        i = runEnd;
      } else if (it.ev.kind === 'tool') {
        const run: CycSessionEvent[] = [it.ev];
        while (
          i + 1 < winItems.length &&
          winItems[i + 1].ev?.kind === 'tool' &&
          new Date(winItems[i + 1].ts).toDateString() === key
        ) {
          run.push(winItems[++i].ev!);
        }

        let interrupt: CycSessionEvent | undefined;
        if (
          i + 1 < winItems.length &&
          winItems[i + 1].ev?.kind === 'interrupt' &&
          new Date(winItems[i + 1].ts).toDateString() === key
        ) {
          interrupt = winItems[++i].ev!;
        }
        node =
          run.length > 1
            ? sessionEventRunMessages(run, interrupt)
            : sessionEventMessage(run[0], interrupt);
      } else {
        node = sessionEventMessage(it.ev);
      }
      (group ?? dateGroup!).append(node);
      frames.push({
        sig: sigs[from],
        sigs: sigs.slice(from, i + 1),
        node,
        dayKey,
        dateGroup,
        group,
        prevRole,
        prevQueued,
        consumed: i - from,
        se: true,
        fold: isFold
      });

      for (let k = from + 1; k <= i; k++) frames.push(undefined as unknown as ItemFrame);
      continue;
    }

    const m = it.m!;
    const first = m.role !== prevRole;
    const next = msgs[it.mi! + 1];
    const last = !next || next.role !== m.role || new Date(next.ts).toDateString() !== key;
    if (first) {
      if (
        spare?.group?.isConnected &&
        spare.group.parentElement === dateGroup &&
        !spare.group.childElementCount
      ) {
        group = spare.group;
      } else {
        group = h('div', 'cyc-message-group relative');
        dateGroup!.append(group);
      }
    }
    const hasAudio = !!(m as CycMessage & {msgId?: string}).msgId;

    const attached = uploadsOf(m);
    const messageNode =
      attached.length > 1 || (attached.length === 1 && isAudioUpload(attached[0]))
        ? attachmentMessage(m, first, last, (u) => uploadUrlOf?.(m, u) ?? '', onOpenUpload)
        : m.upload
          ? uploadMessage(m, first, last, uploadSrc?.(m) ?? '', onOpenUpload)
          : m.file?.fileKind === 'image'
            ? photoMessage(m, first, last, fileSrc?.(m) ?? '', m.file.name, onOpenFile, {
                width: m.file.width,
                height: m.file.height
              })
            : m.file?.inline && m.file.content !== undefined
              ? snippetMessage(m, first, last, onOpenFile)
              : m.file?.fileKind === 'binary'
                ? downloadMessage(m, first, last, onOpenFile)
                : m.file
                  ? fileMessage(m, first, last, onOpenFile)
                  : m.kind === 'voice' || (m.role === 'claude' && hasAudio)
                    ? audioMessage(
                        m,
                        first,
                        last,
                        onPlay,
                        onSeek,
                        winItems.length - i <= EAGER_TAIL
                      )
                    : textMessage(m, first, last, onPlay);
    messageNode.dataset.mid = m.id;
    // The message's ts rides the node for DISPLAY only (a stamp label); the one
    // durable id in data-mid is what every user action resolves the bubble by.
    messageNode.dataset.ts = String(m.ts);
    carryStillImages(dropped.get(messageNode.dataset.mid), messageNode);
    paintAttachmentSend(messageNode, m, attached.length > 0 || !!m.upload);
    if (m.id === firstUnreadId && !unreadStamped) {
      markUnreadLanding(messageNode);
      messageNode.classList.add('max-tab:!max-w-none');
      messageNode.prepend(unreadBannerEl());
      unreadStamped = true;
    }

    if (m.queued && !prevQueued && it.mi! > lastClaudeMi && !queuedStamped) {
      messageNode.classList.add('cyc-first-queued');
      messageNode.prepend(
        queuedBannerEl(
          'Queued for ' + (s.agentName ?? DEFAULT_AGENT_NAME) + (s.model ? ' · ' + s.model : '')
        )
      );
      queuedStamped = true;
    }
    prevQueued = !!m.queued;
    group!.append(messageNode);

    prevRole = m.role;
    frames.push({
      sig: sigs[from],
      sigs: [sigs[from]],
      node: messageNode,
      dayKey,
      dateGroup,
      group,
      prevRole,
      prevQueued,
      consumed: 0,
      last
    });
  }

  for (const w of emptied) {
    if (!w.isConnected) continue;
    if (w.classList.contains('cyc-date-group') ? onlyChip(w) : !w.childElementCount) w.remove();
  }

  // A pending bubble's per-chunk transfer progress repaints in place: the
  // percentage is not in the row's signature (only its presence is), so the
  // kept node, and with it the photo's decoded <img>, survives every chunk;
  // the one thing that moves is the counter's text.
  for (let j = 0; j < start; j++) {
    const f = frames[j];
    const m = f ? winItems[j]?.m : undefined;
    if (!m || m.status !== 'sending' || typeof m.sendPct !== 'number') continue;
    // The label span, never the whole node: the progress line is a button
    // carrying the cancel X beside the text, and the X must survive the tick.
    const prog = f!.node.querySelector('.cyc-send-progress-text');
    if (!prog) continue;
    const text = sendProgressText(m.sendPct);
    if (prog.textContent !== text) prog.textContent = text;
  }

  // The kept row nearest the tail was painted as its group's last row (or
  // not) against the messages of that time. A neighbour that arrived below
  // it, or left, flips that in place; the row itself is never rebuilt for it.
  for (let j = start - 1; j >= 0; j--) {
    const f = frames[j];
    if (!f || f.last === undefined) continue;
    const it = winItems[j];
    const m = it.m!;
    const next = msgs[it.mi! + 1];
    const last = !next || next.role !== m.role || new Date(next.ts).toDateString() !== f.dayKey;
    if (last !== f.last) {
      setMessageLast(f.node, last);
      f.last = last;
    }
    break;
  }

  renderStates.set(inner, {sessionId: s.id, frames, from, count: items.length, starts});
}

/** A date chip whose box overlaps the unread divider carries this; the chip
 * utilities turn it into `visibility: hidden` (layout kept, paint gone). */
export const DATE_CHIP_VEILED = 'cyc-date-veiled';

/**
 * Date chips use CSS `position: sticky` on the real node. The one case CSS
 * cannot settle on its own is the stuck chip meeting the "Unread Messages"
 * divider: both sit at z-2 and the chip, later in paint order, painted over
 * the divider's text. This veils any chip whose box overlaps the divider,
 * on every scroll frame and after every render, and lifts the veil as soon
 * as they part. Without a divider in the list there is nothing to do.
 */
export function attachStickyDates(
  messageListEl: HTMLElement,
  scrollable: HTMLElement
): {refresh: () => void; destroy: () => void} {
  const veiled = new Set<HTMLElement>();
  let frame = 0;

  const unveil = () => {
    for (const chip of veiled) chip.classList.remove(DATE_CHIP_VEILED);
    veiled.clear();
  };

  const refresh = () => {
    const divider = messageListEl.querySelector<HTMLElement>('.cyc-msg-unread');
    if (!divider) return unveil();
    const d = divider.getBoundingClientRect();
    for (const chip of veiled) if (!chip.isConnected) veiled.delete(chip);
    for (const chip of messageListEl.querySelectorAll<HTMLElement>('.cyc-date-chip')) {
      const c = chip.getBoundingClientRect();
      const hit = c.top < d.bottom && d.top < c.bottom && c.left < d.right && d.left < c.right;
      if (hit === veiled.has(chip)) continue;
      chip.classList.toggle(DATE_CHIP_VEILED, hit);
      if (hit) veiled.add(chip);
      else veiled.delete(chip);
    }
  };

  const onScroll = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  };
  scrollable.addEventListener('scroll', onScroll, {passive: true});

  return {
    refresh,
    destroy() {
      scrollable.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      unveil();
    }
  };
}
