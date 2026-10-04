import {describe, expect, test} from 'vitest';
import {
  ALIVE_MS,
  createSelfNavGate,
  OFFLINE_NOTICE,
  WAITING_MAX_MS,
  type SelfNavDeps
} from '@/shared/selfReload';

// The one self-navigation gate (shared/selfReload.ts). Every navigation the
// app does to itself goes through it, because in Chromium a navigation that
// triggers a parked worker activation is dispatched to the old worker as it is
// stopped and never completes (the hung reload, 2026-10-03). ONE rule: a
// WAITING worker is asked to take over and holds the navigation; still waiting
// WAITING_MAX_MS later, the navigation goes to the same URL with ?cyc-net=1
// (network, never the parked worker). An INSTALLING worker never holds. A
// navigation that leaves the page alive (failed) releases the gate; offline, a
// network navigation is not tried, the user is told.

const HERE = 'https://app.example/?chat=x#app';

function rig(init: {waiting?: boolean; online?: boolean} = {}) {
  const st = {waiting: init.waiting ?? false, hidden: false, online: init.online ?? true, now: 0};
  let timers: {at: number; fn: () => void}[] = [];
  const hiddenSubs = new Set<() => void>();
  const r = {
    st,
    asks: 0,
    said: [] as string[],
    went: [] as (string | null)[],
    logs: [] as [string, Record<string, unknown>][],
    // advance the clock, running each timer when it falls due
    async step(ms = 300) {
      const until = st.now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        st.now = Math.max(st.now, due.at);
        due.fn();
        await new Promise((x) => setTimeout(x, 0));
      }
      st.now = until;
    },
    background() {
      st.hidden = true;
      hiddenSubs.forEach((f) => f());
    },
    subs: hiddenSubs,
    events: () => r.logs.map(([e]) => e),
    deps: {
      workerWaiting: async () => st.waiting,
      askActivate: () => void r.asks++,
      hidden: () => st.hidden,
      reachable: async () => st.online,
      href: () => HERE,
      navigate: (url) => void r.went.push(url),
      now: () => st.now,
      schedule: (fn, ms) => {
        const t = {at: st.now + ms, fn};
        timers.push(t);
        return t;
      },
      cancel: (h) => void (timers = timers.filter((t) => t !== h)),
      onHidden: (fn) => {
        hiddenSubs.add(fn);
        return () => void hiddenSubs.delete(fn);
      },
      log: (e, f) => void r.logs.push([e, f]),
      notify: (m) => void r.said.push(m)
    } satisfies SelfNavDeps
  };
  return r;
}

