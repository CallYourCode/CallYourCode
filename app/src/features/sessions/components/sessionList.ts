import type {CycSession} from '../../../types';
import {h} from '../../../components/domHelpers';
import {makeIcon, makeIconButton} from '../../../components/iconGlyphs';
import {chatRow, type ChatRowOpts, type SyncableRow} from '@/features/chat/navigation/chatRow';
function seatRowAt(element: HTMLElement, container: HTMLElement, index: number): boolean {
  const here =
    element.parentElement === container
      ? Array.prototype.indexOf.call(container.children, element)
      : -1;
  if (here === index) return false;
  const others = Array.prototype.filter.call(
    container.children,
    (child) => child !== element
  ) as Element[];
  container.insertBefore(element, others[index] ?? null);
  return true;
}
import {cyclog} from '@/shared/logging';
import RowSortable from '../controls/rowSort';

export type CycRowAudioState = 'none' | 'speakable' | 'speaking' | 'paused' | 'finished';

const AUDIO_STATES: Exclude<CycRowAudioState, 'none'>[] = [
  'speakable',
  'speaking',
  'paused',
  'finished'
];

type SessionList = {
  el: HTMLUListElement;
  update: (sessions: CycSession[], activeId?: string | null) => void;

  setRowAudioState: (sessionId: string, state: CycRowAudioState) => void;

  setConversationMode: (armed: boolean) => void;
};

type MaybeDead = CycSession & {alive?: boolean};

function equalizer(): HTMLSpanElement {
  const eq = h('span', 'cyc-eq flex items-end gap-0.5 h-2.5');
  eq.append(
    h(
      'span',
      'w-[2px] h-[30%] rounded-[1px] bg-current [animation:cyc-eq-bounce_1s_ease-in-out_infinite]'
    ),
    h(
      'span',
      'w-[2px] h-[30%] rounded-[1px] bg-current [animation:cyc-eq-bounce_1s_ease-in-out_infinite] [animation-delay:0.2s]'
    ),
    h(
      'span',
      'w-[2px] h-[30%] rounded-[1px] bg-current [animation:cyc-eq-bounce_1s_ease-in-out_infinite] [animation-delay:0.4s]'
    )
  );
  return eq;
}

function badgeGlyph(state: CycRowAudioState): HTMLElement | null {
  switch (state) {
    case 'speakable':
    case 'paused':
      return makeIcon('play', 'text-[inherit] leading-none');
    case 'speaking':
      return equalizer();
    case 'finished':
      return makeIcon('refresh', 'text-[inherit] leading-none');
    default:
      return null;
  }
}

