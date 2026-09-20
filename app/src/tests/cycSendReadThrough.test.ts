import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('../audio/speaker', () => ({
  speaker: {pending: (): Set<string> => new Set(), stopAll() {}}
}));
vi.mock('../speechGate', () => ({mayStartSpeech: () => false}));
vi.mock('../engine/transfers/worker', () => ({
  enqueue: vi.fn((_blob: Blob, meta: {key: string}) => meta.key),
  wake: vi.fn(),
  onResult: vi.fn(),
  rowOf: vi.fn(() => undefined),
  isEnqueuing: vi.fn(() => false),
  heldKeys: vi.fn(() => new Set()),
  prune: vi.fn(() => 0),
  cancel: vi.fn(() => 0),
  hydrateTransfers: vi.fn(async () => [])
}));

import * as intents from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';
import {conns, seen, sessions, type Conn} from '../engine/store/registry';
import {admitEngineMessage} from '../engine/store/admit';
import {
  applyBroadcastReadThrough,
  effectiveMarkerOf,
  type ReadMarker
} from '../engine/store/readState';
import {createReaderLanding} from '../features/chat/surface/readerLanding';
import type {EngineChatMessage} from '../engine/contract';
import {sendText, __resetForTest as resetSends} from '../engine/store/sends';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';

// The "Unread Messages" divider rendered ABOVE the owner's OWN just-sent
// message. The owner sends while the agent is mid-turn: the send is QUEUED
// engine-side and the delivered/echo row is RESTAMPED with an engine ts LATER
// than the local press ts. The OLD app kept its own read pointer as a
// timestamp and marked it read only through the PRESS-time ts, so once the
// bubble adopted the later engine ts it sat past that pointer and the divider
// (first message with ts > heardTs) anchored on the owner's own row.
//
// THE REDESIGN (fix-unread): the app reports a SIGHTING of the delivered row by
// its durable IDENTITY and renders the engine's marker; there is no local ts
// pointer to strand. A restamp moves the row's timestamp, not its identity, so
// the marker follows the row wherever the engine put it and the divider never
// lands above the owner's own message.

const KEY = 'ws://fake-engine.test:7788/ws';

function plantSession(): CycEngineSession {
  const s = {
    id: KEY + '|p1',
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
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}

function plantConn(): {conn: Conn; sent: unknown[][]; pipe: {sealed: boolean}} {
  const sent: unknown[][] = [];
  const pipe = {sealed: true};
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
      sendText: (...a: unknown[]) => {
        if (!pipe.sealed) return false;
        sent.push(a);
        return true;
      }
    }
  } as unknown as Conn;
  conns.push(conn);
  return {conn, sent, pipe};
}

function settle() {
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
}

const tick = () => vi.advanceTimersByTimeAsync(1);

// Field values (2026-09-18): a queued send accepted at 23:06:29.610Z, its
// delivered row restamped ts=...390224 (23:06:30.224Z), 614 ms later.
const PRESS_TS = 1_789_686_389_610;
const DELIVERED_TS = 1_789_686_390_224;

