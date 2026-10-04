import {describe, expect, test} from 'vitest';
import {createSelfNavGate, WAITING_MAX_MS, type SelfNavDeps} from '@/shared/selfReload';

// The one self-navigation gate (shared/selfReload.ts). Every navigation the
// app does to itself goes through it, because in Chromium a navigation that
// triggers a parked worker activation is dispatched to the old worker as it is
// stopped and never completes (the hung reload, 2026-10-03). Pins: a WAITING
// worker is asked to take over and holds the navigation (a user action a few
// seconds at most, then it goes through the network); an INSTALLING worker
// (minutes on a stalled radio) never holds it; a caller
// hold (the update reload's draft) re-decided per tick and at once on the
// background edge; one self-navigation per page life.

function rig(init: {waiting?: boolean; hidden?: boolean} = {}) {
  const st = {waiting: init.waiting ?? false, hidden: init.hidden ?? false, now: 0};
  const timers: (() => void)[] = [];
  const hiddenSubs = new Set<() => void>();
  const r = {
    st,
    asks: 0,
    said: [] as string[],
    logs: [] as [string, Record<string, unknown>][],
    // run every due timer once (the gate reschedules itself)
    async step(ms = 300) {
      st.now += ms;
      const due = timers.splice(0);
      due.forEach((f) => f());
      await new Promise((x) => setTimeout(x, 0));
    },
    background() {
      st.hidden = true;
      hiddenSubs.forEach((f) => f());
    },
    subs: hiddenSubs,
    deps: {
      workerWaiting: async () => st.waiting,
      askActivate: () => {
        r.asks += 1;
      },
      hidden: () => st.hidden,
      now: () => st.now,
      schedule: (fn: () => void) => {
        timers.push(fn);
        return fn;
      },
      cancel: (h: unknown) => {
        const i = timers.indexOf(h as () => void);
        if (i >= 0) timers.splice(i, 1);
      },
      onHidden: (fn: () => void) => {
        hiddenSubs.add(fn);
        return () => hiddenSubs.delete(fn);
      },
      log: (e: string, f: Record<string, unknown>) => void r.logs.push([e, f]),
      notify: (m: string) => void r.said.push(m)
    } satisfies SelfNavDeps
  };
  return r;
}

describe('self-navigation gate', () => {
  test('nothing waiting: goes on the first tick, logs nav.go', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    let went = 0;
    gate({why: 'chunk-missing', go: () => void went++});
    await r.step();
    expect(went).toBe(1);
    expect(r.logs).toEqual([['nav.go', {why: 'chunk-missing', waited: 300, hidden: false}]]);
    expect(r.subs.size, 'the background listener was not removed').toBe(0);
    expect(r.said).toEqual([]);
  });

  test('a waiting worker is asked to take over and holds; it does, the page goes', async () => {
    const r = rig({waiting: true});
    const gate = createSelfNavGate(r.deps);
    const went: boolean[] = [];
    gate({why: 'sign-out', userAction: 'Signing out…', go: (at) => void went.push(at.viaNetwork)});
    await r.step();
    await r.step();
    expect(went, 'navigated into a waiting worker').toEqual([]);
    expect(r.asks).toBeGreaterThanOrEqual(1);
    expect(r.logs[0]).toEqual(['nav.held', {why: 'sign-out', hold: 'sw-waiting'}]);
    expect(r.said, 'a held user action shows nothing').toEqual(['Signing out…']);
    r.st.waiting = false;
    await r.step();
    expect(went).toEqual([false]);
  });

  test('the update and missing-chunk reloads hold for as long as the worker waits', async () => {
    const r = rig({waiting: true});
    const gate = createSelfNavGate(r.deps);
    let went = 0;
    gate({why: 'chunk-missing', go: () => void went++});
    for (let t = 0; t < 120; t++) await r.step(1000);
    expect(went, 'navigated into a parked worker').toBe(0);
    expect(r.asks).toBeGreaterThan(100);
    expect(r.said).toEqual([]);
    r.st.waiting = false;
    await r.step();
    expect(went).toBe(1);
  });

  test('a user action held past the bound goes through the network, never into the worker', async () => {
    const r = rig({waiting: true});
    const gate = createSelfNavGate(r.deps);
    const went: boolean[] = [];
    gate({why: 'sign-out', userAction: 'Signing out…', go: (at) => void went.push(at.viaNetwork)});
    for (let t = 0; t < WAITING_MAX_MS - 300; t += 300) await r.step();
    expect(went).toEqual([]);
    for (let t = 0; t < 1000; t += 300) await r.step();
    expect(went, 'held past the bound, or went into the worker').toEqual([true]);
    expect(r.st.now, 'went well after the bound').toBeLessThanOrEqual(WAITING_MAX_MS + 1500);
    expect(r.logs.pop()).toEqual([
      'nav.go',
      expect.objectContaining({why: 'sign-out', viaNetwork: true})
    ]);
  });

  // On a stalled radio an install runs for minutes (Chromium 300 s, WebKit
  // longer); the gate used to hold every navigation for all of it.
  test('an installing worker never holds a navigation (the pending-worker probe says not waiting)', async () => {
    const r = rig({waiting: false});
    const gate = createSelfNavGate(r.deps);
    let went = 0;
    gate({why: 'clear-data', go: () => void went++});
    await r.step();
    expect(went).toBe(1);
    expect(r.asks).toBe(0);
  });

  test('a caller hold (a draft) holds until it clears, then the worker bound starts', async () => {
    const r = rig({waiting: true});
    const gate = createSelfNavGate(r.deps);
    let draft = true;
    const held: string[] = [];
    let went = 0;
    gate({
      why: 'update',
      hold: () => (draft ? 'draft' : ''),
      onHeld: (h) => held.push(h),
      go: () => void went++
    });
    await r.step();
    await r.step(60_000);
    expect(went).toBe(0);
    expect(held).toEqual(['draft', 'draft']);
    draft = false;
    await r.step();
    expect(went, 'the draft time counted against the worker bound').toBe(0);
    r.st.waiting = false;
    await r.step();
    expect(went).toBe(1);
  });

  test('the background edge decides at once, without waiting for a tick', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    let went = 0;
    gate({
      why: 'update',
      hold: (_w, hidden) => (hidden ? '' : 'draft'),
      go: ({hidden}) => {
        expect(hidden).toBe(true);
        went++;
      }
    });
    await r.step();
    expect(went).toBe(0);
    r.background();
    await new Promise((x) => setTimeout(x, 0));
    expect(went).toBe(1);
  });

  test('one self-navigation per page life: a second request stands down', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    let a = 0;
    let b = 0;
    gate({why: 'chunk-missing', go: () => void a++});
    gate({why: 'update', go: () => void b++});
    await r.step();
    await r.step();
    expect(a + b).toBe(1);
  });
});
