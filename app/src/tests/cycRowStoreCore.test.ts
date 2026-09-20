import {describe, expect, test} from 'vitest';
import {
  emptyMirror,
  eventRow,
  hasMoreBelow,
  messageRow,
  newestWindowIds,
  olderWindowIds,
  project,
  rowIdOfEvent,
  rowIdOfMessage,
  upsertMirror,
  WINDOW_FLOOR_ALL,
  type StoreRow
} from '../engine/store/rows/core';
import type {CycEngineMessage} from '../engine/store/types';

const SID = 'eng|p1';
const msg = (over: Partial<CycEngineMessage> = {}): CycEngineMessage =>
  ({
    id: 0,
    role: 'claude',
    kind: 'text',
    text: 't',
    ts: over.seq ?? 0,
    ...over
  }) as CycEngineMessage;

const mrow = (over: Partial<CycEngineMessage>): StoreRow => messageRow(SID, msg(over));

describe('durable identity is mid, never seq', () => {
  test('a mid keys a message; a legacy row falls back to ts|role|text', () => {
    expect(rowIdOfMessage({mid: 'mr-x', ts: 1, role: 'user', text: 'hi'})).toBe('m:mr-x');
    expect(rowIdOfMessage({ts: 1, role: 'user', text: 'hi'})).toBe('m@1|user|hi');
    expect(rowIdOfEvent({uuid: 'se-9'})).toBe('e:se-9');
  });

  test('a row re-served under a changed seq is ONE row, seq rewritten in place', () => {
    const m = emptyMirror();
    upsertMirror(m, [mrow({mid: 'mr-a', seq: 3, text: 'a'})]);
    const r = upsertMirror(m, [mrow({mid: 'mr-a', seq: 9, text: 'a'})]);
    expect(m.idx).toHaveLength(1);
    expect(m.idx[0].seq).toBe(9);
    expect(r.changed).toBe(true);
    // non-vacuity: a genuinely different mid IS a second row
    upsertMirror(m, [mrow({mid: 'mr-b', seq: 9, text: 'a'})]);
    expect(m.idx).toHaveLength(2);
  });

  test('colliding seqs across two mids both survive (real logs carry them)', () => {
    const m = emptyMirror();
    m.floor = WINDOW_FLOOR_ALL;
    upsertMirror(m, [
      mrow({mid: 'mr-a', seq: 5, text: 'a'}),
      mrow({mid: 'mr-b', seq: 5, text: 'b'})
    ]);
    expect(m.idx).toHaveLength(2);
    const {messages} = project(m);
    expect(messages.map((x) => x.text).sort()).toEqual(['a', 'b']);
  });
});

describe('window queries', () => {
  test('newestWindowIds returns the tail; olderWindowIds walks below the floor', () => {
    const m = emptyMirror();
    const rows = Array.from({length: 10}, (_, i) => mrow({mid: 'mr-' + i, seq: i, text: 'r' + i}));
    upsertMirror(m, rows);
    m.floor = m.idx[7];
    // only seqs 7..9 are "visible" after a small window; older below the floor
    const newest = newestWindowIds(m, 3);
    expect(newest).toEqual(['m:mr-7', 'm:mr-8', 'm:mr-9']);
    expect(hasMoreBelow(m)).toBe(true);
    const older = olderWindowIds(m, 3);
    expect(older).toEqual(['m:mr-4', 'm:mr-5', 'm:mr-6']);
  });

  test('a below-floor upsert updates the index but does NOT enter the loaded window', () => {
    const m = emptyMirror();
    upsertMirror(m, [mrow({mid: 'mr-9', seq: 9, text: 'tail'})]);
    m.floor = m.idx[0];
    const r = upsertMirror(m, [mrow({mid: 'mr-2', seq: 2, text: 'old'})]);
    expect(r.touchesWindow).toBe(false);
    expect(m.loaded.has('m:mr-2')).toBe(false);
    expect(m.idx.map((t) => t.seq)).toEqual([2, 9]);
    // and an at/above-floor upsert DOES touch the window
    const r2 = upsertMirror(m, [mrow({mid: 'mr-10', seq: 10, text: 'new'})]);
    expect(r2.touchesWindow).toBe(true);
    expect(m.loaded.has('m:mr-10')).toBe(true);
  });
});

describe('projection merges messages and events on the seq axis', () => {
  test('messages and events interleave by seq', () => {
    const m = emptyMirror();
    m.floor = WINDOW_FLOOR_ALL;
    upsertMirror(m, [
      mrow({mid: 'mr-1', seq: 1, text: 'm1'}),
      eventRow(SID, {uuid: 'se-2', ts: 2, seq: 2, kind: 'tool', text: 'Bash'}),
      mrow({mid: 'mr-3', seq: 3, text: 'm3'})
    ]);
    const {messages, events} = project(m);
    expect(messages.map((x) => x.text)).toEqual(['m1', 'm3']);
    expect(events.map((e) => e.uuid)).toEqual(['se-2']);
  });
});
