import {TABLER} from '@/features/media/icons';
import {WRAP_SVG} from '@/features/code/viewer';
import {h} from './domHelpers';

export type CycIconName = keyof typeof TABLER;

const SVGICO_UTILS = 'inline-flex items-center justify-center align-middle leading-none';


// SVG icons inherit text color and use the SVG's own geometry; no icon-font reset is needed.
export const ICON_RESET_UTILS = 'shrink-0 leading-none';


export const BTN_HOVER_UTILS =
  'fine:hover:bg-(--cyc-text-muted-tint)! fine:active:bg-(--cyc-text-muted-tint)!';


const BTN_ICON_INTERACTION =
  '[transition:0.2s_color,0.2s_opacity] disabled:pointer-events-none! disabled:opacity-[0.3]';

/* Icon-button box. `!` on size/padding beats the un-layered button reset. */
export const BTN_ICON_BASE =
  'flex items-center justify-center text-center leading-none relative ' +
  'text-[1.5rem]! p-2! text-(--cyc-text-muted) ' +
  BTN_ICON_INTERACTION;

export function makeIcon(name: CycIconName, className = ''): HTMLSpanElement {
  const span = h(
    'span',
    `cyc-icon cyc-svgico ${SVGICO_UTILS} ${ICON_RESET_UTILS} ${className}`.trim()
  );

  span.innerHTML =
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    TABLER[name] +
    '</svg>';
  return span;
}

export function makeIconOrText(name: string, className = ''): HTMLSpanElement {
  if (name in TABLER) return makeIcon(name as CycIconName, className);
  const span = h('span', `cyc-icon ${ICON_RESET_UTILS} ${className}`.trim());
  span.textContent = name;
  return span;
}

export function wrapIcon(className = ''): HTMLSpanElement {
  const span = h(
    'span',
    `cyc-icon cyc-svgico ${SVGICO_UTILS} ${ICON_RESET_UTILS} ${className}`.trim()
  );
  span.innerHTML = WRAP_SVG;
  return span;
}

export function makeIconButton(
  name: CycIconName,
  extraClass = '',
  hoverBg = true,
  skin = true
): HTMLButtonElement {
  const btn = h(
    'button',
    `cyc-icon-btn ${skin ? `${BTN_ICON_BASE} ` : ''}${hoverBg ? `${BTN_HOVER_UTILS} ` : ''}${extraClass}`.trim()
  );
  btn.append(makeIcon(name));
  return btn;
}
