import type {CycMessage, CycSession, CycSessionEvent} from '@/types';
import {RENDERABLE_EVENT_KINDS} from '@/engine/store/rows/core';
import {
  Virtualizer,
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect
} from '@tanstack/virtual-core';

import {h} from '@/components/domHelpers';
import {markMachineTop, isMachineTop, logScrollWrite} from './machineScroll';
import {syncedAt} from '@/engine/sync';
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
  // The row-cache key this node was built under (see the detached-node LRU on
  // RenderState). A row leaving the window is stashed under this key so the
  // same row (same content, same group edges) re-entering re-attaches its
  // decoded node instead of rebuilding it. Absent on date rows (cheap to make).
  cacheKey?: string;
};

// One merged transcript entry: a message or a session event, at its ts. The
// row model and the paint loop both walk lists of these.
type RowItem = {m?: CycMessage; ev?: CycSessionEvent; ts: number};

// One RENDER-VISIBLE row in the virtual list. The renderer collapses a run of
// session events into a single row (a fold head, a tool run, or a lone pill),
// paints each message as its own row, and opens each day with a date-chip row.
// `itemFrom`/`itemTo` are the inclusive span of merged items the row covers; a
// date row owns no items (itemTo < itemFrom) and simply marks the day boundary
// that sits before item `itemFrom`.
type RowKind = 'date' | 'msg' | 'event';
type RowDesc = {
  key: string;
  kind: RowKind;
  itemFrom: number;
  itemTo: number;
  estimate: number;
};

type MsgVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

type RenderState = {
  sessionId: string;
  frames: ItemFrame[];
  // The item slice [fromItem..toItem] the current DOM window covers. Reuse of
  // the built rows only applies when fromItem is unchanged (a data change at or
  // below the window top); a scroll that slides the window rebuilds it.
  fromItem: number;
  toItem: number;
  count: number;
  rows: RowDesc[];
  virt: MsgVirtualizer | null;
  cleanup: (() => void) | null;
  opts: Record<string, unknown> | null;
  // Re-run the last paint verbatim (a pure re-window: scroll, resize, or a late
  // measurement moved the visible range, with no store change behind it).
  lastPaint: (() => void) | null;
  scheduled: boolean;
  // True while a synchronous re-window is in flight, so the measurement
  // notifications that paint itself triggers do not re-enter it.
  painting: boolean;
  // Set when a measurement notification was swallowed during a paint (a row
  // measured away from its estimate). A standalone paint reads it after its
  // measure loop to schedule a single async converge re-window.
  measuredDirty: boolean;
  // Set for one paint to force a from-scratch window rebuild, bypassing the
  // incremental edge reconcile. The coverage net (below) sets it when an
  // incremental re-window left the viewport uncovered (a rare window collapse
  // under load); a full rebuild recomputes the window and recovers, so the
  // blank never reaches the compositor.
  forceFull: boolean;
  // The item key at index 0 on the previous sync. When it changes the list grew
  // (or trimmed) at the FRONT -- older history prepended -- so every index now
  // maps to a different message. The virtualizer keys its measured sizes by key
  // but rebuilds its offset cache only from `pendingMin` onward; a measurement
  // left pending from the previous paint would keep stale offsets for the
  // now-shifted rows, so the window lands on the wrong rows and meets an
  // unmounted row (the row-shift/unmount-while-older-loads bug, and the failed
  // jump to an old message). The virtualizer resets this itself only for
  // anchorTo:"end"; this list anchors "start", so syncGeom forces the rebuild.
  // A same-day prepend keeps the head DATE row at index 0 while shifting the
  // messages below it, so the row count is tracked alongside the head key: any
  // count change (prepend, append, trim) or head-key change (chat switch, front
  // trim) rebuilds; a pure re-window (scroll, measurement settle) changes
  // neither and keeps the fast incremental path.
  lastHeadKey: string | number | null;
  lastRowCount: number;
  // The item key at index 1 on the previous sync. With the head key it proves the
  // FRONT of the list is stable across a count change: a new-day prepend changes
  // index 0, a same-day prepend inserts older rows right after the head date row
  // and changes index 1 (R10, R11), a front trim changes index 0. When both keys
  // are unchanged the change is at the tail or middle, which reindexes no front
  // row, so syncGeom skips the from-index-0 offset-cache rebuild (prepend safety);
  // a prepend or a front trim still rebuilds.
  lastSecondKey: string | number | null;
  // The scroll offset this list last committed a window at, plus a flag set only
  // for the duration of a LIVE scroll re-window (the sync fling path). Together
  // they gate the selection hold: a paint holds the current window (touching no
  // row) while a selection is live UNLESS it is a live scroll that actually
  // moved the offset -- that one alone re-windows so the list is never frozen
  // under the reader's own scroll. A store change, a prepend's follow-up, a
  // settle, and a spurious same-offset range notification all hold.
  lastScrollTop: number;
  syncScroll: boolean;
  // Re-measure compensation banked while the reader drives, in px. Instead of
  // writing scrollTop under a finger or live momentum (which breaks iOS momentum
  // and leaps: the upward-jitter report), the re-window absorbs the delta in the
  // TOP SPACER, so the rows on screen hold still with the offset untouched. The
  // DOM then sits `bank` px above the virtualizer's model (DOM = model - bank),
  // so the window math reads the model offset as scrollTop + bank. The first
  // re-window after the reader lets go releases it in a single owner write.
  bank: number;
  // Wired by the render hub: after a scroll-driven re-window, re-run the DOM
  // sweeps (waveform hydration, sticky dates, play state) over the freshly
  // mounted rows so a row scrolled into view hydrates like a store paint.
  onWindowChange: (() => void) | null;
  // True ONLY while the open landing is actively holding the unread divider on
  // screen (chatSurface.holdDivider). anchoredRewindow anchors on the divider
  // instead of the topmost visible row ONLY during this window; once the hold
  // ends (the reader's first interaction, or the bounded timeout), it reverts to
  // the topmost-row anchor. Without this gate the divider anchor re-seated the
  // view toward the divider on EVERY re-window while the marker stayed mounted --
  // long after the landing -- so a store repaint (a push catchup) or the reader's
  // own scroll got clawed back toward the divider: the owner's "can't scroll up
  // or down until I leave the chat" freeze. Wired by chatSurface.
  dividerHeld: (() => boolean) | null;
  // A bounded LRU of DETACHED row nodes, keyed by row identity + content
  // version (rowCacheKey). A scroll that slides the window drops the rows
  // leaving it into here and re-attaches the rows entering it from here, so a
  // fast fling re-attaches decoded bubbles instead of rebuilding them from
  // scratch (markdown parse, syntax paint) on every scroll event -- the
  // measured scroll jank. Bounded so the detached set cannot grow without
  // limit; entries are the row node only, never in the document (they do not
  // count against the in-document node budget).
  nodeCache: Map<string, HTMLElement>;
};

const renderStates = new WeakMap<HTMLElement, RenderState>();

// Rough per-row heights the virtualizer starts from; measureElement replaces
// each with the real box as the row mounts. Only OFF-window rows keep an
// estimate, so a wrong guess costs at most a little scroll drift, corrected as
// the reader arrives.
const EST_DATE = 40;
// The message estimate sat well under the real rows the owner's chats draw (a
// wrapped bubble measures ~1.3x this on the narrow layouts); the whole
// estimated block above the fold then under-counted and every scroll correction
// had a large delta to walk off. A closer guess shrinks that delta. The scroll
// fixes below stay correct under ANY estimate error (they settle against the
// measured boxes), so this is an accuracy nicety, not the fix.
const EST_MSG = 96;
const EST_EVENT = 30;
// A small item-count overscan for the virtualizer's own range; the real depth
// of the DOM window is the pixel band below, expanded onto this base.
const MSG_OVERSCAN = 1;

// Pixel overscan: the DOM window keeps rows painted this many viewport-heights
// beyond the visible band on each side. A fast fling scrolls compositor-side
// ahead of the main-thread re-window, so without a band deep enough to cover
// the frames it races past, the viewport meets unmounted space and paints blank.
// One viewport each side (a three-viewport painted region) covers a 15,000 px/s
// fling while holding the node count well under budget.
const OVERSCAN_VIEWPORTS = 2;

// The detached row-node LRU is bounded to this many nodes. A phone window plus
// its overscan band holds a few dozen rows; a few hundred cached nodes cover
// several viewports of fling in both directions without the detached set
// growing without limit. On overflow the oldest entry is dropped (its node is
// unreferenced and collected); a dropped row simply rebuilds if it returns.
const ROW_CACHE_MAX = 400;

// The cache key for a row: its stable identity (the render-row key: `m|<id>`,
// `e|<evKey>|<kind>`) joined with a content version, so a cached node is only
// re-attached when it would be byte-identical to a fresh build. The version
// folds the row's signature(s) -- which already carry the unread-anchor mark
// and every content/status field (itemSig) -- plus the group edges the node's
// own styling bakes in (`first`/`last`) and the first-queued banner, none of
// which live in the signature. A mismatch on any of these misses the cache and
// rebuilds, so a reused node never wears a stale banner or group edge.
function rowCacheKey(identity: string, version: string): string {
  return identity + '\u0000' + version;
}

// Take a detached node for `key`, removing it so the cache only ever holds
// nodes that are NOT in the document (no node is attached in two places).
function takeCachedRow(st: RenderState, key: string): HTMLElement | undefined {
  const node = st.nodeCache.get(key);
  if (node) st.nodeCache.delete(key);
  return node;
}

