import {describe, expect, test} from 'vitest';
import {createSelfNavGate, type PendingWorker, type SelfNavDeps} from '@/shared/selfReload';

// The one self-navigation gate (shared/selfReload.ts). Every navigation the
// app does to itself goes through it, because in Chromium a navigation that
// triggers a parked worker activation is dispatched to the old worker as it is
// stopped and never completes (the hung reload, 2026-10-03). Pins: never go
// while a new worker is installing or waiting; ask a waiting worker to take
// over; a caller hold (the update reload's draft) re-decided per tick and at
// once on the background edge; one self-navigation per page life.

function rig(init: {pending?: PendingWorker; hidden?: boolean} = {}) {
  const st = {pending: init.pending ?? '', hidden: init.hidden ?? false, now: 0};
  const timers: (() => void)[] = [];
  const hiddenSubs = new Set<() => void>();
  const r = {
    st,
    asks: 0,
    logs: [] as [string, Record<string, unknown>][],
    // run every due timer once (the gate reschedules itself)
    async step(ms = 500) {
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
      pendingWorker: async () => st.pending,
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
      log: (e: string, f: Record<string, unknown>) => void r.logs.push([e, f])
    } as SelfNavDeps
  };
  return r;
}

describe('self-navigation gate', () => {
  test('nothing pending: goes on the first tick, logs nav.go', async () => {
    const r = rig();
    const gate = createSelfNavGate(r.deps);
    let went = 0;
    gate({why: 'chunk-missing', go: () => void went++});
    await r.step();
    expect(went).toBe(1);
    expect(r.logs).toEqual([['nav.go', {why: 'chunk-missing', waited: 500, hidden: false}]]);
    expect(r.subs.size, 'the background listener was not removed').toBe(0);
  });

  test('a waiting worker holds the navigation and is asked to take over; it does, the page goes', async () => {
    const r = rig({pending: 'waiting'});
    const gate = createSelfNavGate(r.deps);
    let went = 0;
    gate({why: 'sign-out', go: () => void went++});
    await r.step();
    await r.step();
    expect(went, 'navigated into a waiting worker').toBe(0);
    expect(r.asks).toBeGreaterThanOrEqual(1);
    expect(r.logs[0]).toEqual(['nav.held', {why: 'sign-out', hold: 'sw-waiting', waited: 500}]);
    r.st.pending = '';
    await r.step();
    expect(went).toBe(1);
  });

  test('an installing worker holds without an ask until the install settles', async () => {
    const r = rig({pending: 'installing'});
    const gate = createSelfNavGate(r.deps);
    let went = 0;
    gate({why: 'clear-data', go: () => void went++});
    await r.step();
    expect(went).toBe(0);
    expect(r.asks).toBe(0);
    r.st.pending = '';
    await r.step();
    expect(went).toBe(1);
  });

  test('a caller hold (a draft) holds until it clears; the worker is still asked meanwhile', async () => {
    const r = rig({pending: 'waiting'});
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
    r.st.pending = '';
    await r.step(5_000);
    expect(went).toBe(0);
    expect(r.asks).toBe(1);
    expect(held).toEqual(['draft', 'draft']);
    draft = false;
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

  test('a background edge never skips the worker hold', async () => {
    const r = rig({pending: 'waiting'});
    const gate = createSelfNavGate(r.deps);
    let went = 0;
    gate({why: 'update', go: () => void went++});
    r.background();
    await new Promise((x) => setTimeout(x, 0));
    await r.step();
    expect(went).toBe(0);
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
