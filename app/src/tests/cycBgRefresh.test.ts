/* THE MISSING BACKGROUND REFRESH (fix-bg-refresh).
 *
 * Cache-first paint is fine; the open app must also catch itself up. The live
 * sealed channel delivers instantly while the pipe is healthy, so the gap is
 * the pipe LYING: silently dead after a pocket nap, or a delta that slipped
 * by while the app sat open. These pin the catch-up triggers end to end:
 *
 *   foreground return  -> exactly one frontier-attach of the open chat (and a
 *                         forced liveness probe of every pipe), none hidden
 *   PWA resume         -> the same catch-up on pageshow(persisted)
 *   the safety net     -> re-attaches the ACTIVE session only, only visible,
 *                         paused entirely while hidden
 *   no-change attach-ok-> pages: [] adds nothing, admits nothing, writes no
 *                         page (the engine side of that answer is pinned in
 *                         engine/agent-engine/src/chat/ack.test.ts)
 *   dead pipe          -> the forced probe goes unanswered, the pipe is
 *                         presumed dead, the manager is asked to redial
 *
 *   bun run test --run src/tests/cycBgRefresh.test.ts
 */
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import * as sync from '../engine/sync';
import * as history from '../engine/history';
import {attach, detachChat, start, stop, BG_RESYNC_MS} from '../engine/store';
import {conns, sessions, seen, type Conn} from '../engine/store/registry';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow} from '../engine/store/rows/core';
import {__resetReplicatorsForTest} from '../engine/store/rows/repl';
import {memTx} from './rowStoreFake';
import {wireChat} from '../engine/store/handlers/chat';
import type {HandlerCtx} from '../engine/store/handlers/types';
import type {CycEngineMessage, CycEngineSession} from '../engine/store/types';
import {WsEngineClient} from '../engine/client';

const KEY = 'ws://bg-refresh.test:7791/ws';

// jsdom's document.hidden is read-only; route it through a switch.
let hidden = false;
Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});

