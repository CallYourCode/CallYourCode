const MARKER_CLASS = 'cyc-drop-marker';

function insertionMark(): HTMLElement {
  const mark = document.createElement('div');
  mark.className = `${MARKER_CLASS} pointer-events-none h-0.5 rounded-full bg-[var(--cyc-accent)]`;
  return mark;
}

/** Pointer-driven list ordering. The source row stays in its slot until release; the
 * insertion rule is represented by a small seam marker rather than by moving siblings. */
export default class RowSortable {
  private source: HTMLElement | undefined;
  private seam: HTMLElement | undefined;
  private pointer: number | undefined;
  private startY = 0;
  private changed = false;

  constructor(private readonly options: {list: HTMLElement; onSort: () => void; dragClasses: string}) {}

  get dragging(): boolean {
    return !!this.source;
  }

  get travelled(): boolean {
    return this.changed;
  }

  pickUp(row: HTMLElement, clientY: number, pointerId?: number): void {
    if (this.source || !this.options.list.contains(row)) return;
    this.source = row;
    this.startY = clientY;
    this.changed = false;
    this.seam = insertionMark();
    this.options.list.classList.add('cyc-stack-sorting');
    this.options.list.style.touchAction = 'none';
    // Capture the pointer on the list so a touch drag is not handed back to the
    // scroll container as a vertical pan mid-gesture: without this the browser
    // fires pointercancel on the first move and the drag dies (tabSort captures
    // for the same reason).
    if (pointerId !== undefined) {
      this.pointer = pointerId;
      try {
        this.options.list.setPointerCapture(pointerId);
      } catch {}
    }
    // The lifted row follows the pointer and would otherwise sit under it, so
    // elementFromPoint would only ever return the source and never a drop
    // target; take it out of hit-testing so the row beneath is found.
    row.style.pointerEvents = 'none';
    /* The lift chrome is INLINE, not utilities: the drag bg utility lost the
     * cascade to the row's own :active grey, and the arbitrary shadow class
     * never compiled at all, so the lifted row sat flat and read as
     * transparent on non-stock themes (2026-09-06 report, measured live). */
    row.style.setProperty('background', 'var(--cyc-surface)', 'important');
    row.style.setProperty('box-shadow', '0 2px 8px rgba(0, 0, 0, 0.2)', 'important');
    row.style.setProperty('z-index', '2', 'important');
    row.classList.add('cyc-drag-active', 'cyc-motion-suppressed', ...this.options.dragClasses.split(' '));
    window.addEventListener('pointermove', this.move, {passive: false});
    window.addEventListener('pointerup', this.release);
    window.addEventListener('pointercancel', this.release);
    // Swallow touchmoves while dragging: touch-action is latched at pointerdown,
    // so once a drag begins the scroll container would otherwise pan and the
    // browser would fire pointercancel, killing the drag. Preventing the default
    // here (non-passive) keeps the finger driving the row, not the scroll. Drag
    // only ever starts after a still long-press, so ordinary scrolling is intact.
    window.addEventListener('touchmove', this.blockTouch, {passive: false});
  }

  putDown(): void {
    this.release();
  }

  private blockTouch = (event: TouchEvent) => {
    if (this.source) event.preventDefault();
  };

  private move = (event: PointerEvent) => {
    const source = this.source;
    if (!source) return;
    event.preventDefault();
    const delta = event.clientY - this.startY;
    if (Math.abs(delta) < 2) return;
    this.changed = true;
    source.style.transform = `translateY(${delta}px)`;
    const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const target = hit && Array.from(this.options.list.children).find((child) => child !== source && child !== this.seam && child.contains(hit)) as HTMLElement | undefined;
    if (!target) return;
    const box = target.getBoundingClientRect();
    if (event.clientY < box.top + box.height / 2) target.before(this.seam!);
    else target.after(this.seam!);
  };

  private release = () => {
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.release);
    window.removeEventListener('pointercancel', this.release);
    window.removeEventListener('touchmove', this.blockTouch);
    const source = this.source;
    const seam = this.seam;
    if (!source) return;
    let changedOrder = false;
    if (this.changed && seam?.parentElement === this.options.list) {
      const before = Array.from(this.options.list.children).filter((child) => child !== seam).indexOf(source);
      const after = Array.from(this.options.list.children).filter((child) => child !== source).indexOf(seam);
      changedOrder = before !== after;
      if (changedOrder) this.options.list.insertBefore(source, seam);
    }
    seam?.remove();
    source.style.transform = '';
    source.style.pointerEvents = '';
    source.style.removeProperty('background');
    source.style.removeProperty('box-shadow');
    source.style.removeProperty('z-index');
    source.classList.remove('cyc-drag-active', 'cyc-motion-suppressed', ...this.options.dragClasses.split(' '));
    this.options.list.classList.remove('cyc-stack-sorting');
    this.options.list.style.touchAction = '';
    if (this.pointer !== undefined) {
      try {
        this.options.list.releasePointerCapture(this.pointer);
      } catch {}
    }
    this.source = undefined;
    this.seam = undefined;
    this.pointer = undefined;
    if (changedOrder) this.options.onSort();
  };
}
