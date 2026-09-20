import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as sync from '../engine/sync';
import {attach, detachChat, start, stop} from '../engine/store';
import {conns, sessions, seen, type Conn} from '../engine/store/registry';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow} from '../engine/store/rows/core';
import {__resetReplicatorsForTest} from '../engine/store/rows/repl';
import {memTx} from './rowStoreFake';
import type {CycEngineMessage, CycEngineSession} from '../engine/store/types';

// The open chat's held tail is the row store's now; the frontier a re-attach
// asks with is the highest seq the store holds. Seed seqs 0..1 so it is 1.
async function seedFrontier(sid: string) {
  await rowStore.upsert(sid, [messageRow(sid, msg(0)), messageRow(sid, msg(1))]);
}

/* The push-poke (bg-refresh, deferred piece now wired): a push that lands
 * while the app is OPEN makes the worker message its matched window clients
 * with a content-free {t: 'sync-poke'} (+ the envelope's sessionId when it
 * names exactly one), and the page answers with its EXISTING catch-up
 * (catchUpOpenChat: one frontier attach, idempotent). Both halves
 * are pinned here: the worker rig loads the real public/cyc-sw.js (the same
 * way cycSwNotifIcon.test.ts does), the page rig drives the real store the
 * way cycBgRefresh.test.ts does. */

// --------------------------- the worker's half ------------------------------

type PushEvent = {data: {json: () => unknown}; waitUntil: (p: Promise<unknown>) => void};
type SwGlobals = {
  cycPokeSessionId: (data: unknown) => string;
  cycPokeClients: (sessionId: string) => Promise<void>;
};

function loadWorker(matched: () => unknown[]) {
  const order: string[] = [];
  let pushHandler: ((event: PushEvent) => void) | undefined;
  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: PushEvent) => void) => {
      if (type === 'push') pushHandler = fn;
    },
    navigator: {userAgent: 'vitest'},
    registration: {
      showNotification: (title: string) => {
        order.push('notify:' + title);
      },
      getNotifications: async (): Promise<unknown[]> => []
    },
    clients: {claim: async () => {}, matchAll: async () => matched()},
    skipWaiting: () => {}
  };
  const code = readFileSync(resolve(process.cwd(), 'public/cyc-sw.js'), 'utf8');
  new Function('self', code)(fakeSelf);
  const push = async (data: unknown) => {
    let settled: Promise<unknown> = Promise.resolve();
    pushHandler!({
      data: {json: () => data},
      waitUntil: (p) => {
        settled = p;
      }
    });
    await settled;
  };
  return {sw: fakeSelf as unknown as SwGlobals, push, order};
}

function fakeWindowClient(order: string[], name: string) {
  return {
    postMessage: vi.fn((m: unknown) => {
      order.push('poke:' + name + ':' + JSON.stringify(m));
    })
  };
}

describe('worker half: a push with the app open pokes every matched client', () => {
  test('a single-session push pokes each client once, targeted, AFTER the notification', async () => {
    const clients: unknown[] = [];
    const {push, order} = loadWorker(() => clients);
    const c1 = fakeWindowClient(order, 'c1');
    const c2 = fakeWindowClient(order, 'c2');
    clients.push(c1, c2);

    await push({sessionId: 'sess-9', title: 'T', body: 'b'});

    expect(c1.postMessage).toHaveBeenCalledTimes(1);
    expect(c1.postMessage).toHaveBeenCalledWith({t: 'sync-poke', sessionId: 'sess-9'});
    expect(c2.postMessage).toHaveBeenCalledTimes(1);
    // the notification work ran first; the poke rides behind it
    expect(order[0]).toBe('notify:T');
    expect(order.filter((o) => o.startsWith('poke:'))).toHaveLength(2);
    // sealed model: the poke names the session and NOTHING else
    const sent = c1.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['sessionId', 't']);
  });

  test('a batch push targets only when it names exactly one session', async () => {
    const clients: unknown[] = [];
    const {push, order, sw} = loadWorker(() => clients);
    const c1 = fakeWindowClient(order, 'c1');
    clients.push(c1);

    await push({
      t: 'batch',
      sessions: [
        {sessionId: 'sa', title: 'A', body: 'x'},
        {sessionId: 'sb', title: 'B', body: 'y'}
      ]
    });
    expect(c1.postMessage).toHaveBeenCalledTimes(1); // ONE poke per push event
    expect(c1.postMessage).toHaveBeenCalledWith({t: 'sync-poke'}); // untargeted

    c1.postMessage.mockClear();
    await push({t: 'batch', sessions: [{sessionId: 'sa', title: 'A', body: 'x'}]});
    expect(c1.postMessage).toHaveBeenCalledTimes(1);
    expect(c1.postMessage).toHaveBeenCalledWith({t: 'sync-poke', sessionId: 'sa'});

    // the extractor itself, pinned
    expect(sw.cycPokeSessionId({sessionId: 's1'})).toBe('s1');
    expect(sw.cycPokeSessionId({t: 'batch', sessions: [{sessionId: 'a'}, {sessionId: 'b'}]})).toBe(
      ''
    );
    expect(sw.cycPokeSessionId({})).toBe('');
    expect(sw.cycPokeSessionId(null)).toBe('');
  });

  test('a dismiss push (read elsewhere) still pokes: the page re-syncs its badges', async () => {
    const clients: unknown[] = [];
    const {push, order} = loadWorker(() => clients);
    const c1 = fakeWindowClient(order, 'c1');
    clients.push(c1);

    await push({dismiss: true, sessionId: 'sess-3'});
    expect(c1.postMessage).toHaveBeenCalledWith({t: 'sync-poke', sessionId: 'sess-3'});
  });

  test('no matched clients, or a failing matchAll: the push work still settles', async () => {
    const {push} = loadWorker(() => []);
    await expect(push({sessionId: 's', title: 'T', body: 'b'})).resolves.toBeUndefined();

    const {push: pushBroken} = loadWorker(() => {
      throw new Error('no clients api');
    });
    await expect(pushBroken({sessionId: 's', title: 'T', body: 'b'})).resolves.toBeUndefined();
  });
});

