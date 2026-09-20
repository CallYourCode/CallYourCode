import {h} from '@/components/domHelpers';
import {viewStorage} from '@/features/code/viewer';

export const PHONE_MAX = 700;
export const LAPTOP_MIN = 1100;
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;

export const BAR_H = 28;

export const RAIL_PHONE = BAR_H;
export const RAIL_WIDE = 1;

const SWIPE_COMMIT = 0.28;
export const SWIPE_FLICK = 0.5;
// A flick only counts once the finger has really travelled: without this floor a
// sub-10px twitch released quickly (v > SWIPE_FLICK) flipped the pane.
export const SWIPE_FLICK_MIN_PX = 30;
// Axis lock: travel must pass ARM_PX, and the horizontal lead must beat the
// vertical by ARM_RATIO before the track follows the finger; anything less is a
// scroll (or a tap) and never moves the pane.
const SWIPE_ARM_PX = 8;
const SWIPE_ARM_RATIO = 1.25;

export const TAP_SLOP = 10;

export function clampSplit(v: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v));
}

export function readSplit(key: string, laptop: boolean): number | null {
  try {
    const raw = JSON.parse(viewStorage().get(key) || '{}');
    const v = raw?.[laptop ? 'laptop' : 'tablet'];
    return typeof v === 'number' && v >= SPLIT_MIN && v <= SPLIT_MAX ? v : null;
  } catch {
    return null;
  }
}

export function writeSplit(key: string, laptop: boolean, v: number) {
  try {
    const raw = JSON.parse(viewStorage().get(key) || '{}');
    viewStorage().set(key, JSON.stringify({...raw, [laptop ? 'laptop' : 'tablet']: v}));
  } catch {}
}

type SplitPaneOptions = {
  storageKey: string;

  splitTablet: number;

  splitLaptop: number;

  railLabelA: string;

  railLabelB: string;

  ignoreSwipeWithin?: string;

  onLayout?: () => void;
};

export type SplitPane = {
  track: HTMLDivElement;
  paneA: HTMLDivElement;
  paneB: HTMLDivElement;
  rail: HTMLDivElement;
  railA: HTMLButtonElement;
  railB: HTMLButtonElement;
  applyLayout: () => void;
  showSide: (next: 'a' | 'b', animate?: boolean) => void;

  isWide: () => boolean;

  restoreSplit: () => void;

  destroy: () => void;
};

