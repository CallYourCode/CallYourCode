import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import * as sync from '../engine/sync';

// The connection manager: per-engine states, the backoff
// numbers, the poke reset, the hidden stop, and the ONE aggregate word.

const A = 'ws://a.test/ws';
const B = 'ws://b.test/ws';

type FakeDialer = {redialNow: (caller: string) => boolean; calls: string[]; willDial: boolean};

function dialer(willDial = true): FakeDialer {
  const d: FakeDialer = {calls: [], willDial, redialNow: () => false};
  d.redialNow = (caller: string) => {
    d.calls.push(caller);
    return d.willDial;
  };
  return d;
}

// A dial the client started on its own (connect) and that failed: the client
// reports connecting, then disconnected, then asks the manager for the next.
function failDial(key: string) {
  sync.noteDialing(key);
  sync.noteDown(key);
  return sync.schedule(key);
}

function settle(key: string) {
  sync.noteSealed(key);
  sync.noteHost(key);
  sync.noteSessions(key);
}

describe('sync connection manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    sync.__resetForTest(() => 0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    sync.__resetForTest();
  });

  test('backoff numbers: min(30000, 1000 * 2^n) scaled by 0.75..1.25', () => {
    expect(sync.backoffMs(0, 0.5)).toBe(1000);
    expect(sync.backoffMs(1, 0.5)).toBe(2000);
    expect(sync.backoffMs(2, 0.5)).toBe(4000);
    expect(sync.backoffMs(3, 0.5)).toBe(8000);
    expect(sync.backoffMs(4, 0.5)).toBe(16000);
    expect(sync.backoffMs(5, 0.5)).toBe(30000);
    expect(sync.backoffMs(9, 0.5)).toBe(30000);
    expect(sync.backoffMs(0, 0)).toBe(750);
    expect(sync.backoffMs(0, 1)).toBe(1250);
    expect(sync.backoffMs(5, 1)).toBe(37500);
    expect(sync.backoffMs(5, 0)).toBe(22500);
  });

  test('transitions: dialing -> sealed -> settled -> live, then down -> dialing on the timer', () => {
    const d = dialer();
    sync.register(A, d);
    sync.start();
    expect(sync.engineState(A)).toBe('idle');

    sync.noteDialing(A);
    expect(sync.engineState(A)).toBe('dialing');
    sync.noteSealed(A);
    expect(sync.engineState(A)).toBe('sealed');
    sync.noteHost(A);
    expect(sync.engineState(A)).toBe('sealed');
    sync.noteSessions(A);
    expect(sync.engineState(A)).toBe('live');
    expect(sync.status()).toBe('live');

    // Something owed: draining; nothing owed: live.
    sync.noteQueued(A, 2);
    expect(sync.engineState(A)).toBe('draining');
    expect(sync.status()).toBe('syncing');
    sync.noteQueued(A, 0);
    expect(sync.engineState(A)).toBe('live');
    sync.noteTransfers(true);
    expect(sync.engineState(A)).toBe('draining');
    sync.noteTransfers(false);
    expect(sync.engineState(A)).toBe('live');

    // The pipe goes: down, and the client asks for the next dial.
    sync.noteDown(A);
    expect(sync.engineState(A)).toBe('down');
    expect(sync.schedule(A)).toBe(1000);
    expect(d.calls).toEqual([]);
    vi.advanceTimersByTime(999);
    expect(d.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(d.calls).toEqual(['backoff']);
    expect(sync.engineState(A)).toBe('dialing');
  });

  test('backoff doubles per failed dial, caps at 30 s, resets on settled', () => {
    const d = dialer();
    sync.register(A, d);
    sync.start();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      waits.push(failDial(A));
      vi.runOnlyPendingTimers();
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(d.calls.length).toBe(7);

    settle(A);
    sync.noteDown(A);
    expect(sync.schedule(A)).toBe(1000);
  });

  test('poke resets the backoff and dials now; a mid-dial engine is left alone', () => {
    const d = dialer();
    sync.register(A, d);
    sync.start();
    failDial(A);
    failDial(A);
    failDial(A);
    expect(sync.schedule(A)).toBe(8000);
    expect(sync.activeTimers()).toBe(2); // the backoff timer and the connecting window

    sync.poke('visible');
    expect(d.calls).toEqual(['poke:visible']);
    expect(sync.engineState(A)).toBe('dialing');
    // The old timer is gone: nothing fires later.
    vi.advanceTimersByTime(60_000);
    expect(d.calls).toEqual(['poke:visible']);

    // After the poke the attempt count starts over.
    sync.noteDown(A);
    expect(sync.schedule(A)).toBe(1000);

    // A poke while a dial is in flight does not stack a second one.
    vi.runOnlyPendingTimers();
    expect(sync.engineState(A)).toBe('dialing');
    sync.poke('intent');
    expect(d.calls).toEqual(['poke:visible', 'backoff']);
  });

  test('hidden for 30 s parks the dial with no timers; visible pokes it back', () => {
    const d = dialer();
    sync.register(A, d);
    sync.start();
    failDial(A);
    sync.setHidden(true);
    // Under 30 s hidden: the backoff still dials.
    vi.advanceTimersByTime(1000);
    expect(d.calls).toEqual(['backoff']);
    expect(sync.engineState(A)).toBe('dialing');
    // The hidden stop lands at 30 s: the engine is parked, dial or no dial.
    vi.advanceTimersByTime(29_000);
    expect(sync.engineState(A)).toBe('idle');
    // The client's in-flight dial fails and asks for the next: parked, no timer.
    sync.noteDown(A);
    expect(sync.schedule(A)).toBe(0);
    expect(sync.engineState(A)).toBe('idle');
    // Parked: no dial timer, no connecting window; offline is silence.
    vi.advanceTimersByTime(600_000);
    expect(sync.activeTimers()).toBe(0);
    expect(d.calls).toEqual(['backoff']);
    expect(sync.status()).toBe('offline');

    sync.setHidden(false);
    sync.poke('visible');
    expect(d.calls).toEqual(['backoff', 'poke:visible']);
    expect(sync.engineState(A)).toBe('dialing');
  });

  test('navigator.onLine false parks; online pokes; a poke always dials', () => {
    const d = dialer();
    sync.register(A, d);
    sync.start();
    failDial(A);
    sync.setOnline(false);
    expect(sync.engineState(A)).toBe('idle');
    expect(sync.activeTimers()).toBe(1); // only the connecting window
    vi.advanceTimersByTime(600_000);
    expect(sync.activeTimers()).toBe(0);
    expect(d.calls).toEqual([]);

    // Still offline per the radio: a poke dials anyway (advisory).
    sync.poke('pull');
    expect(d.calls).toEqual(['poke:pull']);

    sync.noteDown(A);
    expect(sync.schedule(A)).toBe(0);
    sync.setOnline(true);
    sync.poke('online');
    expect(d.calls).toEqual(['poke:pull', 'poke:online']);
  });

  test('a held client (pairing / identity) leaves the engine down, not dialing', () => {
    const d = dialer(false);
    sync.register(A, d);
    sync.start();
    failDial(A);
    vi.advanceTimersByTime(1000);
    expect(d.calls).toEqual(['backoff']);
    expect(sync.engineState(A)).toBe('down');
    // No dial timer for a held client; the only timer left is the connecting window.
    expect(sync.activeTimers()).toBe(1);
    vi.advanceTimersByTime(600_000);
    expect(sync.activeTimers()).toBe(0);
    expect(d.calls).toEqual(['backoff']);
  });

  test('aggregate word: live only when every engine is live; connecting is time-boxed', () => {
    const da = dialer();
    const db = dialer();
    sync.register(A, da);
    sync.register(B, db);
    const words: string[] = [];
    sync.onStatus((s) => words.push(s));
    sync.start();
    sync.noteDialing(A);
    sync.noteDialing(B);
    expect(sync.status()).toBe('connecting');
    vi.advanceTimersByTime(4999);
    expect(sync.status()).toBe('connecting');
    vi.advanceTimersByTime(1);
    expect(sync.status()).toBe('offline');
    expect(words).toEqual(['connecting', 'offline']);

    sync.noteSealed(A);
    expect(sync.status()).toBe('syncing');
    settle(A);
    // A live, B still dialing past the connecting window: not live, nothing
    // syncing, the window closed. The literal aggregate reads offline.
    expect(sync.status()).toBe('offline');
    settle(B);
    expect(sync.status()).toBe('live');
    sync.noteDown(B);
    expect(sync.status()).toBe('offline'); // A is live, B is down, no dial pending
    expect(words).toEqual(['connecting', 'offline', 'syncing', 'offline', 'syncing', 'live', 'offline']);
  });

  test('onConnected and onDisconnected fire on the edges, with the settled hook first', () => {
    sync.register(A, dialer());
    const order: string[] = [];
    sync.setSettledEdge((k) => order.push('edge:' + k));
    sync.onConnected((k) => order.push('up:' + k));
    sync.onDisconnected((k) => order.push('down:' + k));
    sync.start();
    sync.noteDialing(A);
    settle(A);
    expect(order).toEqual(['edge:' + A, 'up:' + A]);
    // A sealed pipe that dies before settling is not a disconnect.
    sync.noteDown(A);
    expect(order).toEqual(['edge:' + A, 'up:' + A, 'down:' + A]);
    sync.noteSealed(A);
    sync.noteDown(A);
    expect(order).toEqual(['edge:' + A, 'up:' + A, 'down:' + A]);
  });

  test('syncedAt remembers the last sync per session', () => {
    expect(sync.syncedAt('s1')).toBeUndefined();
    sync.noteSynced('s1', 42);
    expect(sync.syncedAt('s1')).toBe(42);
  });
});
