import {prefersMotion} from '@/shared/capabilities';
import {logScrollWrite} from '@/features/chat/surface/machineScroll';

const SETTLE_CEIL_MS = 1000;

type ScrollRequest = {
  container: HTMLElement;
  element: HTMLElement;
  position: ScrollLogicalPosition;
};

/**
 * The block alignment to hand `scrollIntoView`. A box taller than the container
 * can only align one edge, so it top-aligns (`start`) to keep its head in view;
 * every other box gets the requested alignment.
 */
export function blockFor({container, element, position}: ScrollRequest): ScrollLogicalPosition {
  return element.getBoundingClientRect().height > container.getBoundingClientRect().height
    ? 'start'
    : position;
}

// Resolve when the container reports the smooth scroll landed, or when the
// safety timer fires -- whichever comes first.
function settle(container: HTMLElement): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      container.removeEventListener('scrollend', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, SETTLE_CEIL_MS);
    container.addEventListener('scrollend', finish);
  });
}

// A single animation-frame tick, for the re-targeting settle loops below.
function nextFrame(): Promise<void> {
  return new Promise((resolve) =>
    typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 16)
  );
}

// The container scrollTop that seats the element at the requested alignment,
// clamped to the container's own scroll range. Computed from the two boxes'
// live rects, so it holds wherever the container currently sits. Exported so a
// caller settling a jump (messageTravel) re-targets against the SAME math the
// one-shot below uses.
export function seatScrollTop(request: ScrollRequest): number {
  return containedTop(request);
}
function containedTop(request: ScrollRequest): number {
  const {container, element} = request;
  const block = blockFor(request);
  const containerBox = container.getBoundingClientRect();
  const elementBox = element.getBoundingClientRect();
  const elementTop = elementBox.top - containerBox.top + container.scrollTop;
  let top = elementTop; // block 'start'
  if (block === 'center') top = elementTop - (container.clientHeight - elementBox.height) / 2;
  else if (block === 'end') top = elementTop + elementBox.height - container.clientHeight;
  return Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
}

// Seat the element inside the container, touching ONLY the container.
//
// scrollIntoView is deliberately not used here, for the same reason as
// smoothScrollToBottom below: it scrolls EVERY scrollable ancestor box,
// overflow:hidden ones included. #cyc-columns overflows by the message list's
// pane-gap bleed at phone widths, so a jump-to-message via scrollIntoView also
// shoved the columns box up by that overflow and stranded a background band
// under the composer (the same stuck padding go-to-bottom had). Computing the
// target scrollTop and scrollTo-ing the container itself moves nothing else.
export function smoothScrollTo(request: ScrollRequest): Promise<void> {
  const {container, element} = request;
  if (!element.isConnected || !container.contains(element)) return Promise.resolve();
  const top = containedTop(request);
  if (!prefersMotion()) {
    logScrollWrite(container, 'smooth.to', container.scrollTop, top);
    container.scrollTo({top, behavior: 'auto'});
    return Promise.resolve();
  }
  const done = settle(container);
  logScrollWrite(container, 'smooth.to', container.scrollTop, top);
  container.scrollTo({top, behavior: 'smooth'});
  return done;
}

// Scroll a container to its true end, touching ONLY the container.
//
// scrollIntoView is deliberately not used here: it scrolls EVERY scrollable
// ancestor box, and overflow:hidden boxes are still programmatic scroll
// containers. #cyc-columns overflows by the message list's pane-gap bleed at
// phone widths, so a go-to-bottom via scrollIntoView shoved the whole layout
// up by that overflow and stranded a background band under the composer; with
// no scrollbar there, nothing the user does can undo it (the owner's "padding
// at the bottom of the input box"). scrollTo on the container itself moves
// nothing else, and its target (scrollHeight - clientHeight) is the exact end
// of the content, any clearance margin on the pad-bottom spacer included, so
// the landing is the true bottom with the keyboard open or shut.
//
// The end is re-computed every step: (scrollHeight - clientHeight) grows as
// rows mount and measure taller than their estimate (scrollHeight sampled
// 41,454 -> 52,987 mid-scroll), so a one-shot scrollTo stopped at the stale
// target 11k-25k px short. This walks the scroll toward the CURRENT end until
// the distance holds at <= 1px for a few frames, bounded so it always ends.
//
// A FAR target is jumped instantly, never smooth-animated: over a deep virtual
// list a smooth animation would drag the window through every intermediate
// offset, mounting and measuring each row on the way so the end keeps receding
// and the animation never lands (and thousands of nodes churn). A jump mounts
// only the tail, so the end settles after one small correction, which -- being
// near now -- keeps the smooth finish motion users expect.
//
// `readerTook` (optional): the moment it answers true -- a finger or pointer
// landed on the list -- the reader owns the offset and the walk stops writing.
export async function smoothScrollToBottom(
  container: HTMLElement,
  readerTook?: () => boolean
): Promise<void> {
  const target = () => container.scrollHeight - container.clientHeight;
  const smooth = prefersMotion();
  const MAX_STEPS = 40; // hard ceiling, never spins forever
  const STABLE_FRAMES = 4;
  let stable = 0;
  for (let i = 0; i < MAX_STEPS; i++) {
    if (readerTook?.()) return;
    const top = target();
    if (top - container.scrollTop <= 1) {
      if (++stable >= STABLE_FRAMES) return;
      await nextFrame();
      continue;
    }
    stable = 0;
    const near = top - container.scrollTop <= 2 * container.clientHeight;
    if (smooth && near) {
      logScrollWrite(container, 'smooth.bottom', container.scrollTop, top);
      container.scrollTo({top, behavior: 'smooth'});
      await settle(container);
    } else {
      logScrollWrite(container, 'smooth.bottom', container.scrollTop, top);
      container.scrollTo({top, behavior: 'auto'});
      await nextFrame();
    }
  }
  // Ceiling reached: land exactly on the end so a slow-settling list is never
  // left short.
  if (readerTook?.()) return;
  logScrollWrite(container, 'smooth.bottom', container.scrollTop, target());
  container.scrollTo({top: target(), behavior: 'auto'});
}