// Stash a detached node under `key`. Re-inserting moves it to the most-recent
// end; on overflow the least-recent entry (the first key) is evicted.
function cacheRow(st: RenderState, key: string, node: HTMLElement): void {
  st.nodeCache.delete(key);
  st.nodeCache.set(key, node);
  while (st.nodeCache.size > ROW_CACHE_MAX) {
    const oldest = st.nodeCache.keys().next().value;
    if (oldest === undefined) break;
    st.nodeCache.delete(oldest);
  }
}

const raf: (cb: () => void) => void =
  typeof requestAnimationFrame !== 'undefined'
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => setTimeout(cb, 0);

function evKey(ev: CycSessionEvent): string {
  return (ev as {uuid?: string}).uuid ?? String(ev.ts);
}

// The full render-row model over the merged item list, grouped EXACTLY as the
// paint loop groups: a maximal same-day run of >= COLLAPSE_MIN events folds to
// one row; a shorter same-day tool run (+ optional trailing interrupt) is one
// row; any other lone event is one pill row; each message is one row; each day
// opens with a date row. `rowOfItem[g]` is the model-row index a merged item
// belongs to (its first item for multi-item event rows); `dateRowOfDay` maps a
// day string to its date-row index.
function buildRowModel(items: RowItem[]): {
  rows: RowDesc[];
  rowOfItem: number[];
  dateRowOfDay: Map<string, number>;
} {
  const n = items.length;
  const day = new Array<string>(n);
  for (let k = 0; k < n; k++) day[k] = new Date(items[k].ts).toDateString();
  const rows: RowDesc[] = [];
  const rowOfItem = new Array<number>(n);
  const dateRowOfDay = new Map<string, number>();
  let i = 0;
  let curDay = '';
  while (i < n) {
    if (day[i] !== curDay) {
      curDay = day[i];
      dateRowOfDay.set(curDay, rows.length);
      rows.push({key: 'd|' + curDay, kind: 'date', itemFrom: i, itemTo: i - 1, estimate: EST_DATE});
    }
    const it = items[i];
    if (it.ev) {
      let runEnd = i;
      while (runEnd + 1 < n && items[runEnd + 1].ev && day[runEnd + 1] === curDay) runEnd++;
      if (runEnd - i + 1 >= COLLAPSE_MIN) {
        const ri = rows.length;
        rows.push({key: 'e|' + evKey(it.ev) + '|f', kind: 'event', itemFrom: i, itemTo: runEnd, estimate: EST_EVENT});
        for (let k = i; k <= runEnd; k++) rowOfItem[k] = ri;
        i = runEnd + 1;
        continue;
      }
      if (it.ev.kind === 'tool') {
        let j = i;
        while (j + 1 < n && items[j + 1].ev?.kind === 'tool' && day[j + 1] === curDay) j++;
        if (j + 1 < n && items[j + 1].ev?.kind === 'interrupt' && day[j + 1] === curDay) j++;
        const ri = rows.length;
        rows.push({key: 'e|' + evKey(it.ev) + '|r', kind: 'event', itemFrom: i, itemTo: j, estimate: EST_EVENT});
        for (let k = i; k <= j; k++) rowOfItem[k] = ri;
        i = j + 1;
        continue;
      }
      rowOfItem[i] = rows.length;
      rows.push({key: 'e|' + evKey(it.ev) + '|p', kind: 'event', itemFrom: i, itemTo: i, estimate: EST_EVENT});
      i += 1;
      continue;
    }
    rowOfItem[i] = rows.length;
    rows.push({key: 'm|' + it.m!.id, kind: 'msg', itemFrom: i, itemTo: i, estimate: EST_MSG});
    i += 1;
  }
  return {rows, rowOfItem, dateRowOfDay};
}

// The scroll box the list lives in, or null when the list is painted detached
// (unit tests, a not-yet-mounted surface). No scroll box means no viewport to
// bound the DOM to, so the paint falls back to rendering every row.
function scrollBoxOf(inner: HTMLElement): HTMLElement | null {
  return inner.closest<HTMLElement>('.cyc-message-list-scroll');
}

// The persistent virtualizer for a list node. It owns the geometry (viewport
// rect, scroll offset, measured row heights) and the visible-range math; the
// paint below reads getVirtualItems()/getTotalSize() from it. It observes the
// scroll box for scroll/resize and re-measures mounted rows, and on any range
// change re-runs the last paint (a pure re-window) so scrolling reveals rows.
function ensureVirt(inner: HTMLElement, st: RenderState): MsgVirtualizer {
  if (st.virt) return st.virt;
  const opts: Record<string, unknown> = {
    count: 0,
    getScrollElement: () => scrollBoxOf(inner),
    estimateSize: (i: number) => st.rows[i]?.estimate ?? EST_MSG,
    getItemKey: (i: number) => st.rows[i]?.key ?? i,
    overscan: MSG_OVERSCAN,
    indexAttribute: 'data-index',
    observeElementRect,
    observeElementOffset,
    // Keep the estimate for a row that measures as zero height (a not-yet
    // laid-out or display:none row, and every row under jsdom); caching 0 would
    // collapse the list's offsets and defeat the window bound.
    measureElement: (el: HTMLElement, entry: ResizeObserverEntry | undefined, instance: MsgVirtualizer) => {
      const size = measureElement(el, entry, instance);
      if (size > 0) return size;
      const idx = instance.indexFromElement(el);
      return (idx >= 0 && st.rows[idx]?.estimate) || EST_MSG;
    },
    scrollToFn: (offset: number, o: {adjustments?: number; behavior?: ScrollBehavior}, instance: MsgVirtualizer) => {
      const box = scrollBoxOf(inner);
      const from = box?.scrollTop ?? 0;
      elementScroll(offset, o, instance);
      if (box) {
        logScrollWrite(box, 'virtual.scrollTo', from, box.scrollTop);
        markMachineTop(box);
      }
    },
    // sync is the virtualizer's isScrolling flag: true when the change came from
    // an active scroll, false for a measurement settle or the scroll-end tick.
    onChange: (_v: MsgVirtualizer, sync: boolean) => scheduleRepaint(inner, st, sync)
  };
  const v = new Virtualizer(opts as never) as unknown as MsgVirtualizer;
  st.opts = opts;
  st.cleanup = v._didMount();
  v._willUpdate();
  st.virt = v;
  // The virtualizer's own on-resize scroll correction writes the scroll box
  // mid-measure, BEFORE this paint's spacer heights catch up, so a row above
  // the fold measuring taller than its estimate shoved the visible content for
  // one frame (the row-shift-while-older-loads bug). Turn that off and hold the
  // anchor ourselves in anchoredRewindow, where the scrollTop move and the
  // fresh spacer heights land together in one synchronous re-window.
  (v as unknown as {shouldAdjustScrollPositionOnItemSizeChange?: () => boolean})
    .shouldAdjustScrollPositionOnItemSizeChange = () => false;
  return v;
}

// Re-window after a range change. A scroll-driven change (sync) re-windows
// SYNCHRONOUSLY inside the scroll event, so the DOM window tracks the native
// scroll position in the same frame the browser is about to paint; deferring it
// to rAF let a fast fling paint one or more blank frames before the window
// caught up (measured: 9 blank frames at 15,000 px/s on the phone even with a
// two-viewport overscan, versus 0 when it re-windows in the event). Everything
// else (a measurement settle, the scroll-end tick) re-windows on rAF as before.
//
// Re-windows on every scroll event, synchronously, so the DOM window tracks the
// native scroll position in the frame the browser is about to paint even under
// load. A fling scrolls compositor-side ahead of the main thread; deferring or
// throttling the re-window lets it outrun the window and paint blank, so it
// runs per event. Each re-window is cheap now (the reconcile keeps the overlap
// and only touches the edge rows), so running it per event no longer costs the
// full-window rebuild that made the branch janky. The painting guard swallows
// the measurement notifications a paint (its own re-window, or a store paint's)
// raises so it cannot re-enter; the swallowed notification is remembered
// (measuredDirty) so the paint can converge it once, asynchronously.
function scheduleRepaint(inner: HTMLElement, st: RenderState, sync = false): void {
  // A notification raised while a paint is in flight: never re-enter (a nested
  // synchronous re-window would run against a half-updated window and undo the
  // caller's anchor hold -- the row-shift-while-older-loads bug when a store
  // prepend paints mid-scroll). Record that a size changed so the paint's
  // measure loop can schedule a single async converge, then bail.
  if (st.painting) {
    st.measuredDirty = true;
    return;
  }
  if (sync) {
    if (st.scheduled) return;
    // A sync re-window driven by a MACHINE scroll (the front-prepend re-seat,
    // the render bracket, an open landing) is not the reader scrolling, so it
    // stays hold-eligible while a selection is live; only a genuine reader
    // scroll (the offset is not the last machine write) exempts the hold.
    const sbox = scrollBoxOf(inner);
    st.painting = true;
    st.syncScroll = !sbox || !isMachineTop(sbox, sbox.scrollTop);
    try {
      anchoredRewindow(inner, st);
      recoverIfUncovered(inner, st);
      st.onWindowChange?.();
    } finally {
      st.painting = false;
      st.syncScroll = false;
    }
    return;
  }
  if (st.scheduled) return;
  st.scheduled = true;
  raf(() => {
    st.scheduled = false;
    anchoredRewindow(inner, st);
    recoverIfUncovered(inner, st);
    st.onWindowChange?.();
  });
}

