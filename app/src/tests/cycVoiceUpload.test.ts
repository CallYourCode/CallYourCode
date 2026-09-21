import {afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('../audio/clipVault', () => ({
  park: vi.fn(async () => 'k'),
  release: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  get: vi.fn(async () => undefined),
  list: vi.fn(async () => []),
  holding: vi.fn(() => () => {})
}));
// The transfer worker is exercised on its own (cycTransferWorker.test.ts). Here
// we prove the VOICE send path around it: the bubble, the intent, and that the
// wire goes out only once the transfer result is in hand.
vi.mock('../engine/transfers/worker', () => ({
  enqueue: vi.fn((_blob: Blob, meta: {key: string}) => meta.key),
  wake: vi.fn(),
  onResult: vi.fn(),
  rowOf: vi.fn(() => undefined),
  isEnqueuing: vi.fn(() => false),
  enqueued: vi.fn(async () => true),
  heldKeys: vi.fn(() => new Set()),
  prune: vi.fn(() => 0),
  cancel: vi.fn(() => 0),
  hydrateTransfers: vi.fn(async () => [])
}));

// The log line is the observable for a few of these proofs (which retry path a
// tap took). The real logger rate-caps per wall-clock second, and fake timers
// hold the clock still, so the events are collected here instead.
const logged: {event: string; fields: Record<string, unknown>}[] = [];
vi.mock('@/shared/logging', () => ({
  setLogAutoShip: vi.fn(),
  cyclog: (event: string, fields: Record<string, unknown> = {}) => {
    logged.push({event, fields});
  }
}));

import * as clipVault from '../audio/clipVault';
import * as transfers from '../engine/transfers/worker';
import * as intents from '../engine/intents';
import type {SendPayload} from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';
import {conns, renderSubs, sessions, type Conn} from '../engine/store/registry';
import {sendVoiceClip, retryVoiceClip} from '../engine/store/voiceUpload';
import {commitVoiceNote, discardVoiceNote} from '../engine/store/voiceNotes';
import {hydrateSends, retrySend, __resetForTest as resetSends} from '../engine/store/sends';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';
import type {TransferRow} from '../engine/transfers/rows';

const KEY = 'ws://voice-engine.test:7788/ws';

// The onResult handler voiceUpload registers at module load: the transfer worker
// calls it when a transfer finishes. Captured once (before beforeEach clears the
// mock call record) so a test can fire it.
let registeredOnResult: (row: TransferRow) => void;

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

type Planted = {conn: Conn; sent: unknown[][]};

function plantConn(state: Conn['state'] = 'connected'): Planted {
  const sent: unknown[][] = [];
  const conn = {
    key: KEY,
    state,
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
        sent.push(a);
        return true;
      }
    }
  } as unknown as Conn;
  conns.push(conn);
  return {conn, sent};
}

function settle() {
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
}

// The drain is async (one await per executor step): let it run.
const flush = () => vi.advanceTimersByTimeAsync(1);

const payloadOf = (cid: string) => intents.get(cid)?.payload as SendPayload | undefined;

const clip = (bytes = 128) => new Blob([new Uint8Array(bytes)], {type: 'audio/webm'});

const doneRow = (cid: string, sessionId: string, msgId: string): TransferRow => ({
  key: cid,
  id: 'xid',
  sessionId,
  kind: 'user-audio',
  blobKey: cid,
  size: 128,
  mime: 'audio/webm',
  sha256: 'ff',
  chunk: 262144,
  acked: [0],
  state: 'done',
  attempts: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  result: {msgId}
});

// The row the worker holds while the bytes move.
const queuedRow = (cid: string, sessionId: string): TransferRow => ({
  ...doneRow(cid, sessionId, 'x'),
  state: 'queued',
  acked: [],
  result: undefined
});

