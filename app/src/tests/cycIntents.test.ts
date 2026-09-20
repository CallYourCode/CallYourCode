import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import * as intents from '../engine/intents';
import {APP_ENGINE_KEY, INTENTS_MAX_PER_ENGINE, intentFromOutbox} from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync/connection';
import {INTENTS, upgradeClipsDb} from '../shared/browser';

// The intent queue (offline design v2, section 3): every user mutation is a
// durable row, applied locally at once, drained FIFO per engine on the settled
// edge, coalesced per kind, never dropped for age, failed only by a definitive
// engine answer. This file exercises the queue and the drain with fake
// executors; the per-kind executors have their own suites (sends, session ops,
// mark-unread, settings).

const K = 'ws://intents.test/ws';
const SID = `${K}|pane-1`;

function settle(key = K) {
  sync.noteSealed(key);
  sync.noteHost(key);
  sync.noteSessions(key);
}
const tick = () => vi.advanceTimersByTimeAsync(1);

let nextId = 0;
function put(kind: intents.IntentKind, payload: unknown, coalesceKey?: string, key = K) {
  return intents.put({
    id: `${kind}:${nextId++}`,
    engineKey: key,
    sessionId: SID,
    kind,
    coalesceKey,
    payload
  });
}

describe('intents: coalescing per kind', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    intents.__resetForTest();
    sync.__resetForTest();
    drain.__resetForTest(() => 0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('rename: latest name wins, the revert target is the first before', () => {
    const a = put('rename', {paneId: 'p', name: 'one', before: 'zero'}, 'rename:p');
    const b = put('rename', {paneId: 'p', name: 'two', before: 'one'}, 'rename:p');
    expect(b.id).toBe(a.id);
    expect(intents.all()).toHaveLength(1);
    expect(a.payload).toEqual({paneId: 'p', name: 'two', before: 'zero'});
  });

  test('reorder and unread: latest value wins under one row', () => {
    put('reorder', {order: ['a', 'b'], before: {a: 1, b: 0}}, `reorder:${K}`);
    put('reorder', {order: ['b', 'a'], before: {a: 0, b: 1}}, `reorder:${K}`);
    put('mark-unread', {paneId: 'p', unread: true, before: {unread: 0, marked: false}}, 'unread:p');
    put('mark-unread', {paneId: 'p', unread: false, before: {unread: 1, marked: true}}, 'unread:p');
    const rows = intents.all();
    expect(rows).toHaveLength(2);
    expect(rows[0].payload).toEqual({order: ['b', 'a'], before: {a: 1, b: 0}});
    expect(rows[1].payload).toEqual({
      paneId: 'p',
      unread: false,
      before: {unread: 0, marked: false}
    });
  });

  test('heard keeps the max ts; progress keeps the latest', () => {
    put('heard', {paneId: 'p', msgId: 'm9', ts: 900}, 'heard:p');
    put('heard', {paneId: 'p', msgId: 'm3', ts: 300}, 'heard:p');
    put('progress', {paneId: 'p', seq: 5, explicit: false}, 'progress:p');
    put('progress', {paneId: 'p', seq: 2, explicit: true}, 'progress:p');
    const rows = intents.all();
    expect(rows).toHaveLength(2);
    expect(rows[0].payload).toEqual({paneId: 'p', msgId: 'm9', ts: 900});
    expect(rows[1].payload).toEqual({paneId: 'p', seq: 2, explicit: true});
  });

  test('session and global settings patches merge', () => {
    put('session-settings', {paneId: 'p', patch: {muted: true}}, 'sset:p');
    put('session-settings', {paneId: 'p', patch: {notify: null}}, 'sset:p');
    put('global-settings', {patch: {speed: 2}}, 'gset:app', APP_ENGINE_KEY);
    put('global-settings', {patch: {sound: false}}, 'gset:app', APP_ENGINE_KEY);
    expect(intents.forEngine(K)[0].payload).toEqual({
      paneId: 'p',
      patch: {muted: true, notify: null}
    });
    expect(intents.forEngine(APP_ENGINE_KEY)[0].payload).toEqual({patch: {speed: 2, sound: false}});
  });

  test('sends never coalesce; a coalesced row keeps its place in the queue', () => {
    const r = put('rename', {paneId: 'p', name: 'one', before: 'zero'}, 'rename:p');
    vi.setSystemTime(Date.now() + 5);
    const a = put('send-text', {
      cid: 'c1',
      sessionId: SID,
      ts: Date.now(),
      text: 'hi',
      kind: 'text',
      wire: 'hi'
    });
    const b = put('send-text', {
      cid: 'c2',
      sessionId: SID,
      ts: Date.now(),
      text: 'hi',
      kind: 'text',
      wire: 'hi'
    });
    vi.setSystemTime(Date.now() + 5);
    put('rename', {paneId: 'p', name: 'two', before: 'one'}, 'rename:p');
    const ids = intents.all().map((i) => i.id);
    expect(a.id).not.toBe(b.id);
    expect(ids).toEqual([r.id, a.id, b.id]);
  });

  test('a row in flight is not coalesced into; the new act queues behind it', () => {
    const a = put('rename', {paneId: 'p', name: 'one', before: 'zero'}, 'rename:p');
    intents.setState(a.id, 'inflight');
    const b = put('rename', {paneId: 'p', name: 'two', before: 'one'}, 'rename:p');
    expect(b.id).not.toBe(a.id);
    expect(intents.all().map((i) => i.state)).toEqual(['inflight', 'queued']);
  });

  test('a failed row is superseded by the next act on the same key', () => {
    const a = put('rename', {paneId: 'p', name: 'one', before: 'zero'}, 'rename:p');
    intents.setState(a.id, 'failed', 'no');
    const b = put('rename', {paneId: 'p', name: 'two', before: 'one'}, 'rename:p');
    expect(b.id).toBe(a.id);
    expect(b.state).toBe('queued');
    expect(b.lastError).toBeUndefined();
  });

  test('cap: over 500 per engine the oldest heard/progress go first, sends never', () => {
    for (let i = 0; i < 3; i++) {
      put('send-text', {
        cid: `c${i}`,
        sessionId: SID,
        ts: Date.now(),
        text: 'x',
        kind: 'text',
        wire: 'x'
      });
    }
    const heard: string[] = [];
    for (let i = 0; i < INTENTS_MAX_PER_ENGINE - 3; i++) {
      heard.push(put('heard', {paneId: `p${i}`, msgId: 'm', ts: i}, `heard:p${i}`).id);
    }
    expect(intents.forEngine(K)).toHaveLength(INTENTS_MAX_PER_ENGINE);
    put('progress', {paneId: 'q', seq: 1, explicit: false}, 'progress:q');
    put('rename', {paneId: 'q', name: 'n', before: 'o'}, 'rename:q');
    const rows = intents.forEngine(K);
    expect(rows).toHaveLength(INTENTS_MAX_PER_ENGINE);
    // The two oldest heard marks went; every send and the new rows stay.
    expect(rows.filter((i) => i.kind === 'send-text')).toHaveLength(3);
    expect(intents.get(heard[0])).toBeUndefined();
    expect(intents.get(heard[1])).toBeUndefined();
    expect(intents.get(heard[2])).toBeDefined();
    expect(rows.some((i) => i.kind === 'progress')).toBe(true);
    expect(rows.some((i) => i.kind === 'rename')).toBe(true);
  });

  test('age never drops a row; past 24 h it is stale (waiting since)', () => {
    const r = put('rename', {paneId: 'p', name: 'n', before: 'o'}, 'rename:p');
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(intents.get(r.id)).toBeDefined();
    expect(intents.isStale(r)).toBe(true);
    expect(intents.isStale(put('heard', {paneId: 'p', msgId: 'm', ts: 1}, 'heard:p'))).toBe(false);
  });

  test('intentState finds a send by its local bubble id', () => {
    intents.put({
      id: 'c1',
      engineKey: K,
      sessionId: SID,
      kind: 'send-text',
      payload: {},
      localId: 'm41'
    });
    expect(intents.intentState('m41')).toBe('queued');
    intents.setState('c1', 'inflight');
    expect(intents.intentState('m41')).toBe('inflight');
    expect(intents.intentState('m42')).toBeUndefined();
  });
});