// Safety net for the incremental reconcile. A window can rarely collapse under
// load (a stale row measurement shrinks the virtualizer's visible range, and
// the incremental path builds on the shrunken previous frames instead of
// recovering), leaving the viewport past the mounted rows -- a blank frame.
// Detect it cheaply from the spacer geometry (no per-row layout) and, when the
// viewport is not fully inside the mounted band, force ONE from-scratch rebuild
// which recomputes the window and covers the viewport. A full rebuild always
// covers, so this runs at most once and the blank never reaches the compositor.
function recoverIfUncovered(inner: HTMLElement, st: RenderState): void {
  const box = scrollBoxOf(inner);
  if (!box || !box.clientHeight || !st.lastPaint) return;
  const padTop = parseFloat(inner.style.paddingTop) || 0;
  const padBottom = parseFloat(inner.style.paddingBottom) || 0;
  const contentBottom = box.scrollHeight - padBottom;
  const EPS = 4;
  const uncovered =
    box.scrollTop < padTop - EPS || box.scrollTop + box.clientHeight > contentBottom + EPS;
  if (!uncovered) return;
  st.forceFull = true;
  anchoredRewindow(inner, st);
}

// The distance to the end (px) at or under which the list counts as sitting at
// the bottom, so a re-window follows the end rather than holding a top anchor.
const BOTTOM_PIN_PX = 2;

// The ScrollOwner's side of the re-window (wired by chatSurface through
// setMessageScrollOwner). `driving`: a reader owns the offset right now, so the
// re-window writes nothing and banks its correction in the top spacer.
// `pinned`: the reader sits at the end, so a re-window keeps the end. `write`:
// the owner's single tagged, machine-marked scrollTop write.
export interface MessageScrollOwner {
  driving(): boolean;
  pinned(): boolean;
  write(top: number, tag: string): void;
}

// The ScrollOwner (chatSurface) for a list: the ONE writer of its scroll box's
// scrollTop. Absent for a detached mount or a unit test, where the re-window
// writes inline as before. Keyed by the list node, set once at surface creation.
const scrollOwners = new WeakMap<HTMLElement, MessageScrollOwner>();

function ownerWrite(inner: HTMLElement, box: HTMLElement, top: number, tag: string): void {
  const owner = scrollOwners.get(inner);
  if (owner) {
    owner.write(top, tag);
    return;
  }
  const from = box.scrollTop;
  box.scrollTop = top;
  logScrollWrite(box, tag, from, box.scrollTop);
  markMachineTop(box);
}

// Absorb a re-measure delta in the top spacer instead of scrollTop (the reader
// is driving). The spacer cannot go below zero, so at the very top of the list
// only what fits is banked; the rest shows as a shift, never as a write.
function bankDelta(inner: HTMLElement, st: RenderState, delta: number): void {
  const pad = parseFloat(inner.style.paddingTop) || 0;
  const take = Math.min(delta, pad);
  if (Math.abs(take) <= 0.5) return;
  inner.style.paddingTop = pad - take + 'px';
  st.bank += take;
}

// The reader let go: hand the banked compensation back to scrollTop in ONE
// owner write. The spacer returns to its model height and the offset moves by
// the same amount, so nothing on screen moves and the window that follows is
// computed at the same model offset the reader was looking at.
function releaseBank(inner: HTMLElement, st: RenderState, box: HTMLElement): void {
  const pad = parseFloat(inner.style.paddingTop) || 0;
  const top = box.scrollTop + st.bank;
  inner.style.paddingTop = pad + st.bank + 'px';
  st.bank = 0;
  ownerWrite(inner, box, top, 'rewindow.settle');
}

// A pure re-window (a scroll, or a late measurement) recomputes the spacer
// heights from freshly measured rows. When rows above the fold measure away
// from their estimate that changes their offset, and without this the visible
// content would jump by that delta (the row-shift-while-older-loads bug, which
// lands on the ASYNC re-window after the bracket has already returned).
//
// Sitting at the bottom is the one case where holding a TOP anchor is wrong:
// rows above the fold growing would drag the view up off the end, so there we
// follow the (possibly grown) end instead -- which is also what lets go-to
// bottom settle at distance <= 1 as its tail measures. Otherwise hold the
// topmost row meeting the viewport top: note its on-screen offset before the
// re-window, then after re-seat the box so the SAME row keeps that offset. The
// reference is the live scrollTop, so a reader's own scroll (already on the
// box) is preserved, not undone -- scrollTop only moves when a measurement
// shifted an offset. Under jsdom every rect is zero, so no anchor is found and
// this is a plain re-window (existing window tests are unaffected).
//
// The scrollTop write belongs to the ScrollOwner (setMessageScrollOwner).
// While a reader drives, NOTHING is written: the end is not followed (the
// reader may be leaving it) and the anchor correction is banked in the top
// spacer, so the row under the finger holds still with no programmatic scroll. The first
// re-window after the reader lets go (the virtualizer's scroll-end tick, or the
// owner's settle on release) releases the bank in one write (releaseBank), then
// holds the anchor or follows the end as usual.
function anchoredRewindow(inner: HTMLElement, st: RenderState): void {
  const box = scrollBoxOf(inner);
  if (!box || !box.clientHeight || !st.lastPaint) {
    st.lastPaint?.();
    return;
  }
  const owner = scrollOwners.get(inner);
  const driving = !!owner && owner.driving();
  if (!driving && st.bank !== 0) releaseBank(inner, st, box);
  const atBottom =
    !driving &&
    (box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_PIN_PX ||
      (!!owner && owner.pinned()));
  const boxTop = box.getBoundingClientRect().top;
  let anchorIndex: string | null = null;
  let anchorByDivider = false;
  let screenOffset = 0;
  if (!atBottom) {
    // While an unread landing is ACTIVELY HOLDING the divider on screen, anchor
    // on the DIVIDER row itself rather than the topmost visible row. Rows ABOVE
    // the divider are only estimated on a fresh open (EST_MSG is far off a
    // wrapped bubble), so when one mounts and measures on a later re-window the
    // whole band above the fold resizes; holding the topmost row then lets the
    // divider (below it) drift off its seat and out of view. The divider's own
    // rows below it are already measured (the open pinned the end first), so
    // holding the divider keeps its seat regardless of what the history above
    // measures to. It is re-found after the paint by its MARKER, not its
    // data-index: a message arriving or older history loading reindexes the
    // model, so the index the divider carried now names a different row
    // (measured: the divider slid out of view while a stale index was held in
    // its place).
    //
    // GATED on the active hold: once the hold ends (the reader's first
    // interaction, or the bounded timeout), the divider marker stays MOUNTED but
    // must no longer capture the anchor -- otherwise every later re-window (a
    // push-catchup repaint, the reader's own scroll) re-seats the view back
    // toward the divider, which the owner felt as a chat that "can't scroll up or
    // down until I leave it" and as go-to-bottom fighting its way to the end.
    // When no hold getter is wired (a detached mount, unit tests driving the
    // landing directly) the state is unknown, so default to anchoring on the
    // divider -- the pre-gate behavior -- which is correct for the landing the
    // getter-less callers exercise; the app always wires the getter (renderHub).
    const holdActive = st.dividerHeld ? st.dividerHeld() : true;
    const divider = holdActive ? inner.querySelector<HTMLElement>('[data-cyc-unread]') : null;
    if (divider) {
      const dr = divider.getBoundingClientRect();
      if (dr.bottom > boxTop && dr.top < boxTop + box.clientHeight) {
        anchorByDivider = true;
        screenOffset = dr.top - boxTop;
      }
    }
    if (!anchorByDivider) {
      for (const row of inner.querySelectorAll<HTMLElement>('[data-index]')) {
        const r = row.getBoundingClientRect();
        if (r.bottom > boxTop) {
          anchorIndex = row.dataset.index ?? null;
          screenOffset = r.top - boxTop;
          break;
        }
      }
    }
  }
  st.lastPaint();
  if (atBottom) {
    const end = box.scrollHeight - box.clientHeight;
    if (end - box.scrollTop > 0.5) ownerWrite(inner, box, end, 'rewindow.bottom');
    return;
  }
  if (!anchorByDivider && anchorIndex === null) return;
  const again = anchorByDivider
    ? inner.querySelector<HTMLElement>('[data-cyc-unread]')
    : inner.querySelector<HTMLElement>(`[data-index="${anchorIndex}"]`);
  if (!again) return;
  const now = again.getBoundingClientRect().top - box.getBoundingClientRect().top;
  const delta = now - screenOffset;
  if (Math.abs(delta) <= 0.5) return;
  if (driving) bankDelta(inner, st, delta);
  else ownerWrite(inner, box, box.scrollTop + delta, 'rewindow.anchor');
}

