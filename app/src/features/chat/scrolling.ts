import {markMachineTop} from './surface/machineScroll';

type ClearanceClaimant = 'composer' | 'keyboard';

const NEAR_BOTTOM_PX = 100;

const claims = new Map<ClearanceClaimant, number>();

let spacer: HTMLElement | null = null;
let scroller: HTMLElement | null = null;

let applied = 0;
let pointerDown = false;
let listening = false;

let distanceToEnd = 0;

function desired() {
  let total = 0;
  for (const px of claims.values()) total += px;
  return total;
}

function listen() {
  if (listening) return;
  listening = true;

  document.addEventListener(
    'pointerdown',
    () => {
      pointerDown = true;
    },
    {capture: true}
  );
  const up = () => {
    pointerDown = false;
    settle();
  };
  document.addEventListener('pointerup', up, {capture: true});
  document.addEventListener('pointercancel', up, {capture: true});
  window.addEventListener('blur', up);
}

function settle() {
  const want = desired();
  if (want === applied || !spacer || !scroller) return;
  // The pointerDown / distanceToEnd gates exist to protect a reader who scrolled
  // into history from a GROWING spacer that would shove content under their eyes.
  // A SHRINK toward a smaller (or zero) total -- e.g. the keyboard closing -- must
  // NEVER be gated: leaving the stranded margin in place is exactly the empty-band
  // bug. The compensating scrollTop write below keeps the content anchored under
  // the reader whichever direction the total moves.
  if (want > applied && (pointerDown || distanceToEnd > NEAR_BOTTOM_PX)) return;

  const from = scroller.scrollTop;
  // removeProperty (not `= ''`) so the inline declaration is actually dropped when
  // the total returns to the base -- both clear in a real browser, but only
  // removeProperty reliably clears everywhere.
  if (want) spacer.style.marginBottom = want + 'px';
  else spacer.style.removeProperty('margin-bottom');
  scroller.scrollTop = from + (want - applied);
  // Tag this compensating write as a machine scroll on the shared owner
  // (surface/machineScroll.ts): it is exactly the write that, mid keyboard
  // dismissal, arrives inside another chat's open-landing window and would
  // otherwise read as a reader taking the scroll.
  markMachineTop(scroller);
  applied = want;
}

function release() {
  if (desired() || !scroller) return;
  scroller.removeEventListener('scroll', onScroll);
  // Never orphan a stranded margin on teardown: clear the inline margin and reset
  // the applied total before dropping the refs.
  if (spacer) spacer.style.removeProperty('margin-bottom');
  applied = 0;
  spacer = scroller = null;
}

const onScroll = () => {
  if (scroller) {
    distanceToEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  }
  settle();
};

function bind(host: Element | undefined, fresh = false) {
  if (scroller && !fresh) return;
  const chat = host?.closest('.cyc-thread');
  const s = chat?.querySelector('.cyc-message-list-pad-bottom') as HTMLElement;
  const c = chat?.querySelector('.cyc-message-list-scroll') as HTMLElement;
  if (!s || !c) return;
  spacer = s;
  // Wire the scroll listener only when the scroller actually changes, so the two
  // fresh binds (trackComposerHeight + trackKeyboardInset) cannot double-wire
  // onScroll onto the same scroller.
  if (c !== scroller) {
    scroller?.removeEventListener('scroll', onScroll);
    distanceToEnd = 0;
    applied = 0;
    scroller = c;
    c.addEventListener('scroll', onScroll, {passive: true});
  }
  listen();
}

function claimClearance(who: ClearanceClaimant, px: number, host?: Element) {
  px = Math.max(0, Math.round(px));
  if ((claims.get(who) ?? 0) === px) return;
  if (px) claims.set(who, px);
  else claims.delete(who);
  if (px) bind(host);
  settle();
}

// The keyboard inset (published by installShell as the `cyc:kbinset` event) is
// claimed through the same clearance engine as the composer height, so the newest
// messages stay visible above the lifted composer and the scroll position is
// preserved (or pinned to bottom when already at bottom) -- no fling on focus.
export function trackKeyboardInset(bar: HTMLElement): () => void {
  bind(bar, true);

  const onInset = (e: Event) => {
    const px = (e as CustomEvent<number>).detail;
    claimClearance('keyboard', typeof px === 'number' ? px : 0, bar);
    // A keyboard dismissal on its own produces no later near-bottom scroll to
    // clean up the spacer. claimClearance already ran settle synchronously; re-run
    // it after the browser settles layout so the shrink lands even if the first
    // pass observed a stale distanceToEnd.
    requestAnimationFrame(() => settle());
  };
  window.addEventListener('cyc:kbinset', onInset);

  return () => {
    window.removeEventListener('cyc:kbinset', onInset);
    claimClearance('keyboard', 0);
    release();
  };
}

export function trackComposerHeight(bar: HTMLElement): () => void {
  let base = 0;

  bind(bar, true);

  const publishOvershoot = (px: number) =>
    document.documentElement.style.setProperty('--cyc-composer-overshoot', px + 'px');

  const ro = new ResizeObserver((entries) => {
    const h = entries[entries.length - 1].contentRect.height;
    if (!h) return;
    if (!base || h < base) base = h;
    claimClearance('composer', h - base, bar);
    publishOvershoot(h - base);
  });
  ro.observe(bar);

  const onResize = () => {
    base = 0;
  };
  window.addEventListener('resize', onResize);

  return () => {
    ro.disconnect();
    window.removeEventListener('resize', onResize);
    claimClearance('composer', 0);
    publishOvershoot(0);
    release();
  };
}
