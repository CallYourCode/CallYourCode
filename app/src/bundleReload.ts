import {cyclog} from '@/shared/logging';
import {onSyncStatus, syncStatus} from './engine/store';
import {pipeline} from './audio/pipeline';
import {toast} from './components/widgets';
import {unsentWork, vaultHolds} from './sessionState';
import {createStaleReloadController, parseServedStamp} from './staleReload';
import {markSelfReload} from './shared/selfReload';

export const bundleInfo = {stamp: ''};

declare const __CYC_BUILD__: string;

const RELOAD_MARK_KEY = 'cyc-stale-reload-for';

export function installStaleTabReload(): void {
  const cycBuildStamp = typeof __CYC_BUILD__ !== 'undefined' ? __CYC_BUILD__ : '';
  cyclog('boot', {build: cycBuildStamp || 'dev'});
  bundleInfo.stamp = cycBuildStamp;

  let bootStamp = '';
  let reloading = false;
  const fetchStamp = () =>
    fetch('./build.txt', {cache: 'no-store'})
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => '');
  // Dev bundles carry no baked stamp; there the first build.txt stamp read at
  // boot stands in as the page's own identity (read the first time the sync is
  // live; a stamp that came back empty is asked for again on the next live
  // edge). In production the BAKED stamp is the identity: a page that was
  // itself served stale (the cache-first shell racing a new worker's install)
  // must not adopt the server's newer stamp as its own.
  const readBootStamp = () =>
    fetchStamp().then((s) => {
      if (bootStamp) return;
      bootStamp = parseServedStamp(s);
      if (!bundleInfo.stamp) bundleInfo.stamp = bootStamp;
    });
  onSyncStatus((st) => {
    if (st === 'live' && !bootStamp) void readBootStamp();
  });
  if (syncStatus() === 'live') void readBootStamp();

  const busy = () => {
    const input = document.querySelector('.cyc-composer');
    if (input?.hasAttribute('data-cyc-recording') || input?.classList.contains('cyc-pressing'))
      return true;
    const typed = document.querySelector('.cyc-composer-input')?.textContent?.trim();
    if (typed) return true;

    if (document.querySelector('.cyc-attach-chip')) return true;

    if (document.querySelector('.cyc-block-voice')) return true;
    const audio = document.querySelector('audio');
    if (audio && !audio.paused && !audio.ended) return true;
    if (unsentWork.busy()) return true;
    return false;
  };

  const RELOAD_PATIENCE_MS = 45_000;
  /* The hard ceiling on every hold except a live recording. vaultHolds and
   * unsentWork used to defer FOREVER: one stuck hold (a failed transfer that
   * never settled) meant the toast showed and the reload silently never came
   * (2026-09-06 report). Unsent intents are durable (IndexedDB) and survive
   * the reload, so past this ceiling waiting protects nothing. A recording in
   * progress is the one hold that genuinely cannot be reloaded away. */
  const RELOAD_CEILING_MS = 5 * 60_000;
  const reloadSoon = () => {
    if (reloading) return;
    reloading = true;
    const since = Date.now();
    toast('New version, reloading…', 2500);
    let lastLogged = 0;
    const tick = () => {
      const recording =
        pipeline.captureBusy ||
        (() => {
          const i = document.querySelector('.cyc-composer');
          return (
            !!i && (i.hasAttribute('data-cyc-recording') || i.classList.contains('cyc-pressing'))
          );
        })();

      const holds = {
        recording,
        vault: vaultHolds.writing > 0,
        unsent: unsentWork.busy(),
        busy: busy()
      };
      const waited = Date.now() - since;
      const cannotLose = holds.recording || holds.vault || holds.unsent;
      const defer = recording
        ? true // a live recording waits as long as it runs
        : (cannotLose && waited < RELOAD_CEILING_MS) ||
          (holds.busy && waited < RELOAD_PATIENCE_MS);
      if (defer) {
        if (waited - lastLogged >= 15_000) {
          lastLogged = waited;
          cyclog('reload.deferred', {...holds, waited});
        }
        window.setTimeout(tick, 3000);
        return;
      }

      cyclog('reload.go', {waited});
      const url = new URL(location.href);
      url.searchParams.set('b', String(Date.now()));
      markSelfReload();
      location.replace(url.toString());
    };
    window.setTimeout(tick, 1200);
  };

  const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const controller = createStaleReloadController({
    ownStamp: () => cycBuildStamp || bootStamp,
    fetchServedStamp: fetchStamp,
    cacheNames: () =>
      typeof caches !== 'undefined' ? caches.keys().catch((): string[] => []) : Promise.resolve([]),
    isControlled: () => swSupported && !!navigator.serviceWorker.controller,
    nudgeWorker: () => {
      if (!swSupported) return;
      try {
        void navigator.serviceWorker
          .getRegistration()
          .then((r) => r?.update())
          .catch(() => {});
      } catch {
        // best effort only
      }
    },
    readMark: () => {
      try {
        return sessionStorage.getItem(RELOAD_MARK_KEY) ?? '';
      } catch {
        return '';
      }
    },
    writeMark: (target) => {
      try {
        sessionStorage.setItem(RELOAD_MARK_KEY, target);
      } catch {
        // storage may be unavailable; the controller's own flags still bound reloads
      }
    },
    schedule: (fn, ms) => void window.setTimeout(fn, ms),
    reload: reloadSoon
  });

  // A stamp check is a fetch: only while the sync is live (offline design v2,
  // section 7).
  const check = () => {
    if (syncStatus() !== 'live') return Promise.resolve();
    return controller.check();
  };

  // No idle timer: a new build only matters the next time this tab is looked at
  // or the next time the sync comes back live. Both are edges, so the check
  // rides them instead of a 20 s poll that ran while nothing was on screen.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void check();
  });
  onSyncStatus((st) => {
    if (st === 'live' && !document.hidden) void check();
  });

  // A new worker activating under this page is the one reliable "the new build
  // is installed" edge (it fires even when the page landed stale off a reload
  // that raced the install). The handler verifies staleness itself with a
  // single fetch, so it is not behind the live gate: offline the fetch fails
  // and nothing happens.
  if (swSupported)
    navigator.serviceWorker.addEventListener('controllerchange', controller.onControllerChange);
}
