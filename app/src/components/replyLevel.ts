import createSteppedRange from '@/features/sessions/controls/steppedRangeSlider';
import {h} from '../components/domHelpers';

const NO_LEVEL = 'Not reported here · this host’s engine predates reply levels';

export type DialStep = {n: number; name: string; hint?: string};
export type DialPanel = {
  el: HTMLElement;

  update: (steps: readonly DialStep[], value: number | undefined) => void;
  toggle: () => void;
  close: () => void;
  isOpen: () => boolean;
};

export function createDialPanel(init: {
  key: string;
  title: string;
  steps: readonly DialStep[];
  value: number | undefined;
  onPick: (n: number) => void;
}): DialPanel {
  const el = h(
    'div',
    'cyc-replylevel cyc-replylevel-composer cyc-replylevel-plugin cyc-off flex flex-col items-center gap-0.5 w-full px-2 pb-1'
  );

  const head = h('div', 'cyc-replylevel-head flex items-center justify-between w-full gap-2');
  const title = h(
    'div',
    'cyc-replylevel-title text-[0.8125rem] font-semibold text-[var(--cyc-text)]'
  );
  title.textContent = init.title;
  const btnClose = h(
    'button',
    [
      'cyc-replylevel-close flex-none w-11 h-11 flex items-center justify-center cursor-pointer hover:text-(--cyc-text)!',
      'text-[var(--cyc-text-muted)] text-[1.375rem]! leading-none'
    ].join(' ')
  );
  btnClose.textContent = '×';
  btnClose.title = 'close';
  btnClose.setAttribute('aria-label', 'close');
  head.append(title, btnClose);

  const wrap = h('div', 'cyc-replylevel-dial flex flex-col items-center w-full gap-0.5');
  wrap.dataset.dial = init.key;
  const scale = h('div', 'cyc-replylevel-scale w-full');
  const label = h(
    'div',
    'cyc-replylevel-label text-xs leading-[1.35] h-[2.1rem] text-[var(--cyc-text-muted)] text-center line-clamp-2'
  );

  let steps: readonly DialStep[] = init.steps;
  let dragging = false;
  let settled: number | undefined;
  let known = false;

  const PICK_RESYNC_MS = 2000;
  let pendingPick: number | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingLast: {steps: readonly DialStep[]; value: number | undefined} | undefined;
  const clearPending = () => {
    pendingPick = undefined;
    pendingLast = undefined;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
  };
  const nameEls = new Map<number, HTMLElement>();
  let stops: HTMLElement[] = [];

  const nameOf = (n: number) => steps.find((s) => s.n === n)?.name ?? '';
  const hintOf = (n: number) => steps.find((s) => s.n === n)?.hint ?? '';

  const paint = (n: number) => {
    if (!known) return;
    const at = steps.find((s) => s.n === n);
    label.textContent = at ? (at.hint ? `${at.name} · ${at.hint}` : at.name) : NO_LEVEL;
    stops.forEach((stop, i) => stop.classList.toggle('cyc-replylevel-on', steps[i]?.n === n));
  };

  let draw: (value: number | undefined) => void = () => {};
  const buildRail = () => {
    scale.replaceChildren();
    nameEls.clear();
    const range = createSteppedRange<number>({
      onPreview: (n) => paint(n),
      onGrab: (down) => {
        dragging = down;
      },
      onCommit: (n) => {
        if (n === settled) return;
        settled = n;
        pendingPick = n;
        pendingLast = undefined;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => {
          const last = pendingLast;
          clearPending();
          if (last) update(last.steps, last.value);
        }, PICK_RESYNC_MS);
        init.onPick(n);
      }
    });
    range.container.classList.add('cyc-replylevel-range');
    // The complexity dial keeps the taller top pad here as an inline style (this
    // now owns it outright; the redundant `[data-dial='complexity']
    // .cyc-replylevel-range` rule in settings.css was dropped). As an inline it
    // beats both the base `.cyc-replylevel-range` shorthand and the base inline
    // padding-top:1rem from steppedRangeSlider that would otherwise clobber it.
    if (init.key === 'complexity') range.container.style.paddingTop = '2.375rem';
    scale.append(range.container);
    range.setOptions(
      steps.map((s) => {
        const text = h('span', 'cyc-replylevel-name');
        text.textContent = nameOf(s.n);
        nameEls.set(s.n, text);
        return {label: text, value: s.n};
      })
    );
    stops = range.stops;
    stops.forEach((stop, i) => {
      const at = steps[i];
      stop.classList.add('cyc-replylevel-stop');
      stop.title = at.hint ? `${at.name}: ${at.hint}` : at.name;
      stop.setAttribute('aria-label', `${init.key} ${at.n}, ${at.name}`);
    });
    draw = (value: number | undefined) => {
      const at = steps.find((s) => s.n === value);
      known = !!at;
      wrap.classList.toggle('cyc-replylevel-unknown', !at);
      range.setIndex(at ? steps.indexOf(at) : 0);
      if (!at) {
        label.textContent = NO_LEVEL;
        stops.forEach((stop) => {
          stop.classList.remove('cyc-replylevel-on');
          stop.dataset.reached = 'false';
          stop.dataset.current = 'false';
        });
      } else {
        paint(at.n);
      }
    };
    draw(settled);
  };

  wrap.append(scale, label);
  el.append(head, wrap);
  settled = init.value;
  buildRail();

  btnClose.addEventListener('click', () => el.classList.add('cyc-off'));
  const isOpen = () => !el.classList.contains('cyc-off');
  const toggle = () => el.classList.toggle('cyc-off');
  const close = () => el.classList.add('cyc-off');

  const sig = (s: readonly DialStep[]) => s.map((x) => `${x.n}:${x.name}`).join('|');

  const update = (nextSteps: readonly DialStep[], value: number | undefined) => {
    if (dragging) return;
    if (pendingPick !== undefined) {
      if (value !== pendingPick) {
        pendingLast = {steps: nextSteps, value};
        return;
      }
      clearPending();
    }
    const rebuilt = sig(nextSteps) !== sig(steps);
    steps = nextSteps;
    settled = value;
    if (rebuilt) {
      buildRail();
      return;
    }
    nameEls.forEach((elx, m) => {
      elx.textContent = nameOf(m);
    });
    draw(value);
    void hintOf;
  };

  return {el, update, toggle, close, isOpen};
}
