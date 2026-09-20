import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {renameSession, reorderSessions, wireSessionOps} from '../engine/store/sessionOps';
import {list} from '../engine/store';
import {sessions} from '../engine/store/registry';
import type {CycEngineSession} from '../engine/store/types';
import {setEngineTunnel, clearEngineTunnel, type EngineTunnel} from '../engine/contract';
import * as intents from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';

const WS = 'ws://engine-a.test:7788/ws';
const BASE = 'http://engine-a.test:7788';

function seed(paneId: string): CycEngineSession {
  const s = {
    id: WS + '|' + paneId,
    engineKey: WS,
    paneId,
    tabKey: '',
    name: paneId,
    cwd: '',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}

// A reorder is an intent (offline design v2, section 3): the rows take the
// new order at once, the POST goes through the drain when the engine is
// reachable, a definitive refusal restores the old order.
describe('reorderSessions persists the new order through the sealed tunnel', () => {
  let calls: {url: string; init?: RequestInit}[];
  let status = 200;
  const tunnel: EngineTunnel = {
    ready: () => true,
    fetch: (url, init) => {
      calls.push({url, init});
      return Promise.resolve(new Response('{}', {status}));
    },
    whenReady: () => Promise.resolve(true)
  };

  function settle() {
    sync.noteSealed(WS);
    sync.noteHost(WS);
    sync.noteSessions(WS);
  }

  beforeEach(() => {
    calls = [];
    status = 200;
    sessions.clear();
    intents.__resetForTest();
    sync.__resetLiveForTest();
    drain.__resetForTest(() => 0.5);
    setEngineTunnel(BASE, tunnel);
  });
  afterEach(() => {
    drain.__resetForTest();
    clearEngineTunnel(BASE);
    sessions.clear();
  });

  test('POSTs /sessions/order with the reordered paneIds and resolves true when the engine took it', async () => {
    settle();
    const a = seed('p1');
    const b = seed('p2');
    const c = seed('p3');
    // The live list is the current on-screen order; the drag moved p3 to the top.
    wireSessionOps({list: () => [a, b, c]});

    const done = await reorderSessions([c.id, a.id, b.id]);

    expect(done).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(BASE + '/sessions/order');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init?.body)) as {order: string[]};
    expect(body.order).toEqual(['p3', 'p1', 'p2']);
    expect([c.order, a.order, b.order]).toEqual([0, 1, 2]);
    expect(intents.all()).toHaveLength(0);
  });

  test('offline: the rows take the order at once, the POST waits for the settled edge', async () => {
    const a = seed('p1');
    const b = seed('p2');
    wireSessionOps({list: () => [a, b]});

    const pending = reorderSessions([b.id, a.id]);
    expect([b.order, a.order]).toEqual([0, 1]);
    expect(calls).toHaveLength(0);
    expect(intents.queuedFor(WS)).toHaveLength(1);

    settle();
    expect(await pending).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('two reorders before the edge coalesce into one POST carrying the last order', async () => {
    const a = seed('p1');
    const b = seed('p2');
    const c = seed('p3');
    wireSessionOps({list: () => [a, b, c]});
    void reorderSessions([b.id, a.id, c.id]);
    const last = reorderSessions([c.id, b.id, a.id]);
    expect(intents.queuedFor(WS)).toHaveLength(1);
    settle();
    expect(await last).toBe(true);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init?.body)) as {order: string[]};
    expect(body.order).toEqual(['p3', 'p2', 'p1']);
  });

  test('a definitive refusal (4xx) resolves false and restores the order the rows had', async () => {
    settle();
    const a = seed('p1');
    const b = seed('p2');
    a.order = 0;
    b.order = 1;
    wireSessionOps({list: () => [a, b]});
    status = 400;

    expect(await reorderSessions([b.id, a.id])).toBe(false);
    const body = JSON.parse(String(calls[0].init?.body)) as {order: string[]};
    expect(body.order).toEqual(['p2', 'p1']);
    expect([a.order, b.order]).toEqual([0, 1]);
    expect(intents.all()[0]).toMatchObject({kind: 'reorder', state: 'failed'});
  });

  test('a transient answer (5xx) keeps the intent queued and the new order shown', async () => {
    vi.useFakeTimers();
    try {
      settle();
      const a = seed('p1');
      const b = seed('p2');
      wireSessionOps({list: () => [a, b]});
      status = 503;
      let settled: boolean | undefined;
      void reorderSessions([b.id, a.id]).then((v) => (settled = v));
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(1);
      expect(settled).toBeUndefined();
      expect(intents.queuedFor(WS)).toHaveLength(1);
      expect([b.order, a.order]).toEqual([0, 1]);
      // One jittered retry while the engine stays up: it goes through.
      status = 200;
      await vi.advanceTimersByTimeAsync(1_001);
      expect(calls).toHaveLength(2);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A rename is an intent too. The engine always sends a title (it resolves the
// rename override into title.text) and the list row reads title.text, so the
// local apply paints the title as well as the name, and a refusal restores both.
describe('renameSession applies to the title the row shows', () => {
  let calls: {url: string; init?: RequestInit}[];
  let status = 200;
  const tunnel: EngineTunnel = {
    ready: () => true,
    fetch: (url, init) => {
      calls.push({url, init});
      return Promise.resolve(new Response('{}', {status}));
    },
    whenReady: () => Promise.resolve(true)
  };

  beforeEach(() => {
    calls = [];
    status = 200;
    sessions.clear();
    intents.__resetForTest();
    sync.__resetLiveForTest();
    drain.__resetForTest(() => 0.5);
    setEngineTunnel(BASE, tunnel);
  });
  afterEach(() => {
    drain.__resetForTest();
    clearEngineTunnel(BASE);
    sessions.clear();
  });

  test('offline: name and title.text change at once; the POST goes on the settled edge', async () => {
    const s = seed('p1');
    s.title = {text: 'Claude picked this', detail: null};

    const pending = renameSession(s.id, 'mine');
    expect(s.name).toBe('mine');
    expect(s.title).toEqual({text: 'mine', detail: null});
    expect(calls).toHaveLength(0);

    sync.noteSealed(WS);
    sync.noteHost(WS);
    sync.noteSessions(WS);
    expect(await pending).toBe(true);
    expect(calls[0].url).toBe(BASE + '/session/p1/rename');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({name: 'mine'});
  });

  test('a definitive refusal restores the exact title the engine had sent, not the old name', async () => {
    sync.noteSealed(WS);
    sync.noteHost(WS);
    sync.noteSessions(WS);
    const s = seed('p1');
    s.title = {text: 'Claude picked this', detail: null};
    status = 400;

    expect(await renameSession(s.id, 'mine')).toBe(false);
    expect(s.name).toBe('p1');
    expect(s.title).toEqual({text: 'Claude picked this', detail: null});
  });
});

describe('a persisted order is restored into the list on load', () => {
  beforeEach(() => sessions.clear());
  afterEach(() => sessions.clear());

  test('list() sorts by the engine-echoed order index, so a saved rearrangement survives', () => {
    // Sessions arrive/hydrate in an arbitrary order; each carries the `order`
    // index the engine persisted, which is what a reorder wrote.
    seed('p1').order = 2;
    seed('p2').order = 0;
    seed('p3').order = 1;

    expect(list().map((s) => s.paneId)).toEqual(['p2', 'p3', 'p1']);
  });
});
