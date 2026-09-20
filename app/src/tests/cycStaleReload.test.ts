import {describe, expect, test} from 'vitest';
import {
  CACHE_PREFIX,
  createStaleReloadController,
  newestBucketDeliversTarget,
  parseServedStamp,
  READY_POLL_TRIES,
  staleTargetFor,
  type StaleReloadDeps
} from '@/staleReload';

// The stale-tab reload flow: a page compares its own BAKED build stamp against
// the served build.txt and reloads exactly once, and only when the reload
// provably lands on the new build (its precache bucket is the newest, or no
// worker is in the way so the network serves it). Pins the two dangers: a
// reload LOOP (never more than one automatic reload per target stamp, and the
// controllerchange path reloads at most once per page), and a blind reload
// that lands stale again (the readiness gate).

describe('parseServedStamp', () => {
  test('extracts the bare stamp from the build.txt line', () => {
    expect(parseServedStamp('Build stamp: 1756400000\n')).toBe('1756400000');
    expect(parseServedStamp('1756400000')).toBe('1756400000');
    expect(parseServedStamp('  1756400000  ')).toBe('1756400000');
    expect(parseServedStamp('')).toBe('');
    expect(parseServedStamp('\n')).toBe('');
  });
});

describe('staleTargetFor', () => {
  test('stale only when both stamps are known and differ', () => {
    expect(staleTargetFor('100', 'Build stamp: 200\n')).toBe('200');
    expect(staleTargetFor('100', 'Build stamp: 100\n')).toBe('');
    expect(staleTargetFor('', 'Build stamp: 200\n')).toBe(''); // own unknown (dev, pre-boot-read)
    expect(staleTargetFor('100', '')).toBe(''); // fetch failed / offline
  });
});

describe('newestBucketDeliversTarget', () => {
  const b = (s: string) => CACHE_PREFIX + s;
  test('no buckets at all: the network serves the shell, a reload is fresh', () => {
    expect(newestBucketDeliversTarget([], '200')).toBe(true);
    expect(newestBucketDeliversTarget(['some-other-cache'], '200')).toBe(true);
  });
  test('only the old bucket present: a reload would re-serve the old shell', () => {
    expect(newestBucketDeliversTarget([b('100')], '200')).toBe(false);
    expect(newestBucketDeliversTarget([b('100'), b('150')], '200')).toBe(false);
  });
  test('target (or newer) bucket is newest: a reload lands on the new build', () => {
    expect(newestBucketDeliversTarget([b('100'), b('200')], '200')).toBe(true);
    expect(newestBucketDeliversTarget([b('200')], '200')).toBe(true);
    expect(newestBucketDeliversTarget([b('100'), b('300')], '200')).toBe(true);
  });
  test('order of names does not matter, non-precache caches are ignored', () => {
    expect(newestBucketDeliversTarget([b('200'), b('100'), 'cyc-audio'], '200')).toBe(true);
    expect(newestBucketDeliversTarget(['cyc-audio', b('100')], '200')).toBe(false);
  });
});

type Rig = {
  deps: StaleReloadDeps;
  reloads: number;
  nudges: number;
  mark: {value: string};
  scheduled: (() => void)[];
  runScheduled: () => void;
  set: (
    patch: Partial<{own: string; served: string; names: string[]; controlled: boolean}>
  ) => void;
  controller: ReturnType<typeof createStaleReloadController>;
};

function makeRig(init: {
  own?: string;
  served?: string;
  names?: string[];
  controlled?: boolean;
  mark?: string;
  // Storage-blocked device: setItem throws (private mode) ...
  markWriteThrows?: boolean;
  // ... or the page wiring swallowed the error, so the write silently no-ops.
  markWriteNoops?: boolean;
}): Rig {
  const state = {
    own: init.own ?? '100',
    served: init.served ?? 'Build stamp: 200\n',
    names: init.names ?? [],
    controlled: init.controlled ?? false
  };
  const mark = {value: init.mark ?? ''};
  const rig: Rig = {
    reloads: 0,
    nudges: 0,
    mark,
    scheduled: [],
    runScheduled: () => {
      const fns = rig.scheduled.splice(0);
      fns.forEach((fn) => fn());
    },
    set: (patch) => Object.assign(state, patch),
    deps: {
      ownStamp: () => state.own,
      fetchServedStamp: async () => state.served,
      cacheNames: async () => state.names,
      isControlled: () => state.controlled,
      nudgeWorker: () => {
        rig.nudges += 1;
      },
      readMark: () => mark.value,
      writeMark: (t) => {
        if (init.markWriteThrows) throw new Error('storage blocked');
        if (init.markWriteNoops) return;
        mark.value = t;
      },
      schedule: (fn) => rig.scheduled.push(fn),
      reload: () => {
        rig.reloads += 1;
      }
    },
    controller: undefined as unknown as ReturnType<typeof createStaleReloadController>
  };
  rig.controller = createStaleReloadController(rig.deps);
  return rig;
}

