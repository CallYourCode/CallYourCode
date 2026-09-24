import * as engine from './engine/store';
import type {CycEngineSession} from './engine/store';
import type {CycMediaItem, CycMessage, CycSession, CycSessionEvent} from './types';
import {sessionState, dataState} from './sessionState';
import {
  renderMessages,
  messageWindowFrom,
  messageDomEpoch
} from '@/features/chat/surface/messageList';
import {cyclog} from '@/shared/logging';
import * as interactionWindow from '@/shared/browser';
import {enginePin} from './engine/contract';
import type {EnginePluginDecl} from './engine/contract';
import {mergeTabs, rowChipShown} from '@/features/settings/preferences';
import {uploadKey} from '@/features/chat/content';
import {localUploadUrl} from '@/features/composer/localUploadUrls';
import {
  active,
  allSessions,
  isDead,
  projectArchive,
  projectRows,
  tabLabelOf
} from './sessionSelectors';
import type {createListPane} from './features/sessions/panes/listPane';
import type {createHeaderPane} from './features/sessions/panes/headerPane';
import type {createChatSurface} from '@/features/chat/surface/chatSurface';
import type {createAudioPlayback} from '@/features/chat/surface/audioPlayback';
import type {ViewerItem} from '@/features/media/imageViewer';

export interface RenderHubDeps {
  whole: HTMLElement;
  mainColumns: HTMLElement;
  list: ReturnType<typeof createListPane>;
  tp: ReturnType<typeof createHeaderPane>;
  cs: ReturnType<typeof createChatSurface>;
  audio: ReturnType<typeof createAudioPlayback>;
  media: {
    sessionAttachments(): CycMediaItem[];
    onOpenFileCard: Parameters<typeof renderMessages>[5];
    openAlbumAt(key: string, item: ViewerItem): void;
    openDocAttachment(name: string, url: string, mime?: string): void;
  };
  composer: {
    setPluginWidgets(w: unknown[]): void;
    setDisabled(disabled: boolean): void;
    setVoiceEnabled(on: boolean): void;
  };
  askPanel: {update(ask: unknown, unknownAsk: boolean, id: string | null): void};
  profile: {
    update(s: CycSession | null | undefined): void;
    setCronCount(n: number): void;
    setEngineReachable(on: boolean): void;
    setMedia(items: CycMediaItem[]): void;
  };
  hydrateWaveforms(): void;
  syncNavUrl(): void;
}

