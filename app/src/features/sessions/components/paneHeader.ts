import {h} from '../../../components/domHelpers';
import {makeIconButton} from '../../../components/iconGlyphs';

export const PANE_HEADER_UTILS =
  'flex items-center justify-between bg-transparent px-4 min-h-14 flex-none cursor-default [transition:background-color_0.3s_cubic-bezier(0.32,0.72,0,1)] ' +
  // Shared pane-header body (was shell.css `.cyc-pane-header …`): menu scrolls, the
  // phone breakpoint tightens the inline pad to 0.5rem, and stacked icon buttons gap.
  '[&_.cyc-menu]:overflow-y-auto max-tab:px-2 [&_.cyc-icon-btn+.cyc-icon-btn]:ms-1 ' +
  // Safe-area top inset only for the list / settings / right panes (was the three
  // ancestor-scoped `… .cyc-pane-header` rules in shell.css); the chat header lives in
  // #cyc-thread-pane and is deliberately excluded. `!` beats the layered min-h-14 base.
  '[#cyc-left-pane_&]:pt-[var(--cyc-safe-top)] [#cyc-left-pane_&]:min-h-[calc(3.5rem+var(--cyc-safe-top))]! ' +
  '[.cyc-left-settings_&]:pt-[var(--cyc-safe-top)] [.cyc-left-settings_&]:min-h-[calc(3.5rem+var(--cyc-safe-top))]! ' +
  '[#cyc-right-pane_&]:pt-[var(--cyc-safe-top)] [#cyc-right-pane_&]:min-h-[calc(3.5rem+var(--cyc-safe-top))]!';
export const PANE_BACK_UTILS = '[overflow:inherit]! flex-none w-10 h-10';
export const PANE_TITLE_UTILS =
  'flex-[0_1_auto] min-w-0 me-auto ps-2 font-medium overflow-hidden text-ellipsis whitespace-nowrap';

export function paneHeader(
  title: string,
  onBack: () => void
): {
  el: HTMLDivElement;
  back: HTMLButtonElement;
  title: HTMLDivElement;
} {
  const el = h('div', 'cyc-pane-header ' + PANE_HEADER_UTILS);
  const back = makeIconButton('left', 'cyc-pane-back ' + PANE_BACK_UTILS);
  back.addEventListener('click', onBack);
  const titleEl = h('div', 'cyc-title-container cyc-pane-title ' + PANE_TITLE_UTILS);
  titleEl.textContent = title;
  el.append(back, titleEl);
  return {el, back, title: titleEl};
}
