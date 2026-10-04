// A reload the app does to itself (a new build, a missing chunk, an engine
// switch) keeps the open chat; any other launch (the user reopening the app,
// including after a force close) starts on the chats list. sessionStorage
// lives exactly as long as the page's browsing context, so the mark survives
// our own reload and is gone after the app is closed.

import {cyclog} from './logging';

const KEY = 'cyc-self-reload';
// Our reloads land within seconds; an older mark is not about this boot.
const FRESH_MS = 60_000;

export function markSelfReload(): void {
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {}
}

/** True when this boot is the app's own reload; the mark is spent either way. */
export function consumeSelfReload(now: number = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(KEY) ?? '');
    sessionStorage.removeItem(KEY);
    return Number.isFinite(at) && at > 0 && now - at < FRESH_MS;
  } catch {
    return false;
  }
}

// The update-reload departure breadcrumb, in localStorage (NOT sessionStorage):
// a black-screen reload that the owner force-closes out of ends the browsing
// context, so sessionStorage is gone on the next launch; localStorage is not.
// Stamped just before the reload navigation and read once at the next boot,
// it lets that boot log how long the gap was and which builds it crossed, so a
// stuck reload names itself instead of being a silent hole in app.log.
const DEPART_KEY = 'cyc-reload-depart';

// `hidden`: the reload left from the background (a draft held it until then),
// so its gap includes the time the app spent there and is not a stuck reload.
export type ReloadDeparture = {at: number; from: string; to: string; hidden: boolean};

export function markReloadDeparture(from: string, to: string, hidden = false): void {
  try {
    localStorage.setItem(DEPART_KEY, JSON.stringify({at: Date.now(), from, to, hidden}));
  } catch {}
}

/** The pending departure, if any; spent on read so each reload lands once. */
export function readReloadDeparture(): ReloadDeparture | null {
  try {
    const raw = localStorage.getItem(DEPART_KEY);
    localStorage.removeItem(DEPART_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<ReloadDeparture>;
    if (typeof p?.at !== 'number' || !Number.isFinite(p.at)) return null;
    return {
      at: p.at,
      from: String(p.from ?? ''),
      to: String(p.to ?? ''),
      hidden: p.hidden === true
    };
  } catch {
    return null;
  }
}

// --- The self-navigation gate ----------------------------------------------
// EVERY navigation the app does to itself (an update reload, a missing-chunk
// reload, an engine switch, sign-out, clear-data) goes through navigateSelf.
// The one hazard it guards: a new service worker installed but WAITING. In
// Chromium a request can restart the old worker while it is being stopped for
// the new one's activation, which parks the new one; a navigation that then
// triggers the activation is dispatched to the old worker as it is stopped and
// never completes: the page hangs blank (proven 2026-10-03, sw-activation-race
// / sw-chunk-reload specs). So it never navigates into a waiting worker: it
// asks it to take over ({t: 'skip-waiting'}, cyc-sw.js; it activates about a
// second later, or once the old worker idles, 300 s at worst) and holds.
//  - The update and missing-chunk reloads hold until it has: the page stays
//    usable on the build it runs meanwhile.
//  - A user action (sign-out, engine switch, clear data) shows its notice and
//    holds at most WAITING_MAX_MS, then navigates to its URL with ?cyc-net=1,
//    which cyc-sw.js routes straight to the network: it boots from there
//    without ever reaching the stuck old worker (Chromium proof 2026-10-04).
// An INSTALLING worker never holds a navigation: on a stalled radio an install
// runs for minutes (Chromium 300 s), and the active worker answers meanwhile.
// A caller may add its own hold (the update reload's composer hold), re-decided
// on every tick and at once when the app goes to the background.

export type SelfNavDeps = {
  workerWaiting: () => Promise<boolean>;
  askActivate: () => void;
  hidden: () => boolean;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  // Subscribe to the app going to the background; returns the unsubscribe.
  onHidden: (fn: () => void) => () => void;
  log: (event: string, fields: Record<string, unknown>) => void;
  // A brief notice ('Reloading…') while a waiting worker holds a user action.
  notify: (message: string) => void;
};

export type SelfNav = {
  // What this navigation is, for app.log ('update', 'chunk-missing', ...).
  why: string;
  // Navigate, exactly once. viaNetwork: a new worker is still parked, so
  // navigate to netNavUrl(...) (a user action past WAITING_MAX_MS).
  go: (at: {waited: number; hidden: boolean; viaNetwork: boolean}) => void;
  // The caller's own hold ('' = none), re-asked on every tick.
  hold?: (waited: number, hidden: boolean) => string;
  // Every tick the caller's hold keeps the navigation.
  onHeld?: (hold: string, waited: number, hidden: boolean) => void;
  // Marks a user action: its notice, shown if a waiting worker holds it; held
  // WAITING_MAX_MS at most.
  userAction?: string;
  // Delay before the first decision (the update reload shows its toast first).
  firstTickMs?: number;
};

export const WAITING_MAX_MS = 4000; // an asked worker activates in about a second
const WORKER_TICK_MS = 300;
const HOLD_TICK_MS = 1500; // a caller hold (a draft) ends on a user action

export const NET_NAV_PARAM = 'cyc-net';

// The same page, routed straight to the network (cyc-sw.js CYC_ROUTE_TABLE).
export function netNavUrl(href: string): string {
  const url = new URL(href, location.href);
  url.searchParams.set(NET_NAV_PARAM, '1');
  return url.toString();
}

// Boot: drop the marker so the user's own reloads come from the cache again.
export function dropNetNavParam(): void {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has(NET_NAV_PARAM)) return;
    url.searchParams.delete(NET_NAV_PARAM);
    history.replaceState(history.state, '', url.toString());
  } catch {}
}

