// Stale-tab detection and the single-reload update flow, as a pure module with
// injected dependencies so bundleReload can wire it to the real page and the
// tests can drive it hermetically (no DOM, no timers, no CacheStorage).
//
// Why this exists: the service worker serves the app shell cache-first from the
// newest cyc-precache-<stamp> bucket. On the first reload after a new build the
// navigation is answered by the OLD worker from the OLD bucket while the new
// worker is still installing (the browser's update check races the navigation),
// so that reload lands on the stale build. The old flow then read build.txt as
// its own identity, saw the new stamp, and certified the stale page as current;
// only a second manual reload delivered the update. The flow here compares the
// page's own BAKED stamp against the served build.txt, and only reloads once a
// reload provably lands on the new build.

// The served build.txt is a line like "Build stamp: 1756400000"; the baked
// stamp is the bare number. Reduce both to the bare stamp before comparing.
export function parseServedStamp(text: string): string {
  const t = String(text ?? '').trim();
  if (!t) return '';
  const parts = t.split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

// The build the server is on, when it differs from the one this page runs.
// Empty string means "not stale" (also when either side is unknown).
export function staleTargetFor(own: string, served: string): string {
  const s = parseServedStamp(served);
  if (!own || !s || s === own) return '';
  return s;
}

export const CACHE_PREFIX = 'cyc-precache-';

// True when a reload is guaranteed to land on the target build (or newer): the
// newest precache bucket is the target's, so the worker's shell serve (newest
// bucket, network on a cache miss) cannot hand back the old shell again. No
// buckets at all means the shell comes straight from the network: also fresh.
// Build stamps are 10-digit epoch seconds, so lexical order is numeric order.
export function newestBucketDeliversTarget(names: string[], target: string): boolean {
  const buckets = names.filter((n) => n.startsWith(CACHE_PREFIX)).sort();
  if (!buckets.length) return true;
  return buckets[buckets.length - 1] >= CACHE_PREFIX + target;
}

export const READY_POLL_MS = 500;
export const READY_POLL_TRIES = 30; // 15s per stale sighting; the next edge re-arms

export type StaleReloadDeps = {
  // The page's own build stamp: the baked __CYC_BUILD__, or in dev (no baked
  // stamp) the first build.txt stamp read at boot.
  ownStamp: () => string;
  // Raw build.txt text (or '' on any failure).
  fetchServedStamp: () => Promise<string>;
  // caches.keys() (or [] where CacheStorage is unavailable).
  cacheNames: () => Promise<string[]>;
  // Whether a service worker currently controls this page.
  isControlled: () => boolean;
  // registration.update(): force the worker update check without a navigation.
  nudgeWorker: () => void;
  // The once-per-target-stamp reload mark (sessionStorage in the real page).
  readMark: () => string;
  writeMark: (target: string) => void;
  // setTimeout seam for the readiness poll.
  schedule: (fn: () => void, ms: number) => void;
  // The busy-aware reload (bundleReload's reloadSoon: toast, patience, replace).
  reload: () => void;
};

export function createStaleReloadController(deps: StaleReloadDeps): {
  check: () => Promise<void>;
  onControllerChange: () => void;
} {
  let fired = false; // a reload is committed for this page's lifetime
  let polling = false; // a readiness poll is in flight
  let controllerReloadUsed = false; // controllerchange reloads at most ONCE per page

  const ready = async (target: string): Promise<boolean> => {
    try {
      return newestBucketDeliversTarget(await deps.cacheNames(), target);
    } catch {
      return true;
    }
  };

  // Verify-after-write on the once-per-stamp mark. writeMark may throw
  // (storage blocked) or silently not persist (the page wiring swallows the
  // error); either way readMark will not return the target, and that is the
  // truth that matters: without a persisted mark the per-stamp loop guard is
  // gone across reloads.
  const persistMark = (target: string): boolean => {
    try {
      deps.writeMark(target);
    } catch {
      return false;
    }
    try {
      return deps.readMark() === target;
    } catch {
      return false;
    }
  };

  // Check-path commit: reload ONLY when the mark provably persisted. If it
  // cannot (private mode, storage blocked) an auto-reload here could loop
  // against a persistently half-swapped dist (every reload lands stale, and
  // with no mark every load would reload again). Suppressed, the page stays
  // on the build it has: stale but stable, and a manual reload still works.
  const fireChecked = (target: string): void => {
    if (fired) return;
    if (!persistMark(target)) return;
    fired = true;
    deps.reload();
  };

  // Controllerchange commit: loop-safe without storage (controllerReloadUsed
  // bounds it to once per page life), so the mark write is best effort only.
  const fire = (target: string): void => {
    if (fired) return;
    fired = true;
    try {
      deps.writeMark(target);
    } catch {
      // best effort; controllerReloadUsed already bounds this path
    }
    deps.reload();
  };

  // Ridden by the page's visibility/live edges (the caller keeps its own
  // "only while the sync is live" gate around this).
  const check = async (): Promise<void> => {
    if (fired || polling) return;
    const target = staleTargetFor(deps.ownStamp(), await deps.fetchServedStamp());
    if (!target || fired || polling) return;

    if (!deps.isControlled()) {
      // No worker in the way: a reload is served by the network, so it lands
      // fresh. The once-per-stamp mark is the loop guard for the pathological
      // half-swapped dist where build.txt and the served bundle disagree.
      if (deps.readMark() === target) return;
      fireChecked(target);
      return;
    }

    // A worker serves the shell cache-first: force its update check now (no
    // navigation needed), then reload only once a reload provably lands on the
    // new build. A blind reload here would re-serve the old shell and land the
    // user on the stale build a second time.
    deps.nudgeWorker();
    if (deps.readMark() === target) return; // already auto-reloaded once for this build
    polling = true;
    let tries = READY_POLL_TRIES;
    const poll = (): void => {
      void ready(target).then((ok) => {
        if (fired) {
          polling = false;
          return;
        }
        if (ok) {
          polling = false;
          fireChecked(target);
          return;
        }
        tries -= 1;
        if (tries <= 0) {
          polling = false; // give up; the next visibility/live edge re-enters
          return;
        }
        deps.schedule(poll, READY_POLL_MS);
      });
    };
    poll();
  };

  // A new worker took control mid-life: its install (new bucket) completed
  // before it activated, so a reload lands fresh. Verified, not assumed: the
  // reload happens only if the page really is stale and the newest bucket
  // really delivers the target. Guarded to at most one reload per page life,
  // and each further event would need yet another new build's activation, so
  // this can never loop. It bypasses the once-per-stamp mark on purpose: the
  // mark may have been spent by an earlier reload that raced the install and
  // landed stale; the activation is the signal that this one will not.
  const onControllerChange = (): void => {
    if (controllerReloadUsed || fired) return;
    void (async () => {
      const target = staleTargetFor(deps.ownStamp(), await deps.fetchServedStamp());
      if (!target || controllerReloadUsed || fired) return;
      if (!(await ready(target))) return;
      controllerReloadUsed = true;
      fire(target);
    })();
  };

  return {check, onControllerChange};
}
