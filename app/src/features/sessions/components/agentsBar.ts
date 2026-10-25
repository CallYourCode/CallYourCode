import type {MessagePin} from '@shared/message-pins';
import {makeIcon, makeIconButton} from '@/components/iconGlyphs';
import {openMenu} from '@/components/popupMenu';
import type {EngineAgentRun} from '../../../engine/contract';
import {h} from '../../../components/domHelpers';

// Title/subtitle line box. Arbitrary properties keep transform/transition animatable.
// `overflow-hidden` is what lets `text-ellipsis` engage: a visible-overflow nowrap
// line keeps its full width and runs across the pill rule instead of truncating.
const AGENTS_STRIP_LINE =
  '[font-size:0.875rem] [line-height:calc(0.875rem+4px)] ' +
  'whitespace-nowrap text-ellipsis overflow-hidden relative h-5 min-h-5 ' +
  '[transform:translateX(0)] [transition:transform_0.2s_ease-in-out]';

const DONE_WINDOW_MS = 10 * 60 * 1000;
const doneWindowMs = () =>
  Number((window as any).__cycAgentDoneWindowMs) > 0
    ? Number((window as any).__cycAgentDoneWindowMs)
    : DONE_WINDOW_MS;

const RAIL_CLASS = 'cyc-agents-rail';

// Slot geometry for the run progress rail. Each run owns one vertical slot; the
// pill fills `SLOT_FILL` of it and the rest is the inter-slot gap, split evenly so
// a pill sits centred in its slot. One CSS var (`--cyc-rail-slot`) carries the slot
// height so the dim gradient and the active overlay stay aligned by construction.
const SLOT_FILL = 0.85;
const SLOT_GAP = (1 - SLOT_FILL) / 2;
// Below this a slot is too short to read on its own, so the rail ends are faded.
const MIN_LEGIBLE_SLOT_PX = 9;
const RAIL_FADE = '0.375rem';

// The dim slots: one repeating-linear-gradient period per slot, keyed off the
// `--cyc-rail-slot` var, each period drawing a `--cyc-accent` pill centred by a
// 0.075 half-gap top and bottom (0.075 / 0.925 mirror SLOT_GAP / SLOT_GAP+SLOT_FILL).
// The 40% dim rides on the slot layer's own `opacity-40`. Kept as one literal so the
// production Tailwind scan emits it.
const RAIL_DIM_SLOTS =
  '[background:repeating-linear-gradient(transparent_0,transparent_calc(var(--cyc-rail-slot)*0.075),var(--cyc-accent)_calc(var(--cyc-rail-slot)*0.075),var(--cyc-accent)_calc(var(--cyc-rail-slot)*0.925),transparent_calc(var(--cyc-rail-slot)*0.925),transparent_var(--cyc-rail-slot))]';

// The run progress rail: a fixed-size box whose dim slots are painted by a single
// repeating-linear-gradient keyed off `--cyc-rail-slot`, and one bright overlay
// parked over the active run's slot. When the slots grow too short to read a
// ResizeObserver fades both ends with a CSS mask.
class AgentsRunRail {
  readonly el: HTMLElement;
  private slots: HTMLElement;
  private activeSlot: HTMLElement;
  private total = 1;

  constructor() {
    this.el = document.createElement('div');
    this.el.classList.add(
      RAIL_CLASS,
      'relative',
      'h-10',
      'w-[0.1875rem]',
      'flex-[0_0_auto]',
      // Dim the whole rail while the bar is idle (parent product-state).
      '[.cyc-agents-idle_&]:opacity-45'
    );

    // The dim slots, gradient-painted at 40% ink, behind the active overlay.
    this.slots = document.createElement('div');
    this.slots.classList.add(
      RAIL_CLASS + '-slots',
      'absolute',
      'inset-0',
      RAIL_DIM_SLOTS,
      'opacity-40'
    );

    this.activeSlot = document.createElement('div');
    this.activeSlot.classList.add(
      RAIL_CLASS + '-active',
      'absolute',
      'inset-x-0',
      'rounded-[3px]',
      'bg-(--cyc-accent)',
      // Slide between slots as the active run changes.
      '[transition:top_0.25s_ease-in-out]'
    );
    this.el.append(this.slots, this.activeSlot);

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.applyDensity()).observe(this.el);
    }

    this.update({total: 1, active: 0});
  }

  update({total, active}: {total: number; active: number}) {
    this.total = Math.max(1, total);
    const idx = Math.min(Math.max(0, active), this.total - 1);

    const slot = 100 / this.total;
    // The single slot var the dim gradient reads; the active overlay is placed to
    // match so the bright pill sits exactly over its dim slot.
    this.el.style.setProperty('--cyc-rail-slot', `${slot}%`);
    this.activeSlot.style.top = `${(idx + SLOT_GAP) * slot}%`;
    this.activeSlot.style.height = `${SLOT_FILL * slot}%`;

    this.applyDensity();
  }

  private applyDensity() {
    const h = this.el.clientHeight;
    const dense = h > 0 && h / this.total < MIN_LEGIBLE_SLOT_PX;
    const mask = dense
      ? `linear-gradient(to bottom, transparent 0, #000 ${RAIL_FADE}, #000 calc(100% - ${RAIL_FADE}), transparent 100%)`
      : '';
    this.el.style.setProperty('mask-image', mask);
    this.el.style.setProperty('-webkit-mask-image', mask);
  }
}

