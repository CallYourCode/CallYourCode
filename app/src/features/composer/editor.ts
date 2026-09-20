import {clampNumber} from '@/shared/numbers';

type AutosizeOptions = {
  maxHeight?: number;
  onHeightChange?: (height: number) => void;
};

type Autosize = {
  update(noAnimation?: boolean): void;
  setMaxHeight(px: number | undefined): void;
  destroy(): void;
};

// The glide is paced by how far the box travels, so a one-line growth reads as
// near-instant while a paste-sized jump still animates. Capped so a huge paste
// does not leave the field crawling.
const GLIDE_MS_PER_PX = 1.5;
const GLIDE_CEIL_MS = 200;

const GLIDING_CLASS = 'cyc-field-resizing';

// The field fills its slot and owns its own vertical scroll, with the scrollbar
// suppressed on every engine.
const FIELD_UTILS = [
  'cyc-overflow',
  'cyc-overflow-y',
  'absolute',
  'inset-0',
  'w-full',
  'h-full',
  'max-h-full',
  'overflow-hidden',
  '[-webkit-overflow-scrolling:touch]',
  'overflow-y-auto',
  '[scrollbar-width:none]',
  '[&::-webkit-scrollbar]:hidden',
  'overscroll-y-contain'
];

export function autosize(input: HTMLElement, options: AutosizeOptions = {}): Autosize {
  let ceiling = options.maxHeight;
  let painted = 0;
  let glideTimer: number | undefined;

  input.classList.add(...FIELD_UTILS);
  input.style.position = 'relative';

  const writeCeiling = () => {
    input.style.maxHeight = ceiling === undefined ? '' : `${ceiling}px`;
  };

  // `scrollHeight` only reports the content extent while the box is unconstrained,
  // so the field is briefly released and put straight back.
  const contentHeight = () => {
    const {height, overflowY} = input.style;
    input.style.height = 'auto';
    input.style.overflowY = 'hidden';
    const measured = input.scrollHeight;
    input.style.height = height;
    input.style.overflowY = overflowY;
    return measured;
  };

  const stopGlide = () => {
    if (glideTimer === undefined) return;
    clearTimeout(glideTimer);
    glideTimer = undefined;
  };

  // Hold the gliding marker for exactly as long as the height transition runs.
  const glide = (ms: number) => {
    stopGlide();
    if (ms <= 0) {
      input.classList.remove(GLIDING_CLASS);
      return;
    }
    input.classList.add(GLIDING_CLASS);
    glideTimer = window.setTimeout(() => {
      glideTimer = undefined;
      input.classList.remove(GLIDING_CLASS);
    }, ms);
  };

  const paint = (animate: boolean) => {
    const ceilingPx = ceiling ?? Number.POSITIVE_INFINITY;
    const target = clampNumber(contentHeight(), 0, ceilingPx);
    if (target === painted) return;

    const travel = Math.abs(target - painted);
    const ms = animate ? Math.min(GLIDE_CEIL_MS, Math.round(travel * GLIDE_MS_PER_PX)) : 0;
    painted = target;

    input.style.transitionDuration = `${ms}ms`;
    input.style.height = `${target}px`;
    options.onHeightChange?.(target);
    glide(ms);
  };

  const onInput = () => paint(true);
  input.addEventListener('input', onInput);

  writeCeiling();

  return {
    update(noAnimation = false) {
      paint(!noAnimation);
    },
    setMaxHeight(px: number | undefined) {
      ceiling = px;
      writeCeiling();
      paint(false);
    },
    destroy() {
      input.removeEventListener('input', onInput);
      stopGlide();
    }
  };
}

export function applyTextDirection(elem: Element) {
  elem.setAttribute('dir', 'auto');
}
