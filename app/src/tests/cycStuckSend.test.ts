import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The stuck-"Sending…" defect (session ag-Tc4EGU4110VFzQY8): a send the engine
// already took resurrects a fake pending bubble on every boot, the drain re-sends
// it, and the engine (its cid long evicted from the 200-cid dedupe window) lands
// a fresh duplicate. Root cause proven here: settleSend removes the intent, but
// remove()->erase() is an async IndexedDB delete, and a reload() that re-reads
// the store before the delete commits absorbs the row straight back. These tests
// round-trip through an in-memory intents store so the race is real, not mocked
// away, and prove the three fixes converge the system.

// An in-memory INTENTS store standing in for IndexedDB, with a seam to hold a
// delete uncommitted (the race window): while `deferDeletes` is set a delete is
// queued, and a concurrent read still sees the row.
const disk = new Map<string, {id: string; engineKey: string} & Record<string, unknown>>();
let deferDeletes = false;
const heldDeletes: string[] = [];
function flushDeletes() {
  for (const id of heldDeletes.splice(0)) disk.delete(id);
}
function fakeTransactionOn(
  _store: string | string[],
  _mode: string,
  run: (s: unknown, tx: unknown) => {result?: unknown} | null | undefined
): Promise<unknown> {
  const os = {
    getAll: () => ({result: [...disk.values()]}),
    get: (id: string) => ({result: disk.get(id)}),
    put: (v: {id: string} & Record<string, unknown>) => {
      disk.set(v.id, v as never);
      return {result: v.id};
    },
    delete: (id: string) => {
      if (deferDeletes) heldDeletes.push(id);
      else disk.delete(id);
      return {result: undefined as unknown};
    }
  };
  const req = run(os, {});
  return Promise.resolve(req ? (req.result ?? null) : null);
}

vi.mock('@/shared/browser', () => ({
  INTENTS: 'intents',
  transactionOn: (s: string | string[], m: string, run: never) => fakeTransactionOn(s, m, run)
}));
vi.mock('../engine/transfers/worker', () => ({
  enqueue: vi.fn((_blob: Blob, meta: {key: string}) => meta.key),
  wake: vi.fn(),
  onResult: vi.fn(),
  rowOf: vi.fn(() => undefined),
  isEnqueuing: vi.fn(() => false),
  heldKeys: vi.fn(() => new Set()),
  prune: vi.fn(() => 0),
  cancel: vi.fn(() => 0),
  hydrateTransfers: vi.fn(async () => [])
}));

import * as intents from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';
import {conns, sessions, type Conn} from '../engine/store/registry';
import {
  sendText,
  settleSend,
  paintPendingSends,
  __resetForTest as resetSends
} from '../engine/store/sends';
import {stillSending} from '../features/chat/content';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';

const KEY = 'ws://fake-engine.test:7788/ws';
const DAY = 24 * 60 * 60 * 1000;

