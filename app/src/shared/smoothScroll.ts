import {prefersMotion} from '@/shared/capabilities';

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

// The container scrollTop that seats the element at the requested alignment,
// clamped to the container's own scroll range. Computed from the two boxes'
// live rects, so it holds wherever the container currently sits.
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
    container.scrollTo({top, behavior: 'auto'});
    return Promise.resolve();
  }
  const done = settle(container);
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
export function smoothScrollToBottom(container: HTMLElement): Promise<void> {
  const top = container.scrollHeight - container.clientHeight;
  if (!prefersMotion()) {
    container.scrollTo({top, behavior: 'auto'});
    return Promise.resolve();
  }
  const done = settle(container);
  container.scrollTo({top, behavior: 'smooth'});
  return done;
}
