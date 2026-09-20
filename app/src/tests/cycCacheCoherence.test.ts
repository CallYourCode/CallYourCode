import {afterEach, describe, expect, test} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {createReplicator, type Replicator} from '../engine/store/rows/replicator';
import {messageRow, eventRow, type StoreRow} from '../engine/store/rows/core';
import {
  attachFrontier,
  replicatorFor,
  seedCursor,
  __resetReplicatorsForTest
} from '../engine/store/rows/repl';
import {attach, detachChat, type CycEngineSession} from '../engine/store';
import {sessions, conns, type Conn} from '../engine/store/registry';
import {initDoor} from '../engine/store/rows/door';
import * as sync from '../engine/sync';
import type {EnginePage} from '../engine/contract';
import type {CycEngineMessage} from '../engine/store/types';
import type {CycSessionEvent} from '../types';
import {memTx} from './rowStoreFake';

initDoor();

// THE CACHE-COHERENCE CONTRACT (fix-cachecoherence). The disaster: the app
// painted a FALSE, foreshortened conversation. Messages present in the engine
// chat store did not render; the owner saw them only after wiping the app cache.
//
// The proven mechanism (from the BZ Outreach evidence profile): cyc-rows held a
// contiguous SUFFIX of the axis (the newest pages: 240 chat messages plus 6518
// higher-seq session-event records) with 2709 older messages absent below it.
// The store faithfully projected that suffix, and `extendWindow` reported `dry`,
// so the app declared the conversation complete. On attach the app stated its
// frontier as `highestHeldSeq` -- the MAX seq over every held row, which the
// busy agent's event records had pushed far past both the newest chat message
// AND the last page the sparse suffix actually covered. The engine, told the
// device was caught up to that seq, re-served only the newest page, and the
// truncated cache stood as the whole conversation. Wiping the cache reset the
// frontier to -1 and the engine re-served everything.
//
// THE INVARIANT: the attach frontier states only coverage the cache can PROVE is
// a contiguous run from the START of the axis. A cache that is a sparse suffix
// (the replicator's covered run has not reached page 0) proves no prefix, so it
// attaches COLD (-1) and the engine wins; the cache heals to equal the store.

const SID = 'ws://cachecoherence.test:7790/ws|ag-x';
const PAGE = 100;

const emsg = (seq: number): CycEngineMessage =>
  ({
    id: SID,
    role: (seq % 2 ? 'user' : 'claude') as 'user' | 'claude',
    kind: 'text',
    text: 'm' + seq,
    ts: 1_700_000_000_000 + seq * 1000,
    seq,
    mid: 'mr-' + seq,
    cid: 'cid-' + seq
  }) as unknown as CycEngineMessage;

// One engine page of DISTINCT chat messages, minted the way the replicator mints
// re-served rows (id = m:c:<cid>, carrying the mid too, the shape the field chat
// re-serves after fix-oneid).
function page(n: number, pages: number): EnginePage {
  const base = n * PAGE;
  return {
    page: n,
    version: (n + 1) * PAGE,
    sealed: n < pages - 1,
    messages: Array.from({length: PAGE}, (_, i) => emsg(base + i)),
    events: []
  } as unknown as EnginePage;
}

const evt = (seq: number): CycSessionEvent =>
  ({
    uuid: 'se-' + seq,
    ts: 1_700_000_000_000 + seq * 1000,
    kind: 'status',
    text: 'status',
    seq
  }) as CycSessionEvent;

async function paintedToFloor(size: number): Promise<CycEngineMessage[]> {
  const proj = await rowStore.openWindow(SID, size);
  let out = proj.messages;
  for (let i = 0; i < 2000; i++) {
    const r = await rowStore.extendWindow(SID, size);
    out = r.messages;
    if (r.dry) break;
  }
  return out;
}

function mkRep(pages: number): {rep: Replicator; committed: Set<string>} {
  const committed = new Set<string>();
  const rep = createReplicator(SID, {
    fetchPage: async (n) => (n >= 0 && n < pages ? page(n, pages) : null),
    upsert: async (rows: StoreRow[]) => {
      const r = await rowStore.upsert(SID, rows, 'replicator');
      for (const row of rows) committed.add(row.id);
      return {loSeq: r.loSeq, hiSeq: r.hiSeq};
    },
    persistCursor: () => {},
    now: () => 0,
    schedule: () => {}
  });
  return {rep, committed};
}

afterEach(() => {
  rowStore.__setBackingForTest(null);
  __resetReplicatorsForTest();
});

