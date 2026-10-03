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
// It never navigates while a new service worker is installing or waiting: in
// Chromium a navigation can be what triggers a parked activation (a request
// restarted the old worker mid-swap), it is dispatched to the old worker as
// that worker is stopped, and it never completes: the page hangs blank
// (proven 2026-10-03, sw-activation-race / sw-chunk-reload specs). Installing
// settles by itself in seconds; a waiting worker is asked to take over
// ({t: 'skip-waiting'}, cyc-sw.js) and Chromium otherwise activates it once
// the old worker idles. A caller may add its own hold (the update reload's
// composer hold); the gate re-decides on every tick and at once when the app
// goes to the background.

export type PendingWorker = '' | 'installing' | 'waiting';

export type SelfNavDeps = {
  pendingWorker: () => Promise<PendingWorker>;
  askActivate: () => void;
  hidden: () => boolean;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  // Subscribe to the app going to the background; returns the unsubscribe.
  onHidden: (fn: () => void) => () => void;
  log: (event: string, fields: Record<string, unknown>) => void;
};

export type SelfNav = {
  // What this navigation is, for app.log ('update', 'chunk-missing', ...).
  why: string;
  // Navigate. Called exactly once, when nothing holds the navigation.
  go: (at: {waited: number; hidden: boolean}) => void;
  // The caller's own hold ('' = none), re-asked on every tick.
  hold?: (waited: number, hidden: boolean) => string;
  // Every tick the navigation stays held (the caller's or the worker's hold).
  onHeld?: (hold: string, waited: number, hidden: boolean) => void;
  // Delay before the first decision (the update reload shows its toast first).
  firstTickMs?: number;
};

const WORKER_TICK_MS = 400; // an activation takes milliseconds, an install seconds
const HOLD_TICK_MS = 1500; // a caller hold (a draft) ends on a user action
const ASK_EVERY_MS = 2000;
const LOG_EVERY_MS = 15_000;

export function createSelfNavGate(deps: SelfNavDeps): (nav: SelfNav) => void {
  let gone = false; // one self-navigation per page life wins; the rest stand down
  return (nav: SelfNav) => {
    const since = deps.now();
    let timer: unknown = null;
    let ticking = false;
    let again = false;
    let lastAsk = -Infinity;
    let lastLog = -Infinity;
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
        const pending = await deps.pendingWorker().catch((): PendingWorker => '');
        if (gone) return off();
        const waited = deps.now() - since;
        const hidden = deps.hidden();
        if (pending === 'waiting' && waited - lastAsk >= ASK_EVERY_MS) {
          lastAsk = waited;
          deps.askActivate();
        }
        const own = nav.hold?.(waited, hidden) ?? '';
        const hold = own || (pending ? 'sw-' + pending : '');
        if (hold) {
          if (!own && waited - lastLog >= LOG_EVERY_MS) {
            lastLog = waited;
            deps.log('nav.held', {why: nav.why, hold, waited});
          }
          nav.onHeld?.(hold, waited, hidden);
          timer = deps.schedule(() => void tick(), pending ? WORKER_TICK_MS : HOLD_TICK_MS);
          return;
        }
        gone = true;
        off();
        deps.log('nav.go', {why: nav.why, waited, hidden});
        nav.go({waited, hidden});
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

export async function pendingWorker(): Promise<PendingWorker> {
  if (!swSupported()) return '';
  try {
    const r = await navigator.serviceWorker.getRegistration();
    return r?.installing ? 'installing' : r?.waiting ? 'waiting' : '';
  } catch {
    return '';
  }
}

export function askActivate(): void {
  if (!swSupported()) return;
  void navigator.serviceWorker
    .getRegistration()
    .then((r) => r?.waiting?.postMessage({t: 'skip-waiting'}))
    .catch(() => {});
}

const realDeps: SelfNavDeps = {
  pendingWorker,
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
  log: (event, fields) => cyclog(event, fields)
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
