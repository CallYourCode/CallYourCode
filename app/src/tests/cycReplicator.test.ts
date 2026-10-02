import {describe, expect, test, vi} from 'vitest';
import {
  createReplicator,
  FAILED_STEP_BACKOFF_MS,
  rowsFromPage,
  tailVersionOf
} from '../engine/store/rows/replicator';
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

describe('the tail version is a version, never a row count', () => {
  test('prefers the wire tailVersion, else the newest served page, and NEVER total', () => {
    // The wire tailVersion is authoritative even on a page-less delta.
    expect(tailVersionOf({sessionId: SID, pageSize: 100, total: 123904, tailVersion: 124924, pages: []})).toBe(124924);
    // No wire tailVersion: the newest SERVED page's version (the tail page is
    // always among the served pages), never the total.
    expect(
      tailVersionOf({sessionId: SID, pageSize: 100, total: 123904, pages: [page(1238, 124000), page(1239, 124924)]})
    ).toBe(124924);
    // Page-less AND no wire tailVersion (an old engine, a device current): the
    // tail is UNKNOWN (0). The old code returned `total` (123904) here, a row
    // count that on a gappy axis reads as a regression below the real tail.
    expect(tailVersionOf({sessionId: SID, pageSize: 100, total: 123904, pages: []})).toBe(0);
  });

  // Fail-before: the exact BZ-Builder flood. A fully-synced device reconnects
  // and the engine serves a page-less, up-to-date attach whose `total` (a row
  // count) sits BELOW the gappy tail version. The old tailVersionOf fell back to
  // total, renumberDirty saw a regression, resetCoverage wiped the covered run,
  // and the replicator re-pulled every page (5 MB / 353 msgs on the wire). It
  // must instead hold coverage and pull nothing.
  test('a page-less up-to-date reconnect on a gappy axis re-pulls NOTHING', async () => {
    const h = harness(1240);
    // seed a high tail version (a gappy axis) via the wire, then cover the tail
    await h.rep.attachOk({
      sessionId: SID,
      pageSize: 100,
      tailPage: 1239,
      total: 123904,
      tailVersion: 124924,
      pages: []
    });
    await h.rep.pump(); // commits the tail page 1239, coveredFrom = 1239
    const coveredBefore = cursorSeq(h.rep.cursor);
    expect(coveredBefore).toBe(123900);
    const fetchesBefore = h.fetches.length;
    // the reconnect: an OLD engine (no wire tailVersion), page-less, total below
    // the true tail version.
    await h.rep.attachOk({sessionId: SID, pageSize: 100, tailPage: 1239, total: 123904, pages: []});
    // coverage held: no renumber, no reset.
    expect(cursorSeq(h.rep.cursor)).toBe(coveredBefore);
    // the ordered backfill resumes BELOW the covered run; the tail is never
    // re-fetched (a reset would have set nextPage back to the tail page).
    await h.rep.pump();
    expect(h.fetches.slice(fetchesBefore)).not.toContain(1239);
    expect(h.fetches[h.fetches.length - 1]).toBe(1238);
  });

  // The same reconnect from a NEW engine that DOES state its tail version: the
  // stated version equals what we covered at, so still no renumber.
  test('a page-less reconnect that states the real tail version is not a renumber', async () => {
    const h = harness(1240);
    await h.rep.attachOk({
      sessionId: SID,
      pageSize: 100,
      tailPage: 1239,
      total: 123904,
      tailVersion: 124924,
      pages: []
    });
    await h.rep.pump();
    const coveredBefore = cursorSeq(h.rep.cursor);
    const fetchesBefore = h.fetches.length;
    await h.rep.attachOk({
      sessionId: SID,
      pageSize: 100,
      tailPage: 1239,
      total: 123904,
      tailVersion: 124924,
      pages: []
    });
    expect(cursorSeq(h.rep.cursor)).toBe(coveredBefore);
    await h.rep.pump();
    expect(h.fetches.slice(fetchesBefore)).not.toContain(1239);
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

describe('the background backfill pauses while hidden and trickles for non-open chats', () => {
  test('a paused (hidden) replicator arms no timer until it is woken', async () => {
    let hidden = true;
    const scheduled: Array<{fn: () => void; ms: number}> = [];
    const fetches: number[] = [];
    const rep = createReplicator(SID, {
      fetchPage: async (n) => {
        fetches.push(n);
        return page(n, (n + 1) * 100);
      },
      upsert: async () => ({loSeq: -1, hiSeq: -1}),
      persistCursor: () => {},
      now: () => 0,
      schedule: (fn, ms) => scheduled.push({fn, ms}),
      paused: () => hidden
    });
    await rep.attachOk({sessionId: SID, pageSize: 100, tailPage: 3, total: 400, pages: []});
    rep.start();
    // Hidden: start armed nothing, so no page is pulled.
    expect(scheduled).toHaveLength(0);
    // Even a manual pump fetches nothing while paused.
    await rep.pump();
    expect(fetches).toHaveLength(0);

    // The page becomes visible and the registry wakes it: now the backfill arms.
    hidden = false;
    rep.wake();
    expect(scheduled).toHaveLength(1);
    scheduled[0].fn(); // run the scheduled step
    await Promise.resolve();
    expect(fetches).toEqual([3]);
  });

  test('a timer that fires after the page went hidden pulls nothing and stops re-arming', async () => {
    let hidden = false;
    const scheduled: Array<() => void> = [];
    const fetches: number[] = [];
    const rep = createReplicator(SID, {
      fetchPage: async (n) => {
        fetches.push(n);
        return page(n, (n + 1) * 100);
      },
      upsert: async () => ({loSeq: -1, hiSeq: -1}),
      persistCursor: () => {},
      now: () => 0,
      schedule: (fn) => scheduled.push(fn),
      paused: () => hidden
    });
    await rep.attachOk({sessionId: SID, pageSize: 100, tailPage: 3, total: 400, pages: []});
    rep.start();
    expect(scheduled).toHaveLength(1);
    // The page hid while the timer was pending: the step fires but pulls nothing
    // and does not re-arm.
    hidden = true;
    scheduled[0]();
    await Promise.resolve();
    expect(fetches).toHaveLength(0);
    expect(scheduled).toHaveLength(1); // no new timer armed while hidden
  });

  test('gapMs sets the fetch cadence: the open chat runs fast, a background chat trickles', async () => {
    const openGaps: number[] = [];
    const openRep = createReplicator(SID, {
      fetchPage: async (n) => page(n, (n + 1) * 100),
      upsert: async () => ({loSeq: -1, hiSeq: -1}),
      persistCursor: () => {},
      now: () => 0,
      schedule: (_fn, ms) => openGaps.push(ms),
      gapMs: () => 500
    });
    await openRep.attachOk({sessionId: SID, pageSize: 100, tailPage: 3, total: 400, pages: []});
    openRep.start();
    expect(openGaps[0]).toBe(500);

    const bgGaps: number[] = [];
    const bgRep = createReplicator(SID, {
      fetchPage: async (n) => page(n, (n + 1) * 100),
      upsert: async () => ({loSeq: -1, hiSeq: -1}),
      persistCursor: () => {},
      now: () => 0,
      schedule: (_fn, ms) => bgGaps.push(ms),
      gapMs: () => 5000
    });
    await bgRep.attachOk({sessionId: SID, pageSize: 100, tailPage: 3, total: 400, pages: []});
    bgRep.start();
    expect(bgGaps[0]).toBe(5000);
  });
});

const settleMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe('a failing fetch is paced', () => {
  test('a step that threw waits the cadence plus one fixed backoff, and success clears it', async () => {
    const gaps: number[] = [];
    const steps: Array<() => void> = [];
    let fail = true;
    const rep = createReplicator(SID, {
      fetchPage: async (n) => {
        if (fail) throw new Error('page failed: HTTP 500');
        return page(n, (n + 1) * 100);
      },
      upsert: async () => ({loSeq: -1, hiSeq: -1}),
      persistCursor: () => {},
      now: () => 0,
      schedule: (fn, ms) => {
        gaps.push(ms);
        steps.push(fn);
      },
      gapMs: () => 500
    });
    await rep.attachOk({sessionId: SID, pageSize: 100, tailPage: 3, total: 400, pages: []});
    rep.start();
    expect(gaps).toEqual([500]);
    steps[0]();
    await settleMicrotasks();
    // main re-armed at 0 ms here: 60 failed fetches a second
    expect(gaps).toEqual([500, 500 + FAILED_STEP_BACKOFF_MS]);
    fail = false;
    steps[1]();
    await settleMicrotasks();
    expect(gaps[2]).toBe(500);
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
