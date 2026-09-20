import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import type {CycSession} from '../types';
import {
  orderByLatest,
  applyMergedOrder,
  projectMembership,
  allSessions,
  active
} from '../sessionSelectors';
import {sessionState, dataState} from '../sessionState';
import {setSortByLatest} from '../features/settings/preferences';
function sess(id: string, over: Partial<CycSession> = {}): CycSession {
  return {
    id,
    name: id,
    unread: 0,
    muted: false,
    thinking: false,
    messages: [],
    ...over
  } as CycSession;
}
beforeEach(() => {
  localStorage.clear();
  dataState.mode = 'test';
  dataState.demoSessions = [];
  sessionState.activeId = null;
});
afterEach(() => {
  setSortByLatest(false);
  dataState.mode = 'live';
  dataState.demoSessions = [];
});
describe('orderByLatest', () => {
  test('a no-op while the preference is off (the default is ON, 2026-08-10)', () => {
    setSortByLatest(false);
    const base = [sess('a', {lastActivity: 1}), sess('b', {lastActivity: 9})];
    expect(orderByLatest(base)).toBe(base);
  });
  test('newest lastActivity first, stable for ties, input untouched', () => {
    setSortByLatest(true);
    const base = [
      sess('a', {lastActivity: 5}),
      sess('b'),
      sess('c', {lastActivity: 9}),
      sess('d', {lastActivity: 5})
    ];
    const out = orderByLatest(base);
    expect(out.map((s) => s.id)).toEqual(['c', 'a', 'd', 'b']);
    expect(base.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
describe('applyMergedOrder self-healing', () => {
  test('no stored arrangement: the default order stands', () => {
    const base = [sess('x'), sess('y')];
    expect(applyMergedOrder(base).map((s) => s.id)).toEqual(['x', 'y']);
  });
});
describe('projectMembership', () => {
  test('drops dead rows except the open chat, keeps churn greys', () => {
    const dead = sess('dead', {} as never);
    (dead as CycSession & {alive?: boolean}).alive = false;
    const churn = sess('churn');
    (churn as CycSession & {alive?: boolean; churnGrey?: boolean}).alive = false;
    (churn as CycSession & {churnGrey?: boolean}).churnGrey = true;
    const live = sess('live');
    expect(projectMembership([dead, churn, live]).map((s) => s.id)).toEqual(['churn', 'live']);
    sessionState.activeId = 'dead';
    expect(projectMembership([dead, churn, live]).map((s) => s.id)).toEqual([
      'dead',
      'churn',
      'live'
    ]);
  });
});
describe('demo-mode reads', () => {
  test('allSessions and active read the demo list in demo mode', () => {
    const a = sess('a');
    dataState.demoSessions = [a, sess('b')];
    expect(allSessions().length).toBe(2);
    sessionState.activeId = 'a';
    expect(active()).toBe(a);
    sessionState.activeId = 'ghost';
    expect(active()).toBeNull();
  });
});
