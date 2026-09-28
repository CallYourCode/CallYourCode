/* THE ONE-ROW SESSIONS FRAME, APP SIDE (Lane D, SYNC-CONTRACT V2a).
 *
 * When only one chat's list facts change the engine now sends ONE additive
 * {t:"session", ...row} instead of the whole ~42 KB roster. The app applies that
 * one row through the VERY SAME per-row code the full {t:"sessions"} frame runs
 * (applySessionRow), persists (one guarded roster write), and re-keys just that
 * list row. This pins the four properties the change lives or dies on:
 *   - a one-row frame applies to exactly that row (the others are untouched)
 *   - it persists exactly once (and the guard still skips an unchanged one)
 *   - a one-row frame for an id the app does not hold makes NO phantom row and
 *     asks the engine to re-serve the full roster instead of guessing
 *   - a later full frame reconciles a value a one-row frame set (and vice versa),
 *     so a missed frame in either direction self-heals
 *
 *   npx vitest run src/tests/cycSessionPatch.test.ts
 */
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {wireSessions} from '../engine/store/handlers/sessions';
import {__resetRosterFingerprintForTest} from '../engine/store/roster';
import * as history from '../engine/history';
import {
  conns,
  engineThinking,
  lastSettledTabs,
  markedUnread,
  seen,
  sessions,
  type Conn
} from '../engine/store/registry';
import type {HandlerCtx} from '../engine/store/handlers/types';

const WS = 'ws://session-patch.test:7788/ws';

// A connected engine whose frames we drive by hand. Mirrors the cycRosterWriteGuard
// harness, with the one extra thing the {t:"session"} handler can call: a
// re-serve request when it is handed a row it does not hold.
function fakeConn(attachedId: () => string): {
  fire: (ev: string, ...a: unknown[]) => void;
  resyncSessions: ReturnType<typeof vi.fn>;
} {
  const handlers: Record<string, (...a: never[]) => void> = {};
  const resyncSessions = vi.fn();
  const conn = {
    key: WS,
    state: 'connected',
    failed: false,
    user: 'u',
    host: 'h',
    hostname: 'h',
    tabs: [],
    plugins: [],
    voiceHealthy: true,
    helloSettled: true,
    client: {
      on: (ev: string, fn: never) => {
        handlers[ev] = fn as never;
      },
      setSessionTail: vi.fn(),
      detach: vi.fn(),
      attach: vi.fn(),
      heard: vi.fn(),
      progress: vi.fn(),
      resyncSessions
    }
  } as unknown as Conn;
  conns.push(conn);
  const ctx = {
    ensureSession: (ek: string, p: string) => {
      const id = ek + '|' + p;
      let s = sessions.get(id);
      if (!s) {
        s = {
          id,
          engineKey: ek,
          paneId: p,
          tabKey: '',
          name: p,
          cwd: '',
          unread: 0,
          muted: false,
          thinking: false,
          alive: true,
          messages: [],
          claudeSessionId: null,
          events: [],
          agentRuns: []
        } as never;
        sessions.set(id, s!);
      }
      return s!;
    },
    attachedId,
    reclaimDead: () => true,
    overlayOn: () => false
  } as unknown as HandlerCtx;
  wireSessions(conn, ctx);
  return {fire: (ev, ...a) => (handlers[ev] as (...x: unknown[]) => void)(...a), resyncSessions};
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'p1',
  cwd: '',
  settings: {},
  alive: true,
  unread: 0,
  status: 'idle',
  claudeSessionId: null as string | null,
  ...over
});

const liveOf = (paneId: string) => sessions.get(WS + '|' + paneId)!;

beforeEach(() => {
  sessions.clear();
  markedUnread.clear();
  __resetRosterFingerprintForTest();
  seen.clear();
  engineThinking.clear();
  conns.length = 0;
  lastSettledTabs.delete(WS);
});
afterEach(() => {
  sessions.clear();
  markedUnread.clear();
  __resetRosterFingerprintForTest();
  conns.length = 0;
  lastSettledTabs.delete(WS);
  vi.restoreAllMocks();
});

describe('the app applies a one-row {t:session} frame through the same per-row code', () => {
  test('a one-row frame updates exactly that row and leaves the others untouched', () => {
    const {fire} = fakeConn(() => '');

    // A full frame introduces two rows; the one-row frame then moves only p1.
    fire('sessions', [row({id: 'p1', name: 'p1'}), row({id: 'p2', name: 'p2'})], []);
    expect(liveOf('p1').name).toBe('p1');
    expect(liveOf('p2').name).toBe('p2');

    fire('session', row({id: 'p1', name: 'renamed on the phone', status: 'working'}));

    expect(liveOf('p1').name, 'the one-row frame did not apply to its own row').toBe('renamed on the phone');
    expect(liveOf('p1').status, 'the one-row frame is the full row, so status applied too').toBe('working');
    expect(liveOf('p2').name, 'the one-row frame touched a row it did not name').toBe('p2');
  });

  test('a one-row frame persists exactly once, and the guard skips an unchanged repeat', () => {
    const {fire} = fakeConn(() => '');
    fire('sessions', [row({id: 'p1'})], []); // baseline full frame
    const spy = vi.spyOn(history, 'writeRoster');

    fire('session', row({id: 'p1', name: 'moved'}));
    expect(spy, 'a one-row change wrote the roster other than once').toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].sessions.find((r) => r.id === WS + '|p1')?.name)
      .toBe('moved');

    // The very same row again changes nothing the store persists: the V2b guard
    // must skip the write.
    fire('session', row({id: 'p1', name: 'moved'}));
    expect(spy, 'an unchanged one-row frame still wrote the roster').toHaveBeenCalledTimes(1);
  });

  test('a one-row frame for an unknown id makes no phantom row and asks for the full roster', () => {
    const {fire, resyncSessions} = fakeConn(() => '');
    fire('sessions', [row({id: 'p1'})], []);
    expect(sessions.size).toBe(1);

    fire('session', row({id: 'ghost', name: 'never introduced'}));

    expect(sessions.size, 'a one-row frame for an unknown id invented a phantom row').toBe(1);
    expect(sessions.has(WS + '|ghost'), 'the phantom row is in the store').toBe(false);
    expect(resyncSessions, 'an unknown one-row frame did not ask the engine to re-serve').toHaveBeenCalledTimes(1);
  });

  test('a one-row frame for an unknown id writes nothing (it never reaches persist)', () => {
    const {fire} = fakeConn(() => '');
    fire('sessions', [row({id: 'p1'})], []);
    const spy = vi.spyOn(history, 'writeRoster');

    fire('session', row({id: 'ghost'}));
    expect(spy, 'the unknown one-row frame persisted despite not being applied').not.toHaveBeenCalled();
  });

  test('a later full frame reconciles a value a one-row frame set (a missed frame self-heals)', () => {
    const {fire} = fakeConn(() => '');
    fire('sessions', [row({id: 'p1', name: 'p1'})], []);

    // A one-row frame moves it...
    fire('session', row({id: 'p1', name: 'set by a one-row frame'}));
    expect(liveOf('p1').name).toBe('set by a one-row frame');

    // ...and a subsequent full frame (a reconnect, a structural change) carries
    // the current truth and reconciles it, exactly as it would a device that had
    // missed the one-row frame entirely.
    fire('sessions', [row({id: 'p1', name: 'reconciled by the full frame'})], []);
    expect(liveOf('p1').name, 'the full frame did not reconcile the row').toBe('reconciled by the full frame');
  });
});
