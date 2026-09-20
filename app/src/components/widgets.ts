import {Notyf} from 'notyf';
import 'notyf/notyf.min.css';
import './toast.css';
import {h} from '../components/domHelpers';
import {BTN_HOVER_UTILS, makeIcon, makeIconOrText} from '../components/iconGlyphs';
import {
  currentPresentation,
  currentPresentationTheme,
  paintPresentation,
  paintTheme,
  registerThemePainter,
  type Presentation,
  type PresentationTheme
} from '../components/presentation';

type IconName = Parameters<typeof makeIcon>[0];

// The copper palette legs TS paints onto the toggle. These are literal, exact
// Tailwind arbitrary-value class strings so the static extractor sees them; the
// day/night colours match the SKIN palette in preferences.ts exactly.
const TRACK_BG: Record<PresentationTheme, {on: string; off: string}> = {
  day: {on: 'bg-[#96602f]', off: 'bg-[#6b6b70]'},
  night: {on: 'bg-[#c98652]', off: 'bg-[#a0a0a6]'}
};
const KNOB_BORDER: Record<PresentationTheme, {on: string; off: string}> = {
  day: {on: 'border-[#96602f]', off: 'border-[#6b6b70]'},
  night: {on: 'border-[#c98652]', off: 'border-[#a0a0a6]'}
};
const KNOB_BG: Record<PresentationTheme, string> = {
  day: 'bg-[#ffffff]',
  night: 'bg-[#17171a]'
};
const KNOB_TEXT_ON: Record<PresentationTheme, string> = {
  day: 'text-[#96602f]',
  night: 'text-[#c98652]'
};
// The knob is positioned from the physical end so no borrowed RTL geometry or
// custom-property arithmetic is needed.
const KNOB_SHIFT = {
  ltr: {on: 'translate-x-4', off: 'translate-x-0', pending: 'translate-x-2'},
  rtl: {on: '-translate-x-4', off: 'translate-x-0', pending: '-translate-x-2'}
} as const;

export type Toggle = {
  el: HTMLLabelElement;
  input: HTMLInputElement;
  set(checked: boolean): void;
  // A half-way, dimmed, tap-proof state for the stretch between a tap and the
  // real outcome; the caller settles it with set() when the truth is known.
  setPending(pending: boolean): void;
  setDisabled(disabled: boolean): void;
};

