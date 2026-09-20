import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {sessions, conns, type Conn} from '../engine/store/registry';
import {canOlder, loadOlder, attach, type CycEngineSession} from '../engine/store';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow, type StoreRow} from '../engine/store/rows/core';
import {openChatWindow, WINDOW} from '../engine/store/rows/door';
import {__resetReplicatorsForTest} from '../engine/store/rows/repl';
import {memTx} from './rowStoreFake';

// OLDER PAGING, REBUILT ON THE STORE. The old sparse-axis pager (Job Hunt,
// 2026-09-06) had to track an `olderFloor` because it paged by PAGE NUMBER
// against an engine log with persisted seq gaps: a gap served an empty sealed
// page, and "the page below the lowest held row" recomputed to the same page
// forever. The row store removes the whole hazard: loadOlder extends the window
// over the stored ROW INDEX, which holds only rows that exist, so a seq gap is
// simply two adjacent rows and paging can never re-probe an empty page. This
// pins that: older paging pulls the next older stored rows regardless of seq
// gaps, and reports done at the store's floor.

const KEY = 'ws://fake-olderfloor.test:7788/ws';
const SID = KEY + '|p1';

function seedRows(): StoreRow[] {
  // 500 rows on a SPARSE seq axis (three wide gaps), so the newest window (300)
  // leaves 200 older rows to page in, and paging must walk across the gaps.
  const rows: StoreRow[] = [];
  let seq = 0;
  for (let i = 0; i < 500; i++) {
    seq += i === 150 || i === 300 || i === 420 ? 400 : 1; // gaps
    rows.push(
      messageRow(SID, {
        id: i + 1,
        role: 'claude',
        kind: 'text',
        text: 'r' + i,
        ts: 1000 + i,
        seq
      } as never)
    );
  }
  return rows;
}

function seedSession(): CycEngineSession {
  const s = {
    id: SID,
    paneId: 'p1',
    engineKey: KEY,
    name: 'sparse',
    cwd: '/x',
    alive: true,
    unread: 0,
    muted: false,
    thinking: false,
    messages: [],
    events: [],
    pageSize: 100
  } as unknown as CycEngineSession;
  sessions.set(SID, s);
  conns.push({
    key: KEY,
    state: 'connected',
    client: {
      fetchPage: async (): Promise<null> => null,
      setSessionTail: () => {},
      attach: () => {},
      detach: () => {}
    }
  } as unknown as Conn);
  return s;
}

beforeEach(() => {
  rowStore.__setBackingForTest(memTx().tx);
});

afterEach(() => {
  rowStore.__setBackingForTest(null);
  __resetReplicatorsForTest();
  sessions.delete(SID);
  const at = conns.findIndex((c) => c.key === KEY);
  if (at >= 0) conns.splice(at, 1);
});

describe('sparse-axis older paging over the store', () => {
  test('older paging pulls the next older rows across seq gaps, then reports exhausted', async () => {
    const s = seedSession();
    await rowStore.upsert(SID, seedRows());
    await openChatWindow(SID);
    // the newest window holds the last WINDOW rows; 200 older remain below.
    expect(s.messages).toHaveLength(WINDOW);
    expect(canOlder(SID)).toBe(true);

    await loadOlder(SID);
    // the window grew downward from the store alone: all 500 rows are the oldest
    // r0 through the newest, in stored order, with the gaps crossed, no re-probe.
    expect(s.messages).toHaveLength(500);
    expect(s.messages[0].text).toBe('r0');
    expect(canOlder(SID)).toBe(false);
  });

  test('a fresh attach re-probes the axis from the tail', () => {
    const s = seedSession();
    s.olderFloor = 0;
    attach(SID);
    expect(s.olderFloor).toBeUndefined();
  });
});
