import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('../audio/speaker', () => ({
  speaker: {pending: (): Set<string> => new Set(), stopAll() {}}
}));
vi.mock('../speechGate', () => ({mayStartSpeech: () => false}));
// The transfer worker has its own suite; here only its wiring from the settle
// point is proven (prune, never cancel: a settle must not touch live rows).
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
import * as transfers from '../engine/transfers/worker';
import * as intents from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';
import {effectiveMarkerOf} from '../engine/store/readState';
import {conns, seen, sessions, type Conn} from '../engine/store/registry';
import {admitEngineMessage} from '../engine/store/admit';
import {createReaderLanding} from '../features/chat/surface/readerLanding';
import type {EngineChatMessage} from '../engine/contract';
import {
  armAck,
  armedAcks,
  quoteForWire,
  sendText,
  settleSend,
  isLocalOnly,
  paintPendingSends,
  retrySend,
  __resetForTest as resetSends
} from '../engine/store/sends';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';

// A send is an intent (offline design v2, section 3): the bubble and the
// durable row exist at once, offline or not; the wire goes only when the
// engine is reachable, in queue order, and an unacked frame is written again
// (same cid) on a 10 s, 20 s, 30 s deadline, never failed.

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
      heard: () => pipe.sealed,
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

describe('sends as intents', () => {
  let planted: ReturnType<typeof plantConn>;
  let s: CycEngineSession;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sessions.clear();
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
  });

  test('quoteForWire marks every line, empty lines included', () => {
    expect(quoteForWire('a\n\nb')).toBe('> a\n>\n> b');
  });

  test('sending sights the sent row so the divider never strands above it', () => {
    s.heardTs = 10;
    const reader = createReaderLanding({
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
      openMarker: () => undefined,
      setOpenMarker: () => {}
    });

    sendText(s.id, 'hello there', {ts: 20});

    // No local marker moved and no heard intent competes with the send: the
    // press-time optimism is an in-memory overlay, and the divider resolves to
    // the sent row through it. The durable sighting rides delivery (admit.ts).
    expect(intents.all().some((i) => i.kind === 'heard')).toBe(false);
    expect(effectiveMarkerOf(s)?.ts).toBe(20);
    expect(reader.firstUnheardId(s)).toBeUndefined();
  });

  test('sending reads through a remote row that arrived before the sent row', () => {
    s.heardTs = 10;
    s.messages.push({
      id: 'm1',
      role: 'claude',
      kind: 'text',
      text: 'unseen',
      ts: 19
    } as CycEngineMessage);
    const reader = createReaderLanding({
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
      openMarker: () => undefined,
      setOpenMarker: () => {}
    });

    sendText(s.id, 'hello there', {ts: 20});

    expect(effectiveMarkerOf(s)?.ts).toBe(20);
    expect(reader.firstUnheardId(s)).toBeUndefined();
  });

  test('offline: the bubble and the queued intent exist, nothing on the wire, no ack timer', () => {
    sendText(s.id, 'hello there');
    expect(s.messages).toHaveLength(1);
    const m = s.messages[0] as CycEngineMessage;
    expect(m.status).toBe('sending');
    expect(m.cid).toBeTruthy();
    expect(isLocalOnly(m)).toBe(true);
    const row = intents.get(m.cid!);
    expect(row).toMatchObject({kind: 'send-text', state: 'queued', engineKey: KEY, localId: m.id});
    expect(intents.intentState(m.id)).toBe('queued');
    expect(planted.sent).toHaveLength(0);
    expect(armedAcks()).toBe(0);
  });

  test('the settled edge drains: the frame is written once, the ack armed, the row in flight', async () => {
    sendText(s.id, 'hello there');
    const m = s.messages[0] as CycEngineMessage;
    settle();
    await tick();
    expect(planted.sent).toHaveLength(1);
    expect(planted.sent[0][0]).toBe('p1');
    expect(planted.sent[0][1]).toBe('hello there');
    expect((planted.sent[0][2] as {cid: string}).cid).toBe(m.cid);
    expect(intents.get(m.cid!)?.state).toBe('inflight');
    expect(intents.intentState(m.id)).toBe('inflight');
    expect(armedAcks()).toBe(1);
  });

  test('a reply carries the excerpt as a per-line blockquote on the wire only', async () => {
    settle();
    sendText(s.id, 'yes do it', {replyTo: {text: 'shall I deploy?\nto prod?'} as never});
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    expect(m.text).toBe('yes do it');
    expect(m.wireText).toBe('> shall I deploy?\n> to prod?\n\nyes do it');
    expect(planted.sent[0][1]).toBe(m.wireText);
  });

  test('nothing to send: no bubble, no wire, no intent', () => {
    settle();
    sendText(s.id, '   ');
    expect(s.messages).toHaveLength(0);
    expect(planted.sent).toHaveLength(0);
    expect(intents.all()).toHaveLength(0);
  });

  test('the ack deadline re-writes the same frame (10 s, 20 s, 30 s, 30 s) and never fails it', async () => {
    settle();
    sendText(s.id, 'into the void');
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    expect(planted.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_998);
    expect(planted.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(planted.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(planted.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(planted.sent).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(planted.sent).toHaveLength(5);
    for (const frame of planted.sent) expect((frame[2] as {cid: string}).cid).toBe(m.cid);
    expect(m.status).toBe('sending');
    expect(intents.get(m.cid!)?.state).toBe('inflight');
  });

  test('the ack settles the send: intent gone, deadline disarmed, finished transfer rows pruned', async () => {
    settle();
    sendText(s.id, 'acked in time');
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    m.status = 'sent';
    settleSend(m.cid);
    expect(intents.get(m.cid!)).toBeUndefined();
    expect(armedAcks()).toBe(0);
    expect(vi.mocked(transfers.prune)).toHaveBeenCalledWith(m.cid);
    expect(vi.mocked(transfers.cancel)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(planted.sent).toHaveLength(1);
    expect(m.status).toBe('sent');
    // no cid: nothing to settle, nothing pruned
    settleSend(undefined);
    expect(vi.mocked(transfers.prune)).toHaveBeenCalledTimes(1);
  });

  test('one in flight per engine: the second send waits for the first ack, then goes', async () => {
    settle();
    sendText(s.id, 'first');
    sendText(s.id, 'second');
    await tick();
    expect(planted.sent).toHaveLength(1);
    const [a, b] = s.messages as CycEngineMessage[];
    expect(intents.get(a.cid!)?.state).toBe('inflight');
    expect(intents.get(b.cid!)?.state).toBe('queued');
    settleSend(a.cid);
    await tick();
    expect(planted.sent).toHaveLength(2);
    expect(planted.sent[1][1]).toBe('second');
    expect(intents.get(b.cid!)?.state).toBe('inflight');
  });

  test('the pipe going down disarms every deadline and puts the in-flight row back in the queue', async () => {
    settle();
    sendText(s.id, 'mid-flight');
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    expect(armedAcks()).toBe(1);
    sync.noteDown(KEY);
    expect(armedAcks()).toBe(0);
    expect(intents.get(m.cid!)?.state).toBe('queued');
    expect(m.status).toBe('sending');
    expect(vi.getTimerCount()).toBe(0);
    // Up again: the same frame, the same cid, once.
    settle();
    await tick();
    expect(planted.sent).toHaveLength(2);
    expect((planted.sent[1][2] as {cid: string}).cid).toBe(m.cid);
  });

  test('a write that finds no sealed pipe is transient: queued, one jittered retry while reachable', async () => {
    settle();
    planted.pipe.sealed = false;
    sendText(s.id, 'no pipe yet');
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    expect(planted.sent).toHaveLength(0);
    expect(intents.get(m.cid!)?.state).toBe('queued');
    expect(armedAcks()).toBe(0);
    expect(drain.activeTimers()).toBe(1);
    planted.pipe.sealed = true;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(planted.sent).toHaveLength(1);
    expect(intents.get(m.cid!)?.state).toBe('inflight');
  });

  test('retry of a failed send re-queues the same intent, same cid', async () => {
    settle();
    sendText(s.id, 'refused once');
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    drain.fail(m.cid!, 'the engine refused it');
    m.status = 'failed';
    expect(intents.get(m.cid!)?.state).toBe('failed');
    retrySend(s.id, m.id);
    await tick();
    expect(m.status).toBe('sending');
    expect(intents.get(m.cid!)?.state).toBe('inflight');
    expect(planted.sent).toHaveLength(2);
    expect((planted.sent[1][2] as {cid: string}).cid).toBe(m.cid);
  });

  test('A2 retry of a failed row whose intent was deleted at ack rebuilds it, same cid, and re-sends', async () => {
    settle();
    sendText(s.id, 'into the modal');
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    expect(planted.sent).toHaveLength(1);
    // The ack settled the send: the intent is deleted, the bubble at 'sent'.
    m.status = 'sent';
    settleSend(m.cid);
    expect(intents.get(m.cid!)).toBeUndefined();
    // Delivery then failed post-ack (a swallowed modal): send-failed on the
    // cid demoted the row to failed. No intent survives.
    m.status = 'failed';
    m.failReason = 'that session did not take the text';
    // The retry tap rebuilds the intent from the row, same cid, and the drain
    // writes the frame again.
    retrySend(s.id, m.id);
    await tick();
    expect(m.status).toBe('sending');
    expect(m.failReason).toBeUndefined();
    const rebuilt = intents.get(m.cid!);
    expect(rebuilt).toMatchObject({kind: 'send-text', engineKey: KEY, localId: m.id});
    expect((rebuilt!.payload as {cid: string; text: string; wire: string}).cid).toBe(m.cid);
    expect((rebuilt!.payload as {text: string}).text).toBe('into the modal');
    expect(planted.sent).toHaveLength(2);
    expect(planted.sent[1][1]).toBe('into the modal');
    expect((planted.sent[1][2] as {cid: string}).cid).toBe(m.cid);
  });
  test('re-arming the same cid never leaves a stale timer behind', async () => {
    settle();
    sendText(s.id, 'retry me');
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    expect(armedAcks()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    // Re-arm at 5 s: the original 10 s deadline is cleared, a fresh one takes
    // its place (attempts is still 1, so it is another 10 s window).
    armAck(m.cid!, s.id);
    expect(armedAcks()).toBe(1);
    // The original deadline (10 s total) passes with no rewrite: it was cleared.
    await vi.advanceTimersByTimeAsync(6000);
    expect(planted.sent).toHaveLength(1);
    // The re-armed deadline (10 s from the re-arm, 15 s total) fires: the drain
    // redelivers the same cid, exactly one more frame on the wire.
    await vi.advanceTimersByTimeAsync(4001);
    expect(planted.sent).toHaveLength(2);
    expect((planted.sent[1][2] as {cid: string}).cid).toBe(m.cid);
    expect(m.status).toBe('sending');
  });

  // Fail-before (the point of this change): the ONE writer is the drain. On the
  // old arch the ack timer called writeSend() directly, bypassing the drain, so
  // a timed-out send had TWO writers (the drain executor for the first frame,
  // the ack timer for every rewrite) and the durable attempt count never moved
  // past 1 -- the rewrites left no trace in the drain. On the new arch the ack
  // timer asks drain.redeliver, so every frame for a cid originates from the
  // drain executor and each rewrite bumps intents.noteAttempt. The attempt
  // count climbing with the wire count is the proof of a single writer; on the
  // old code it stays pinned at 1 while the wire count grows, and this fails.
  test('one writer: every timed-out rewrite runs through the drain (its attempt count climbs)', async () => {
    settle();
    sendText(s.id, 'through the drain only');
    await tick();
    const m = s.messages[0] as CycEngineMessage;
    expect(planted.sent).toHaveLength(1);
    expect(intents.get(m.cid!)?.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(planted.sent).toHaveLength(2);
    expect(intents.get(m.cid!)?.attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(planted.sent).toHaveLength(3);
    expect(intents.get(m.cid!)?.attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(planted.sent).toHaveLength(4);
    expect(intents.get(m.cid!)?.attempts).toBe(4);
    for (const frame of planted.sent) expect((frame[2] as {cid: string}).cid).toBe(m.cid);
    expect(m.status).toBe('sending');
    expect(intents.get(m.cid!)?.state).toBe('inflight');
  });
});

// The engine's copy of a send comes back in a replayed page (an attach after
// a reload, a second tab, the history cache) carrying the cid the app sent.
// That row and the pending bubble are one message: the bubble is delivered
// and its intent goes; nothing paints a twin.
describe('a replayed page row merges into the pending bubble of its send', () => {
  let planted: ReturnType<typeof plantConn>;
  let s: CycEngineSession;
  const row = (over: Partial<EngineChatMessage>): EngineChatMessage => ({
    id: 'p1',
    role: 'user',
    text: 'ack then die',
    ts: 1_700_000_020_000,
    seq: 20,
    msgId: 'u20',
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

  test('the row with the bubble cid delivers it: one bubble, engine ts and ids, intent gone', () => {
    sendText(s.id, 'ack then die');
    const m = s.messages[0] as CycEngineMessage;
    expect(m.status).toBe('sending');
    expect(intents.get(m.cid!)).toBeDefined();
    expect(admitEngineMessage(s, row({cid: m.cid}), true)).toBe(false);
    expect(s.messages).toHaveLength(1);
    expect(m).toMatchObject({status: 'delivered', ts: 1_700_000_020_000, seq: 20, msgId: 'u20'});
    // Legacy row (no mid): the durable key is ts|role|text, not seq.
    expect(m.dedupeKey).toBe('1700000020000|user|ack then die');
    expect(intents.get(m.cid!)).toBeUndefined();
    expect(armedAcks()).toBe(0);
  });

  test('the row with the bubble msgId (a voice note) delivers it too', () => {
    sendText(s.id, 'a spoken note', {kind: 'voice', msgId: 'clip-7', durationS: 2});
    const m = s.messages[0] as CycEngineMessage;
    expect(admitEngineMessage(s, row({msgId: 'clip-7', text: 'a spoken note'}), true)).toBe(false);
    expect(s.messages).toHaveLength(1);
    expect(m.status).toBe('delivered');
    expect(intents.get(m.cid!)).toBeUndefined();
  });

  test('a row with another cid and the same words is another message: the send stays owed', () => {
    sendText(s.id, 'same words');
    const m = s.messages[0] as CycEngineMessage;
    expect(admitEngineMessage(s, row({cid: 'someone-else', text: 'same words'}), true)).toBe(true);
    expect(s.messages).toHaveLength(2);
    expect(m.status).toBe('sending');
    expect(intents.get(m.cid!)?.state).toBe('queued');
  });

  test('a row painted before the intents came back from disk: the send finds it by cid, no twin', () => {
    expect(admitEngineMessage(s, row({cid: 'from-disk'}), true)).toBe(true);
    intents.put({
      id: 'from-disk',
      engineKey: KEY,
      sessionId: s.id,
      kind: 'send-text',
      payload: {
        cid: 'from-disk',
        sessionId: s.id,
        ts: 1,
        text: 'ack then die',
        kind: 'text',
        wire: 'ack then die'
      }
    });
    paintPendingSends(s.id);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({cid: 'from-disk', status: 'delivered'});
    expect(intents.get('from-disk')).toBeUndefined();
  });
});
