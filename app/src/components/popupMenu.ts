import {placeMenu, type PopupAnchor} from '@/features/chat/placeMenu';
import {
  currentPresentation,
  registerThemePainter,
  type Presentation
} from '../components/presentation';
import {h} from '../components/domHelpers';
import {makeIcon, type CycIconName} from '../components/iconGlyphs';

export type CycMenuItem = {
  icon?: CycIconName;
  text: string;
  onClick: (e: MouseEvent | TouchEvent) => void;
  danger?: boolean;
  disabled?: boolean;
  // Why a disabled item is disabled, as the row's tooltip.
  title?: string;

  section?: boolean;
};

type CycMenuOptions = {
  triggerElement?: HTMLElement;
  onClose?: () => void;

  className?: string;
};

export type PointerSource = TouchEvent | Touch | MouseEvent;

function anchorFromEvent(event: PointerSource): PopupAnchor {
  const point =
    'touches' in event && event.touches.length ? event.touches[0] : (event as Touch | MouseEvent);
  return {x: point.clientX, y: point.clientY};
}

const CLOSE_REMOVE_DELAY = 200;

const MODAL_TEXT: Record<Presentation['theme'], string> = {
  day: 'text-[#1c1c1e]',
  night: 'text-[#ededee]'
};
const BOX_BG: Record<Presentation['theme'], string> = {
  day: 'bg-[#ece9e3]',
  night: 'bg-[#0d0d0e]'
};
const SHEET_ICON_COLOR: Record<Presentation['theme'], string> = {
  day: 'text-[#6b6b70]!',
  night: 'text-[#a0a0a6]!'
};

const BOX_TRANSITION = 'transform 0.18s cubic-bezier(0.16, 1, 0.3, 1)';
const MODAL_SHOW = 'opacity 0.16s ease-out, visibility 0s linear';
const MODAL_HIDE = 'opacity 0.12s ease-in, visibility 0s linear 0.12s';

// Context-menu chrome. Open/close is `data-cyc-phase`; placeMenu sets origin inline.
const MENU_BASE = [
  'fixed z-20 w-max text-sm cyc-elevation-low p-2 backdrop-blur-md',
  'invisible opacity-0 translate-y-1',
  '[transition:opacity_120ms_ease-out,translate_120ms_ease-out,visibility_0s_linear_120ms]',
  '[&[data-cyc-phase=open]]:visible [&[data-cyc-phase=open]]:opacity-100',
  '[&[data-cyc-phase=open]]:translate-y-0',
  '[&[data-cyc-phase=open]]:[transition:opacity_120ms_ease-out,translate_120ms_ease-out,visibility_0s]'
].join(' ');

// Inline background so the minifier cannot quantize the alpha. Theme painter updates live.
const MENU_BG: Record<Presentation['theme'], string> = {
  day: 'rgba(255, 255, 255, 0.9)',
  night: 'rgba(23, 23, 26, 0.82)'
};

function paintMenuBg(el: HTMLElement, theme: Presentation['theme']): void {
  el.style.backgroundColor = MENU_BG[theme];
}

const MENU_ITEM_BASE =
  'relative grid items-center gap-3 cursor-pointer text-[var(--cyc-text)] text-start';
// An item with an icon reserves the 1.5rem icon track; an icon-less item is a
// single text track. Without this, a lone text span auto-places into the fixed
// 1.5rem column and clips to one character (the harness picker bug).
const MENU_ITEM_COLS_ICON = 'grid-cols-[1.5rem_minmax(0,1fr)]';
const MENU_ITEM_COLS_TEXT = 'grid-cols-[minmax(0,1fr)]';
const ITEM_PRESS = 'transition-colors duration-100 active:opacity-75';
const MENU_ITEM_ICON_BASE =
  'cyc-menu-item-icon flex size-6 items-center justify-center p-0 text-xl text-current';
const MENU_ITEM_TEXT =
  'cyc-menu-item-text min-w-0 overflow-hidden text-ellipsis whitespace-nowrap pointer-events-none';

type ItemCtx = {
  variant: 'context' | 'sheet';
  bits: boolean;
  phone: boolean;
  theme: Presentation['theme'];
};

const hasBits = (className?: string) => /(?:^|\s)cyc-bits(?:\s|$)/.test(className ?? '');