// ---------------------------- the page's half -------------------------------

const KEY = 'ws://sw-poke.test:7792/ws';

let hidden = false;
Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
function flip(to: boolean) {
  hidden = to;
  document.dispatchEvent(new Event('visibilitychange'));
}

const swListeners = new Set<(e: MessageEvent) => void>();
Object.defineProperty(navigator, 'serviceWorker', {
  configurable: true,
  value: {
    addEventListener: (_t: string, fn: (e: MessageEvent) => void) => swListeners.add(fn),
    removeEventListener: (_t: string, fn: (e: MessageEvent) => void) => swListeners.delete(fn)
  }
});
function poke(sessionId?: string) {
  const data = sessionId ? {t: 'sync-poke', sessionId} : {t: 'sync-poke'};
  for (const fn of [...swListeners]) fn({data} as MessageEvent);
}

function fakeClient() {
  return {
    connect: vi.fn(),
    close: vi.fn(),
    detach: vi.fn(),
    attach: vi.fn(),
    setSessionTail: vi.fn(),
    verifyPipe: vi.fn(),
    setVisible: vi.fn(),
    fetchSessionAgents: vi.fn(() => Promise.resolve([])),
    on: vi.fn()
  };
}

function plantConn(client = fakeClient()) {
  const conn = {
    key: KEY,
    client,
    state: 'connected',
    user: 'u',
    host: 'h',
    hostname: 'h',
    tabs: [],
    plugins: [],
    voiceHealthy: true,
    helloSettled: true
  } as unknown as Conn;
  conns.push(conn);
  return {conn, client};
}

const msg = (seq: number): CycEngineMessage =>
  ({
    id: 'm-' + (seq + 1),
    role: 'claude',
    kind: 'text',
    text: 'm' + seq,
    ts: 1000 + seq,
    seq
  }) as CycEngineMessage;

function plantSession(paneId: string): CycEngineSession {
  const s = {
    id: KEY + '|' + paneId,
    engineKey: KEY,
    paneId,
    tabKey: '',
    name: paneId,
    cwd: '',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [msg(0), msg(1)],
    claudeSessionId: null,
    events: [],
    agentRuns: [],
    engineTotal: 2,
    frontier: 1
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}

function settle() {
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('page half: the poke runs the existing catch-up, on its discipline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    hidden = false;
    sessions.clear();
    seen.clear();
    conns.length = 0;
    rowStore.__setBackingForTest(memTx().tx);
    sync.__resetLiveForTest(() => 0.5);
  });

  afterEach(() => {
    stop();
    detachChat();
    conns.length = 0;
    sessions.clear();
    seen.clear();
    sync.__resetLiveForTest();
    rowStore.__setBackingForTest(null);
    __resetReplicatorsForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('one poke, one catch-up: the open chat is re-attached with what the app holds', async () => {
    const {client} = plantConn();
    const s = plantSession('p1');
    await seedFrontier(s.id);
    settle();
    attach(s.id);
    await flush();
    start();
    client.attach.mockClear();
    client.verifyPipe.mockClear();

    poke(); // untargeted "sync now"
    expect(client.attach).toHaveBeenCalledTimes(1);
    expect(client.attach).toHaveBeenCalledWith('p1', 1);
    expect(client.verifyPipe).toHaveBeenCalled(); // the push proved the engine spoke; the pipe must too

    client.attach.mockClear();
    poke(s.id); // targeted at the open chat: same single catch-up
    expect(client.attach).toHaveBeenCalledTimes(1);
  });

  test('a poke naming some OTHER chat challenges the pipes but does not churn the open chat', async () => {
    const {client} = plantConn();
    const s = plantSession('p1');
    plantSession('p2');
    settle();
    attach(s.id);
    await flush();
    start();
    client.attach.mockClear();
    client.verifyPipe.mockClear();

    poke(KEY + '|p2');
    expect(client.attach).not.toHaveBeenCalled();
    expect(client.verifyPipe).toHaveBeenCalled();
  });

  test('hidden, a poke is a no-op; the visible edge already owes the catch-up', async () => {
    const {client} = plantConn();
    const s = plantSession('p1');
    await seedFrontier(s.id);
    settle();
    attach(s.id);
    await flush();
    start();
    flip(true);
    client.attach.mockClear();
    client.verifyPipe.mockClear();

    poke();
    poke(s.id);
    expect(client.attach).not.toHaveBeenCalled();
    expect(client.verifyPipe).not.toHaveBeenCalled();

    flip(false); // the deferral cashes out here: foregroundReturn catches up
    expect(client.attach).toHaveBeenCalledTimes(1);
    expect(client.attach).toHaveBeenCalledWith('p1', 1);
  });

  test('after stop() the listener is gone: a poke reaches nothing', async () => {
    const {client} = plantConn();
    const s = plantSession('p1');
    settle();
    attach(s.id);
    await flush();
    start();
    stop();
    client.attach.mockClear();

    poke();
    expect(client.attach).not.toHaveBeenCalled();
    expect(swListeners.size).toBe(0);
  });
});
