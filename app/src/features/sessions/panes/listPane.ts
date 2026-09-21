import type {CycSession} from '../../../types';
import * as engine from '../../../engine/store';
import type {CycEngineSession} from '../../../engine/store';
import {sessionState, dataState} from '../../../sessionState';
import {h} from '../../../components/domHelpers';
import {BTN_HOVER_UTILS, makeIcon, makeIconButton} from '../../../components/iconGlyphs';
import {
  BADGE_COMPACT,
  BADGE_FACE,
  BADGE_MOTION,
  DOT_SM,
  setBadgeCount
} from '@/components/countBadge';
import {PANE_HEADER_UTILS} from '@/features/sessions/components/paneHeader';
import {scrollSurface} from '@/shared/dom';
import {cyclog} from '@/shared/logging';
import {clampNumber} from '@/shared/numbers';
import {relTicker} from '@/shared/relTicker';
import * as interactionWindow from '@/shared/browser';
import {opaqueKey} from '@/features/sessions/navigation';
import {deviceClass} from '@/features/sessions/layout';
import {enginePin} from '../../../engine/contract';
import {sortByLatest, mergeTabs, rowChipShown} from '@/features/settings/preferences';
import {seedKeymapFromServer} from '@/features/settings/preferences';
import {speaker} from '../../../audio/speaker';
import {pipeline} from '../../../audio/pipeline';
import {inputSearch, toast, confirmExitSession} from '../../../components/widgets';
import {openMenu, type CycMenuItem} from '../../../components/popupMenu';
import {createSessionList} from '../components/sessionList';
import {createPluginCard, type PluginCard} from '../../../components/pluginCard';
import {createHintsCard, hintsDismissed} from '../../../components/hintsCard';
import {createAudioPlayerBar} from '@/features/chat/navigation/audioPlayerBar';
import HorizontalSortable from '../controls/tabSort';
import {createPluginCardsPane} from './pluginCardsPane';
import {createPairBanner} from '@/features/pairing/pairBanner';
import {SESSION_STATE_BADGE_BG} from '@/features/sessions/sessionsPaint';
import {paintTheme} from '@/components/presentation';
import {onHorizontalSwipe} from '@/features/gestures';

const TABS_UTILS =
  'relative z-[2] flex h-12 w-full flex-auto items-center justify-evenly gap-2 px-2 py-1 text-[var(--cyc-text-muted)] bg-[var(--cyc-surface)]';
const TAB_UTILS =
  'relative flex h-full min-w-0 max-w-44 flex-auto cursor-pointer items-center justify-center rounded-xl px-2 text-center text-sm font-medium leading-[1.3] [transition:background-color_0.2s_ease-in-out]';
const TAB_HOVER_UTILS =
  'fine:hover:bg-(--cyc-text-muted-tint)! fine:active:bg-(--cyc-text-muted-tint)!';
// Tab-strip swipe thresholds and timing, owned by the list feature. The drag arms
// once travel passes ARM_PX and clearly leads horizontally (by ARM_RATIO); a
// release past COMMIT_PX (or a wheel run accumulating WHEEL_COMMIT_PX) pages to the
// neighbouring tab; SWIPE_ANIM_MS is the slide/settle duration; a wheel run ends
// after WHEEL_QUIET_MS of silence.
const LIST_ARM_PX = 12;
// Pointer/touch tab-swipe commit rule (owned by the gesture wrapper): a release
// past this fraction of the surface width, OR a flick faster than this velocity
// (px/ms), pages to the neighbouring tab; anything short snaps back.
const LIST_COMMIT_PCT = 0.5;
const LIST_FLICK_VELOCITY = 0.5;
const LIST_COMMIT_PX = 60;
const LIST_WHEEL_COMMIT_PX = LIST_COMMIT_PX * 1.5;
const LIST_WHEEL_QUIET_MS = 160;
const LIST_SWIPE_ANIM_MS = 110;
const ACTION_FLOAT_HOVER_UTILS =
  'fine:hover:bg-(--cyc-accent-pressed)! fine:active:bg-(--cyc-accent-pressed)!';
const FAB_DOCK =
  'cyc-ctl-round cyc-action-float absolute z-[1] flex items-center justify-center text-center ' +
  '[--cyc-fab-inset:1.25rem] bottom-[var(--cyc-fab-inset)] end-[var(--cyc-fab-inset)] ' +
  '[transform:translateY(calc(100%+var(--cyc-fab-inset)))] [&.cyc-dock-shown]:[transform:translateY(0)] ' +
  '[transition:transform_0.18s_ease-out] w-12! h-12! rounded-[12px]! text-[1.5rem]!';
const TAB_BG_UTILS =
  'pointer-events-none absolute inset-0 z-[1] rounded-[inherit] bg-[var(--cyc-text-muted-tint)] opacity-0';
const TAB_LABEL_UTILS =
  'relative z-[2] flex items-center min-w-0 overflow-hidden pointer-events-none whitespace-nowrap';
// Owned host-tab pill/dot shared tail: the 5px start gap the un-layered
// `.cyc-seg .cyc-tally` rule used to carry (now authored here) plus `flex-none`.
const TAB_BADGE_TAIL = 'ms-[5px] flex-none';
import type {ComposerPluginWidget} from '@/features/composer/components/messageComposer';
import {
  activeEngineKey,
  sortedLive,
  orderByLatest,
  projectArchive,
  projectRows,
  tabLabelOf,
  isPluginCardEngine,
  visibleTabs
} from '../../../sessionSelectors';

export interface ListPaneDeps {
  onTeardown(d: () => void): void;
  render(): void;
  renderRows(): void;
  openChat(id: string, after?: () => void, opts?: {keepList?: boolean}): void;
  saveDraft(): void;
  loadDraft(id: string | null): void;
  releaseMicIfIdle(): void;
  rowAudioClick(id: string): void;
  openPlayingMessage(): void;
  restored(key: 'host' | 'chat' | 'list' | 'profile' | 'doc'): void;
  cancelPendingOpens(source: string): void;
  restorePending: Set<'host' | 'chat' | 'list' | 'profile' | 'doc'>;
  setView(view: 'list' | 'chat' | 'profile'): void;

  wantedHost(): string | null;
  clearWantedHost(): void;

  forgetProgress(id: string): void;

  paintKeymapFromGlobals(): void;
  mainColumns: HTMLElement;
}

