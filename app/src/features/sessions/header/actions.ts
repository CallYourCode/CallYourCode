import {h} from '../../../components/domHelpers';
import {BTN_HOVER_UTILS, BTN_ICON_BASE, makeIconOrText} from '../../../components/iconGlyphs';
import {
  toolbarActionShown,
  engineToolbarActions,
  type CycToolbarAction,
  type CycToolbarActionId
} from '@/features/settings/preferences';
import {paintHeaderHeight} from './headerHeight';

export function captioned(btn: HTMLElement, text: string, short?: string): HTMLElement {
  const slot = h(
    'div',
    'cyc-mast-slot flex flex-col items-center justify-center flex-[0_1_3rem] min-w-11 min-h-[2.875rem] max-w-18 gap-0 pb-2 ' +
      '[.cyc-hdr-phone_&]:pb-1 [.cyc-hdr-phone_&]:flex-[1_1_2.75rem] [.cyc-hdr-phone_&]:w-auto'
  );
  const cap = h(
    'span',
    [
      'cyc-mast-caption -mt-[0.3125rem] whitespace-nowrap pointer-events-none select-none',
      // Phone shrinks the caption; `tracking-normal` is letter-spacing:0.
      'text-[0.5625rem] leading-none font-medium tracking-[0.01em] text-[var(--cyc-text-muted)] ' +
        '[.cyc-hdr-phone_&]:text-[0.5rem] [.cyc-hdr-phone_&]:tracking-normal'
    ].join(' ')
  );
  if (short) {
    // The long spelling hides on phone; the short one is base-hidden and revealed on phone.
    const long = h('span', 'cyc-mast-caption-long [.cyc-hdr-phone_&]:hidden');
    long.textContent = text;
    const brief = h('span', 'cyc-mast-caption-short hidden [.cyc-hdr-phone_&]:inline');
    brief.textContent = short;
    cap.append(long, brief);
  } else {
    cap.textContent = text;
  }
  slot.append(btn, cap);
  return slot;
}

type HeaderActionsHost = {
  el: HTMLElement;

  utils: HTMLElement;

  sessionId: () => string;

  toolbarEngine?: (sessionId: string) => {engineKey: string | null; plugins: ReadonlySet<string>};

  onPluginAction?: (id: CycToolbarActionId) => void;
};

export type HeaderActions = {
  headerBreak: HTMLElement;
  reg: (id: CycToolbarActionId, slot: HTMLElement) => HTMLElement;
  refreshToolbarActions: () => void;
  actionButton: (id: CycToolbarActionId) => HTMLElement | null;
  remeasure: () => void;
};

export function createHeaderActions(host: HeaderActionsHost): HeaderActions {
  const {el, utils} = host;

  const actionSlots: Partial<Record<CycToolbarActionId, HTMLElement>> = {};
  const reg = (id: CycToolbarActionId, slot: HTMLElement): HTMLElement => {
    slot.dataset.cycAction = id;
    actionSlots[id] = slot;
    return slot;
  };

  function genericActionSlot(a: CycToolbarAction): HTMLElement {
    const btn = h(
      'button',

      `cyc-icon-btn cyc-force-show cyc-plugin-action-btn ${BTN_ICON_BASE} ${BTN_HOVER_UTILS} cyc-${a.id}-btn`
    );
    btn.append(makeIconOrText(a.icon));
    btn.title = a.label;
    btn.setAttribute('aria-label', a.label);
    btn.addEventListener('click', () => host.onPluginAction?.(a.id));
    return captioned(btn, a.label);
  }
  function ensureSlot(a: CycToolbarAction): HTMLElement {
    const existing = actionSlots[a.id];
    if (existing) return existing;
    return reg(a.id, genericActionSlot(a));
  }

  // The wrap break is base-hidden, and only the phone title-row wrap turns it into a
  // full-basis zero-height flex break.
  const headerBreak = h(
    'div',
    'cyc-mast-break hidden [.cyc-hdr-phone_&]:block [.cyc-hdr-phone_&]:basis-full ' +
      '[.cyc-hdr-phone_&]:h-0 [.cyc-hdr-phone_&]:m-0'
  );

  const HEADER_WRAP_AFTER = 3;
  const HEADER_TITLE_ROW_MAX = 4;

  function refreshToolbarActions() {
    const sessionId = host.sessionId();
    const ctx = host.toolbarEngine?.(sessionId) ?? {engineKey: null, plugins: new Set<string>()};
    const engineKey = ctx.engineKey;
    const ordered = engineToolbarActions(engineKey, ctx.plugins);
    for (const a of ordered) ensureSlot(a);
    const inEngine = new Set<CycToolbarActionId>(ordered.map((a) => a.id));

    for (const id of Object.keys(actionSlots) as CycToolbarActionId[]) {
      if (!inEngine.has(id)) actionSlots[id]!.classList.add('cyc-off');
    }
    const isShown = (id: CycToolbarActionId) => toolbarActionShown(engineKey, id);

    const shownCount = ordered.reduce(
      (n, a) => n + (actionSlots[a.id] && isShown(a.id) ? 1 : 0),
      0
    );
    headerBreak.remove();
    let placed = 0;
    ordered.forEach((a) => {
      const slot = actionSlots[a.id];
      if (!slot) return;
      const shown = isShown(a.id);
      slot.classList.toggle('cyc-off', !shown);
      utils.appendChild(slot);
      if (!shown) return;
      placed++;
      if (placed === HEADER_WRAP_AFTER && shownCount > HEADER_TITLE_ROW_MAX)
        utils.appendChild(headerBreak);
    });

    applyToolbarExtraRows(true);
  }

  function actionButton(id: CycToolbarActionId): HTMLElement | null {
    return actionSlots[id]?.querySelector<HTMLElement>('.cyc-icon-btn') ?? null;
  }

  const setHeaderHeightExtra = paintHeaderHeight(el);

  let lastBarWidth = -1;
  function measureToolbarExtraRows(): number {
    const tops = Array.from(utils.querySelectorAll<HTMLElement>('.cyc-mast-slot'))

      .filter((s) => s.offsetWidth > 0)
      .map((s) => s.getBoundingClientRect().top)
      .sort((a, b) => a - b);
    if (!tops.length) return 0;
    let rows = 1;
    for (let i = 1; i < tops.length; i++) if (tops[i] - tops[i - 1] > 8) rows++;
    return rows - 1;
  }
  function applyToolbarExtraRows(force = false) {
    const w = el.offsetWidth;

    if (!w) return;

    if (!force && w === lastBarWidth) return;
    lastBarWidth = w;
    setHeaderHeightExtra(measureToolbarExtraRows());
  }
  const toolbarRowObserver = new ResizeObserver(() => applyToolbarExtraRows());
  toolbarRowObserver.observe(el);

  return {
    headerBreak,
    reg,
    refreshToolbarActions,
    actionButton,
    remeasure: () => applyToolbarExtraRows(true)
  };
}