// Per-variant item layout. Radius comes from utilities.css.
function itemLayout(ctx: ItemCtx): string[] {
  if (ctx.variant === 'sheet') {
    return ['min-h-13 px-4 py-2 text-[15px] leading-5 font-normal'];
  }
  if (ctx.bits) {
    return [
      'min-h-9 max-w-[min(42rem,calc(100vw-1.5rem))] px-3 py-2',
      'items-start text-[13px] leading-[1.35] font-medium',
      ITEM_PRESS
    ];
  }
  return ['min-h-10 px-3 py-2 text-sm leading-5 font-semibold', ITEM_PRESS];
}

// Final icon geometry. Context centres the glyph at the base 1.25rem size; the
// sheet grows it to 1.5rem, keeps the base trailing margin at 1.5rem, and tints
// it with the theme's secondary text colour.
function iconLayout(ctx: ItemCtx): string[] {
  return ctx.variant === 'sheet' ? [SHEET_ICON_COLOR[ctx.theme]] : [];
}

let currentMenu:
  | {
      element: HTMLElement;
      close: () => void;
    }
  | undefined;

function closeMenu() {
  currentMenu?.close();
}

function menuItem(item: CycMenuItem, ctx: ItemCtx): HTMLElement {
  if (item.section) {
    const head = h(
      'div',
      'cyc-menu-section px-4 pt-2 pb-1 text-xs font-semibold tracking-[0.02em] uppercase text-[var(--cyc-text-muted)] pointer-events-none'
    );
    head.textContent = item.text;
    return head;
  }
  const mods = [item.danger && 'cyc-danger', item.disabled && 'cyc-menu-item-disabled'].filter(
    Boolean
  );
  const stateUtils = item.danger
    ? 'fine:hover:bg-(--cyc-danger-tint)! fine:active:bg-(--cyc-danger-tint)!'
    : 'fine:hover:bg-(--cyc-text-muted-tint)! fine:active:bg-(--cyc-text-muted-tint)!';
  const cols = item.icon ? MENU_ITEM_COLS_ICON : MENU_ITEM_COLS_TEXT;
  const el = h(
    'div',
    ['cyc-menu-item', MENU_ITEM_BASE, cols, ...itemLayout(ctx), stateUtils, ...mods].join(' ')
  );
  if (item.icon)
    el.append(
      makeIcon(item.icon, ['cyc-menu-item-icon', MENU_ITEM_ICON_BASE, ...iconLayout(ctx)].join(' '))
    );
  const text = h('span', 'cyc-menu-item-text ' + MENU_ITEM_TEXT);
  text.textContent = item.text;
  el.append(text);
  if (item.title) el.title = item.title;
  if (item.disabled) return el;
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    item.onClick(e);
    closeMenu();
  });
  return el;
}

function scrollToEnd(scroller: HTMLElement) {
  scroller.scrollTop = scroller.scrollHeight;
}

export function openMenu(items: CycMenuItem[], event: PointerSource, options: CycMenuOptions = {}) {
  closeMenu();

  if ('preventDefault' in event) {
    (event as Event).preventDefault();
    (event as Event).stopPropagation();
  }

  const p = currentPresentation();
  const bits = hasBits(options.className);
  // Bits menus use a taller cap; dvh tracks mobile chrome.
  const geometry = [
    'min-w-[13.5rem]!',
    bits ? 'max-h-[calc(100vh-1rem)]' : 'max-h-[70dvh]',
    'overflow-y-auto',
    'overscroll-contain',
    '[-webkit-overflow-scrolling:touch]'
  ].join(' ');
  const element = h(
    'div',
    'cyc-menu cyc-menu-context ' +
      MENU_BASE +
      ' ' +
      geometry +
      (options.className ? ' ' + options.className : '')
  );
  paintMenuBg(element, p.theme);
  const unpaintTheme = registerThemePainter(element, (theme) => paintMenuBg(element, theme));
  const ctx: ItemCtx = {variant: 'context', bits, phone: p.width === 'phone', theme: p.theme};
  element.append(...items.map((it) => menuItem(it, ctx)));

  document.body.append(element);

  const holdSelection = (e: Event) => e.preventDefault();
  element.addEventListener('mousedown', holdSelection);
  element.addEventListener('pointerdown', holdSelection);

  placeMenu(anchorFromEvent(event), element);

  const onDocumentClick = (e: MouseEvent | TouchEvent) => {
    if (element.contains(e.target as Node)) return;
    close();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const onGlobalClose = () => close();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    currentMenu = undefined;

    element.dataset.cycPhase = 'closing';
    options.triggerElement?.removeAttribute('data-cyc-menu-open');
    unpaintTheme();

    document.removeEventListener('click', onDocumentClick, {capture: true});
    window.removeEventListener('contextmenu', onGlobalClose);
    window.removeEventListener('keydown', onKeyDown, {capture: true});
    window.removeEventListener('resize', onGlobalClose);

    setTimeout(() => element.remove(), CLOSE_REMOVE_DELAY);
    options.onClose?.();
  };

  document.addEventListener('click', onDocumentClick, {capture: true});
  window.addEventListener('contextmenu', onGlobalClose);
  window.addEventListener('keydown', onKeyDown, {capture: true});
  window.addEventListener('resize', onGlobalClose);

  // Lifecycle state used by the menu and its trigger.
  element.dataset.cycPhase = 'open';
  options.triggerElement?.setAttribute('data-cyc-menu-open', '');
  scrollToEnd(element);

  currentMenu = {element, close};

  return {element, close};
}