export function createListPane(deps: ListPaneDeps) {
  let updateFabImpl = () => {};

  let rowMenuOpen = false;

  let listPressed = false;
  const resortGuarded = () =>
    rowMenuOpen ||
    listPressed ||
    interactionWindow.active('scroll') ||
    interactionWindow.active('open');

  let frozenOrder: string[] | null = null;
  let resortPending = false;
  const captureFrozen = () => {
    if (sortByLatest() && !frozenOrder) frozenOrder = sortedLive().map((s) => s.id);
  };
  const tabSessions = (): CycSession[] => {
    const sorted = sortedLive();
    if (!sortByLatest() || !resortGuarded()) return sorted;
    if (!frozenOrder) frozenOrder = sorted.map((s) => s.id);
    else if (sorted.map((s) => s.id).join('\0') !== frozenOrder.join('\0')) {
      resortPending = true;
    }

    const rank = new Map(frozenOrder.map((id, i) => [id, i] as const));
    const laOf = new Map(sorted.map((s) => [s.id, s.lastActivity ?? 0] as const));
    const rankOf = (s: CycSession): number => {
      const r = rank.get(s.id);
      if (r !== undefined) return r;
      const la = laOf.get(s.id) ?? 0;
      let moreRecent = 0;
      for (const id of frozenOrder!) if ((laOf.get(id) ?? 0) >= la) moreRecent++;
      return moreRecent - 0.5;
    };
    return sorted.slice().sort((a, b) => rankOf(a) - rankOf(b));
  };

  const flushResort = () => {
    if (resortGuarded()) return;
    frozenOrder = null;
    if (resortPending) {
      resortPending = false;
      deps.renderRows();
    }
  };

  const projectList = (
    tabId: string | undefined
  ): {rows: CycSession[]; cards: {hints: boolean}} => {
    const ordered =
      tabId === (sessionState.activeTabId ?? undefined)
        ? tabSessions()
        : orderByLatest(engine.list(tabId));

    // projectRows applies the archive lens: live membership normally, the
    // dead-session archive while sessionState.archiveOpen. No hints card in
    // the archive; it is a reading room, not the home list.
    return {
      rows: projectRows(ordered),
      cards: {hints: !sessionState.archiveOpen && !hintsDismissed()}
    };
  };

  const leftMain = h('div', 'cyc-left-main flex h-full flex-col');
  const leftHeader = h(
    'div',
    // The list header also fades opacity alongside its background (was shell.css
    // `#cyc-left-pane .cyc-stack-header`); `!` re-widens the PANE_HEADER_UTILS transition.
    // A single column that holds only the burger+search row now: the connectivity
    // word moved out of the header to a bottom overlay band (see syncStatusEl below).
    // `justify-center!` beats PANE_HEADER_UTILS' inherited `justify-between`: with
    // the sync strip gone the row is the header's only child, so centering it in the
    // 3.5rem header (below the safe-area top pad) gives even space above and below
    // the search row instead of the old top-heavy pt-2 bias.
    'cyc-pane-header cyc-stack-header opacity-100 flex-col! items-stretch! justify-center! ' +
      '[transition:background-color_0.3s_cubic-bezier(0.32,0.72,0,1),opacity_0.3s_cubic-bezier(0.32,0.72,0,1)]! ' +
      PANE_HEADER_UTILS
  );
  // The burger + search row. No top bias: the header centers it vertically so the
  // padding above and below the search is even (was a top-heavy pt-2).
  const headerRow = h('div', 'flex w-full items-center gap-2');
  const btnContainer = h('div', 'cyc-pane-header-btns');
  const burger = makeIconButton('menu', 'cyc-pane-menu-btn');
  btnContainer.append(burger);
  const listFilter = {query: ''};

  // The searchable text of a row; MUST match what the list rows display.
  const sessionHaystack = (s: CycSession): string =>
    `${s.name} ${s.title?.text ?? ''} ${s.title?.detail ?? ''}`;

  // EXACTLY the rows the list paints, in painted order: the active tab's
  // membership projection (projectList -> projectMembership) narrowed by the
  // search filter. Both the renderer (renderRows) and the keyboard nav MUST
  // derive from this one function so the two sets can never drift; nav over
  // any broader set (e.g. raw tabSessions) steps onto unlisted sessions.
  // Pass precomputed projected rows to skip recomputing the projection.
  const visibleSessions = (projectedRows?: CycSession[]): CycSession[] => {
    const rows = projectedRows ?? projectList(sessionState.activeTabId ?? undefined).rows;
    const q = listFilter.query;
    if (!q) return rows;
    return rows.filter((s) => sessionHaystack(s).toLowerCase().includes(q));
  };
  const search = inputSearch(
    'Search',
    (value) => {
      listFilter.query = value.trim().toLowerCase();
      deps.render();
    },
    {plain: true}
  );
  headerRow.append(btnContainer, search);

  // The one connectivity word (offline design v3): no longer a reserved strip in
  // the header. It rides as a slim full-width band PINNED TO THE BOTTOM of the
  // list, OVERLAYING the rows (position it over the content, out of flow, so it
  // reserves NO height anywhere and the list never jumps). It is present only when
  // there is a status to show (not-live) and slides/fades away when live. It is
  // pointer-events-none so it never steals the new-session (+) button or the last
  // row's tap target, and it sits just above the bottom safe-area. Appended to
  // leftContent (below) so the (+) FAB, added later, paints over it.
  const syncStatusEl = h(
    'div',
    'cyc-sync-status pointer-events-none absolute inset-x-0 bottom-0 z-[1] ' +
      'text-center text-[0.75rem] leading-[1.2] whitespace-nowrap text-[var(--cyc-text-muted)] ' +
      'pt-1.5 pb-[calc(0.375rem+var(--cyc-safe-bottom))] ' +
      'bg-[color-mix(in_srgb,var(--cyc-surface)_92%,transparent)] ' +
      '[transition:opacity_0.28s_cubic-bezier(0.32,0.72,0,1),transform_0.28s_cubic-bezier(0.32,0.72,0,1)] ' +
      'motion-reduce:[transition:none] ' +
      '[&.cyc-sync-live]:opacity-0 [&.cyc-sync-live]:[transform:translateY(100%)]'
  );
  const paintSyncStatus = () => {
    const st = dataState.mode === 'live' ? engine.syncStatus() : 'live';
    const text = st === 'live' ? '' : st;
    syncStatusEl.textContent = text;
    // Absent (slid + faded down out of the clipped pane) while live; present only
    // when there is a word to show, so no reserved space and nothing jumps.
    syncStatusEl.classList.toggle('cyc-sync-live', text === '');
  };
  paintSyncStatus();
  deps.onTeardown(engine.onSyncStatus(paintSyncStatus));

  leftHeader.append(headerRow);

  const restart = async (id: string, name: string) => {
    toast(`Restarting ${name}…`);
    const res = await engine.restartSession(id);
    if (!res) {
      toast(`Could not reach the host ${name} is on.`, 8000);
      return;
    }
    toast(res.say, res.confirmed ? 3000 : 8000);
  };

  const openNewSessionMenu = (e: MouseEvent, trigger: HTMLElement) => {
    const key = activeEngineKey();
    if (!key || dataState.mode !== 'live') {
      toast('Needs a live engine');
      return;
    }
    // The folders AND the recently-closed agents, both fetched as the menu
    // opens. recentlyClosed is best-effort: the store answers [] on any failure,
    // and the guard keeps an older mocked store (no such method) from throwing.
    void Promise.all([
      engine.newSessionPlaces(key),
      engine.recentlyClosed ? engine.recentlyClosed(key) : Promise.resolve([])
    ]).then(([got, closed]) => {
      if (!got) {
        toast('Could not reach the engine to list folders; try again');
        return;
      }
      const {places, home, def} = got;
      // Old engine omits these; the store parses absent -> [], but the mocked
      // store in tests can hand back the old shape, so default defensively.
      const harnesses = got.harnesses ?? [];
      const recent = got.recent ?? [];
      const near = () => (tabSessions()[0] as CycEngineSession | undefined)?.paneId;
      // Shared post-start landing: wait for the new/reopened session to appear,
      // then open its chat. `where` names the folder for the timeout toast.
      const landStarted = (
        started: {paneId: string; agentId: string; why: string; notInstalled?: boolean},
        where: string
      ) => {
        const {paneId, agentId, why, notInstalled} = started;
        if (!paneId) {
          // A typed harness-missing refusal (engine session-ops) carries a ready
          // human sentence ("claude is not installed on this host"); show it as
          // is. Other failures keep the generic "Could not start it" prefix.
          toast(notInstalled ? why : 'Could not start it: ' + why);
          return;
        }
        let tries = 0;
        const land = () => {
          const found = agentId
            ? engine.list().find((s) => s.engineKey === key && s.sessionAgentId === agentId)
            : engine.tabs().length
              ? engine.get(`${key}|${paneId}`)
              : undefined;
          if (found) {
            deps.openChat(found.id);
            return;
          }
          if (++tries < 30) {
            setTimeout(land, 400);
            return;
          }
          toast('Started it in ' + where + ', but it has not appeared here yet');
        };
        land();
      };
      const startIn = (cwd: string, harness?: string) => {
        toast('Starting a session…');
        void engine.startSession(key, cwd, near(), harness).then((s) => landStarted(s, cwd));
      };
      // Reopen a recently-closed agent under its OLD id: cwd and harness come
      // from the agent's meta, so neither is chosen here; resume replays its
      // conversation.
      const reopenClosed = (entry: {agentId: string; cwd: string}) => {
        toast('Reopening…');
        void engine
          .startSession(key, entry.cwd, near(), undefined, {agentId: entry.agentId, resume: true})
          .then((s) => landStarted(s, entry.cwd));
      };

      const labelOf = (cwd: string) => cwd.split('/').filter(Boolean).slice(-2).join('/') || cwd;

      // Step 2: the folder menu. Same lead/Home/live rows as before, plus a
      // "Recent" section for folders remembered from the engine's pane-binding
      // history. The chosen harness (if any) rides through startIn.
      const openFolderMenu = (ev: MouseEvent, harness?: string) => {
        const lead = def && def !== home ? def : null;
        const asRow = (cwd: string) => ({
          icon: 'newConversation' as const,
          text: labelOf(cwd),
          onClick: () => startIn(cwd, harness)
        });
        const items: CycMenuItem[] = lead
          ? [
              {
                icon: 'folder' as const,
                text: labelOf(lead),
                onClick: () => startIn(lead, harness)
              },

              ...places.filter((cwd) => cwd !== lead).map(asRow)
            ]
          : [
              ...(home
                ? [
                    {
                      icon: 'folder' as const,
                      text: 'Home',
                      onClick: () => startIn(home, harness)
                    }
                  ]
                : []),
              ...places.filter((cwd) => cwd !== home).map(asRow)
            ];
        if (recent.length) {
          items.push({section: true, text: 'Recent', onClick: () => {}});
          for (const cwd of recent) {
            items.push({
              icon: 'folder' as const,
              text: labelOf(cwd),
              onClick: () => startIn(cwd, harness)
            });
          }
        }
        // "Recently closed" sits ABOVE the folder rows: a dumb list of dead
        // agents this engine owns, each reopened under its old identity on tap.
        // No delete/edit, no pagination. Skipped entirely when the fetch was
        // empty or failed (closed is [] there).
        if (closed.length) {
          const closedRows: CycMenuItem[] = [
            {section: true, text: 'Recently closed', onClick: () => {}}
          ];
          for (const entry of closed) {
            const base = entry.cwd.split('/').filter(Boolean).pop() ?? entry.cwd;
            closedRows.push({
              icon: 'newConversation' as const,
              text: [entry.name, entry.harness, base].filter(Boolean).join(' · '),
              onClick: () => reopenClosed(entry)
            });
          }
          items.unshift(...closedRows);
        }
        if (!items.length) {
          toast('No known directories on this host');
          return;
        }
        openMenu(items, ev, {triggerElement: trigger});
      };

      // Step 1 (conditional): only offer a harness step when 2+ are installed.
      const avail = harnesses.filter((h) => h.available);
      if (harnesses.length && !avail.length) {
        // A current engine reported its harness list and NOTHING is installed:
        // any start would only be refused (the engine probes PATH before it
        // spawns), so name the real fix instead of offering folders.
        toast('Install a coding harness first: claude code, codex, opencode or pi');
        return;
      }
      if (avail.length <= 1) {
        // 0 available (old engine) -> undefined -> engine default (claude);
        // exactly 1 -> that kind, same outcome as the default.
        openFolderMenu(e, avail[0]?.kind);
        return;
      }
      const LABELS: Record<string, string> = {
        claude: 'Claude',
        codex: 'Codex',
        opencode: 'OpenCode',
        pi: 'Pi'
      };
      const harnessRows = avail.map((h) => ({
        text: LABELS[h.kind] ?? h.kind,
        // MANDATORY DEFERRAL: popupMenu's item click runs onClick THEN closeMenu,
        // and openMenu sets currentMenu to the new menu; opening the folder menu
        // synchronously here would get it closed immediately. Defer to next tick.
        onClick: (ev: MouseEvent | TouchEvent) => {
          setTimeout(() => openFolderMenu(ev as MouseEvent, h.kind), 0);
        }
      }));
      openMenu(harnessRows, e, {triggerElement: trigger});
    });
  };

  const tabsWrap = h(
    'div',
    'cyc-segstrip-scroll cyc-host-tabs-wrap cyc-off mt-2 mx-2 mb-0 flex h-12 flex-none overflow-hidden rounded-3xl bg-[var(--cyc-surface)] shadow-[0px_2px_6px_0px_rgba(17,20,26,0.09)]'
  );
  const tabsMenu = h('nav', 'cyc-shared-tabs cyc-segstrip cyc-host-tabs ' + TABS_UTILS);
  tabsWrap.append(tabsMenu);
  type TabParts = {
    tab: HTMLElement;
    label: HTMLElement;
    badgeEl: HTMLElement;
    dotEl: HTMLElement;
    pinEl: HTMLElement;
  };
  const tabEls = new Map<string, TabParts>();
  const ensureTabEl = (key: string): TabParts => {
    let parts = tabEls.get(key);
    if (parts) return parts;

    // .cyc-seg-disconnected {opacity:0.55}` (self product-state class).
    const tab = h(
      'div',
      'cyc-seg [&.cyc-seg-disconnected]:opacity-[0.55] ' + TAB_HOVER_UTILS + ' ' + TAB_UTILS
    );
    const bg = h('i', 'cyc-seg-bg ' + TAB_BG_UTILS);
    const span = h('div', 'cyc-seg-label ' + TAB_LABEL_UTILS);
    const label = h(
      'span',
      '[display:inline-table] flex-[0_1_auto] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap'
    );

    const pinEl = makeIcon('lock', 'cyc-seg-pin cyc-off text-[0.8em] me-[0.28rem] opacity-75');

    const dotEl = h(
      'div',
      'cyc-seg-activity ' + DOT_SM + ' rounded-full bg-[var(--cyc-text-muted)] ' + TAB_BADGE_TAIL
    );
    dotEl.hidden = true;
    paintTheme(dotEl, (t) => {
      dotEl.style.backgroundColor = SESSION_STATE_BADGE_BG[t];
    });
    const badgeEl = h(
      'div',
      'cyc-seg-count ' +
        BADGE_COMPACT +
        ' ' +
        BADGE_FACE +
        ' ' +
        BADGE_MOTION +
        ' bg-[var(--cyc-accent)]! ' +
        TAB_BADGE_TAIL
    );
    badgeEl.hidden = true;
    span.append(pinEl, label, dotEl, badgeEl);
    tab.append(bg, span);
    tab.addEventListener('click', () => switchTab(key));
    tabsMenu.append(tab);
    parts = {tab, label, badgeEl, dotEl, pinEl};
    tabEls.set(key, parts);
    return parts;
  };
  function renderTabs() {
    const infos = visibleTabs();

    const wanted = deps.wantedHost();
    if (infos.length && wanted) {
      const match = infos.find((i) => opaqueKey(i.id) === wanted);
      deps.clearWantedHost();
      if (match) sessionState.activeTabId = match.id;
      else {
        cyclog('nav.host.unknown', {
          why: 'the URL named a host this fleet does not have, so the first one is selected'
        });
      }
      deps.restored('host');
    }

    if (infos.length && !sessionState.activeTabId) sessionState.activeTabId = infos[0].id;

    if (
      infos.length &&
      sessionState.activeTabId &&
      !infos.some((i) => i.id === sessionState.activeTabId)
    ) {
      const engineKey = sessionState.activeTabId.split('#')[0];
      const sameEngine = infos.find((i) => i.id.split('#')[0] === engineKey);
      sessionState.activeTabId = (sameEngine ?? infos[0]).id;
    }

    const pinned = dataState.mode === 'live' ? enginePin() : null;

    const show = !mergeTabs() && (infos.length > 1 || (!!pinned && infos.length > 0));
    tabsWrap.classList.toggle('cyc-off', !show);
    tabsWrap.classList.toggle('cyc-host-tabs-pinned', !!pinned);

    if (!show) {
      for (const [id, parts] of tabEls) {
        parts.tab.remove();
        tabEls.delete(id);
      }
      return;
    }
    for (const [at, info] of infos.entries()) {
      const parts = ensureTabEl(info.id);
      parts.label.textContent = info.label;

      parts.pinEl.classList.toggle('cyc-off', !pinned || at > 0);
      parts.tab.classList.toggle('active', info.id === sessionState.activeTabId);

      parts.tab.classList.toggle('cyc-seg-disconnected', info.state !== 'connected');

      parts.tab.title = [
        info.detail ?? '',
        info.state === 'connected' ? '' : `engine ${info.state}`,
        pinned ? `pinned to ${pinned}: Settings has the way out` : ''
      ]
        .filter(Boolean)
        .join(' - ');

      parts.dotEl.hidden = !info.activity || info.unread > 0;
      setBadgeCount(parts.badgeEl, info.unread);
    }

    if (!tabsMenu.classList.contains('cyc-reordering')) {
      infos.forEach((info, i) => {
        const el = tabEls.get(info.id)!.tab;
        if (tabsMenu.children[i] !== el) tabsMenu.insertBefore(el, tabsMenu.children[i] ?? null);
      });

      for (const [id, parts] of tabEls) {
        if (infos.some((i) => i.id === id)) continue;
        parts.tab.remove();
        tabEls.delete(id);
      }
    }
  }

  new HorizontalSortable({
    list: tabsMenu,
    dragClasses: 'z-2! shadow-[0_2px_8px_rgba(0,0,0,0.2)]! bg-(--cyc-surface)!',
    onSort: () => {
      const ids: string[] = [];
      for (const el of Array.from(tabsMenu.children)) {
        for (const [id, parts] of tabEls) if (parts.tab === el) ids.push(id);
      }
      engine.reorderTabs(ids);
      deps.render();
    }
  });

  tabsMenu.addEventListener(
    'pointerdown',
    (e) => {
      const hitTab = (e.target as HTMLElement).closest?.('.cyc-seg');
      let hitId = 'gap';
      if (hitTab) for (const [id, parts] of tabEls) if (parts.tab === hitTab) hitId = id;
      cyclog('nav.press', {
        control: 'tabstrip',
        hit: hitId,
        x: Math.round(e.clientX),
        tabs: Array.from(tabEls.values())
          .map((p) => {
            const r = p.tab.getBoundingClientRect();
            return `${Math.round(r.left)}-${Math.round(r.right)}`;
          })
          .join(',')
      });
    },
    {capture: true}
  );

  const tabNeighbour = (dir: 1 | -1): string | null => {
    if (mergeTabs()) return null;
    const infos = visibleTabs();
    if (infos.length < 2) return null;
    const at = infos.findIndex((i) => i.id === sessionState.activeTabId);
    const to = (at < 0 ? 0 : at) + dir;
    return to >= 0 && to < infos.length ? infos[to].id : null;
  };
  const swipeToTab = (dir: 1 | -1) => {
    const id = tabNeighbour(dir);
    if (id) switchTab(id, {src: 'swipe'});
  };
  function switchTab(tabId: string, opts?: {stayOnList?: boolean; src?: string}) {
    const src = opts?.src ?? 'tap';
    const tabList = visibleTabs();
    const tabState = tabList.find((i) => i.id === tabId)?.state ?? 'unknown';
    if (sessionState.activeTabId === tabId) {
      cyclog('nav.tap', {
        control: 'tab',
        tab: tabId,
        src,
        tabState,
        decision: 'already-active',
        rendered: 'none'
      });
      return;
    }

    deps.cancelPendingOpens('tab');
    deps.restored('host');
    sessionState.activeTabId = tabId;

    const sel = sessionState.tabSelection.get(tabId);
    if (sel && engine.get(sel)) {
      const sideBySide = deviceClass() === 'laptop';
      if (!sideBySide || opts?.stayOnList) {
        cyclog('nav.tap', {
          control: 'tab',
          tab: tabId,
          src,
          tabState,
          decision: opts?.stayOnList ? 'stay-on-list' : 'list-only',
          rendered: 'list',
          session: sel
        });
        deps.setView('list');
        deps.render();
        return;
      }

      cyclog('nav.tap', {
        control: 'tab',
        tab: tabId,
        src,
        tabState,
        decision: 'restore-chat-keep-list',
        rendered: 'list',
        session: sel
      });
      deps.openChat(sel, undefined, {keepList: true});
      return;
    }

    deps.saveDraft();
    deps.loadDraft(null);
    sessionState.activeId = null;

    deps.restorePending.delete('chat');
    deps.restorePending.delete('list');
    localStorage.removeItem('cyc-engaged');
    engine.detachChat();
    if (pipeline.handsFreeSessionId) pipeline.disableHandsFree();
    deps.releaseMicIfIdle();
    cyclog('nav.tap', {
      control: 'tab',
      tab: tabId,
      src,
      tabState,
      decision: 'close-to-list',
      rendered: 'list'
    });
    deps.setView('list');
    deps.render();
  }

  let badgeShown = -1;
  function updateBadge() {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (!nav.setAppBadge) return;

    const waiting =
      dataState.mode === 'live'
        ? engine.list().reduce((n, x) => n + Math.max(0, x.unread ?? 0), 0)
        : 0;
    if (waiting === badgeShown) return;
    badgeShown = waiting;
    void (waiting ? nav.setAppBadge(waiting) : nav.clearAppBadge?.()).catch(() => {});
  }

  try {
    localStorage.removeItem('cyc-usage-card');
  } catch {}

  const {paintPluginCards, paintLimits, refreshUsage, markUsageReady, retainedAnswer, flashCards} =
    createPluginCardsPane({
      mountPoints: () => ({container: sessionListTop, anchor: sessionList.el})
    });

  const pluginComposerWidgets = (s: CycEngineSession): ComposerPluginWidget[] => {
    const out: ComposerPluginWidget[] = [];
    for (const p of engine.pluginsOf(s.engineKey)) {
      for (const w of p.composer ?? []) {
        out.push(
          w.type === 'slider'
            ? {
                widget: w,
                onSet: (n: number) => {
                  if (p.id === 'reply-dials') {
                    queueMicrotask(() => void engine.setReplyDial(w.key, n));
                  } else {
                    void engine.pluginRpc(s.engineKey, p.id, 'set', s.paneId, {key: w.key, n});
                  }
                }
              }
            : {widget: w}
        );
      }
    }
    return out;
  };
  if (dataState.mode === 'live') {
    engine.startSettingsSync();

    void seedKeymapFromServer().then(() => deps.paintKeymapFromGlobals());
    void refreshUsage();

    const limitsTimer = window.setInterval((): void => {
      if (!document.hidden) void refreshUsage();
    }, 5 * 60_000);
    deps.onTeardown(() => clearInterval(limitsTimer));
    const limitsOnVisible = () => {
      if (!document.hidden) void refreshUsage();
    };
    document.addEventListener('visibilitychange', limitsOnVisible);
    deps.onTeardown(() => document.removeEventListener('visibilitychange', limitsOnVisible));

    // Relative-time upkeep runs on the one shared ticker (paused while hidden),
    // and only when a label could actually change. The rows carry a live age
    // only while a session is thinking (its `turnSince` label), so an all-idle
    // list ticks nothing; the usage card's "Nm ago" moves once a minute.
    deps.onTeardown(
      relTicker().register({
        value: () =>
          tabSessions().some((s) => s.turnSince) ? String(Math.floor(Date.now() / 60_000)) : 'idle',
        paint: () => deps.renderRows()
      })
    );
    deps.onTeardown(
      relTicker().register({
        value: () => String(Math.floor(Date.now() / 60_000)),
        paint: () => paintLimits()
      })
    );
  }

  const notifyOn = (sessionId: string) => {
    const s =
      dataState.mode === 'live'
        ? engine.get(sessionId)
        : (dataState.demoSessions.find((d) => d.id === sessionId) as CycEngineSession | undefined);
    return engine.effectiveNotify(s);
  };

  const leftContent = h(
    'div',
    'cyc-pane-content cyc-left-content relative flex min-h-0 flex-auto flex-col h-full max-h-full w-full overflow-hidden'
  );
  const sessionList = createSessionList({
    sessions: tabSessions(),
    activeId: sessionState.activeId,

    activityMark: (s) => engine.activityMark(s),

    notifyOn,

    mergedSubtitle: (s) => (mergeTabs() ? tabLabelOf(s.id) : null),

    // Harness and model chips paint in every list (merged or per-host),
    // each behind its own settings toggle. No chip when the fact is absent
    // (an older engine, or a model not yet known). Only the HOST chip
    // (mergedSubtitle above) keeps the merged-only rule.
    harnessChip: (s) => (rowChipShown('harness') ? (s.agentName ?? null) : null),

    modelChip: (s) => (rowChipShown('model') ? (s.model ?? null) : null),

    onOpen: (id) =>
      sessionState.appConversationMode && dataState.mode === 'live'
        ? deps.rowAudioClick(id)
        : deps.openChat(id),

    onEnter: (id) => deps.openChat(id),

    canReorder: () => dataState.mode === 'live' && !sortByLatest(),

    onReorder:
      dataState.mode === 'live'
        ? (ids) => {
            void (mergeTabs() ? engine.setMergedListOrder(ids) : engine.reorderSessions(ids));
          }
        : undefined,
    onRowMenu: (id, at) => {
      const s = engine.get(id);
      if (!s || dataState.mode !== 'live') return;

      // Restart and exit run on the engine itself (no intent carries them):
      // grey, with the reason, while it cannot be reached.
      const needsEngine = engine.engineReachable(s.engineKey)
        ? {}
        : {disabled: true, title: 'needs the engine'};

      rowMenuOpen = true;
      captureFrozen();
      openMenu(
        [
          ...(s.unread > 0
            ? [
                {
                  icon: 'markRead' as const,
                  text: 'Mark as read',
                  onClick: () => {
                    void engine.setSessionUnread(id, false);
                  }
                }
              ]
            : [
                {
                  icon: 'unread' as const,
                  text: 'Mark as unread',
                  onClick: () => {
                    deps.forgetProgress(id);
                    void engine.setSessionUnread(id, true);
                  }
                }
              ]),
          {
            icon: 'edit',
            text: 'Rename',
            onClick: () => {
              const next = window.prompt('Name this session', s.name)?.trim();
              if (next === undefined) return;
              void engine.renameSession(id, next);
            }
          },

          {
            icon: 'refresh',
            text: 'Restart',
            ...needsEngine,
            onClick: () => void restart(id, s.name)
          },
          {
            icon: 'delete',
            text: 'Exit session',
            danger: true,
            ...needsEngine,
            onClick: () => {
              confirmExitSession(s.name, () => void engine.exitSession(id));
            }
          }
        ],
        at as MouseEvent,
        {
          onClose: () => {
            rowMenuOpen = false;
            flushResort();
          }
        }
      );
    }
  });
  sessionList.setConversationMode(sessionState.appConversationMode);

  const listScroll = scrollSurface();

  let resortSettleArmed = false;
  const settleReorderPass = () => {
    const c = listScroll;
    const cTop = c.getBoundingClientRect().top;
    let anchor: HTMLElement | undefined,
      anchorOffset = 0;
    for (const r of Array.from(sessionList.el.children) as HTMLElement[]) {
      const rect = r.getBoundingClientRect();
      if (rect.bottom > cTop) {
        anchor = r;
        anchorOffset = rect.top - cTop;
        break;
      }
    }
    flushResort();
    if (anchor?.isConnected) {
      const delta =
        anchor.getBoundingClientRect().top - c.getBoundingClientRect().top - anchorOffset;
      if (delta) c.scrollTop += delta;
    }
  };

  const armSettleResort = () => {
    if (resortSettleArmed) return;
    if (!interactionWindow.active('scroll') && !interactionWindow.active('open')) return;
    resortSettleArmed = true;
    interactionWindow.onSettle(() => {
      resortSettleArmed = false;
      settleReorderPass();
    });
  };
  const sessionListTop = h(
    'div',
    'cyc-stack-top h-auto min-h-full relative flow-root pb-[calc(1rem+3.5rem+var(--cyc-safe-bottom)+0.5rem)] max-tab:pb-[calc(1.5rem+3.5rem+var(--cyc-safe-bottom)+0.5rem)]'
  );

  // Second-engine pairing doorway: a banner above the rows whenever the app
  // server announces an engine this device holds no E2E key for. The plugin
  // cards insert before sessionList.el, so they land between the banner and
  // the rows; the banner stays on top. A LIVE-LIST affordance only: the
  // archive lens hides it via `hidden` (updateArchiveEntry, below), while the
  // banner's own discovery paint only toggles `cyc-off`, so the two gates
  // never fight.
  let pairBannerEl: HTMLElement | null = null;
  if (dataState.mode === 'live') {
    pairBannerEl = createPairBanner({onTeardown: deps.onTeardown});
    pairBannerEl.hidden = sessionState.archiveOpen;
    sessionListTop.append(pairBannerEl);
  }
  sessionListTop.append(sessionList.el);

  /* THE "CHATS" BACK ROW of the archive lens (dead-session archive). The
   * archive's ENTRY POINT lives in Settings now (an "Archived (n)" row just
   * above "Clear cached data"); the conversation list itself carries NO
   * archive affordance. While the lens is open this one row-shaped button
   * sits directly above the archived rows and returns to the live list.
   * Reading an archived chat is the ordinary openChat on its row; restarting
   * stays the row menu's existing action and returns the session live. */
  const archiveEntry = h(
    'button',
    'cyc-archive-entry flex w-full items-center gap-3.5 rounded-xl px-4 py-3 ' +
      'cursor-pointer text-start text-[0.9375rem] font-medium text-[var(--cyc-text-muted)] ' +
      BTN_HOVER_UTILS
  );
  archiveEntry.hidden = true;
  sessionListTop.insertBefore(archiveEntry, sessionList.el);
  archiveEntry.addEventListener('click', () => {
    sessionState.archiveOpen = !sessionState.archiveOpen;
    cyclog('nav.tap', {control: 'archive', open: sessionState.archiveOpen});
    deps.render();
  });

  const updateArchiveEntry = () => {
    const open = sessionState.archiveOpen;
    // The pair banner is a live-list affordance; the archive lens hides it.
    // This runs inside renderRows' keyed pass, and listSurfaceVersion already
    // folds archiveOpen, so a lens toggle repaints the banner in and out.
    if (pairBannerEl) pairBannerEl.hidden = open;
    // The back row is present exactly while the lens is open (the way back,
    // even from an emptied archive) and never on the live list: the list has
    // no archive entry point any more, Settings does.
    archiveEntry.hidden = !open;
    if (!open) return;
    const n = projectArchive(tabSessions()).length;
    archiveEntry.textContent = '';
    const label = h('span', 'flex-auto min-w-0 overflow-hidden text-ellipsis whitespace-nowrap');
    label.textContent = 'Chats';
    const count = h('span', 'flex-none text-[0.8125rem] font-normal');
    count.textContent = n ? String(n) : '';
    archiveEntry.append(makeIcon('left', 'text-[1.25rem]'), label, count);
    // The back row sits directly above the archived rows; the plugin cards
    // insert before sessionList.el too, so re-assert the slot every pass.
    if (archiveEntry.nextSibling !== sessionList.el)
      sessionListTop.insertBefore(archiveEntry, sessionList.el);
  };

  markUsageReady();
  paintLimits();
  // Flow the scroll in the flex column (was shell.css `.cyc-left-content > .cyc-overflow`).
  // `relative!` beats the un-layered `.cyc-overflow { position: absolute }` base.
  listScroll.classList.add('relative!', 'flex-auto');
  listScroll.append(sessionListTop);

  const hintsCardEl = createHintsCard({dismissible: true, onDismiss: () => deps.render()});

  type Neighbour = {
    el: HTMLElement;
    list: ReturnType<typeof createSessionList>;
    pcard: PluginCard;
    hints: HTMLElement | null;
  };
  const neighbours = new Map<1 | -1, Neighbour>();
  function stageNeighbour(dir: 1 | -1): boolean {
    const tabId = tabNeighbour(dir);
    if (!tabId) return false;
    let neighbour = neighbours.get(dir);
    if (!neighbour) {
      const el = h(
        'div',
        'cyc-stack-neighbour cyc-stack-neighbour-' +
          (dir > 0 ? 'next start-full' : 'prev end-full') +
          ' pointer-events-none absolute top-0 min-h-full w-full bg-[var(--cyc-surface,var(--cyc-background-color))]'
      );

      el.setAttribute('inert', '');

      const pcard = createPluginCard('Plan usage', () => {});
      const list = createSessionList({
        sessions: [],
        activityMark: (s) => engine.activityMark(s),
        onOpen: () => {}
      });
      el.append(pcard.el, list.el);

      sessionListTop.insertBefore(el, sessionListTop.querySelector(':scope > .cyc-hints'));
      neighbour = {el, list, pcard, hints: null};
      neighbours.set(dir, neighbour);
    }

    neighbour.list.update(projectList(tabId).rows, null);

    const neighbourKey = engine.engineKeyOfTab(tabId);

    const a =
      neighbourKey && isPluginCardEngine(neighbourKey) ? retainedAnswer(neighbourKey) : null;
    neighbour.pcard.update(
      a ? {html: a.html, hosts: [], ...(a.height != null ? {height: a.height} : {})} : {html: null}
    );

    if (hintsDismissed()) {
      neighbour.hints?.remove();
      neighbour.hints = null;
    } else if (!neighbour.hints) {
      neighbour.hints = createHintsCard({dismissible: true});
      neighbour.el.append(neighbour.hints);
    }

    neighbour.el.classList.remove('cyc-off');
    return true;
  }
  function clearNeighbours() {
    for (const p of neighbours.values()) p.el.classList.add('cyc-off');
  }
  leftContent.append(listScroll);
  // The connectivity band overlays the bottom of the list (out of flow). It goes
  // in before the (+) FAB so the button, appended later, paints over the band.
  leftContent.append(syncStatusEl);

  listScroll.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;

    if (t.closest('.cyc-session-entry, .cyc-plugincard, .cyc-hints, .cyc-archive-entry')) return;
    if (!sessionState.activeId) return;
    deps.saveDraft();
    deps.loadDraft(null);
    sessionState.activeId = null;

    deps.restorePending.delete('chat');
    deps.restorePending.delete('list');
    localStorage.removeItem('cyc-engaged');
    engine.detachChat();
    if (pipeline.handsFreeSessionId) pipeline.disableHandsFree();
    deps.releaseMicIfIdle();
    deps.setView('list');
    deps.render();
  });

  let stripeBg: HTMLElement | null = null;

  let stripeGeom: {dir: 1 | -1; shift: number; fromW: number; toW: number; bg: HTMLElement} | null =
    null;
  const followStripe = (progress: number, animate: boolean) => {
    if (!progress) {
      stripeGeom = null;
      if (!stripeBg) return;
      stripeBg.style.transition = animate
        ? `transform ${LIST_SWIPE_ANIM_MS}ms ease, width ${LIST_SWIPE_ANIM_MS}ms ease`
        : 'none';
      stripeBg.style.transform = '';
      stripeBg.style.width = '';
      stripeBg = null;
      return;
    }
    const dir: 1 | -1 = progress < 0 ? 1 : -1;
    if (!stripeGeom || stripeGeom.dir !== dir) {
      const toKey = tabNeighbour(dir);
      const fromTab = sessionState.activeTabId
        ? tabEls.get(sessionState.activeTabId)?.tab
        : undefined;
      const toTab = toKey ? tabEls.get(toKey)?.tab : undefined;
      if (!fromTab || !toTab) return;
      const bg = fromTab.querySelector('.cyc-seg-bg') as HTMLElement;
      if (stripeBg && stripeBg !== bg) {
        stripeBg.style.transition = 'none';
        stripeBg.style.transform = '';
        stripeBg.style.width = '';
      }
      stripeBg = bg;

      stripeGeom = {
        dir,
        bg,
        shift: toTab.offsetLeft - fromTab.offsetLeft,
        fromW: fromTab.clientWidth,
        toW: toTab.clientWidth
      };
    }
    const g = stripeGeom;
    const f = Math.min(1, Math.abs(progress));
    g.bg.style.transition = animate
      ? `transform ${LIST_SWIPE_ANIM_MS}ms ease, width ${LIST_SWIPE_ANIM_MS}ms ease`
      : 'none';
    g.bg.style.transform = `translate3d(${g.shift * f}px, 0, 0)`;
    g.bg.style.width = `${g.fromW + (g.toW - g.fromW) * f}px`;
  };

  // Tab-strip swipe on the list surface: a pointer drag or horizontal wheel pages
  // to the neighbouring tab, staging its content underneath and animating the tab
  // stripe via `followStripe`. dir>0 pages to the next tab, dir<0 to the previous.
  {
    const surface = listScroll;
    const moves = sessionListTop;
    const surfaceWidth = () => surface.clientWidth || 1;
    const enabled = () => visibleTabs().length > 1;
    const canGo = (dir: 1 | -1) => !!tabNeighbour(dir);
    const runGo = (dir: 1 | -1) => {
      swipeToTab(dir);
      clearNeighbours();
    };
    const settle = (final: number, committed: boolean, dir: 1 | -1, ms: number) =>
      cyclog('tab.settle', {
        from: sessionState.activeTabId ?? null,
        to: tabNeighbour(dir),
        final,
        committed,
        dir,
        ms
      });
    const gestureEnd = (reason: 'touchend' | 'touchcancel' | 'wheel') => {
      if (reason === 'touchcancel') cyclog('gesture.cancel', {surface: 'sessionList', reason});
      deps.renderRows();
    };

    // While a neighbour tab is staged the surface pages over it at full opacity;
    // until then a bare drag fades as it travels.
    let prepared: 1 | -1 | 0 = 0;
    let windowToken = 0;
    const openWindow = () => {
      if (!windowToken) windowToken = interactionWindow.begin('gesture', 'sessionList');
    };
    const closeWindow = () => {
      if (windowToken) {
        interactionWindow.end(windowToken);
        windowToken = 0;
      }
    };
    const paint = (offset: number, animate: boolean, w: number = surfaceWidth()) => {
      moves.style.transition = animate
        ? `transform ${LIST_SWIPE_ANIM_MS}ms ease, opacity ${LIST_SWIPE_ANIM_MS}ms ease`
        : 'none';
      moves.style.transform = offset === 0 ? '' : `translateX(${offset}px)`;
      moves.style.opacity =
        !offset || prepared ? '' : String(Math.max(0.4, 1 - Math.abs(offset) / w));
      followStripe(offset / w, animate);
    };
    // Track travel BEYOND the arm slop so the strip starts at zero displacement
    // at the arm point instead of jumping to the full accumulated delta (which
    // reads as tracking from the first unit of movement). Both the pointer drag
    // and the wheel run paint through this; commit still measures raw travel.
    const slopSubtracted = (d: number) => Math.sign(d) * Math.max(0, Math.abs(d) - LIST_ARM_PX);
    const releasePrepared = () => {
      if (!prepared) return;
      prepared = 0;
      window.setTimeout(() => {
        if (!prepared) clearNeighbours();
      }, LIST_SWIPE_ANIM_MS);
    };

    const innerScrollerHasRoomX = (target: EventTarget | null, deltaX: number): boolean => {
      let el = target instanceof Element ? target : null;
      while (el && el !== surface) {
        if (el.scrollWidth > el.clientWidth + 1) {
          const {overflowX} = window.getComputedStyle(el);
          if (overflowX === 'auto' || overflowX === 'scroll') {
            const room =
              deltaX > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft;
            if (room > 1) return true;
          }
        }
        el = el.parentElement;
      }
      return false;
    };

    // Wheel paging.
    let wheelOffset = 0;
    let quietTimer: number | undefined;
    let cooling = false;
    let cooldownDir: 1 | -1 = 1;
    let deferToInner = false;
    let baseWidth = 0;
    let wheelStartMs = 0;
    let wheelOpen = false;
    const finishWheel = () => {
      wheelOffset = 0;
      cooling = false;
      deferToInner = false;
      baseWidth = 0;
      paint(0, true);
      releasePrepared();
      if (wheelOpen) {
        wheelOpen = false;
        closeWindow();
        gestureEnd('wheel');
      }
    };
    surface.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        if (!enabled()) return;
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        if (!deferToInner && !wheelOffset && !cooling && innerScrollerHasRoomX(e.target, e.deltaX))
          deferToInner = true;
        window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(finishWheel, LIST_WHEEL_QUIET_MS);
        if (deferToInner) return;

        const incomingDir: 1 | -1 = e.deltaX > 0 ? 1 : -1;
        if (cooling) {
          if (incomingDir === cooldownDir) return;
          cooling = false;
          wheelOffset = 0;
        }
        e.preventDefault();
        const dir: 1 | -1 = wheelOffset - e.deltaX < 0 ? 1 : -1;
        if (!canGo(dir)) {
          wheelOffset = 0;
          paint(0, false);
          return;
        }
        wheelOffset -= e.deltaX;
        if (prepared !== dir && stageNeighbour(dir)) prepared = dir;
        if (!baseWidth) {
          baseWidth = surfaceWidth();
          wheelStartMs = Date.now();
        }
        if (!wheelOpen) {
          wheelOpen = true;
          openWindow();
        }
        paint(clampNumber(slopSubtracted(wheelOffset), -baseWidth, baseWidth), false, baseWidth);
        if (Math.abs(wheelOffset) <= LIST_WHEEL_COMMIT_PX) return;

        cooling = true;
        cooldownDir = dir;
        const w = baseWidth;
        settle(dir > 0 ? -w : w, true, dir, Date.now() - wheelStartMs);
        paint(dir > 0 ? -w : w, true, w);
        window.setTimeout(() => {
          runGo(dir);
          prepared = 0;
          paint(0, false);
        }, LIST_SWIPE_ANIM_MS);
      },
      {passive: false}
    );

    // Pointer/touch drag: axis-lock, threshold and velocity are owned by the
    // gesture wrapper (features/gestures.ts). The wrapper reports travel already
    // past the arm slop, so we paint it directly. Its dir is the pointer's own
    // sign (rightward 1, leftward -1); the tab strip pages the opposite way
    // (rightward -> previous tab, leftward -> next), so we flip the sign.
    let dragOpen = false;
    let dragStartMs = 0;
    let curTabDir: 1 | -1 = 1;
    const paintDrag = (dx: number) => {
      const tabDir: 1 | -1 = dx < 0 ? 1 : -1;
      curTabDir = tabDir;
      if (!canGo(tabDir)) {
        paint(0, false);
        return;
      }
      if (!dragOpen) {
        dragOpen = true;
        dragStartMs = Date.now();
        openWindow();
      }
      if (prepared !== tabDir && stageNeighbour(tabDir)) prepared = tabDir;
      paint(clampNumber(dx, -surfaceWidth(), surfaceWidth()), false);
    };
    const snapBack = () => {
      if (dragOpen) {
        dragOpen = false;
        settle(0, false, curTabDir, Date.now() - dragStartMs);
        closeWindow();
        gestureEnd('touchend');
      }
      paint(0, true);
      releasePrepared();
    };
    const commitTab = (tabDir: 1 | -1) => {
      const w = surfaceWidth();
      if (dragOpen) {
        dragOpen = false;
        settle(tabDir > 0 ? -w : w, true, tabDir, Date.now() - dragStartMs);
        closeWindow();
        gestureEnd('touchend');
      }
      paint(tabDir > 0 ? -w : w, true);
      setTimeout(() => {
        runGo(tabDir);
        prepared = 0;
        paint(0, false);
      }, LIST_SWIPE_ANIM_MS);
    };
    const startEligible = (start: EventTarget | null): boolean =>
      enabled() && !(start instanceof Element && start.closest('.cyc-steprange'));

    deps.onTeardown(
      onHorizontalSwipe(surface, {
        thresholdPct: LIST_COMMIT_PCT,
        velocityCommit: LIST_FLICK_VELOCITY,
        armPx: LIST_ARM_PX,
        travelWidth: surfaceWidth,
        canStart: startEligible,
        onProgress: ({dx}) => paintDrag(dx),
        onCommit: ({dir}) => {
          const tabDir: 1 | -1 = dir < 0 ? 1 : -1;
          if (canGo(tabDir)) commitTab(tabDir);
          else snapBack();
        },
        onCancel: snapBack
      })
    );
  }

  const floatingAction = h(
    'button',
    FAB_DOCK +
      ' cyc-dock-shown cyc-conversation-toggle bg-[var(--cyc-accent)]! text-white ' +
      '[&.cyc-conv-on]:bg-[#4ec97b]! [&.cyc-conv-on]:[animation:cyc-pulse_1.6s_infinite] ' +
      ACTION_FLOAT_HOVER_UTILS
  );
  floatingAction.title = 'conversation mode';
  floatingAction.append(makeIcon('microphone'));
  floatingAction.addEventListener('click', () => {
    sessionState.appConversationMode = !sessionState.appConversationMode;
    sessionList.setConversationMode(sessionState.appConversationMode);
    toast(
      sessionState.appConversationMode
        ? 'Conversation mode armed: tap a row to hear its latest reply'
        : 'Conversation mode off'
    );
    deps.render();
  });

  const newConversation = h(
    'button',
    FAB_DOCK +
      ' cyc-elevation-low cyc-dock-shown cyc-new-conversation [box-shadow:none]! bg-[var(--cyc-fill-color)]! text-white! ' +
      ACTION_FLOAT_HOVER_UTILS
  );
  newConversation.tabIndex = -1;
  newConversation.title = 'new session';
  newConversation.append(makeIcon('add'));
  newConversation.addEventListener('click', (e) => openNewSessionMenu(e, newConversation));
  leftContent.append(newConversation);

  let floatingActionHiddenByScroll = false;
  updateFabImpl = () => {
    const chatCoversList = window.innerWidth <= 550 && deps.mainColumns.dataset.view !== 'list';
    floatingAction.classList.toggle(
      'cyc-dock-shown',
      !floatingActionHiddenByScroll && !chatCoversList
    );
    newConversation.classList.toggle('cyc-dock-shown', !chatCoversList);
  };
  let lastListScrollTop = listScroll.scrollTop;
  listScroll.addEventListener(
    'scroll',
    () => {
      interactionWindow.begin('scroll', 'listscroll');

      captureFrozen();
      armSettleResort();
      const top = listScroll.scrollTop;
      if (top === lastListScrollTop) return;
      floatingActionHiddenByScroll = top > lastListScrollTop && top > 0;
      lastListScrollTop = top;
      updateFabImpl();
    },
    {passive: true}
  );

  const onListPress = () => {
    listPressed = true;
    captureFrozen();
  };
  const onListRelease = () => {
    if (!listPressed) return;
    listPressed = false;
    settleReorderPass();
  };
  listScroll.addEventListener('pointerdown', onListPress, {passive: true});
  window.addEventListener('pointerup', onListRelease);
  window.addEventListener('pointercancel', onListRelease);
  deps.onTeardown(() => {
    window.removeEventListener('pointerup', onListRelease);
    window.removeEventListener('pointercancel', onListRelease);
  });
  window.addEventListener('resize', updateFabImpl);
  deps.onTeardown(() => window.removeEventListener('resize', updateFabImpl));

  leftContent.append(floatingAction);

  const playerBar = createAudioPlayerBar({
    onToggle: () => {
      const st = speaker.state;
      if (st.state === 'speaking') speaker.pause();
      else speaker.resume();
    },
    onOpen: () => deps.openPlayingMessage(),
    onClose: () => speaker.stopAll()
  });
  leftContent.append(playerBar.el);

  leftMain.append(leftHeader, tabsWrap, leftContent);
  return {
    leftMain,
    leftContent,
    syncStatusEl,
    burger,
    listFilter,
    sessionList,
    sessionListTop,
    floatingAction,
    hintsCardEl,
    listScroll,
    playerBar,
    notifyOn,
    pluginComposerWidgets,
    updateBadge,
    renderTabs,
    switchTab,
    swipeToTab,
    tabNeighbour,
    tabSessions,
    projectList,
    visibleSessions,
    archiveEntry,
    updateArchiveEntry,
    captureFrozen,
    armSettleResort,
    flushResort,
    paintPluginCards,
    paintLimits,
    refreshUsage,
    retainedAnswer,
    flashCards,
    updateFab: () => updateFabImpl()
  };
}
