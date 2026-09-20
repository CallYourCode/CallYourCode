import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('../audio/speaker', () => ({
  speaker: {pending: (): Set<string> => new Set(), stopAll() {}}
}));
vi.mock('../speechGate', () => ({mayStartSpeech: () => false}));

import * as intents from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';
import {conns, sessions, type Conn} from '../engine/store/registry';
import {
  applyBroadcastReadThrough,
  effectiveMarkerOf,
  reportSighting,
  type ReadMarker
} from '../engine/store/readState';
import {createReaderLanding} from '../features/chat/surface/readerLanding';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';

// THE GHOST-UNREAD DEFECTS (field, 2026-09-18), reproduced through the real
// read-state paths, then held fixed by the single-authority, identity-based
// redesign. The two mechanisms: (a) a chat flips unread WHILE it is open and
// visible because the engine counts a fresh reply unread until the device's
// report lands, and (b) the divider anchors far up a chat the owner is reading
// because a client timestamp scan runs over a mis-sorted legacy window.

const KEY = 'ws://ghost.test:7788/ws';
const SID = KEY + '|p1';

function plantSession(over: Partial<CycEngineSession> = {}): CycEngineSession {
  const s = {
    id: SID,
    engineKey: KEY,
    paneId: 'p1',
    tabKey: '',
    name: 'p1',
    cwd: '',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [] as CycEngineMessage[],
    claudeSessionId: null,
    events: [],
    agentRuns: [],
    ...over
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}

function plantConn(sealed = true): {conn: Conn; heardSent: unknown[]} {
  const heardSent: unknown[] = [];
  const conn = {
    key: KEY,
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
      heard: (id: string, row: unknown) => {
        if (!sealed) return false;
        heardSent.push([id, row]);
        return true;
      }
    }
  } as unknown as Conn;
  conns.push(conn);
  return {conn, heardSent};
}

function reader(session: CycEngineSession) {
  return createReaderLanding({
    deps: {
      heardTsOf: (s) => effectiveMarkerOf(s as CycEngineSession)?.ts ?? 0,
      readMarkerOf: (s) => effectiveMarkerOf(s as CycEngineSession),
      play: () => {},
      suppressAutoSpeak: () => false,
      isChatViewOpen: () => true
    },
    messages: document.createElement('div'),
    scroll: document.createElement('div'),
    silentScrollTo: () => {},
    openMarker: (): ReadMarker | undefined => undefined,
    setOpenMarker: () => {}
  });
}

const row = (over: Omit<Partial<CycEngineMessage>, 'id'> & {id?: number}): CycEngineMessage =>
  ({
    role: 'claude',
    kind: 'text',
    text: 't',
    ts: 0,
    ...over,
    // the fixtures speak in small numbers; the durable id mirrors a claude
    // row's mid-keyed name so firstUnheardId returns what the engine would key.
    id: over.mid ? `m:${over.mid}` : `m${over.id ?? 1}`
  }) as CycEngineMessage;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sessions.clear();
  intents.__resetForTest();
  sync.__resetLiveForTest();
  drain.__resetForTest(() => 0.5);
  localStorage.clear();
});
afterEach(() => {
  drain.__resetForTest();
  vi.useRealTimers();
  conns.length = 0;
  sessions.clear();
});

describe('(a) a reply while the chat is open does not flip it unread', () => {
  test('the optimistic sighting keeps the row read even before the report lands', () => {
    plantConn();
    // Everything up to `mr-a` is read; the engine broadcast says so.
    const s = plantSession({
      messages: [row({id: 1, ts: 100, mid: 'mr-a'})],
      readThrough: {mid: 'mr-a', ts: 100}
    });
    expect(reader(s).firstUnheardId(s)).toBeUndefined();

    // A fresh reply renders while the chat is open and visible. The engine has
    // NOT yet been told it was seen, so its broadcast still counts it unread.
    s.messages.push(row({id: 2, ts: 200, mid: 'mr-b'}));
    s.unread = 1; // the still-stale engine count

    // WITHOUT the device's sighting this is the ghost: the divider anchors on
    // the reply the owner is looking at.
    expect(reader(s).firstUnheardId(s)).toBe('m:mr-b');

    // The device sights the reply it rendered. Even if that report is dropped or
    // arrives late (the engine broadcast below never moves), the optimistic
    // overlay keeps the row read: the chat does not flip unread while viewed.
    reportSighting(s.id, {mid: 'mr-b', ts: 200});
    expect(effectiveMarkerOf(s)?.mid).toBe('mr-b');
    expect(reader(s).firstUnheardId(s)).toBeUndefined();

    // A late, still-stale engine frame (readThrough behind the reply) cannot
    // undo it: the overlay sits further forward.
    applyBroadcastReadThrough(s, {mid: 'mr-a', ts: 100});
    expect(reader(s).firstUnheardId(s)).toBeUndefined();
  });
});

