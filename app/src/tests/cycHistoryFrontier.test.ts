import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {wireChat} from '../engine/store/handlers/chat';
import type {HandlerCtx} from '../engine/store/handlers/types';
import {conns, sessions, type Conn} from '../engine/store/registry';
import type {CycEngineSession} from '../engine/store/types';
import * as rowStore from '../engine/store/rows/rowStore';
import {initDoor} from '../engine/store/rows/door';
import {running, __resetReplicatorsForTest} from '../engine/store/rows/repl';
import {memTx} from './rowStoreFake';

// THE FRONTIER, REBUILT AS THE REPLICATOR'S CURSOR. The old app tracked a
// scalar `frontier` and, on a capped attach-ok (pages above a hole), walked the
// interior page by page so it never stranded a gap. That whole mechanism is
// gone: the attach-ok now feeds the ONE replicator, which fills newest-first
// from the tail and advances its covered-run cursor only over committed pages
// (exhaustively tested in cycRowCursor / cycReplicator). This file pins the
// wiring: the chat handler routes attach-ok pages into the store, and a delta
// that names a tail above what is covered leaves the replicator with the
// interior still to backfill (no stranded hole), while a fully covered delta
// completes.

const KEY = 'ws://frontier.test:7798/ws';
const SID = KEY + '|p1';

initDoor();

function session(): CycEngineSession {
  const s = {
    id: SID,
    engineKey: KEY,
    paneId: 'p1',
    tabKey: '',
    name: 'p1',
    cwd: '',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(SID, s);
  return s;
}

function wire(): {fire: (ev: string, ...a: unknown[]) => void} {
  const handlers: Record<string, (...a: never[]) => void> = {};
  const client = {
    on: (ev: string, fn: never) => {
      handlers[ev] = fn as never;
    },
    // the replicator's page fetch: null keeps the cursor at the edge (the test
    // does not stand up a page server; cycReplicator covers the real fill).
    fetchPage: vi.fn(() => Promise.resolve(null))
  };
  const conn = {key: KEY, client, state: 'connected'} as unknown as Conn;
  conns.push(conn);
  const ctx = {
    ensureSession: () => sessions.get(SID) ?? session(),
    stripInstruction: (t: string) => t,
    releaseQueuedBefore: vi.fn(() => false),
    endReplayHold: vi.fn(),
    firstPaint: vi.fn()
  } as unknown as HandlerCtx;
  wireChat(conn, ctx);
  return {fire: (ev, ...a) => (handlers[ev] as (...x: unknown[]) => void)(...a)};
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const page = (n: number, seqs: number[]) => ({
  page: n,
  version: (n + 1) * 100,
  sealed: false,
  messages: seqs.map((seq) => ({seq, role: 'claude', kind: 'text', text: 't' + seq, ts: seq})),
  events: [] as {uuid: string; ts: number; seq: number; kind: string; text: string}[]
});

beforeEach(() => {
  rowStore.__setBackingForTest(memTx().tx);
  session();
});

afterEach(() => {
  rowStore.__setBackingForTest(null);
  __resetReplicatorsForTest();
  sessions.delete(SID);
  const at = conns.findIndex((c) => c.key === KEY);
  if (at >= 0) conns.splice(at, 1);
  vi.restoreAllMocks();
});

describe('attach-ok feeds the store, never a frontier walk', () => {
  test("the delta's pages enter the store and project into the open window", async () => {
    const {fire} = wire();
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 300);
    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: 100,
      total: 2200,
      tailPage: 21,
      pointerPage: 21,
      pages: [page(21, [2199])]
    });
    await flush();
    expect(rowStore.projection(SID).messages.map((m) => m.seq)).toEqual([2199]);
  });

  test('a delta whose tail sits above the covered run leaves the interior to backfill', async () => {
    const {fire} = wire();
    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: 100,
      total: 2200,
      tailPage: 21,
      pointerPage: 21,
      pages: [page(21, [2199])]
    });
    await flush();
    // the tail is stored, but pages 0..20 are not covered yet: the replicator is
    // still running (no stranded hole), it just fills them in the background.
    expect(rowStore.highestHeldSeq(SID)).toBe(2199);
    expect(running(SID)).toBe(true);
  });

  test('a delta that covers the whole history completes the backfill', async () => {
    const {fire} = wire();
    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: 100,
      total: 100,
      tailPage: 0,
      pointerPage: 0,
      pages: [page(0, [0, 1, 2])]
    });
    await flush();
    // tailPage 0 covered: nothing below to pull, the cursor is complete.
    expect(running(SID)).toBe(false);
  });
});