export function openSheet(items: CycMenuItem[], options: CycMenuOptions = {}) {
  closeMenu();

  const p = currentPresentation();
  const bits = hasBits(options.className);
  const element = h(
    'div',
    'cyc-modal cyc-sheet fixed inset-0 z-[15] m-0 flex overflow-auto overscroll-contain p-0 items-end text-[1rem] bg-[rgba(0,0,0,0.3)] ' +
      MODAL_TEXT[p.theme] +
      (options.className ? ' ' + options.className : '')
  );
  const boxCls = [
    'cyc-modal-box',
    'cyc-elevation-low',
    'relative',
    'flex',
    'flex-col',
    'overflow-hidden',
    '[backface-visibility:hidden]',
    'm-0',
    'w-full',
    'max-w-none',
    'pt-2',
    'px-0',
    'pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]',
    BOX_BG[p.theme]
  ];
  if (bits) boxCls.push('overflow-y-auto!', 'max-h-[70vh]!', 'overscroll-contain');
  const container = h('div', boxCls.join(' '));
  const ctx: ItemCtx = {variant: 'sheet', bits, phone: p.width === 'phone', theme: p.theme};
  container.append(...items.map((it) => menuItem(it, ctx)));
  element.append(container);

  // Hidden + slid-down initial state. The `data-cyc-phase` attribute (`open` /
  // `closing`) is the behavioural lifecycle marker (tests, the oracle selector),
  // while the visual state is driven by explicit inline style here, not CSS.
  element.style.opacity = '0';
  element.style.visibility = 'hidden';
  element.style.transition = MODAL_HIDE;
  container.style.transform = 'translate3d(0, 100%, 0)';
  container.style.transition = BOX_TRANSITION;

  document.body.append(element);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const onGlobalClose = () => close();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    currentMenu = undefined;

    element.dataset.cycPhase = 'closing';
    element.style.opacity = '0';
    element.style.visibility = 'hidden';
    element.style.transition = MODAL_HIDE;
    container.style.transform = 'translate3d(0, 100%, 0)';
    options.triggerElement?.removeAttribute('data-cyc-menu-open');

    window.removeEventListener('keydown', onKeyDown, {capture: true});
    window.removeEventListener('resize', onGlobalClose);

    setTimeout(() => element.remove(), CLOSE_REMOVE_DELAY);
    options.onClose?.();
  };

  element.addEventListener('click', (e) => {
    if (container.contains(e.target as Node)) return;
    close();
  });

  window.addEventListener('keydown', onKeyDown, {capture: true});
  window.addEventListener('resize', onGlobalClose);

  void element.offsetWidth;
  element.dataset.cycPhase = 'open';
  element.style.opacity = '1';
  element.style.visibility = 'visible';
  element.style.transition = MODAL_SHOW;
  container.style.transform = 'translate3d(0, 0, 0)';
  options.triggerElement?.setAttribute('data-cyc-menu-open', '');
  scrollToEnd(container);

  currentMenu = {element, close};

  return {element, close};
}