export function toggle(
  opts: {checked?: boolean; disabled?: boolean; onChange?: (checked: boolean) => void} = {}
): Toggle {
  const label = h(
    'label',
    [
      'cyc-tick cyc-tick-toggle cyc-toggle-standalone',
      'relative flex min-h-[20px] min-w-[20px] items-center',
      'mx-[0.3125rem] my-0 px-1 py-0 text-start cursor-pointer pointer-events-none',
      '[transition:opacity_0.2s]'
    ].join(' ')
  );
  const input = h(
    'input',
    'cyc-tick-input absolute m-0 h-px w-px overflow-hidden border-0 p-0 [clip-path:inset(50%)] whitespace-nowrap'
  );
  input.type = 'checkbox';
  input.checked = !!opts.checked;
  let pending = false;
  let disabled = false;
  const track = h(
    'div',
    [
      'cyc-toggle-track relative flex h-4 w-9 items-center',
      'mx-1 my-0 rounded-full [transition:background-color_120ms_ease-out]'
    ].join(' ')
  );
  const knob = h(
    'div',
    [
      'cyc-toggle-knob absolute start-0 h-5 w-5 rounded-[50%] border-2',
      // Tailwind v4 translate-x-* sets the `translate` property, not
      // `transform`; transitioning `transform` left the knob snapping.
      '[transition:border-color_0.1s,translate_0.1s_cubic-bezier(0.22,0.75,0.7,1.3)]'
    ].join(' ')
  );
  track.append(knob);
  label.append(input, track);

  let trackPaint: string[] = [];
  let knobPaint: string[] = [];
  const paint = (theme: PresentationTheme = currentPresentationTheme()) => {
    // Pending paints as neither state: off-coloured track, knob half-way.
    const on = input.checked && !pending;
    const dir = document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';
    track.classList.remove(...trackPaint);
    knob.classList.remove(...knobPaint);
    trackPaint = [on ? TRACK_BG[theme].on : TRACK_BG[theme].off];
    knobPaint = [
      on ? KNOB_BORDER[theme].on : KNOB_BORDER[theme].off,
      KNOB_BG[theme],
      pending ? KNOB_SHIFT[dir].pending : on ? KNOB_SHIFT[dir].on : KNOB_SHIFT[dir].off,
      ...(on ? [KNOB_TEXT_ON[theme]] : [])
    ];
    track.classList.add(...trackPaint);
    knob.classList.add(...knobPaint);
  };
  paintTheme(label, paint);

  // A disabled input swallows click() from the host row, so both states below
  // also make the toggle tap-proof, not just faded.
  const setPending = (p: boolean) => {
    pending = p;
    input.disabled = pending || disabled;
    label.classList.toggle('cyc-toggle-pending', p);
    label.classList.toggle('opacity-[0.6]', p);
    paint();
  };
  const setDisabled = (d: boolean) => {
    disabled = d;
    input.disabled = pending || disabled;
    label.classList.toggle('opacity-[0.3]', d);
    label.classList.toggle('pointer-events-none!', d);
    paint();
  };
  if (opts.disabled) setDisabled(true);

  input.addEventListener('change', () => {
    paint();
    opts.onChange?.(input.checked);
  });

  return {
    el: label,
    input,
    set(checked: boolean) {
      input.checked = checked;
      paint();
    },
    setPending,
    setDisabled
  };
}

const EYE_TEXT: Record<PresentationTheme, {shown: string; hidden: string}> = {
  day: {shown: 'text-[#1c1c1e]', hidden: 'text-[#6b6b70]'},
  night: {shown: 'text-[#ededee]', hidden: 'text-[#a0a0a6]'}
};

export function eyeState(shown: boolean): {el: HTMLElement; set(shown: boolean): void} {
  const el = h('span', 'cyc-eye-state');
  let state = shown;
  let colorPaint: string[] = [];
  const paintColor = (theme: PresentationTheme = currentPresentationTheme()) => {
    el.classList.remove(...colorPaint);
    colorPaint = [state ? EYE_TEXT[theme].shown : EYE_TEXT[theme].hidden];
    el.classList.add(...colorPaint);
  };
  const set = (s: boolean) => {
    state = s;
    el.replaceChildren(makeIcon(s ? 'eye' : 'eyeOff'));
    el.classList.toggle('cyc-eye-hidden', !s);
    paintColor();
  };
  set(shown);
  registerThemePainter(el, paintColor);
  return {el, set};
}

const CARD_SURFACE: Record<PresentationTheme, string> = {
  day: 'bg-[#ffffff]',
  night: 'bg-[#17171a]'
};
const CARD_SHADOW: Record<PresentationTheme, string> = {
  day: 'shadow-[0px_1px_4px_0px_rgba(0,0,0,0.05)]',
  night: 'shadow-[0px_1px_4px_0px_rgba(0,0,0,0.12)]'
};
const CARD_HEADING_COLOR: Record<PresentationTheme, string> = {
  day: 'text-[#96602f]',
  night: 'text-[#c98652]'
};
const CARD_FOOTER_COLOR: Record<PresentationTheme, string> = {
  day: 'text-[#6b6b70]',
  night: 'text-[#a0a0a6]'
};

