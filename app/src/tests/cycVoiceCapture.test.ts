import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('../engine/store', () => ({
  markVoiceNoteSafe: vi.fn(),
  commitVoiceNote: vi.fn(),
  sendText: vi.fn(),
  sendVoiceClip: vi.fn(() => 42),
  updateVoiceNote: vi.fn(),
  failVoiceNote: vi.fn(),
  discardVoiceNote: vi.fn(),
  get: vi.fn(),
  subscribe: vi.fn(() => () => {})
}));
// The resumable-transfer queue the settlement rides: a fake with just the
// worker surface voiceSettlement touches, plus __finish to land a transfer
// (fires the onResult handlers exactly like the real worker) and __reset.
vi.mock('../engine/transfers/worker', () => {
  const rows = new Map<string, Record<string, unknown>>();
  const handlers = new Set<(row: unknown) => void>();
  return {
    enqueue: vi.fn((blob: Blob, meta: {key: string; sessionId: string; kind: string}) => {
      rows.set(meta.key, {
        key: meta.key,
        sessionId: meta.sessionId,
        kind: meta.kind,
        state: 'queued',
        acked: [],
        size: blob.size
      });
      return meta.key;
    }),
    rowOf: (key: string) => rows.get(key),
    isEnqueuing: () => false,
    enqueued: async () => true,
    wake: vi.fn(),
    onResult: (fn: (row: unknown) => void) => {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    __finish: (key: string, msgId: string) => {
      const row = rows.get(key);
      if (!row) throw new Error(`no fake transfer row under ${key}`);
      row.state = 'done';
      row.result = {msgId};
      for (const fn of [...handlers]) fn(row);
    },
    __reset: () => {
      rows.clear();
      handlers.clear();
    }
  };
});
vi.mock('../audio/clipVault', () => ({
  park: vi.fn(async () => true),
  release: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  list: vi.fn(async () => []),
  holding: vi.fn()
}));

vi.mock('../speechGate', () => ({mayStartSpeech: () => true}));
vi.mock('../features/composer/persistence/vault', () => ({
  list: vi.fn(async () => []),
  holding: vi.fn(),
  save: vi.fn(async () => null),
  get: vi.fn(async () => null),
  drop: vi.fn(async () => {})
}));
import * as engine from '../engine/store';
import * as transfers from '../engine/transfers/worker';
import {pipeline} from '../audio/pipeline';

type FakeWorker = {
  __finish(key: string, msgId: string): void;
  __reset(): void;
};
const fakeWorker = transfers as unknown as FakeWorker;
import {
  createCaptureState,
  installVoiceCapture,
  type VoiceDraft
} from '../features/composer/voice/capture';
import {settledPartialOf} from '../features/composer/voice/captureState';
import {dataState, orphanSweep} from '../sessionState';
const emit = (ev: string, ...args: unknown[]) =>
  (pipeline as unknown as {emit(ev: string, ...args: unknown[]): void}).emit(ev, ...args);
describe('createCaptureState', () => {
  test('draftFor: a stamped event never falls back to the current draft', () => {
    const cap = createCaptureState();
    const current = {sessionId: 's1', localId: '1', seconds: 2} as VoiceDraft;
    cap.voiceDraft = current;
    expect(cap.draftFor(undefined)).toBe(current);
    expect(cap.draftFor(42)).toBeNull();
    const exact = {sessionId: 's1', localId: '2', seconds: 1} as VoiceDraft;
    cap.draftsByCapture.set(42, exact);
    expect(cap.draftFor(42)).toBe(exact);
  });
  test("heardOn: one capture's words, never the global", () => {
    const cap = createCaptureState();
    cap.lastPartial = {text: 'the OTHER recording', committed: 5};
    expect(cap.heardOn(7).text).toBe('');
    cap.partialByCapture.set(7, {text: 'mine', committed: 4});
    expect(cap.heardOn(7).text).toBe('mine');
  });
  test('forgetPartial stays bounded at 8 captures', () => {
    const cap = createCaptureState();
    for (let i = 0; i < 12; i++) cap.partialByCapture.set(i, {text: 't' + i, committed: 1});
    cap.forgetPartial(0);
    expect(cap.partialByCapture.size).toBeLessThanOrEqual(8);

    expect(cap.partialByCapture.has(11)).toBe(true);
  });
  test('settledPartialOf: the settled prefix, its honest position, and when it is the whole', () => {
    // Nothing recorded, nothing settled, no position: no partial.
    expect(settledPartialOf(undefined, 3)).toBeNull();
    expect(settledPartialOf({text: 'abc', committed: 0, committedS: 1}, 3)).toBeNull();
    expect(settledPartialOf({text: 'abc', committed: 3}, 3)).toBeNull();
    // A settled prefix with uncommitted text behind it: partial, not whole.
    expect(settledPartialOf({text: 'abc def', committed: 3, committedS: 1.5}, 5)).toEqual({
      text: 'abc',
      upToS: 1.5,
      whole: false
    });
    // Everything finalized AND the audio clock at the clip's end: the whole.
    expect(settledPartialOf({text: 'abc def', committed: 7, committedS: 4.5}, 5)).toEqual({
      text: 'abc def',
      upToS: 4.5,
      whole: true
    });
    // Everything finalized but the audio clock LAGGING: not whole, and upToS
    // stays the decoder's position so the engine's tail can only add words.
    expect(settledPartialOf({text: 'abc def', committed: 7, committedS: 2}, 5)).toMatchObject({
      whole: false,
      upToS: 2
    });
  });
});
describe('voiceCapture send paths (RecKey record)', () => {
  let cap: ReturnType<typeof createCaptureState>;
  const teardowns: (() => void)[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    fakeWorker.__reset();
    vi.useFakeTimers();
    dataState.mode = 'live';
    orphanSweep.started = true;
    cap = createCaptureState();
    installVoiceCapture({
      cap,
      onTeardown: (d) => teardowns.push(d),
      composer: {
        setTranscribing: () => {},
        setLive: () => {},
        setLivePartial: () => {},
        setLevel: () => {}
      },
      releaseMicIfIdle: () => {},
      scrollToBottom: () => {},
      updateVoiceStrip: () => {},
      putBlocksBack: () => {},
      restoreVoiceBlock: () => {},
      clipCid: new WeakMap(),
      vaultKeyOf: new WeakMap()
    });
  });
  afterEach(() => {
    while (teardowns.length) teardowns.pop()!();
    vi.useRealTimers();
  });
  const clipOf = (bytes: number) => new Blob([new Uint8Array(bytes)], {type: 'audio/webm'});
  test('clip -> queued -> transfer lands -> 9s handoff commits EMPTY text with the msgId exactly once; a late utterance stands down', async () => {
    const draft: VoiceDraft = {
      sessionId: 's1',
      localId: '7',
      seconds: 3,
      cid: 'cid-1',
      captureId: 5
    };
    cap.draftsByCapture.set(5, draft);
    emit('clip', clipOf(100), 's1', 4, 5);
    await vi.advanceTimersByTimeAsync(10);

    // The clip rides the transfer queue under its cid, never a one-shot POST.
    expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transfers.enqueue).mock.calls[0][1]).toMatchObject({
      key: 'cid-1',
      sessionId: 's1',
      kind: 'user-audio'
    });

    // The transfer finishing before the commit draws the safe tick.
    fakeWorker.__finish('cid-1', 'msg-1');
    expect(vi.mocked(engine.markVoiceNoteSafe)).toHaveBeenCalledWith(
      's1',
      '7',
      'msg-1',
      4,
      'cid-1'
    );

    await vi.advanceTimersByTimeAsync(9_000);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledWith(
      's1',
      '7',
      '',
      expect.objectContaining({msgId: 'msg-1', cid: 'cid-1'})
    );

    emit('utterance', 'hello there', 's1', clipOf(100), 4, 5);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.sendText)).not.toHaveBeenCalled();
    expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(1);
  });
  test('utterance with the clip landed commits the words with the msgId and disarms the handoff', async () => {
    const draft: VoiceDraft = {
      sessionId: 's1',
      localId: '8',
      seconds: 3,
      cid: 'cid-2',
      captureId: 6
    };
    cap.draftsByCapture.set(6, draft);
    emit('clip', clipOf(80), 's1', 3, 6);
    await vi.advanceTimersByTimeAsync(10);
    fakeWorker.__finish('cid-2', 'msg-1');
    emit('utterance', 'the real words', 's1', clipOf(80), 3, 6);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledWith(
      's1',
      '8',
      'the real words',
      expect.objectContaining({msgId: 'msg-1', cid: 'cid-2'})
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledTimes(1);
  });
  test('utterance while the clip is still moving commits with the transferKey, never clipless, and enqueues only once', async () => {
    const draft: VoiceDraft = {
      sessionId: 's1',
      localId: '9',
      seconds: 3,
      cid: 'cid-3',
      captureId: 7
    };
    cap.draftsByCapture.set(7, draft);
    emit('clip', clipOf(90), 's1', 3, 7);
    await vi.advanceTimersByTimeAsync(10);
    // No finish: the link is slow or down. The words still commit at once, but
    // the wire is handed to the transfer instead of shipping without the clip.
    emit('utterance', 'over a weak link', 's1', clipOf(90), 3, 7);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledWith(
      's1',
      '9',
      'over a weak link',
      expect.objectContaining({transferKey: 'cid-3', cid: 'cid-3'})
    );
    expect(vi.mocked(engine.commitVoiceNote).mock.calls[0][3]).not.toHaveProperty(
      'msgId',
      expect.anything()
    );
    expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledTimes(1);
  });
  test('a hands-free capture (no messageNode) with the clip landed sends via the parked msgId', async () => {
    emit('clip', clipOf(60), 's2', 5, 9);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(1);
    const key = vi.mocked(transfers.enqueue).mock.calls[0][1].key;
    expect(vi.mocked(engine.markVoiceNoteSafe)).not.toHaveBeenCalled();
    fakeWorker.__finish(key, 'msg-1');
    emit('utterance', 'spoken hands free', 's2', clipOf(60), 5, 9);
    await vi.advanceTimersByTimeAsync(10);

    expect(vi.mocked(transfers.enqueue)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.sendText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.sendText)).toHaveBeenCalledWith(
      's2',
      'spoken hands free',
      expect.objectContaining({kind: 'voice', msgId: 'msg-1'})
    );
  });
  test('a hands-free capture whose clip is still moving goes out as an honest clip send, not a clipless text', async () => {
    emit('clip', clipOf(70), 's2', 6, 11);
    await vi.advanceTimersByTimeAsync(10);
    const key = vi.mocked(transfers.enqueue).mock.calls[0][1].key;
    emit('utterance', 'still uploading', 's2', clipOf(70), 6, 11);
    await vi.advanceTimersByTimeAsync(10);

    expect(vi.mocked(engine.sendText)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.sendVoiceClip)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.sendVoiceClip).mock.calls[0][0]).toBe('s2');
    expect(vi.mocked(engine.sendVoiceClip).mock.calls[0][2]).toMatchObject({
      text: 'still uploading',
      cid: key
    });
  });
  test('transcription error with the clip still moving ships the recording (transferKey), never failVoiceNote', async () => {
    const draft: VoiceDraft = {
      sessionId: 's1',
      localId: '12',
      seconds: 4,
      cid: 'cid-4',
      captureId: 8
    };
    cap.draftsByCapture.set(8, draft);
    emit('clip', clipOf(120), 's1', 4, 8);
    await vi.advanceTimersByTimeAsync(10);
    emit('ignored', '', 'error', clipOf(120), 8, 4);
    await vi.advanceTimersByTimeAsync(10);

    expect(vi.mocked(engine.failVoiceNote)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledWith(
      's1',
      '12',
      '',
      expect.objectContaining({transferKey: 'cid-4', cid: 'cid-4'})
    );
  });
  test('the 9s handoff carries the settled streaming partial: empty body, tail owed, never the whole clip', async () => {
    const draft: VoiceDraft = {
      sessionId: 's1',
      localId: '40',
      seconds: 6,
      cid: 'cid-9',
      captureId: 20
    };
    cap.draftsByCapture.set(20, draft);
    // The streaming decoder settled 17 chars (4.5s in) with more uncommitted.
    emit('partial', 'the settled start plus', 's1', 17, 20, 4.5);
    emit('clip', clipOf(100), 's1', 6, 20);
    await vi.advanceTimersByTimeAsync(10);
    fakeWorker.__finish('cid-9', 'msg-9');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledWith(
      's1',
      '40',
      '',
      expect.objectContaining({
        msgId: 'msg-9',
        partial: {text: 'the settled start', upToS: 4.5}
      })
    );
  });
  test('a fully-settled partial at the handoff ships as the body: nothing left for the engine to decode', async () => {
    const draft: VoiceDraft = {
      sessionId: 's1',
      localId: '41',
      seconds: 6,
      cid: 'cid-10',
      captureId: 21
    };
    cap.draftsByCapture.set(21, draft);
    // Everything finalized and the audio clock at the clip's end (5.6s of 6s).
    emit('partial', 'every word settled', 's1', 18, 21, 5.6);
    emit('clip', clipOf(100), 's1', 6, 21);
    await vi.advanceTimersByTimeAsync(10);
    fakeWorker.__finish('cid-10', 'msg-10');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(vi.mocked(engine.commitVoiceNote)).toHaveBeenCalledTimes(1);
    const [, , body, opts] = vi.mocked(engine.commitVoiceNote).mock.calls[0];
    expect(body).toBe('every word settled');
    expect(opts).not.toHaveProperty('partial');
  });
  test('a sent lone note: partials stream into its bubble, the settled utterance updates it, nothing sends twice', async () => {
    // wiring registered the capture as SENT when the instant lone-note went.
    cap.sentByCapture.set(15, {sessionId: 's1', localId: '33'});
    emit('partial', 'growing words', 's1', 7, 15, 1.2);
    expect(vi.mocked(engine.updateVoiceNote)).toHaveBeenCalledWith(
      's1',
      '33',
      'growing words',
      7,
      undefined
    );
    emit('utterance', 'growing words finished', undefined, clipOf(50), 4, 15);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(engine.updateVoiceNote)).toHaveBeenLastCalledWith(
      's1',
      '33',
      'growing words finished',
      'growing words finished'.length,
      undefined
    );
    // The hands-free fallback did NOT fire: no second upload, no second send.
    expect(vi.mocked(engine.sendVoiceClip)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.sendText)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.commitVoiceNote)).not.toHaveBeenCalled();
    expect(vi.mocked(transfers.enqueue)).not.toHaveBeenCalled();
    expect(cap.sentByCapture.has(15)).toBe(false);
    expect(cap.partialByCapture.has(15)).toBe(false);
  });
  test('THE DOUBLE-SEND INCIDENT: settlement after the instant ship sends NOTHING new', async () => {
    // The instant lone-note send consumed capture 17: card deleted, note sent.
    cap.sentByCapture.set(17, {sessionId: 's1', localId: '50'});
    // The decoder settles seconds later: first the clip, then the utterance,
    // exactly the shape of the confirmed duplicate (two cids for one note).
    emit('clip', clipOf(90), undefined, 5, 17);
    await vi.advanceTimersByTimeAsync(10);
    // No second upload: the recording already rides the sent note's transfer.
    expect(vi.mocked(transfers.enqueue)).not.toHaveBeenCalled();
    emit('utterance', 'the whole spoken sentence', undefined, clipOf(90), 5, 17);
    await vi.advanceTimersByTimeAsync(10);
    // No second send of ANY kind, ever.
    expect(vi.mocked(transfers.enqueue)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.sendVoiceClip)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.sendText)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.commitVoiceNote)).not.toHaveBeenCalled();
    // The settled words still reach the SENT bubble as a display update.
    expect(vi.mocked(engine.updateVoiceNote)).toHaveBeenCalledWith(
      's1',
      '50',
      'the whole spoken sentence',
      'the whole spoken sentence'.length,
      undefined
    );
  });
  test('an evicted held card (consumed, no row) stands down on every settlement event', async () => {
    // wiring evicts a held card past the cap: consumed with nothing to fill.
    cap.sentByCapture.set(18, null);
    emit('clip', clipOf(60), undefined, 4, 18);
    emit('partial', 'words for the evicted card', undefined, 10, 18, 2);
    emit('utterance', 'words for the evicted card', undefined, clipOf(60), 4, 18);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(transfers.enqueue)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.sendVoiceClip)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.sendText)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.commitVoiceNote)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.updateVoiceNote)).not.toHaveBeenCalled();
  });
  test('an ignored verdict on a sent note stands down: the engine reads the clip; no fail, no resend', async () => {
    cap.sentByCapture.set(16, {sessionId: 's1', localId: '34'});
    emit('ignored', '', 'error', clipOf(70), 16, 3);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(engine.failVoiceNote)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.commitVoiceNote)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.sendVoiceClip)).not.toHaveBeenCalled();
    expect(vi.mocked(transfers.enqueue)).not.toHaveBeenCalled();
    expect(cap.sentByCapture.has(16)).toBe(false);
  });
  test('transcription error with no clip anywhere fails the note visibly', async () => {
    const draft: VoiceDraft = {
      sessionId: 's1',
      localId: '13',
      seconds: 2,
      cid: 'cid-5',
      captureId: 10
    };
    cap.draftsByCapture.set(10, draft);
    emit('ignored', '', 'error', undefined, 10, 2);
    await vi.advanceTimersByTimeAsync(10);

    expect(vi.mocked(engine.commitVoiceNote)).not.toHaveBeenCalled();
    expect(vi.mocked(engine.failVoiceNote)).toHaveBeenCalledWith('s1', '13', 'cid-5');
  });
});