export function createSessionList(opts: {
  sessions: CycSession[];
  activeId?: string | null;
  onOpen: (id: string) => void;

  onEnter?: (id: string) => void;

  onRowMenu?: (id: string, at: MouseEvent | Touch) => void;

  onReorder?: (ids: string[]) => void;

  canReorder?: (id: string) => boolean;

  activityMark?: (s: CycSession) => CycSession['status'] | null;

  notifyOn?: (id: string) => boolean;

  mergedSubtitle?: (s: CycSession) => string | null;

  harnessChip?: (s: CycSession) => string | null;

  modelChip?: (s: CycSession) => string | null;
}): SessionList {
  const el = h(
    'ul',
    'cyc-stack relative m-0 flex w-full flex-col bg-[var(--cyc-surface)] px-2 max-tab:px-0 [-webkit-touch-callout:none]'
  );

  el.addEventListener(
    'pointerdown',
    (e) => {
      const row = (e.target as HTMLElement).closest?.('[data-session-id]') as HTMLElement | null;
      cyclog('nav.press', {
        surface: 'sessionList',
        row: row?.dataset.sessionId ?? null,
        armed,
        dragging: !!sortable?.dragging,
        x: Math.round(e.clientX),
        y: Math.round(e.clientY)
      });
    },
    {capture: true}
  );

  const liveRows = new Map<string, HTMLElement>();
  const audioStates = new Map<string, CycRowAudioState>();

  let armed = false;

  let suppressClick = false;

  const sortable = opts.onReorder
    ? new RowSortable({
        list: el,
        // The dragged row's surface fill is painted by chatRow's per-theme
        // `[&.cyc-drag-active]:bg-*`, so this only lifts and shadows it.
        dragClasses: 'z-2! shadow-[0_2px_8px_rgba(0,0,0,0.2)]!',
        onSort: () =>
          opts.onReorder!(
            Array.from(el.children)
              .map((row) => (row as HTMLElement).dataset.sessionId)
              .filter((id): id is string => !!id)
          )
      })
    : null;

  function applyAudioState(row: HTMLElement, state: CycRowAudioState) {
    for (const s of AUDIO_STATES) row.classList.toggle(`cyc-clip-${s}`, s === state);

    row.style.boxShadow = state === 'speaking' ? 'inset 3px 0 0 #4ec97b' : '';

    let badge = row.querySelector<HTMLElement>('.cyc-list-row-audio-badge');
    if (state === 'none') {
      badge?.remove();
      return;
    }
    if (!badge) {
      // The badge exists only while an audio state is active, so it is shown

      badge = h(
        'span',
        [
          'cyc-list-row-audio-badge absolute -end-0.5 -bottom-0.5 z-[1] flex h-[1.375rem] w-[1.375rem]',
          'items-center justify-center rounded-full border-2 border-[var(--cyc-surface)]',
          'bg-[var(--cyc-accent)] text-[0.8125rem] text-white'
        ].join(' ')
      );
      row.querySelector('.cyc-session-avatar')?.append(badge);
    }

    badge.style.backgroundColor = state === 'speaking' ? '#4ec97b' : '';
    badge.textContent = '';
    const glyph = badgeGlyph(state);
    if (glyph) badge.append(glyph);
  }

  function attachHandlers(row: HTMLElement, s: CycSession) {
    const enter = makeIconButton(
      'next',
      'cyc-list-row-enter hidden absolute end-2 top-1/2 z-[2] w-9 h-9 -translate-y-1/2 text-xl bg-[var(--cyc-surface)] shadow-[0_1px_2px_rgba(0,0,0,0.25)]'
    );
    enter.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      (opts.onEnter ?? opts.onOpen)(s.id);
    });
    row.append(enter);

    row.addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        cyclog('nav.press', {surface: 'sessionList', row: s.id, outcome: 'long-press-suppressed'});
        return;
      }
      opts.onOpen(s.id);
    });

    if (opts.onRowMenu || sortable) {
      let liftTimer = 0;
      let menuTimer = 0;
      let sx = 0,
        sy = 0;
      const cancel = () => {
        clearTimeout(liftTimer);
        liftTimer = 0;
        clearTimeout(menuTimer);
        menuTimer = 0;
      };
      row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        sx = e.clientX;
        sy = e.clientY;
        cancel();

        suppressClick = false;
        liftTimer = window.setTimeout(() => {
          liftTimer = 0;
          suppressClick = true;

          const canLift = !!sortable && (opts.canReorder ? opts.canReorder(s.id) : true);
          if (canLift) {
            try {
              navigator.vibrate?.(12);
            } catch {}
            sortable!.pickUp(row, e.clientY, e.pointerId);
          }
          menuTimer = window.setTimeout(() => {
            menuTimer = 0;

            if (canLift && sortable?.travelled) return;
            sortable?.putDown();
            try {
              navigator.vibrate?.(12);
            } catch {}
            opts.onRowMenu?.(s.id, e);
          }, 600);
        }, 500);
      });
      row.addEventListener('pointermove', (e) => {
        const far = Math.hypot(e.clientX - sx, e.clientY - sy) > 10;
        if (liftTimer && far) {
          if (
            e.pointerType === 'mouse' &&
            sortable &&
            (opts.canReorder ? opts.canReorder(s.id) : true)
          ) {
            cancel();
            suppressClick = true;
            sortable.pickUp(row, e.clientY, e.pointerId);
          } else cancel();
        } else if (menuTimer && far) {
          clearTimeout(menuTimer);
          menuTimer = 0;
        }
      });

      const letGo = () => {
        cancel();
        window.removeEventListener('pointerup', letGo);
        window.removeEventListener('pointercancel', letGo);
      };
      let touching = false;
      row.addEventListener('pointerdown', (e) => {
        touching = e.pointerType !== 'mouse';
        window.addEventListener('pointerup', letGo);
        window.addEventListener('pointercancel', letGo);
      });

      if (opts.onRowMenu) {
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (touching) return;
          opts.onRowMenu!(s.id, e);
        });
      }
    }
  }

  function update(sessions: CycSession[], activeId?: string | null, now: number = Date.now()) {
    if (sortable?.dragging) return;
    const markOf = opts.activityMark ?? ((s: CycSession) => s.status ?? null);
    // Order is decided upstream (sortedLive/applyMergedOrder/orderByLatest and
    // manual drag-reorder); render the list exactly as passed in.
    const nextRows: HTMLElement[] = [];
    for (const s of sessions as MaybeDead[]) {
      const rowOpts: ChatRowOpts = {
        mark: markOf(s),
        notifyOff: opts.notifyOn ? !opts.notifyOn(s.id) : false,
        active: s.id === activeId,
        dead: (s as MaybeDead).alive === false,
        mergedTab: opts.mergedSubtitle?.(s) || undefined,
        harnessChip: opts.harnessChip?.(s) || undefined,
        modelChip: opts.modelChip?.(s) || undefined,
        now
      };
      let row = liveRows.get(s.id);
      if (row) {
        (row as SyncableRow)._cycSync?.(s, rowOpts);
      } else {
        row = chatRow(s, rowOpts);
        attachHandlers(row, s);
        liveRows.set(s.id, row);
      }
      const state = audioStates.get(s.id);
      applyAudioState(row, state ?? 'none');
      nextRows.push(row);
    }

    for (const [id, r] of liveRows) {
      if (!nextRows.includes(r)) {
        liveRows.delete(id);
        r.remove();
      }
    }

    for (let i = 0; i < nextRows.length; i++) seatRowAt(nextRows[i], el, i);
  }

  update(opts.sessions, opts.activeId);
  el.classList.toggle('cyc-armed', armed);

  return {
    el,
    update,
    setRowAudioState(sessionId, state) {
      if (state === 'none') audioStates.delete(sessionId);
      else audioStates.set(sessionId, state);
      const row = el.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
      if (row) applyAudioState(row, state);
    },
    setConversationMode(nextArmed) {
      armed = nextArmed;
      el.classList.toggle('cyc-armed', armed);
    }
  };
}
