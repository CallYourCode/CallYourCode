import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import * as sync from '../engine/sync';
import {
  attach,
  canOlder,
  detachChat,
  ensureMessageHeld,
  loadOlder,
  type CycEngineSession
} from '../engine/store';
import {sessions, conns, seen, type Conn} from '../engine/store/registry';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow, type StoreRow} from '../engine/store/rows/core';
import {__resetReplicatorsForTest} from '../engine/store/rows/repl';
import {memTx} from './rowStoreFake';

// STOP TRUSTING A STALE COPY, REBUILT ON THE ROW STORE (was 2026-09-07's stale
// short-sealed page bug). The old cache stored whole history PAGES and trusted a
// sealed page forever, so a device that sealed a pre-repair SHORT page never
// re-checked it, and a cold offline open could paint blank when the meta-named
// pages were thin or evicted. The row store removes both hazards by design:
//   - identity is the durable mid, so the engine's corrected re-serve rewrites
//     the one row in place (no stale twin, no sealed-forever page), and
//   - the open reads the newest WINDOW straight from the store, offline-first,
//     so a cold offline open always paints what the device actually holds.
// This file pins those two claims plus the jump-to-message path, all through the
// real attach / loadOlder / ensureMessageHeld against the store.

const KEY = 'ws://stale-seal.test:7799/ws';
const SID = KEY + '|p1';
const PAGE = 100;

let fetchPage: ReturnType<typeof vi.fn>;

function seedRows(count = 500): StoreRow[] {
  return Array.from({length: count}, (_, i) =>
    messageRow(SID, {
      id: i + 1,
      role: 'claude',
      kind: 'text',
      text: `row-${i}`,
      ts: 1000 + i,
      seq: i,
      mid: `mr-${i}`
    } as never)
  );
}

function seedSession(): CycEngineSession {
  const s = {
    id: SID,
    paneId: 'p1',
    engineKey: KEY,
    name: 'stale',
    cwd: '/x',
    alive: true,
    unread: 0,
    muted: false,
    thinking: false,
    messages: [],
    events: [],
    pageSize: PAGE
  } as unknown as CycEngineSession;
  sessions.set(SID, s);
  fetchPage = vi.fn(async () => null);
  conns.push({
    key: KEY,
    state: 'connected',
    client: {
      fetchPage,
      setSessionTail: () => {},
      attach: () => {},
      detach: () => {},
      fetchSessionAgents: () => Promise.resolve([])
    }
  } as unknown as Conn);
  return s;
}

function reachable() {
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
}

async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  rowStore.__setBackingForTest(memTx().tx);
  sync.__resetLiveForTest(() => 0.5);
});

afterEach(() => {
  detachChat();
  vi.restoreAllMocks();
  sessions.delete(SID);
  seen.delete(SID);
  const at = conns.findIndex((c) => c.key === KEY);
  if (at >= 0) conns.splice(at, 1);
  rowStore.__setBackingForTest(null);
  __resetReplicatorsForTest();
  sync.__resetLiveForTest();
});

describe('the corrected re-serve wins, no stale twin', () => {
  test('a row re-served under the same mid with fixed text/seq rewrites in place', async () => {
    await rowStore.upsert(SID, [
      messageRow(SID, {
        id: 1,
        role: 'claude',
        kind: 'text',
        text: 'stale',
        ts: 1,
        seq: 42,
        mid: 'mr-x'
      } as never)
    ]);
    // the engine's repaired axis re-serves the SAME row (mid) with new text/seq
    await rowStore.upsert(SID, [
      messageRow(SID, {
        id: 9,
        role: 'claude',
        kind: 'text',
        text: 'fixed',
        ts: 1,
        seq: 900,
        mid: 'mr-x'
      } as never)
    ]);
    rowStore.close(SID);
    const {messages} = await rowStore.openWindow(SID, 300);
    expect(messages).toHaveLength(1); // no twin
    expect(messages[0].text).toBe('fixed');
    expect(messages[0].seq).toBe(900);
  });
});

describe('offline open paints the newest window from the store', () => {
  test('a cold offline open renders what the device holds, no fetch', async () => {
    const s = seedSession();
    await rowStore.upsert(SID, seedRows());
    // no reachable(): the engine is unreachable
    expect(sync.engineReachable(KEY)).toBe(false);

    attach(SID);
    await flush();

    // the newest window painted straight from the store, and nothing was fetched
    expect(s.messages.length).toBeGreaterThan(0);
    expect(s.messages[s.messages.length - 1].text).toBe('row-499');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  test('older paging offline extends the window from the store alone', async () => {
    const s = seedSession();
    await rowStore.upsert(SID, seedRows());
    expect(sync.engineReachable(KEY)).toBe(false);
    attach(SID);
    await flush();

    const before = s.messages.length;
    expect(canOlder(SID)).toBe(true);
    await loadOlder(SID);
    expect(s.messages.length).toBeGreaterThan(before);
    expect(s.messages[0].text).toBe('row-0');
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

describe('jump-to-message reaches an older target from the store', () => {
  test('ensureMessageHeld extends the window until the target row is loaded', async () => {
    const s = seedSession();
    await rowStore.upsert(SID, seedRows());
    reachable();
    attach(SID);
    await flush();
    // the target (seq 42) is far below the newest window; the store holds it.
    expect(s.messages.some((m) => (m as {seq?: number}).seq === 42)).toBe(false);

    const ok = await ensureMessageHeld(SID, {ts: 1000 + 42, role: 'claude', seq: 42});
    expect(ok).toBe(true);
    expect(s.messages.some((m) => m.text === 'row-42')).toBe(true);
  });

  test('a target the store does not hold, offline, is not found', async () => {
    seedSession();
    await rowStore.upsert(SID, seedRows());
    expect(sync.engineReachable(KEY)).toBe(false);
    attach(SID);
    await flush();

    const ok = await ensureMessageHeld(SID, {ts: 999999, role: 'claude', seq: 99999});
    expect(ok).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