// Settle the microtask chain inside check/onControllerChange (each awaits at
// most a couple of already-resolved promises).
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('check, uncontrolled page (no service worker in the way)', () => {
  test('a fresh page never reloads (non-vacuity: same rig, stale stamp, reloads)', async () => {
    const fresh = makeRig({own: '200', served: 'Build stamp: 200\n'});
    await fresh.controller.check();
    expect(fresh.reloads).toBe(0);
    expect(fresh.mark.value).toBe('');

    const stale = makeRig({own: '100', served: 'Build stamp: 200\n'});
    await stale.controller.check();
    expect(stale.reloads).toBe(1);
    expect(stale.mark.value).toBe('200');
  });

  test('at most one automatic reload per target stamp (the mark), a newer build reloads again', async () => {
    const rig = makeRig({own: '100', mark: '200'});
    await rig.controller.check();
    expect(rig.reloads, 'the mark did not stop a second reload for the same stamp').toBe(0);

    // A NEWER build than the marked one: reload again, once.
    const rig2 = makeRig({own: '100', served: 'Build stamp: 300\n', mark: '200'});
    await rig2.controller.check();
    expect(rig2.reloads).toBe(1);
    expect(rig2.mark.value).toBe('300');
  });
});

describe('check, controlled page (cache-first shell)', () => {
  test('nudges the worker and does NOT reload while only the old bucket exists', async () => {
    const rig = makeRig({controlled: true, names: [CACHE_PREFIX + '100']});
    await rig.controller.check();
    await settle();
    expect(rig.nudges).toBe(1);
    expect(rig.reloads, 'a blind reload would land on the stale build again').toBe(0);
    expect(rig.scheduled.length, 'the readiness poll is not waiting').toBe(1);
  });

  test('reloads once the new bucket appears (single reload, mark written)', async () => {
    const rig = makeRig({controlled: true, names: [CACHE_PREFIX + '100']});
    await rig.controller.check();
    await settle();
    expect(rig.reloads).toBe(0);

    rig.set({names: [CACHE_PREFIX + '100', CACHE_PREFIX + '200']}); // install finished
    rig.runScheduled();
    await settle();
    expect(rig.reloads).toBe(1);
    expect(rig.mark.value).toBe('200');

    // Nothing further is scheduled and later edges are inert for this page.
    rig.runScheduled();
    await settle();
    await rig.controller.check();
    await settle();
    expect(rig.reloads).toBe(1);
  });

  test('reloads immediately when the new bucket is already installed', async () => {
    const rig = makeRig({controlled: true, names: [CACHE_PREFIX + '100', CACHE_PREFIX + '200']});
    await rig.controller.check();
    await settle();
    expect(rig.reloads).toBe(1);
  });

  test('poll gives up after its tries and a later edge re-enters (no infinite poll)', async () => {
    const rig = makeRig({controlled: true, names: [CACHE_PREFIX + '100']});
    await rig.controller.check();
    await settle();
    for (let i = 0; i < READY_POLL_TRIES + 5; i++) {
      rig.runScheduled();
      await settle();
    }
    expect(rig.reloads).toBe(0);
    expect(rig.scheduled.length, 'the poll never stopped').toBe(0);

    // A later visibility/live edge starts over (still no reload while stale-unready).
    await rig.controller.check();
    await settle();
    expect(rig.nudges).toBe(2);
    expect(rig.scheduled.length).toBe(1);
  });

  test('the mark also bounds the controlled path to one reload per stamp', async () => {
    const rig = makeRig({
      controlled: true,
      names: [CACHE_PREFIX + '100', CACHE_PREFIX + '200'],
      mark: '200'
    });
    await rig.controller.check();
    await settle();
    expect(rig.reloads).toBe(0);
  });
});

