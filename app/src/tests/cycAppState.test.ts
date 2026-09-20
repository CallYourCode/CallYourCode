import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {
  sessionState,
  dataState,
  orphanSweep,
  stagedBlocks,
  unsentWork,
  vaultHolds
} from '../sessionState';
describe('appState defaults', () => {
  test('boots live with no active session and empty per-tab memory', () => {
    expect(dataState.mode).toBe('live');
    expect(dataState.demoSessions).toEqual([]);
    expect(sessionState.activeId).toBeNull();
    expect(sessionState.shownDoc).toBeNull();
    expect(sessionState.tabSelection.size).toBe(0);
    expect(sessionState.chatConversationMode.size).toBe(0);
  });
  test('boot-guard counters start idle: nothing can be staged before the app exists', () => {
    expect(vaultHolds.writing).toBe(0);
    expect(stagedBlocks.held()).toBe(false);
    expect(orphanSweep.started).toBe(false);
  });
});
describe('unsentWork', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    unsentWork.until = 0;
    unsentWork.inFlight = () => false;
  });
  afterEach(() => vi.useRealTimers());
  test('idle by default', () => {
    expect(unsentWork.busy()).toBe(false);
  });
  test('hold() keeps busy until the deadline, then releases', () => {
    unsentWork.hold(5000);
    expect(unsentWork.busy()).toBe(true);
    vi.setSystemTime(1_000_000 + 4999);
    expect(unsentWork.busy()).toBe(true);
    vi.setSystemTime(1_000_000 + 5000);
    expect(unsentWork.busy()).toBe(false);
  });
  test('overlapping holds keep the LATEST deadline (never shorten)', () => {
    unsentWork.hold(5000);
    unsentWork.hold(1000);
    vi.setSystemTime(1_000_000 + 2000);
    expect(unsentWork.busy()).toBe(true);
    vi.setSystemTime(1_000_000 + 5001);
    expect(unsentWork.busy()).toBe(false);
  });
  test('inFlight() keeps it busy past any deadline (echo not settled)', () => {
    unsentWork.inFlight = () => true;
    expect(unsentWork.busy()).toBe(true);
  });
});