export function settingsCard(
  opts: {heading?: string; footer?: string},
  ...children: HTMLElement[]
): HTMLDivElement {
  const container = h('div', 'cyc-block-box px-4');
  const inner = h('div', 'cyc-block mb-4 rounded-[6px] py-2');
  const content = h('div', 'cyc-block-content');
  let heading: HTMLElement | undefined;
  if (opts.heading) {
    heading = h(
      'div',
      'cyc-card-heading flex justify-between px-4 py-2 text-[length:1rem] font-semibold'
    );
    heading.textContent = opts.heading;
    content.append(heading);
  }
  content.append(...children);
  inner.append(content);
  container.append(inner);
  let footer: HTMLElement | undefined;
  if (opts.footer) {
    footer = h(
      'div',
      'cyc-block-content cyc-card-footer -mt-1.5 mx-0 mb-4 px-4 text-[length:0.875rem] leading-[18px]'
    );
    footer.textContent = opts.footer;
    container.append(footer);
  }

  let surfacePaint: string[] = [];
  const paint = (p: Presentation = currentPresentation()) => {
    // Surface fill + drop shadow follow the theme; the content inset follows the
    // width bucket (flush on phone, 0.5rem inset from tablet up).
    inner.classList.remove(...surfacePaint);
    surfacePaint = [CARD_SURFACE[p.theme], CARD_SHADOW[p.theme]];
    inner.classList.add(...surfacePaint);
    content.classList.remove('mx-0', 'mx-2');
    content.classList.add(p.width === 'phone' ? 'mx-0' : 'mx-2');
    heading?.classList.remove('text-[#96602f]', 'text-[#c98652]');
    heading?.classList.add(CARD_HEADING_COLOR[p.theme]);
    footer?.classList.remove('text-[#6b6b70]', 'text-[#a0a0a6]');
    footer?.classList.add(CARD_FOOTER_COLOR[p.theme]);
  };
  paintPresentation(container, paint);
  return container;
}

// Generic row inset: 4rem phone, 3.5rem otherwise (the desktop side pane is a
// fixed 320px column, and the old 4.5rem inset left labels ~120px and
// ellipsized half the settings titles; 2026-09-06). chatRow has its own inset.
export function paintRowChrome(el: HTMLElement): void {
  const inset = el.classList.contains('cyc-list-row-inset');
  const press = el.classList.contains('cyc-list-row-press');
  if (!inset && !press) return;
  const paint = (p: Presentation = currentPresentation()) => {
    const phone = p.width === 'phone';
    if (inset) {
      el.classList.remove('ps-[4rem]!', 'ps-[3.5rem]!');
      el.classList.add(phone ? 'ps-[4rem]!' : 'ps-[3.5rem]!');
    }
    if (press) el.classList.toggle('rounded-[16px]', !phone);
  };
  paintPresentation(el, paint);
}

