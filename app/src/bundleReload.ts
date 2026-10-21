import {cyclog} from '@/shared/logging';
import {onSyncStatus} from './engine/store';
import {pipeline} from './audio/pipeline';
import {toast} from './components/widgets';
import {unsentWork, vaultHolds} from './sessionState';
import {createStaleReloadController, parseServedStamp, CACHE_PREFIX} from './staleReload';
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
      build: cycBuildStamp || 'dev'
    });

  let bootStamp = '';
  let reloading = false;
  const fetchStamp = () =>
    fetch('./build.txt', {cache: 'no-store'})
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => '');
  // Dev bundles carry no baked stamp; there the first build.txt stamp read at
  // boot stands in as the page's own identity (an empty read is retried on
  // the next check). In production the BAKED stamp is the identity: a page that was
  // itself served stale (the cache-first shell racing a new worker's install)
  // must not adopt the server's newer stamp as its own.
  const readBootStamp = () =>
    fetchStamp().then((s) => {
      if (bootStamp) return;
      bootStamp = parseServedStamp(s);
      if (!bundleInfo.stamp) bundleInfo.stamp = bootStamp;
    });

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
  // Vault writes keep their existing ceiling. Recordings and unsent work
  // must settle before an update reload, even when the engine is unreachable.
  const RELOAD_CEILING_MS = 5 * 60_000;
  const reloadSoon = (target: string) => {
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
      const defer =
        holds.recording ||
        holds.unsent ||
        (holds.vault && waited < RELOAD_CEILING_MS) ||
        (holds.busy && waited < RELOAD_PATIENCE_MS);
      if (defer) {
        if (waited - lastLogged >= 15_000) {
          lastLogged = waited;
          cyclog('reload.deferred', {...holds, waited});
        }
        window.setTimeout(tick, 3000);
        return;
      }

      cyclog('reload.go', {waited, from: cycBuildStamp || bootStamp, to: target});
      const url = new URL(location.href);
      url.searchParams.set('b', String(Date.now()));
      markSelfReload();
      markReloadDeparture(cycBuildStamp || bootStamp, target);
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
    reload: (target) => reloadSoon(target)
  });

  // Static build discovery uses HTTP, not engine sync. A transport-incompatible
  // installed page must still be able to discover its replacement at boot and
  // on foreground. Only dev needs to learn its own identity from the server.
  const check = async () => {
    if (!cycBuildStamp && !bootStamp) await readBootStamp();
    await controller.check();
  };
  void check();

  // No idle timer: boot, foreground and live edges are enough.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void check();
  });
  onSyncStatus((st) => {
    if (st === 'live' && !document.hidden) void check();
  });

  // A new worker activating under this page is the one reliable "the new build
  // is installed" edge (it fires even when the page landed stale off a reload
  // that raced the install). The handler verifies staleness itself with a
  // single HTTP fetch: offline the fetch fails and nothing happens.
  if (swSupported)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      cyclog('sw.controllerchange', {hasController: !!navigator.serviceWorker.controller});
      controller.onControllerChange();
    });
}
