/* MARK-AS-UNREAD state transitions (fix-mark-unread).
 *
 * The bug: marking the chat you are VIEWING (the attached one) unread had no
 * effect -- the sessions frame zeroed the attached row's count, so the badge
 * never appeared and the roster persisted 0. These cover the three moves the
 * fix must make right end to end:
 *   mark   -> the row shows unread (even while it is the open chat)
 *   open   -> the badge clears
 *   reload -> the unread survives (the roster carries it)
 *
 *   bun run test --run src/tests/cycMarkUnread.test.ts
 */
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {setSessionUnread, wireSessionOps} from '../engine/store/sessionOps';
import {wireSessions} from '../engine/store/handlers/sessions';
import {attach} from '../engine/store';
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
import {setEngineTunnel, clearEngineTunnel, type EngineTunnel} from '../engine/contract';
import * as intents from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';
import type {HandlerCtx} from '../engine/store/handlers/types';
import type {CycEngineSession} from '../engine/store/types';

const WS = 'ws://mark-unread.test:7788/ws';
const BASE = 'http://mark-unread.test:7788';

function seed(paneId: string, over: Partial<CycEngineSession> = {}): CycEngineSession {
  const s = {
    id: WS + '|' + paneId,
    engineKey: WS,
    paneId,
    tabKey: '',
    name: paneId,
    cwd: '',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    claudeSessionId: null,
    events: [],
    agentRuns: [],
    ...over
  } as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}

// A connected engine whose sessions frames we can drive by hand.
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
    ensureSession: (ek: string, p: string) => sessions.get(ek + '|' + p) ?? seed(p),
    attachedId,
    reclaimDead: () => true,
    overlayOn: () => false
  } as unknown as HandlerCtx;
  wireSessions(conn, ctx);
  return {fire: (ev, ...a) => (handlers[ev] as (...x: unknown[]) => void)(...a)};
}

const frameRow = (unread: number) => ({
  id: 'p1',
  name: 'p1',
  cwd: '',
  settings: {},
  alive: true,
  unread,
  claudeSessionId: null as string | null
});

let engineUnread = 1;
let engineStatus = 200;
const tunnel: EngineTunnel = {
  ready: () => true,
  whenReady: () => Promise.resolve(true),
  fetch: (_url, _init) =>
    Promise.resolve(
      new Response(JSON.stringify({ok: engineStatus === 200, unread: engineUnread}), {
        status: engineStatus
      })
    )
};

// Mark-unread is an intent: the engine must be reachable for the POST to go.
function settle() {
  sync.noteSealed(WS);
  sync.noteHost(WS);
  sync.noteSessions(WS);
}

beforeEach(() => {
  engineUnread = 1;
  engineStatus = 200;
  sessions.clear();
  markedUnread.clear();
  seen.clear();
  engineThinking.clear();
  conns.length = 0;
  intents.__resetForTest();
  sync.__resetLiveForTest();
  drain.__resetForTest(() => 0.5);
  setEngineTunnel(BASE, tunnel);
  wireSessionOps({list: () => [...sessions.values()]});
  settle();
});
afterEach(() => {
  drain.__resetForTest();
  clearEngineTunnel(BASE);
  sessions.clear();
  markedUnread.clear();
  conns.length = 0;
  lastSettledTabs.delete(WS);
  vi.restoreAllMocks();
});

describe('mark -> the row shows unread', () => {
  test('optimistically paints and records the deliberate intent before the round-trip', async () => {
    const s = seed('p1', {unread: 0});
    const roster = vi.spyOn(history, 'writeRoster');

    const ok = await setSessionUnread(s.id, true);

    expect(ok).toBe(true);
    expect(s.unread).toBe(1);
    expect(markedUnread.has(s.id)).toBe(true);
    // Persisted so the badge outlives a reload (roster carries `unread`).
    const wrote = roster.mock.calls.at(-1)?.[0].sessions.find((r) => r.id === s.id);
    expect(wrote?.unread).toBe(1);
  });

  test('the OPEN (attached) chat keeps the badge the engine just gave it', () => {
    const s = seed('p1', {unread: 0});
    const {fire} = fakeConn(() => s.id); // this chat is the attached one
    markedUnread.add(s.id); // a deliberate mark-unread is in flight

    fire('sessions', [frameRow(2)], []);

    expect(s.unread).toBe(2); // honoured, not zeroed
  });

  test('incidental live activity on the open chat is still zeroed (no false badge)', () => {
    const s = seed('p1', {unread: 0});
    const {fire} = fakeConn(() => s.id);
    // no markedUnread: a reply arrived while he reads, count not deliberate

    fire('sessions', [frameRow(3)], []);

    expect(s.unread).toBe(0);
  });

  test('a definitive refusal (4xx) reverts the optimistic paint', async () => {
    const s = seed('p1', {unread: 0});
    engineStatus = 400;

    const ok = await setSessionUnread(s.id, true);

    expect(ok).toBe(false);
    expect(s.unread).toBe(0);
    expect(markedUnread.has(s.id)).toBe(false);
    expect(intents.all()[0]).toMatchObject({kind: 'mark-unread', state: 'failed'});
  });

  test('offline: the paint holds and the intent waits for the settled edge', async () => {
    sync.noteDown(WS);
    const s = seed('p1', {unread: 0});
    const pending = setSessionUnread(s.id, true);
    expect(s.unread).toBe(1);
    expect(markedUnread.has(s.id)).toBe(true);
    expect(intents.queuedFor(WS)).toHaveLength(1);
    settle();
    expect(await pending).toBe(true);
    expect(intents.all()).toHaveLength(0);
  });
});

describe('open -> the badge clears', () => {
  test('attaching drops the intent and zeroes the count', () => {
    const s = seed('p1', {unread: 2});
    markedUnread.add(s.id);

    attach(s.id);

    expect(markedUnread.has(s.id)).toBe(false);
    expect(s.unread).toBe(0);
  });

  test('after open, a later frame is no longer force-held unread', () => {
    const s = seed('p1', {unread: 2});
    markedUnread.add(s.id);
    const {fire} = fakeConn(() => s.id);

    attach(s.id); // he opened it
    fire('sessions', [frameRow(0)], []); // engine has since marked it read

    expect(s.unread).toBe(0);
  });
});

describe('reload -> the unread survives', () => {
  test('a fresh (nothing attached) frame paints the engine unread straight through', () => {
    const s = seed('p1', {unread: 0});
    const {fire} = fakeConn(() => ''); // cold boot: no chat open

    fire('sessions', [frameRow(1)], []);

    expect(s.unread).toBe(1);
  });

  test('mark-read clears the intent, the count, and re-persists zero', async () => {
    const s = seed('p1', {unread: 3});
    markedUnread.add(s.id);
    const roster = vi.spyOn(history, 'writeRoster');
    engineUnread = 0;

    const ok = await setSessionUnread(s.id, false);

    expect(ok).toBe(true);
    expect(s.unread).toBe(0);
    expect(markedUnread.has(s.id)).toBe(false);
    const wrote = roster.mock.calls.at(-1)?.[0].sessions.find((r) => r.id === s.id);
    expect(wrote?.unread).toBe(0);
  });
});