export function row(opts: {
  icon?: IconName | string;
  title: string;
  subtitle?: string;
  rightContent?: HTMLElement | string;
  clickable?: boolean | ((e: MouseEvent) => void);
}): HTMLElement {
  const isToggle =
    opts.rightContent instanceof HTMLElement &&
    opts.rightContent.classList.contains('cyc-tick-toggle');

  const container: HTMLElement = h(
    'div',
    'cyc-list-row relative flex min-h-14 flex-col justify-center px-4 py-0! whitespace-nowrap [transition:opacity_0.3s_cubic-bezier(0.32,0.72,0,1)]'
  );

  if (opts.subtitle) {
    const subtitle = h(
      'div',
      [
        'cyc-list-row-subtitle relative order-1 pointer-events-none overflow-hidden text-ellipsis whitespace-nowrap',
        'text-[color:var(--cyc-text-muted)] text-[length:0.8125rem]',
        'leading-[18px] mt-[0.1875rem]'
      ].join(' ')
    );
    subtitle.textContent = opts.subtitle;
    container.append(subtitle);
  } else container.classList.add('cyc-list-row-title-only', 'min-h-[3rem]!');

  const title = h(
    'div',
    [
      'cyc-list-row-title relative order-0 pointer-events-none whitespace-nowrap',
      'overflow-hidden text-ellipsis [word-break:break-word]',
      'text-[length:0.9375rem] leading-[var(--cyc-line-height)] text-[var(--cyc-text)]'
    ].join(' ')
  );
  title.textContent = opts.title;
  if (opts.rightContent != null) {
    const titleRow = h(
      'div',
      'cyc-list-row-line cyc-list-row-title-line order-0 flex items-center justify-between'
    );
    title.classList.add('whitespace-nowrap', 'min-w-0', 'flex-auto');
    const right = h(
      'div',
      [
        'cyc-list-row-title cyc-list-row-right relative pointer-events-none flex-none ms-4',
        'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [word-break:break-word]',
        'text-[length:0.9375rem] leading-[var(--cyc-line-height)]'
      ].join(' ')
    );
    if (typeof opts.rightContent === 'string') {
      right.classList.add('cyc-list-row-right-muted', 'text-[var(--cyc-text-muted)]');
      right.textContent = opts.rightContent;
    } else {
      right.classList.add('text-[var(--cyc-text)]');
      opts.rightContent.classList.remove('cyc-toggle-standalone');
      right.append(opts.rightContent);
    }
    titleRow.append(title, right);
    container.append(titleRow);
  } else container.append(title);

  if (isToggle) {
    const toggleEl = opts.rightContent as HTMLElement;
    toggleEl.classList.add('[position:unset]!', 'my-0!', 'mx-[0.125rem]!', 'p-0!', 'h-auto!');
    const input = toggleEl.querySelector('input');
    input?.setAttribute('aria-label', opts.title);
    container.addEventListener('click', (e) => {
      if (!toggleEl.contains(e.target as Node)) input?.click();
    });
  }
  if (opts.icon) {
    container.append(
      makeIconOrText(
        opts.icon,
        'cyc-list-row-icon pointer-events-none absolute start-4 top-1/2 z-[1] [transform:translateY(-50%)] text-xl text-[var(--cyc-text-muted)]'
      )
    );
    container.classList.add('cyc-list-row-has-icon', 'cyc-list-row-inset');
  }
  if (opts.clickable || isToggle) {
    container.classList.add(
      'cyc-list-row-press',
      'cyc-lit',
      'cursor-pointer',
      'overflow-hidden',
      ...BTN_HOVER_UTILS.split(' ')
    );
    if (typeof opts.clickable === 'function') container.addEventListener('click', opts.clickable);
  }
  paintRowChrome(container);
  return container;
}

// Search-field colours. `!` on fills beats the input/button resets.
type SearchTheme = {
  plainBg: string; // plain-mode resting fill (flat neutral surface)
  filledBg: string; // default-mode resting fill (raised field surface)
  filledBorder: string; // default-mode resting border
  primaryBorder: string; // accent border on focus (also the focus ring)
  hoverBorder: string; // muted border on a fine-pointer hover
  primaryText: string; // accent ink for the focused icon/clear
  secondaryText: string; // muted ink for the resting icon/clear
  typedText: string; // primary ink for the typed value
  caret: string; // accent caret
  // Clear-button hover tints: the same 10% wash of accent / muted ink used
  // elsewhere (--cyc-accent-tint / --cyc-text-muted-tint).
  clearHoverFocused: string; // accent 10% wash
  clearHoverBlurred: string; // muted 10% wash
};
const SEARCH_SKIN: Record<PresentationTheme, SearchTheme> = {
  day: {
    plainBg: 'bg-[#ece9e3]!',
    filledBg: 'bg-[#f2f2f3]!',
    filledBorder: 'border-[#e6e6e8]',
    primaryBorder: 'border-[#96602f]',
    hoverBorder: 'border-[#6b6b70]',
    primaryText: 'text-[#96602f]',
    secondaryText: 'text-[#6b6b70]',
    typedText: 'text-[#1c1c1e]',
    caret: 'caret-[#96602f]',
    clearHoverFocused: 'bg-[rgba(150,96,47,0.1)]!',
    clearHoverBlurred: 'bg-[rgba(107,107,112,0.1)]!'
  },
  night: {
    plainBg: 'bg-[#0d0d0e]!',
    filledBg: 'bg-[#17171a]!',
    filledBorder: 'border-[#000000]',
    primaryBorder: 'border-[#c98652]',
    hoverBorder: 'border-[#a0a0a6]',
    primaryText: 'text-[#c98652]',
    secondaryText: 'text-[#a0a0a6]',
    typedText: 'text-[#ededee]',
    caret: 'caret-[#c98652]',
    clearHoverFocused: 'bg-[rgba(201,134,82,0.1)]!',
    clearHoverBlurred: 'bg-[rgba(160,160,166,0.1)]!'
  }
};