function flip(to: boolean) {
  hidden = to;
  document.dispatchEvent(new Event('visibilitychange'));
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

// Two messages, seqs 0..1, total 2: frontier is 1 (engine-confirmed through 1).
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

// The open chat's held tail is now the row store's, so the frontier a re-attach
// asks with is the highest seq the store holds. Seed seqs 0..1 so it is 1.
async function seedFrontier(sid: string) {
  await rowStore.upsert(sid, [messageRow(sid, msg(0)), messageRow(sid, msg(1))]);
}

// attach() paints the cache in an async IIFE before it asks the engine.
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

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

describe('foreground return catches the open chat up', () => {
  test('a visible transition re-attaches the open chat once, with what the app holds', async () => {
    const {client} = plantConn();
    const s = plantSession('p1');
    await seedFrontier(s.id);
    settle();
    attach(s.id);
    await flush();
    expect(client.attach).toHaveBeenCalledTimes(1); // the open itself
    client.attach.mockClear();

    start();
    flip(true);
    expect(client.attach).not.toHaveBeenCalled(); // hidden asks for nothing

    flip(false);
    expect(client.attach).toHaveBeenCalledTimes(1);
    expect(client.attach).toHaveBeenCalledWith('p1', 1);
    // Every pipe that only LOOKS alive is challenged on the same edge.
    expect(client.verifyPipe).toHaveBeenCalled();
  });

  test('a PWA resume (pageshow persisted) runs the same catch-up', async () => {
    const {client} = plantConn();
    const s = plantSession('p1');
    await seedFrontier(s.id);
    settle();
    attach(s.id);
    await flush();
    start();
    client.attach.mockClear();
    client.verifyPipe.mockClear();

    const notRestored = new Event('pageshow'); // a normal load: no catch-up
    window.dispatchEvent(notRestored);
    expect(client.attach).not.toHaveBeenCalled();

    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', {value: true});
    window.dispatchEvent(restored);
    expect(client.attach).toHaveBeenCalledTimes(1);
    expect(client.attach).toHaveBeenCalledWith('p1', 1);
    expect(client.verifyPipe).toHaveBeenCalled();
  });

  test('an unreachable engine gets no attach; the settled edge owns that catch-up', async () => {
    const {client} = plantConn();
    const s = plantSession('p1');
    sync.noteDown(KEY); // the engine is down: visible must not attach into the void
    attach(s.id);
    await flush();
    start();
    client.attach.mockClear();

    flip(true);
    flip(false);
    expect(client.attach).not.toHaveBeenCalled();
  });
});

describe('the periodic safety net while the app sits open', () => {
  test('ticks only while visible, only for the active session, and pauses hidden', async () => {
    const {client} = plantConn();
    const s1 = plantSession('p1');
    plantSession('p2'); // open in the list, NOT attached: never re-asked
    settle();
    attach(s1.id);
    await flush();
    start();
    client.attach.mockClear();

    await vi.advanceTimersByTimeAsync(BG_RESYNC_MS);
    expect(client.attach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BG_RESYNC_MS);
    expect(client.attach).toHaveBeenCalledTimes(2);
    for (const call of client.attach.mock.calls) expect(call[0]).toBe('p1');

    flip(true);
    client.attach.mockClear();
    await vi.advanceTimersByTimeAsync(BG_RESYNC_MS * 3);
    expect(client.attach).not.toHaveBeenCalled(); // hidden = paused, not slowed

    flip(false); // one immediate catch-up, then the cadence re-arms fresh
    expect(client.attach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BG_RESYNC_MS);
    expect(client.attach).toHaveBeenCalledTimes(2);
    for (const call of client.attach.mock.calls) expect(call[0]).toBe('p1');
  });

  test('no open chat: the tick asks for nothing', async () => {
    const {client} = plantConn();
    plantSession('p1');
    settle();
    start();

    await vi.advanceTimersByTimeAsync(BG_RESYNC_MS * 2);
    expect(client.attach).not.toHaveBeenCalled();
  });

  test('the cadence sits in the modest 60..90 s window', () => {
    expect(BG_RESYNC_MS).toBeGreaterThanOrEqual(60_000);
    expect(BG_RESYNC_MS).toBeLessThanOrEqual(90_000);
  });
});

describe('a no-change attach is cheap on the app side too', () => {
  test('attach-ok with pages: [] admits nothing and writes no page', () => {
    const handlers: Record<string, (...a: never[]) => void> = {};
    const client = {
      ...fakeClient(),
      on: (ev: string, fn: never) => {
        handlers[ev] = fn as never;
      }
    };
    const {conn} = plantConn(client as never);
    const s = plantSession('p1');
    const admit = vi.fn(() => true);
    const ctx = {
      ensureSession: () => s,
      admitEngineMessage: admit,
      insertEvents: vi.fn(),
      releaseQueuedBefore: vi.fn(() => false),
      endReplayHold: vi.fn(),
      firstPaint: vi.fn(),
      pageSizeOf: () => 100
    } as unknown as HandlerCtx;
    wireChat(conn, ctx);
    const writePage = vi.spyOn(history, 'writePage');

    const before = s.messages.length;
    (handlers['attachOk'] as (a: unknown) => void)({
      id: 'p1',
      known: true,
      pointer: 1,
      pointerPage: 0,
      tailPage: 0,
      pageSize: 100,
      total: 2,
      pages: [] // the engine matched our tail: metadata only
    });

    expect(s.messages.length).toBe(before);
    expect(admit).not.toHaveBeenCalled();
    expect(writePage).not.toHaveBeenCalled(); // only the meta row is refreshed
  });
});

describe('a silently dead pipe fails the forced probe and is redialed', () => {
  type Guts = {
    closed: boolean;
    pipe: {open: boolean; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>} | null;
    sec: unknown;
    awaitingInboundBy: number | null;
    checkLiveness(): void;
  };

  function sealedClient(url: string) {
    const schedule = vi.fn();
    const c = new WsEngineClient(url, {schedule});
    const g = c as unknown as Guts;
    g.closed = false;
    const pipe = {open: true, send: vi.fn(), close: vi.fn()};
    g.pipe = pipe;
    g.sec = {
      ready: true,
      chan: {seal: (x: unknown) => Promise.resolve(x)},
      writeChain: Promise.resolve(),
      userHost: 'u@h',
      pastedUh: null
    };
    return {c, g, pipe, schedule};
  }

  test('verifyPipe arms the inbound deadline; unanswered past the grace, the manager is asked to redial', () => {
    const {c, g, pipe, schedule} = sealedClient('ws://dead.test/ws');

    c.verifyPipe();
    const deadline = g.awaitingInboundBy;
    expect(deadline).not.toBeNull();

    // Within the grace: still waiting, nothing presumed.
    vi.setSystemTime(deadline! - 1);
    g.checkLiveness();
    expect(schedule).not.toHaveBeenCalled();
    expect(g.pipe).not.toBeNull();

    // Past it: the pipe is presumed dead and the redial is the manager's.
    vi.setSystemTime(deadline! + 1);
    g.checkLiveness();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(g.pipe).toBeNull();
    expect(pipe.close).toHaveBeenCalledWith(4008, 'presumed-dead');
  });

  test('a pong in time stands the watch down: no redial', () => {
    const {c, g, schedule} = sealedClient('ws://alive.test/ws');
    c.verifyPipe();
    expect(g.awaitingInboundBy).not.toBeNull();

    // Any inbound clears the deadline (onPipeMessage does this on the wire).
    g.awaitingInboundBy = null;
    vi.setSystemTime(Date.now() + 60_000);
    g.checkLiveness(); // quiet again, but nothing owed: at most a fresh probe
    expect(schedule).not.toHaveBeenCalled();
    expect(g.pipe).not.toBeNull();
  });

  test('verifyPipe is a no-op unsealed, and never re-arms an armed deadline', () => {
    const schedule = vi.fn();
    const c = new WsEngineClient('ws://cold.test/ws', {schedule});
    const g = c as unknown as Guts;
    c.verifyPipe(); // no pipe at all
    expect(g.awaitingInboundBy).toBeNull();

    const {c: c2, g: g2} = sealedClient('ws://armed.test/ws');
    c2.verifyPipe();
    const first = g2.awaitingInboundBy;
    vi.setSystemTime(Date.now() + 5_000);
    c2.verifyPipe(); // already a demand outstanding: keep the tighter deadline
    expect(g2.awaitingInboundBy).toBe(first);
  });
});
