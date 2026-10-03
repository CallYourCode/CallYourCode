// Registers the offline precache worker (app/public/cyc-sw.js) at boot so the
// app can cold-start with no network: the worker precaches the app shell and
// every hashed chunk this build produced and serves them cache-first, while
// passing all other traffic (API, websocket, sealed push, uploads, transfers,
// cross-origin) straight through. The push path (pushNotify.ensureWorker) also
// registers the same worker when notifications are enabled; registering here as
// well is a no-op the second time, but it means precaching no longer waits for
// a user to turn push on.
//
// Best-effort and guarded: an unsupported browser or a failed registration
// never blocks boot, and there is no reload on its own. The stamp-named precache
// cache plus the worker's activate cleanup are what make a new build win, so
// this does not fight bundleReload's "new version, reload" flow. Registration is
// deferred to the load event so the first paint and its own asset fetches are
// never in contention with the worker's initial precache addAll.

import {cyclog} from '@/shared/logging';
import {CACHE_PREFIX} from './staleReload';

const SW_URL = '/cyc-sw.js';

// Each precache bucket's build stamp and whether it really holds the shell,
// newest first ("1791024576:shell 1790946436:shell"). A worker that serves an
// older build than the newest bucket name, or a bucket with no shell, is then
// visible in app.log at every boot instead of only inferable.
async function bucketsLine(): Promise<string> {
  if (typeof caches === 'undefined') return 'none';
  try {
    const names = (await caches.keys())
      .filter((n) => n.startsWith(CACHE_PREFIX))
      .sort()
      .reverse();
    const parts: string[] = [];
    for (const n of names) {
      const cache = await caches.open(n);
      const shell = !!((await cache.match('/index.html')) || (await cache.match('/')));
      parts.push(`${n.slice(CACHE_PREFIX.length)}:${shell ? 'shell' : 'empty'}`);
    }
    return parts.join(' ') || 'none';
  } catch {
    return 'unreadable';
  }
}

// Name the worker lifecycle in app.log so a stuck update (a new build that
// installs but never finishes taking over, the black-screen suspect on iOS)
// leaves a trail instead of a silent hole. No timers: these are edges the
// browser already fires (register result, a found update's state changes). A
// failed install shows as sw.statechange state=redundant.
function logSwState(reg: ServiceWorkerRegistration): void {
  const state = (w: ServiceWorker | null) => w?.state ?? 'none';
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    cyclog('sw.updatefound', {state: state(w)});
    w?.addEventListener('statechange', () => cyclog('sw.statechange', {state: state(w)}));
  });
  const at = {
    controlled: !!navigator.serviceWorker.controller,
    installing: state(reg.installing),
    waiting: state(reg.waiting),
    active: state(reg.active)
  };
  void bucketsLine().then((buckets) => cyclog('sw.state', {...at, buckets}));
}

export function registerOfflineWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register(SW_URL, {scope: '/'}).then(
      (reg) => {
        try {
          logSwState(reg);
        } catch {
          // logging must never break registration
        }
      },
      () => {}
    );
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, {once: true});
}
