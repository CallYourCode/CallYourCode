// Field trace for "tapping an image in the chat opened nothing" (iPhone PWA).
// Passive listeners only: they read events and never prevent, stop or reorder
// them. Capture on document runs ahead of every handler under it (including the
// swipe recognisers' own capture click filter on the scroller), and each line is
// written once dispatch is over, so a click that something swallowed reads as
// dp=1 (prevented) and/or reached=0 (never got back up to the window).
//
// tap.media          ph=down|click: one line per press on a message's media and
//                    per click that lands while such a press is pending.
// tap.media.noclick  a press on media with no click within NOCLICK_MS.
import {cyclog} from '@/shared/logging';

const MEDIA = '.cyc-media-box, .cyc-doc, video';
const NOCLICK_MS = 700;

interface Press {
  media: Element;
  x: number;
  y: number;
  at: number;
  moved: number;
  pcancel: boolean;
  tend: string;
  clicked: boolean;
}

// `img.cyc-still`: the tag plus at most two app classes (never the utility soup).
export function tagOf(el: Element | null): string {
  if (!el) return 'none';
  const cls = Array.from(el.classList)
    .filter((c) => c.startsWith('cyc-'))
    .slice(0, 2);
  return [el.tagName.toLowerCase(), ...cls].join('.');
}

// Whether the tapped media has something its click handler can open.
function openable(media: Element): string {
  if (media.matches('.cyc-doc')) return 'doc';
  if (media.matches('video') || media.querySelector('video')) return 'video';
  if (media.querySelector('.cyc-media-gone')) return 'gone';
  const img = media.querySelector('img');
  if (!img) return 'none';
  if (img.classList.contains('cyc-off')) return 'img-off';
  return img.complete && img.naturalWidth > 0 ? 'img' : 'img-wait';
}

export function installMediaTapTrace(root: HTMLElement): () => void {
  let press: Press | null = null;
  let reachedClick: Event | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const mediaOf = (t: EventTarget | null): Element | null => {
    const media = t instanceof Element ? t.closest(MEDIA) : null;
    return media && root.contains(media) && media.closest('.cyc-message') ? media : null;
  };
  const view = () => (root.closest('[data-view]') as HTMLElement | null)?.dataset.view ?? '?';
  const hitOf = (e: MouseEvent, target: Element | null): string | undefined => {
    const hit = document.elementFromPoint?.(e.clientX, e.clientY) ?? null;
    return hit === target ? undefined : tagOf(hit);
  };
  const kindOf = (e: Event) => ('pointerType' in e ? (e as PointerEvent).pointerType : undefined);

  const onDown = (e: PointerEvent) => {
    const media = mediaOf(e.target);
    if (!media) return;
    const p: Press = {
      media,
      x: e.clientX,
      y: e.clientY,
      at: Date.now(),
      moved: 0,
      pcancel: false,
      tend: 'none',
      clicked: false
    };
    press = p;
    const target = e.target as Element;
    later(() => {
      cyclog('tap.media', {
        ph: 'down',
        tgt: tagOf(target),
        hit: hitOf(e, target),
        pt: e.pointerType,
        dp: e.defaultPrevented ? 1 : 0,
        view: view(),
        open: openable(media)
      });
    }, 0);
    later(() => {
      if (press === p) press = null;
      if (p.clicked) return;
      cyclog('tap.media.noclick', {
        tgt: tagOf(target),
        pcancel: p.pcancel ? 1 : 0,
        mv: p.moved,
        tend: p.tend,
        view: view()
      });
    }, NOCLICK_MS);
  };

  const onMove = (e: PointerEvent) => {
    if (!press) return;
    const d = Math.round(Math.hypot(e.clientX - press.x, e.clientY - press.y));
    if (d > press.moved) press.moved = d;
  };
  const onCancel = () => {
    if (press) press.pcancel = true;
  };
  // Bubble on window: read after every handler below has run.
  const onTouchEnd = (e: TouchEvent) => {
    if (press) press.tend = e.defaultPrevented ? 'pd' : 'ok';
  };

  const onClick = (e: MouseEvent) => {
    const media = mediaOf(e.target);
    const p = press;
    // A click with no pending media press is only ours when it lands on media.
    if (!media && !p) return;
    if (p) p.clicked = true;
    const target = e.target as Element | null;
    later(() => {
      cyclog('tap.media', {
        ph: 'click',
        tgt: tagOf(target),
        hit: hitOf(e, target),
        pt: kindOf(e),
        dp: e.defaultPrevented ? 1 : 0,
        reached: reachedClick === e ? 1 : 0,
        onmedia: media ? (p && p.media !== media ? 'other' : 1) : 0,
        det: e.detail,
        mv: p?.moved,
        ms: p ? Date.now() - p.at : undefined,
        view: view(),
        open: media ? openable(media) : undefined
      });
    }, 0);
  };
  const onClickReached = (e: MouseEvent) => {
    reachedClick = e;
  };

  const capture: AddEventListenerOptions = {capture: true, passive: true};
  const bubble: AddEventListenerOptions = {passive: true};
  document.addEventListener('pointerdown', onDown, capture);
  document.addEventListener('click', onClick, capture);
  window.addEventListener('pointermove', onMove, capture);
  window.addEventListener('pointercancel', onCancel, capture);
  window.addEventListener('touchend', onTouchEnd, bubble);
  window.addEventListener('click', onClickReached, bubble);

  return () => {
    document.removeEventListener('pointerdown', onDown, capture);
    document.removeEventListener('click', onClick, capture);
    window.removeEventListener('pointermove', onMove, capture);
    window.removeEventListener('pointercancel', onCancel, capture);
    window.removeEventListener('touchend', onTouchEnd, bubble);
    window.removeEventListener('click', onClickReached, bubble);
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
