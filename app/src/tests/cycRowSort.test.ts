import {afterEach, describe, expect, test, vi} from 'vitest';
import RowSortable from '../features/sessions/controls/rowSort';

// jsdom layout is stubbed to exercise pointer-driven row reordering.

const ROW_HEIGHT = 20;

function pointer(type: string, clientY: number, clientX = 5) {
  const event = new Event(type, {bubbles: true, cancelable: true}) as PointerEvent;
  Object.assign(event, {button: 0, clientX, clientY, pointerId: 1});
  return event;
}

function mount(count: number) {
  const list = document.createElement('ul');
  document.body.append(list);
  const rows: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const row = document.createElement('li');
    row.dataset.sessionId = `s${i}`;
    row.getBoundingClientRect = () =>
      ({
        top: i * ROW_HEIGHT,
        bottom: (i + 1) * ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 100,
        width: 100
      }) as DOMRect;
    list.append(row);
    rows.push(row);
  }
  list.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: count * ROW_HEIGHT,
      height: count * ROW_HEIGHT,
      left: 0,
      right: 100,
      width: 100
    }) as DOMRect;
  // Model the browser hit-test faithfully: the lifted source row is painted on
  // top and translated to follow the pointer, so it is hit first at its
  // *translated* box -- UNLESS it has opted out with pointer-events:none, in
  // which case the point falls through to the row whose static box holds y.
  document.elementFromPoint = ((_x: number, y: number) => {
    const lifted = rows.find((r) => r.classList.contains('cyc-drag-active'));
    if (lifted && lifted.style.pointerEvents !== 'none') {
      const m = /translateY\((-?\d+(?:\.\d+)?)px\)/.exec(lifted.style.transform);
      const shift = m ? parseFloat(m[1]) : 0;
      const b = lifted.getBoundingClientRect();
      if (y >= b.top + shift && y < b.bottom + shift) return lifted;
    }
    return (
      rows.find((r) => {
        const b = r.getBoundingClientRect();
        return y >= b.top && y < b.bottom;
      }) ?? list
    );
  }) as typeof document.elementFromPoint;
  return {list, rows};
}

const order = (list: HTMLElement) =>
  Array.from(list.children)
    .filter((c) => !c.classList.contains('cyc-drop-marker'))
    .map((c) => (c as HTMLElement).dataset.sessionId);

afterEach(() => {
  document.body.replaceChildren();
});

describe('RowSortable drag reorder via elementFromPoint + insertion marker', () => {
  test('dragging a row past the last row commits the new order and calls onSort', async () => {
    const {list, rows} = mount(3);
    const onSort = vi.fn();
    const sortable = new RowSortable({list, onSort, dragClasses: 'is-lifted'});

    sortable.pickUp(rows[0], 5); // grab the first row near its top
    expect(sortable.dragging).toBe(true);
    expect(rows[0].classList.contains('cyc-drag-active')).toBe(true);
    expect(rows[0].classList.contains('is-lifted')).toBe(true);
    expect(list.classList.contains('cyc-stack-sorting')).toBe(true);
    expect(list.style.touchAction).toBe('none');

    window.dispatchEvent(pointer('pointermove', 55)); // lower half of the last row
    expect(sortable.travelled).toBe(true);
    expect(rows[0].style.transform).toMatch(/translateY/);
    expect(rows[0].style.pointerEvents).toBe('none'); // lifted row is out of hit-testing while dragging
    const marker = list.querySelector('.cyc-drop-marker')!;
    expect(marker).toBeTruthy();
    expect(marker.previousElementSibling).toBe(rows[2]); // parked after the last row

    window.dispatchEvent(pointer('pointerup', 55));
    await vi.waitFor(() => expect(sortable.dragging).toBe(false));

    expect(order(list)).toEqual(['s1', 's2', 's0']);
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(list.querySelector('.cyc-drop-marker')).toBeNull();
    expect(list.classList.contains('cyc-stack-sorting')).toBe(false);
    expect(list.style.touchAction).toBe('');
    expect(rows[0].classList.contains('cyc-drag-active')).toBe(false);
    expect(rows[0].style.transform).toBe('');
    expect(rows[0].style.pointerEvents).toBe(''); // hit-testing restored after release
  });

  test('releasing without moving leaves the order intact and skips onSort', async () => {
    const {list, rows} = mount(3);
    const onSort = vi.fn();
    const sortable = new RowSortable({list, onSort, dragClasses: 'is-lifted'});

    sortable.pickUp(rows[1], 25);
    window.dispatchEvent(pointer('pointerup', 25));
    await vi.waitFor(() => expect(sortable.dragging).toBe(false));

    expect(order(list)).toEqual(['s0', 's1', 's2']);
    expect(onSort).not.toHaveBeenCalled();
    expect(list.querySelector('.cyc-drop-marker')).toBeNull();
  });

  test('a touch drag captures the pointer and swallows touchmove so the list does not pan', async () => {
    const {list, rows} = mount(3);
    const captured: number[] = [];
    const released: number[] = [];
    list.setPointerCapture = ((id: number) => captured.push(id)) as typeof list.setPointerCapture;
    list.releasePointerCapture = ((id: number) =>
      released.push(id)) as typeof list.releasePointerCapture;
    const sortable = new RowSortable({list, onSort: vi.fn(), dragClasses: 'is-lifted'});

    sortable.pickUp(rows[0], 5, 7); // long-press lift carries the touch pointerId
    expect(captured).toEqual([7]); // captured so the scroll container cannot steal the gesture

    // touch-action is latched at pointerdown, so the drag must cancel the scroll
    // itself: a touchmove while dragging is prevented (no vertical pan).
    const tm = new Event('touchmove', {bubbles: true, cancelable: true});
    window.dispatchEvent(tm);
    expect(tm.defaultPrevented).toBe(true);

    window.dispatchEvent(pointer('pointerup', 5));
    await vi.waitFor(() => expect(sortable.dragging).toBe(false));
    expect(released).toEqual([7]);

    // Once released, a stray touchmove is left alone so scrolling stays smooth.
    const after = new Event('touchmove', {bubbles: true, cancelable: true});
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  test('dropping over the upper half of an earlier row inserts before it', async () => {
    const {list, rows} = mount(3);
    const onSort = vi.fn();
    const sortable = new RowSortable({list, onSort, dragClasses: 'is-lifted'});

    sortable.pickUp(rows[2], 55);
    window.dispatchEvent(pointer('pointermove', 22)); // upper half of the middle row
    const marker = list.querySelector('.cyc-drop-marker')!;
    expect(marker.nextElementSibling).toBe(rows[1]); // marker sits before the hovered row

    window.dispatchEvent(pointer('pointerup', 22));
    await vi.waitFor(() => expect(sortable.dragging).toBe(false));

    expect(order(list)).toEqual(['s0', 's2', 's1']);
    expect(onSort).toHaveBeenCalledTimes(1);
  });
});