export function createSplitPane(overlay: HTMLElement, opts: SplitPaneOptions): SplitPane {
  const track = h('div', 'cyc-fx-track');

  const paneA = h('div', 'cyc-fx-pane cyc-fx-a');
  const paneB = h('div', 'cyc-fx-pane cyc-fx-b');
  const rail = h('div', 'cyc-fx-rail');
  const railA = h('button', 'cyc-fx-rail-half cyc-fx-rail-a');
  const railB = h('button', 'cyc-fx-rail-half cyc-fx-rail-b');

  const railGrip = h('div', 'cyc-fx-rail-grip');
  rail.append(railA, railB, railGrip);
  track.append(paneA, rail, paneB);
  overlay.append(track);

  let side: 'a' | 'b' = 'a';
  let split = opts.splitTablet;
  let wide = false;
  let panelW = 0;
  let railW = RAIL_PHONE;

  const applyLayout = () => {
    const w = overlay.clientWidth || 0;
    if (!w) return;
    wide = w >= PHONE_MAX;
    railW = wide ? RAIL_WIDE : RAIL_PHONE;
    overlay.classList.toggle('cyc-fx-wide', wide);
    overlay.classList.toggle('cyc-fx-phone', !wide);
    if (wide) {
      const aW = Math.round((w - railW) * split);
      paneA.style.width = `${aW}px`;
      paneB.style.width = `${w - railW - aW}px`;
      track.style.width = `${w}px`;
      track.style.transform = 'translateX(0)';
      panelW = aW;
    } else {
      panelW = w - railW;
      paneA.style.width = `${panelW}px`;
      paneB.style.width = `${panelW}px`;
      track.style.width = `${panelW * 2 + railW}px`;
      slide(side === 'a' ? 0 : -panelW, false);
    }
    rail.style.width = `${railW}px`;
    opts.onLayout?.();
  };

  const slide = (x: number, animate: boolean) => {
    track.style.transition = animate ? 'transform .22s cubic-bezier(.25,.1,.25,1)' : 'none';
    track.style.transform = `translateX(${x}px)`;
  };

  const showSide = (next: 'a' | 'b', animate = true) => {
    side = next;
    overlay.classList.toggle('cyc-fx-on-b', next === 'b');
    railA.classList.toggle('cyc-fx-rail-on', next === 'a');
    railB.classList.toggle('cyc-fx-rail-on', next === 'b');
    if (!wide) slide(next === 'a' ? 0 : -panelW, animate);
  };

  const railLabel = (host: HTMLElement, glyph: string, text: string) => {
    const chev = h('span', 'cyc-fx-rail-chev');
    chev.textContent = glyph;
    const label = h('span', 'cyc-fx-rail-label');
    label.textContent = text;
    host.append(chev, label);
  };
  railLabel(railA, '‹', opts.railLabelA);
  railLabel(railB, '›', opts.railLabelB);
  railA.addEventListener('click', () => {
    if (!wide) showSide('a');
  });
  railB.addEventListener('click', () => {
    if (!wide) showSide('b');
  });

  let g: {
    x: number;
    y: number;
    t: number;
    from: number;
    axis: '' | 'x' | 'y';
    sc: HTMLElement | null;
    left: number;
    max: number;
  } | null = null;
  track.addEventListener(
    'touchstart',
    (e) => {
      if (wide || e.touches.length !== 1) return;

      if (opts.ignoreSwipeWithin && (e.target as HTMLElement)?.closest?.(opts.ignoreSwipeWithin))
        return;
      const t = e.touches[0];

      const sc = (e.target as HTMLElement)?.closest?.('.cyc-fx-scroll') as HTMLElement | null;
      const max = sc ? Math.max(0, sc.scrollWidth - sc.clientWidth) : 0;
      g = {
        x: t.clientX,
        y: t.clientY,
        t: Date.now(),
        from: side === 'a' ? 0 : -panelW,
        axis: '',
        sc: max ? sc : null,
        left: sc?.scrollLeft ?? 0,
        max
      };
    },
    {passive: true}
  );

  track.addEventListener(
    'touchmove',
    (e) => {
      if (!g || wide || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      if (!g.axis) {
        if (Math.abs(dx) < SWIPE_ARM_PX && Math.abs(dy) < SWIPE_ARM_PX) return;
        g.axis = Math.abs(dx) >= Math.abs(dy) * SWIPE_ARM_RATIO ? 'x' : 'y';
      }
      if (g.axis !== 'x') return;
      e.preventDefault();

      let over = dx;
      if (g.sc) {
        const want = g.left - dx;
        const at = Math.min(g.max, Math.max(0, want));
        g.sc.scrollLeft = at;
        over = at - want;
      }

      let x = g.from + over;
      if (x > 0) x *= 0.35;
      if (x < -panelW) x = -panelW + (x + panelW) * 0.35;
      slide(x, false);
    },
    {passive: false}
  );

  const endSwipe = () => {
    if (!g || wide) {
      g = null;
      return;
    }
    const held = g.axis === 'x';
    const from = g.from;
    const dt = Math.max(1, Date.now() - g.t);
    const now = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
    const dx = now - from;
    g = null;
    if (!held) return;
    const v = Math.abs(dx) / dt;
    const commit =
      Math.abs(dx) > panelW * SWIPE_COMMIT ||
      (v > SWIPE_FLICK && Math.abs(dx) > SWIPE_FLICK_MIN_PX);
    if (!commit) {
      showSide(side);
      return;
    }
    showSide(dx < 0 ? 'b' : 'a');
  };
  track.addEventListener('touchend', endSwipe, {passive: true});
  track.addEventListener('touchcancel', endSwipe, {passive: true});

  rail.addEventListener('pointerdown', (e) => {
    if (!wide) return;
    e.preventDefault();
    rail.setPointerCapture(e.pointerId);
    overlay.classList.add('cyc-fx-dragging');
  });
  rail.addEventListener('pointermove', (e) => {
    if (!wide || !rail.hasPointerCapture(e.pointerId)) return;
    const box = overlay.getBoundingClientRect();
    const frac = (e.clientX - box.left) / Math.max(1, box.width);
    split = clampSplit(frac);
    applyLayout();
  });
  const endDrag = (e: PointerEvent) => {
    if (!rail.hasPointerCapture?.(e.pointerId)) return;
    rail.releasePointerCapture(e.pointerId);
    overlay.classList.remove('cyc-fx-dragging');
    opts.onLayout?.();

    writeSplit(opts.storageKey, overlay.clientWidth >= LAPTOP_MIN, split);
  };
  rail.addEventListener('pointerup', endDrag);
  rail.addEventListener('pointercancel', endDrag);

  const ro = new ResizeObserver(() => applyLayout());
  ro.observe(overlay);

  const restoreSplit = () => {
    applyLayout();
    const isLaptop = overlay.clientWidth >= LAPTOP_MIN;
    split =
      readSplit(opts.storageKey, isLaptop) ?? (isLaptop ? opts.splitLaptop : opts.splitTablet);
    applyLayout();
    showSide('a', false);
  };

  return {
    track,
    paneA,
    paneB,
    rail,
    railA,
    railB,
    applyLayout,
    showSide,
    isWide: () => wide,
    restoreSplit,
    destroy: () => ro.disconnect()
  };
}
