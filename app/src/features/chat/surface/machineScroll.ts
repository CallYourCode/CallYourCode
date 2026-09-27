import {cyclog} from '@/shared/logging';

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

// ---------------------------------------------------------------------------
// V4 scroll diagnostic (Lane C step 0). Always-on, rate-limited cyclog lines
// that name every writer of the message scroller's scroll position and why it
// ran. A home-screen PWA cannot set ?cycscroll=1, so these ship unconditionally
// via the existing cyclog (which is already gated by the hosted-privacy switch
// and shipped with dev=<device>). Rate-limited to at most 1 line / 2s PER KEY;
// the next allowed line for a key carries the count suppressed since the last.
const DIAG_RATE_MS = 2000;
const diagAt = new Map<string, number>();
const diagSuppressed = new Map<string, number>();
function diagLog(key: string, event: string, fields: Record<string, unknown>): void {
  const now = Date.now();
  const prev = diagAt.get(key) ?? 0;
  if (now - prev < DIAG_RATE_MS) {
    diagSuppressed.set(key, (diagSuppressed.get(key) ?? 0) + 1);
    return;
  }
  diagAt.set(key, now);
  const supp = diagSuppressed.get(key) ?? 0;
  diagSuppressed.set(key, 0);
  cyclog(event, supp ? {...fields, suppressed: supp} : fields);
}

// A programmatic scrollTop/scrollTo write on the chat scroller. `from` is the
// offset just before the write; call BEFORE markMachineTop so the ctx compares
// `from` against the PREVIOUS machine top: ctx=machine means the scroller was
// still where the machine last left it (no reader scroll since), ctx=user means
// a reader had moved it before this write. dir is the direction of THIS write.
export function logScrollWrite(el: Element, tag: string, from: number, to: number): void {
  if (Math.abs(to - from) < 1) return; // a no-op write says nothing about a creep
  const prev = lastTop.get(el);
  const ctx = prev !== undefined && Math.abs(from - prev) <= 1 ? 'machine' : 'user';
  const dir = to < from ? 'up' : 'down';
  diagLog(`scroll.write:${tag}`, 'scroll.write', {
    tag,
    from: Math.round(from),
    to: Math.round(to),
    dir,
    ctx
  });
}

// A store paint of the open chat (bracketMessageRender). `changed` names the
// contentVersion inputs that moved since the last paint (status, thinking,
// turnSince, lastActivity, contextPct); `set` is whether the message set itself
// changed. This is the writer the V4 chain blames for the idle upward creep.
export function logChatRepaint(fields: Record<string, unknown>): void {
  diagLog('chat.repaint', 'chat.repaint', fields);
}

// An UPWARD scroll event on the chat scroller not attributed to a machine write
// (isMachineTop was false at the event): a real reader scroll, or an untagged
// writer the instrumentation above missed.
export function logScrollUpUser(from: number, to: number): void {
  diagLog('scroll.up.user', 'scroll.up.user', {
    from: Math.round(from),
    to: Math.round(to),
    delta: Math.round(from - to)
  });
}
