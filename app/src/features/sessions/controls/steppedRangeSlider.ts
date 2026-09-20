import {clampNumber} from '@/shared/numbers';

export type DialOption<T> = {label: HTMLElement | string; value: T};

export type SteppedRangeConfig<T> = {
  onPreview?: (value: T) => void;
  onGrab?: (grabbing: boolean) => void;
  onCommit?: (value: T) => void;
};

export type SteppedRange<T> = {
  readonly container: HTMLElement;
  setOptions(options: DialOption<T>[], index?: number): void;
  setIndex(index: number): void;
  readonly stops: HTMLButtonElement[];
  readonly value: T | undefined;
};

// Flex row of notches and segments. Fill is inked segments, not a thumb.
const ROOT_CLASS = [
  'cyc-steprange group border-0 m-0 min-w-0 p-0',
  '[--cyc-steprange-rail:0.2rem] [--cyc-steprange-dot:0.4rem] [--cyc-steprange-grip:0.8rem]',
  '[--cyc-steprange-round:999px] [--cyc-steprange-grab:1.2]',
  '[--cyc-steprange-ink:var(--cyc-accent)] [--cyc-steprange-idle:var(--cyc-text-muted)]',
  // Stops get their own color so a skin that fades the rail (the composer
  // dial does) keeps every stop visible as a dot on the line.
  '[--cyc-steprange-stop:var(--cyc-steprange-idle)]'
].join(' ');

const TRACK_CLASS = 'cyc-steprange-track relative flex items-center cursor-pointer';

// A run of rail between two adjacent notches; it inks to the accent once the
// selection has crossed onto its far notch.
const SEG_CLASS = [
  'cyc-steprange-seg pointer-events-none min-w-0 flex-1',
  'h-[var(--cyc-steprange-rail)] rounded-[var(--cyc-steprange-round)]',
  'bg-[var(--cyc-steprange-idle)] data-[reached=true]:bg-[var(--cyc-steprange-ink)]'
].join(' ');

// A radio button reset to a bare dot. A notch the selection has reached inks to
// the accent; the single selected notch swells to grip size. Deliberately NO
// transforms and NO transitions: the label lives inside this button, so any
// scale or size morph zoomed and lifted the text with it (the "weird
// animations" report, 2026-09-06). Selection changes paint instantly.
const NOTCH_CLASS = [
  'cyc-steprange-notch relative z-[1] flex-none appearance-none border-0 p-0 m-0 cursor-pointer',
  'h-[var(--cyc-steprange-dot)] w-[var(--cyc-steprange-dot)] rounded-[var(--cyc-steprange-round)]',
  // background is painted INLINE (createNotch/paintSelection): a bg-[...]
  // utility here loses to the shell reset's un-layered button background
  'data-[current=true]:h-[var(--cyc-steprange-grip)] data-[current=true]:w-[var(--cyc-steprange-grip)]'
].join(' ');

// The label rides above its notch, anchored to the notch's CENTER (50%), which
// stays put when the notch swells to grip size; anchoring to the top edge made
// the active label jump up with the bigger dot.
const TAG_CLASS = [
  'cyc-steprange-tag pointer-events-none absolute whitespace-nowrap',
  'bottom-[calc(50%_+_0.7rem)] text-[var(--cyc-steprange-idle)] text-[0.75rem]'
].join(' ');

