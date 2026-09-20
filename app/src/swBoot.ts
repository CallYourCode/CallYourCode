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

const SW_URL = '/cyc-sw.js';

export function registerOfflineWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register(SW_URL, {scope: '/'}).catch(() => {});
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, {once: true});
}