function plantSession(): CycEngineSession {
  const s = {
    id: KEY + '|p1',
    engineKey: KEY,
    paneId: 'p1',
    tabKey: '',
    name: 'p1',
    cwd: '',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [] as CycEngineMessage[],
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}
function plantConn() {
  const sent: unknown[][] = [];
  const pipe = {sealed: true};
  const conn = {
    key: KEY,
    state: 'connected',
    client: {
      heard: () => pipe.sealed,
      sendText: (...a: unknown[]) => {
        if (!pipe.sealed) return false;
        sent.push(a);
        return true;
      }
    }
  } as unknown as Conn;
  conns.push(conn);
  return {conn, sent, pipe};
}
function settle() {
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
}
const tick = () => vi.advanceTimersByTimeAsync(1);

describe('a delivered send never resurrects "Sending…" nor re-sends', () => {
  let planted: ReturnType<typeof plantConn>;
  let s: CycEngineSession;
  beforeEach(() => {
    vi.useFakeTimers();
    disk.clear();
    heldDeletes.length = 0;
    deferDeletes = false;
    sessions.clear();
    intents.__resetForTest();
    sync.__resetLiveForTest();
    drain.__resetForTest(() => 0.5);
    resetSends();
    s = plantSession();
    planted = plantConn();
  });
  afterEach(() => {
    drain.__resetForTest();
    vi.useRealTimers();
    conns.splice(conns.indexOf(planted.conn), 1);
    sessions.clear();
  });

  // THE REPRODUCED LEAK. The ack settles the send (its intent removed), but the
  // erase is still uncommitted when a drain-lease reload re-reads the store. On
  // 1ca4f59 the row is absorbed back and lives forever; the tombstone in remove()
  // keeps it gone.
  test('the settle survives a reload that races the async erase: the intent stays gone', async () => {
    settle();
    sendText(s.id, 'Resume full session as-is');
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    const cid = m.cid!;
    expect(intents.get(cid)?.state).toBe('inflight');
    expect(disk.has(cid)).toBe(true);

    // The engine acks: settleSend removes the intent -- but hold the erase so it
    // has not committed to disk yet (the real async-delete window).
    deferDeletes = true;
    m.status = 'sent';
    settleSend(cid);
    expect(intents.get(cid)).toBeUndefined();
    expect(disk.has(cid)).toBe(true); // erase not committed

    // A lease handover re-reads the store while the delete is still in flight.
    await intents.reload();
    // FAIL-BEFORE: without the tombstone the stale row is absorbed back here.
    expect(intents.get(cid)).toBeUndefined();

    // The delete finally commits; a second boot finds nothing to resurrect.
    flushDeletes();
    expect(disk.has(cid)).toBe(false);

    // And no fake "Sending…" bubble is repainted for the taken send.
    const s2 = plantSession();
    paintPendingSends(s2.id);
    expect(s2.messages.some((x) => stillSending(x as CycEngineMessage))).toBe(false);
  });

  // FIX 2: an intent older than a day is not re-sent and not painted sending;
  // it surfaces once as a failed bubble with a retry, and only the user's tap
  // (which renews it) puts it back on the wire.
  test('a send older than a day is failed, never auto-re-sent, and retries on the tap', async () => {
    // A send written now, but its clock predates the boot by more than a day.
    sendText(s.id, 'Resume full session as-is');
    const m = s.messages[0] as CycEngineMessage;
    const cid = m.cid!;
    const row = intents.get(cid)!;
    row.createdAt = Date.now() - (DAY + 60_000);

    // Boot: the session (re)appears and repaints its pending sends. The stale
    // send draws as failed, not sending.
    const s2 = plantSession();
    paintPendingSends(s2.id);
    const painted = s2.messages.find(
      (x) => (x as CycEngineMessage).cid === cid
    ) as CycEngineMessage;
    expect(painted.status).toBe('failed');
    expect(stillSending(painted)).toBe(false);
    expect(intents.get(cid)?.state).toBe('failed');

    // Even reachable, the drain does not put it on the wire.
    settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(planted.sent).toHaveLength(0);

    // The user taps retry on the failed bubble: renewed, it sends fresh.
    const {retrySend} = await import('../engine/store/sends');
    retrySend(s2.id, painted.id);
    await tick();
    expect(intents.get(cid)?.state).toBe('inflight');
    expect(planted.sent).toHaveLength(1);
    expect((planted.sent[0][2] as {cid: string}).cid).toBe(cid);
  });

  // FIX 3: a resurrected send whose ts predates a delivered row never stamps the
  // list row "Sending…". Proven at the store layer: the painted bubble lands
  // behind the delivered row, not at the tail.
  test('a resurrected old send is painted behind the newest delivered row', () => {
    // A delivered engine row already sits in the window (ts newer than the send).
    const delivered: CycEngineMessage = {
      id: 'm999',
      role: 'user',
      kind: 'text',
      text: 'a later message',
      ts: 5_000,
      status: 'delivered',
      dedupeKey: '5000|user|a later message'
    } as CycEngineMessage;
    s.messages.push(delivered);

    // An intent from before it (ts 1000) comes back from disk and paints.
    intents.put({
      id: 'old-cid',
      engineKey: KEY,
      sessionId: s.id,
      kind: 'send-text',
      payload: {
        cid: 'old-cid',
        sessionId: s.id,
        ts: 1_000,
        text: 'Resume full session as-is',
        kind: 'text',
        wire: 'Resume full session as-is'
      }
    });
    paintPendingSends(s.id);

    // The pending bubble is NOT the session's newest row: the delivered row is.
    const last = s.messages[s.messages.length - 1] as CycEngineMessage;
    expect(last.status).toBe('delivered');
    expect(stillSending(last)).toBe(false);
  });

  // NO REGRESSION: the normal flow -- send, ack, intent gone, row status clears.
  test('normal send: ack settles it, intent gone, nothing left sending', async () => {
    settle();
    sendText(s.id, 'hello');
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    expect(planted.sent).toHaveLength(1);
    m.status = 'sent';
    settleSend(m.cid);
    // Intent gone at the ack: the drain owes nothing more.
    expect(intents.get(m.cid!)).toBeUndefined();
    // The engine's echo then delivers the row; the list stops saying sending.
    m.status = 'delivered';
    m.dedupeKey = 'k';
    expect(stillSending(m)).toBe(false);
  });

  // NO REGRESSION: offline queueing -- a genuinely unsent, fresh intent still
  // re-sends on reconnect and still paints as sending.
  test('offline: a fresh unsent send still paints sending and drains on reconnect', async () => {
    planted.pipe.sealed = false;
    sendText(s.id, 'queued while offline');
    const m = s.messages[0] as CycEngineMessage;
    expect(m.status).toBe('sending');
    expect(stillSending(m)).toBe(true);
    expect(planted.sent).toHaveLength(0);
    // Reconnect: the same fresh intent drains.
    planted.pipe.sealed = true;
    settle();
    await tick();
    expect(planted.sent).toHaveLength(1);
    expect((planted.sent[0][2] as {cid: string}).cid).toBe(m.cid);
    expect(intents.get(m.cid!)?.state).toBe('inflight');
  });
});
