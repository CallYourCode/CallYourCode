import {describe, expect, test} from 'vitest';
import {
  addDemand,
  cursorSeq,
  emptyCursor,
  isComplete,
  nextPage,
  notePageCommitted,
  renumberDirty,
  resetCoverage,
  type CursorState
} from '../engine/store/rows/cursor';

function seeded(tailPage: number, tailVersion = 100): CursorState {
  const st = emptyCursor(100);
  st.tailPage = tailPage;
  st.tailVersion = tailVersion;
  return st;
}

describe('newest-first backfill', () => {
  test('nextPage starts at the tail, then walks down page by page', () => {
    const st = seeded(3);
    expect(nextPage(st)).toBe(3);
    notePageCommitted(st, 3);
    expect(nextPage(st)).toBe(2);
    notePageCommitted(st, 2);
    expect(nextPage(st)).toBe(1);
    notePageCommitted(st, 1);
    expect(nextPage(st)).toBe(0);
    notePageCommitted(st, 0);
    expect(nextPage(st)).toBeNull();
    expect(isComplete(st)).toBe(true);
  });

  test('the cursor seq is the floor of the covered run and advances only on commit', () => {
    const st = seeded(5);
    expect(cursorSeq(st)).toBe(-1); // nothing covered yet
    notePageCommitted(st, 5);
    expect(cursorSeq(st)).toBe(500);
    notePageCommitted(st, 4);
    expect(cursorSeq(st)).toBe(400);
    // a non-adjacent commit does NOT lower the contiguous floor
    notePageCommitted(st, 1);
    expect(cursorSeq(st)).toBe(400);
  });
});

describe('demand hints jump the queue without breaking the cursor', () => {
  test('a demanded page is fetched next; it becomes covered only when connected', () => {
    const st = seeded(5);
    notePageCommitted(st, 5);
    notePageCommitted(st, 4);
    addDemand(st, 1);
    expect(nextPage(st)).toBe(1); // the UI is waiting on page 1
    notePageCommitted(st, 1); // fetched as an island, floor stays at 4
    expect(cursorSeq(st)).toBe(400);
    expect(nextPage(st)).toBe(3); // ordered backfill resumes below the run
    notePageCommitted(st, 3);
    notePageCommitted(st, 2);
    // reaching page 2 connects the island at 1, absorbing it
    expect(cursorSeq(st)).toBe(100);
  });

  test('a demand for an already covered page is a no-op', () => {
    const st = seeded(5);
    notePageCommitted(st, 5);
    addDemand(st, 5);
    expect(nextPage(st)).toBe(4);
  });
});

describe('renumber after an engine restart', () => {
  test('a regressed tail version marks coverage dirty; reset re-pulls', () => {
    const st = seeded(5, 200);
    notePageCommitted(st, 5);
    notePageCommitted(st, 4);
    expect(renumberDirty(st, 150)).toBe(true); // version went backwards
    expect(renumberDirty(st, 250)).toBe(false); // grew forward: fine
    resetCoverage(st, 6, 150);
    expect(cursorSeq(st)).toBe(-1);
    expect(nextPage(st)).toBe(6); // re-pull from the new tail
  });

  test('renumber is never dirty before anything is covered', () => {
    const st = seeded(5, 200);
    expect(renumberDirty(st, 1)).toBe(false);
  });
});