describe('self-navigation gate', () => {
  test('nothing waiting: goes on the first tick (reload, or the caller URL)', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    let before = 0;
    gate({why: 'chunk-missing', before: () => void before++});
    await r.step();
    expect(r.went).toEqual([null]);
    expect(before).toBe(1);
    expect(r.logs[0]).toEqual(['nav.go', {why: 'chunk-missing', waited: 0, hidden: false}]);
    expect(r.subs.size, 'the background listener was not removed').toBe(0);
    expect(r.said).toEqual([]);
  });

  test('a waiting worker is asked to take over and holds; it does, the page goes normally', async () => {
    const r = rig({waiting: true});
    const gate = createSelfNavGate(r.deps);
    gate({why: 'sign-out', notice: 'Signing out…', to: () => '/'});
    await r.step();
    await r.step();
    expect(r.went, 'navigated into a waiting worker').toEqual([]);
    expect(r.asks).toBeGreaterThanOrEqual(1);
    expect(r.logs[0]).toEqual(['nav.held', {why: 'sign-out', hold: 'sw-waiting'}]);
    expect(r.said).toEqual(['Signing out…']);
    r.st.waiting = false;
    await r.step();
    expect(r.went).toEqual(['/']);
  });

  // One rule for every caller: the update and missing-chunk reloads used to
  // hold until Chromium's own activation (up to 300 s on a lost ask).
  test('still waiting past the bound: every self-navigation goes via the network hatch', async () => {
    for (const why of ['update', 'chunk-missing', 'sign-out']) {
      const r = rig({waiting: true});
      const gate = createSelfNavGate(r.deps);
      gate({why, to: why === 'sign-out' ? () => '/' : undefined});
      await r.step(WAITING_MAX_MS - 300);
      expect(r.went, why).toEqual([]);
      await r.step(1000);
      expect(r.went, why).toEqual([
        why === 'sign-out'
          ? 'https://app.example/?cyc-net=1'
          : 'https://app.example/?chat=x&cyc-net=1#app'
      ]);
      expect(r.logs.find(([e]) => e === 'nav.go')?.[1]).toMatchObject({why, viaNetwork: true});
    }
  });

  test('an installing worker never holds a navigation (the probe says not waiting)', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    gate({why: 'clear-data'});
    await r.step();
    expect(r.went).toEqual([null]);
    expect(r.asks).toBe(0);
  });

  // Offline + a worker waiting (WebKit silently failed the network navigation
  // and the gate stayed spent: a second sign-out did nothing).
  test('offline: the hatch is not tried, the user is told, and a second attempt still works', async () => {
    const r = rig({waiting: true, online: false});
    const gate = createSelfNavGate(r.deps);
    gate({why: 'sign-out', notice: 'Signing out…', to: () => '/'});
    await r.step(WAITING_MAX_MS + 600);
    expect(r.went).toEqual([]);
    expect(r.said).toEqual(['Signing out…', OFFLINE_NOTICE]);
    expect(r.events()).toContain('nav.offline');
    expect(r.subs.size).toBe(0);
    r.st.online = true;
    gate({why: 'sign-out', to: () => '/'});
    await r.step(WAITING_MAX_MS + 600);
    expect(r.went).toEqual(['https://app.example/?cyc-net=1']);
  });

  test('a navigation that leaves the page alive releases the gate', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    gate({why: 'sign-out', to: () => '/'});
    await r.step();
    expect(r.went).toEqual(['/']);
    // still here: a second request stands down until the attempt is known failed
    gate({why: 'sign-out', to: () => '/'});
    await r.step();
    expect(r.went).toEqual(['/']);
    r.st.online = false;
    await r.step(ALIVE_MS);
    expect(r.events()).toContain('nav.failed');
    expect(r.said).toEqual([OFFLINE_NOTICE]);
    gate({why: 'sign-out', to: () => '/'});
    await r.step();
    expect(r.went).toEqual(['/', '/']);
  });

  test('a caller hold (a draft) holds until it clears, then the worker rule applies', async () => {
    const r = rig({waiting: true});
    const gate = createSelfNavGate(r.deps);
    let draft = true;
    const held: string[] = [];
    gate({why: 'update', hold: () => (draft ? 'draft' : ''), onHeld: (h) => held.push(h)});
    await r.step(60_000);
    expect(r.went).toEqual([]);
    expect(held.length).toBeGreaterThan(1);
    expect(r.asks, 'asked while the draft held').toBe(0);
    draft = false;
    await r.step(1000);
    expect(r.went, 'the draft time counted against the worker bound').toEqual([]);
    r.st.waiting = false;
    await r.step(2000);
    expect(r.went).toEqual([null]);
  });

  test('the background edge decides at once, without waiting for a tick', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    gate({
      why: 'update',
      hold: (_w, hidden) => (hidden ? '' : 'draft'),
      before: ({hidden}) => expect(hidden).toBe(true)
    });
    await r.step();
    expect(r.went).toEqual([]);
    r.background();
    await new Promise((x) => setTimeout(x, 0));
    expect(r.went).toEqual([null]);
  });

  test('one self-navigation at a time: a second request stands down', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    gate({why: 'chunk-missing'});
    gate({why: 'update', to: () => '/x'});
    await r.step();
    await r.step();
    expect(r.went.length).toBe(1);
  });
});
