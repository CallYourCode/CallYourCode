// Count and dot treatments for unread/notification affordances. The pills size
// themselves from their own text rather than snapping to a fixed scale.
export const BADGE_PROMINENT = 'h-7 min-w-7 leading-7 px-2.5';
export const BADGE_COMPACT = 'h-[1.125rem] min-w-[1.125rem] leading-[1.125rem] px-1';
export const BADGE_FACE = 'font-semibold text-[#f8f3ed] text-xs text-center rounded-full';
export const BADGE_MOTION = 'transition-[background-color,opacity] duration-150 ease-out';

export const DOT_SM = 'size-2 p-0';
export const DOT_MD = 'size-2.5 p-0';

// Set a count pill's numerals and its empty state together: a positive count shows
// the number, anything else collapses the box via the `hidden` attribute.
export function setBadgeCount(el: HTMLElement, count: number): void {
  el.textContent = count > 0 ? String(count) : '';
  el.hidden = count <= 0;
}