// The visible render-row range for the current geometry, plus the top/bottom
// spacer heights that stand in for the rows outside it. Returns null when the
// list has no bounded viewport, telling the paint to render every row.
// The scroll box drives the geometry directly: each paint reads the live
// scrollTop and viewport height into the virtualizer, so the window matches the
// native scroll position synchronously (an app scrollTop write, jsdom with no
// scroll events) instead of waiting on the async scroll observer. The observer
// still fires onChange so a reader's own scroll re-windows.
function syncGeom(inner: HTMLElement, st: RenderState, box: HTMLElement): MsgVirtualizer {
  const v = ensureVirt(inner, st);
  st.opts!.count = st.rows.length;
  v.setOptions(st.opts as never);
  // A row-set change (a history prepend, a trim, a chat switch) can shift indices
  // at the front: force the virtualizer to rebuild its offset cache from index 0
  // (by key) so a measurement left pending from the previous paint cannot leave
  // stale offsets for the shifted rows -- the wrong window that meets an unmounted
  // row (the row-shift/unmount-while-older-loads bug and the failed jump to an old
  // message). Bumping the size-cache version re-runs the memoised measurement
  // build. A pure re-window (a scroll, a measurement settle) changes neither the
  // count nor the head, so this is skipped and the fast incremental measurement
  // path stands.
  //
  // The from-0 rebuild is only NEEDED when the FRONT reindexes -- older history
  // prepended at index 0 shifts every row below it, and a measurement left
  // pending would then apply to the wrong row. A change that leaves the FRONT in
  // place (a message appended at the tail, a tail session-event run refolding,
  // an edit) reindexes only rows at/after the change point; those are
  // re-measured on this same paint (they are what the reader at the tail is
  // looking at), while the rows above keep both their index and their measured
  // offset. Rebuilding the whole offset cache from index 0 for such a change is
  // pure cost -- it discards every measured height and re-derives the window from
  // estimates, churning the mounted rows (the measured 47 drawn / 16 removed on
  // an arriving message).
  //
  // "Front stable" is proven by the first TWO row keys: a new-day prepend changes
  // the head date row (key 0); a same-day prepend inserts older messages right
  // after the head date row, changing key 1 (R10, R11); a front trim changes key
  // 0. A tail/middle change leaves both, so it keeps the fast incremental path.
  const headKey = st.rows.length ? st.rows[0].key : null;
  const secondKey = st.rows.length > 1 ? st.rows[1].key : null;
  const frontStable =
    st.lastRowCount > 0 && headKey === st.lastHeadKey && secondKey === st.lastSecondKey;
  if (headKey !== st.lastHeadKey || st.rows.length !== st.lastRowCount) {
    if (!frontStable) {
      const vi = v as unknown as {pendingMin: number | null; itemSizeCacheVersion: number};
      vi.pendingMin = 0;
      vi.itemSizeCacheVersion++;
    }
    st.lastHeadKey = headKey;
    st.lastRowCount = st.rows.length;
    st.lastSecondKey = secondKey;
  }
  v._willUpdate();
  v.scrollRect = {width: box.clientWidth, height: box.clientHeight};
  // The model offset: the DOM sits `bank` px above the model while the reader
  // drives (see RenderState.bank).
  v.scrollOffset = box.scrollTop + st.bank;
  return v;
}

// The stable model key of a mounted frame's row: `m|<id>` for a message row
// (its data-mid), the row identity for a session-event row (the head of its
// cacheKey, before the content-version separator). Used to re-find a mounted
// row after the item list was reindexed by a front prepend. Only message
// anchors are matched against the item list below, so the mid form is enough.
function frameMessageId(f: ItemFrame): string | null {
  return f.node.dataset.mid ?? null;
}

// True when a non-collapsed selection has at least one end inside the list. A
// re-window that rebuilds, moves or re-parents rows (even reusing the SAME node
// out of the detached LRU) detaches the range's container for an instant and
// the browser collapses the selection -- the reader loses their highlight the
// moment older history lands (or a message arrives, or a measurement settles).
// While this holds, a store paint / settle holds the current window verbatim so
// no row is touched; a real user scroll (isScrolling) still re-windows normally.
function selectionInList(inner: HTMLElement): boolean {
  const win = inner.ownerDocument?.defaultView;
  const sel = win?.getSelection?.();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  const a = sel.anchorNode;
  const f = sel.focusNode;
  return !!((a && inner.contains(a)) || (f && inner.contains(f)));
}

// The new item index of the message `id`, searching FORWARD from `from` first
// (older history prepends move a row to a HIGHER index) then the whole list (a
// front trim moves it lower), or -1 if the message is gone.
function findMessageItemIndex(items: RowItem[], id: string, from: number): number {
  for (let i = Math.max(0, from); i < items.length; i++)
    if (items[i].m && items[i].m!.id === id) return i;
  for (let i = 0; i < from && i < items.length; i++)
    if (items[i].m && items[i].m!.id === id) return i;
  return -1;
}

// Older STORE history landed at the FRONT: every loaded row still exists but its
// item index shifted up by the page that arrived. A paint that recomputed its
// window at the (still pre-re-seat) scroll offset landed on the newly-prepended
// older rows and rebuilt the whole visible window -- detaching the row nodes and
// dropping the reader's text selection (3 of 4 rounds), and even when a row
// survived, moving its day section collapsed the range (the 4th). This detects
// the shift by re-finding the topmost mounted MESSAGE row in the reindexed item
// list, then re-seats the scroll box HERE so the window lands on the SAME rows
// the reader is looking at and the edge reconcile keeps every unchanged row in
// place (rows are only added at the top edge and trimmed at the bottom). The
// re-seat rides the virtualizer's measured/estimated offsets (not DOM rects), so
// it holds under jsdom too. The render bracket cannot do this re-seat itself: it
// keys off row.offsetTop, which is measured against the row's positioned GROUP,
// not the scroll content, so a prepend that pushes the whole group down by the
// top spacer leaves offsetTop unchanged and the bracket computes a zero move --
// snapping the view back to the top and re-triggering the full rebuild. The
// bracket now DEFERS to this re-seat (it sees scrollTop already moved).
// Returns the item shift so the caller can hold the previous window (reindexed),
// or 0 when there is nothing to preserve (a fresh open, a chat switch, a tail
// append, a pure scroll, a same-index paint, or a reader sitting at the bottom).
function reseatForFrontShift(
  inner: HTMLElement,
  st: RenderState,
  items: RowItem[],
  rowOfItem: number[],
  prevFrames: ItemFrame[],
  prevFromItem: number,
  sameChat: boolean
): number {
  if (!sameChat || !st.virt || !prevFrames.length) return 0;
  const box = scrollBoxOf(inner);
  if (!box || !box.clientHeight) return 0;
  // At the bottom the list follows the end, never a top anchor (anchoredRewindow);
  // a prepend there keeps its bottom pin rather than re-seating upward.
  if (box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_PIN_PX) return 0;
  // Anchor on the first mounted message row (a session-event head has no stable
  // per-item id to match, and the reader's selection lives in a message anyway).
  let ap = 0;
  while (ap < prevFrames.length && !(prevFrames[ap] && frameMessageId(prevFrames[ap]))) ap++;
  const anchor = prevFrames[ap];
  if (!anchor || !anchor.node.isConnected) return 0;
  const id = frameMessageId(anchor)!;
  const anchorOldItem = prevFromItem + ap;
  const newPos = findMessageItemIndex(items, id, anchorOldItem);
  if (newPos < 0) return 0;
  const shift = newPos - anchorOldItem;
  if (shift === 0) return 0;
  const v = st.virt;
  const oldMeas = v.measurementsCache;
  const oldIdx = Number(anchor.node.dataset.index);
  const oldStart = (Number.isFinite(oldIdx) && oldMeas[oldIdx]?.start) || 0;
  const gap = box.scrollTop - oldStart;
  // Prime the virtualizer on the reindexed model (syncGeom rebuilds the offset
  // cache from index 0 on a head or count change -- a prepend is exactly that),
  // then place the anchor's NEW row at the same on-screen offset it held.
  syncGeom(inner, st, box);
  const newRowIdx = rowOfItem[newPos];
  const newStart = v.measurementsCache[newRowIdx]?.start ?? oldStart;
  const next = Math.max(0, newStart + gap);
  if (Math.abs(next - box.scrollTop) > 0.5) {
    box.scrollTop = next;
    markMachineTop(box);
  }
  return shift;
}

// A pure front EVICTION: the store's open window is the newest page (a fixed row
// cap), so a new row arriving at the tail drops the oldest row at the FRONT and
// every kept row's item index shifts DOWN by k. Nothing moved or changed -- the
// dropped row and the arrival both sit far outside the viewport -- but the reuse
// walk below matches the previous frames against the new item slice BY POSITION,
// and a front shift makes every position mismatch at index 0, dropping the whole
// window into a from-scratch rebuild that detaches and re-attaches every visible
// row (the arrival jitter: one row in, the whole list redrawn). Re-find the
// first mounted MESSAGE row in the reindexed item list to learn k, so the walk
// can reuse the kept frames at their shifted offset (reuse by id) instead. Read
// only: the scroll seat is held elsewhere (the render bracket for a reader in
// history, the bottom pin for a pinned reader), never here, and the selection
// path takes reseatForFrontShift instead. Returns a NEGATIVE shift for a front
// trim, or 0 when the front did not move -- a pure tail append, a scroll, a
// same-index paint, or a front PREPEND (older history, a positive shift), which
// keeps its existing re-seat path untouched.
function frontTrimShift(
  st: RenderState,
  items: RowItem[],
  prevFrames: ItemFrame[],
  prevFromItem: number,
  sameChat: boolean
): number {
  if (!sameChat || !prevFrames.length || !st.virt) return 0;
  let ap = 0;
  while (ap < prevFrames.length && !(prevFrames[ap] && frameMessageId(prevFrames[ap]))) ap++;
  const anchor = prevFrames[ap];
  if (!anchor || !anchor.node.isConnected) return 0;
  const id = frameMessageId(anchor)!;
  const anchorOldItem = prevFromItem + ap;
  const newPos = findMessageItemIndex(items, id, anchorOldItem);
  if (newPos < 0) return 0;
  const shift = newPos - anchorOldItem;
  return shift < 0 ? shift : 0;
}

