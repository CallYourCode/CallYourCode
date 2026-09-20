// Theme / width / pointer snapshot. Painters prune themselves when detached.

export type PresentationTheme = 'day' | 'night';
export type PresentationWidth = 'phone' | 'tablet' | 'laptop';
export type PresentationPointer = 'coarse' | 'fine';

export type Presentation = {
  theme: PresentationTheme;
  width: PresentationWidth;
  pointer: PresentationPointer;
};

function computeWidth(): PresentationWidth {
  const vw = typeof window === 'undefined' ? 0 : window.innerWidth;
  if (vw <= 550) return 'phone';
  if (vw <= 899) return 'tablet';
  return 'laptop';
}

function computePointer(): PresentationPointer {
  try {
    return window.matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine';
  } catch {
    return 'fine';
  }
}

let snapshot: Presentation = {
  theme: 'day',
  width: computeWidth(),
  pointer: computePointer()
};

// Theme-only painters (e.g. toggle) repaint solely on theme changes. Snapshot
// painters (e.g. search) repaint on any theme / width / pointer change.
type ThemePainter = {el: HTMLElement; paint: (theme: PresentationTheme) => void};
type SnapshotPainter = {el: HTMLElement; paint: (snapshot: Presentation) => void};

const themePainters = new Set<ThemePainter>();
const snapshotPainters = new Set<SnapshotPainter>();

export function currentPresentationTheme(): PresentationTheme {
  return snapshot.theme;
}

export function currentPresentation(): Presentation {
  return {...snapshot};
}

// Register a painter bound to an element. The painter runs on every theme change
// while the element stays connected, and is pruned once the element detaches.
// Returns an unregister handle for callers that want explicit teardown.
export function registerThemePainter(
  el: HTMLElement,
  paint: (theme: PresentationTheme) => void
): () => void {
  const painter: ThemePainter = {el, paint};
  themePainters.add(painter);
  return () => themePainters.delete(painter);
}

// Register a painter that wants the full presentation snapshot (theme + width +
// pointer). Same connected/pruned lifecycle as theme painters.
export function registerPresentationPainter(
  el: HTMLElement,
  paint: (snapshot: Presentation) => void
): () => void {
  const painter: SnapshotPainter = {el, paint};
  snapshotPainters.add(painter);
  return () => snapshotPainters.delete(painter);
}

// Paint immediately with the current theme, then register the same painter for
// future day/night flips. A thin wrapper over `registerThemePainter` for the
// pervasive "paint now, then subscribe" idiom; returns its unregister handle
// unchanged (registers exactly one painter, so painter-count deltas stay +1).
export function paintTheme(el: HTMLElement, run: (theme: PresentationTheme) => void): () => void {
  run(currentPresentationTheme());
  return registerThemePainter(el, run);
}

// Paint immediately with the current presentation snapshot, then register the
// same painter for future theme / width / pointer changes. Thin wrapper over
// `registerPresentationPainter`; returns its unregister handle unchanged.
export function paintPresentation(
  el: HTMLElement,
  run: (snapshot: Presentation) => void
): () => void {
  run(currentPresentation());
  return registerPresentationPainter(el, run);
}

function repaint<T extends {el: HTMLElement}>(set: Set<T>, run: (painter: T) => void): void {
  for (const painter of [...set]) {
    if (!painter.el.isConnected) {
      set.delete(painter);
      continue;
    }
    run(painter);
  }
}

// Set the active theme and repaint every connected painter atomically, pruning
// any whose element has since detached.
export function setPresentationTheme(next: PresentationTheme): void {
  snapshot = {...snapshot, theme: next};
  repaint(themePainters, (p) => p.paint(next));
  repaint(snapshotPainters, (p) => p.paint(snapshot));
}

// Recompute the width / pointer buckets and, only when one actually changed,
// repaint the snapshot painters. Theme painters are untouched.
function refreshBuckets(): void {
  const width = computeWidth();
  const pointer = computePointer();
  if (width === snapshot.width && pointer === snapshot.pointer) return;
  snapshot = {...snapshot, width, pointer};
  repaint(snapshotPainters, (p) => p.paint(snapshot));
}

// Install coalesced resize / matchMedia notification. Returns an explicit
// teardown handle. The shell installs this once; tests exercise both ends.
export function installPresentationReactivity(): () => void {
  let raf = 0;
  const onResize = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      refreshBuckets();
    });
  };
  let ptrQuery: MediaQueryList | undefined;
  try {
    ptrQuery = window.matchMedia('(pointer: coarse)');
  } catch {
    ptrQuery = undefined;
  }
  const onPointer = () => refreshBuckets();
  window.addEventListener('resize', onResize);
  ptrQuery?.addEventListener?.('change', onPointer);
  // Adopt the current geometry immediately in case it changed before install.
  refreshBuckets();
  return () => {
    window.removeEventListener('resize', onResize);
    ptrQuery?.removeEventListener?.('change', onPointer);
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

// Introspection for tests: how many painters of each kind are currently tracked.
export function themePainterCount(): number {
  return themePainters.size;
}

export function presentationPainterCount(): number {
  return snapshotPainters.size;
}