export function createSelfNavGate(deps: SelfNavDeps): (nav: SelfNav) => void {
  let gone = false; // one self-navigation per page life wins; the rest stand down
  return (nav: SelfNav) => {
    const since = deps.now();
    let waitingSince = -1; // when the worker hold began (-1: not holding)
    let timer: unknown = null;
    let ticking = false;
    let again = false;
    const off = deps.onHidden(() => void tick());
    const tick = async (): Promise<void> => {
      if (gone) return off();
      if (ticking) {
        again = true; // an edge arrived mid-tick: decide again right after
        return;
      }
      ticking = true;
      if (timer !== null) deps.cancel(timer);
      timer = null;
      try {
        const now = deps.now();
        const waited = now - since;
        const hidden = deps.hidden();
        const own = nav.hold?.(waited, hidden) ?? '';
        if (own) {
          waitingSince = -1;
          nav.onHeld?.(own, waited, hidden);
          timer = deps.schedule(() => void tick(), HOLD_TICK_MS);
          return;
        }
        const waiting = await deps.workerWaiting().catch(() => false);
        if (gone) return off();
        if (!waiting) waitingSince = -1;
        else if (waitingSince < 0) {
          waitingSince = now;
          deps.log('nav.held', {why: nav.why, hold: 'sw-waiting'});
          if (nav.userAction) deps.notify(nav.userAction);
        }
        const heldFor = waitingSince < 0 ? 0 : now - waitingSince;
        if (waiting && (!nav.userAction || heldFor < WAITING_MAX_MS)) {
          deps.askActivate();
          timer = deps.schedule(() => void tick(), WORKER_TICK_MS);
          return;
        }
        gone = true;
        off();
        deps.log('nav.go', {why: nav.why, waited, hidden, ...(waiting ? {viaNetwork: true} : {})});
        nav.go({waited, hidden, viaNetwork: waiting});
      } finally {
        ticking = false;
        if (again && !gone) {
          again = false;
          void tick();
        }
      }
    };
    timer = deps.schedule(() => void tick(), nav.firstTickMs ?? 0);
  };
}

const swSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

export async function workerWaiting(): Promise<boolean> {
  if (!swSupported()) return false;
  try {
    return !!(await navigator.serviceWorker.getRegistration())?.waiting;
  } catch {
    return false;
  }
}

export function askActivate(): void {
  if (!swSupported()) return;
  void navigator.serviceWorker
    .getRegistration()
    .then((r) => r?.waiting?.postMessage({t: 'skip-waiting'}))
    .catch(() => {});
}

let notifier: (message: string) => void = () => {};
// main registers the real toast once it is up (this module renders nothing).
export function setSelfNavNotifier(fn: (message: string) => void): void {
  notifier = fn;
}

const realDeps: SelfNavDeps = {
  workerWaiting,
  askActivate,
  hidden: () => typeof document !== 'undefined' && document.hidden,
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  onHidden: (fn) => {
    if (typeof document === 'undefined') return () => {};
    const h = () => {
      if (document.hidden) fn();
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  },
  log: (event, fields) => cyclog(event, fields),
  notify: (message) => notifier(message)
};

let gate = createSelfNavGate(realDeps);

/** Navigate this page (reload, replace, assign) through the gate. */
export function navigateSelf(nav: SelfNav): void {
  gate(nav);
}

// Test seam: a fresh page (the gate lets one self-navigation per page life go).
export function resetSelfNavForTests(): void {
  gate = createSelfNavGate(realDeps);
}
