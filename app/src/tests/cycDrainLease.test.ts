import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import * as intents from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as lease from '../engine/sync/lease';
import * as sync from '../engine/sync/connection';

// One drainer per origin (offline design v2, section 3): the tab holding the
// lease runs the drain, every other tab's kick is nothing, and a tab that
// takes the lease re-reads the store and drains. The lease is a Web Lock,
// with a BroadcastChannel election where locks are missing.

const K = 'ws://lease.test/ws';
const SID = `${K}|pane-1`;
const tick = () => vi.advanceTimersByTimeAsync(1);

function settle() {
  sync.noteSealed(K);
  sync.noteHost(K);
  sync.noteSessions(K);
}

let nextId = 0;
function put(kind: intents.IntentKind = 'rename') {
  return intents.put({
    id: `${kind}:${nextId++}`,
    engineKey: K,
    sessionId: SID,
    kind,
    payload: {paneId: 'p', name: 'n', before: 'o'}
  });
}

// A fake Web Locks with the real API's shape: a request's callback runs when
// the lock is granted (`grant()` hands the head of the queue the lock), the
// request's promise settles once the callback's promise has, and a request
// with `steal` takes the lock at once, rejecting the holder's request with an
// AbortError the way the browser does.
function fakeLocks() {
  type Req = {
    steal: boolean;
    cb: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };
  const queue: Req[] = [];
  let holder: Req | null = null;
  const log: string[] = [];
  const run = (r: Req) => {
    holder = r;
    let out: Promise<unknown>;
    try {
      out = Promise.resolve(r.cb());
    } catch (e) {
      out = Promise.reject(e);
    }
    void out.then(
      (v) => {
        if (holder === r) holder = null;
        r.resolve(v);
      },
      (e) => {
        if (holder === r) holder = null;
        r.reject(e);
      }
    );
  };
  const locks: lease.LocksLike = {
    request: (_name, opts, cb) =>
      new Promise<unknown>((resolve, reject) => {
        const r: Req = {steal: !!opts.steal, cb, resolve, reject};
        log.push(r.steal ? 'steal' : 'request');
        if (r.steal) {
          const old = holder;
          holder = null;
          old?.reject(
            new DOMException(
              'Lock broken by another request with the "steal" option.',
              'AbortError'
            )
          );
          run(r);
          return;
        }
        queue.push(r);
      })
  };
  return {
    locks,
    grant: () => {
      if (holder) return;
      const r = queue.shift();
      if (r) run(r);
    },
    log,
    holding: () => holder !== null,
    queued: () => queue.length
  };
}

// A fake BroadcastChannel bus: every channel opened on it hears the others.
function fakeBus() {
  const members: lease.ChannelLike[] = [];
  const open = (): lease.ChannelLike => {
    const me: lease.ChannelLike = {
      onmessage: null,
      postMessage: (data) => {
        for (const m of members) if (m !== me) m.onmessage?.({data} as MessageEvent);
      },
      close: () => {
        const i = members.indexOf(me);
        if (i >= 0) members.splice(i, 1);
      }
    };
    members.push(me);
    return me;
  };
  return {open, size: () => members.length, members};
}

