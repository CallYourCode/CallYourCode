import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {chatRow} from '../features/chat/navigation/chatRow';
import {createSessionList} from '../features/sessions/components/sessionList';
import {setPresentationTheme, themePainterCount} from '../components/presentation';
import type {CycSession} from '../types';

const sess = (over: Partial<CycSession> = {}): CycSession =>
  ({
    id: 's1',
    name: 'Relay Server',
    messages: [],
    unread: 0,
    muted: false,
    cwd: '/srv/relay',
    lastActivity: 0,
    ...over
  }) as unknown as CycSession;

const bg = (el: Element | null) => (el as HTMLElement | null)?.style.backgroundColor ?? '';

// Normalize expected CSS values through jsdom before comparison.
const norm = (prop: string, v: string): string => {
  const p = document.createElement('div');
  p.style.setProperty(prop, v);
  return p.style.getPropertyValue(prop);
};
const color = (v: string) => norm('color', v);
const fill = (v: string) => norm('background-color', v);

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('selected (active) row highlight: was html body .cyc-session-entry.active --background', () => {
  test('active paints the selected-row fill per theme; inactive clears it', () => {
    const row = chatRow(sess(), {active: true});
    document.body.append(row);
    expect(row.style.getPropertyValue('background-color')).toBe('rgba(0, 0, 0, 0.055)');
    expect(row.style.getPropertyPriority('background-color')).toBe('important');

    setPresentationTheme('night');
    expect(row.style.getPropertyValue('background-color')).toBe('rgba(255, 255, 255, 0.07)');

    (row as any)._cycSync(sess(), {active: false});
    expect(row.style.getPropertyValue('background-color')).toBe('');
  });
});

describe('unread badge fill: was .cyc-stack .unread / .active .cyc-tally.unread', () => {
  test('status normally, fill when active, secondary when muted, per theme', () => {
    const row = chatRow(sess({unread: 4}));
    document.body.append(row);
    const unread = () => row.querySelector('.cyc-session-badge-unread');
    expect(bg(unread())).toBe(fill('#96602f')); // status (= primary), day

    (row as any)._cycSync(sess({unread: 4, muted: true}), {});
    expect(bg(unread())).toBe(fill('#6b6b70')); // secondary-color, muted, day

    (row as any)._cycSync(sess({unread: 4}), {active: true});
    expect(bg(unread())).toBe(fill('#96602f')); // fill (copper day == primary)
    setPresentationTheme('night');
    expect(bg(unread())).toBe(fill('#a86c38')); // fill diverges from primary at night
  });
});

describe('active .cyc-icon recolour: was .active .cyc-icon', () => {
  test('mute icon follows the active .cyc-icon -> primary-text override', () => {
    const row = chatRow(sess({muted: true}), {active: true});
    document.body.append(row);
    const mute = row.querySelector('.cyc-session-mute-icon') as HTMLElement;
    expect(mute.style.color).toBe(color('#1c1c1e')); // primary-text day
    (row as any)._cycSync(sess({muted: true}), {active: false});
    expect(mute.style.color).toBe(''); // falls back to the pinned-color utility
  });
});

describe('state badge grey: was html body .cyc-state-badge (theme-branched)', () => {
  test('the done/unknown dot is the fixed day/night grey, not blocked danger', () => {
    const row = chatRow(sess({unread: 0, status: 'done'} as any), {mark: 'done'});
    document.body.append(row);
    const dot = () => row.querySelector('.cyc-state-badge');
    expect(bg(dot())).toBe(fill('#b4b4b8'));
    setPresentationTheme('night');
    expect(bg(dot())).toBe(fill('#5c5c62'));
  });
});

describe('dead avatar (was .cyc-session-entry.cyc-dead .cyc-session-avatar)', () => {
  test('dead greyscales the avatar and marks the row; clearing removes it', () => {
    const row = chatRow(sess(), {dead: true});
    document.body.append(row);
    const avatar = () => row.querySelector('.cyc-session-avatar') as HTMLElement;
    expect(row.classList.contains('cyc-dead')).toBe(true);
    expect(avatar().style.filter).toBe('grayscale(1)');
    (row as any)._cycSync(sess(), {dead: false});
    expect(row.classList.contains('cyc-dead')).toBe(false);
    expect(avatar().style.filter).toBe('');
  });
});

describe('big-row subtitle geometry: was .cyc-session-entry-big .cyc-list-row-subtitle', () => {
  // 2026-09-02: 1rem -> 0.875rem (14px), one size in every state, a step under
  // the 1rem title; see cycChatRowSubtitle.test.ts.
  test('subtitle is 0.875rem/1.375rem with no top gap, inline-important', () => {
    const row = chatRow(sess());
    const subtitle = row.querySelector('.cyc-list-row-subtitle') as HTMLElement;
    expect(subtitle.style.getPropertyValue('font-size')).toBe('0.875rem');
    expect(subtitle.style.getPropertyPriority('font-size')).toBe('important');
    expect(subtitle.style.getPropertyValue('line-height')).toBe('1.375rem');
    expect(subtitle.style.getPropertyValue('margin-top')).toBe(norm('margin-top', '0'));
  });
});

describe('audio rail: was .cyc-clip-speaking (row shadow + badge fill)', () => {
  test('speaking paints the fixed #4ec97b rail and badge; none clears them', () => {
    const list = createSessionList({sessions: [sess()], onOpen: () => {}});
    document.body.append(list.el);
    const row = () => list.el.querySelector('[data-session-id="s1"]') as HTMLElement;

    list.setRowAudioState('s1', 'speaking');
    expect(row().style.boxShadow).toBe('inset 3px 0 0 #4ec97b');
    const badge = row().querySelector('.cyc-list-row-audio-badge') as HTMLElement;
    expect(badge.style.backgroundColor).toBe(fill('#4ec97b'));
    expect(badge.className).toContain('flex');
    expect(badge.className).not.toContain('hidden');

    list.setRowAudioState('s1', 'paused');
    expect(row().style.boxShadow).toBe(''); // only speaking gets the rail
    expect(
      (row().querySelector('.cyc-list-row-audio-badge') as HTMLElement).style.backgroundColor
    ).toBe('');

    list.setRowAudioState('s1', 'none');
    expect(row().querySelector('.cyc-list-row-audio-badge')).toBeNull();
  });
});

describe('theme painter lifecycle', () => {
  test('a detached row is pruned on the next theme flip', () => {
    const row = chatRow(sess({unread: 1}), {active: true});
    document.body.append(row);
    const before = themePainterCount();
    row.remove();
    setPresentationTheme('night');
    expect(themePainterCount()).toBeLessThan(before);
  });
});