describe('the attach frontier states only contiguous coverage (root cause)', () => {
  test('a sparse SUFFIX cache attaches cold (-1), never its inflated held tail', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    // The evidence shape: the newest chat messages (pages 5..7) held, plus a run
    // of higher-seq session-event records above them (a busy agent's tail), and
    // NO older pages. highestHeldSeq lands on an event seq far above the newest
    // message and above the covered floor.
    const msgs: StoreRow[] = [];
    for (let seq = 500; seq < 800; seq++) msgs.push(messageRow(SID, emsg(seq)));
    const events: StoreRow[] = [];
    for (let seq = 800; seq < 830; seq++) events.push(eventRow(SID, evt(seq)));
    await rowStore.upsert(SID, [...msgs, ...events]);

    // The replicator's covered run is the suffix [page5, page8]; it has NOT
    // reached page 0, so the cache proves no contiguous prefix.
    const rep = replicatorFor(SID, 'k', 'ag-x');
    seedCursor(rep, {
      sessionId: SID,
      cursor: 500,
      tailVersion: 830,
      tailPage: 8,
      coveredFrom: 5,
      pageSize: PAGE,
      total: 0,
      syncedAt: 0
    });

    const held = rowStore.highestHeldSeq(SID);
    expect(held).toBe(829); // the inflated max the OLD code stated as the frontier
    // The fix: it states -1 (a cold attach) so the engine re-serves the older
    // history the sparse suffix cannot prove. This is the whole bug in one line:
    // the old `client.attach(paneId, highestHeldSeq)` would have stated 829.
    expect(attachFrontier(SID, held)).toBe(-1);
  });

  test('a cache whose covered run reaches the start states its held tail', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    for (let seq = 0; seq < 300; seq++) await rowStore.upsert(SID, [messageRow(SID, emsg(seq))]);
    const rep = replicatorFor(SID, 'k', 'ag-x');
    seedCursor(rep, {
      sessionId: SID,
      cursor: 0,
      tailVersion: 300,
      tailPage: 2,
      coveredFrom: 0, // the run reaches page 0: a provable contiguous prefix
      pageSize: PAGE,
      total: 0,
      syncedAt: 0
    });
    const held = rowStore.highestHeldSeq(SID);
    expect(held).toBe(299);
    expect(attachFrontier(SID, held)).toBe(299);
  });

  test('no replicator: keep the held tail, invent no suffix', () => {
    // With no covered run to prove a suffix, the prior behavior stands: the held
    // tail is stated. Only a PROVEN non-anchored suffix downgrades to cold.
    expect(attachFrontier(SID, 12345)).toBe(12345);
  });
});

// The fail-before at the real seam: driving the store's own attach() over a
// truncated cache, the frontier handed to the engine is -1, not the inflated
// held tail. On the pre-fix code (client.attach(paneId, highestHeldSeq)) this
// stated the event-tail seq and went RED here.
describe('store.attach states the honest frontier over a truncated cache (seam fail-before)', () => {
  const IKEY = 'ws://cachecoherence-seam.test:7791/ws';
  const ISID = IKEY + '|ag-x';

  afterEach(() => {
    detachChat();
    sessions.delete(ISID);
    const at = conns.findIndex((c) => c.key === IKEY);
    if (at >= 0) conns.splice(at, 1);
    sync.__resetLiveForTest();
    __resetReplicatorsForTest();
    rowStore.__setBackingForTest(null);
  });

  test('a suffix cache with a covered run above page 0 attaches cold (-1)', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    sync.__resetLiveForTest(() => 0.5);
    sync.noteSealed(IKEY);
    sync.noteHost(IKEY);
    sync.noteSessions(IKEY);

    // a truncated suffix: newest messages plus a higher-seq event tail, and a
    // persisted cursor whose covered run has NOT reached page 0.
    const rows: StoreRow[] = [];
    for (let seq = 500; seq < 800; seq++)
      rows.push(messageRow(ISID, {...emsg(seq), id: ISID} as unknown as CycEngineMessage));
    for (let seq = 800; seq < 830; seq++) rows.push(eventRow(ISID, evt(seq)));
    await rowStore.upsert(ISID, rows);
    rowStore.writeMeta({
      sessionId: ISID,
      cursor: 500,
      tailVersion: 830,
      tailPage: 8,
      coveredFrom: 5,
      pageSize: PAGE,
      total: 0,
      syncedAt: 1
    });
    rowStore.close(ISID);

    const seen: number[] = [];
    const s = {
      id: ISID,
      paneId: 'ag-x',
      engineKey: IKEY,
      name: 'x',
      cwd: '/x',
      alive: true,
      unread: 0,
      muted: false,
      thinking: false,
      messages: [],
      events: []
    } as unknown as CycEngineSession;
    sessions.set(ISID, s);
    conns.push({
      key: IKEY,
      state: 'connected',
      client: {
        fetchPage: async (): Promise<null> => null,
        setSessionTail: () => {},
        attach: (_pane: string, frontier: number) => seen.push(frontier),
        detach: () => {}
      }
    } as unknown as Conn);

    attach(ISID);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));

    expect(rowStore.highestHeldSeq(ISID)).toBe(829); // what the OLD code stated
    expect(seen.length).toBeGreaterThan(0);
    // every attach on this open states the honest cold frontier, never 829.
    for (const f of seen) expect(f).toBe(-1);
  });
});