function computeWindow(
  inner: HTMLElement,
  st: RenderState
): {r0: number; r1: number; padTop: number; padBottom: number} | null {
  const box = scrollBoxOf(inner);
  if (!box || !st.rows.length) return null;
  // Prime the virtualizer (its row count, geometry, and scroll/resize
  // observers) even when the scroll box has no height yet -- an open whose first
  // paint ran before the surface was laid out. Without this the render-all
  // branch below returned BEFORE the virtualizer was ever created, so no resize
  // observer was watching the box; once the box gained its height nothing fired
  // a re-window and the list stayed rendered whole forever (the unread open that
  // mounted every row and never re-virtualized, even after a scroll -- with no
  // observer there was no onChange). syncGeom sets the count so calculateRange
  // yields a real range, so the ResizeObserver's first delivery once the box has
  // a true height changes that range and fires onChange, which re-windows onto
  // the viewport. A no-height paint still renders whole (correct: no viewport to
  // bound to), it just recovers the instant the height lands.
  const v = syncGeom(inner, st, box);
  if (!box.clientHeight) return null;
  const total = v.getTotalSize();
  // The model offset the window is computed at. Sitting at the end, it is the
  // MODEL's end (the measured/estimated total), never the live scrollTop: the
  // live end is the bottom pin's own write, and scrollHeight there carries any
  // gap between a row's cached measurement and its rendered height, which
  // depends on which rows are mounted. Deriving the top boundary from it let a
  // boundary row flip in and out, the end turn bistable and the pin chase it
  // (the open-bounce jitter, and the cannot-reach-bottom 284 px seesaw). The
  // model end does not move when a row mounts, so the window cannot feed back
  // into the pin. Elsewhere the live scrollTop (plus any bank) drives it.
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_PIN_PX;
  const off = atBottom ? Math.max(0, total - box.clientHeight) : box.scrollTop + st.bank;
  v.scrollOffset = off;
  const vitems = v.getVirtualItems();
  if (!vitems.length) return null;
  // Expand the virtualizer's tight range outward to cover the pixel overscan
  // band on each side, reading the full measurement offsets (measured where a
  // row has mounted, estimated otherwise). The offset is live, so the band
  // tracks the native scroll position of THIS paint.
  const meas = v.measurementsCache;
  const last = meas.length - 1;
  const band = box.clientHeight * OVERSCAN_VIEWPORTS;
  const topLimit = off - band;
  const botLimit = off + box.clientHeight + band;
  let r0 = vitems[0].index;
  let r1 = vitems[vitems.length - 1].index;
  while (r0 > 0 && meas[r0 - 1] && meas[r0 - 1].end > topLimit) r0--;
  while (r1 < last && meas[r1 + 1] && meas[r1 + 1].start < botLimit) r1++;
  // Guarantee the mounted band actually spans the viewport, by the rows' own
  // measured extents. The band expansion above walks by the NEXT row's start,
  // which leaves the viewport uncovered when the measurement offsets are
  // momentarily non-contiguous -- exactly what a history prepend leaves behind
  // for a frame: the item indices shift, the virtualizer's range lands short of
  // the re-seated scrollTop, and the window stops before the fold. The reader
  // then meets an unmounted row at the top that never recovered (the
  // shift/unmount-while-older-loads bug), because recoverIfUncovered only
  // re-runs this same computation. Extending until the row extents cover
  // [scrollTop, scrollTop + clientHeight] closes that gap; on a contiguous
  // window (the normal case) both loops are no-ops.
  const viewTop = off;
  const viewBottom = off + box.clientHeight;
  while (r0 > 0 && meas[r0] && meas[r0].start > viewTop) r0--;
  while (r1 < last && meas[r1] && meas[r1].end < viewBottom) r1++;
  const start = meas[r0] ? meas[r0].start : vitems[0].start;
  // The spacer stands the bank in (DOM = model - bank). It cannot go below zero:
  // at the very top only what fits stays banked.
  if (st.bank > start) st.bank = start;
  const padTop = start - st.bank;
  const padBottom = meas[r1] ? Math.max(0, total - meas[r1].end) : 0;
  return {r0, r1, padTop, padBottom};
}

// Recompute the DOM window at the list's CURRENT scroll offset, synchronously.
// The render bracket (chatSurface.bracketMessageRender) preserves the reader's
// position across a store paint by re-seating scrollTop AFTER the paint. But the
// paint computed its window (and the top spacer) at the pre-re-seat scrollTop,
// so for one frame the content sits at the new scrollTop against the old spacer
// -- the rows shift by the re-seat delta, or the viewport meets an unmounted
// row, until the next re-window lands: the shift/unmount-while-older-loads bug
// on a prepend, which moves scrollTop by the added height. This runs the same
// anchored re-window the async scroll observer would, but IN THIS FRAME, so the
// spacer matches the re-seated offset. It runs the same anchored re-window the
// async scroll observer would (anchoredRewindow), IN THIS FRAME: the window is
// recomputed at the current scrollTop and the topmost visible row keeps its
// on-screen position across the spacer change (the recompute would otherwise
// shift every row by the top-spacer delta), and the coverage net mounts the
// viewport if the paint's window fell short of it (the stuck-unmount case).
// Under jsdom (no scroll box) anchoredRewindow is a plain re-window, so window
// tests are unaffected.
export function rewindowMessages(inner: HTMLElement): void {
  const st = renderStates.get(inner);
  if (!st) return;
  anchoredRewindow(inner, st);
  recoverIfUncovered(inner, st);
}

// Re-window at the list's CURRENT scroll offset WITHOUT holding a prior anchor:
// a plain repaint that mounts whatever rows the (already moved) scrollTop now
// covers, then the coverage net if the window fell short. Unlike
// rewindowMessages, this does NOT re-seat scrollTop to hold the previously
// mounted rows -- that anchor hold UNDOES a deliberate programmatic jump when
// the destination rows are not mounted yet, so the unread landing jumping to an
// off-window divider snapped straight back to the bottom (anchoredRewindow held
// the still-mounted bottom rows and re-seated onto them). The landing moves the
// scroll itself and then calls this to paint the destination in place.
export function repaintMessagesAtScroll(inner: HTMLElement): void {
  const st = renderStates.get(inner);
  if (!st) return;
  st.lastPaint?.();
}

// Register the after-window-change sweep hook (see RenderState.onWindowChange).
export function setMessageWindowHook(inner: HTMLElement, cb: () => void): void {
  const st = renderStates.get(inner);
  if (st) st.onWindowChange = cb;
}

// Register the divider-hold getter (see RenderState.dividerHeld). chatSurface
// passes a closure over its holdDivider flag so anchoredRewindow anchors on the
// unread divider ONLY while the landing is actively holding it.
export function setMessageDividerHold(inner: HTMLElement, held: () => boolean): void {
  const st = renderStates.get(inner);
  if (st) st.dividerHeld = held;
}

// Register the ScrollOwner for a list (see scrollOwners): chatSurface hands the
// list its one writer, so anchoredRewindow never writes scrollTop on its own.
export function setMessageScrollOwner(inner: HTMLElement, owner: MessageScrollOwner): void {
  scrollOwners.set(inner, owner);
}

// True while the virtualizer sees the box scrolling (a scroll event within its
// reset delay, ~150 ms). The owner reads it, with who wrote the last offset, to
// tell a reader's live scroll or momentum from a settled list.
export function messageListScrolling(inner: HTMLElement): boolean {
  const st = renderStates.get(inner);
  return !!st?.virt && (st.virt as unknown as {isScrolling?: boolean}).isScrolling === true;
}

// Whether a re-measure correction is banked in the top spacer (RenderState.bank),
// waiting for the reader to let go.
export function messageListBanked(inner: HTMLElement): boolean {
  return (renderStates.get(inner)?.bank ?? 0) !== 0;
}

// A scan-key fragment that changes whenever the visible window moves, so the
// render hub re-runs its DOM sweeps for the rows a scroll just revealed.
export function messageVisibleRangeKey(inner: HTMLElement): string {
  const st = renderStates.get(inner);
  if (!st) return '0:0';
  return st.fromItem + ':' + st.toItem;
}

// The model-row index whose message carries `id`, or -1. Used to scroll to a
// row that may not be mounted yet (reply/search/audio jump, unread landing).
function rowIndexOfMessageId(st: RenderState, id: string): number {
  const key = 'm|' + id;
  for (let i = 0; i < st.rows.length; i++) if (st.rows[i].key === key) return i;
  return -1;
}

