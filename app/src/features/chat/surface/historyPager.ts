import * as engine from '@/engine/store';
import {active} from '@/sessionSelectors';
import {cyclog} from '@/shared/logging';

interface HistoryPagerOptions {
  container: HTMLElement;
  render(): void;
  ownsOpening(): boolean;
  isAnchoring(): boolean;
  // The ScrollOwner's answers (R7): was this offset a machine write, and does the
  // view sit at the top of the loaded history (read off the offsets)?
  isMachineScroll(top: number): boolean;
  atTop(): boolean;
}

export function installHistoryPager(options: HistoryPagerOptions) {
  const {container, render, ownsOpening, isAnchoring, isMachineScroll, atTop} = options;
  let prepending = false;
  // The rendered window is virtual now: reaching the top no longer extends an
  // in-memory floor (every loaded row is already in the model). It only pulls
  // older STORE pages, below (loadEarlier), which prepend to the model; the
  // render bracket preserves the reader's anchor across the prepend. Whatever
  // asks, older history loads only at the top of the loaded history, as the
  // owner reads it.

  const loadEarlier = () => {
    const session = active();
    if (!session || prepending || ownsOpening() || isAnchoring() || !atTop()) return;
    if (!engine.canOlder(session.id)) return;
    prepending = true;
    void engine
      .loadOlder(session.id)
      .then(render)
      .finally(() => {
        prepending = false;
      });
  };

  // A 1px probe pinned to the very top of the scroll content: once it enters the
  // container's own viewport we are at (or within a hair of) the start, so pull in
  // older history.
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.className = 'cyc-overflow-start-sentinel';
  sentinel.style.height = '1px';
  container.prepend(sentinel);
  const nearStart =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(
          (entries) => {
            if (entries[entries.length - 1]?.isIntersecting) loadEarlier();
          },
          {root: container, threshold: 0}
        );
  nearStart?.observe(sentinel);

  let lastCoverTop = 0;
  let lastPagerSaid = '';
  let lastPagerAt = 0;
  const pagerSay = (why: string, extra: Record<string, unknown> = {}) => {
    const now = Date.now();
    if (why === lastPagerSaid && now - lastPagerAt < 2000) return;
    lastPagerSaid = why;
    lastPagerAt = now;
    cyclog('pager.cover', {why, ...extra});
  };
  container.addEventListener(
    'scroll',
    () => {
      const top = container.scrollTop;
      const up = top < lastCoverTop;
      lastCoverTop = top;
      if (!up) return;
      // Only a reader's scroll reaching the top loads older history, and the
      // owner answers both halves. The upward move is the APP'S OWN re-seat,
      // not a reader flick: the render bracket, the anchored re-window, the open
      // landing all write scrollTop and tag it (machineScroll). Loading older
      // history off a machine re-seat is the go-to-bottom runaway (the field saw
      // go-to-bottom's re-window yank scrollTop up ~8k px and the pager answer
      // with a burst of history.older far from the top). And "the top" is the
      // start of the loaded history as the owner reads it, never the first
      // MOUNTED row meeting the viewport: that is the virtual window's own
      // edge, met anywhere whenever the view outruns the window (BZ
      // Distributor, 2026-10-03: a browser clamp, untagged, read as the top at
      // 56k px).
      if (isMachineScroll(top)) return pagerSay('machine');
      if (prepending) return pagerSay('prepending');
      const session = active();
      if (!session) return pagerSay('no-active');
      if (ownsOpening() || isAnchoring()) return pagerSay('owned');
      if (!engine.canOlder(session.id)) return pagerSay('no-older', {session: session.id});
      if (!atTop()) return pagerSay('covered');
      pagerSay('fetch', {session: session.id, top});
      loadEarlier();
    },
    {passive: true}
  );

  // A wheel/touch pull toward the top while already there (no scroll event
  // follows at offset 0) is the reader asking for older history.
  const topInput = () => loadEarlier();
  container.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY < 0) topInput();
    },
    {passive: true}
  );
  let touchY = 0;
  container.addEventListener(
    'touchstart',
    (event) => {
      touchY = event.touches[0]?.clientY ?? 0;
    },
    {passive: true}
  );
  container.addEventListener(
    'touchmove',
    (event) => {
      const y = event.touches[0]?.clientY ?? 0;
      if (y > touchY + 8) topInput();
      touchY = y;
    },
    {passive: true}
  );

  return {
    renderEarlier: render,
    destroy() {
      nearStart?.disconnect();
    }
  };
}
