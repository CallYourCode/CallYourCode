import {cyclog} from '@/shared/logging';
import {onSyncStatus, syncStatus} from './engine/store';
import {pipeline} from './audio/pipeline';
import {toast} from './components/widgets';
import {unsentWork, vaultHolds} from './sessionState';
import {
  createStaleReloadController,
  parseServedStamp,
  reloadHold,
  CACHE_PREFIX,
  type ReloadHolds
} from './staleReload';
import {markSelfReload, markReloadDeparture, readReloadDeparture} from './shared/selfReload';

export const bundleInfo = {stamp: ''};

declare const __CYC_BUILD__: string;

const RELOAD_MARK_KEY = 'cyc-stale-reload-for';

export function installStaleTabReload(): void {
  const cycBuildStamp = typeof __CYC_BUILD__ !== 'undefined' ? __CYC_BUILD__ : '';
  cyclog('boot', {build: cycBuildStamp || 'dev'});
  bundleInfo.stamp = cycBuildStamp;

  // This boot is main actually starting: clear the index.html watchdog so it
  // never beacons a false "main did not start".
  try {
    window.__cycBootOk?.();
  } catch {
    // the inline watchdog is best-effort; its absence is fine
  }

  // Did we just land from an update reload? The departure breadcrumb names the
  // gap and the builds it crossed. A ~1-2 s gap is a healthy reload; a large
  // gap (the owner force-closing out of a black screen, then relaunching) is
  // the stuck reload naming itself in app.log.
  const departed = readReloadDeparture();
  if (departed)
    cyclog('reload.landed', {
      gap: Date.now() - departed.at,
      from: departed.from,
      to: departed.to,
      hidden: departed.hidden,
      build: cycBuildStamp || 'dev'
    });

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

  const composer = () => document.querySelector('.cyc-composer');
  const recordingNow = () => {
    const i = composer();
    return (
      pipeline.captureBusy ||
      (!!i && (i.hasAttribute('data-cyc-recording') || i.classList.contains('cyc-pressing')))
    );
  };
  const draftInBox = () =>
    !!document.querySelector('.cyc-composer-input')?.textContent?.trim() ||
    !!document.querySelector('.cyc-attach-chip') ||
    !!document.querySelector('.cyc-block-voice');
  const audioPlaying = () => {
    const audio = document.querySelector('audio');
    return !!audio && !audio.paused && !audio.ended;
  };

  const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const pendingWorker = async (): Promise<'' | 'installing' | 'waiting'> => {
    if (!swSupported) return '';
    try {
      const r = await navigator.serviceWorker.getRegistration();
      return r?.installing ? 'installing' : r?.waiting ? 'waiting' : '';
    } catch {
      return '';
    }
  };
  const askActivate = () => {
    if (!swSupported) return;
    void navigator.serviceWorker
      .getRegistration()
      .then((r) => r?.waiting?.postMessage({t: 'skip-waiting'}))
      .catch(() => {});
  };

  const reloadSoon = (target: string) => {
    if (reloading) return;
    reloading = true;
    const since = Date.now();
    // Announce only a reload that is about to happen; one held by a draft
    // comes later, when the box is empty or the app is in the background.
    if (!draftInBox()) toast('New version, reloading…', 2500);
    let lastLogged = 0;
    let timer = 0;
    let ticking = false;
    let again = false;
    let going = false;
    const tick = async (): Promise<void> => {
      if (going) return;
      if (ticking) {
        again = true; // e.g. the background edge arrived mid-tick: decide again
        return;
      }
      ticking = true;
      window.clearTimeout(timer);
      try {
        // Never navigate while a new worker is installing or waiting: in
        // Chromium the navigation can be what triggers the parked activation,
        // and it then hangs (staleReload pendingWorker).
        const pending = await pendingWorker();
        const holds: ReloadHolds = {
          recording: recordingNow(),
          vault: vaultHolds.writing > 0,
          unsent: unsentWork.busy(),
          draft: draftInBox(),
          audio: audioPlaying()
        };
        const waited = Date.now() - since;
        const hidden = document.hidden;
        const hold = reloadHold(holds, waited, hidden) || (pending ? 'sw-' + pending : '');
        if (hold) {
          if (pending === 'waiting') askActivate();
          if (waited - lastLogged >= 15_000) {
            lastLogged = waited;
            cyclog('reload.deferred', {...holds, hold, hidden, waited});
          }
          timer = window.setTimeout(() => {
            void tick();
          }, 3000);
          return;
        }
        going = true;
        cyclog('reload.go', {waited, hidden, from: cycBuildStamp || bootStamp, to: target});
        const url = new URL(location.href);
        url.searchParams.set('b', String(Date.now()));
        markSelfReload();
        markReloadDeparture(cycBuildStamp || bootStamp, target, hidden);
        location.replace(url.toString());
      } finally {
        ticking = false;
        if (again && !going) {
          again = false;
          void tick();
        }
      }
    };
    // Going to the background is the moment a draft stops holding the reload:
    // decide at once, before the page is suspended.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void tick();
    });
    timer = window.setTimeout(() => {
      void tick();
    }, 1200);
  };

  const controller = createStaleReloadController({
    ownStamp: () => cycBuildStamp || bootStamp,
    fetchServedStamp: fetchStamp,
    cacheNames: () =>
      typeof caches !== 'undefined' ? caches.keys().catch((): string[] => []) : Promise.resolve([]),
    // The newest precache bucket really holds index.html (so, atomically, every
    // chunk). Guards the readiness gate against firing a reload onto an empty
    // bucket whose name exists but whose addAll is still in flight or failed.
    shellCached: async () => {
      if (typeof caches === 'undefined') return true;
      try {
        const names = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX)).sort();
        if (!names.length) return true; // no bucket in the way: the network serves it
        const cache = await caches.open(names[names.length - 1]);
        return !!((await cache.match('/index.html')) || (await cache.match('/')));
      } catch {
        return true;
      }
    },
    isControlled: () => swSupported && !!navigator.serviceWorker.controller,
    pendingWorker,
    askActivate,
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
    reload: (target) => reloadSoon(target),
    log: (event, fields) => cyclog(event, fields)
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
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      cyclog('sw.controllerchange', {hasController: !!navigator.serviceWorker.controller});
      controller.onControllerChange();
    });
}