export default function createSteppedRange<T>(config: SteppedRangeConfig<T>): SteppedRange<T> {
  const container = document.createElement('fieldset');
  const track = document.createElement('div');
  let options: DialOption<T>[] = [];
  let notches: HTMLButtonElement[] = [];
  let segments: HTMLSpanElement[] = [];
  let index = 0;
  let pointerId: number | null = null;
  let bounds: DOMRect | null = null;

  container.className = ROOT_CLASS;
  container.setAttribute('role', 'radiogroup');
  container.style.paddingInline = '1rem';
  container.style.paddingTop = '1rem';
  container.style.paddingBottom = '1rem';

  track.className = TRACK_CLASS;
  container.append(track);

  const last = () => Math.max(0, notches.length - 1);
  const selected = () => options[index]?.value;

  const paintSelection = (next: number) => {
    index = next;
    // Every notch from the start through the current one is inked; the single
    // chosen notch also carries `data-current` (grip size) and the a11y state.
    // A segment is filled once the selection has crossed onto its far notch.
    notches.forEach((notch, position) => {
      const current = position === next;
      const reached = position <= next;
      notch.dataset.reached = String(reached);
      notch.dataset.current = String(current);
      /* Inline, not a bg-[...] utility: the shell reset's un-layered
       * `button { background: transparent }` beats every layered utility, so
       * the notch dots never painted at all (found by measuring the live
       * page, 2026-09-06). setAttribute, because a non-browser DOM's style
       * setter can silently drop var() values and the cascade test
       * serializes this element's outerHTML. */
      notch.setAttribute(
        'style',
        `background-color: ${reached ? 'var(--cyc-steprange-ink)' : 'var(--cyc-steprange-stop, var(--cyc-steprange-idle))'}`
      );
      notch.setAttribute('aria-checked', current ? 'true' : 'false');
      notch.tabIndex = current ? 0 : -1;
    });
    segments.forEach((segment, position) => {
      segment.dataset.reached = String(next > position);
    });
    const value = selected();
    if (value !== undefined) config.onPreview?.(value);
  };

  const commit = () => {
    const value = selected();
    if (value !== undefined) config.onCommit?.(value);
  };

  const setIndex = (next: number) => {
    if (!notches.length) return;
    paintSelection(clampNumber(next, 0, last()));
  };

  const fractionAlong = (event: PointerEvent) => {
    if (!bounds) return 0;
    const span = Math.max(1, bounds.width);
    let fraction = clampNumber(event.clientX - bounds.left, 0, span) / span;
    if (document.documentElement.dir === 'rtl') fraction = 1 - fraction;
    return fraction;
  };

  const scrub = (event: PointerEvent) => {
    if (!bounds) return;
    paintSelection(clampNumber(Math.round(fractionAlong(event) * last()), 0, last()));
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId === pointerId) scrub(event);
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    track.removeEventListener('pointermove', onPointerMove);
    track.removeEventListener('pointerup', onPointerEnd);
    track.removeEventListener('pointercancel', onPointerEnd);
    if (track.hasPointerCapture?.(event.pointerId)) track.releasePointerCapture(event.pointerId);
    pointerId = null;
    bounds = null;
    delete container.dataset.grabbing;
    config.onGrab?.(false);
    commit();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || pointerId !== null || !notches.length) return;
    pointerId = event.pointerId;
    bounds = track.getBoundingClientRect();
    track.setPointerCapture?.(event.pointerId);
    track.addEventListener('pointermove', onPointerMove);
    track.addEventListener('pointerup', onPointerEnd);
    track.addEventListener('pointercancel', onPointerEnd);
    container.dataset.grabbing = 'true';
    config.onGrab?.(true);
    scrub(event);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!notches.length) return;
    let next = index;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last();
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit();
        return;
      default:
        return;
    }
    event.preventDefault();
    next = clampNumber(next, 0, last());
    if (next !== index) {
      paintSelection(next);
      commit();
    }
    notches[next]?.focus();
  };

  track.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('keydown', onKeyDown);

  const createNotch = (label: DialOption<T>['label'], position: number, lastIndex: number) => {
    const notch = document.createElement('button');
    notch.type = 'button';
    notch.setAttribute('role', 'radio');
    notch.setAttribute('aria-checked', 'false');
    notch.dataset.reached = 'false';
    notch.dataset.current = 'false';
    notch.tabIndex = position === 0 ? 0 : -1;
    notch.className = NOTCH_CLASS;
    // idle until paintSelection speaks; inline for the reset-beating reason above
    notch.setAttribute('style', 'background-color: var(--cyc-steprange-stop, var(--cyc-steprange-idle))');
    const tag = document.createElement('span');
    tag.className = TAG_CLASS;
    tag.append(label);
    notch.append(tag);
    // The two end labels would spill past the rail if centred over their notch, so
    // anchor them to the notch's outer (inline) edge -- logical, so it mirrors under
    // rtl the same way the flex row does; every interior label centres over its notch.
    if (position === 0) {
      tag.style.insetInlineStart = '0';
    } else if (position === lastIndex) {
      tag.style.insetInlineEnd = '0';
    } else {
      tag.style.left = '50%';
      tag.style.transform = 'translateX(-50%)';
    }
    return notch;
  };

  const setOptions = (next: DialOption<T>[], startIndex?: number) => {
    track.replaceChildren();
    options = next;
    index = 0;
    const lastIndex = Math.max(0, options.length - 1);
    notches = options.map((option, position) => createNotch(option.label, position, lastIndex));
    segments = [];
    notches.forEach((notch, position) => {
      if (position > 0) {
        const segment = document.createElement('span');
        segment.className = SEG_CLASS;
        segment.dataset.reached = 'false';
        segments.push(segment);
        track.append(segment);
      }
      track.append(notch);
    });
    if (startIndex !== undefined && notches.length) setIndex(startIndex);
  };

  return {
    container,
    setOptions,
    setIndex,
    get stops() {
      return notches;
    },
    get value() {
      return selected();
    }
  };
}
