// The ONE owner of the "last machine write" tag for a message scroller. Every
// programmatic scrollTop write to `.cyc-message-list-scroll` -- the open landing
// (silentScrollTo), the render bracket (bracketMessageRender), and the keyboard/
// composer clearance compensation (features/chat/scrolling.ts settle) -- records
// where it landed here. The scroll listener reads it back to tell an app-driven
// adjustment from a real reader scroll; without a shared tag the clearance write
// looked like a reader taking the scroll and stole the open landing.
//
// Keyed by element (WeakMap), so two collaborators writing the same scroller
// share one tag with no import cycle and no per-surface duplicate of the state.
const lastTop = new WeakMap<Element, number>();

// Record where a machine write landed. Call immediately AFTER writing scrollTop.
export function markMachineTop(el: Element): void {
  lastTop.set(el, el.scrollTop);
}

// True when `top` matches the last machine write on `el` (within 1px). Untagged
// elements never match, so a reader scroll before any machine write reads false.
export function isMachineTop(el: Element, top: number): boolean {
  const t = lastTop.get(el);
  return t !== undefined && Math.abs(top - t) <= 1;
}

// The last recorded machine top for `el`, or -1 if none. Diagnostics only.
export function machineTopOf(el: Element): number {
  return lastTop.get(el) ?? -1;
}