export function inputSearch(
  placeholder = 'Search',
  onChange?: (value: string) => void,
  opts: {plain?: boolean} = {}
): HTMLDivElement {
  const plain = opts.plain === true;

  const container = h(
    'div',
    'cyc-search relative flex w-full items-center overflow-hidden rounded-[6px] me-0'
  );
  // Search geometry (root font-size is 15px). The leading glyph sits
  // in a fixed gutter and the field reserves that gutter (plus the trailing clear
  // button) as symmetric inline padding, so the value/placeholder start clear of
  // the icon: 0.875rem gutter + 1.5rem glyph + a 0.375rem gap == 2.75rem. The
  // 2.75rem control height and 0.18s colour fade are the field's own scale.
  const input = h(
    'input',
    [
      'cyc-search-input box-border relative z-[1] w-full',
      'h-[2.75rem] min-h-[2.75rem] leading-[21px]',
      'rounded-[6px] border-[1px] border-solid px-[2.75rem] py-0',
      '[transition:background-color_0.18s_ease,border-color_0.18s_ease]'
    ].join(' '),
    {type: 'text', placeholder: ' ', autocomplete: 'off'}
  );
  const overlay = h(
    'div',
    [
      'cyc-search-border pointer-events-none absolute inset-0 z-[1]',
      'rounded-[6px] border-2 border-solid opacity-0 [transition:opacity_0.18s_ease]'
    ].join(' ')
  );
  const searchIcon = makeIcon(
    'search',
    [
      'cyc-search-icon pointer-events-none absolute z-[1] start-[0.875rem] text-center leading-none',
      'h-[1.5rem] w-[1.5rem] text-[length:1.5rem]',
      '[transition:opacity_0.18s_ease,color_0.18s_ease]'
    ].join(' ')
  );
  const clearBtn = h(
    'button',
    [
      // The unlayered reset.css button reset zeroes padding and drops font-size
      // to inherit, so a plain `p-1.5` collapses the box to 15x15px and the
      // 1em close SVG shrinks to the 16px root. The dropped .cyc-icon-btn skin
      // used to supply font-size:1.5rem; reproduce the base 33.8px geometry by
      // marking both spacing and size important (5.625px pad + 22.5px icon).
      'cyc-search-clear relative flex items-center justify-center rounded-[6px] p-1.5!',
      'cursor-pointer border-none bg-transparent text-center leading-none text-[length:1.5rem]!',
      '[transition:opacity_0.18s_ease,color_0.18s_ease,background-color_0.12s_ease]'
    ].join(' ')
  );
  clearBtn.type = 'button';
  clearBtn.append(makeIcon('close'));
  const placeholderEl = h(
    'span',
    [
      'cyc-search-placeholder pointer-events-none absolute z-[1] whitespace-nowrap text-[#9e9e9e]',
      'start-[2.75rem] origin-[left_center]',
      '[animation:cyc-search-label-reveal_0.25s_forwards_ease-in-out]'
    ].join(' ')
  );
  placeholderEl.textContent = placeholder;

  container.append(input, overlay, searchIcon, clearBtn, placeholderEl);

  let focused = false;
  let hovered = false;
  let clearHovered = false;
  let inputPaint: string[] = [];
  let overlayPaint: string[] = [];
  let iconPaint: string[] = [];
  let clearPaint: string[] = [];

  const render = (p: Presentation = currentPresentation()) => {
    const skin = SEARCH_SKIN[p.theme];
    const fine = p.pointer === 'fine';
    const empty = !input.value;

    // Container inset follows the width bucket (phone start inset is tighter).
    container.classList.remove('ms-1', 'ms-2');
    container.classList.add(p.width === 'phone' ? 'ms-1' : 'ms-2');

    // Input: fill + border by focus / fine-hover / plain-or-filled base.
    input.classList.remove(...inputPaint);
    const inputBg = focused ? 'bg-transparent' : plain ? skin.plainBg : skin.filledBg;
    const inputBorder = focused
      ? skin.primaryBorder
      : hovered && fine
        ? skin.hoverBorder
        : plain
          ? 'border-transparent'
          : skin.filledBorder;
    inputPaint = [inputBg, inputBorder, skin.typedText, skin.caret];
    input.classList.add(...inputPaint);

    // Focus-ring overlay: primary border, faded in only while focused.
    overlay.classList.remove(...overlayPaint);
    overlayPaint = [skin.primaryBorder, focused ? 'opacity-100' : 'opacity-0'];
    overlay.classList.add(...overlayPaint);

    // Search icon: primary + full opacity on focus, else a muted secondary.
    searchIcon.classList.remove(...iconPaint);
    iconPaint = [
      focused ? skin.primaryText : skin.secondaryText,
      focused ? 'opacity-100' : 'opacity-[0.6]'
    ];
    searchIcon.classList.add(...iconPaint);

    // Clear button: matches the icon colour, hidden while empty, tinting its
    // background only on a fine-pointer hover (focused vs blurred tint).
    clearBtn.classList.remove(...clearPaint);
    const clearBg =
      clearHovered && fine
        ? focused
          ? skin.clearHoverFocused
          : skin.clearHoverBlurred
        : 'bg-transparent';
    clearPaint = [
      focused ? skin.primaryText : skin.secondaryText,
      focused ? 'opacity-100' : 'opacity-[0.6]',
      clearBg
    ];
    clearBtn.classList.add(...clearPaint);
    clearBtn.hidden = empty;

    // Placeholder shows only while the field is empty.
    placeholderEl.hidden = !empty;
  };

  input.addEventListener('input', () => {
    render();
    onChange?.(input.value);
  });
  input.addEventListener('focus', () => {
    focused = true;
    render();
  });
  input.addEventListener('blur', () => {
    focused = false;
    render();
  });
  input.addEventListener('mouseenter', () => {
    hovered = true;
    render();
  });
  input.addEventListener('mouseleave', () => {
    hovered = false;
    render();
  });
  clearBtn.addEventListener('mouseenter', () => {
    clearHovered = true;
    render();
  });
  clearBtn.addEventListener('mouseleave', () => {
    clearHovered = false;
    render();
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    render();
    onChange?.(input.value);
    input.focus();
  });

  paintPresentation(container, render);

  return container;
}