describe('lease: who drains', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    intents.__resetForTest();
    sync.__resetForTest();
    drain.__resetForTest(() => 0.5);
  });
  afterEach(() => {
    lease.__resetForTest();
    vi.useRealTimers();
  });

  test('Web Locks: this tab leads once the lock is granted, not before', () => {
    const {locks, grant} = fakeLocks();
    const led: string[] = [];
    lease.__resetForTest({locks, channel: null});
    const off = lease.onLeader(() => led.push('lead'));
    expect(lease.isLeader()).toBe(false);
    grant();
    expect(lease.isLeader()).toBe(true);
    expect(led).toEqual(['lead']);
    off();
  });

  test('Web Locks refused: the tabs elect over the channel instead', async () => {
    const bus = fakeBus();
    const locks: lease.LocksLike = {request: () => Promise.reject(new Error('insecure context'))};
    lease.__resetForTest({locks, channel: bus.open, id: 'a'}, () => 0);
    await tick();
    expect(bus.size()).toBe(1);
    expect(lease.isLeader()).toBe(false);
    await vi.advanceTimersByTimeAsync(lease.LEASE_TTL_MS);
    expect(lease.isLeader()).toBe(true);
  });

  test('channel: a tab that hears a holder waits; silence for the TTL makes it claim', async () => {
    const bus = fakeBus();
    lease.__resetForTest({locks: null, channel: bus.open, id: 'b'}, () => 0);
    const other = bus.open();
    const heard: unknown[] = [];
    other.onmessage = (ev) => heard.push(ev.data);
    // The holder beats every second: this tab never claims.
    for (let i = 0; i < 5; i++) {
      other.postMessage({t: 'lease', id: 'a'});
      await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS);
    }
    expect(lease.isLeader()).toBe(false);
    // The holder dies: after the TTL this tab claims and starts beating.
    await vi.advanceTimersByTimeAsync(lease.LEASE_TTL_MS);
    expect(lease.isLeader()).toBe(true);
    expect(heard[0]).toEqual({t: 'lease', id: 'b'});
    const n = heard.length;
    await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS * 2);
    expect(heard).toHaveLength(n + 2);
  });

  test('channel: of two holders the lower id keeps the lease', async () => {
    const bus = fakeBus();
    lease.__resetForTest({locks: null, channel: bus.open, id: 'b'}, () => 0);
    await vi.advanceTimersByTimeAsync(lease.LEASE_TTL_MS);
    expect(lease.isLeader()).toBe(true);
    const other = bus.open();
    other.postMessage({t: 'lease', id: 'a'});
    expect(lease.isLeader()).toBe(false);
    other.postMessage({t: 'lease', id: 'c'});
    expect(lease.isLeader()).toBe(false);
  });

  test('neither API: the one tab leads at once', () => {
    lease.__resetForTest({locks: null, channel: null});
    expect(lease.isLeader()).toBe(true);
  });

  test('a follower kicks nothing: its queued rows stay queued', async () => {
    const {locks} = fakeLocks();
    lease.__resetForTest({locks, channel: null});
    const calls: string[] = [];
    drain.registerExecutor('rename', (i) => {
      calls.push(i.id);
      return 'done';
    });
    const r = put();
    settle();
    drain.kick(K);
    await tick();
    expect(calls).toEqual([]);
    expect(intents.get(r.id)?.state).toBe('queued');
  });

  test('taking the lease re-reads the store and drains what it finds', async () => {
    const {locks, grant} = fakeLocks();
    lease.__resetForTest({locks, channel: null});
    const calls: string[] = [];
    drain.registerExecutor('rename', (i) => {
      calls.push(i.id);
      return 'done';
    });
    const reload = vi.spyOn(intents, 'reload');
    const r = put();
    settle();
    await tick();
    expect(calls).toEqual([]);
    grant();
    await tick();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([r.id]);
    expect(intents.all()).toEqual([]);
    reload.mockRestore();
  });

  test("another tab's queued row kicks the holder; a gone row settles a waiter", async () => {
    const calls: string[] = [];
    drain.registerExecutor('rename', (i) => {
      calls.push(i.id);
      return 'done';
    });
    settle();
    await tick();
    // Without a store under the test, the notice reads nothing: the row is
    // gone, and whoever waited on it hears so.
    const r = put();
    const waited = drain.whenSettled(r.id);
    await intents.__noticeForTest({t: 'gone', id: r.id, engineKey: K});
    await expect(waited).resolves.toBe(true);
    // A row notice with the row on disk kicks the drain; the kick is gated
    // on the lease like every other, so a follower still writes nothing.
    lease.__resetForTest({locks: fakeLocks().locks, channel: null});
    const q = put();
    await intents.__noticeForTest({t: 'row', id: q.id, engineKey: K});
    await tick();
    expect(calls).toEqual([]);
  });

  test("a remote 'gone' for the row in flight frees the slot: the next row drains without an edge (R7)", async () => {
    const calls: string[] = [];
    let x: intents.Intent | undefined = undefined;
    drain.registerExecutor('send-text', (i) => {
      calls.push(i.id);
      return i.id === x?.id ? 'inflight' : 'done';
    });
    settle();
    await tick();
    x = put('send-text');
    const y = put('send-text');
    drain.kick(K);
    await tick();
    expect(calls).toEqual([x.id]);
    expect(drain.inflightOf(K)).toBe(x.id);
    // Another tab erased X (it saw the ack, or the user discarded it there):
    // the slot X held here is free, and Y goes now, on no socket edge.
    await intents.__noticeForTest({t: 'gone', id: x.id, engineKey: K});
    await tick();
    expect(drain.inflightOf(K)).toBeUndefined();
    expect(calls).toEqual([x.id, y.id]);
    expect(intents.all()).toEqual([]);
  });
});