export function createRenderHub(deps: RenderHubDeps) {
  const {list, tp, cs, audio, media} = deps;

  // contentVersion(s) folds every message of the session; during a streaming
  // reply the growing body changes it each chunk, so every reader hashes the
  // active session's whole history on every coalesced notify -- up to the
  // display refresh rate (120Hz on a ProMotion iPhone). Memoize it for the
  // span of one render pass: the store does not mutate mid-render, so this is
  // byte-identical to calling through, it only drops any duplicate O(messages)
  // pass. Today chatSurfaceVersion is the one caller (the list surface keys on
  // the coarse listRowVersion below instead), but the memo stays so any future
  // reader inside a render pass is free. Null outside a render pass so any
  // stray call falls straight through to the engine.
  let cvMemo: Map<string, string> | null = null;
  const cvOf = (s: CycSession): string => {
    if (!cvMemo) return engine.contentVersion(s);
    let v = cvMemo.get(s.id);
    if (v === undefined) {
      v = engine.contentVersion(s);
      cvMemo.set(s.id, v);
    }
    return v;
  };

  // pluginsOf(engineKey) returns conn.plugins, an array the store replaces
  // wholesale only when the engine re-announces its plugins (the 'plugins'
  // event in engine/store/handlers/liveness); it is never mutated in place. So
  // the composer JSON is a pure function of that array's reference: cache it per
  // reference and re-stringify only when the engine swaps the array, instead of
  // serialising it on every version computation (i.e. every animation frame
  // while a reply streams).
  const composerJsonCache = new WeakMap<object, string>();
  const composerJson = (list: EnginePluginDecl[]): string => {
    let json = composerJsonCache.get(list);
    if (json === undefined) {
      json = JSON.stringify(list.map((p) => p.composer ?? []));
      composerJsonCache.set(list, json);
    }
    return json;
  };

  let renderCount = 0;
  (window as unknown as {__cycRenderCount: () => number}).__cycRenderCount = () => renderCount;

  type SurfaceName = 'tabs' | 'list' | 'chat';
  const surfaceMark: Record<SurfaceName, string> = {tabs: '\0', list: '\0', chat: '\0'};
  const surfaceStat: Record<SurfaceName, {paints: number; skips: number}> = {
    tabs: {paints: 0, skips: 0},
    list: {paints: 0, skips: 0},
    chat: {paints: 0, skips: 0}
  };

  const SKIP_LOG_EVERY = 64;
  function paintSurface(name: SurfaceName, version: string, fn: () => void, force: boolean) {
    if (!force && surfaceMark[name] === version) {
      const skips = ++surfaceStat[name].skips;
      if (skips % SKIP_LOG_EVERY === 0) {
        cyclog('render.skipped', {
          surface: name,
          session: sessionState.activeId ?? '',
          skipped: skips
        });
      }
      return;
    }
    surfaceMark[name] = version;
    surfaceStat[name].paints++;
    fn();
  }
  if (new URLSearchParams(location.search).get('testhooks')) {
    (window as never as {__cycSurfaceStats: () => typeof surfaceStat}).__cycSurfaceStats = () =>
      surfaceStat;
  }

  function renderRows(allowEmpty = false) {
    const projected = list.projectList(sessionState.activeTabId ?? undefined);
    const rows = projected.rows;

    const modelIds = new Set(allSessions().map((s) => s.id));
    const shownRows = list.sessionList.el.querySelectorAll<HTMLElement>('[data-session-id]');
    const shownIds = Array.from(shownRows).map((r) => r.dataset.sessionId);
    const allBacked = shownIds.length > 0 && shownIds.every((id) => !!id && modelIds.has(id));
    // The archive lens legitimately empties (its one session restarted back to
    // life), so the hold-empty guard is a live-list rule only.
    if (
      !allowEmpty &&
      !sessionState.archiveOpen &&
      rows.length === 0 &&
      modelIds.size > 0 &&
      allBacked
    ) {
      cyclog('list.heldEmpty', {
        tab: sessionState.activeTabId ?? null,
        fleet: modelIds.size,
        shown: shownIds.length,
        why: 'a wire event zeroed the active tab for a frame while every shown row is still model-backed; the durable list is held'
      });
      return;
    }

    if (projected.cards.hints) {
      if (list.hintsCardEl.parentElement !== list.sessionListTop)
        list.sessionListTop.append(list.hintsCardEl);
    } else if (list.hintsCardEl.parentElement) {
      list.hintsCardEl.remove();
    }

    // The one authoritative visible set (membership projection + search
    // filter) lives in list.visibleSessions; keyboard nav iterates the same
    // function, so what nav reaches and what this paints can never drift.
    const visible = list.visibleSessions(rows);

    list.sessionList.update(visible, window.innerWidth <= 550 ? null : sessionState.activeId);
    list.updateArchiveEntry();
    audio.updateRowAudio();

    audio.updatePlayerBar();
  }

  function tabsSurfaceVersion(): string {
    const infos = dataState.mode === 'live' ? engine.tabs() : dataState.testTabs;
    const pinned = dataState.mode === 'live' ? enginePin() : null;
    const parts: (string | number)[] = [
      dataState.mode,
      mergeTabs() ? 1 : 0,
      pinned ?? '',
      sessionState.activeTabId ?? '',
      infos.length
    ];
    for (const i of infos)
      parts.push(i.id, i.label, i.unread | 0, i.activity ? 1 : 0, i.state, i.detail ?? '');
    return parts.join('\x1f');
  }

  // The one line of a message a session row can show: a single CSS-ellipsized
  // preview. There is no character cutoff in the row itself (the ellipsis is
  // pixel-width), so this bound is chosen comfortably above what one row line
  // can render on the widest list pane. Folding only this prefix bounds the
  // streaming storm: while a growing body's first LIST_PREVIEW_CHARS characters
  // arrive the row still repaints (its visible preview is actually changing),
  // and past the bound further appends stop re-keying the list entirely.
  const LIST_PREVIEW_CHARS = 200;

  // What a session ROW actually paints, and nothing else -- the coarse
  // per-row version the list surface keys on instead of contentVersion.
  // contentVersion folds every message body (text.length per row) plus events,
  // agentRuns and more, so a streaming reply, a TUI event stream, or token
  // ticks re-keyed the WHOLE list surface every coalesced notify even though a
  // row paints none of that. This key folds exactly the row's painted inputs
  // (chatRow's deriveSubtitle/deriveBadges/titleSig/avatarSig/timeOf, the
  // sessionList audio badge, and list membership/order), each traced to the
  // row renderer; the enumeration lives with the field list below. O(1) per
  // session: only the LAST message is read, never the history.
  function listRowVersion(s: CycSession): string {
    const es = s as Partial<CycEngineSession> & CycSession;
    const msgs = s.messages ?? [];
    const n = msgs.length;
    const last = n
      ? (msgs[n - 1] as CycMessage & {growing?: boolean; msgId?: string; dedupeKey?: string})
      : null;
    // title presence picks the subtitle branch: with a title the row mirrors
    // agent state (ask/thinking/turnAge label); without one it shows the last
    // message's live text as the preview.
    const mirror = s.title !== undefined;
    return [
      s.id, // row identity; also makes the order-sensitive surface join see reorders
      n, // new/removed message (deriveSubtitle's `last`, timeOf)
      s.name, // titleSig fallback, avatarSeed, filter haystack
      mirror ? '1|' + s.title!.text + '|' + (s.title!.detail ?? '') : '0', // titleSig + branch pick
      s.agentLabel ?? '', // agentNameOf -> idle label
      s.agentName ?? '', // agentNameOf fallback + harness chip text
      s.unread | 0, // unread badge
      s.muted ? 1 : 0, // mute icon + cyc-muted class
      s.thinking ? 1 : 0, // thinking dots
      s.status ?? '', // 'working' dots + deriveBadges via activityMark
      s.ask ? s.ask.question : '', // asking subtitle
      s.askUnknown ? 1 : 0, // waiting-in-terminal subtitle
      s.avatarUrl ?? '', // avatarSig
      s.turnSince ?? 0, // turnAge label (minute ticks repaint via relTicker's direct renderRows)
      s.lastActivity ?? 0, // timeOf fallback + orderByLatest input
      s.order ?? -1, // manual order
      es.alive === false ? 0 : 1, // dead: offline subtitle, grayscale, membership
      es.churnGrey ? 1 : 0, // projectMembership keeps a churning dead row
      s.cwd ?? '', // empty-chat subtitle fallback
      es.heardTs ?? 0, // row audio badge speakable vs finished
      engine.activityMark(s) ?? '', // the dot the row is handed (folds the global toggle too)
      engine.effectiveNotify(es) ? 1 : 0, // notifyOff bell (per-session pref + global default)
      mergeTabs() ? (tabLabelOf(s.id) ?? '') : '', // merged-tabs chip
      mergeTabs() ? 1 : 0, // the merged gate the HOST chip paints under
      (rowChipShown('harness') ? 2 : 0) + (rowChipShown('model') ? 1 : 0), // the settings toggles the harness/model chips paint under
      s.model ?? '', // model chip text (the harness chip folds via agentName above)
      // Last-message facts the row paints; the growing BODY is deliberately
      // only folded as the bounded preview prefix at the end.
      last ? last.ts : 0, // timeOf clock
      last ? ((last.msgId ?? last.id) as string | number) : '', // latestSpeakable identity for the audio badge
      last ? last.role : '', // 'You: ' prefix + stillSending
      last ? last.kind : '', // voice mic prefix
      last ? statusNum(last.status) + (last.queued ? 8 : 0) : -1, // stillSending -> 'Sending...'
      last?.dedupeKey ? 1 : 0, // reachOf 'session' (delivered) input
      last?.growing ? 1 : 0, // settle edge, cheap safety term
      last?.file ? last.file.fileKind + '|' + last.file.name : '', // attachment preview
      last?.upload ? (last.upload.image ? 'i|' : 'd|') + last.upload.name : '', // upload preview
      last?.uploads?.length ?? 0, // multi-upload safety term
      !mirror && last ? last.text.slice(0, LIST_PREVIEW_CHARS) : '' // the visible preview text
    ].join('\x1f');
  }

  function listSurfaceVersion(): string {
    // The version MUST iterate the SAME row set the renderer paints:
    // renderRows -> projectList -> projectRows (the live membership, or the
    // archive projection while the archive lens is open). The old
    // `!isDead || active` filter left a rendered churnGrey row invisible to
    // the version, so its settle-frame deletion changed nothing and the grey
    // zombie stayed painted; the lens shares the projector for the same reason.
    const base = list.tabSessions();
    const rows = projectRows(base);
    const parts: (string | number)[] = [
      dataState.mode,
      list.listFilter.query,
      window.innerWidth <= 550 ? 1 : 0,
      sessionState.activeId ?? '',
      engine.overlayEnabled() ? 1 : 0,
      sessionState.appConversationMode ? 1 : 0,
      // The archive lens and the archived count: the entry row's label,
      // position and badge paint from these, and the lens can flip with the
      // projected rows byte-identical (one dead session that is also the open
      // chat is BOTH lists), so both must fold or the entry goes stale.
      sessionState.archiveOpen ? 1 : 0,
      projectArchive(base).length
    ];
    for (const s of rows) parts.push(listRowVersion(s));
    return parts.join('\n');
  }

  function chatSurfaceVersion(): string {
    const s = active();
    const d = engine.globalSettings();
    return [
      dataState.mode,
      sessionState.activeId ?? '',
      deps.mainColumns.dataset.view ?? '',
      s ? cvOf(s) : 'none',
      d.replyLevel,
      d.complexity,
      d.verbosityOn ? 1 : 0,
      d.complexityOn ? 1 : 0,

      s ? composerJson(engine.pluginsOf((s as CycEngineSession).engineKey)) : '',
      s ? (engine.overlayOn(s.id) ? 1 : 0) : 0,
      s ? (isDead(s) ? 1 : 0) : 0,
      s ? (reachable(s) ? 1 : 0) : 0,
      s ? (engine.voiceEngineHealthy(s.id) ? 1 : 0) : 0,
      tp.speedLabelOf(engine.effectiveSpeed()),
      s ? tp.cronCountOf(s.id) : 0,
      s ? (sessionState.chatConversationMode.has(s.id) ? 1 : 0) : 0,
      sessionState.appConversationMode ? 1 : 0
    ].join('\x1f');
  }

  // The one connectivity fact the chat pane paints from: whether this chat's
  // engine can take a frame right now. Test-mode fixtures have no engine.
  const reachable = (s: CycSession) =>
    dataState.mode !== 'live' || engine.engineReachable((s as CycEngineSession).engineKey);

  // Under ?testhooks=1 every paint leaves a performance.measure: 'cyc.render'
  // for the whole render and 'cyc.paint.chat' for the chat surface, so a spec
  // can read per-event paint cost off the timeline without touching the code.
  const measurePaints = !!new URLSearchParams(location.search).get('testhooks');
  let paintSeq = 0;
  function measured<T>(name: string, fn: () => T): T {
    if (!measurePaints) return fn();
    const mark = `${name}#${++paintSeq}`;
    performance.mark(mark);
    try {
      return fn();
    } finally {
      performance.measure(name, mark);
      performance.clearMarks(mark);
    }
  }

  let renderDirty = false;
  let renderSettleArmed = false;
  function render(fromStore = false) {
    // One memo table per render pass: every contentVersion(s) read below reuses
    // the first hash of that session for the rest of this synchronous render.
    cvMemo = new Map();
    try {
      measured('cyc.render', () => renderInner(fromStore));
    } finally {
      cvMemo = null;
    }
  }
  function renderInner(fromStore: boolean) {
    renderCount++;

    if (fromStore && interactionWindow.active('gesture')) {
      renderDirty = true;
      if (!renderSettleArmed) {
        renderSettleArmed = true;
        interactionWindow.onSettle(() => {
          renderSettleArmed = false;
          if (renderDirty) {
            renderDirty = false;
            render();
          }
        });
      }
      return;
    }

    const force = !fromStore;

    deps.syncNavUrl();
    list.updateBadge();
    paintSurface('tabs', tabsSurfaceVersion(), list.renderTabs, force);
    tp.updateJumpBar();

    list.paintLimits();

    paintSurface('list', listSurfaceVersion(), () => renderRows(force), force);
    list.floatingAction.classList.toggle('cyc-conv-on', sessionState.appConversationMode);
    paintSurface(
      'chat',
      chatSurfaceVersion(),
      () => measured('cyc.paint.chat', renderChatPane),
      force
    );
  }

  // Structural signature of the chat pane's DOM inputs, deliberately excluding
  // the growing tail's volatile body. The three auxiliary scans below
  // (hydrateWaveforms, stickyDates.refresh, updateMessagePlays) walk the
  // message-list DOM -- querySelectorAll sweeps, and for stickyDates a forced
  // synchronous layout -- on every chat paint. During a streaming reply the
  // chat surface repaints every animation frame because the growing tail's body
  // bumps contentVersion each chunk. A pure body-append to the tail cannot add a
  // voice clip, move a date chip or the unread divider, or add a play row, so
  // its volatile fields are the one thing we drop from the key: the scans then
  // re-run only when a structural input could actually have moved.
  const statusNum = (st?: string): number =>
    st === 'sending' ? 1 : st === 'sent' ? 2 : st === 'delivered' ? 3 : st === 'failed' ? 4 : 0;
  function chatScanKey(
    s: CycSession,
    overlayActive: boolean,
    events: CycSessionEvent[] | undefined
  ): string {
    const msgs = s.messages ?? [];
    const n = msgs.length;
    let fold = 0;
    for (let i = 0; i < n; i++) {
      const m = msgs[i] as CycMessage & {growing?: boolean; msgId?: string};
      const growing = m.growing === true;
      const tailGrowing = i === n - 1 && growing;
      // The id is a durable string now: fold it in char by char so a change of
      // identity still perturbs the fingerprint.
      for (let k = 0; k < m.id.length; k++) fold = (Math.imul(fold, 31) + m.id.charCodeAt(k)) | 0;
      fold = (Math.imul(fold, 31) + (m.ts | 0)) | 0;
      fold = (Math.imul(fold, 31) + (m.kind === 'voice' ? 2 : 1)) | 0;
      fold = (Math.imul(fold, 31) + statusNum(m.status) + (m.queued ? 8 : 0)) | 0;
      fold = (Math.imul(fold, 31) + (growing ? 7 : 0)) | 0;
      fold = (Math.imul(fold, 31) + (m.upload ? 1 : 0) + (m.uploads?.length ?? 0)) | 0;
      fold = (Math.imul(fold, 31) + (m.file ? 1 : 0)) | 0;
      fold = (Math.imul(fold, 31) + (m.clipLost ? 1 : 0)) | 0;
      fold = (Math.imul(fold, 31) + (m.wordsPending ? 1 : 0) + (m.transcriptPending ? 2 : 0)) | 0;
      fold = (Math.imul(fold, 31) + (m.draftCommitted === undefined ? -1 : m.draftCommitted)) | 0;
      // msgId adoption (a voice upload's resume path sets it with no other
      // folded field moving) is the moment a clip becomes hydratable and
      // addressable by data-msg-id; a presence bit re-keys the scans for it.
      fold = (Math.imul(fold, 31) + (m.msgId ? 1 : 0)) | 0;
      // The growing tail's body length, clip duration, and in-flight send
      // progress churn every frame while the reply streams or a clip records or
      // uploads. They change only the tail bubble's own content/height; nothing
      // paints below it, so they cannot move a clip row, date chip, divider, or
      // play button. Fold them for every other row, skip them for the growing
      // tail so streaming does not re-key the scans.
      if (!tailGrowing) {
        fold = (Math.imul(fold, 31) + (m.text ? m.text.length : 0)) | 0;
        fold = (Math.imul(fold, 31) + (m.durationS ? m.durationS | 0 : 0)) | 0;
        // Send progress: presence only, mirroring the row signature. The
        // per-chunk value patches one text node in place (renderMessages) and
        // rebuilds nothing, so it cannot move a clip row, chip, or divider.
        fold = (Math.imul(fold, 31) + (typeof m.sendPct === 'number' ? 1 : 0)) | 0;
      }
    }
    // The scans' true input is the DOM node set, and renderMessages rebuilds
    // nodes on inputs the message fold alone misses. Fold those too:
    // - the TUI overlay swaps event rows in and out; when it is active each
    //   event's ts and kind are folded so an arriving event (or the interrupt
    //   reorder, which reorders by these same inputs) re-keys.
    let evFold = 0;
    if (overlayActive && events) {
      for (const ev of events) {
        evFold = (Math.imul(evFold, 31) + (ev.ts | 0)) | 0;
        const k = ev.kind;
        for (let j = 0; j < k.length; j++) evFold = (Math.imul(evFold, 31) + k.charCodeAt(j)) | 0;
      }
    }
    // firstUnread fixes the divider's position; mode gates hydrateWaveforms
    // (which no-ops off live). The window origin covers history pagination and
    // jumpToMessage (a moved `from` discards every row frame with the messages
    // unchanged); the DOM epoch covers clearMessages and the empty-wipe
    // teardowns, which rebuild the node set with no store change at all.
    return [
      dataState.mode,
      s.id,
      n,
      fold,
      cs.firstUnread() ?? -1,
      messageWindowFrom(cs.messageListInner),
      messageDomEpoch(),
      overlayActive ? 1 : 0,
      evFold
    ].join('\x1f');
  }
  let lastScanKey: string | null = null;

  function renderChatPane() {
    const s = active();

    deps.composer.setPluginWidgets(s ? list.pluginComposerWidgets(s as CycEngineSession) : []);
    deps.whole.classList.toggle('cyc-no-thread', !s);

    deps.askPanel.update(
      s?.ask,
      (s as CycEngineSession | null)?.askUnknown === true,
      s?.id ?? null
    );
    tp.updateAgentsBar();
    if (!s) {
      tp.header.setVoiceState(null);
      tp.refreshModelBadge(null);
      tp.refreshCronBadge(null);
      cs.hideChatBusy();
      lastScanKey = null;
      return;
    }

    tp.header.update(s);

    tp.header.setSpeed(tp.speedLabelOf(engine.effectiveSpeed()));

    tp.refreshCronBadge(s);

    tp.refreshModelBadge(s);
    tp.convToggleBtn.classList.toggle('cyc-conv-on', sessionState.chatConversationMode.has(s.id));

    deps.composer.setDisabled(dataState.mode === 'live' && isDead(s));

    const voiceOff = dataState.mode === 'live' && !engine.voiceEngineHealthy(s.id);
    deps.composer.setVoiceEnabled(!voiceOff);
    tp.convToggleBtn.toggleAttribute('disabled', voiceOff);

    tp.convToggleBtn.closest('.cyc-mast-slot')?.classList.toggle('cyc-call-disabled', voiceOff);

    const es = s as CycEngineSession;
    const overlayActive = dataState.mode === 'live' && engine.overlayOn(s.id);

    cs.bracketMessageRender(s.id, () => {
      renderMessages(
        cs.messageListInner,
        s,
        audio.onMessagePlay,
        cs.firstUnread(),
        audio.onMessageSeek,
        media.onOpenFileCard,
        overlayActive ? es.events : undefined,

        (m) =>
          m.upload
            ? (localUploadUrl(m.upload.uploadId) ?? engine.uploadUrl(s.id, m.upload.uploadId))
            : '',

        (u) => {
          if (u.image) {
            // The viewer resolves the picture itself: engine URL as the cache
            // key, the local object URL looked up live, then the wire.
            media.openAlbumAt(uploadKey(u.uploadId), {
              url: engine.uploadUrl(s.id, u.uploadId),
              name: u.name,
              local: () => localUploadUrl(u.uploadId)
            });
            return;
          }
          const url = localUploadUrl(u.uploadId) ?? engine.uploadUrl(s.id, u.uploadId);
          media.openDocAttachment(u.name, url, u.mime);
        },
        (m) => (m.file ? engine.docUrl(s.id, m.file.docId) + '/raw' : ''),

        cs.renderEarlier,

        (_m, u) => localUploadUrl(u.uploadId) ?? engine.uploadUrl(s.id, u.uploadId)
      );
    });

    // The open's first paint is the one the store settled (the cache, or the
    // engine's replay); a render before that shows leftovers, not the open.
    if (
      cs.openPaintIsPending() &&
      dataState.mode === 'live' &&
      sessionState.activeId === s.id &&
      es.paintSource
    ) {
      cs.clearOpenPaint();
      const painted = s.messages;
      // Order check: the chat must read oldest to newest. Name the first place
      // it does not, with enough of each row to trace (2026-09-24: August rows
      // painted after today's on two devices; a fresh client was fine).
      const inv = painted.findIndex((m, i) => i > 0 && m.ts < painted[i - 1].ts);
      if (inv > 0) {
        const brief = (m: (typeof painted)[number]) => ({
          ts: m.ts,
          seq: (m as {seq?: number}).seq ?? null,
          id: String((m as {id?: string}).id ?? '').slice(0, 24),
          mid: (m as {mid?: string}).mid ?? null,
          cid: (m as {cid?: string}).cid ?? null,
          role: m.role
        });
        cyclog('chat.order.broken', {
          session: s.id,
          at: inv,
          count: painted.length,
          inversions: painted.filter((m, i) => i > 0 && m.ts < painted[i - 1].ts).length,
          before: JSON.stringify(brief(painted[inv - 1])),
          after: JSON.stringify(brief(painted[inv]))
        });
      }
      cyclog('chat.painted', {
        session: s.id,
        source: es.paintSource,
        count: painted.length,
        range: [
          painted.length ? painted[0].ts : 0,
          painted.length ? painted[painted.length - 1].ts : 0
        ],
        ms: Date.now() - cs.openPaintStartedAt()
      });
    }

    const waiting = dataState.mode === 'live' && !es.notOnEngine && !!es.historyPending;

    if (waiting && !cs.messageListInner.childElementCount) cs.showChatBusy();
    else cs.hideChatBusy();

    // The scans re-run only when a structural input could have moved. A pure
    // body-append to the growing tail leaves the key unchanged, so a streaming
    // reply no longer pays these DOM sweeps and forced layout every frame. The
    // scroll-driven stickyDates path (attachStickyDates' own scroll listener) is
    // untouched: scroll still refreshes the date-chip veil.
    const scanKey = chatScanKey(s, overlayActive, es.events);
    if (scanKey !== lastScanKey) {
      lastScanKey = scanKey;
      deps.hydrateWaveforms();
      cs.stickyDates.refresh();
      audio.updateMessagePlays();
    }
    audio.updateVoiceStrip();
    deps.profile.update(s);
    deps.profile.setCronCount(tp.cronCountOf(s.id));
    deps.profile.setEngineReachable(reachable(s));
    refreshProfileAttachments();
  }

  function refreshProfileAttachments() {
    if (deps.mainColumns.dataset.view !== 'profile') return;
    deps.profile.setMedia(media.sessionAttachments());
  }

  if (new URLSearchParams(location.search).get('testhooks')) {
    (window as never as {__cycProfileAttachments: () => CycMediaItem[]}).__cycProfileAttachments =
      () => media.sessionAttachments();

    (window as never as {__cycSpeakUnheard: (id: string) => void}).__cycSpeakUnheard = (
      id: string
    ) => cs.speakUnheard(id);

    (window as never as {__cycRenderRows: () => void}).__cycRenderRows = () => renderRows();
  }

  // Coming back live (not the first time): read out what arrived unheard
  // while the pipe was down, once the reconnect replay has settled.
  let wasLive = false;
  let everLive = false;
  let reconnectSpeakTimer: ReturnType<typeof setTimeout> | null = null;
  engine.onSyncStatus((st) => {
    if (st !== 'live') {
      wasLive = false;
      return;
    }
    if (wasLive) return;
    wasLive = true;
    if (!everLive) {
      everLive = true;
      return;
    }
    if (reconnectSpeakTimer) clearTimeout(reconnectSpeakTimer);
    reconnectSpeakTimer = setTimeout(() => {
      if (dataState.mode === 'live' && sessionState.activeId)
        cs.speakUnheard(sessionState.activeId);
    }, 900);
  });

  return {render, renderRows, renderChatPane, refreshProfileAttachments};
}