// Bring the message with `id` into view even when its row is outside the
// current window: scroll the box to the row's computed offset, which fires the
// re-window that mounts it. Returns false when the id is unknown. The caller
// re-queries the DOM (after the synchronous re-window) for the mounted node.
export function scrollMessageIntoView(
  inner: HTMLElement,
  id: string,
  align: 'start' | 'center' | 'end' = 'center'
): boolean {
  const st = renderStates.get(inner);
  if (!st) return false;
  const idx = rowIndexOfMessageId(st, id);
  if (idx < 0) return false;
  const box = scrollBoxOf(inner);
  if (!box || !box.clientHeight) return true; // render-all: the row is already mounted
  // getOffsetForIndex reads the measurement cache: a row still OUTSIDE the
  // window carries only its per-row ESTIMATE (EST_MSG), but a wrapped bubble on
  // the narrow layout measures well over that, so a single estimate-based jump
  // to a FAR row lands one window short of it and never mounts it -- the unread
  // landing that came to rest mid-history with no divider in the DOM. Each pass
  // scrolls to the current best offset and re-windows, which MEASURES the rows
  // it just mounted and feeds their real heights back; the next offset is
  // therefore closer, and the window walks onto the target in a few passes.
  // Iterate until the row is mounted and the offset it computes to has stopped
  // moving, bounded so a pathological geometry cannot spin. Under jsdom every
  // row measures to its estimate, so the offset is stable from pass 0 and this
  // settles in two passes with the same landing the single jump gave.
  const g = globalThis as unknown as {CSS?: {escape?: (s: string) => string}};
  const escId = g.CSS?.escape ? g.CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
  const sel = `.cyc-message[data-mid="${escId}"]`;
  let prevOff = Number.NaN;
  for (let pass = 0; pass < 12; pass++) {
    const v = syncGeom(inner, st, box);
    v.getVirtualItems(); // refresh the measurements cache getOffsetForIndex reads
    const off = v.getOffsetForIndex(idx, align);
    if (!off) break;
    const target = off[0];
    const from = box.scrollTop;
    // The offset is the model's; the DOM sits `bank` px above it (RenderState.bank).
    box.scrollTop = target - st.bank;
    logScrollWrite(box, 'jump.into', from, box.scrollTop);
    markMachineTop(box);
    // Re-window at the new offset now (computeWindow reads box.scrollTop), so the
    // caller can find the freshly mounted row synchronously, and this pass's
    // fresh measurements sharpen the next offset.
    st.lastPaint?.();
    if (inner.querySelector(sel) && Math.abs(target - prevOff) <= 1) break;
    prevOff = target;
  }
  return true;
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

/** The number of detached row nodes currently held in a list's re-attach cache.
 *  Test-only observability for the cache bound; unused by the app. */
export function messageRowCacheSize(inner: HTMLElement): number {
  return renderStates.get(inner)?.nodeCache.size ?? 0;
}

export function clearMessages(inner: HTMLElement) {
  domEpoch++;
  const st = renderStates.get(inner);
  st?.cleanup?.();
  renderStates.delete(inner);
  inner.textContent = '';
  inner.style.removeProperty('padding-top');
  inner.style.removeProperty('padding-bottom');
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
    const st0 = renderStates.get(inner);
    if (st0) {
      st0.frames = [];
      st0.fromItem = 0;
      st0.toItem = -1;
      st0.count = 0;
      st0.rows = [];
      st0.lastPaint = null;
    }
    inner.textContent = '';
    if (inner.style.paddingTop || inner.style.paddingBottom) {
      inner.style.removeProperty('padding-top');
      inner.style.removeProperty('padding-bottom');
    }

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
    // The chat's first sync is settled exactly when syncedAt is set (first
    // attach-ok, or the persisted meta of an earlier sync). Before that a
    // fresh device may still be pulling months of history, so an empty window
    // reads as loading, never as an empty chat.
    msg.textContent =
      syncedAt(s.id) === undefined ? 'Loading messages...' : 'No messages here yet';
    content.append(msg);
    messageNode.append(content);
    attachMessageHighlight(messageNode);
    wrap.append(messageNode);
    inner.append(wrap);
    return;
  }

  // Persistent per-list render state, holding the virtualizer across paints and
  // chat switches. A new list, or a switch to another chat, resets the built
  // rows but keeps the virtualizer bound to the same scroll box.
  let st = renderStates.get(inner);
  const sameChat = !!(st && st.sessionId === s.id);
  if (!st) {
    st = {
      sessionId: s.id,
      frames: [],
      fromItem: 0,
      toItem: -1,
      count: 0,
      rows: [],
      virt: null,
      cleanup: null,
      opts: null,
      lastPaint: null,
      scheduled: false,
      painting: false,
      measuredDirty: false,
      forceFull: false,
      lastHeadKey: null,
      lastRowCount: -1,
      lastSecondKey: null,
      lastScrollTop: -1,
      syncScroll: false,
      bank: 0,
      onWindowChange: null,
      dividerHeld: null,
      nodeCache: new Map()
    };
    renderStates.set(inner, st);
  } else if (!sameChat) {
    st.sessionId = s.id;
    st.bank = 0;
    st.frames = [];
    st.fromItem = 0;
    st.toItem = -1;
    st.count = 0;
    // The cached nodes belong to the chat we just left; drop them so a switch
    // never re-attaches another chat's bubble.
    st.nodeCache.clear();
  }
  const prevFrames = sameChat ? st.frames : [];
  const prevFromItem = st.fromItem;
  const prevToItem = st.toItem;

  // The full render-row model, then the visible slice. The virtualizer bounds
  // the DOM to the viewport (+ overscan); with no scroll box the whole list
  // renders (a detached list in a unit test, a short chat). winItems is the
  // merged-item slice the visible rows cover; padTop/padBottom stand in for the
  // rows outside it so native scroll and the box's scrollHeight stay honest.
  const model = buildRowModel(items);
  const rows = model.rows;
  const rowOfItem = model.rowOfItem;
  const dateRowOfDay = model.dateRowOfDay;
  st.rows = rows;
  // Hold the current window whenever the reader has text selected in the list:
  // a store paint, a prepend, a live append or a measurement settle must not
  // rebuild/move/re-parent any mounted row, or the range's container detaches
  // for an instant and the browser collapses the selection. Only a genuine
  // reader scroll (a live sync re-window whose offset actually moved) is exempt,
  // so the list is never frozen under the reader's own scroll. With no selection
  // this is off and the list windows exactly as before (the scroll-stability
  // contract the list-rig pins is untouched).
  const holdBox = scrollBoxOf(inner);
  const scrollMoved = !holdBox || Math.abs(holdBox.scrollTop - st.lastScrollTop) > 1;
  const holdForSelection =
    sameChat &&
    !(st.syncScroll && scrollMoved) &&
    prevFrames.length > 0 &&
    selectionInList(inner);
  // Older history prepended at the front? While holding a selection, re-seat the
  // scroll to keep the reader's rows on screen BEFORE the window is computed and
  // learn the item shift, so the reconcile treats the mounted rows as unchanged
  // (kept in place) instead of rebuilding them and dropping the selection. When
  // nothing is selected the prepend takes the pre-existing render-bracket path.
  // A selection holds its rows across a prepend or a trim by re-seating the
  // scroll (reseatForFrontShift). With no selection a front EVICTION (the store
  // dropped its oldest row when this arrival landed) still shifts every kept
  // row's index down; learn that shift (read only, no re-seat) so the reuse walk
  // matches the kept frames by identity instead of by their now-stale position
  // and does not remount the whole window. A front prepend (positive shift) is
  // left to its existing bracket/selection path.
  const frontShift = holdForSelection
    ? reseatForFrontShift(inner, st, items, rowOfItem, prevFrames, prevFromItem, sameChat)
    : frontTrimShift(st, items, prevFrames, prevFromItem, sameChat);
  const reusePrevFrom = prevFromItem + frontShift;
  const win = computeWindow(inner, st);
  const windowed = !!win;
  let fromItem: number;
  let toItem: number;
  let padTop = 0;
  let padBottom = 0;
  let startsWithDate = true;
  if (win) {
    let f = Infinity;
    let t = -1;
    for (let r = win.r0; r <= win.r1; r++) {
      if (rows[r].itemFrom < f) f = rows[r].itemFrom;
      if (rows[r].itemTo > t) t = rows[r].itemTo;
    }
    if (t < f) t = f;
    fromItem = f;
    toItem = t;
    padTop = win.padTop;
    padBottom = win.padBottom;
    startsWithDate = rows[win.r0].kind === 'date';
    // Older history landed at the front and the scroll was re-seated to hold the
    // reader's view (reseatForFrontShift). Hold EXACTLY the previously mounted
    // window, reindexed, for this paint: the edge reconcile then reuses every
    // row verbatim (dropHead 0) and rebuilds/moves nothing, so the reader's text
    // selection survives. computeWindow's band around the freshly re-seated
    // offset can land a row or two off the true anchor (the anchor is the top
    // mounted message, the band is symmetric about the offset), which slid the
    // window and left rows the reconcile did not trim; pinning it to the shifted
    // previous window sidesteps that. The very next re-window (the render
    // bracket's re-seat, a scroll, a settle) runs with frontShift 0 and adjusts
    // the edges cleanly from this correct base.
    if (holdForSelection && prevFrames.length && st.virt) {
      const fFrom = Math.max(0, reusePrevFrom);
      const fTo = Math.min(items.length - 1, prevToItem + frontShift);
      if (fTo >= fFrom) {
        fromItem = fFrom;
        toItem = fTo;
        const meas = st.virt.measurementsCache;
        const rTop = rowOfItem[fromItem];
        const rBot = rowOfItem[toItem];
        const total = st.virt.getTotalSize();
        padTop = meas[rTop] ? Math.max(0, meas[rTop].start - st.bank) : padTop;
        padBottom = meas[rBot] ? Math.max(0, total - meas[rBot].end) : padBottom;
        startsWithDate = rows[rTop]?.kind === 'date';
      }
    }
  } else {
    fromItem = 0;
    toItem = items.length - 1;
  }
  const winItems = items.slice(fromItem, toItem + 1);

  const sigs = winItems.map((it) => itemSig(it.m, it.ev, it.ts, firstUnreadId));

  // The one row this paint's "first queued" banner belongs on: the first
  // message that opens a queued run sitting ahead of the agent (past the last
  // claude row). Both the reuse sweep and the row builders key off this single
  // id so at most one queued head is ever stamped.
  let firstQueuedMid: string | undefined;
  {
    let pq = fromItem > 0 ? !!items[fromItem - 1].m?.queued : false;
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

  // The single-banner bookkeeping shared by the reuse sweep and the row
  // builders: at most one unread divider and one queued head across the window.
  type StampState = {unread: boolean; queued: boolean};

  // Build (or re-attach from cache) one SESSION-EVENT row starting at window
  // index `from`, settling its run span first so the cache key covers the whole
  // run. Returns the node, the last window index it consumed, and the frame
  // metadata; the caller owns where it lands in the group/section tree.
  function makeEvNode(from: number, key: string): {
    node: HTMLElement;
    endIdx: number;
    isFold: boolean;
    cacheKey: string;
    sigsSlice: string[];
  } {
    let i = from;
    let isFold = false;
    let build: () => HTMLElement;
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
      isFold = true;
      i = runEnd;
      build = () => sessionEventFoldMessages(events);
    } else if (winItems[from].ev!.kind === 'tool') {
      const run: CycSessionEvent[] = [winItems[from].ev!];
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
      build = () =>
        run.length > 1
          ? sessionEventRunMessages(run, interrupt)
          : sessionEventMessage(run[0], interrupt);
    } else {
      const only = winItems[from].ev!;
      build = () => sessionEventMessage(only);
    }
    const ck = rowCacheKey(
      rows[rowOfItem[fromItem + from]].key,
      sigs.slice(from, i + 1).join('\u0001')
    );
    const node = takeCachedRow(st, ck) ?? build();
    node.dataset.index = String(rowOfItem[fromItem + from]);
    return {node, endIdx: i, isFold, cacheKey: ck, sigsSlice: sigs.slice(from, i + 1)};
  }

  // Build (or re-attach from cache) one MESSAGE row. The version key folds the
  // signature (content, status, unread-anchor) with the group edges the node's
  // styling bakes in (`first`/`last`) and the queued-head mark, so a re-attached
  // bubble is byte-identical to a fresh one. A cache hit already carries its
  // images, send-progress line, and banners, so only the single-banner
  // bookkeeping is updated; a miss carries images, paints send state, and
  // stamps the anchors.
  function makeMsgNode(
    from: number,
    m: CycMessage,
    first: boolean,
    last: boolean,
    dropped: Map<string, HTMLElement>,
    ss: StampState
  ): {node: HTMLElement; cacheKey: string} {
    const hasAudio = !!(m as CycMessage & {msgId?: string}).msgId;
    const attached = uploadsOf(m);
    const msgCk = rowCacheKey(
      'm|' + m.id,
      sigs[from] +
        '|' +
        (first ? 'F' : '') +
        (last ? 'L' : '') +
        (m.id === firstQueuedMid ? 'Q' : '')
    );
    const cached = takeCachedRow(st, msgCk);
    const messageNode =
      cached ??
      (attached.length > 1 || (attached.length === 1 && isAudioUpload(attached[0]))
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
                        winItems.length - from <= EAGER_TAIL
                      )
                    : textMessage(m, first, last, onPlay));
    messageNode.dataset.mid = m.id;
    messageNode.dataset.index = String(rowOfItem[fromItem + from]);
    messageNode.dataset.ts = String(m.ts);
    if (cached) {
      if (messageNode.dataset.cycUnread !== undefined) ss.unread = true;
      if (messageNode.classList.contains('cyc-first-queued')) ss.queued = true;
    } else {
      carryStillImages(dropped.get(messageNode.dataset.mid), messageNode);
      paintAttachmentSend(messageNode, m, attached.length > 0 || !!m.upload);
      if (m.id === firstUnreadId && !ss.unread) {
        markUnreadLanding(messageNode);
        messageNode.classList.add('max-tab:!max-w-none');
        messageNode.prepend(unreadBannerEl());
        ss.unread = true;
      }
      if (m.queued && m.id === firstQueuedMid && !ss.queued) {
        messageNode.classList.add('cyc-first-queued');
        messageNode.prepend(
          queuedBannerEl(
            'Queued for ' + (s.agentName ?? DEFAULT_AGENT_NAME) + (s.model ? ' \u00b7 ' + s.model : '')
          )
        );
        ss.queued = true;
      }
    }
    return {node: messageNode, cacheKey: msgCk};
  }

  // Land the freshly reconciled window: spacer heights, the persistent state,
  // the re-window closure, and a settle-measure of the mounted rows. Shared by
  // the append path and the scroll-up prepend path.
  function commitWindow(finalFrames: ItemFrame[]): void {
    if (windowed) {
      inner.style.paddingTop = padTop + 'px';
      inner.style.paddingBottom = padBottom + 'px';
      // A front prepend reindexed the rows: refresh the data-index on every kept
      // node (only when it actually changed, so a plain repaint still writes
      // nothing) so the virtualizer keys each row's measured height by the right
      // row and anchoredRewindow finds the right anchor. Kept rows are never
      // rebuilt for this -- their index attribute is patched in place.
      for (let p = 0; p < finalFrames.length; p++) {
        const f = finalFrames[p];
        if (!f) continue;
        const idx = String(rowOfItem[fromItem + p]);
        if (f.node.dataset.index !== idx) f.node.dataset.index = idx;
      }
    } else if (inner.style.paddingTop || inner.style.paddingBottom) {
      inner.style.removeProperty('padding-top');
      inner.style.removeProperty('padding-bottom');
    }
    st!.sessionId = s.id;
    st!.frames = finalFrames;
    st!.fromItem = fromItem;
    st!.toItem = toItem;
    st!.count = items.length;
    st!.rows = rows;
    {
      const cb = scrollBoxOf(inner);
      st!.lastScrollTop = cb ? cb.scrollTop : -1;
    }
    st!.lastPaint = () =>
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
    // Feed the real box heights back to the virtualizer so off-window offsets
    // and the total scroll height converge from the estimates. measureElement
    // only notifies (and schedules a re-window) when a size actually changed, so
    // this settles rather than looping.
    //
    // Hold `painting` across the loop so a size change here cannot run a
    // synchronous re-window nested inside this paint. A store prepend
    // (bracketMessageRender) paints here while the reader is mid-scroll (the
    // virtualizer still flags isScrolling), and without this a measure
    // notification re-entered anchoredRewindow before the caller had re-seated
    // its anchor, shifting the held row a few px (the row-shift-while-older-loads
    // bug). `reentrant` is true when this paint is itself a scroll re-window
    // (the sync fling path already set `painting`): that path keeps converging
    // on its own scroll events, so it schedules nothing extra here. A standalone
    // paint (a store prepend, a plain render) instead schedules ONE async
    // re-window when a row measured away from its estimate, so offsets and the
    // scroll height converge next frame with the anchor hold intact.
    if (windowed && st!.virt) {
      const reentrant = st!.painting;
      st!.painting = true;
      st!.measuredDirty = false;
      try {
        for (const node of inner.querySelectorAll<HTMLElement>('[data-index]'))
          st!.virt.measureElement(node);
      } finally {
        st!.painting = reentrant;
      }
      // Skip the converge while the virtualizer is actively scrolling: the next
      // scroll event's re-window reads the fresh measurements and converges
      // them, and the scroll-end tick catches a fling that stops right here, so
      // scheduling one now would only add a redundant re-window to the fling
      // (measured as extra long frames). A settled store paint has no such
      // follow-up, so it schedules the one converge itself.
      const scrolling = (st!.virt as unknown as {isScrolling?: boolean}).isScrolling === true;
      if (!reentrant && st!.measuredDirty && !scrolling) scheduleRepaint(inner, st!);
    }
  }

  // Scroll UP: the window slid toward older rows. Keep the overlap (a prefix of
  // the mounted frames) in place, trim the rows that left the bottom, and
  // PREPEND only the rows that entered at the top -- the mirror of the append
  // path's edge-only reconcile. Without it a scroll up rebuilt the whole window
  // every frame (the measured up-fling jank). Returns true when it handled the
  // paint; false falls through to the general path (a full rebuild).
  function tryPrependWindow(): boolean {
    const P = reusePrevFrom - fromItem; // items entering at the top
    const keptItemCount = toItem - reusePrevFrom + 1; // overlap items
    if (P <= 0 || keptItemCount <= 0 || keptItemCount > prevFrames.length) return false;
    const kept = prevFrames.slice(0, keptItemCount);
    if (!kept[0]) return false;
    // The boundary into the leaving-bottom rows must be a whole row, not a
    // mid-run placeholder, so trimming removes complete rows.
    if (keptItemCount < prevFrames.length && !prevFrames[keptItemCount]) return false;
    // The overlap must still match the new window's signatures at the shifted
    // offset (a pure scroll). A concurrent store change misses here and the
    // paint falls back to a full rebuild.
    for (let j = 0; j < kept.length; j++) {
      const f = kept[j];
      if (!f) continue;
      for (let k = 0; k < f.sigs.length; k++) {
        if (f.sigs[k] !== sigs[P + j + k]) return false;
      }
    }
    // The insertion anchor: the first kept row's LIVE section, read from the DOM
    // rather than the frame's stored reference (a prior paint can leave that
    // stale). Bail to a full rebuild if it is not a direct child of the list --
    // splicing against a detached node throws and drops the whole list into the
    // rebuild-fallback, which repaints from the top and paints blank. Checked
    // before any DOM mutation so the fallback starts from a clean tree.
    const firstKeptSection = kept[0]!.node.closest<HTMLElement>('.cyc-date-group');
    if (!firstKeptSection || firstKeptSection.parentElement !== inner) return false;

    // The entering-top rows: build them into a fragment as their own sections
    // and groups. The single-banner state is seeded from the kept rows so a
    // banner already carried below is never duplicated above.
    const ss: StampState = {unread: false, queued: false};
    for (const f of kept) {
      if (!f) continue;
      if (f.node.dataset.cycUnread !== undefined) ss.unread = true;
      if (f.node.classList.contains('cyc-first-queued')) ss.queued = true;
    }
    const noDrop = new Map<string, HTMLElement>();
    const frag = document.createDocumentFragment();
    const pf: ItemFrame[] = [];
    let gDay = '';
    let gSection: HTMLElement | null = null;
    let gGroup: HTMLDivElement | null = null;
    let gRole: string | null = null;
    let gPrevQueued = fromItem > 0 ? !!items[fromItem - 1].m?.queued : false;
    for (let i = 0; i < P; i++) {
      const it = winItems[i];
      const from = i;
      const key = new Date(it.ts).toDateString();
      if (key !== gDay) {
        gDay = key;
        gSection = h('section', 'cyc-date-group relative');
        const chip = dateMessage(dayLabel(it.ts));
        const dri = dateRowOfDay.get(key);
        if (dri !== undefined) chip.dataset.index = String(dri);
        gSection.append(chip);
        frag.append(gSection);
        gGroup = null;
        gRole = null;
      }
      if (it.ev) {
        const {node, endIdx, isFold, cacheKey, sigsSlice} = makeEvNode(from, key);
        i = endIdx;
        (gGroup ?? gSection!).append(node);
        pf.push({
          sig: sigs[from],
          sigs: sigsSlice,
          node,
          dayKey: gDay,
          dateGroup: gSection,
          group: gGroup,
          prevRole: gRole,
          prevQueued: gPrevQueued,
          consumed: i - from,
          se: true,
          fold: isFold,
          cacheKey
        });
        for (let k = from + 1; k <= i; k++) pf.push(undefined as unknown as ItemFrame);
        continue;
      }
      const m = it.m!;
      const first = m.role !== gRole;
      const next = msgs[it.mi! + 1];
      const last = !next || next.role !== m.role || new Date(next.ts).toDateString() !== key;
      if (first) {
        gGroup = h('div', 'cyc-message-group relative');
        gSection!.append(gGroup);
      }
      const {node, cacheKey} = makeMsgNode(from, m, first, last, noDrop, ss);
      gGroup!.append(node);
      gPrevQueued = !!m.queued;
      gRole = m.role;
      pf.push({
        sig: sigs[from],
        sigs: [sigs[from]],
        node,
        dayKey: gDay,
        dateGroup: gSection,
        group: gGroup,
        prevRole: gRole,
        prevQueued: gPrevQueued,
        consumed: 0,
        last,
        cacheKey
      });
    }

    // Trim the rows that left the bottom, caching them for a scroll back, and
    // prune the sections/groups they emptied.
    const emptied: HTMLElement[] = [];
    for (let i = keptItemCount; i < prevFrames.length; i++) {
      const f = prevFrames[i];
      if (!f) continue;
      if (f.cacheKey) cacheRow(st!, f.cacheKey, f.node);
      f.node.remove();
      if (f.group) emptied.push(f.group);
      if (f.dateGroup) emptied.push(f.dateGroup);
    }

    // Splice the prepend fragment in above the kept content. When the last
    // prepend day equals the first kept day, its rows join the existing kept
    // section (after that section's date chip) so the day keeps ONE chip; the
    // remaining earlier-day sections are inserted before it.
    let lastPf: ItemFrame | undefined;
    for (let i = pf.length - 1; i >= 0; i--)
      if (pf[i]) {
        lastPf = pf[i];
        break;
      }
    if (lastPf && lastPf.dayKey === kept[0]!.dayKey) {
      const pSection = lastPf.dateGroup!;
      const chip = firstKeptSection.querySelector<HTMLElement>(':scope > .cyc-date-chip');
      const ref = chip ? chip.nextSibling : firstKeptSection.firstChild;
      for (const child of Array.from(pSection.children)) {
        if (child.classList.contains('cyc-date-chip')) continue;
        firstKeptSection.insertBefore(child, ref);
      }
      for (const f of pf) if (f && f.dateGroup === pSection) f.dateGroup = firstKeptSection;
      pSection.remove();
    }
    inner.insertBefore(frag, firstKeptSection);
    for (const w of emptied) {
      if (!w.isConnected) continue;
      const empty = w.classList.contains('cyc-date-group')
        ? w.childElementCount <= 1
        : !w.childElementCount;
      if (empty) w.remove();
    }

    commitWindow([...pf, ...kept]);
    return true;
  }

  // The rows that scrolled off the TOP as the window slid down. Frames are
  // item-indexed (a run head then a placeholder per item it consumed), so the
  // frame at offset (fromItem - prevFromItem) is the one that now sits at the
  // window top; everything before it left. Keeping the overlap mounted IN PLACE
  // and only trimming the leaving head + appending the entering tail is what
  // keeps a fling cheap: the browser re-lays-out the few edge rows, not the
  // whole window (a from-scratch wipe re-styled and re-painted every row every
  // scroll event -- the measured jank). A slid window shares no anchor with the
  // old prefix, so before this it always fell through to a full rebuild.
  let leavingHead: ItemFrame[] = [];
  let reusable: ItemFrame[] | null = null;
  // A forced full rebuild (the coverage net recovering a collapsed window):
  // reuse nothing, so the window is recomputed and mounted from scratch. But a
  // full rebuild detaches every row -- fatal to a live selection -- so while the
  // reader has text selected the hold wins and the coverage recovery is deferred
  // (a held window can leave an overscan edge briefly uncovered; the recovery
  // lands the moment the selection clears).
  const forceFull = st.forceFull && !holdForSelection;
  st.forceFull = false;
  if (forceFull) {
    // fall through with reusable = null (full rebuild)
  } else if (sameChat && windowed) {
    const dropHead = fromItem - reusePrevFrom;
    if (dropHead === 0) {
      reusable = prevFrames;
    } else if (dropHead > 0 && dropHead < prevFrames.length && prevFrames[dropHead]) {
      // Only when the boundary lands on a real frame (not mid-run); a mid-run
      // boundary or a store change that shifted item indices makes the
      // signature walk below match nothing, and the paint falls back to a full
      // rebuild (frames empty -> the node set is wiped and rebuilt from cache).
      reusable = prevFrames.slice(dropHead);
      leavingHead = prevFrames.slice(0, dropHead);
    }
  } else if (sameChat && reusePrevFrom === fromItem) {
    reusable = prevFrames;
  }

  // The window slid the other way (scroll up / a jump to an earlier row): the
  // overlap is a PREFIX of the mounted frames and new rows enter at the top.
  // Prepend them instead of rebuilding the window; on any mismatch this returns
  // false and the general path below takes over.
  if (
    !forceFull &&
    reusable === null &&
    sameChat &&
    windowed &&
    fromItem < reusePrevFrom &&
    reusePrevFrom <= toItem &&
    prevFrames.length > 0 &&
    prevFrames[0] &&
    tryPrependWindow()
  ) {
    return;
  }

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
          // The node grew in place, so its stored version no longer matches its
          // content; drop its cache key so it is never stashed under a stale
          // one (it simply rebuilds if it ever leaves and returns).
          foldFrame.cacheKey = undefined;
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
      from: fromItem,
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
  // A rebuilt row for the same message adopts the dropped row's <img> (see
  // carryStillImages). The source is the reused tail on a data change, or the
  // whole previous window on a scroll re-window (reusable is null then, but the
  // rows that stay visible should still carry their decoded pictures).
  const dropped = new Map<string, HTMLElement>();
  {
    const dropSource = reusable ?? prevFrames;
    const dropStart = reusable ? start : 0;
    for (let i = dropStart; i < dropSource.length; i++) {
      const f = dropSource[i];
      const mid = f?.node.dataset.mid;
      if (mid && !dropped.has(mid)) dropped.set(mid, f.node);
      // A row leaving the window is stashed under its content-version key so
      // the build loop below (and later paints) re-attach it rather than
      // rebuild it. Only rows with a key are cached (date chips are cheap).
      if (f?.cacheKey) cacheRow(st, f.cacheKey, f.node);
    }
  }
  // The rows that scrolled off the top leave: cache their nodes (a scroll back
  // re-attaches them) and drop them, leaving their now-empty groups for the
  // prune below. A group straddling the drop boundary keeps its surviving rows
  // (the prune checks it still has children).
  for (const f of leavingHead) {
    if (!f) continue;
    if (f.cacheKey) cacheRow(st, f.cacheKey, f.node);
    f.node.remove();
    if (f.group) emptied.push(f.group);
    if (f.dateGroup) emptied.push(f.dateGroup);
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

  let prevQueued = base?.prevQueued ?? (fromItem > 0 ? !!items[fromItem - 1].m?.queued : false);

  // The window opened mid-day (its first rendered row is not a day boundary):
  // open a chip-less day section so the partial day's rows have a container and
  // no duplicate date chip appears. A very long single day scrolled deep shows
  // no pinned chip until its boundary scrolls in; a documented limitation of
  // the virtual list (the date separators between days are unaffected).
  if (!frames.length && windowed && !startsWithDate) {
    dayKey = new Date(winItems[0].ts).toDateString();
    dateGroup = h('section', 'cyc-date-group relative');
    inner.append(dateGroup);
  }

  const onlyChip = (section: HTMLElement) => section.childElementCount <= 1;

  // Sweep the rows the walk reused verbatim: strip an unread or queued stamp off
  // any that is not this paint's anchor, and off a second row that duplicates
  // the anchor id. The freshly built tail below is stamped correctly; seeding
  // these flags from the kept rows keeps the build from adding a second banner
  // when the anchor already carries one.
  const ss: StampState = {unread: false, queued: false};
  for (let j = 0; j < start; j++) {
    const f = frames[j];
    if (!f) continue;
    const node = f.node;
    const mid = node.dataset.mid ?? '';
    if (node.dataset.cycUnread !== undefined) {
      if (!ss.unread && firstUnreadId !== undefined && mid === firstUnreadId) ss.unread = true;
      else stripUnreadStamp(node);
    }
    if (node.classList.contains('cyc-first-queued')) {
      if (!ss.queued && firstQueuedMid !== undefined && mid === firstQueuedMid) ss.queued = true;
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
        const chip = dateMessage(label);
        const dri = dateRowOfDay.get(key);
        if (dri !== undefined) chip.dataset.index = String(dri);
        dateGroup.append(chip);
        inner.append(dateGroup);
      }
      group = null;
      prevRole = null;
    }

    if (it.ev) {
      const {node, endIdx, isFold, cacheKey, sigsSlice} = makeEvNode(from, key);
      i = endIdx;
      (group ?? dateGroup!).append(node);
      frames.push({
        sig: sigs[from],
        sigs: sigsSlice,
        node,
        dayKey,
        dateGroup,
        group,
        prevRole,
        prevQueued,
        consumed: i - from,
        se: true,
        fold: isFold,
        cacheKey
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
    const {node: messageNode, cacheKey: msgCk} = makeMsgNode(from, m, first, last, dropped, ss);
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
      last,
      cacheKey: msgCk
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

  // Spacers, persistent state, the re-window closure, and a settle-measure.
  commitWindow(frames);
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