let notyf: Notyf | undefined;
function notify() {
  notyf ??= new Notyf({
    duration: 3000,
    ripple: false,
    position: {x: 'center', y: 'center'},
    dismissible: false,
    types: [
      {
        type: 'info',
        background: 'rgba(0, 0, 0, 0.66)',
        icon: false,
        className: 'cyc-notyf'
      }
    ]
  });
  return notyf;
}

export type Toast = {
  // Take the notice down before its time: what it said is no longer so.
  dismiss(): void;
};

export function toast(content: string | Node, duration = 3000): Toast {
  const message = typeof content === 'string' ? content : (content.textContent ?? '');
  const n = notify();
  const shown = n.open({type: 'info', message, duration});
  return {dismiss: () => n.dismiss(shown)};
}

type PopupButton = {
  text: string;
  danger?: boolean;
  // A greyed button, with the reason as its tooltip.
  disabled?: boolean;
  title?: string;
  callback?: (value: string) => void;
};

type PopupInput = {placeholder: string; rows?: number; maxLength?: number};

const DIALOG_TEXT: Record<PresentationTheme, string> = {
  day: 'text-[#1c1c1e]',
  night: 'text-[#ededee]'
};
const DIALOG_BG: Record<PresentationTheme, string> = {
  day: 'bg-[#ece9e3]',
  night: 'bg-[#0d0d0e]'
};
const DIALOG_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const DIALOG_BACKDROP_TRANSITION = `opacity 0.15s ${DIALOG_EASE}`;
const DIALOG_BOX_TRANSITION = `opacity 0.15s ${DIALOG_EASE}, transform 0.16s ${DIALOG_EASE}`;
const DIALOG_BOX_REST = 'scale(0.96)';
const DIALOG_BOX_SHOWN = 'scale(1)';

