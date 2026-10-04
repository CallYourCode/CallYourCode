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
// (network, never the parked worker). An INSTALLING worker never holds. The
// gate owns the one pending navigation: offline it is not tried (the user is
// told) and stays pending until the next edge or request; a navigation that
// leaves the page alive (failed) is decided again the same way.

const HERE = 'https://app.example/?chat=x#app';

function rig(init: {waiting?: boolean; online?: boolean} = {}) {
  const st = {waiting: init.waiting ?? false, hidden: false, online: init.online ?? true, now: 0};
  let timers: {at: number; fn: () => void}[] = [];
  const edgeSubs = new Set<() => void>();
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
        await new Promise((x) => setTimeout(x, 0)); // let a running tick reschedule
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        st.now = Math.max(st.now, due.at);
        due.fn();
        await new Promise((x) => setTimeout(x, 0));
      }
      st.now = until;
      await new Promise((x) => setTimeout(x, 0)); // let an edge's tick settle
    },
    background() {
      st.hidden = true;
      edgeSubs.forEach((f) => f());
    },
    // the app comes back to the front, or the network comes back
    edge() {
      st.hidden = false;
      edgeSubs.forEach((f) => f());
    },
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
      onEdge: (fn) => void edgeSubs.add(fn),
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

  // Offline + a worker waiting. The update and missing-chunk reloads kept
  // their own one-time flags, so after "You're offline" they never came back
  // (verifier round 3). The gate keeps the navigation pending instead.
  test('offline: not tried and stays pending; the next edge lands it', async () => {
    for (const why of ['update', 'chunk-missing', 'sign-out']) {
      const user = why === 'sign-out';
      const r = rig({waiting: true, online: false});
      const gate = createSelfNavGate(r.deps);
      gate({why, to: user ? () => '/' : undefined, notice: user ? 'Signing out…' : undefined});
      await r.step(WAITING_MAX_MS + 600);
      expect(r.went, why).toEqual([]);
      expect(r.events(), why).toContain('nav.offline');
      await r.step(60_000);
      expect(r.went, 'retried with no edge').toEqual([]);
      r.st.online = true;
      r.edge();
      await r.step(0);
      expect(r.went, why).toHaveLength(1);
      expect(r.went[0], why).toContain('cyc-net=1');
    }
  });

  // Every visibility edge re-decided and re-said "You're offline", also into a
  // hidden page, and automatic reloads said it too (verifier round 4).
  test('offline notice: user actions only, once per offline spell, never on a hide edge', async () => {
    const auto = rig({waiting: true, online: false});
    createSelfNavGate(auto.deps)({why: 'update'});
    await auto.step(WAITING_MAX_MS + 600);
    for (let i = 0; i < 3; i++) {
      auto.background();
      await auto.step(0);
      auto.edge();
      await auto.step(0);
    }
    expect(auto.said, 'an automatic reload spoke').toEqual([]);
    expect(auto.events().filter((e) => e === 'nav.offline')).toHaveLength(1);

    const r = rig({waiting: true, online: false});
    const gate = createSelfNavGate(r.deps);
    r.st.hidden = true; // the action's hold ends while the app is hidden: no toast there
    gate({why: 'sign-out', notice: 'Signing out…', to: () => '/'});
    await r.step(WAITING_MAX_MS + 600);
    expect(r.said).toEqual(['Signing out…']);
    for (let i = 0; i < 3; i++) {
      r.edge();
      await r.step(0);
      r.background();
      await r.step(0);
    }
    expect(r.said).toEqual(['Signing out…', OFFLINE_NOTICE]);
    // a second tap in the same spell: no second notice
    r.st.hidden = false;
    gate({why: 'sign-out', notice: 'Signing out…', to: () => '/'});
    await r.step(WAITING_MAX_MS + 600);
    expect(r.said.filter((m) => m === OFFLINE_NOTICE)).toHaveLength(1);
  });

  // A missing chunk while the update reload is held by a draft was held by
  // that draft (it re-used the pending navigation and its hold).
  test('a missing chunk relaxes a draft-held update reload: it goes now, both befores run', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    const ran: string[] = [];
    gate({
      why: 'update',
      hold: () => 'draft',
      to: () => '/?b=1',
      before: () => void ran.push('update')
    });
    await r.step(5000);
    expect(r.went).toEqual([]);
    gate({why: 'chunk-missing', before: () => void ran.push('chunk')});
    await r.step();
    expect(r.went).toEqual(['/?b=1']);
    expect(ran, "the update's departure record and the chunk's loop guard").toEqual([
      'update',
      'chunk'
    ]);
  });

  // LOW-1 (verifier round 5): a missing chunk replaced a pending user action,
  // so a sign-out landed on the current URL and an engine switch was undone.
  test('a missing chunk never replaces a pending user action: it keeps its destination', async () => {
    for (const online of [true, false]) {
      const r = rig({waiting: true, online});
      const gate = createSelfNavGate(r.deps);
      const ran: string[] = [];
      gate({
        why: 'engine-switch',
        notice: 'Reloading…',
        to: () => '/?x=1',
        before: () => void ran.push('pin')
      });
      await r.step(1000);
      gate({why: 'chunk-missing', before: () => void ran.push('chunk')});
      await r.step(WAITING_MAX_MS);
      if (!online) {
        r.st.online = true;
        r.edge();
        await r.step(0);
      }
      expect(r.went, `online=${online}`).toEqual(['https://app.example/?x=1&cyc-net=1']);
      expect(ran).toEqual(['pin']);
      expect(r.logs.find(([e]) => e === 'nav.go')?.[1].why).toBe('engine-switch');
    }
  });

  // LOW-2 (verifier round 5): every request restarted the 4 s worker-wait
  // clock, so missing chunks 2 s apart postponed the hatch without bound.
  test('repeated requests never restart the worker-wait clock', async () => {
    const r = rig({waiting: true});
    const gate = createSelfNavGate(r.deps);
    for (let i = 0; i < 6; i++) {
      gate({why: 'chunk-missing'});
      await r.step(i < 2 ? 2000 : 0);
      if (r.went.length) break;
    }
    await r.step(500);
    expect(r.went).toHaveLength(1);
    expect(r.st.now, 'the hatch went long after the first request').toBeLessThanOrEqual(
      WAITING_MAX_MS + 600
    );
  });

  test('a user action taking over while the worker waits says so at once, on the same clock', async () => {
    const r = rig({waiting: true});
    const gate = createSelfNavGate(r.deps);
    gate({why: 'chunk-missing'});
    await r.step(3000);
    gate({why: 'sign-out', notice: 'Signing out…', to: () => '/'});
    await r.step(0);
    expect(r.said).toEqual(['Signing out…']);
    await r.step(1600);
    expect(r.went).toEqual(['https://app.example/?cyc-net=1']);
  });

  test('an update reload never replaces a hold-free pending navigation', async () => {
    const r = rig({waiting: true, online: false});
    const gate = createSelfNavGate(r.deps);
    const ran: string[] = [];
    gate({why: 'chunk-missing', before: () => void ran.push('chunk')});
    await r.step(WAITING_MAX_MS + 600); // offline: pending
    gate({why: 'update', hold: () => 'draft', before: () => void ran.push('update')});
    r.st.online = true;
    r.edge();
    await r.step(0);
    expect(r.went).toEqual(['https://app.example/?chat=x&cyc-net=1#app']);
    expect(ran, 'the loop guard of the navigation that went').toEqual(['chunk']);
  });

  test('offline: the next held request re-uses the pending navigation', async () => {
    const r = rig({waiting: true, online: false});
    const gate = createSelfNavGate(r.deps);
    let before = 0;
    gate({why: 'update', hold: () => '', before: () => void before++});
    await r.step(WAITING_MAX_MS + 600);
    r.st.online = true;
    gate({why: 'update', hold: () => '', before: () => void (before += 100)});
    await r.step(0);
    expect(r.went).toEqual(['https://app.example/?chat=x&cyc-net=1#app']);
    expect(before, 'the first, pending navigation went').toBe(1);
  });

  test('a user action replaces a pending reload (a sign-out never waits on a draft)', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    gate({why: 'update', hold: () => 'draft'});
    await r.step(5000);
    gate({why: 'sign-out', notice: 'Signing out…', to: () => '/'});
    await r.step();
    expect(r.went).toEqual(['/']);
  });

  test('a navigation that leaves the page alive is decided again on the next edge', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    gate({why: 'sign-out', to: () => '/'});
    await r.step();
    expect(r.went).toEqual(['/']);
    // still navigating: an edge or a new request does not start a second one
    r.edge();
    gate({why: 'sign-out', to: () => '/'});
    await r.step();
    expect(r.went).toEqual(['/']);
    await r.step(ALIVE_MS);
    expect(r.events()).toContain('nav.failed');
    expect(r.said, 'no second notice on a slow navigation').toEqual([]);
    r.edge();
    await r.step(0);
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

  test('one pending navigation: two hold-free requests navigate once', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    gate({why: 'chunk-missing'});
    gate({why: 'chunk-missing'});
    await r.step();
    await r.step();
    expect(r.went).toEqual([null]);
  });
});