describe('honest voice-clip send over the transfer queue', () => {
  let planted: Planted;
  let s: CycEngineSession;
  beforeAll(() => {
    // Every store module that waits on transfers (voice clips, attachments)
    // registers its own result handler at load; fan a row out to all of them,
    // exactly as the worker does, and each ignores rows that are not its own.
    const handlers = vi
      .mocked(transfers.onResult)
      .mock.calls.map((c) => c[0] as (row: TransferRow) => void);
    expect(handlers.length).toBeGreaterThanOrEqual(1);
    registeredOnResult = (row: TransferRow) => {
      for (const fn of handlers) fn(row);
    };
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    logged.length = 0;
    vi.mocked(clipVault.get).mockResolvedValue(undefined);
    vi.mocked(transfers.enqueue).mockImplementation((_b, meta) => meta.key);
    vi.mocked(transfers.rowOf).mockReturnValue(undefined);
    vi.mocked(transfers.isEnqueuing).mockReturnValue(false);
    intents.__resetForTest();
    sync.__resetLiveForTest();
    drain.__resetForTest(() => 0.5);
    resetSends();
    sessions.clear();
    s = plantSession();
    planted = plantConn();
    settle();
  });
  afterEach(() => {
    drain.__resetForTest();
    vi.useRealTimers();
    conns.splice(conns.indexOf(planted.conn), 1);
    sessions.clear();
  });

  test('the row is pending and durable from the first frame, and the transfer is queued', async () => {
    vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));
    const id = sendVoiceClip(s.id, clip(), {durationS: 4});
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    expect(m.kind).toBe('voice');
    expect(m.status).toBe('sending');
    expect(m.clipKey).toBe(m.cid);
    // The intent is written, queued, referencing the clip by clipKey.
    expect(intents.get(m.cid!)).toMatchObject({kind: 'send-voice', localId: id});
    expect(payloadOf(m.cid!)).toMatchObject({cid: m.cid, kind: 'voice', clipKey: m.cid});
    await flush();
    // The drain looked and found the bytes still moving: the row waits.
    expect(intents.get(m.cid!)?.state).toBe('queued');
    expect(vi.mocked(transfers.wake)).toHaveBeenCalled();
    // The bytes are queued for transfer...
    expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transfers.enqueue).mock.calls[0][1]).toMatchObject({
      key: m.cid,
      sessionId: s.id,
      kind: 'user-audio'
    });
    // ...and NOTHING went on the wire yet: a voice intent never sends without
    // its transfer result.
    expect(planted.sent).toHaveLength(0);
  });

  test("the send's own kick before the row is written waits; it never fails the note", async () => {
    // `enqueue` returns at once and writes the row later: the drain step the
    // send kicks finds no row and no parked bytes. That is a transfer still
    // being enqueued, not a lost recording.
    vi.mocked(transfers.rowOf).mockReturnValue(undefined);
    vi.mocked(transfers.isEnqueuing).mockReturnValue(true);
    const id = sendVoiceClip(s.id, clip(), {durationS: 4});
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    await flush();
    expect(m.status).toBe('sending');
    expect(intents.get(m.cid!)?.state).toBe('queued');
    expect(vi.mocked(transfers.isEnqueuing)).toHaveBeenCalledWith(m.cid);
    expect(vi.mocked(transfers.wake)).toHaveBeenCalled();
    expect(vi.mocked(clipVault.get)).not.toHaveBeenCalled();
    expect(planted.sent).toHaveLength(0);
  });

  test('discarding a queued note cancels its whole transfer set, not just the finished rows', () => {
    const id = sendVoiceClip(s.id, clip(), {durationS: 4});
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    const cid = m.cid!;
    discardVoiceNote(s.id, id, cid, 'test');
    expect(s.messages.find((x) => x.id === id)).toBeUndefined();
    // The intent goes, and the discard point cancels queued and active rows
    // too, for this cid.
    expect(intents.get(cid)).toBeUndefined();
    expect(vi.mocked(transfers.cancel)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transfers.cancel)).toHaveBeenCalledWith(cid);
    expect(planted.sent).toHaveLength(0);
  });

  test('the transfer result sends the wire, names the msgId, and holds the intent for the ack', async () => {
    vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));
    const id = sendVoiceClip(s.id, clip(200), {durationS: 3, text: 'hi there'});
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    await flush();
    expect(planted.sent).toHaveLength(0);

    const row = doneRow(m.cid!, s.id, 'srv-msg-1');
    vi.mocked(transfers.rowOf).mockReturnValue(row);
    // The result must repaint the bubble with the progress line gone: the
    // wire's own edge changes no status, so nothing else paints.
    const paints: (number | undefined)[] = [];
    const sub = () => paints.push(m.sendPct);
    renderSubs.add(sub);
    registeredOnResult(row);
    await flush();
    renderSubs.delete(sub);

    expect(m.msgId).toBe('srv-msg-1');
    expect(m.status).toBe('sending');
    expect(m.sendPct).toBeUndefined();
    expect(paints).toContain(undefined);
    expect(planted.sent).toHaveLength(1);
    expect(planted.sent[0][1]).toBe('hi there');
    expect(planted.sent[0][2]).toMatchObject({kind: 'voice', msgId: 'srv-msg-1', cid: m.cid});
    expect(intents.get(m.cid!)?.state).toBe('inflight');
    expect(payloadOf(m.cid!)?.msgId).toBe('srv-msg-1');
  });

  // The point of this revision: the ack escalation counts WIRE WRITES, not
  // drain passes. A transfer-backed send spends passes in `waiting` while its
  // bytes move, and each pass bumps intents.noteAttempt; if the ack deadline
  // were derived from `attempts`, the FIRST wire write would already be at
  // attempts=2 and arm a 20 s (or 30 s) deadline -- a 2-3x retransmit-latency
  // regression on the media path. It must arm the FIRST deadline at 10 s,
  // measured from the first frame on the wire, however many passes it waited.
  test('D1: a transfer-backed send whose transfer waited arms its FIRST ack deadline at 10 s after the first wire write', async () => {
    // One waiting pass first: the bytes are still moving, so nothing goes on
    // the wire and no ack is armed, but the drain has counted the pass.
    vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));
    const id = sendVoiceClip(s.id, clip(200), {durationS: 3, text: 'hi there'});
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    await flush();
    expect(planted.sent).toHaveLength(0);
    // The drain took a pass (attempts is 1) but wrote no frame (wireWrites 0).
    expect(intents.get(m.cid!)?.attempts).toBe(1);
    expect(intents.get(m.cid!)?.wireWrites ?? 0).toBe(0);

    // The transfer finishes: the drain writes the wire for the FIRST time. The
    // drain-pass count is now 2, but this is wire write #1, so the deadline is
    // 10 s, not ackTimeoutMs(attempts - 1) = 20 s.
    const row = doneRow(m.cid!, s.id, 'srv-1');
    vi.mocked(transfers.rowOf).mockReturnValue(row);
    registeredOnResult(row);
    await flush();
    expect(planted.sent).toHaveLength(1);
    expect(intents.get(m.cid!)?.attempts).toBe(2);
    expect(intents.get(m.cid!)?.wireWrites).toBe(1);

    // 10 s (not 20 s): the same frame is written again on the FIRST deadline.
    // On the old attempts-derived code this deadline was ackTimeoutMs(1) = 20 s,
    // so at +10 s the wire would still hold one frame.
    await vi.advanceTimersByTimeAsync(9_998);
    expect(planted.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3);
    expect(planted.sent).toHaveLength(2);
    expect((planted.sent[1][2] as {cid: string}).cid).toBe(m.cid);
    // The second write escalated the count (wire write #2), and the drain is the
    // only writer throughout: the note never fails for a missed ack.
    expect(intents.get(m.cid!)?.wireWrites).toBe(2);
    expect(m.status).toBe('sending');
    expect(intents.get(m.cid!)?.state).toBe('inflight');
  });

  test('a settled partial rides the intent and the wire; the display paints the bubble; the wire body stays empty', async () => {
    vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));
    const id = sendVoiceClip(s.id, clip(), {
      durationS: 8,
      text: '',
      partial: {text: 'the settled start', upToS: 5.5},
      display: {text: 'the settled start and more', committed: 17}
    });
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    // The bubble holds the device's own words at once, still growing
    // (draftCommitted keeps the row open to updateVoiceNote).
    expect(m.text).toBe('the settled start and more');
    expect(m.draftCommitted).toBe(17);
    // The intent: empty wire body, the partial named by the frame's cid.
    expect(payloadOf(m.cid!)).toMatchObject({
      text: '',
      wire: '',
      partials: [{id: m.cid, text: 'the settled start', upToS: 5.5}]
    });
    await flush();
    const row = doneRow(m.cid!, s.id, 'srv-tail-1');
    vi.mocked(transfers.rowOf).mockReturnValue(row);
    registeredOnResult(row);
    await flush();
    // The wire frame carries the partial for the engine's tail decode; the
    // text on the wire is empty (the engine fills it), never the display.
    expect(planted.sent).toHaveLength(1);
    expect(planted.sent[0][1]).toBe('');
    expect(planted.sent[0][2]).toMatchObject({
      kind: 'voice',
      msgId: 'srv-tail-1',
      partials: [{id: m.cid, text: 'the settled start', upToS: 5.5}]
    });
  });

  test('retry of an empty-bodied partial note resends the empty wire + partial, never the display text', async () => {
    vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));
    const id = sendVoiceClip(s.id, clip(), {
      durationS: 8,
      text: '',
      partial: {text: 'the settled start', upToS: 5.5},
      display: {text: 'the settled start and more', committed: 17}
    });
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    await flush();
    // The note failed after the display grew: the bubble text is the device's
    // partial, which must NOT become the resend's wire body (it would ship the
    // partial AS the transcript and lose the tail).
    m.status = 'failed';
    m.text = 'the settled start and more grown further';
    vi.mocked(clipVault.get).mockResolvedValue({
      blob: clip(),
      mime: 'audio/webm',
      durationS: 8
    } as never);
    expect(retryVoiceClip(s.id, id)).toBe(true);
    await flush();
    expect(payloadOf(m.cid!)).toMatchObject({
      text: '',
      wire: '',
      partials: [{id: m.cid, text: 'the settled start', upToS: 5.5}]
    });
  });

  test('a send made while disconnected still enqueues pending and moves no bytes', async () => {
    sync.noteDown(KEY);
    conns.splice(conns.indexOf(planted.conn), 1);
    planted = plantConn('disconnected');
    const id = sendVoiceClip(s.id, clip(256), {durationS: 3});
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    await flush();
    expect(m.status).toBe('sending');
    expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(1);
    expect(planted.sent).toHaveLength(0);
    // No failed state: an offline send simply waits, and nothing ticks.
    expect(intents.get(m.cid!)?.state).toBe('queued');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('retry re-queues from the kept bytes', async () => {
    const id = sendVoiceClip(s.id, clip(400), {durationS: 6});
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    // The first drain finds no transfer row and no parked bytes: the note
    // fails as a lost clip. The retry below is of that failed note.
    await flush();
    expect(m.status).toBe('failed');
    const kept = clip(400);
    vi.mocked(clipVault.get).mockResolvedValueOnce({
      key: m.clipKey!,
      cid: m.clipKey!,
      sessionId: s.id,
      blob: kept,
      mime: 'audio/webm',
      bytes: 400,
      durationS: 6,
      ts: Date.now(),
      tries: 0
    } as never);
    // The re-queued transfer is the worker's from here: the drain sees its row.
    vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));

    const took = retryVoiceClip(s.id, id);
    expect(took).toBe(true);
    // Owed again from the tap itself, before the vault answers.
    expect(m.status).toBe('sending');
    await flush();
    expect(vi.mocked(clipVault.get)).toHaveBeenCalledWith(m.clipKey);
    // enqueue was called at send time and again at retry, with the kept bytes.
    expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(transfers.enqueue).mock.calls[1][0]).toBe(kept);
    expect(m.status).toBe('sending');
    expect(m.clipLost).toBeUndefined();
    expect(intents.get(m.cid!)?.state).toBe('queued');
  });

  test('the message menu "Try again" routes a failed voice note through the kept bytes', async () => {
    const id = sendVoiceClip(s.id, clip(128), {durationS: 2});
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    m.status = 'failed';
    vi.mocked(clipVault.get).mockResolvedValueOnce({
      key: m.clipKey!,
      cid: m.clipKey!,
      sessionId: s.id,
      blob: clip(128),
      mime: 'audio/webm',
      bytes: 128,
      ts: Date.now(),
      tries: 0
    } as never);
    retrySend(s.id, id);
    await flush();
    expect(vi.mocked(clipVault.get)).toHaveBeenCalledWith(m.clipKey);
    expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(2);
  });

  describe('the dictation commit while the clip is still moving (commitVoiceNote transferKey)', () => {
    // The draft bubble exactly as the pipeline made it (beginVoiceNote shape).
    function plantDraft(localId: string): CycEngineMessage {
      const m = {
        id: localId,
        role: 'user',
        kind: 'voice',
        text: '',
        ts: Date.now(),
        status: 'sending',
        durationS: 3,
        draftCommitted: 0
      } as CycEngineMessage;
      s.messages.push(m);
      return m;
    }

    test('writes a send-voice intent pinned to the transfer key; the wire waits, then ships the words with the msgId', async () => {
      const m = plantDraft('501');
      vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));
      commitVoiceNote(s.id, '501', 'spoken words', {transferKey: 'tk-1', durationS: 3});
      // The bubble is retryable (clipKey) and addressable (cid == key).
      expect(m.cid).toBe('tk-1');
      expect(m.clipKey).toBe('tk-1');
      expect(m.text).toBe('spoken words');
      expect(m.draftCommitted).toBeUndefined();
      expect(intents.get('tk-1')).toMatchObject({kind: 'send-voice', localId: '501'});
      expect(payloadOf('tk-1')).toMatchObject({
        cid: 'tk-1',
        clipKey: 'tk-1',
        transferKey: 'tk-1',
        text: 'spoken words',
        kind: 'voice'
      });
      await flush();
      // NOTHING on the wire while the bytes move: the words never ship clipless.
      expect(planted.sent).toHaveLength(0);
      expect(intents.get('tk-1')?.state).toBe('queued');

      const row = doneRow('tk-1', s.id, 'srv-msg-7');
      vi.mocked(transfers.rowOf).mockReturnValue(row);
      registeredOnResult(row);
      await flush();
      expect(planted.sent).toHaveLength(1);
      expect(planted.sent[0][1]).toBe('spoken words');
      expect(planted.sent[0][2]).toMatchObject({kind: 'voice', msgId: 'srv-msg-7', cid: 'tk-1'});
      expect(m.msgId).toBe('srv-msg-7');
    });

    test('an empty-bodied commit with a transferKey is NOT discarded: the recording is the message', async () => {
      const m = plantDraft('502');
      vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));
      commitVoiceNote(s.id, '502', '', {transferKey: 'tk-2', durationS: 2});
      // Still here, still owed: the clip rides the queue and the wire waits.
      expect(s.messages.find((x) => x.id === '502')).toBe(m);
      expect(intents.get('tk-2')).toMatchObject({kind: 'send-voice'});
      await flush();
      expect(planted.sent).toHaveLength(0);
    });

    test('a transfer refused for good fails the bubble with the reason, and the bytes path stays retryable', async () => {
      const m = plantDraft('503');
      const gone: TransferRow = {
        ...queuedRow('tk-3', s.id),
        state: 'gone',
        refused: 'too large (over 300 MB)'
      };
      vi.mocked(transfers.rowOf).mockReturnValue(gone);
      commitVoiceNote(s.id, '503', 'lost words', {transferKey: 'tk-3', durationS: 2});
      await flush();
      expect(m.status).toBe('failed');
      expect(m.failReason).toBe('too large (over 300 MB)');
      expect(m.clipKey).toBe('tk-3');
      expect(planted.sent).toHaveLength(0);
    });

    test('with the msgId already in hand the commit is the plain wire, exactly as before', async () => {
      const m = plantDraft('504');
      commitVoiceNote(s.id, '504', 'quick words', {msgId: 'srv-msg-8', durationS: 2});
      expect(intents.get(m.cid!)).toMatchObject({kind: 'send-text'});
      await flush();
      expect(planted.sent).toHaveLength(1);
      expect(planted.sent[0][2]).toMatchObject({kind: 'voice', msgId: 'srv-msg-8'});
    });
  });

  describe('the send-voice executor after a reload (defect #1)', () => {
    const entry = (over: Partial<SendPayload> = {}): SendPayload => ({
      cid: 'c-reload',
      sessionId: s.id,
      ts: Date.now(),
      text: 'note',
      kind: 'voice',
      durationS: 2,
      wire: 'note',
      clipKey: 'c-reload',
      transferKey: 'c-reload',
      ...over
    });
    // The intent as it comes back from disk (planted in the live map), then
    // the boot paint and the drain.
    async function reload(payload: SendPayload) {
      intents.put({
        id: payload.cid,
        engineKey: KEY,
        sessionId: s.id,
        kind: 'send-voice',
        payload,
        createdAt: payload.ts
      });
      await hydrateSends();
      await flush();
    }

    test('a transfer that already finished sends the wire from its result', async () => {
      vi.mocked(transfers.rowOf).mockReturnValue(doneRow('c-reload', s.id, 'srv-9'));
      await reload(entry());
      expect(planted.sent).toHaveLength(1);
      expect(planted.sent[0][2]).toMatchObject({kind: 'voice', msgId: 'srv-9'});
      const m = s.messages.find(
        (x) => (x as CycEngineMessage).cid === 'c-reload'
      ) as CycEngineMessage;
      expect(m.msgId).toBe('srv-9');
      expect(m.status).toBe('sending');
    });

    test('an intent whose wire was ready pre-reload resends it, never empty', async () => {
      await reload(entry({msgId: 'srv-pre'}));
      expect(planted.sent).toHaveLength(1);
      expect(planted.sent[0][1]).toBe('note'); // the real wire, not empty
      expect(planted.sent[0][2]).toMatchObject({kind: 'voice', msgId: 'srv-pre'});
    });

    test('an in-flight transfer just wakes the worker and sends nothing yet', async () => {
      vi.mocked(transfers.rowOf).mockReturnValue({
        ...doneRow('c-reload', s.id, 'x'),
        state: 'queued',
        result: undefined
      });
      await reload(entry());
      expect(vi.mocked(transfers.wake)).toHaveBeenCalled();
      expect(planted.sent).toHaveLength(0);
      expect(intents.get('c-reload')?.state).toBe('queued');
    });

    test('a row refused before the reload fails the bubble with the same reason', async () => {
      vi.mocked(transfers.rowOf).mockReturnValue({
        ...doneRow('c-reload', s.id, 'x'),
        state: 'gone',
        result: undefined,
        refused: 'too large (over 300 MB)'
      });
      await reload(entry());
      const m = s.messages.find(
        (x) => (x as CycEngineMessage).cid === 'c-reload'
      ) as CycEngineMessage;
      expect(m.status).toBe('failed');
      expect(m.clipLost).toBe(true);
      expect(m.failReason).toBe('too large (over 300 MB)');
      expect(intents.get('c-reload')).toMatchObject({
        state: 'failed',
        lastError: 'too large (over 300 MB)'
      });
      expect(planted.sent).toHaveLength(0);
    });

    test('no row but kept bytes re-queues the transfer', async () => {
      vi.mocked(transfers.rowOf).mockReturnValue(undefined);
      vi.mocked(clipVault.get).mockResolvedValueOnce({
        key: 'c-reload',
        blob: clip(64),
        mime: 'audio/webm',
        bytes: 64,
        sessionId: s.id,
        ts: Date.now(),
        tries: 0
      } as never);
      await reload(entry());
      expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.objectContaining({key: 'c-reload', kind: 'user-audio'})
      );
      expect(planted.sent).toHaveLength(0);
      expect(intents.get('c-reload')?.state).toBe('queued');
    });

    test('no row and no bytes after a reload: the bubble fails as a lost clip, nothing is sent', async () => {
      vi.mocked(transfers.rowOf).mockReturnValue(undefined);
      vi.mocked(clipVault.get).mockResolvedValue(undefined);
      await reload(entry());
      const m = s.messages.find(
        (x) => (x as CycEngineMessage).cid === 'c-reload'
      ) as CycEngineMessage;
      expect(m.status).toBe('failed');
      expect(m.clipLost).toBe(true);
      expect(m.sendPct).toBeUndefined();
      expect(intents.get('c-reload')?.state).toBe('failed');
      expect(vi.mocked(transfers.enqueue)).not.toHaveBeenCalled();
      expect(planted.sent).toHaveLength(0);
    });
  });

  describe('retry of a failed note after a successful finish (defect #5)', () => {
    test('bytes gone but the intent carries a msgId: the wire is re-sent, same cid, same msgId', async () => {
      vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));
      const id = sendVoiceClip(s.id, clip(128), {durationS: 2, text: 'note'});
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      await flush();
      // the finish released the bytes and the wire went out; the engine then
      // refused the message for good
      intents.update(m.cid!, {...payloadOf(m.cid!)!, msgId: 'srv-finished'});
      drain.fail(m.cid!, 'refused');
      m.status = 'failed';
      m.msgId = 'srv-finished';
      vi.mocked(clipVault.get).mockResolvedValue(undefined);
      retrySend(s.id, id);
      await flush();
      // no second transfer: the clip is on the engine already
      expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(1);
      expect(planted.sent).toHaveLength(1);
      expect(planted.sent[0][1]).toBe('note');
      expect(planted.sent[0][2]).toMatchObject({
        kind: 'voice',
        msgId: 'srv-finished',
        cid: m.clipKey
      });
      expect(m.status).toBe('sending');
      expect(intents.get(m.cid!)).toMatchObject({state: 'inflight', attempts: 2});
    });

    test('two retry taps in one tick (R9): the note flips to sending before the vault is read; one wire, one requeue', async () => {
      vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));
      const id = sendVoiceClip(s.id, clip(128), {durationS: 2, text: 'note'});
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      await flush();
      intents.update(m.cid!, {...payloadOf(m.cid!)!, msgId: 'srv-finished'});
      drain.fail(m.cid!, 'refused');
      m.status = 'failed';
      m.failReason = 'refused';
      m.msgId = 'srv-finished';
      vi.mocked(clipVault.get).mockResolvedValue(undefined);
      logged.length = 0;
      // Two taps land in the same tick: the second must find the note already
      // owed again (status sending), not still failed.
      expect(retryVoiceClip(s.id, id)).toBe(true);
      expect(m.status).toBe('sending');
      expect(retryVoiceClip(s.id, id)).toBe(true);
      await flush();
      expect(logged.filter((l) => l.event === 'voiceclip.retry.wire')).toHaveLength(1);
      expect(logged.filter((l) => l.event === 'voiceclip.retry.noop')).toHaveLength(1);
      // The second tap never reached the vault.
      expect(vi.mocked(clipVault.get)).toHaveBeenCalledTimes(1);
      // One requeue: the row went in flight once more and stayed there.
      expect(planted.sent).toHaveLength(1);
      expect(intents.get(m.cid!)).toMatchObject({state: 'inflight', attempts: 2});
      expect(m.status).toBe('sending');
      expect(m.failReason).toBeUndefined();
    });

    test('bytes gone and no msgId (a definitive refusal): nothing is sent', async () => {
      vi.mocked(transfers.rowOf).mockImplementation((k) => queuedRow(k, s.id));
      const id = sendVoiceClip(s.id, clip(128), {durationS: 2});
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      await flush();
      drain.fail(m.cid!, 'refused');
      m.status = 'failed';
      vi.mocked(clipVault.get).mockResolvedValue(undefined);
      retrySend(s.id, id);
      await flush();
      expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(1);
      expect(planted.sent).toHaveLength(0);
      expect(m.status).toBe('failed');
      expect(intents.get(m.cid!)?.state).toBe('failed');
    });
  });
});
