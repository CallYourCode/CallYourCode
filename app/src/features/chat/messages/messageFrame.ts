import {h} from '@/components/domHelpers';
import {paintPresentation, type Presentation} from '@/components/presentation';

// Message frame width and first/last/unread state.

// On phone the frame carries a 0.5rem side margin so a bubble never sits flush
// against the screen edge (received on the left, sent on the right; flex-start
// vs flex-row-reverse pick the side). Wider layouts center a 30rem column and
// need no edge inset.
export function messageFrameEl(): HTMLDivElement {
  return h('div', 'cyc-message-frame flex flex-col max-w-[var(--cyc-msg-frame-max)] max-tab:mx-2');
}

export function docFrameEl(): HTMLDivElement {
  return messageFrameEl();
}

// Paints the single responsive frame-width token on the list inner; every
// `.cyc-message-frame` reads it by inheritance. Phone allows the frame 2.75rem
// of side room: the 0.5rem near-edge margin the frame carries (messageFrameEl)
// plus 2.25rem of clearance on the far side. Wider layouts use the 30rem
// reading column.
export function paintMessageFrameWidth(inner: HTMLElement): void {
  const run = (p: Presentation) => {
    const value = p.width === 'phone' ? 'calc(100% - 2.75rem)' : '30rem';
    inner.style.setProperty('--cyc-msg-frame-max', value);
  };
  paintPresentation(inner, run);
}

// Service-row width: 2.25rem inset on phone, 4rem otherwise.
export function paintServiceRowWidth(el: HTMLElement): void {
  const run = (p: Presentation) => {
    el.style.maxWidth = p.width === 'phone' ? 'calc(100% - 2.25rem)' : 'calc(100% - 4rem)';
  };
  paintPresentation(el, run);
}

// Stamps the group/unread state onto a frame-bearing message root. The highlight
// geometry reads `[data-cyc-first]` / `[data-cyc-last]` for the group ends and
// `[data-cyc-unread]` for the unread landing; markUnreadLanding adds the last one
// once the list knows which row the unread run opens on.
export function applyMessageState(node: HTMLElement, first: boolean, last: boolean): void {
  if (first) node.dataset.cycFirst = '';
  if (last) node.dataset.cycLast = '';
}

// Flips a painted row's group-end state in place: the gap below it
// (messageClasses) and the highlight geometry. A row that gains or loses a
// same-role neighbour below it changes only this, so the list flips it here
// rather than rebuilding the row.
export function setMessageLast(node: HTMLElement, last: boolean): void {
  node.classList.toggle('mb-2', last);
  node.classList.toggle('mb-1', !last);
  if (last) node.dataset.cycLast = '';
  else delete node.dataset.cycLast;
}

export function markUnreadLanding(node: HTMLElement): void {
  node.dataset.cycUnread = '';
}

export const UNREAD_LANDING_SELECTOR = '[data-cyc-unread]';