describe('drain: FIFO per engine on the settled edge', () => {
  const calls: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    intents.__resetForTest();
    sync.__resetForTest();
    drain.__resetForTest(() => 0.5);
  });
  afterEach(() => {
    drain.__resetForTest();
    vi.useRealTimers();
  });

  test('offline: rows queue, nothing runs, no timers', async () => {
    drain.registerExecutor('rename', (i) => {
      calls.push(i.id);
      return 'done';
    });
    put('rename', {paneId: 'p', name: 'n', before: 'o'}, 'rename:p');
    drain.kick(K);
    await tick();
    expect(calls).toEqual([]);
    expect(intents.queuedFor(K)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(drain.activeTimers()).toBe(0);
  });

  test('ordering invariant: a rename queued before a send drains first', async () => {
    drain.registerExecutor('rename', (i) => {
      calls.push(i.id);
      return 'done';
    });
    drain.registerExecutor('send-text', (i) => {
      calls.push(i.id);
      return 'done';
    });
    const r = put('rename', {paneId: 'p', name: 'n', before: 'o'}, 'rename:p');
    vi.setSystemTime(Date.now() + 1);
    const s = put('send-text', {cid: 'c1'});
    settle();
    await tick();
    expect(calls).toEqual([r.id, s.id]);
    expect(intents.all()).toEqual([]);
  });

  test('one in flight per engine; the next row waits for settled(id)', async () => {
    drain.registerExecutor('send-text', (i) => {
      calls.push(i.id);
      return 'inflight';
    });
    const a = put('send-text', {cid: 'a'});
    vi.setSystemTime(Date.now() + 1);
    const b = put('send-text', {cid: 'b'});
    settle();
    await tick();
    expect(calls).toEqual([a.id]);
    expect(drain.inflightOf(K)).toBe(a.id);
    expect(intents.get(b.id)?.state).toBe('queued');
    drain.settled(a.id);
    await tick();
    expect(calls).toEqual([a.id, b.id]);
    expect(intents.get(a.id)).toBeUndefined();
    expect(drain.inflightOf(K)).toBe(b.id);
  });

  test('transient: the row stays queued and the drain ends; retry 1 s, 2 s, 4 s .. 30 s while up', async () => {
    let answer: drain.DrainOutcome = 'transient';
    drain.registerExecutor('rename', (i) => {
      calls.push(i.id);
      return answer;
    });
    const r = put('rename', {paneId: 'p', name: 'n', before: 'o'}, 'rename:p');
    settle();
    await tick();
    expect(calls).toEqual([r.id]);
    expect(intents.get(r.id)?.state).toBe('queued');
    expect(drain.activeTimers()).toBe(1);
    // The retry was armed at t=0 for 1000 ms; the tick above spent 1 ms.
    await vi.advanceTimersByTimeAsync(998);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).toHaveLength(4);
    expect(intents.get(r.id)?.attempts).toBe(4);
    answer = 'done';
    await vi.advanceTimersByTimeAsync(8000);
    expect(calls).toHaveLength(5);
    expect(intents.get(r.id)).toBeUndefined();
    expect(drain.activeTimers()).toBe(0);
  });

  test('retryMs: min(30000, 1000 * 2^n) scaled by 0.75..1.25', () => {
    expect(drain.retryMs(0, 0.5)).toBe(1000);
    expect(drain.retryMs(1, 0.5)).toBe(2000);
    expect(drain.retryMs(4, 0.5)).toBe(16000);
    expect(drain.retryMs(5, 0.5)).toBe(30000);
    expect(drain.retryMs(9, 0.5)).toBe(30000);
    expect(drain.retryMs(0, 0)).toBe(750);
    expect(drain.retryMs(0, 1)).toBe(1250);
  });

  test('down clears the retry timer and puts the in-flight row back to queued', async () => {
    drain.registerExecutor('send-text', () => 'inflight');
    drain.registerExecutor('rename', () => 'transient');
    const s = put('send-text', {cid: 'a'});
    settle();
    await tick();
    expect(drain.inflightOf(K)).toBe(s.id);
    sync.noteDown(K);
    expect(drain.inflightOf(K)).toBeUndefined();
    expect(intents.get(s.id)?.state).toBe('queued');
    expect(vi.getTimerCount()).toBe(0);

    drain.settled(s.id);
    put('rename', {paneId: 'p', name: 'n', before: 'o'}, 'rename:p');
    settle();
    await tick();
    expect(drain.activeTimers()).toBe(1);
    sync.noteDown(K);
    expect(drain.activeTimers()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('definitive: the row is failed with the reason, the queue goes on, whenSettled resolves false', async () => {
    drain.registerExecutor('rename', () => ({failed: 'the engine refused it (HTTP 404)'}));
    drain.registerExecutor('reorder', (i) => {
      calls.push(i.id);
      return 'done';
    });
    const r = put('rename', {paneId: 'p', name: 'n', before: 'o'}, 'rename:p');
    vi.setSystemTime(Date.now() + 1);
    const o = put('reorder', {order: [], before: {}}, `reorder:${K}`);
    const settledR = drain.whenSettled(r.id);
    const settledO = drain.whenSettled(o.id);
    settle();
    await tick();
    expect(await settledR).toBe(false);
    expect(await settledO).toBe(true);
    expect(intents.get(r.id)).toMatchObject({
      state: 'failed',
      lastError: 'the engine refused it (HTTP 404)'
    });
    expect(calls).toEqual([o.id]);
    // A retry tap requeues it and it runs again.
    drain.registerExecutor('rename', () => 'done');
    drain.requeue(r.id);
    await tick();
    expect(intents.get(r.id)).toBeUndefined();
  });

  test('whenTaken rides out a refusal and resolves with the retry that lands; false only when the row goes untaken', async () => {
    drain.registerExecutor('rename', () => ({failed: 'the engine refused it (HTTP 404)'}));
    const r = put('rename', {paneId: 'p', name: 'n', before: 'o'}, 'rename:p');
    const d = put('rename', {paneId: 'q', name: 'n', before: 'o'}, 'rename:q');
    const takenR = drain.whenTaken(r.id);
    const takenD = drain.whenTaken(d.id);
    let doneR: boolean | null = null;
    let doneD: boolean | null = null;
    void takenR.then((ok) => (doneR = ok));
    void takenD.then((ok) => (doneD = ok));
    settle();
    await tick();
    expect(intents.get(r.id)?.state).toBe('failed');
    expect(intents.get(d.id)?.state).toBe('failed');
    expect(doneR).toBeNull();
    expect(doneD).toBeNull();
    // Refused again on the retry tap: still following.
    drain.requeue(r.id);
    await tick();
    expect(doneR).toBeNull();
    // The next retry lands: taken.
    drain.registerExecutor('rename', () => 'done');
    drain.requeue(r.id);
    await tick();
    expect(doneR).toBe(true);
    expect(intents.get(r.id)).toBeUndefined();
    // The user discards the other: gone untaken.
    drain.drop(d.id);
    await tick();
    expect(doneD).toBe(false);
    // A row that is not there is already taken.
    await expect(drain.whenTaken('never')).resolves.toBe(true);
  });

  test("waiting: a send whose transfer is moving holds only its session's later sends; a rename passes it, the result kicks", async () => {
    let bytesMoving = true;
    drain.registerExecutor('send-voice', (i) => {
      calls.push(i.id);
      return bytesMoving ? 'waiting' : 'done';
    });
    drain.registerExecutor('send-text', (i) => {
      calls.push(i.id);
      return 'done';
    });
    drain.registerExecutor('rename', (i) => {
      calls.push(i.id);
      return 'done';
    });
    const v = put('send-voice', {cid: 'v'});
    vi.setSystemTime(Date.now() + 1);
    const t = put('send-text', {cid: 't'});
    vi.setSystemTime(Date.now() + 1);
    const r = put('rename', {paneId: 'p', name: 'n', before: 'o'}, 'rename:p');
    settle();
    await tick();
    // The rename never waits behind a send, so it drained; the voice note's
    // bytes are still moving, so it and the text behind it (same session)
    // stay. No timer polls for the waiting head.
    expect(calls).toEqual([r.id, v.id]);
    expect(intents.get(r.id)).toBeUndefined();
    expect(intents.get(v.id)?.state).toBe('queued');
    expect(intents.get(t.id)?.state).toBe('queued');
    expect(vi.getTimerCount()).toBe(0);
    // The transfer finishes: its result kicks the drain and the session's two
    // sends go in store order.
    bytesMoving = false;
    drain.kick(K);
    await tick();
    expect(calls).toEqual([r.id, v.id, v.id, t.id]);
    expect(intents.all()).toEqual([]);
  });

  test('a head refused while it waits on its bytes never holds the rows behind it', async () => {
    // The voice note's transfer is moving (waiting); the engine then refuses
    // the bytes for good (a 413), which reaches the drain as fail(owner).
    // Nothing else kicks: the text behind it must go on that failure alone.
    drain.registerExecutor('send-voice', (i) => {
      calls.push(i.id);
      return 'waiting';
    });
    drain.registerExecutor('send-text', (i) => {
      calls.push(i.id);
      return 'done';
    });
    const v = put('send-voice', {cid: 'v'});
    vi.setSystemTime(Date.now() + 1);
    const t = put('send-text', {cid: 't'});
    settle();
    await tick();
    expect(calls).toEqual([v.id]);
    expect(drain.inflightOf(K)).toBeUndefined();
    expect(intents.get(t.id)?.state).toBe('queued');
    drain.fail(v.id, 'too large (over 1 KB)');
    await tick();
    expect(intents.get(v.id)).toMatchObject({state: 'failed', lastError: 'too large (over 1 KB)'});
    expect(calls).toEqual([v.id, t.id]);
    expect(intents.get(t.id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a head discarded while it waits on its bytes frees the rows behind it', async () => {
    drain.registerExecutor('send-voice', (i) => {
      calls.push(i.id);
      return 'waiting';
    });
    drain.registerExecutor('send-text', (i) => {
      calls.push(i.id);
      return 'done';
    });
    const v = put('send-voice', {cid: 'v'});
    vi.setSystemTime(Date.now() + 1);
    const t = put('send-text', {cid: 't'});
    settle();
    await tick();
    expect(calls).toEqual([v.id]);
    drain.drop(v.id);
    await tick();
    expect(intents.get(v.id)).toBeUndefined();
    expect(calls).toEqual([v.id, t.id]);
    expect(intents.get(t.id)).toBeUndefined();
  });

  test('settled for a row another tab erased still frees the slot it held in flight', async () => {
    drain.registerExecutor('send-text', (i) => {
      calls.push(i.id);
      return 'inflight';
    });
    const a = put('send-text', {cid: 'a'});
    vi.setSystemTime(Date.now() + 1);
    const b = put('send-text', {cid: 'b'});
    settle();
    await tick();
    expect(drain.inflightOf(K)).toBe(a.id);
    // Another tab erased the row (a remote gone) before this tab's ack landed.
    intents.remove(a.id);
    drain.settled(a.id);
    await tick();
    expect(calls).toEqual([a.id, b.id]);
    expect(drain.inflightOf(K)).toBe(b.id);
  });

  test('an executor that throws is transient, not a failure', async () => {
    drain.registerExecutor('rename', () => {
      throw new Error('boom');
    });
    const r = put('rename', {paneId: 'p', name: 'n', before: 'o'}, 'rename:p');
    settle();
    await tick();
    expect(intents.get(r.id)?.state).toBe('queued');
    expect(drain.activeTimers()).toBe(1);
  });

  test('global settings drain under the app key whenever any engine is reachable', async () => {
    drain.registerExecutor('global-settings', (i) => {
      calls.push(i.id);
      return 'done';
    });
    const g = put('global-settings', {patch: {speed: 2}}, 'gset:app', APP_ENGINE_KEY);
    drain.kick(APP_ENGINE_KEY);
    await tick();
    expect(calls).toEqual([]);
    expect(drain.reachable(APP_ENGINE_KEY)).toBe(false);
    settle();
    await tick();
    expect(calls).toEqual([g.id]);
  });

  test('the owed count reaches the sync seam: a settled engine with rows is draining, empty is live', () => {
    settle();
    expect(sync.engineState(K)).toBe('live');
    const r = put('rename', {paneId: 'p', name: 'n', before: 'o'}, 'rename:p');
    expect(sync.engineState(K)).toBe('draining');
    intents.remove(r.id);
    expect(sync.engineState(K)).toBe('live');
  });
});

describe('drain: one send in flight per session, reads never wait behind sends (F1)', () => {
  const calls: string[] = [];
  const A_SID = `${K}|pane-A`;
  const B_SID = `${K}|pane-B`;
  let seq = 0;
  function send(sid: string, cid: string) {
    return intents.put({
      id: cid,
      engineKey: K,
      sessionId: sid,
      kind: 'send-text',
      payload: {cid, sessionId: sid, ts: Date.now(), text: cid, kind: 'text', wire: cid}
    });
  }
  function progress(sid: string) {
    return intents.put({
      id: `pr${seq++}`,
      engineKey: K,
      sessionId: sid,
      kind: 'progress',
      coalesceKey: `progress:${sid}`,
      payload: {paneId: sid, seq: 1, explicit: false}
    });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    seq = 0;
    intents.__resetForTest();
    sync.__resetForTest();
    drain.__resetForTest(() => 0.5);
    drain.registerExecutor('send-text', (i) => {
      calls.push(i.id);
      return 'inflight';
    });
    drain.registerExecutor('progress', (i) => {
      calls.push(i.id);
      return 'done';
    });
  });
  afterEach(() => {
    drain.__resetForTest();
    vi.useRealTimers();
  });

  test('a stuck send to A does not hold B; each session gets one send in flight (round-robin)', async () => {
    const a1 = send(A_SID, 'a1');
    vi.setSystemTime(Date.now() + 1);
    const a2 = send(A_SID, 'a2');
    vi.setSystemTime(Date.now() + 1);
    const b1 = send(B_SID, 'b1');
    settle();
    await tick();
    // One send each for A and B goes in flight; A's second waits behind A's
    // first, not behind B. A stuck head on A holds only A.
    expect(calls).toEqual([a1.id, b1.id]);
    expect(intents.get(a1.id)?.state).toBe('inflight');
    expect(intents.get(b1.id)?.state).toBe('inflight');
    expect(intents.get(a2.id)?.state).toBe('queued');
    // A's first settles: A's second goes now; B's is still in flight.
    drain.settled(a1.id);
    await tick();
    expect(calls).toEqual([a1.id, b1.id, a2.id]);
    expect(intents.get(a2.id)?.state).toBe('inflight');
    expect(drain.inflightOf(K)).toBeDefined();
  });

  test('a read mark lands while a send is stuck in flight (read-progress never waits behind a send)', async () => {
    const a1 = send(A_SID, 'a1');
    vi.setSystemTime(Date.now() + 1);
    const pr = progress(B_SID);
    settle();
    await tick();
    // The read mark drained though A's send is still in flight and never acks.
    expect(intents.get(a1.id)?.state).toBe('inflight');
    expect(intents.get(pr.id)).toBeUndefined();
    expect(calls).toEqual([pr.id, a1.id]);
    // A read mark on the SAME session as the stuck send lands too.
    const pr2 = progress(A_SID);
    drain.kick(K);
    await tick();
    expect(intents.get(pr2.id)).toBeUndefined();
    expect(intents.get(a1.id)?.state).toBe('inflight');
  });

  test('within a session, sends go one at a time in store order', async () => {
    const a1 = send(A_SID, 'a1');
    vi.setSystemTime(Date.now() + 1);
    const a2 = send(A_SID, 'a2');
    vi.setSystemTime(Date.now() + 1);
    const a3 = send(A_SID, 'a3');
    settle();
    await tick();
    expect(calls).toEqual([a1.id]);
    drain.settled(a1.id);
    await tick();
    expect(calls).toEqual([a1.id, a2.id]);
    drain.settled(a2.id);
    await tick();
    expect(calls).toEqual([a1.id, a2.id, a3.id]);
    drain.settled(a3.id);
    await tick();
    expect(intents.all()).toEqual([]);
  });

  test("the pipe going down owes every session's in-flight send again", async () => {
    const a1 = send(A_SID, 'a1');
    vi.setSystemTime(Date.now() + 1);
    const b1 = send(B_SID, 'b1');
    settle();
    await tick();
    expect(intents.get(a1.id)?.state).toBe('inflight');
    expect(intents.get(b1.id)?.state).toBe('inflight');
    sync.noteDown(K);
    expect(intents.get(a1.id)?.state).toBe('queued');
    expect(intents.get(b1.id)?.state).toBe('queued');
    expect(drain.inflightOf(K)).toBeUndefined();
  });
});

describe('cyc-clips v6: outbox rows become intents', () => {
  type Fake = {
    names: Set<string>;
    created: string[];
    indexes: string[];
    deleted: string[];
    outbox: unknown[];
    intents: unknown[];
  };
  function fakeDb(
    names: string[],
    outbox: unknown[] = []
  ): {db: Fake; d: Parameters<typeof upgradeClipsDb>[0]; tx: Parameters<typeof upgradeClipsDb>[1]} {
    const db: Fake = {
      names: new Set(names),
      created: [],
      indexes: [],
      deleted: [],
      outbox,
      intents: []
    };
    const d = {
      objectStoreNames: {contains: (n: string) => db.names.has(n)} as DOMStringList,
      createObjectStore: (n: string) => {
        db.names.add(n);
        db.created.push(n);
        return {
          createIndex: (name: string) => {
            db.indexes.push(`${n}.${name}`);
          }
        } as unknown as IDBObjectStore;
      },
      deleteObjectStore: (n: string) => {
        db.names.delete(n);
        db.deleted.push(n);
      }
    };
    const tx = {
      objectStore: (n: string) => ({
        openCursor: () => {
          let at = 0;
          const req = {
            result: null as unknown,
            onsuccess: null as (() => void) | null,
            onerror: null as (() => void) | null
          };
          const step = () => {
            if (at >= db.outbox.length) {
              req.result = null;
            } else {
              const value = db.outbox[at++];
              req.result = {
                value,
                continue: () => step()
              };
            }
            req.onsuccess?.();
          };
          queueMicrotask(step);
          return req as unknown as IDBRequest<IDBCursorWithValue | null>;
        },
        put: (v: unknown) => {
          if (n === INTENTS) db.intents.push(v);
          return {} as IDBRequest<IDBValidKey>;
        }
      })
    };
    return {db, d, tx};
  }

  test('a v5 db with a legacy failed outbox row: intents store + indexes, the row queued, the outbox deleted', async () => {
    const failed = {
      cid: 'c-old',
      sessionId: 'ws://old/ws|pane-9',
      ts: 1_700_000_000_000,
      text: 'still owed',
      kind: 'text',
      wire: 'still owed',
      state: 'failed',
      failReason: 'Failed to fetch',
      attempts: 3
    };
    const {db, d, tx} = fakeDb(
      ['clips', 'compositions', 'images', 'transfers', 'outbox'],
      [failed]
    );
    upgradeClipsDb(d, tx);
    await Promise.resolve();
    await Promise.resolve();
    expect(db.created).toEqual([INTENTS]);
    expect(db.indexes).toEqual([`${INTENTS}.bySession`, `${INTENTS}.byEngine`]);
    expect(db.intents).toEqual([
      {
        id: 'c-old',
        engineKey: 'ws://old/ws',
        sessionId: 'ws://old/ws|pane-9',
        kind: 'send-text',
        payload: failed,
        createdAt: 1_700_000_000_000,
        attempts: 3,
        state: 'queued'
      }
    ]);
    expect(db.deleted).toEqual(['outbox']);
    expect(db.names.has('outbox')).toBe(false);
  });

  test('a v4 db (no transfers, an outbox): every missing store is created, then the outbox walks', async () => {
    const voice = {
      cid: 'v1',
      sessionId: 'ws://e/ws|p',
      ts: 5,
      text: '',
      kind: 'voice',
      wire: '',
      clipKey: 'v1',
      transferKey: 'v1'
    };
    const files = {
      cid: 'f1',
      sessionId: 'ws://e/ws|p',
      ts: 6,
      text: 'see',
      kind: 'text',
      wire: 'see',
      transferKeys: ['a', 'b']
    };
    const {db, d, tx} = fakeDb(
      ['clips', 'compositions', 'images', 'outbox'],
      [voice, files, {junk: true}]
    );
    upgradeClipsDb(d, tx);
    await Promise.resolve();
    await Promise.resolve();
    expect(db.created).toEqual(['transfers', INTENTS]);
    expect(db.intents.map((i) => (i as {kind: string}).kind)).toEqual(['send-voice', 'send-files']);
    expect(db.deleted).toEqual(['outbox']);
  });

  test('a fresh db creates every store and no outbox walk happens', () => {
    const {db, d, tx} = fakeDb([]);
    upgradeClipsDb(d, tx);
    expect(db.created).toEqual(['clips', 'compositions', 'images', 'transfers', INTENTS]);
    expect(db.deleted).toEqual([]);
  });

  test('intentFromOutbox refuses a row without a cid or session', () => {
    expect(intentFromOutbox(null)).toBeNull();
    expect(intentFromOutbox({cid: '', sessionId: 'x'})).toBeNull();
    expect(intentFromOutbox({cid: 'c', ts: 1})).toBeNull();
  });
});

describe('hydrate reaps definitively dead sends (predicate)', () => {
  const now = 1_800_000_000_000;
  const row = (over: Partial<intents.Intent> = {}): intents.Intent =>
    ({
      id: 'i',
      engineKey: K,
      sessionId: SID,
      kind: 'send-text',
      payload: {},
      createdAt: now - 3 * 24 * 3600_000,
      attempts: 2,
      state: 'failed',
      lastError: 'no such session on this engine',
      ...over
    }) as intents.Intent;

  test('only an OLD, FAILED, no-such-session send is dead', () => {
    expect(intents.definitivelyDead(row(), now)).toBe(true);
    // young: a reconnect might still be racing; keep it
    expect(intents.definitivelyDead(row({createdAt: now - 3600_000}), now)).toBe(false);
    // a different failure is not proof the session key is gone
    expect(intents.definitivelyDead(row({lastError: 'HTTP 500'}), now)).toBe(false);
    // queued rows are live work, never reaped for age (offline design v2)
    expect(intents.definitivelyDead(row({state: 'queued', lastError: undefined}), now)).toBe(false);
    // exactly at the horizon is still kept; strictly past it goes
    expect(intents.definitivelyDead(row({createdAt: now - intents.REAP_AFTER_MS}), now)).toBe(
      false
    );
    expect(intents.definitivelyDead(row({createdAt: now - intents.REAP_AFTER_MS - 1}), now)).toBe(
      true
    );
  });
});
