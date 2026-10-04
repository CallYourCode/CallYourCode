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
// reload, an engine switch, sign-out, clear-data) goes through navigateSelf,
// under ONE rule. The hazard: a new service worker installed but WAITING. In
// Chromium a request can restart the old worker while it is being stopped for
// the new one's activation, which parks the new one; a navigation that then
// triggers the activation is dispatched to the old worker as it is stopped and
// never completes: the page hangs blank (proven 2026-10-03). So while a worker
// waits the gate asks it to take over ({t: 'skip-waiting'}, cyc-sw.js; it
// activates about a second later) and holds; if it is still waiting
// WAITING_MAX_MS after the ask, the gate navigates to the same URL with
// ?cyc-net=1, which cyc-sw.js routes straight to the network for any path: the
// page loads from there and never reaches the stuck old worker. It never
// navigates into a parked worker. An INSTALLING worker never holds a
// navigation (on a stalled radio an install runs for minutes; the active
// worker answers meanwhile). A caller may add its own hold (the update
// reload's composer hold), re-decided every tick and at once when the app
// goes to the background.
// The gate holds ONE pending self-navigation; callers keep no flags of their
// own. Merge rule: a new request replaces the pending one unless it would wait
// longer, i.e. unless it brings a hold of its own. So a missing chunk or a user
// action (no hold) replaces an update reload held by a draft and goes now; an
// update reload (draft hold) never replaces a hold-free pending one, which
// keeps its own `before` (the missing-chunk loop guard). A hatch navigation is
// not tried when the server does not answer (asked, not read from
// navigator.onLine: Playwright's WebKit always says false, and true is no
// promise of a network); it stays pending: the next foreground, online edge or
// request decides again. A user action says "You're offline" once per offline
// spell (never on a hide edge); automatic reloads stay silent. A page still alive ALIVE_MS after its navigation (it failed)
// lets that pending navigation be decided again the same way.

export type SelfNavDeps = {
  workerWaiting: () => Promise<boolean>;
  askActivate: () => void;
  hidden: () => boolean;
  // The app server answers right now (a tiny network-routed fetch).
  reachable: () => Promise<boolean>;
  href: () => string;
  // Replace the page with this URL, or reload it (null).
  navigate: (url: string | null) => void;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  // Subscribe to visibility changes and the online edge.
  onEdge: (fn: () => void) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
  notify: (message: string) => void;
};

export type SelfNav = {
  // What this navigation is, for app.log ('update', 'chunk-missing', ...).
  why: string;
  // Where to go, read when it goes; absent: reload this page.
  to?: () => string;
  // Just before navigating (marks, breadcrumbs).
  before?: (at: {waited: number; hidden: boolean; viaNetwork: boolean}) => void;
  // The caller's own hold ('' = none), re-asked on every tick.
  hold?: (waited: number, hidden: boolean) => string;
  // Every tick the caller's hold keeps the navigation.
  onHeld?: (hold: string, waited: number, hidden: boolean) => void;
  // Marks a user action; shown once if a waiting worker holds it ('Signing
  // out…'), so it never looks like it did nothing.
  notice?: string;
  // Delay before the first decision (the update reload shows its toast first).
  firstTickMs?: number;
};

export const WAITING_MAX_MS = 4000; // an asked worker activates in about a second
export const ALIVE_MS = 8000; // a navigation that leaves the page alive this long failed
export const OFFLINE_NOTICE = "You're offline";
const WORKER_TICK_MS = 300;
const HOLD_TICK_MS = 1500; // a caller hold (a draft) ends on a user action

export const NET_NAV_PARAM = 'cyc-net';

// The same URL, routed straight to the network (cyc-sw.js CYC_ROUTE_TABLE).
export function netNavUrl(href: string, base: string): string {
  const url = new URL(href, base);
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
  type Pending = {nav: SelfNav; since: number; waitingSince: number};
  let pending: Pending | null = null;
  let going = false; // navigating; until ALIVE_MS shows the page is still here
  let timer: unknown = null;
  let ticking = false;
  let again = false;
  let subscribed = false;
  let offline = false; // this offline spell is logged
  let toldOffline = false; // and a user action was told
  const later = (ms: number) => {
    if (timer !== null) deps.cancel(timer);
    timer = deps.schedule(() => {
      timer = null;
      void tick();
    }, ms);
  };
  const tick = async (): Promise<void> => {
    if (!pending || going) return;
    if (ticking) {
      again = true; // an edge or a request arrived mid-tick: decide again after
      return;
    }
    ticking = true;
    if (timer !== null) deps.cancel(timer);
    timer = null;
    try {
      const p = pending;
      const {nav} = p;
      const now = deps.now();
      const waited = now - p.since;
      const hidden = deps.hidden();
      const own = nav.hold?.(waited, hidden) ?? '';
      if (own) {
        p.waitingSince = -1;
        nav.onHeld?.(own, waited, hidden);
        return later(HOLD_TICK_MS);
      }
      const waiting = await deps.workerWaiting().catch(() => false);
      if (pending !== p) return;
      if (!waiting) p.waitingSince = -1;
      else if (p.waitingSince < 0) {
        p.waitingSince = now;
        deps.log('nav.held', {why: nav.why, hold: 'sw-waiting'});
        if (nav.notice) deps.notify(nav.notice);
      }
      if (waiting && now - p.waitingSince < WAITING_MAX_MS) {
        deps.askActivate();
        return later(WORKER_TICK_MS);
      }
      const viaNetwork = waiting;
      if (viaNetwork && !(await deps.reachable().catch(() => false))) {
        if (!offline) deps.log('nav.offline', {why: nav.why, waited});
        offline = true;
        if (!toldOffline && nav.notice && !hidden) {
          toldOffline = true;
          deps.notify(OFFLINE_NOTICE);
        }
        return; // still pending: the next edge or request decides again
      }
      offline = toldOffline = false;
      if (pending !== p) return;
      going = true;
      deps.log('nav.go', {why: nav.why, waited, hidden, ...(viaNetwork ? {viaNetwork} : {})});
      nav.before?.({waited, hidden, viaNetwork});
      const to = nav.to?.();
      deps.navigate(viaNetwork ? netNavUrl(to ?? deps.href(), deps.href()) : (to ?? null));
      deps.schedule(() => {
        going = false;
        deps.log('nav.failed', {why: nav.why});
      }, ALIVE_MS);
    } finally {
      ticking = false;
      if (again) {
        again = false;
        void tick();
      }
    }
  };
  return (nav: SelfNav) => {
    if (!subscribed) {
      subscribed = true;
      deps.onEdge(() => void tick());
    }
    if (pending && nav.hold) return void tick();
    pending = {nav, since: deps.now(), waitingSince: -1};
    later(nav.firstTickMs ?? 0);
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
  reachable: () =>
    fetch('/build.txt', {cache: 'no-store', signal: AbortSignal.timeout(3000)}).then(
      (r) => r.ok,
      () => false
    ),
  href: () => location.href,
  navigate: (url) => (url === null ? location.reload() : location.replace(url)),
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  onEdge: (fn) => {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', fn);
    window.addEventListener('online', fn);
  },
  log: (event, fields) => cyclog(event, fields),
  notify: (message) => notifier(message)
};

let gate = createSelfNavGate(realDeps);

/** Navigate this page (reload, replace, assign) through the gate. */
export function navigateSelf(nav: SelfNav): void {
  gate(nav);
}

// Test seam: a fresh page.
export function resetSelfNavForTests(): void {
  gate = createSelfNavGate(realDeps);
}
