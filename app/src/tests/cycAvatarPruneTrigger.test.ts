import {afterEach, describe, expect, test, vi} from 'vitest';

/* The prune trigger rides the roster-frame sync path (handlers/sessions.ts):
 * only a CONNECTED engine's settled frame is authoritative enough to prune,
 * and the keep-set spans EVERY engine's sessions (one flat icon DB). An
 * engine that is merely down greys its sessions and prunes nothing, so a
 * brief outage cannot thrash delete/rewrite. */

const {pruneNotifAvatars, syncNotifAvatars} = vi.hoisted(() => ({
  pruneNotifAvatars: vi.fn((_keep: Iterable<string>) => Promise.resolve()),
  syncNotifAvatars: vi.fn()
}));
vi.mock('../features/media/notifAvatars', () => ({
  pruneNotifAvatars,
  syncNotifAvatars,
  armNotifAvatarPrune: vi.fn(),
  syncNotifAvatar: vi.fn(),
  notifIconKey: vi.fn(),
  notifFallbackIcon: vi.fn()
}));

import {conns, sessions, seen, lastSettledTabs, type Conn} from '../engine/store/registry';
import {wireSessions} from '../engine/store/handlers/sessions';
import type {HandlerCtx} from '../engine/store/handlers/types';
import type {CycEngineSession} from '../engine/store/types';

const KEY = 'ws://prune-a.test:7789/ws';
const OTHER = 'ws://prune-b.test:7790/ws';

function fakeConn(settled = true): {conn: Conn; fire: (ev: string, ...a: unknown[]) => void} {
  const handlers: Record<string, (...a: never[]) => void> = {};
  const conn = {
    key: KEY,
    state: 'connected',
    user: 'u',
    host: 'h',
    hostname: 'h',
    tabs: [],
    plugins: [],
    voiceHealthy: true,
    helloSettled: settled,
    client: {
      on: (ev: string, fn: (...a: never[]) => void) => {
        handlers[ev] = fn;
      },
      setSessionTail: vi.fn()
    }
  } as unknown as Conn;
  conns.push(conn);
  return {
    conn,
    fire: (ev: string, ...a: unknown[]) => (handlers[ev] as (...x: unknown[]) => void)(...a)
  };
}

function mkSession(engineKey: string, paneId: string): CycEngineSession {
  const s = {
    id: engineKey + '|' + paneId,
    engineKey,
    paneId,
    tabKey: '',
    name: paneId,
    cwd: '/x',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}

function spyCtx(over: Partial<HandlerCtx> = {}): HandlerCtx {
  return {
    ensureSession: (ek: string, paneId: string) =>
      sessions.get(ek + '|' + paneId) ?? mkSession(ek, paneId),
    rekeySession: vi.fn(() => null),
    reclaimDead: vi.fn(() => true),
    attachedId: () => '',
    overlayOn: () => false,
    fireCompactResult: vi.fn(),
    fireAnswerResult: vi.fn(),
    ...over
  } as unknown as HandlerCtx;
}

const row = (id: string) => ({
  id,
  name: id,
  cwd: '/x',
  settings: {},
  alive: true,
  unread: 0,
  claudeSessionId: null as string | null
});

afterEach(() => {
  conns.length = 0;
  sessions.clear();
  seen.clear();
  lastSettledTabs.clear();
  pruneNotifAvatars.mockClear();
  syncNotifAvatars.mockClear();
});

describe('the prune trigger on the roster-frame path', () => {
  test('a settled frame prunes with a keep-set spanning every engine', () => {
    const {conn, fire} = fakeConn(true);
    wireSessions(conn, spyCtx());
    mkSession(KEY, 'p1');
    mkSession(KEY, 'gone');
    const foreign = mkSession(OTHER, 'px'); // another engine, maybe offline: kept

    fire('sessions', [row('p1')], []);

    expect(pruneNotifAvatars).toHaveBeenCalledTimes(1);
    const keep = pruneNotifAvatars.mock.calls[0][0] as string[];
    expect(keep).toContain(KEY + '|p1');
    expect(keep).toContain(foreign.id); // the flat DB keeps other engines' rows
    expect(keep).not.toContain(KEY + '|gone'); // the departed one is prunable
  });

  test('an unsettled frame (engine briefly down, hello not settled) never prunes', () => {
    const {conn, fire} = fakeConn(false);
    wireSessions(conn, spyCtx());
    mkSession(KEY, 'p1');
    const dark = mkSession(KEY, 'dark');

    fire('sessions', [row('p1')], []);

    expect(pruneNotifAvatars).not.toHaveBeenCalled();
    // and the session itself was greyed, not deleted: still in every keep-set
    expect(sessions.has(dark.id)).toBe(true);
    expect(dark.alive).toBe(false);
  });

  test('the attached open chat survives the frame AND stays in the keep-set', () => {
    const {conn, fire} = fakeConn(true);
    wireSessions(conn, spyCtx({attachedId: () => KEY + '|open'}));
    mkSession(KEY, 'p1');
    mkSession(KEY, 'open'); // not in the frame, but attached: exempt

    fire('sessions', [row('p1')], []);

    expect(pruneNotifAvatars).toHaveBeenCalledTimes(1);
    const keep = pruneNotifAvatars.mock.calls[0][0] as string[];
    expect(keep).toContain(KEY + '|open');
  });
});