// Lease liveness (R4/R5): a holder that is not running (frozen in the bfcache,
// a stopped background tab) must not keep every tab from draining, and a
// thawed holder must not write a wire on a lease it may have lost.
describe('lease: liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    intents.__resetForTest();
    sync.__resetForTest();
    drain.__resetForTest(() => 0);
  });
  afterEach(() => {
    lease.__resetForTest();
    vi.useRealTimers();
  });

  const listen = (bus: ReturnType<typeof fakeBus>) => {
    const other = bus.open();
    const heard: Array<{t: string; id: string}> = [];
    other.onmessage = (ev) => heard.push(ev.data as {t: string; id: string});
    return {other, heard, beatsFrom: (id: string) => heard.filter((f) => f.id === id).length};
  };
  const freeze = (ms: number) => vi.setSystemTime(Date.now() + ms);

  test('Web Locks: the holder beats on the channel every second', async () => {
    const {locks, grant} = fakeLocks();
    const bus = fakeBus();
    lease.__resetForTest({locks, channel: bus.open, id: 'a'}, () => 0);
    const {heard} = listen(bus);
    await tick();
    expect(heard).toEqual([]);
    grant();
    expect(heard).toEqual([{t: 'lease', id: 'a'}]);
    await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS * 2);
    expect(heard).toHaveLength(3);
  });

  test('Web Locks: a follower that hears no beat for the TTL steals the lock and leads', async () => {
    const {locks, log} = fakeLocks();
    const bus = fakeBus();
    lease.__resetForTest({locks, channel: bus.open, id: 'b'}, () => 0);
    const {other, beatsFrom} = listen(bus);
    const led: string[] = [];
    const off = lease.onLeader(() => led.push('lead'));
    // The holder (another tab, the lock never granted here) beats: no steal.
    for (let i = 0; i < 5; i++) {
      other.postMessage({t: 'lease', id: 'a'});
      await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS);
    }
    expect(log).toEqual(['request']);
    expect(lease.isLeader()).toBe(false);
    // The holder freezes: silence for the TTL (counted from its last beat),
    // and this tab takes the lock.
    await vi.advanceTimersByTimeAsync(lease.LEASE_TTL_MS - lease.HEARTBEAT_MS);
    expect(log).toEqual(['request', 'steal']);
    expect(lease.isLeader()).toBe(true);
    expect(led).toEqual(['lead']);
    expect(beatsFrom('b')).toBe(1);
    await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS * 2);
    expect(beatsFrom('b')).toBe(3);
    off();
  });

  test('Web Locks: a follower that was itself frozen listens for a round before it steals', async () => {
    const {locks, log} = fakeLocks();
    const bus = fakeBus();
    lease.__resetForTest({locks, channel: bus.open, id: 'b'}, () => 0);
    const {other} = listen(bus);
    other.postMessage({t: 'lease', id: 'a'});
    // This tab stops running for a while; its steal timer fires late.
    freeze(60_000);
    await vi.advanceTimersByTimeAsync(lease.LEASE_TTL_MS);
    expect(log).toEqual(['request']);
    // The holder is alive and says so: no steal.
    for (let i = 0; i < 4; i++) {
      other.postMessage({t: 'lease', id: 'a'});
      await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS);
    }
    expect(log).toEqual(['request']);
    expect(lease.isLeader()).toBe(false);
    // Silence for real: the steal.
    await vi.advanceTimersByTimeAsync(lease.LEASE_TTL_MS);
    expect(log).toEqual(['request', 'steal']);
    expect(lease.isLeader()).toBe(true);
  });

  test('Web Locks: a thawed holder whose lock was stolen yields on the rejection and queues again', async () => {
    const {locks, grant, log, queued} = fakeLocks();
    const bus = fakeBus();
    lease.__resetForTest({locks, channel: bus.open, id: 'a'}, () => 0);
    const {other, beatsFrom} = listen(bus);
    grant();
    expect(lease.isLeader()).toBe(true);
    // Another tab steals the lock (this tab was frozen, and thaws now).
    locks.request(lease.LOCK_NAME, {steal: true}, () => new Promise(() => {})).catch(() => {});
    await tick();
    expect(lease.isLeader()).toBe(false);
    expect(log).toEqual(['request', 'steal', 'request']);
    expect(queued()).toBe(1);
    // The thief beats; this tab stays a follower and beats nothing.
    const n = beatsFrom('a');
    for (let i = 0; i < 4; i++) {
      other.postMessage({t: 'lease', id: 'c'});
      await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS);
    }
    expect(beatsFrom('a')).toBe(n);
    expect(lease.isLeader()).toBe(false);
    expect(log).toEqual(['request', 'steal', 'request']);
  });

  test('Web Locks: a holder frozen past the TTL steps down before the next write and leads again only once regranted', async () => {
    const {locks, grant, holding, queued} = fakeLocks();
    const bus = fakeBus();
    lease.__resetForTest({locks, channel: bus.open, id: 'a'}, () => 0);
    const {beatsFrom} = listen(bus);
    const led: string[] = [];
    const off = lease.onLeader(() => led.push('lead'));
    grant();
    expect(lease.isLeader()).toBe(true);
    expect(holding()).toBe(true);
    const n = beatsFrom('a');
    // Frozen: no timer ran, and the wall clock moved past the TTL.
    freeze(lease.LEASE_TTL_MS + 1);
    // The drain's check before a write: not the leader any more.
    expect(lease.isLeader()).toBe(false);
    await tick();
    expect(holding()).toBe(false);
    expect(queued()).toBe(1);
    expect(beatsFrom('a')).toBe(n);
    // Nobody else took it: the regrant makes this tab the holder afresh.
    grant();
    expect(lease.isLeader()).toBe(true);
    expect(led).toEqual(['lead', 'lead']);
    expect(beatsFrom('a')).toBe(n + 1);
    off();
  });

  test('Web Locks: a thawed holder whose beat timer fires late steps down instead of beating', async () => {
    const {locks, grant, holding} = fakeLocks();
    const bus = fakeBus();
    lease.__resetForTest({locks, channel: bus.open, id: 'a'}, () => 0);
    const {beatsFrom} = listen(bus);
    grant();
    const n = beatsFrom('a');
    freeze(lease.LEASE_TTL_MS + 1);
    await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS);
    expect(beatsFrom('a')).toBe(n);
    expect(lease.isLeader()).toBe(false);
    expect(holding()).toBe(false);
  });

  test('Web Locks: a lapsed holder writes no wire; the drain resumes on the regrant', async () => {
    const {locks, grant} = fakeLocks();
    const bus = fakeBus();
    lease.__resetForTest({locks, channel: bus.open, id: 'a'}, () => 0);
    const calls: string[] = [];
    drain.registerExecutor('rename', (i) => {
      calls.push(i.id);
      return 'done';
    });
    settle();
    grant();
    await tick();
    const a = put();
    drain.kick(K);
    await tick();
    expect(calls).toEqual([a.id]);
    freeze(lease.LEASE_TTL_MS + 1);
    const b = put();
    drain.kick(K);
    await tick();
    expect(calls).toEqual([a.id]);
    expect(intents.get(b.id)?.state).toBe('queued');
    grant();
    await tick();
    expect(calls).toEqual([a.id, b.id]);
  });

  test('channel: a thawed holder whose last beat is older than the TTL does not beat and is not the leader', async () => {
    const bus = fakeBus();
    lease.__resetForTest({locks: null, channel: bus.open, id: 'b'}, () => 0);
    const {other, beatsFrom} = listen(bus);
    await vi.advanceTimersByTimeAsync(lease.LEASE_TTL_MS);
    expect(lease.isLeader()).toBe(true);
    const n = beatsFrom('b');
    // Frozen past the TTL: the beat timer fires late, and beats nothing.
    freeze(lease.LEASE_TTL_MS + 1);
    await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS);
    expect(beatsFrom('b')).toBe(n);
    expect(lease.isLeader()).toBe(false);
    // The tab that claimed meanwhile beats: this one stays a follower.
    for (let i = 0; i < 4; i++) {
      other.postMessage({t: 'lease', id: 'a'});
      await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS);
    }
    expect(lease.isLeader()).toBe(false);
    expect(beatsFrom('b')).toBe(n);
    // That one dies too: the TTL after its last beat this tab claims again.
    await vi.advanceTimersByTimeAsync(lease.LEASE_TTL_MS - lease.HEARTBEAT_MS);
    expect(lease.isLeader()).toBe(true);
    expect(beatsFrom('b')).toBe(n + 1);
  });

  test('channel: the check before a write, not only the timer, catches a lapsed holder', async () => {
    const bus = fakeBus();
    lease.__resetForTest({locks: null, channel: bus.open, id: 'b'}, () => 0);
    const {beatsFrom} = listen(bus);
    await vi.advanceTimersByTimeAsync(lease.LEASE_TTL_MS);
    const n = beatsFrom('b');
    freeze(lease.LEASE_TTL_MS + 1);
    expect(lease.isLeader()).toBe(false);
    await vi.advanceTimersByTimeAsync(lease.HEARTBEAT_MS * 2);
    expect(beatsFrom('b')).toBe(n);
  });
});
