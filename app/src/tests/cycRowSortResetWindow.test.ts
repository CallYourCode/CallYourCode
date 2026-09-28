import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow} from '../engine/store/rows/core';
import type {CycEngineMessage} from '../engine/store/types';
import {memTx} from './rowStoreFake';

// THE RESET-BEARING WINDOW DEFECT, root-caused. The transcript is ordered by ts
// (cmpTuple is ts-first), but the loaded-window floor and eviction USED to be
// expressed as a seq threshold. seq is not monotonic in ts on a reset-bearing
// log: a post-reset band carries LOWER seqs than the older pre-reset band still
// in the window. A seq floor is therefore NOT a contiguous ts-tail, so a single
// live append that rides the floor UP by seq evicts rows that are NEWER by ts but
// carry a lower (reused) seq -- the newest of the transcript vanishes and a hole
// opens. These tests cut the window by ts-position (a floor TUPLE compared with
// cmpTuple), so a live append never drops a newer-by-ts row.
//
//   bunx vitest run src/tests/cycRowSortResetWindow.test.ts

const SID = 'ws://reset.test:7799/ws|p1';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_756_000_000_000;
const WINDOW = 300;

function msg(seq: number, ts: number, text: string): CycEngineMessage {
  const role = seq % 2 ? 'claude' : 'user';
  return {role, kind: 'text', text, ts, seq} as unknown as CycEngineMessage;
}

// The window the store SHOULD hold: the newest `size` rows by ts (every ts here
// is distinct, so ts alone is the total order), youngest last.
function expectedNewest(all: CycEngineMessage[], size: number): string[] {
  return [...all]
    .sort((a, b) => a.ts - b.ts)
    .slice(-size)
    .map((m) => m.text);
}

function projTexts(): string[] {
  return rowStore.projection(SID).messages.map((m) => m.text);
}

describe('reset-bearing window: a live append never drops a newer-by-ts row', () => {
  beforeEach(() => {
    rowStore.__setBackingForTest(memTx().tx);
  });
  afterEach(() => {
    rowStore.setOpen(null);
    rowStore.__setBackingForTest(null);
  });

  // The verifier's single-reset fixture. Run A climbs to a HIGH seq (0..219) over
  // days 0..2, then a resume RESETS seq to 1 and climbs slowly through days 3..6,
  // so the newest-300 window STRADDLES the reset. Open, then ONE live append.
  test('single reset: open holds the newest 300 by ts and a live append keeps them all', async () => {
    const all: CycEngineMessage[] = [];
    // Run A: day 0..2, seq 0..219 (climbs high before the reset).
    for (let i = 0; i < 220; i++) {
      const day = Math.floor(i / 90);
      all.push(msg(i, T0 + day * DAY + (i % 90) * 20_000, 'A' + i));
    }
    // Reset: day 3..6, seq restarts at 1 and climbs slowly (a recent reset).
    let s = 1;
    for (let day = 3; day <= 6; day++) {
      for (let k = 0; k < 30; k++) {
        all.push(msg(s, T0 + day * DAY + k * 30_000, 'B' + day + '-' + k));
        s += 1;
      }
    }
    await rowStore.upsert(SID, all.map((m) => messageRow(SID, m)) as never);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // Open holds EXACTLY the newest 300 by ts, in true time order, no hole.
    const before = projTexts();
    expect(before).toEqual(expectedNewest(all, WINDOW));
    expect(before).toHaveLength(WINDOW);
    // The whole post-reset day-3 band is in the window (it is newer by ts than the
    // Run A tail the window also holds), even though it carries the lowest seqs.
    for (let k = 0; k < 30; k++) expect(before).toContain('B3-' + k);

    // ONE live message at the true tail (newest ts, next reset-band seq). On the
    // seq-floor code this rode the floor up and evicted the low-seq band. While
    // the chat is OPEN the window now GROWS by the arrival instead of sliding, so
    // nothing is evicted and no newer-by-ts row can be dropped.
    const live = msg(s, T0 + 6 * DAY + 999_000, 'LIVE');
    all.push(live);
    await rowStore.upsert(SID, [messageRow(SID, live)] as never);

    const after = projTexts();
    // The open window GREW by one: it is now the newest 301 by ts, front kept.
    expect(after).toHaveLength(WINDOW + 1);
    expect(after).toEqual(expectedNewest(all, WINDOW + 1));
    // The live row is at the tail; no day-3 band row vanished.
    expect(after[after.length - 1]).toBe('LIVE');
    for (let k = 0; k < 30; k++) expect(after).toContain('B3-' + k);

    // Eviction, when it DOES run (a background chat, or the grow cap), still cuts
    // by ts, never by seq: leave SID in the background and append once more, and
    // the floor rides to the exact newest 300 by ts. The low-seq post-reset band
    // survives; only the oldest-by-ts rows leave, no hole.
    rowStore.setOpen('ws://other.test:1/ws|p9');
    const live2 = msg(s + 1, T0 + 6 * DAY + 999_500, 'LIVE2');
    all.push(live2);
    await rowStore.upsert(SID, [messageRow(SID, live2)] as never);
    const bg = projTexts();
    expect(bg).toHaveLength(WINDOW);
    expect(bg).toEqual(expectedNewest(all, WINDOW));
    expect(bg[bg.length - 1]).toBe('LIVE2');
    for (let k = 0; k < 30; k++) expect(bg).toContain('B3-' + k);
  });

  // The frequent-reset (BZ-Builder) shape: 20 bands of 40 rows, seq resets to 0
  // each band, so low seqs recur across the whole ts span and no band climbs high.
  // Strong assertions: the window is the exact newest-300 by ts at open AND after
  // a live append -- window COMPLETENESS, not merely "the newest row is present".
  test('frequent resets: the window is the exact newest 300 at open and after a live append', async () => {
    const all: CycEngineMessage[] = [];
    for (let band = 0; band < 20; band++) {
      for (let k = 0; k < 40; k++) {
        all.push(msg(k, T0 + band * DAY + k * 60_000, 'b' + band + '-' + k));
      }
    }
    await rowStore.upsert(SID, all.map((m) => messageRow(SID, m)) as never);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    const before = projTexts();
    expect(before).toEqual(expectedNewest(all, WINDOW));
    expect(before).toHaveLength(WINDOW);

    // A live append at the true tail (a fresh band-19 row, reused low-ish seq).
    // While the chat is OPEN the window GROWS by the arrival, keeping every
    // newer-by-ts row: it is now the exact newest 301 by ts, no hole.
    const live = msg(40, T0 + 19 * DAY + 99 * 60_000, 'LIVE');
    all.push(live);
    await rowStore.upsert(SID, [messageRow(SID, live)] as never);

    const after = projTexts();
    expect(after).toHaveLength(WINDOW + 1);
    expect(after).toEqual(expectedNewest(all, WINDOW + 1));
    expect(after[after.length - 1]).toBe('LIVE');

    // Background eviction still cuts by ts, never by seq: with SID in the
    // background the floor rides to the exact newest 300 by ts, no band
    // half-evicted by a seq floor riding up over the ts-ordered index.
    rowStore.setOpen('ws://other.test:1/ws|p9');
    const live2 = msg(41, T0 + 19 * DAY + 100 * 60_000, 'LIVE2');
    all.push(live2);
    await rowStore.upsert(SID, [messageRow(SID, live2)] as never);
    const bg = projTexts();
    expect(bg).toHaveLength(WINDOW);
    expect(bg).toEqual(expectedNewest(all, WINDOW));
    expect(bg[bg.length - 1]).toBe('LIVE2');
  });
});
