/* ROSTER IDB WRITE GUARD (fix-roster-write, V2b).
 *
 * Every {t:"sessions"} frame used to write the WHOLE roster to IndexedDB with no
 * unchanged-guard (handlers/sessions.ts -> persistRoster -> history.writeRoster
 * -> s.put), so a status-churning agent rewrote the entire roster every few
 * seconds while nothing the list paints had changed. persistRoster now
 * fingerprints exactly the persisted fields and skips the put when they are
 * unchanged. This pins:
 *   - N identical sessions frames  -> 1 roster write
 *   - a changed PERSISTED field    -> exactly 1 more
 *   - a changed RUNTIME-ONLY field -> 0 writes (churnGrey is not persisted)
 * A real change must still persist.
 *
 *   npx vitest run src/tests/cycRosterWriteGuard.test.ts
 */
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {wireSessions} from '../engine/store/handlers/sessions';
import {persistRoster, __resetRosterFingerprintForTest} from '../engine/store/roster';
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

const WS = 'ws://roster-guard.test:7788/ws';

// A connected engine whose sessions frames we drive by hand (same shape the
// cycMarkUnread harness uses).
function fakeConn(attachedId: () => string): {
  fire: (ev: string, ...a: unknown[]) => void;
} {
  const handlers: Record<string, (...a: never[]) => void> = {};
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
      progress: vi.fn()
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
  return {fire: (ev, ...a) => (handlers[ev] as (...x: unknown[]) => void)(...a)};
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

describe('persistRoster skips the whole-roster put when nothing persisted changed', () => {
  test('N identical sessions frames cause exactly 1 roster write', () => {
    const {fire} = fakeConn(() => '');
    const spy = vi.spyOn(history, 'writeRoster');

    fire('sessions', [row()], []);
    fire('sessions', [row()], []);
    fire('sessions', [row()], []);
    fire('sessions', [row()], []);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a changed PERSISTED field causes exactly 1 more write', () => {
    const {fire} = fakeConn(() => '');
    const spy = vi.spyOn(history, 'writeRoster');

    fire('sessions', [row({title: {text: 'a', detail: null}})], []);
    fire('sessions', [row({title: {text: 'a', detail: null}})], []); // identical: skipped
    expect(spy).toHaveBeenCalledTimes(1);

    // title is a ROSTER_FIELD, so a change to it must persist.
    fire('sessions', [row({title: {text: 'b', detail: null}})], []);
    expect(spy).toHaveBeenCalledTimes(2);

    // and an identical follow-up is skipped again.
    fire('sessions', [row({title: {text: 'b', detail: null}})], []);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('a changed RUNTIME-ONLY (not persisted) field causes 0 writes', () => {
    const {fire} = fakeConn(() => '');
    const spy = vi.spyOn(history, 'writeRoster');

    fire('sessions', [row()], []); // 1 baseline write
    expect(spy).toHaveBeenCalledTimes(1);

    // churnGrey is runtime-only (RUNTIME_ONLY in cycRosterFields): flipping it
    // is a status-visual change the row store never persists.
    const s = sessions.get(WS + '|p1')!;
    (s as unknown as {churnGrey: boolean}).churnGrey = true;
    persistRoster(WS);
    expect(spy).toHaveBeenCalledTimes(1);

    (s as unknown as {churnGrey: boolean}).churnGrey = false;
    persistRoster(WS);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a real persisted change after churn still writes exactly once', () => {
    const {fire} = fakeConn(() => '');
    const spy = vi.spyOn(history, 'writeRoster');

    fire('sessions', [row()], []);
    const s = sessions.get(WS + '|p1')!;
    (s as unknown as {churnGrey: boolean}).churnGrey = true;
    persistRoster(WS); // skipped
    expect(spy).toHaveBeenCalledTimes(1);

    s.unread = 5; // a persisted field
    persistRoster(WS);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.at(-1)?.[0].sessions.find((r) => r.id === s.id)?.unread).toBe(5);
  });
});