type AgentsBar = {
  slot: HTMLElement;

  refresh: () => void;
  el: HTMLElement;

  update: (runs: EngineAgentRun[], pins?: MessagePin[]) => void;

  reset: () => void;
};

type Entry = {run?: EngineAgentRun; pin?: MessagePin; running: boolean};
type PinActions = {
  goTo?: (pin: MessagePin) => void;
  unpin?: (pin: MessagePin) => void;
};
const entryKey = (e: Entry) => e.pin ? 'pin:' + e.pin.id : 'run:' + e.run.toolUseId;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

export function createAgentsBar(actions: PinActions = {}): AgentsBar {
  // `min-h-13` (3.25rem == the populated wrapper's 44px + p-1 8px) keeps a stable
  // strip height whether it shows the running-agents wrapper or only the jump pill;
  // it is inert when `cyc-off` (display:none) and when populated (already 52px).
  const el = h(
    'div',
    'cyc-bar cyc-agents-strip cyc-agents-bar cyc-off cursor-auto flex justify-between bg-(--cyc-surface)! p-1 min-h-13'
  );
  // Keep the wrap a flex row so the rail and title sit side by side in the fixed height.
  // `flex-[1_1_0%]`: a zero basis means the wrap takes whatever the pill slot leaves
  // (the slot keeps its natural width) instead of bidding with its nowrap text width
  // and squeezing the slot down to its minimum.
  const wrapper = h(
    'div',
    'cyc-bar-wrap cyc-agents-strip-wrap cyc-lit-primary max-w-full min-w-0 flex items-center flex-[1_1_0%] relative ' +
      'h-11! py-0.5! px-1! ' +
      'fine:hover:bg-(--cyc-accent-tint)! fine:active:bg-(--cyc-accent-tint)!'
  );
  const rail = new AgentsRunRail();
  // Content column. `min-w-0`
  // lets the column shrink to the wrap (a flex item's default min-width is its
  // nowrap text width), so the title and subtitle lines truncate inside it.
  const content = h(
    'div',
    'cyc-bar-content cyc-agents-strip-content pointer-events-none ' +
      'flex flex-col flex-1 justify-end overflow-visible! min-w-0 ms-2 h-10 relative'
  );
  // Idle title uses muted ink; `!` beats the accent base.
  const title = h(
    'div',
    'cyc-bar-title cyc-agents-strip-title text-[var(--cyc-accent)] ' +
      'font-medium mb-[-2px] ' +
      AGENTS_STRIP_LINE +
      ' [.cyc-agents-idle_&]:text-[var(--cyc-text-muted)]!'
  );
  // Subtitle ink; done entries fade via a self class. A flex row of [badge] task
  // age: the task span is the one that truncates, the age span never shrinks, so
  // "· 20s" stays visible at the end of a truncated line.
  const subtitle = h(
    'div',
    'cyc-bar-subtitle cyc-agents-strip-subtitle text-[var(--cyc-text-muted)] ' +
      '[&.cyc-agents-entry-done]:opacity-[0.65] flex items-baseline ' +
      AGENTS_STRIP_LINE
  );
  const task = h('span', 'cyc-agents-task min-w-0 overflow-hidden text-ellipsis whitespace-nowrap');
  const age = h('span', 'cyc-agents-age flex-none whitespace-pre');
  content.append(title, subtitle);
  const goTo = makeIconButton('next', 'cyc-pin-goto cyc-off flex-none size-9! text-base!');
  goTo.type = 'button';
  goTo.title = 'Go to message';
  goTo.setAttribute('aria-label', 'Go to message');
  goTo.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const pin = entries[cycleIndex]?.pin;
    if (pin) actions.goTo?.(pin);
  });
  wrapper.append(rail.el, content, goTo);


  const slot = h(
    'div',
    'cyc-agents-slot flex flex-[0_1_auto] items-stretch min-w-32 max-w-[45%] ' +
      '[.cyc-agents-bare_&]:min-w-0 [.cyc-agents-bare_&]:max-w-full [.cyc-agents-bare_&]:flex-[1_1_auto] ' +
      '[.cyc-agents-bar:not(.cyc-agents-bare)_&]:border-s [.cyc-agents-bar:not(.cyc-agents-bare)_&]:border-s-[var(--cyc-border-color)]'
  );
  el.append(wrapper, slot);

  let entries: Entry[] = [];
  let cycleIndex = 0;

  let holdTimer = 0;
  let suppressClick = false;
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = 0; };
  const pinMenu = (event: MouseEvent | PointerEvent) => {
    const pin = entries[cycleIndex]?.pin;
    if (!pin) return;
    suppressClick = true;
    openMenu([
      {icon: 'next', text: 'Go to message', onClick: () => actions.goTo?.(pin)},
      {icon: 'pin', text: 'Unpin', onClick: () => actions.unpin?.(pin)}
    ], event, {triggerElement: wrapper});
  };
  wrapper.addEventListener('contextmenu', (event) => {
    cancelHold();
    pinMenu(event);
  });
  let sx = 0, sy = 0;
  wrapper.addEventListener('pointerdown', (event) => {
    cancelHold();
    suppressClick = false;
    if (event.pointerType === 'mouse' || event.target instanceof Element && event.target.closest('button')) return;
    sx = event.clientX; sy = event.clientY;
    if (entries[cycleIndex]?.pin) holdTimer = window.setTimeout(() => {
      holdTimer = 0;
      suppressClick = true;
      pinMenu(event);
    }, 650);
  });
  wrapper.addEventListener('pointermove', (event) => {
    if (Math.hypot(event.clientX - sx, event.clientY - sy) > 10) cancelHold();
  });
  wrapper.addEventListener('pointerup', cancelHold);
  wrapper.addEventListener('pointercancel', cancelHold);
  wrapper.addEventListener('pointerleave', cancelHold);
  wrapper.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    if (entries.length < 2) return;
    cycleIndex = (cycleIndex + 1) % entries.length;
    paint();
  });

  function paint() {
    const now = Date.now();

    const bare = !entries.length;
    wrapper.classList.toggle('cyc-off', bare);
    el.classList.toggle('cyc-agents-bare', bare);
    if (bare) {
      el.classList.toggle('cyc-off', !slot.firstElementChild || slot.classList.contains('cyc-off'));
      return;
    }
    el.classList.remove('cyc-off');

    const running = entries.filter((e) => e.running).length;
    const agents = entries.filter((e) => e.run).length;
    if (cycleIndex >= entries.length) cycleIndex = 0;
    const e = entries[cycleIndex];
    el.classList.toggle('cyc-agents-idle', running === 0 || !!e.pin);
    goTo.classList.toggle('cyc-off', !e.pin);
    rail.update({total: entries.length, active: cycleIndex});
    if (e.pin) {
      title.replaceChildren(makeIcon('pin', 'text-xs me-1'),
        document.createTextNode(e.pin.role === 'user' ? 'Pinned, you' : 'Pinned message'));
      task.textContent = e.pin.snippet;
      age.textContent = '';
      subtitle.replaceChildren(task, age);
      subtitle.classList.remove('cyc-agents-pi', 'cyc-agents-entry-done');
      return;
    }
    if (running > 0) title.textContent = `${running} agent${running === 1 ? '' : 's'} running`;
    else title.textContent = `${agents} agent${agents === 1 ? '' : 's'} done`;
    const run = e.run;
    task.textContent = run.desc || '(no description)';
    if (e.running) age.textContent = ` · ${fmtElapsed(now - run.ts)}`;
    else age.textContent = run.tokens ? ` · done, ${run.tokens} tokens` : ' · done';

    const isPi = run.source === 'pi';
    subtitle.classList.toggle('cyc-agents-pi', isPi);
    if (isPi && run.model) {
      const badge = h(
        'span',
        [
          'cyc-agents-pi-badge flex-none me-[0.4em] px-[0.4em] rounded-[0.5em]',
          'text-[0.82em] font-semibold leading-[1.4] text-[var(--cyc-accent)]',
          'bg-[color-mix(in_srgb,var(--cyc-accent)_16%,transparent)]'
        ].join(' ')
      );
      badge.textContent = run.model;
      subtitle.replaceChildren(badge, task, age);
    } else {
      subtitle.replaceChildren(task, age);
    }
    subtitle.classList.toggle('cyc-agents-entry-done', !e.running);

    rail.update({total: Math.max(1, entries.length), active: cycleIndex});
  }

  function update(runs: EngineAgentRun[], pins: MessagePin[] = []) {
    const now = Date.now();
    const next: Entry[] = [];

    const sorted = [...runs].sort((a, b) => b.ts - a.ts);
    for (const r of sorted) {
      if (r.endedTs === null) next.push({run: r, running: true});
    }
    for (const r of sorted) {
      if (r.endedTs !== null && now - r.endedTs < doneWindowMs())
        next.push({run: r, running: false});
    }
    next.push(...[...pins].sort((a, b) => b.pinnedAt - a.pinnedAt).map((pin) => ({pin, running: false})));
    const changedShape =
      next.length !== entries.length ||
      next.some(
        (e, i) => entryKey(e) !== (entries[i] && entryKey(entries[i])) || e.running !== entries[i]?.running
      );
    if (changedShape) { cancelHold(); cycleIndex = 0; }
    entries = next;
    paint();
  }

  return {
    el,
    slot,
    update,

    refresh: paint,
    reset: () => {
      cancelHold();
      cycleIndex = 0;
      entries = [];
      paint();
    }
  };
}
