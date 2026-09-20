import {afterEach, describe, expect, test, vi} from 'vitest';
import HorizontalSortable from '../features/sessions/controls/tabSort';

vi.mock('../shared/logging', () => ({cyclog: vi.fn()}));

// jsdom layout and hit testing are stubbed for pointer-driven tab reordering.

const TAB_WIDTH = 50;

function pointer(type: string, clientX: number, clientY = 5) {
  const event = new Event(type, {bubbles: true, cancelable: true}) as PointerEvent;
  Object.assign(event, {button: 0, clientX, clientY, pointerId: 1});
  return event;
}

function mount(count: number) {
  const list = document.createElement('nav');
  document.body.append(list);
  const tabs: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const tab = document.createElement('button');
    tab.className = 'cyc-seg';
    tab.dataset.tabId = `t${i}`;
    tab.getBoundingClientRect = () =>
      ({
        left: i * TAB_WIDTH,
        right: (i + 1) * TAB_WIDTH,
        width: TAB_WIDTH,
        top: 0,
        bottom: 20,
        height: 20
      }) as DOMRect;
    list.append(tab);
    tabs.push(tab);
  }
  list.getBoundingClientRect = () =>
    ({
      left: 0,
      right: count * TAB_WIDTH,
      width: count * TAB_WIDTH,
      top: 0,
      bottom: 20,
      height: 20
    }) as DOMRect;
  // Simulate elementFromPoint against the stubbed tab bounds.
  document.elementFromPoint = ((x: number) =>
    tabs.find((t) => {
      if (t.style.pointerEvents === 'none') return false;
      const b = t.getBoundingClientRect();
      return x >= b.left && x < b.right;
    }) ?? list) as typeof document.elementFromPoint;
  return {list, tabs};
}

const order = (list: HTMLElement) =>
  Array.from(list.children)
    .filter((c) => !c.classList.contains('cyc-drop-marker'))
    .map((c) => (c as HTMLElement).dataset.tabId);

afterEach(() => {
  document.body.replaceChildren();
});

