// Pairing confirm/paired/copied paint.

import {
  currentPresentationTheme,
  registerThemePainter,
  type PresentationTheme
} from '@/components/presentation';

const ROW_BORDER: Record<'confirm' | 'paired', Record<PresentationTheme, string>> = {
  confirm: {day: 'border-[#96602f]!', night: 'border-[#c98652]!'},
  paired: {day: 'border-[#4f9e57]!', night: 'border-[#46b56e]!'}
};
// Every border literal any state can paint, cleared before the current one is
// re-applied so the base `border-[var(--cyc-border-color)]` wins again at idle.
const ROW_BORDER_ALL = [...Object.values(ROW_BORDER.confirm), ...Object.values(ROW_BORDER.paired)];

const GREEN: Record<PresentationTheme, string> = {
  day: 'text-[#4f9e57]!',
  night: 'text-[#46b56e]!'
};
const GREEN_ALL = Object.values(GREEN);

export type PairRowPhase = 'idle' | 'confirm' | 'paired';

export function bindPairRowPaint(
  el: HTMLElement,
  stateEl: HTMLElement,
  actions: HTMLElement,
  phase: () => PairRowPhase
): () => void {
  const run = () => {
    const theme = currentPresentationTheme();
    el.classList.remove(...ROW_BORDER_ALL);
    stateEl.classList.remove(...GREEN_ALL);
    const p = phase();
    if (p === 'confirm') {
      el.classList.add(ROW_BORDER.confirm[theme]);
    } else if (p === 'paired') {
      el.classList.add(ROW_BORDER.paired[theme]);
      stateEl.classList.add(GREEN[theme]);
    }
    actions.classList.toggle('hidden', p === 'paired');
  };
  registerThemePainter(el, run);
  run();
  return run;
}

// Paint the copy button green while `copied`, back to its base primary otherwise.
export function bindPairCopyPaint(btn: HTMLElement, copied: () => boolean): () => void {
  const run = () => {
    btn.classList.remove(...GREEN_ALL);
    if (copied()) btn.classList.add(GREEN[currentPresentationTheme()]);
  };
  registerThemePainter(btn, run);
  run();
  return run;
}
