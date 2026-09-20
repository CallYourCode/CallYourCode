import * as engine from '@/engine/store';
import {active} from '@/sessionSelectors';
import {cyclog} from '@/shared/logging';
import {extendMessageWindow, messageWindowFrom} from './messageList';

// A wheel/touch flick that leaves the viewport within this many px of the top
// counts as a request for older history.
const START_LOAD_PX = 100;

interface HistoryPagerOptions {
  container: HTMLElement;
  messages: HTMLElement;
  render(): void;
  ownsOpening(): boolean;
  isAnchoring(): boolean;
  isMachineScroll(top: number): boolean;
}

export function installHistoryPager(options: HistoryPagerOptions) {
  const {container, messages, render, ownsOpening, isAnchoring, isMachineScroll} = options;
  let extendingEarlier = false;
  let lastScrollPos = 0;
  let prepending = false;

  container.addEventListener('scroll', () => {
    const pos = container.scrollTop;
    const up = pos < lastScrollPos;
    lastScrollPos = pos;
    if (!up || extendingEarlier || pos > 600) return;
    if (isMachineScroll(pos) || ownsOpening()) return;
    if (messageWindowFrom(messages) <= 0) return;
    extendingEarlier = true;
    try {
      if (extendMessageWindow(messages)) render();
    } finally {
      extendingEarlier = false;
    }
  });

  const loadEarlier = () => {
    const session = active();
    if (!session || prepending || ownsOpening() || isAnchoring()) return;
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
      if (prepending) return pagerSay('prepending');
      const session = active();
      if (!session) return pagerSay('no-active');
      if (ownsOpening() || isAnchoring()) return pagerSay('owned');
      if (!engine.canOlder(session.id)) return pagerSay('no-older', {session: session.id});
      const first = messages.querySelector('.cyc-message:not(.cyc-msg-system)');
      const containerTop = container.getBoundingClientRect().top;
      if (first && first.getBoundingClientRect().top < containerTop - 200)
        return pagerSay('covered');
      pagerSay('fetch', {session: session.id, top});
      loadEarlier();
    },
    {passive: true}
  );

  const topInput = () => {
    if (container.scrollTop <= START_LOAD_PX) loadEarlier();
  };
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
