import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {chatRow, type SyncableRow} from '../features/chat/navigation/chatRow';
import {setPresentationTheme} from '../components/presentation';
import type {CycSession} from '../types';

// Owner request 2026-09-05: the merged conversation list shows a HOST chip on
// each row; model and harness get matching chips. chatRow renders whatever
// chip strings it is handed (the merged-only gate lives in listPane, tested in
// cycListPane.test.ts); these tests pin the rendering contract: right text,
// the same chip face as the host chip, no chip when the fact is absent, and a
// live sync repaints them.

const NOW = 1_700_000_000_000;

const sess = (over: Partial<CycSession> = {}): CycSession =>
  ({
    id: 's1',
    name: 'builder',
    messages: [],
    unread: 0,
    muted: false,
    thinking: false,
    cwd: '/repo',
    lastActivity: 0,
    title: {text: 'claude', detail: null},
    ...over
  }) as unknown as CycSession;

const chipOf = (row: HTMLElement, cls: string) => row.querySelector<HTMLElement>('.' + cls);

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('harness and model chips on a session row', () => {
  test('both chips render with their text, beside the host chip', () => {
    const row = chatRow(sess(), {
      now: NOW,
      mergedTab: 'homebox',
      harnessChip: 'Codex',
      modelChip: 'Fable 5'
    });
    expect(chipOf(row, 'cyc-list-row-tab')?.textContent).toBe('homebox');
    expect(chipOf(row, 'cyc-list-row-harness')?.textContent).toBe('Codex');
    expect(chipOf(row, 'cyc-list-row-model')?.textContent).toBe('Fable 5');
  });

  test('the chips wear the host chip face (same utility classes)', () => {
    const row = chatRow(sess(), {
      now: NOW,
      mergedTab: 'homebox',
      harnessChip: 'Codex',
      modelChip: 'Fable 5'
    });
    const host = chipOf(row, 'cyc-list-row-tab')!;
    const harness = chipOf(row, 'cyc-list-row-harness')!;
    const model = chipOf(row, 'cyc-list-row-model')!;
    // Every visual class of the host chip is on both new chips; each chip
    // keeps only its identity class (and the model chip its max-w truncation).
    const face = [...host.classList].filter((c) => c !== 'cyc-list-row-tab');
    for (const c of face) {
      expect(harness.classList.contains(c), `harness chip missing ${c}`).toBe(true);
      expect(model.classList.contains(c), `model chip missing ${c}`).toBe(true);
    }
    expect([...model.classList]).toContain('max-w-[7rem]');
  });

  test('an absent fact renders no chip at all, never a blank one', () => {
    const row = chatRow(sess(), {now: NOW, mergedTab: 'homebox'});
    expect(chipOf(row, 'cyc-list-row-harness')).toBeNull();
    expect(chipOf(row, 'cyc-list-row-model')).toBeNull();
    const alone = chatRow(sess(), {now: NOW, harnessChip: 'Claude'});
    expect(chipOf(alone, 'cyc-list-row-harness')?.textContent).toBe('Claude');
    expect(chipOf(alone, 'cyc-list-row-model')).toBeNull();
  });

  test('a sync with changed chip strings repaints them; dropping them removes the chips', () => {
    const row = chatRow(sess(), {
      now: NOW,
      harnessChip: 'Claude',
      modelChip: 'Opus 4.8'
    }) as SyncableRow;
    row._cycSync!(sess(), {now: NOW, harnessChip: 'Claude', modelChip: 'Fable 5'});
    expect(chipOf(row, 'cyc-list-row-model')?.textContent).toBe('Fable 5');
    expect(chipOf(row, 'cyc-list-row-harness')?.textContent).toBe('Claude');
    row._cycSync!(sess(), {now: NOW});
    expect(chipOf(row, 'cyc-list-row-model')).toBeNull();
    expect(chipOf(row, 'cyc-list-row-harness')).toBeNull();
  });
});
