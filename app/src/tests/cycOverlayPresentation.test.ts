import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {openMenu, openSheet, type CycMenuItem} from '../components/popupMenu';
import {confirmPopup} from '../components/widgets';
import {installPresentationReactivity, setPresentationTheme} from '../components/presentation';

const ORIGINAL_WIDTH = window.innerWidth;
const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});

let teardown: (() => void) | undefined;
const sync = () => {
  teardown?.();
  teardown = installPresentationReactivity();
};

const ITEMS: CycMenuItem[] = [
  {icon: 'image', text: 'Photo or Video', onClick: () => {}},
  {icon: 'document', text: 'File', onClick: () => {}}
];

const cls = (el: Element | null | undefined) => el?.className ?? '';
const firstItem = (root: HTMLElement) => root.querySelector<HTMLElement>('.cyc-menu-item')!;
const itemIcon = (root: HTMLElement) => root.querySelector<HTMLElement>('.cyc-menu-item-icon')!;

const evt = () => new MouseEvent('click', {clientX: 40, clientY: 40, bubbles: true});

beforeEach(() => {
  document.documentElement.dir = '';
  document.body.innerHTML = '';
  setWidth(1024);
  setPresentationTheme('day');
  sync();
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
  setWidth(ORIGINAL_WIDTH);
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('context menu geometry and item spacing are literal TS classes', () => {
  test('laptop context menu paints the min-width, capped height and 1.5rem inset', () => {
    const {element, close} = openMenu(ITEMS, evt());
    expect(cls(element)).toContain('cyc-menu-context');
    expect(cls(element)).toContain('min-w-[13.5rem]!');
    expect(cls(element)).toContain('max-h-[70dvh]');
    expect(cls(element)).toContain('overflow-y-auto');
    expect(cls(element)).toContain('overscroll-contain');

    const item = firstItem(element);
    expect(cls(item)).toContain('min-h-10');
    expect(cls(item)).toContain('px-3');
    expect(cls(item)).toContain('text-sm');
    expect(cls(item)).toContain('font-semibold');
    expect(cls(item)).toContain('transition-colors');
    expect(cls(item)).toContain('active:opacity-75');
    expect(cls(item)).not.toContain('[pointer-events:all]!');

    const ic = itemIcon(element);
    expect(cls(ic)).toContain('size-6');
    expect(cls(ic)).not.toContain('w-6!');
    close();
  });

  test('phone context menu widens the trailing inset to 1.875rem', () => {
    setWidth(390);
    sync();
    const {element, close} = openMenu(ITEMS, evt());
    const item = firstItem(element);
    expect(cls(item)).toContain('min-h-10');
    expect(cls(item)).toContain('px-3');
    expect(cls(item)).not.toContain('pe-[1.5rem]!');
    close();
  });

  test('a bits context menu raises the height cap and switches to the bits box', () => {
    const {element, close} = openMenu([{text: 'Insert', onClick: () => {}}], evt(), {
      className: 'cyc-plugin-widget cyc-bits'
    });
    expect(cls(element)).toContain('max-h-[calc(100vh-1rem)]');
    expect(cls(element)).toContain('min-w-[13.5rem]!');
    const item = firstItem(element);
    expect(cls(item)).toContain('min-h-9');
    expect(cls(item)).toContain('items-start');
    expect(cls(item)).toContain('max-w-[min(42rem,calc(100vw-1.5rem))]');
    expect(cls(item)).not.toContain('h-[3.5rem]!');
    close();
  });
});

describe('bottom sheet chrome, theme and fade lifecycle', () => {
  test('day sheet paints the backdrop, box surface and item/icon literals', () => {
    const {element, close} = openSheet(ITEMS);
    expect(cls(element)).toContain('cyc-sheet');
    expect(cls(element)).toContain('fixed');
    expect(cls(element)).toContain('items-end');
    expect(cls(element)).toContain('bg-[rgba(0,0,0,0.3)]');
    expect(cls(element)).toContain('text-[#1c1c1e]');

    const box = element.querySelector<HTMLElement>('.cyc-modal-box')!;
    expect(cls(box)).toContain('w-full');
    expect(cls(box)).toContain('max-w-none');
    expect(cls(box)).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]');
    expect(cls(box)).toContain('bg-[#ece9e3]');

    const item = firstItem(element);
    expect(cls(item)).toContain('min-h-13');
    expect(cls(item)).toContain('px-4');
    expect(cls(item)).toContain('font-normal');
    expect(cls(item)).toContain('text-[15px]');
    expect(cls(item)).toContain('leading-5');
    expect(cls(item)).not.toContain('[transform:none]!');
    expect(cls(item)).not.toContain('active:[transform:scale(0.97)]');

    const ic = itemIcon(element);
    expect(cls(ic)).toContain('size-6');
    expect(cls(ic)).toContain('text-[#6b6b70]!');

    // Open menus are visible at their resting scale.
    expect(element.style.opacity).toBe('1');
    expect(element.style.visibility).toBe('visible');
    expect(box.style.transform).toBe('translate3d(0, 0, 0)');
    expect(element.getAttribute('data-cyc-phase')).toBe('open');
    expect(element.classList.contains('active')).toBe(false);
    close();
  });

  test('night sheet swaps to the dark surface and secondary icon tint', () => {
    setPresentationTheme('night');
    const {element, close} = openSheet(ITEMS);
    expect(cls(element)).toContain('text-[#ededee]');
    expect(cls(element.querySelector('.cyc-modal-box'))).toContain('bg-[#0d0d0e]');
    expect(cls(itemIcon(element))).toContain('text-[#a0a0a6]!');
    expect(cls(itemIcon(element))).not.toContain('text-[#6b6b70]!');
    close();
  });

  test('a bits sheet box scrolls within a 70vh cap', () => {
    const {element, close} = openSheet([{text: 'Insert', onClick: () => {}}], {
      className: 'cyc-bits'
    });
    const box = element.querySelector<HTMLElement>('.cyc-modal-box')!;
    expect(cls(box)).toContain('max-h-[70vh]!');
    expect(cls(box)).toContain('overflow-y-auto!');
    close();
  });

  test('closing flips the inline state back to hidden and slid-down', () => {
    const {element, close} = openSheet(ITEMS);
    const box = element.querySelector<HTMLElement>('.cyc-modal-box')!;
    close();
    expect(element.style.opacity).toBe('0');
    expect(element.style.visibility).toBe('hidden');
    expect(box.style.transform).toBe('translate3d(0, 100%, 0)');
    expect(element.getAttribute('data-cyc-phase')).toBe('closing');
    expect(element.classList.contains('hiding')).toBe(false);
  });
});

describe('confirm/dialog modal literals, buttons and lifecycle', () => {
  test('single-button dialog paints the min-content box and horizontal buttons', () => {
    const el = confirmPopup({title: 'Hi', description: 'There'});
    expect(cls(el)).toContain('cyc-modal-dialog');
    expect(cls(el)).toContain('fixed');
    expect(cls(el)).toContain('p-[1.75rem]');
    expect(cls(el)).toContain('text-[#1c1c1e]');

    const box = el.querySelector<HTMLElement>('.cyc-modal-box')!;
    expect(cls(box)).toContain('w-[min-content]');
    expect(cls(box)).toContain('min-w-[min(100%,20rem)]');
    expect(cls(box)).toContain('max-w-[min(100%,24rem)]');
    expect(cls(box)).toContain('bg-[#ece9e3]');

    const btns = el.querySelector<HTMLElement>('.cyc-modal-btns')!;
    expect(cls(btns)).toContain('flex-row-reverse');
    expect(cls(btns)).toContain('items-center');
    expect(cls(btns)).toContain('h-12');
    expect(cls(btns.querySelector('.cyc-sheet-btn'))).toContain('px-4!');

    // Shown dialogs use their resting scale.
    expect(el.style.opacity).toBe('1');
    expect(box.style.opacity).toBe('1');
    expect(box.style.transform).toBe('scale(1)');
    el.remove();
  });

  test('three buttons stack vertically with no sibling gap', () => {
    const el = confirmPopup({
      title: 'Pick',
      buttons: [{text: 'A'}, {text: 'B'}, {text: 'C'}]
    });
    const btns = el.querySelector<HTMLElement>('.cyc-modal-btns')!;
    expect(cls(btns)).toContain('flex-col');
    expect(cls(btns)).toContain('items-stretch');
    expect(cls(btns)).toContain('h-auto');
    for (const b of btns.querySelectorAll('.cyc-sheet-btn')) {
      expect(cls(b)).not.toContain('me-[0.625rem]');
      expect(cls(b)).toContain('px-4!');
    }
    el.remove();
  });

  test('two horizontal buttons give the trailing one the 0.625rem gap', () => {
    const el = confirmPopup({title: 'Ok?', buttons: [{text: 'Cancel'}, {text: 'OK'}]});
    const list = el.querySelectorAll('.cyc-sheet-btn');
    expect(cls(list[0])).not.toContain('me-[0.625rem]');
    expect(cls(list[1])).toContain('me-[0.625rem]');
    el.remove();
  });

  test('night dialog paints the dark surface', () => {
    setPresentationTheme('night');
    const el = confirmPopup({title: 'Hi'});
    expect(cls(el)).toContain('text-[#ededee]');
    expect(cls(el.querySelector('.cyc-modal-box'))).toContain('bg-[#0d0d0e]');
    el.remove();
  });
});