describe('HorizontalSortable drag reorder via elementFromPoint + insertion marker', () => {
  test('dragging the first tab past the last commits the new order and calls onSort', async () => {
    const {list, tabs} = mount(3);
    const onSort = vi.fn();
    new HorizontalSortable({list, onSort, dragClasses: 'is-lifted'});

    tabs[0].dispatchEvent(pointer('pointerdown', 25)); // grab the first tab at its centre
    list.dispatchEvent(pointer('pointermove', 130)); // right half of the last tab

    expect(tabs[0].classList.contains('cyc-drag-active')).toBe(true);
    expect(tabs[0].classList.contains('is-lifted')).toBe(true);
    expect(list.classList.contains('cyc-reordering')).toBe(true);
    expect(tabs[0].style.transform).toMatch(/translateX/);
    const marker = list.querySelector('.cyc-drop-marker')!;
    expect(marker).toBeTruthy();
    expect(marker.previousElementSibling).toBe(tabs[2]); // dropped after the last tab

    list.dispatchEvent(pointer('pointerup', 130));
    await vi.waitFor(() => expect(list.querySelector('.cyc-drop-marker')).toBeNull());

    expect(order(list)).toEqual(['t1', 't2', 't0']);
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(onSort).toHaveBeenCalledWith(0, 2);
    expect(list.classList.contains('cyc-reordering')).toBe(false);
    expect(tabs[0].classList.contains('cyc-drag-active')).toBe(false);
    expect(tabs[0].style.transform).toBe('');
  });

  test('releasing without crossing the threshold leaves the order intact and skips onSort', async () => {
    const {list, tabs} = mount(3);
    const onSort = vi.fn();
    new HorizontalSortable({list, onSort, dragClasses: 'is-lifted'});

    tabs[1].dispatchEvent(pointer('pointerdown', 75));
    list.dispatchEvent(pointer('pointerup', 75));

    expect(order(list)).toEqual(['t0', 't1', 't2']);
    expect(onSort).not.toHaveBeenCalled();
    expect(list.querySelector('.cyc-drop-marker')).toBeNull();
    expect(tabs[1].classList.contains('cyc-drag-active')).toBe(false);
  });

  test('a drag that parks the marker at the lifted tab own seam commits nothing', async () => {
    const {list, tabs} = mount(3);
    const onSort = vi.fn();
    new HorizontalSortable({list, onSort, dragClasses: 'is-lifted'});

    tabs[1].dispatchEvent(pointer('pointerdown', 75)); // grab the middle tab
    list.dispatchEvent(pointer('pointermove', 84)); // nudge past threshold, still over itself
    const marker = list.querySelector('.cyc-drop-marker')!;
    expect(marker.previousElementSibling).toBe(tabs[1]); // parked at its own seam

    list.dispatchEvent(pointer('pointerup', 84));
    await vi.waitFor(() => expect(list.classList.contains('cyc-reordering')).toBe(false));

    expect(order(list)).toEqual(['t0', 't1', 't2']);
    expect(onSort).not.toHaveBeenCalled();
    expect(list.querySelector('.cyc-drop-marker')).toBeNull();
  });

  test('a 5px horizontal wobble never lifts the tab', () => {
    const {list, tabs} = mount(3);
    const onSort = vi.fn();
    new HorizontalSortable({list, onSort, dragClasses: 'is-lifted'});

    tabs[1].dispatchEvent(pointer('pointerdown', 75));
    list.dispatchEvent(pointer('pointermove', 80));

    expect(tabs[1].classList.contains('cyc-drag-active')).toBe(false);
    expect(tabs[1].style.transform).toBe('');
    list.dispatchEvent(pointer('pointerup', 80));
    expect(onSort).not.toHaveBeenCalled();
  });

  test('a mostly-vertical drag abandons the press: a scroll never lifts a tab', () => {
    const {list, tabs} = mount(3);
    const onSort = vi.fn();
    new HorizontalSortable({list, onSort, dragClasses: 'is-lifted'});

    tabs[1].dispatchEvent(pointer('pointerdown', 75, 5));
    list.dispatchEvent(pointer('pointermove', 83, 25)); // dx 8, dy 20: vertical leads

    expect(tabs[1].classList.contains('cyc-drag-active')).toBe(false);
    // The press is dead: a later horizontal pull in the same gesture cannot lift.
    list.dispatchEvent(pointer('pointermove', 130, 25));
    expect(tabs[1].classList.contains('cyc-drag-active')).toBe(false);
    expect(order(list)).toEqual(['t0', 't1', 't2']);
    expect(onSort).not.toHaveBeenCalled();
  });

  test('an ambiguous diagonal waits; a clear horizontal pull then lifts and reorders', async () => {
    const {list, tabs} = mount(3);
    const onSort = vi.fn();
    new HorizontalSortable({list, onSort, dragClasses: 'is-lifted'});

    tabs[0].dispatchEvent(pointer('pointerdown', 25, 5));
    list.dispatchEvent(pointer('pointermove', 34, 13)); // dx 9, dy 8: under the ratio
    expect(tabs[0].classList.contains('cyc-drag-active')).toBe(false);

    list.dispatchEvent(pointer('pointermove', 130, 13)); // now clearly horizontal
    expect(tabs[0].classList.contains('cyc-drag-active')).toBe(true);

    list.dispatchEvent(pointer('pointerup', 130, 13));
    await vi.waitFor(() => expect(list.querySelector('.cyc-drop-marker')).toBeNull());
    expect(order(list)).toEqual(['t1', 't2', 't0']);
    expect(onSort).toHaveBeenCalledWith(0, 2);
  });

  test('dropping over the left half of an earlier tab inserts before it', async () => {
    const {list, tabs} = mount(3);
    const onSort = vi.fn();
    new HorizontalSortable({list, onSort, dragClasses: 'is-lifted'});

    tabs[2].dispatchEvent(pointer('pointerdown', 125)); // grab the last tab
    list.dispatchEvent(pointer('pointermove', 20)); // left half of the first tab
    const marker = list.querySelector('.cyc-drop-marker')!;
    expect(marker.nextElementSibling).toBe(tabs[0]); // marker sits before the hovered tab

    list.dispatchEvent(pointer('pointerup', 20));
    await vi.waitFor(() => expect(list.querySelector('.cyc-drop-marker')).toBeNull());

    expect(order(list)).toEqual(['t2', 't0', 't1']);
    expect(onSort).toHaveBeenCalledWith(2, 0);
  });
});