describe('RENDERED-EQUALS-STORE at the cache/engine seam (core contract)', () => {
  // The painted set equals the engine's distinct message set for the painted
  // range, for ANY starting cache state, once the cache has healed against the
  // engine. This is the gate the suite runs forever: no truncated suffix, no
  // stale id generation, no foreign id can leave a message the engine holds
  // unpainted, and no re-serve can twin one the cache already held.
  const PAGES = 12; // 1200 distinct engine messages
  const engineTexts = () => {
    const s = new Set<string>();
    for (let seq = 0; seq < PAGES * PAGE; seq++) s.add('m' + seq);
    return s;
  };

  async function healAndAssert(): Promise<void> {
    rowStore.setOpen(SID);
    // Cache-only open first: whatever the pre-state projects (often a truncated
    // suffix) is the FALSE view the owner could see.
    const before = (await paintedToFloor(PAGE)).length;

    // A cold attach (the honest frontier for an unproven cache), then the
    // background backfill drains every page: the engine wins.
    const {rep, committed} = mkRep(PAGES);
    await rep.attachOk({
      sessionId: SID,
      pageSize: PAGE,
      tailPage: PAGES - 1,
      total: PAGES * PAGE,
      pages: [page(PAGES - 1, PAGES)]
    });
    rep.start();
    for (let i = 0; i < PAGES + 5; i++) await rep.pump();
    void committed;

    rowStore.close(SID);
    rowStore.setOpen(SID);
    const painted = await paintedToFloor(PAGE);
    const paintedTexts = new Set(painted.map((m) => m.text));

    // 1) every engine message is painted; 2) nothing is painted twice (no twin).
    expect(paintedTexts).toEqual(engineTexts());
    expect(painted.length).toBe(PAGES * PAGE);
    // and the heal genuinely added history a truncated pre-state had hidden.
    expect(painted.length).toBeGreaterThanOrEqual(before);
  }

  test('empty cache heals to the full store', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    await healAndAssert();
  });

  test('a truncated SUFFIX cache (the disaster) heals to the full store', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    // only the newest 2 pages present, keyed exactly as the engine re-serves.
    for (let n = PAGES - 2; n < PAGES; n++) {
      const rows = page(n, PAGES).messages.map((m) =>
        messageRow(SID, m as unknown as CycEngineMessage)
      );
      await rowStore.upsert(SID, rows);
    }
    rowStore.setOpen(SID);
    const truncated = (await paintedToFloor(PAGE)).length;
    expect(truncated).toBe(2 * PAGE); // the FALSE, foreshortened conversation
    expect(truncated).toBeLessThan(PAGES * PAGE);
    rowStore.close(SID);
    await healAndAssert();
  });

  test('a stale OLD-SPELLING suffix (a prior id generation) heals with no twin', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    // The newest 2 pages held under the PRE-rekey id (m:<mid>, no cid on the
    // stored payload), the spelling a deployed-master device cached. The engine
    // re-serves the SAME messages under m:c:<cid>. The door must fold, not twin.
    for (let n = PAGES - 2; n < PAGES; n++) {
      const rows = page(n, PAGES).messages.map((m) => {
        const old = {...(m as unknown as CycEngineMessage)};
        delete (old as {cid?: string}).cid; // pre-rekey: keyed by mid alone
        return messageRow(SID, old);
      });
      await rowStore.upsert(SID, rows);
    }
    rowStore.close(SID);
    await healAndAssert();
  });

  test('a FOREIGN-id suffix (rows the engine never re-serves) heals and keeps them below', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    // A row whose id no generation of the engine will re-serve (a legacy fallback
    // id on a real, on-axis seq). It must stay, and every engine row must still
    // paint around it; the painted set is a SUPERSET of the store here, so we
    // assert engine-coverage rather than exact equality.
    const foreign = messageRow(SID, {
      id: 0,
      role: 'claude',
      kind: 'text',
      text: 'foreign-legacy',
      ts: 1_700_000_000_000 + 50 * 1000 + 1,
      seq: 50
    } as unknown as CycEngineMessage);
    await rowStore.upsert(SID, [foreign]);
    rowStore.close(SID);

    rowStore.setOpen(SID);
    const {rep} = mkRep(PAGES);
    await rep.attachOk({
      sessionId: SID,
      pageSize: PAGE,
      tailPage: PAGES - 1,
      total: PAGES * PAGE,
      pages: [page(PAGES - 1, PAGES)]
    });
    rep.start();
    for (let i = 0; i < PAGES + 5; i++) await rep.pump();
    rowStore.close(SID);
    rowStore.setOpen(SID);
    const painted = await paintedToFloor(PAGE);
    const texts = new Set(painted.map((m) => m.text));
    for (const t of engineTexts()) expect(texts.has(t)).toBe(true); // engine wins for all it holds
    expect(texts.has('foreign-legacy')).toBe(true); // the unprovable row is kept, not dropped
  });
});
