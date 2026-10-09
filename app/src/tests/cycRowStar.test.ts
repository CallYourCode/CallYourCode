import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

import {chatRow, type SyncableRow} from '../features/chat/navigation/chatRow';
import {setPresentationTheme} from '../components/presentation';
import {
  SESSION_SELECTED_ROW,
  SESSION_STAR_INK,
  SESSION_STAR_SELECTED_ROW
} from '../features/sessions/sessionsPaint';
import type {CycSession} from '../types';

// The list star (agent-marks mockup, "Star (on/off)"): a starred row shows a
// gold star after the name and a gold wash on the whole row, in both themes,
// and keeps its gold when selected; an unstarred row is exactly as before.

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
    ...over
  }) as unknown as CycSession;

const star = (row: HTMLElement) => row.querySelector<HTMLElement>('.cyc-list-row-star');
const wash = (row: HTMLElement) =>
  [...row.classList].filter((c) => c.startsWith('bg-[color-mix(in_srgb,#'));

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('a starred session row', () => {
  test('shows the star right after the name, in gold, and a gold wash', () => {
    const row = chatRow(sess(), {starred: true});
    document.body.append(row);
    const title = row.querySelector('.cyc-list-row-title')!;
    const kids = [...title.children];
    expect(kids[0]!.textContent).toBe('builder');
    expect(kids[1]).toBe(star(row));
    expect(star(row)!.style.color).toBe('rgb(224, 165, 38)'); // #e0a526
    expect(row.classList.contains('cyc-starred')).toBe(true);
    expect(wash(row)).toEqual(['bg-[color-mix(in_srgb,#e0a526_10%,var(--cyc-surface))]']);
    // the hover is a deeper gold, never the plain row's grey
    expect(row.className).not.toContain('fine:hover:bg-[#f2f2f3]!');
  });

  test('an unstarred row has no star, no wash, and the plain hover', () => {
    const row = chatRow(sess(), {});
    expect(star(row)).toBeNull();
    expect(row.classList.contains('cyc-starred')).toBe(false);
    expect(wash(row)).toEqual([]);
    expect(row.className).toContain('fine:hover:bg-[#f2f2f3]!');
  });

  test('a selected starred row keeps its gold; a selected plain row keeps its grey', () => {
    // jsdom's CSSOM drops a color-mix() value, so read what the row was given.
    const set = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
    const bgOf = () =>
      set.mock.calls
        .filter((c) => c[0] === 'background-color')
        .map((c) => c[1])
        .at(-1);
    chatRow(sess(), {starred: true, active: true});
    expect(bgOf()).toBe(SESSION_STAR_SELECTED_ROW.day);
    chatRow(sess({id: 's2'}), {active: true});
    expect(bgOf()).toBe(SESSION_SELECTED_ROW.day);
    set.mockRestore();
  });

  test('night swaps to its own gold for the wash and the star', () => {
    const row = chatRow(sess(), {starred: true, active: false});
    document.body.append(row);
    setPresentationTheme('night');
    expect(wash(row)).toEqual(['bg-[color-mix(in_srgb,#ffae1a_11%,var(--cyc-surface))]']);
    expect(star(row)!.style.color).toBe('rgb(245, 180, 42)'); // #f5b42a
    expect(SESSION_STAR_INK.night).toBe('#f5b42a');
  });

  test('a live sync stars and unstars the row in place', () => {
    const row = chatRow(sess(), {}) as SyncableRow;
    row._cycSync!(sess(), {starred: true});
    expect(star(row)).not.toBeNull();
    expect(wash(row)).toHaveLength(1);
    row._cycSync!(sess(), {});
    expect(star(row)).toBeNull();
    expect(wash(row)).toEqual([]);
    expect(row.classList.contains('cyc-starred')).toBe(false);
  });
});
