import {afterEach, describe, expect, test} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {createReplicator} from '../engine/store/rows/replicator';
import {cursorSeq} from '../engine/store/rows/cursor';
import {WINDOW} from '../engine/store/rows/door';
import type {EnginePage} from '../engine/contract';
import {messageRow, type StoreRow} from '../engine/store/rows/core';
import type {CycEngineMessage} from '../engine/store/types';
import {memTx} from './rowStoreFake';

// TONIGHT'S FLOOD, as a unit-level fail-before. A cold device (frontier F = -1)
// attaches to a 200-page history. The class of bug the rebuild kills is: a
// backfill that repaints the screen per page. This file proves both sides.
//
// METHOD. The "before" is a faithful port of master's paint path: master seeds
// the in-memory message array page by page and calls notify() after each page
// (store.ts attach IIFE + walkFrontierGap on master), so a 200-page cold fill
// fires ~200 repaints. The "after" runs the real rebuilt replicator against the
// real rowStore: the tail is the only page the open window holds, so the open
// gets ONE paint and every below-window backfill page paints ZERO. We assert the
// paint counters on both, so the contrast cannot pass vacuously.

const SID = 'eng|p1';
const PAGES = 200;
const PAGE = 100;

function page(n: number): EnginePage {
  const base = n * PAGE;
  return {
    page: n,
    version: (n + 1) * PAGE,
    sealed: true,
    messages: Array.from({length: PAGE}, (_, i) => ({
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

afterEach(() => rowStore.__setBackingForTest(null));

describe('the flood, before: master repaints per backfilled page', () => {
  test('a 200-page cold fill fires ~200 paints (the bug)', () => {
    // Port of master's paintStoredPage-into-memory + notify-per-page loop.
    const messages: {seq: number}[] = [];
    let paints = 0;
    const notify = () => paints++;
    const paintStoredPage = (pg: EnginePage) => {
      for (const m of pg.messages) messages.push({seq: m.seq!});
      notify(); // master paints after every page it folds into the window
    };
    // cold attach + ascending frontier walk: every page from tail to floor
    for (let n = PAGES - 1; n >= 0; n--) paintStoredPage(page(n));
    expect(paints).toBe(PAGES);
    expect(messages).toHaveLength(PAGES * PAGE); // the whole log ended up in memory
  });
});

describe('the flood, after: the rebuild opens once and fills silently', () => {
  test('F=-1 cold attach over 200 pages: ONE open paint, ZERO backfill paints, cursor completes', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen(SID);

    let openPaints = 0;
    let backfillPaints = 0;
    let opened = false;
    const off = rowStore.onChange((sid) => {
      if (sid !== SID) return;
      if (opened) backfillPaints++;
      else openPaints++;
    });

    // the wire's fetchPage, standing in for the engine holding 200 pages
    const committed = new Set<string>();
    const rep = createReplicator(SID, {
      fetchPage: async (n) => (n >= 0 && n < PAGES ? page(n) : null),
      upsert: async (rows: StoreRow[]) => {
        const r = await rowStore.upsert(SID, rows);
        for (const row of rows) committed.add(row.id);
        return {loSeq: r.loSeq, hiSeq: r.hiSeq};
      },
      persistCursor: () => {},
      now: () => 0,
      schedule: () => {}
    });

    // cold attach: F=-1, the engine names the tail. The delta carries the tail
    // page (the newest window), nothing more.
    await rep.attachOk({
      sessionId: SID,
      pageSize: PAGE,
      tailPage: PAGES - 1,
      total: PAGES * PAGE,
      pages: [page(PAGES - 1)]
    });

    // open the chat: ONE query of the newest window, ONE paint.
    const win = await rowStore.openWindow(SID, PAGE);
    opened = true;
    expect(win.messages).toHaveLength(PAGE);
    expect(win.messages[win.messages.length - 1].text).toBe('r' + (PAGES * PAGE - 1));

    // now the background replicator drains all 199 remaining pages.
    for (let i = 0; i < PAGES + 5; i++) await rep.pump();

    expect(committed.size).toBe(PAGES * PAGE); // the whole history is stored
    expect(cursorSeq(rep.cursor)).toBe(0); // backfill complete
    expect(backfillPaints).toBe(0); // the flood is gone: not one repaint below the window
    // The served tail is admitted while the chat is OPEN but not yet floored
    // (the attach-ok beats the deferred openWindow, exactly the cold open the
    // owner hit). That admit floors the empty window and paints the served tail
    // ONCE, so the fresh open shows the newest rows instead of a persistent
    // empty window; openWindow itself still fires no onChange, and every
    // below-window backfill page still paints nothing.
    expect(openPaints).toBe(1);

    // and the window is unchanged after the flood settled: still the tail.
    const after = rowStore.projection(SID);
    expect(after.messages).toHaveLength(PAGE);
    off();
  });

  test('scrolling up after the fill reads older rows from the store, no new network', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen(SID);
    const rep = createReplicator(SID, {
      fetchPage: async (n) => (n >= 0 && n < PAGES ? page(n) : null),
      upsert: (rows: StoreRow[]) =>
        rowStore.upsert(SID, rows).then((r) => ({loSeq: r.loSeq, hiSeq: r.hiSeq})),
      persistCursor: () => {},
      now: () => 0,
      schedule: () => {}
    });
    await rep.attachOk({
      sessionId: SID,
      pageSize: PAGE,
      tailPage: PAGES - 1,
      total: PAGES * PAGE,
      pages: [page(PAGES - 1)]
    });
    for (let i = 0; i < PAGES + 5; i++) await rep.pump();
    await rowStore.openWindow(SID, PAGE);
    const older = await rowStore.extendWindow(SID, PAGE);
    // the window grew downward from the store alone
    expect(older.messages[0].text).toBe('r' + (PAGES * PAGE - 2 * PAGE));
    expect(older.messages).toHaveLength(2 * PAGE);
  });
});

// THE THIN-STORE FLOOR COLLAPSE (defect 3). openWindow on an empty/thin store
// clamps the newest-window floor to 0, so on 5f7a9e2 EVERY backfilled page lands
// "in the window": it paints and the projection climbs without bound (the rig's
// `DBG.project msgs 289 -> 450 (and climbing)`, the owner's flashing and jank).
// The bound makes the floor ride the newest-WINDOW boundary as rows arrive, so
// the projection stays at WINDOW and a below-boundary backfill page paints
// nothing. Proven failing on 5f7a9e2 (projection blows past WINDOW), passing
// after.
describe('the window bound: a thin open store stays at WINDOW under a backfill flood', () => {
  test('50 pages backfilled into a thin open store never grow the projection past WINDOW, and paint at most once per in-window change', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen(SID);
    // Open onto an EMPTY store: the newest-window floor clamps to 0, the exact
    // thin-store condition the rig hit.
    await rowStore.openWindow(SID, WINDOW);

    let paints = 0;
    const off = rowStore.onChange((sid) => {
      if (sid === SID) paints++;
    });

    // 50 pages of 100 rows, newest first (descending seq ranges), the shape the
    // replicator backfills, two per second on the rig.
    const PAGE_ROWS = 100;
    const NPAGES = 50;
    for (let p = 0; p < NPAGES; p++) {
      const base = (NPAGES - 1 - p) * PAGE_ROWS; // page 0 carries the newest rows
      const rows: StoreRow[] = Array.from({length: PAGE_ROWS}, (_, i) => {
        const seq = base + i;
        return messageRow(SID, {
          id: seq + 1,
          role: 'claude',
          kind: 'text',
          text: 'r' + seq,
          ts: seq,
          seq,
          mid: 'mr-' + seq
        } as unknown as CycEngineMessage);
      });
      await rowStore.upsert(SID, rows);
      // the projection never exceeds WINDOW, page after page (on 5f7a9e2 it grows
      // to NPAGES * PAGE_ROWS = 5000).
      expect(rowStore.projection(SID).messages.length).toBeLessThanOrEqual(WINDOW);
    }

    const proj = rowStore.projection(SID).messages;
    expect(proj).toHaveLength(WINDOW); // bounded at the newest WINDOW, not 5000
    expect(proj[proj.length - 1].text).toBe('r' + (NPAGES * PAGE_ROWS - 1)); // the tail shows
    // At most one paint per in-window change while the window filled to WINDOW,
    // never one per backfilled page (that was the flood: NPAGES paints).
    expect(paints).toBeLessThanOrEqual(Math.ceil(WINDOW / PAGE_ROWS));
    off();
  });
});
