import {afterEach, describe, expect, test} from 'vitest';
import {
  migrateLegacyHistory,
  rowsFromLegacyPages,
  type LegacyPage
} from '../engine/store/rows/migrate';
import type {StoreRow} from '../engine/store/rows/core';

afterEach(() => {
  try {
    localStorage.clear();
  } catch {}
});

const page = (sid: string, n: number, over: Partial<LegacyPage> = {}): LegacyPage => ({
  key: `${sid}|p${n}`,
  sessionId: sid,
  messages: [
    {id: 1, role: 'user', kind: 'text', text: 'q', ts: n * 100, seq: n * 100, mid: `mr-${n}a`},
    {
      id: 2,
      role: 'claude',
      kind: 'text',
      text: 'a',
      ts: n * 100 + 1,
      seq: n * 100 + 1,
      mid: `mr-${n}b`
    }
  ] as never,
  events: [{uuid: `se-${n}`, ts: n * 100 + 2, seq: n * 100 + 2, kind: 'tool', text: 'Bash'}],
  ...over
});

describe('rowsFromLegacyPages', () => {
  test('groups pages by session and splits rows across the two kinds', () => {
    const by = rowsFromLegacyPages([page('s1', 0), page('s1', 1), page('s2', 0)]);
    expect([...by.keys()].sort()).toEqual(['s1', 's2']);
    expect(by.get('s1')).toHaveLength(6); // 2 pages * (2 msgs + 1 event)
    const ids = by.get('s1')!.map((r) => r.id);
    expect(ids).toContain('m:mr-0a');
    expect(ids).toContain('e:se-0');
  });

  test('refuses stale rows: a message with no mid, or a row with no seq', () => {
    // A mid-less message (falls back to m@ts|role|text and twins the engine's
    // re-serve WITH a mid), an unseqed message (walls the newest window), and an
    // unseqed event are all dropped; only the sound mid+seq rows survive.
    const stale: LegacyPage = {
      key: 's3|p0',
      sessionId: 's3',
      messages: [
        {id: 1, role: 'user', kind: 'text', text: 'ok', ts: 10, seq: 10, mid: 'mr-ok'},
        {id: 2, role: 'claude', kind: 'text', text: 'nomid', ts: 11, seq: 11},
        {id: 3, role: 'claude', kind: 'text', text: 'noseq', ts: 12, mid: 'mr-noseq'}
      ] as never,
      events: [
        {uuid: 'se-ok', ts: 13, seq: 13, kind: 'tool', text: 'Bash'},
        {uuid: 'se-noseq', ts: 14, kind: 'tool', text: 'Bash'}
      ]
    };
    const by = rowsFromLegacyPages([stale]);
    const ids = by.get('s3')!.map((r) => r.id);
    expect(ids).toEqual(['m:mr-ok', 'e:se-ok']);
    expect(ids).not.toContain('m@11|claude|nomid'); // mid-less refused
    expect(ids).not.toContain('m:mr-noseq'); // unseqed message refused
    expect(ids).not.toContain('e:se-noseq'); // unseqed event refused
  });

  test('ignores non-page records (meta, roster) that share the store', () => {
    const meta = {key: 's1|meta', sessionId: 's1', messages: undefined} as unknown as LegacyPage;
    const by = rowsFromLegacyPages([page('s1', 0), meta]);
    expect(by.get('s1')).toHaveLength(3);
  });
});

describe('migrateLegacyHistory runs once, idempotently, then drops the pages', () => {
  test('imports every page, drops the store, and sets the flag', async () => {
    const imported: StoreRow[] = [];
    let dropped = 0;
    const deps = {
      readLegacyPages: async () => [page('s1', 0), page('s1', 1)],
      importRows: async (_sid: string, rows: StoreRow[]) => {
        imported.push(...rows);
      },
      dropLegacyPages: async () => {
        dropped++;
      }
    };
    const r = await migrateLegacyHistory(deps);
    expect(r).toMatchObject({sessions: 1, rows: 6, skipped: false});
    expect(imported).toHaveLength(6);
    expect(dropped).toBe(1);

    // a second boot: the flag makes it a no-op (control: nothing re-read)
    let reread = false;
    const r2 = await migrateLegacyHistory({
      readLegacyPages: async () => {
        reread = true;
        return [];
      },
      importRows: async () => {},
      dropLegacyPages: async () => {}
    });
    expect(r2.skipped).toBe(true);
    expect(reread).toBe(false);
  });
});
