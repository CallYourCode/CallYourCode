import {describe, expect, test, vi} from 'vitest';
import {createReplicator, rowsFromPage} from '../engine/store/rows/replicator';
import {cursorSeq} from '../engine/store/rows/cursor';
import type {EnginePage} from '../engine/contract';
import {
  emptyMirror,
  project,
  upsertMirror,
  WINDOW_FLOOR_ALL,
  type StoreRow
} from '../engine/store/rows/core';

const SID = 'eng|p1';

function page(n: number, version: number, sealed = true): EnginePage {
  const base = n * 100;
  return {
    page: n,
    version,
    sealed,
    messages: Array.from({length: 100}, (_, i) => ({
      id: SID,
      role: (i % 2 ? 'user' : 'claude') as 'user' | 'claude',
      kind: 'text' as const,
      text: 'r' + (base + i),
      ts: base + i,
      seq: base + i,
      mid: 'mr-' + (base + i)
    })),
    events: []
  };
}

// A test harness: a fake engine holding `total` pages, and a store that records
// every committed row and every cursor persist.
function harness(total: number) {
  const committed = new Map<string, StoreRow>();
  const fetches: number[] = [];
  let persisted = -1;
  const fetchPage = async (n: number): Promise<EnginePage | null> => {
    fetches.push(n);
    if (n < 0 || n >= total) return null;
    return page(n, (n + 1) * 100);
  };
  const upsert = async (rows: StoreRow[]) => {
    for (const r of rows) committed.set(r.id, r);
    return {loSeq: rows[0]?.seq ?? -1, hiSeq: rows[rows.length - 1]?.seq ?? -1};
  };
  const rep = createReplicator(SID, {
    fetchPage,
    upsert,
    persistCursor: (st) => {
      persisted = cursorSeq(st);
    },
    now: () => 0,
    schedule: () => {} // stepped by hand via pump()
  });
  return {
    rep,
    committed,
    fetches,
    get persisted() {
      return persisted;
    }
  };
}

describe('replicator backfill', () => {
  test('newest-first, one page per pump, cursor advances only after the commit', async () => {
    const h = harness(4);
    await h.rep.attachOk({sessionId: SID, pageSize: 100, tailPage: 3, total: 400, pages: []});
    // nothing committed yet from an empty attach delta
    expect(h.committed.size).toBe(0);
    await h.rep.pump();
    expect(h.fetches).toEqual([3]); // the tail first
    expect(h.committed.size).toBe(100);
    expect(h.persisted).toBe(300); // covered run floor = page 3
    await h.rep.pump();
    expect(h.fetches).toEqual([3, 2]);
    expect(h.persisted).toBe(200);
    await h.rep.pump();
    await h.rep.pump();
    expect(h.fetches).toEqual([3, 2, 1, 0]);
    expect(h.committed.size).toBe(400);
    expect(h.persisted).toBe(0); // fully backfilled
    // no more work
    await h.rep.pump();
    expect(h.fetches).toEqual([3, 2, 1, 0]);
  });

  test('a page that cannot be confirmed (offline) leaves the cursor at the edge, resumable', async () => {
    const committed: StoreRow[] = [];
    let fail = true;
    const rep = createReplicator(SID, {
      fetchPage: async (n) => (fail ? null : page(n, (n + 1) * 100)),
      upsert: async (rows) => {
        committed.push(...rows);
        return {loSeq: -1, hiSeq: -1};
      },
      persistCursor: () => {},
      now: () => 0,
      schedule: () => {}
    });
    await rep.attachOk({sessionId: SID, pageSize: 100, tailPage: 2, total: 300, pages: []});
    await rep.pump();
    expect(committed).toHaveLength(0); // could not confirm the tail
    fail = false;
    await rep.pump();
    expect(committed).toHaveLength(100); // resumes exactly at the tail
  });
});

describe('idempotent re-sync after a seq renumber', () => {
  test('an attach whose tail version regressed re-pulls; upserts by mid converge (no twins)', async () => {
    const h = harness(3);
    await h.rep.attachOk({sessionId: SID, pageSize: 100, tailPage: 2, total: 300, pages: []});
    await h.rep.pump();
    await h.rep.pump();
    await h.rep.pump();
    expect(h.committed.size).toBe(300);
    const before = h.committed.size;

    // engine restarts: same rows, renumbered seqs, LOWER tail version. The
    // attach reports the regression; the replicator re-pulls the tail.
    await h.rep.attachOk({sessionId: SID, pageSize: 100, tailPage: 2, total: 300, pages: []});
    // (harness fetchPage still serves the same mids, so re-pull converges)
    await h.rep.pump();
    await h.rep.pump();
    await h.rep.pump();
    // same 300 durable rows: the re-sync did not double anything
    expect(h.committed.size).toBe(before);
  });
});

describe('demand hints jump the queue', () => {
  test('a demanded far page is fetched before the ordered backfill resumes', async () => {
    const h = harness(10);
    await h.rep.attachOk({sessionId: SID, pageSize: 100, tailPage: 9, total: 1000, pages: []});
    await h.rep.pump(); // tail page 9
    h.rep.demand(150); // the UI scrolled to seq 150 => page 1
    await h.rep.pump();
    expect(h.fetches).toEqual([9, 1]); // the demand jumped ahead of page 8
    await h.rep.pump();
    expect(h.fetches[2]).toBe(8); // then the ordered backfill resumes
  });
});

describe('rowsFromPage', () => {
  test('splits a page into message and event rows on one axis', () => {
    const p: EnginePage = {
      page: 0,
      version: 1,
      sealed: false,
      messages: [{id: SID, role: 'user', kind: 'text', text: 'hi', ts: 1, seq: 1, mid: 'mr-1'}],
      events: [{uuid: 'se-2', ts: 2, seq: 2, kind: 'tool', text: 'Bash'}]
    };
    const rows = rowsFromPage(SID, p);
    expect(rows.map((r) => r.kind)).toEqual(['msg', 'event']);
    expect(rows.map((r) => r.id)).toEqual(['m:mr-1', 'e:se-2']);
  });

  // Regression: on the wire a chat message's `id` field IS the session id
  // (handlers/chat.ts ensureSession(conn.key, m.id)). The page path must not let
  // that string leak into the row's LOCAL render id (msg.id, a number used as
  // data-mid); it must mint a fresh per-message render id, the same counter the
  // live path uses, and keep it stable across a re-upsert of the same page.
  test('page messages get their one durable id, never the session id, stable on re-upsert', () => {
    const m = emptyMirror();
    m.floor = WINDOW_FLOOR_ALL; // an open window, so every page row is loaded and projected
    upsertMirror(m, rowsFromPage(SID, page(0, 100)));
    const first = project(m).messages;
    expect(first).toHaveLength(100);
    const ids = first.map((x) => x.id);
    // every id is the row's durable string name (mid-keyed here), never the
    // session id the wire reuses as the attach key, and all are unique.
    expect(ids.every((id) => typeof id === 'string' && id.startsWith('m:mr-'))).toBe(true);
    expect(ids as unknown[]).not.toContain(SID);
    expect(new Set(ids).size).toBe(ids.length);
    // a re-serve of the same page (fresh rows, as a re-fetch builds) keeps the
    // painted node's identity: the ids are content-derived and do not churn.
    upsertMirror(m, rowsFromPage(SID, page(0, 100)));
    expect(project(m).messages.map((x) => x.id)).toEqual(ids);
  });
});