describe('a queued own send stays read through its delivered identity', () => {
  let planted: ReturnType<typeof plantConn>;
  let s: CycEngineSession;
  const reader = () =>
    createReaderLanding({
      deps: {
        heardTsOf: (session) => effectiveMarkerOf(session as CycEngineSession)?.ts ?? 0,
        readMarkerOf: (session) => effectiveMarkerOf(session as CycEngineSession),
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
  const deliveredRow = (over: Partial<EngineChatMessage> = {}): EngineChatMessage => ({
    id: 'p1',
    role: 'user',
    text: 'my reply while it was thinking',
    ts: DELIVERED_TS,
    seq: 42,
    mid: 'mr-own42',
    msgId: 'u42',
    ...over
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sessions.clear();
    seen.clear();
    intents.__resetForTest();
    sync.__resetLiveForTest();
    drain.__resetForTest(() => 0.5);
    resetSends();
    localStorage.clear();
    s = plantSession();
    planted = plantConn();
  });
  afterEach(() => {
    drain.__resetForTest();
    vi.useRealTimers();
    conns.splice(conns.indexOf(planted.conn), 1);
    sessions.clear();
    seen.clear();
  });

  // Send at press ts T; the engine restamps the delivered row to T+X. No
  // explicit read action. The delivered row is SIGHTED by its identity, so the
  // marker resolves to the owner's own row wherever the restamp put it, and the
  // divider does not anchor on it.
  test('the delivered restamp keeps the own row read, by identity', async () => {
    settle();
    sendText(s.id, 'my reply while it was thinking', {ts: PRESS_TS});
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    expect(m.status).toBe('sending');
    // The optimistic press-time sighting was queued for the bubble already.
    expect(effectiveMarkerOf(s)?.ts).toBe(PRESS_TS);

    // The queued send is delivered later, its row restamped to the engine ts
    // and carrying the engine's durable identity.
    expect(admitEngineMessage(s, deliveredRow({cid: m.cid}), false)).toBe(false);
    expect(m.status).toBe('delivered');
    expect(m.ts).toBe(DELIVERED_TS);
    expect(m.mid).toBe('mr-own42');

    // The overlay now resolves to the delivered identity, wherever it sits.
    const marker = effectiveMarkerOf(s)!;
    expect(marker.mid).toBe('mr-own42');
    expect(marker.ts).toBe(DELIVERED_TS);

    // The unread divider does not anchor on the owner's own delivered row.
    expect(reader().firstUnheardId(s)).not.toBe(m.id);
    expect(reader().firstUnheardId(s)).toBeUndefined();
  });

  // The delivered row is reported as a SIGHTING (a durable heard intent) so the
  // read-through reaches the engine, the one authority, not just this device.
  test('the delivered restamp queues a heard sighting for the row identity', async () => {
    settle();
    sendText(s.id, 'my reply while it was thinking', {ts: PRESS_TS});
    await tick();
    const m = s.messages[0] as CycEngineMessage;

    expect(admitEngineMessage(s, deliveredRow({cid: m.cid}), false)).toBe(false);

    const heard = intents.all().filter((i) => i.kind === 'heard' && i.sessionId === s.id);
    expect(heard.length).toBe(1); // coalesced: one furthest-forward sighting
    const payload = heard[0].payload as {mid?: string; ts: number};
    expect(payload.mid).toBe('mr-own42');
    expect(payload.ts).toBe(DELIVERED_TS);
  });

  // REGRESSION GUARD: a remote reply that arrives AFTER the sent row's
  // delivered ts still counts unread; the divider anchors on it, not the own.
  test('a remote reply after the delivered ts still counts unread', async () => {
    settle();
    sendText(s.id, 'my reply while it was thinking', {ts: PRESS_TS});
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    admitEngineMessage(s, deliveredRow({cid: m.cid}), false);

    admitEngineMessage(
      s,
      {
        id: 'r1',
        role: 'claude',
        text: 'a reply that is genuinely unread',
        ts: DELIVERED_TS + 1_000,
        seq: 43,
        mid: 'mr-c43',
        msgId: 'c43'
      } as EngineChatMessage,
      false
    );
    // The engine counts the genuinely-unread remote reply: the count is the
    // sole authority for WHETHER anything is unread, and the divider then
    // anchors on that row's IDENTITY, never on the owner's own delivered row.
    s.unread = 1;
    const remote = s.messages.find((x) => x.role === 'claude') as CycEngineMessage;
    expect(reader().firstUnheardId(s)).toBe(remote.id);
  });

  // REGRESSION GUARD: the engine stays the authority. When another device has
  // already read further (the broadcast marker sits past the own row), the
  // own-send sighting never drags the displayed marker back.
  test('the engine broadcast wins when it is already further forward', async () => {
    settle();
    sendText(s.id, 'my reply while it was thinking', {ts: PRESS_TS});
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    admitEngineMessage(s, deliveredRow({cid: m.cid}), false);

    // A remote reply lands and another device reads it: the engine broadcasts
    // its identity as the read-through.
    admitEngineMessage(
      s,
      {
        id: 'r1',
        role: 'claude',
        text: 'read on another device',
        ts: DELIVERED_TS + 5_000,
        seq: 44,
        mid: 'mr-c44',
        msgId: 'c44'
      } as EngineChatMessage,
      false
    );
    applyBroadcastReadThrough(s, {mid: 'mr-c44', ts: DELIVERED_TS + 5_000});

    const marker = effectiveMarkerOf(s)!;
    expect(marker.mid).toBe('mr-c44');
    expect(reader().firstUnheardId(s)).toBeUndefined();
  });
});
