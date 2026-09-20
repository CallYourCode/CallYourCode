// Reorder arming: the horizontal travel must pass ARM_PX and clearly lead the
// vertical (by ARM_RATIO) before a tab lifts; a mostly-vertical drag abandons the
// press so it stays a scroll and never flinches the strip.
const ARM_PX = 8;
const ARM_RATIO = 1.25;

function makeSeam(): HTMLElement {
  const seam = document.createElement('div');
  seam.className =
    'cyc-drop-marker pointer-events-none w-0.5 self-stretch rounded-full bg-[var(--cyc-accent)]';
  return seam;
}

/** Reorders a tab strip by tracking a pointer on the strip itself. Unlike a native
 * draggable, it does not create a browser drag image or transfer payload. */
export default class HorizontalSortable {
  private tab: HTMLElement | undefined;
  private seam: HTMLElement | undefined;
  private pointerId: number | undefined;
  private downX = 0;
  private downY = 0;
  private active = false;

  constructor(
    private readonly options: {
      list: HTMLElement;
      onSort: (previousIndex: number, nextIndex: number) => void;
      dragClasses: string;
    }
  ) {
    options.list.addEventListener('pointerdown', this.down);
  }

  private down = (event: PointerEvent) => {
    if (event.button !== 0 || this.tab) return;
    const target = event.target as Node | null;
    const tab =
      target &&
      (Array.from(this.options.list.children).find((child) => child.contains(target)) as
        HTMLElement | undefined);
    if (!tab) return;
    this.tab = tab;
    this.pointerId = event.pointerId;
    this.downX = event.clientX;
    this.downY = event.clientY;
    this.options.list.addEventListener('pointermove', this.move);
    this.options.list.addEventListener('pointerup', this.up);
    this.options.list.addEventListener('pointercancel', this.up);
  };

  private start(): void {
    const tab = this.tab!;
    this.active = true;
    this.seam = makeSeam();
    this.options.list.classList.add('cyc-reordering');
    // inline lift chrome, for the same cascade reasons as rowSort
    tab.style.setProperty('background', 'var(--cyc-surface)', 'important');
    tab.style.setProperty('box-shadow', '0 2px 8px rgba(0, 0, 0, 0.2)', 'important');
    tab.style.setProperty('z-index', '2', 'important');
    tab.classList.add(
      'cyc-drag-active',
      'cyc-motion-suppressed',
      ...this.options.dragClasses.split(' ')
    );
  }

  private move = (event: PointerEvent) => {
    if (!this.tab || event.pointerId !== this.pointerId) return;
    const offset = event.clientX - this.downX;
    if (!this.active) {
      const travelX = Math.abs(offset);
      const travelY = Math.abs(event.clientY - this.downY);
      if (travelY >= ARM_PX && travelY > travelX) {
        this.up(event);
        return;
      }
      if (travelX < ARM_PX || travelX < travelY * ARM_RATIO) return;
      this.start();
      try {
        this.options.list.setPointerCapture(event.pointerId);
      } catch {}
    }
    event.preventDefault();
    this.tab.style.transform = `translateX(${offset}px)`;
    const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const over =
      hit &&
      (Array.from(this.options.list.children).find(
        (child) => child !== this.seam && child.contains(hit)
      ) as HTMLElement | undefined);
    if (!over || over === this.tab) {
      if (!this.seam!.parentElement) this.tab.after(this.seam!);
      return;
    }
    const bounds = over.getBoundingClientRect();
    if (event.clientX < bounds.left + bounds.width / 2) over.before(this.seam!);
    else over.after(this.seam!);
  };

  private up = (event?: PointerEvent) => {
    if (event && event.pointerId !== this.pointerId) return;
    this.options.list.removeEventListener('pointermove', this.move);
    this.options.list.removeEventListener('pointerup', this.up);
    this.options.list.removeEventListener('pointercancel', this.up);
    const tab = this.tab;
    const seam = this.seam;
    if (!tab) return;
    let prior = -1;
    let next = -1;
    if (this.active && seam?.parentElement === this.options.list) {
      prior = Array.from(this.options.list.children)
        .filter((child) => child !== seam)
        .indexOf(tab);
      next = Array.from(this.options.list.children)
        .filter((child) => child !== tab)
        .indexOf(seam);
      if (prior !== next) this.options.list.insertBefore(tab, seam);
    }
    seam?.remove();
    tab.style.transform = '';
    tab.style.removeProperty('background');
    tab.style.removeProperty('box-shadow');
    tab.style.removeProperty('z-index');
    tab.classList.remove(
      'cyc-drag-active',
      'cyc-motion-suppressed',
      ...this.options.dragClasses.split(' ')
    );
    this.options.list.classList.remove('cyc-reordering');
    this.tab = undefined;
    this.seam = undefined;
    this.pointerId = undefined;
    this.active = false;
    if (prior >= 0 && prior !== next) this.options.onSort(prior, next);
  };
}
