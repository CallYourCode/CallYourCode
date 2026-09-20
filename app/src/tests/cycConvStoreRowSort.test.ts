import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import * as rowStore from '../engine/store/rows/rowStore';
import {eventRow, messageRow} from '../engine/store/rows/core';
import type {CycEngineMessage} from '../engine/store/types';
import type {CycSessionEvent} from '../types';
import {memTx} from './rowStoreFake';

// THE MIS-SORT (Hunter chat ad24c6f5, field 2026-09-18). The engine's own seq
// axis is not always chronological in a legacy log: a harness session-resume
// RESTARTED the message seq at 1, so a later-dated run reuses a seq band the
// earlier run already spent; and the session-record rows sit on a SEPARATE,
// higher seq band than the messages they are contemporaneous with (a record
// stamped on day 0 carrying a seq that, by number, belongs beside day-14 rows).
//
// The store used to order strictly by seq (seq first, ts only to break a seq
// tie), so it rendered those rows exactly where their wrong seq put them: an
// old-dated row sandwiched among newer ones, and the newest-by-seq row was not
// the newest in time. Ordering by ts (which stampTs keeps strictly increasing
// per session) puts every row back where its clock says it belongs. This fixture
// mirrors the real shape with invented text and drives it through the real store
// door and window; it FAILS on 83e1d40 (seq-first order) and passes on the fix.

const SID = 'ws://rowsort.test:7799/ws|p1';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_756_000_000_000; // an arbitrary "day 0" epoch-ms base

function msg(seq: number, ts: number, text: string, role: 'user' | 'claude') {
  // Mid-less rows, exactly like the pre-mid engine files re-serve: identity
  // falls back to m@ts|role|text, and seq is the only ordering hint the row
  // carries. This is the shape the mis-sort needs.
  return messageRow(SID, {role, kind: 'text', text, ts, seq} as unknown as CycEngineMessage);
}
function rec(seq: number, ts: number, text: string) {
  return eventRow(SID, {uuid: 'se-' + seq, ts, seq, kind: 'tool', text} as CycSessionEvent);
}

// Build the Hunter shape: a first run's messages on seq 0..MAX, a resume that
// RESETS the message seq to 1 and then climbs, and records on a higher un-reset
// band whose ts starts back at day 0.
function hunterShape() {
  const rows: ReturnType<typeof msg>[] = [];
  const RESET_AT = 220;
  // Run A: day 0 through day ~2, message seq 0..220, a tight morning cadence.
  for (let i = 0; i <= RESET_AT; i++) {
    const day = Math.floor(i / 90); // ~90 msgs per day
    const ts = T0 + day * DAY + (i % 90) * 20_000;
    rows.push(msg(i, ts, 'runA-' + i, i % 2 ? 'claude' : 'user'));
  }
  // The resume-control answer: seq RESET to 1, day 3.
  rows.push(msg(1, T0 + 3 * DAY + 9 * 60 * 60 * 1000, 'runB open', 'user'));
  // Run B: day 3 through day 18, message seq climbing 2.. (sparse: records take
  // the holes on the shared axis).
  let s = 2;
  for (let day = 3; day <= 18; day++) {
    for (let k = 0; k < 12; k++) {
      rows.push(
        msg(s, T0 + day * DAY + k * 30_000, 'runB-' + day + '-' + k, k % 2 ? 'claude' : 'user')
      );
      s += 3;
    }
  }
  // Records: a SEPARATE, higher seq band (starts well above the reused message
  // band), but their ts starts back at day 0 and climbs across the whole span.
  let rs = 300;
  for (let day = 0; day <= 18; day++) {
    for (let k = 0; k < 5; k++) {
      rows.push(rec(rs, T0 + day * DAY + 15 * 60 * 60 * 1000 + k * 100, 'rec-' + day + '-' + k));
      rs += 7;
    }
  }
  return rows;
}

// The store's own merged order (messages and records interleaved), read off the
// warm mirror index for exactly the rows the window loaded.
function storeOrderTs(): number[] {
  const m = rowStore.__mirror(SID)!;
  const out: number[] = [];
  for (const t of m.idx) {
    const row = m.loaded.get(t.id);
    if (row) out.push(row.ts);
  }
  return out;
}

describe('the store orders a legacy non-chronological seq axis by time, not by seq', () => {
  beforeEach(() => {
    rowStore.__setBackingForTest(memTx().tx);
  });
  afterEach(() => {
    rowStore.__setBackingForTest(null);
  });

  test('a reset/reused seq band and an offset record band render in true time order', async () => {
    await rowStore.upsert(SID, hunterShape() as never);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 300);

    // The whole loaded window is in true chronological order: no old-dated row
    // is sandwiched among newer ones (the field symptom).
    const ts = storeOrderTs();
    expect(ts.length).toBeGreaterThan(0);
    let inversions = 0;
    for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1]) inversions++;
    expect(inversions).toBe(0);

    // The bottom of the transcript (the row the sidebar clock reads) is the
    // newest row in the whole session, not a stale reused-seq row.
    const windowNewest = ts[ts.length - 1];
    const m = rowStore.__mirror(SID)!;
    let sessionNewest = 0;
    for (const t of m.idx) if (t.ts > sessionNewest) sessionNewest = t.ts;
    expect(windowNewest).toBe(sessionNewest);
  });

  test('re-serving the same rows under their engine seqs keeps the time order (idempotent)', async () => {
    const rows = hunterShape();
    await rowStore.upsert(SID, rows as never);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 300);
    // A second serve of the same rows (a re-attach) must not re-scramble.
    await rowStore.upsert(SID, rows as never);
    const ts = storeOrderTs();
    let inversions = 0;
    for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1]) inversions++;
    expect(inversions).toBe(0);
  });
});