export function confirmPopup(opts: {
  title: string;
  description?: string;
  buttons?: PopupButton[];
  className?: string;
  input?: PopupInput;
}): HTMLDivElement {
  const theme = currentPresentationTheme();
  const element = h(
    'div',
    'cyc-modal cyc-modal-dialog fixed inset-0 z-[15] m-0 flex overflow-auto bg-[rgba(0,0,0,0.34)] p-[1.75rem] text-[1rem] ' +
      DIALOG_TEXT[theme] +
      (opts.className ? ' ' + opts.className : '')
  );
  const container = h(
    'div',
    'cyc-modal-box cyc-elevation-low px-2 py-3 relative flex flex-col overflow-hidden m-auto w-[min-content] min-w-[min(100%,20rem)] max-w-[min(100%,24rem)] ' +
      DIALOG_BG[theme]
  );
  const header = h(
    'div',
    'cyc-modal-header relative m-0 flex h-10 w-max max-w-full flex-none items-center px-4'
  );
  const title = h(
    'div',
    [
      'cyc-modal-title m-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap pe-4',
      'text-[1.25rem] leading-[26px] font-medium'
    ].join(' ')
  );
  title.textContent = opts.title;
  header.append(title);
  container.append(header);

  if (opts.description) {
    const description = h(
      'p',
      [
        'cyc-modal-text my-0 min-w-[min(100%,15rem)] max-w-fit flex-none overflow-hidden',
        'text-ellipsis whitespace-pre-wrap px-4 pt-2.5 pb-2 leading-[var(--cyc-line-height)]',
        '[word-break:break-word]'
      ].join(' ')
    );
    description.textContent = opts.description;
    container.append(description);
  }

  let field: HTMLTextAreaElement | null = null;
  if (opts.input) {
    const wrap = h('div', 'cyc-field relative mx-4 mt-2 flex items-center');
    field = h(
      'textarea',
      [
        'cyc-field-input box-border relative z-[1] w-full resize-y',
        'min-h-[72px] max-h-[40vh] px-4 py-3 leading-[1.3]',
        'rounded-xl border border-solid border-[var(--cyc-border-color)]',
        'bg-[var(--cyc-surface)] [transition:border-color_0.15s]',
        'fine:hover:border-(--cyc-accent) fine:focus:border-(--cyc-accent)'
      ].join(' '),
      {
        rows: String(opts.input.rows ?? 4),
        placeholder: opts.input.placeholder,
        maxlength: String(opts.input.maxLength ?? 2000),
        autocomplete: 'off'
      }
    ) as HTMLTextAreaElement;
    wrap.append(field);
    container.append(wrap);
  }

  let closed = false;
  const hide = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    // `.hiding`/`.active` remain as behavioural markers; the fade is inline. The
    // backdrop fades out as the box zooms back down to its shrunk rest, then the
    // node is dropped once that exit completes (just past the 0.16s box transition).
    element.classList.add('hiding');
    element.classList.remove('active');
    element.style.opacity = '0';
    container.style.opacity = '0';
    container.style.transform = DIALOG_BOX_REST;
    setTimeout(() => element.remove(), 220);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    hide();
  };

  const buttons = opts.buttons?.length ? opts.buttons : [{text: 'OK'} as PopupButton];
  // Three-or-more buttons stack vertically.
  const vertical = buttons.length >= 3;
  const buttonsEl = h(
    'div',
    'cyc-modal-btns flex flex-none justify-start px-2 ' +
      (vertical ? 'flex-col items-stretch h-auto' : 'flex-row-reverse items-center h-12')
  );
  buttons.forEach((b, i) => {
    // `px-4!` beats the un-layered reset.css `button{padding:0}` reset; the inline
    // 0.625rem gap reproduces the `.cyc-sheet-btn + .cyc-sheet-btn` sibling margin
    // (which the vertical stack zeroed).
    const gap = !vertical && i > 0 ? ' me-[0.625rem]' : '';
    const btn = h(
      'button',
      'cyc-sheet-btn cyc-ctl relative h-10 max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-2xl px-4! font-medium uppercase' +
        gap +
        (b.danger
          ? ' cyc-danger fine:hover:bg-(--cyc-danger-tint)! fine:active:bg-(--cyc-danger-tint)!'
          : ' cyc-emphasis fine:hover:bg-(--cyc-accent-tint)! fine:active:bg-(--cyc-accent-tint)!')
    );
    btn.append(b.text);
    if (b.title) btn.title = b.title;
    if (b.disabled) {
      btn.disabled = true;
      btn.classList.add('opacity-40');
    }
    btn.addEventListener('click', () => {
      const value = field?.value ?? '';
      b.callback?.(value);
      hide();
    });
    buttonsEl.append(btn);
  });
  container.append(buttonsEl);
  element.append(container);

  element.addEventListener('click', (e) => e.target === element && hide());

  // Hidden initial state: transparent backdrop, box shrunk a touch. The reveal
  // fades the backdrop in and zooms the box up to its resting scale(1).
  element.style.opacity = '0';
  element.style.transition = DIALOG_BACKDROP_TRANSITION;
  container.style.opacity = '0';
  container.style.transform = DIALOG_BOX_REST;
  container.style.transition = DIALOG_BOX_TRANSITION;

  document.body.append(element);
  document.addEventListener('keydown', onKeyDown, true);
  void element.offsetWidth;
  element.classList.add('active');
  element.style.opacity = '1';
  container.style.opacity = '1';
  container.style.transform = DIALOG_BOX_SHOWN;

  if (field) setTimeout(() => field?.focus(), 60);
  return element;
}

export function confirmPluginAction(opts: {
  title: string;
  confirm: {label: string; message: string};
  className?: string;
  onConfirm: () => void;
}): HTMLDivElement {
  return confirmPopup({
    title: opts.title,
    description: opts.confirm.message,
    className: opts.className ?? 'cyc-confirm-plugin',
    buttons: [
      {text: 'Cancel'},
      {text: opts.confirm.label, danger: true, callback: () => opts.onConfirm()}
    ]
  });
}

export function confirmExitSession(name: string, onConfirm: () => void): HTMLDivElement {
  return confirmPopup({
    title: 'Close this session?',
    description:
      `Close the pane running ${name}. Its agent stops and the ` +
      'conversation goes with it, and that cannot be undone.',
    className: 'cyc-confirm-exit',
    buttons: [{text: 'Cancel'}, {text: 'Close', danger: true, callback: () => onConfirm()}]
  });
}