describe('(b) the divider anchors by identity on a mis-sorted legacy window', () => {
  test('badge is zero and the divider does not anchor far up the chat', () => {
    plantConn();
    // A reset-bearing window (cycRowSortResetWindow shapes): STORE ORDER is not
    // ts order. A pre-reset band carries HIGHER timestamps but sits at the TOP
    // of the loaded window; the post-reset band the owner just read sits at the
    // BOTTOM with LOWER timestamps. The engine read-through is the true newest
    // row by log order, `mr-d`.
    const s = plantSession({
      messages: [
        row({id: 1, role: 'claude', ts: 9000, mid: 'mr-a'}), // pre-reset, high ts, top
        row({id: 2, role: 'claude', ts: 9500, mid: 'mr-b'}),
        row({id: 3, role: 'claude', ts: 1000, mid: 'mr-c'}), // post-reset, low ts
        row({id: 4, role: 'user', ts: 1500, mid: 'mr-d'}) // the newest by log order, read
      ],
      unread: 0,
      readThrough: {mid: 'mr-d', ts: 1500}
    });

    // The badge is zero: the engine counts nothing after the read-through row.
    expect(s.unread).toBe(0);

    // THE GHOST a naive timestamp scan would produce: the heardTs sits between
    // the bands (1500), so `find(m => m.ts > 1500)` returns the TOP row and the
    // divider lands 43063px up the chat the owner is reading.
    const ghost = s.messages.find((m) => m.ts > 1500);
    expect(ghost?.id).toBe('m:mr-a');

    // The identity-anchored divider finds the read-through ROW at its real
    // position (the bottom) and puts nothing after it: no divider, no ghost.
    expect(reader(s).firstUnheardId(s)).toBeUndefined();
  });
});

describe('offline: a sighting queues, survives reload, drains, and the badge settles', () => {
  test('the durable heard intent carries the row identity to the engine', async () => {
    const planted = plantConn(false); // pipe not sealed yet: offline
    const s = plantSession({
      messages: [row({id: 1, ts: 100, mid: 'mr-a'}), row({id: 2, ts: 200, mid: 'mr-b'})],
      readThrough: {mid: 'mr-a', ts: 100},
      unread: 1
    });

    // The device sights the newest row while offline.
    reportSighting(s.id, {mid: 'mr-b', ts: 200});

    // A durable, coalesced heard intent is queued (it survives a reload because
    // the intent store is persisted), and the overlay already shows it read.
    const queued = intents.all().filter((i) => i.kind === 'heard' && i.sessionId === s.id);
    expect(queued).toHaveLength(1);
    expect((queued[0].payload as {mid?: string; ts: number}).mid).toBe('mr-b');
    expect(effectiveMarkerOf(s)?.mid).toBe('mr-b');
    expect(planted.heardSent).toHaveLength(0); // nothing on the wire while offline

    // Reconnect: the pipe seals and the intent drains to the engine.
    conns.length = 0;
    const online = plantConn(true);
    sync.noteSealed(KEY);
    sync.noteHost(KEY);
    sync.noteSessions(KEY);
    drain.kick(KEY);
    await vi.advanceTimersByTimeAsync(1);
    expect(online.heardSent).toHaveLength(1);
    expect(intents.all().some((i) => i.kind === 'heard')).toBe(false);

    // The engine now broadcasts the read-through it recorded and the badge
    // settles to zero; the overlay has collapsed to the broadcast.
    applyBroadcastReadThrough(s, {mid: 'mr-b', ts: 200});
    s.unread = 0;
    expect(effectiveMarkerOf(s)?.mid).toBe('mr-b');
    expect(s.unread).toBe(0);
  });
});
