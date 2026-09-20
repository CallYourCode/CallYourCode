import {describe, expect, test} from 'vitest';
import {planHistoryEvictions, PAGE_TTL_MS, MAX_PAGE_RECORDS} from '../engine/history';

// planHistoryEvictions is pure: it takes every row in the `cyc-history` store,
// the clock, and the caps, and returns the list of PAGE keys to delete. These
// tests pin the two rules (TTL, then oldest-first over a count cap) and the one
// invariant that keeps a cold offline open working: `|meta` and `|roster` rows
// are never evicted.

const now = 1_800_000_000_000;
const page = (sid: string, n: number, savedAt: number) => ({key: `${sid}|p${n}`, savedAt});
const meta = (sid: string, savedAt: number) => ({key: `${sid}|meta`, savedAt});
const roster = (engineKey: string, savedAt: number) => ({key: `${engineKey}|roster`, savedAt});

const caps = {ttlMs: PAGE_TTL_MS, maxPages: MAX_PAGE_RECORDS};

describe('planHistoryEvictions', () => {
  test('drops pages older than the TTL, keeps fresh ones', () => {
    const rows = [
      page('s', 0, now - PAGE_TTL_MS - 1),
      page('s', 1, now - PAGE_TTL_MS - 10_000),
      page('s', 2, now - 1000)
    ];
    const doomed = planHistoryEvictions(rows, now, caps);
    expect(doomed.sort()).toEqual(['s|p0', 's|p1']);
    expect(doomed).not.toContain('s|p2');
  });

  test('over the count cap, drops the oldest pages first', () => {
    const rows = Array.from({length: MAX_PAGE_RECORDS + 3}, (_, i) =>
      page('s', i, now - (MAX_PAGE_RECORDS + 3 - i) * 1000)
    );
    const doomed = planHistoryEvictions(rows, now, caps);
    expect(doomed).toHaveLength(3);
    // the three oldest keys are p0, p1, p2 (smallest savedAt)
    expect(doomed.sort()).toEqual(['s|p0', 's|p1', 's|p2']);
  });

  test('never evicts |meta or |roster rows, even when stale and over cap', () => {
    const rows = [
      meta('s', now - PAGE_TTL_MS * 10),
      roster('eng', now - PAGE_TTL_MS * 10),
      ...Array.from({length: MAX_PAGE_RECORDS + 5}, (_, i) =>
        page('s', i, now - (MAX_PAGE_RECORDS + 5 - i) * 1000)
      )
    ];
    const doomed = planHistoryEvictions(rows, now, caps);
    expect(doomed).not.toContain('s|meta');
    expect(doomed).not.toContain('eng|roster');
    for (const k of doomed) expect(k).toMatch(/\|p\d+$/);
  });

  test('drops nothing when under both caps', () => {
    const rows = [
      page('s', 0, now - 5000),
      page('s', 1, now - 4000),
      meta('s', now - 4000),
      roster('eng', now - 4000)
    ];
    expect(planHistoryEvictions(rows, now, caps)).toEqual([]);
  });

  test('TTL and count cap combine without double-listing a key', () => {
    const rows = [
      page('s', 0, now - PAGE_TTL_MS - 1), // stale
      ...Array.from({length: MAX_PAGE_RECORDS + 1}, (_, i) =>
        page('s', i + 100, now - (MAX_PAGE_RECORDS + 1 - i) * 1000)
      )
    ];
    const doomed = planHistoryEvictions(rows, now, caps);
    expect(new Set(doomed).size).toBe(doomed.length);
    expect(doomed).toContain('s|p0');
  });
});