describe('storage-blocked device (the mark cannot persist): check path never auto-reloads', () => {
  // The compound failure behind the residual reload loop: sessionStorage is
  // blocked (the mark never persists across reloads) AND the dist stays
  // half-swapped (every reload lands stale again). Each load would then pass
  // the readMark guard and auto-reload, forever. Verify-after-write closes it:
  // the check path reloads only when the mark provably persisted. The page
  // stays stale but stable, and a manual reload still works.

  test('mark write THROWS, uncontrolled page: no auto-reload, even across repeated checks', async () => {
    const rig = makeRig({markWriteThrows: true});
    await rig.controller.check();
    expect(rig.reloads, 'reloaded with no persisted mark: the loop is open').toBe(0);

    // Simulate the loop driver: further edges (each a fresh load would look
    // exactly like this) still never reload.
    await rig.controller.check();
    await rig.controller.check();
    expect(rig.reloads).toBe(0);
  });

  test('mark write THROWS, controlled page with the new bucket ready: no auto-reload', async () => {
    const rig = makeRig({
      markWriteThrows: true,
      controlled: true,
      names: [CACHE_PREFIX + '100', CACHE_PREFIX + '200']
    });
    await rig.controller.check();
    await settle();
    expect(rig.reloads).toBe(0);
    expect(rig.scheduled.length, 'suppression must end the poll, not spin it').toBe(0);
  });

  test('mark write silently does NOT persist (no-op setItem): same suppression', async () => {
    const rig = makeRig({markWriteNoops: true});
    await rig.controller.check();
    expect(rig.reloads).toBe(0);
    expect(rig.mark.value).toBe('');

    const controlled = makeRig({
      markWriteNoops: true,
      controlled: true,
      names: [CACHE_PREFIX + '200']
    });
    await controlled.controller.check();
    await settle();
    expect(controlled.reloads).toBe(0);
  });

  test('non-vacuity: the same rigs with working storage reload exactly once', async () => {
    const rig = makeRig({});
    await rig.controller.check();
    expect(rig.reloads).toBe(1);
    expect(rig.mark.value).toBe('200');

    const controlled = makeRig({controlled: true, names: [CACHE_PREFIX + '200']});
    await controlled.controller.check();
    await settle();
    expect(controlled.reloads).toBe(1);
  });

  test('controllerchange still heals once with storage blocked (in-memory flag bounds it)', async () => {
    const rig = makeRig({
      markWriteThrows: true,
      controlled: true,
      names: [CACHE_PREFIX + '200']
    });
    rig.controller.onControllerChange();
    await settle();
    expect(rig.reloads, 'the loop-safe heal path must not be suppressed').toBe(1);

    // And still at most once per page life, storage or not.
    rig.controller.onControllerChange();
    await settle();
    expect(rig.reloads).toBe(1);
  });
});

describe('onControllerChange (a new worker activated under the page)', () => {
  test('stale + new bucket installed: reloads, bypassing a spent mark', async () => {
    // The mark was spent by an earlier reload that raced the install and landed
    // stale; the activation is the evidence this reload will not.
    const rig = makeRig({
      controlled: true,
      names: [CACHE_PREFIX + '100', CACHE_PREFIX + '200'],
      mark: '200'
    });
    rig.controller.onControllerChange();
    await settle();
    expect(rig.reloads).toBe(1);
  });

  test('reloads at most ONCE per page life, never a loop', async () => {
    const rig = makeRig({controlled: true, names: [CACHE_PREFIX + '200']});
    rig.controller.onControllerChange();
    await settle();
    rig.controller.onControllerChange();
    rig.controller.onControllerChange();
    await settle();
    expect(rig.reloads, 'controllerchange reloaded more than once').toBe(1);
  });

  test('a fresh page ignores the event (first-ever claim, re-registration)', async () => {
    const rig = makeRig({own: '200', served: 'Build stamp: 200\n', controlled: true});
    rig.controller.onControllerChange();
    await settle();
    expect(rig.reloads).toBe(0);
  });

  test('stale but the new bucket is not the newest: no reload (would land stale)', async () => {
    const rig = makeRig({controlled: true, names: [CACHE_PREFIX + '100']});
    rig.controller.onControllerChange();
    await settle();
    expect(rig.reloads).toBe(0);
  });

  test('does not double-reload a page whose check already fired', async () => {
    const rig = makeRig({controlled: true, names: [CACHE_PREFIX + '200']});
    await rig.controller.check();
    await settle();
    expect(rig.reloads).toBe(1);
    rig.controller.onControllerChange();
    await settle();
    expect(rig.reloads).toBe(1);
  });
});
