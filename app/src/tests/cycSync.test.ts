import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import * as sync from '../engine/sync';

// The sync seam: an engine is live once its pipe sealed AND the host frame AND
// the first sessions frame landed (the settled edge), in any order. The
// connected edge fires once per connect and never again until the engine went
// down in between. No timers while nothing is dialing: offline is silence.

const KEY = 'ws://sync.test/ws';

describe('sync seam', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sync.__resetForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('status is offline until sealed AND host AND sessions landed, in either order', () => {
    expect(sync.status()).toBe('offline');
    sync.noteSealed(KEY);
    expect(sync.status()).toBe('syncing');
    sync.noteHost(KEY);
    expect(sync.status()).toBe('syncing');
    expect(sync.isLive({key: KEY})).toBe(false);
    sync.noteSessions(KEY);
    expect(sync.status()).toBe('live');
    expect(sync.isLive({key: KEY})).toBe(true);

    // The other order: sessions before host.
    sync.noteDown(KEY);
    expect(sync.status()).toBe('offline');
    expect(sync.isLive({key: KEY})).toBe(false);
    sync.noteSealed(KEY);
    sync.noteSessions(KEY);
    expect(sync.status()).toBe('syncing');
    sync.noteHost(KEY);
    expect(sync.status()).toBe('live');
  });

  test('onConnected fires once per connect on the settled edge; unsubscribe stops it', () => {
    const seen: string[] = [];
    const off = sync.onConnected((key) => seen.push(key));

    sync.noteSealed(KEY);
    sync.noteHost(KEY);
    expect(seen).toEqual([]);
    sync.noteSessions(KEY);
    expect(seen).toEqual([KEY]);
    // Repeated frames on the same live engine do not re-fire.
    sync.noteSessions(KEY);
    sync.noteHost(KEY);
    expect(seen).toEqual([KEY]);

    // Down then up again: one more edge.
    sync.noteDown(KEY);
    sync.noteSealed(KEY);
    sync.noteHost(KEY);
    sync.noteSessions(KEY);
    expect(seen).toEqual([KEY, KEY]);

    off();
    sync.noteDown(KEY);
    sync.noteSealed(KEY);
    sync.noteHost(KEY);
    sync.noteSessions(KEY);
    expect(seen).toEqual([KEY, KEY]);
    // And nothing here ever armed a timer.
    expect(vi.getTimerCount()).toBe(0);
  });
});
