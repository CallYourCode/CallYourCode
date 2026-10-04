import {beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycSession} from '../types';
const fake = {
  active: null as CycSession | null,
  dead: false,
  // The chat the box shows (the vault bridge's draft owner); the active chat.
  owner: 's1' as string | null,
  drafts: {} as Record<string, string>,
  draftVersions: {} as Record<string, number>
};
type ComposerOpts = Record<string, (...a: never[]) => unknown>;
let composerOpts: ComposerOpts = {};
const composerHandle = {
  el: document.createElement('div'),
  onInput: vi.fn(),
  onBlocks: vi.fn(),
  addVoice: vi.fn(() => ({update: vi.fn(), attach: vi.fn()})),
  focus: vi.fn(),
  getDraft: () => '',
  getBlocks: (): unknown[] => []
};
vi.mock('../engine/store', () => ({
  sendText: vi.fn(() => 1),
  sendAttachments: vi.fn(() => 1),
  sendVoiceClip: vi.fn(() => 7),
  sendCommitted: vi.fn(async () => true),
  sendTaken: vi.fn(async () => false),
  sendSettles: vi.fn(() => new Promise<boolean>(() => {})),
  withdrawSend: vi.fn(() => true),
  wordsMarker: (id: string) => `{{cyc-words:${id}}}`,
  uploadFile: vi.fn(async () => ({uploadId: 'u1'})),
  engineCan: vi.fn(() => false),
  answerAsk: vi.fn(() => true),
  onAnswerResult: () => () => {},
  onCompactResult: () => () => {}
}));
vi.mock('../features/composer/components/messageComposer', () => ({
  createComposer: (opts: ComposerOpts) => {
    composerOpts = opts;
    return composerHandle;
  },
  sendPlan: () => ({parts: [] as unknown[]})
}));
vi.mock('../components/askPanel', () => ({
  createAskPanel: () => ({el: document.createElement('div'), result: vi.fn(), update: vi.fn()})
}));
const notice = vi.hoisted(() => ({dismiss: vi.fn()}));
vi.mock('../components/widgets', () => ({toast: vi.fn(() => notice)}));
const ALONGSIDE = vi.hoisted(() => ({stores: ['compositions', 'clips'], run: () => {}}));
vi.mock('../features/composer/persistence/vaultBridge', () => ({
  createComposerVaultBridge: () => ({
    saveDraft: vi.fn(),
    loadDraft: vi.fn((id: string | null) => {
      fake.owner = id;
    }),
    dropDraft: vi.fn((id: string, sent?: {text: string; version: number}) => {
      if (
        !sent ||
        ((fake.drafts[id] ?? '') === sent.text && (fake.draftVersions[id] ?? 0) === sent.version)
      )
        delete fake.drafts[id];
    }),
    draftIdentity: vi.fn((id: string, text: string) => ({
      text,
      version: fake.draftVersions[id] ?? 0
    })),
    sentAlongside: vi.fn((id: string) => (id === 's1' ? ALONGSIDE : undefined)),
    persistComposition: vi.fn(async () => {}),
    putBlocksBack: vi.fn(),
    restoreVoiceBlock: vi.fn(),
    clipCid: vi.fn(),
    vaultKeyOf: new WeakMap(),
    draftOwner: () => fake.owner,
    anyBlocksHeld: () => false
  })
}));
vi.mock('../audio/speaker', () => ({
  speaker: {
    stopAll: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setBusy: vi.fn(),
    state: {state: 'idle'}
  }
}));
const pipelineMock = vi.hoisted(() => ({
  handsFreeSessionId: '',
  captureBusy: false,
  dispose: vi.fn(),
  liveCaptureId: 0,
  capturesInFlight: [] as number[],
  pressCaptureId: 0,
  cidOf: () => '',
  startPTT: vi.fn(),
  endPTT: vi.fn(),
  cancelCapture: vi.fn(),
  forceEnd: vi.fn()
}));
vi.mock('../audio/pipeline', () => ({pipeline: pipelineMock}));
const micMock = vi.hoisted(() => ({ready: null as Promise<void> | null}));
const hiddenSilencesMock = vi.hoisted(() => ({value: false}));
vi.mock('../speechGate', () => ({
  ensureMic: vi.fn(async () => {}),
  mic: micMock,
  hiddenSilences: () => hiddenSilencesMock.value
}));
vi.mock('../audio/clipVault', () => ({release: vi.fn(async () => {})}));
vi.mock('../sessionSelectors', () => ({
  active: () => fake.active,
  isDead: () => fake.dead
}));
import {createComposerWiring, type ComposerWiringDeps} from '../features/composer/wiring';
import {awaitingWords} from '../features/chat/content';
import {sessionState, dataState, unsentWork} from '../sessionState';
import * as engine from '../engine/store';
import {speaker} from '../audio/speaker';
import {toast} from '../components/widgets';
function mkSession(): CycSession {
  return {
    id: 's1',
    name: 'p',
    cwd: '/x',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    engineKey: 'e1'
  } as unknown as CycSession;
}
function mk(over: Partial<ComposerWiringDeps> = {}) {
  const deps: ComposerWiringDeps = {
    onTeardown: () => {},
    clearUnreadAnchor: vi.fn(),
    scrollToBottom: vi.fn(),
    render: vi.fn(),
    jumpToReply: vi.fn(),
    ...over
  };
  return {deps, api: createComposerWiring(deps)};
}
beforeEach(() => {
  fake.active = mkSession();
  fake.dead = false;
  fake.owner = 's1';
  fake.drafts = {};
  fake.draftVersions = {};
  dataState.mode = 'live';
  sessionState.activeId = 's1';
  pipelineMock.handsFreeSessionId = '';
  pipelineMock.captureBusy = false;
  micMock.ready = null;
  hiddenSilencesMock.value = false;
  vi.clearAllMocks();
  vi.mocked(engine.engineCan).mockReturnValue(false);
});
describe('sendCurrent', () => {
  test('a live send stops the speaker, holds the reload guard, sends and reveals', () => {
    const {api, deps} = mk();
    api.sendCurrent('hi');
    expect(speaker.stopAll).toHaveBeenCalled();
    expect(engine.sendText).toHaveBeenCalledWith('s1', 'hi', {
      kind: 'text',
      durationS: undefined,
      replyTo: undefined,
      alongside: undefined
    });
    expect(deps.scrollToBottom).toHaveBeenCalled();
    expect(deps.clearUnreadAnchor).toHaveBeenCalled();
  });
  test('a dead session refuses', () => {
    const {api} = mk();
    fake.dead = true;
    api.sendCurrent('hi');
    expect(toast).toHaveBeenCalledWith('Session is offline');
    expect(engine.sendText).not.toHaveBeenCalled();
  });
});
describe('unsent work', () => {
  test('the reload guard sees open drafts, uploads in flight and held blocks', () => {
    const {api} = mk();
    expect(unsentWork.inFlight!()).toBe(false);
    api.cap.uploading++;
    expect(unsentWork.inFlight!()).toBe(true);
    api.cap.uploading--;
    api.cap.voiceDraft = {} as never;
    expect(unsentWork.inFlight!()).toBe(true);
  });
});
describe('releaseMicIfIdle', () => {
  test('disposes the pipeline once nothing needs the mic', async () => {
    const {api} = mk();
    micMock.ready = Promise.resolve();
    api.releaseMicIfIdle();
    await new Promise((r) => setTimeout(r, 10));
    expect(pipelineMock.dispose).toHaveBeenCalled();
    expect(micMock.ready).toBeNull();
  });
  test('keeps the mic while hands-free is on for the open chat', async () => {
    const {api} = mk();
    micMock.ready = Promise.resolve();
    pipelineMock.handsFreeSessionId = 's1';
    api.releaseMicIfIdle();
    await new Promise((r) => setTimeout(r, 10));
    expect(pipelineMock.dispose).not.toHaveBeenCalled();
    expect(micMock.ready).not.toBeNull();
  });
});
// Bug 2: keep a granted mic stream alive across back-to-back push-to-talk
// recordings (a grace window) so getUserMedia is not re-run -- and, on iOS, not
// re-prompted -- per recording. Hard-release triggers still dispose at once.
describe('mic keep-alive (Bug 2)', () => {
  test('G6: a PTT release keeps the stream for the grace window, then disposes', async () => {
    vi.useFakeTimers();
    try {
      mk();
      micMock.ready = Promise.resolve();
      (composerOpts.onVoiceEnd as (how: string) => void)('release');
      await vi.advanceTimersByTimeAsync(50);
      // Not disposed on release: the stream is held for the window.
      expect(pipelineMock.dispose).not.toHaveBeenCalled();
      expect(micMock.ready).not.toBeNull();
      // The window elapses with nothing recorded: it disposes now.
      await vi.advanceTimersByTimeAsync(90_000);
      await vi.advanceTimersByTimeAsync(50);
      expect(pipelineMock.dispose).toHaveBeenCalledTimes(1);
      expect(micMock.ready).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  test('G6: two recordings inside the window keep one stream; getUserMedia is not re-run', async () => {
    vi.useFakeTimers();
    try {
      mk();
      micMock.ready = Promise.resolve();
      (composerOpts.onVoiceEnd as (how: string) => void)('release');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pipelineMock.dispose).not.toHaveBeenCalled();
      // A second recording starts within the window: it reuses the live stream
      // (mic.ready never went null, so ensureMic re-inits nothing) and cancels
      // the pending grace dispose.
      (composerOpts.onVoiceStart as () => void)();
      expect(micMock.ready).not.toBeNull();
      (composerOpts.onVoiceEnd as (how: string) => void)('release');
      await vi.advanceTimersByTimeAsync(80_000);
      // 80s after the SECOND release: the window (reset by it) has not elapsed.
      expect(pipelineMock.dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(pipelineMock.dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  test('G6: backgrounding on a touch device is a hard release: dispose at once', async () => {
    vi.useFakeTimers();
    try {
      mk();
      micMock.ready = Promise.resolve();
      hiddenSilencesMock.value = true;
      (composerOpts.onVoiceEnd as (how: string) => void)('release');
      await vi.advanceTimersByTimeAsync(50);
      expect(pipelineMock.dispose).toHaveBeenCalledTimes(1);
      expect(micMock.ready).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  test('G6: teardown is a hard release: a grace-held stream is disposed', () => {
    const disposers: (() => void)[] = [];
    mk({onTeardown: (d) => disposers.push(d)});
    micMock.ready = Promise.resolve();
    for (const d of disposers) d();
    expect(pipelineMock.dispose).toHaveBeenCalledTimes(1);
    expect(micMock.ready).toBeNull();
  });
});
// Bug 1: a lone voice note must not wait on the on-device decoder before the
// bubble and the composer clear. On an engine that advertises words it ships at
// once with an empty body and the engine transcribes the uploaded clip
// server-side (task 292); a caption or reply excerpt rides the wire beside the
// best words the card holds now, still without waiting.
describe('lone voice note send (Bug 1)', () => {
  type VStaged = {
    file: File;
    upload: null;
    progress: number;
    done: boolean;
    error: null;
    durationS?: number;
  };
  const setup = (over: {caption?: string; partial?: string} = {}) => {
    const {api} = mk();
    const file = new File(['aud'], 'v.webm', {type: 'audio/webm'});
    const staged: VStaged[] = [
      {file, upload: null, progress: 0, done: true, error: null, durationS: 3}
    ];
    // The held card the recording lives in until Enter; the lone path finds it
    // by file identity. Its presence means the on-device decode has not settled.
    api.cap.heldClips.set(1, {
      file: () => file,
      update: vi.fn(),
      attach: vi.fn(),
      remove: vi.fn()
    } as never);
    const compose = (pending?: (st: VStaged) => string | undefined) => {
      // The recording's own words are suppressed when a pending returns '' for
      // the clip: that is how the fix separates a caption from the recording.
      // Read live from `over` so a test can model the on-device decoder
      // settling (the card's words growing) while the send waits.
      const rec = pending ? pending(staged[0]) : undefined;
      const words = rec === '' ? '' : (over.partial ?? '');
      const text = [words, over.caption ?? ''].filter(Boolean).join('\n\n');
      return {text, anchors: [{at: 0, textLen: text.length}]};
    };
    return {api, file, staged, compose, over};
  };
  const onAttach = (staged: unknown, compose: unknown, replyTo?: unknown) =>
    (composerOpts.onAttach as (f: unknown, c: unknown, r?: unknown) => Promise<unknown>)(
      staged,
      compose,
      replyTo
    );

  test('G1/G2: canWords, plain note -> sendVoiceClip in the same turn, empty body, no decode wait', async () => {
    vi.mocked(engine.engineCan).mockReturnValue(true);
    const {staged, compose} = setup({partial: 'hello wor'}); // mid-decode partial, no caption
    const p = onAttach(staged, compose);
    // Synchronous: the clip send is issued before any await could have run, and
    // the freeze-prone attachment path is not taken.
    expect(engine.sendVoiceClip).toHaveBeenCalledTimes(1);
    expect(engine.sendAttachments).not.toHaveBeenCalled();
    const [sid, blob, opts] = vi.mocked(engine.sendVoiceClip).mock.calls[0] as [
      string,
      File,
      {text: string}
    ];
    expect(sid).toBe('s1');
    expect(blob).toBe(staged[0].file);
    // Empty body: the engine reads its own copy of the clip and fills the
    // transcript. An empty-text voice note renders as transcribing until then.
    expect(opts.text).toBe('');
    expect(awaitingWords({role: 'user', kind: 'voice', text: opts.text} as never)).toBe(true);
    await p;
  });

  test('G1: the lone path never awaits settleHeldWords (it resolves in one turn)', async () => {
    vi.mocked(engine.engineCan).mockReturnValue(true);
    const {staged, compose} = setup({partial: 'partial words'});
    let resolved = false;
    const p = onAttach(staged, compose).then(() => (resolved = true));
    // sendVoiceClip already fired; only the on-disk commit (mocked, immediate)
    // is awaited -- no 200ms x 50 poll of the decoder.
    expect(engine.sendVoiceClip).toHaveBeenCalledTimes(1);
    await p;
    expect(resolved).toBe(true);
  });

  test('the instant send CARRIES the settled streaming partial; the engine only owes the tail', async () => {
    vi.mocked(engine.engineCan).mockReturnValue(true);
    const {api, staged, compose} = setup();
    // The streaming decoder settled 'hello world' (11 chars, 2.5s in) with
    // more text still uncommitted: the tail past 2.5s is the engine's.
    api.cap.partialByCapture.set(1, {
      text: 'hello world and more coming',
      committed: 11,
      committedS: 2.5
    });
    const p = onAttach(staged, compose);
    // Still same-turn instant: issued before any await could run.
    expect(engine.sendVoiceClip).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(engine.sendVoiceClip).mock.calls[0][2] as {
      text: string;
      partial?: {text: string; upToS: number};
      display?: {text: string; committed: number};
    };
    // Empty wire body (the engine fills it), the settled prefix beside it.
    expect(opts.text).toBe('');
    expect(opts.partial).toEqual({text: 'hello world', upToS: 2.5});
    // The bubble shows the device's own transcript at once, still growing.
    expect(opts.display).toEqual({text: 'hello world and more coming', committed: 11});
    // The capture is remembered as SENT: its later decoder events reach this
    // row (bubble growth) and never the hands-free fallback (a twin send).
    expect(api.cap.sentByCapture.get(1)).toEqual({sessionId: 's1', localId: 7});
    await p;
  });

  test('a fully-settled streaming transcript ships as the body: no pending words, no engine decode', async () => {
    vi.mocked(engine.engineCan).mockReturnValue(true);
    const {api, staged, compose} = setup();
    // Everything finalized AND the decoder's audio clock reached the clip's
    // end (2.8s of a 3s note, within the rounded-up second).
    api.cap.partialByCapture.set(1, {text: 'all of it settled', committed: 17, committedS: 2.8});
    const p = onAttach(staged, compose);
    expect(engine.sendVoiceClip).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(engine.sendVoiceClip).mock.calls[0][2] as {
      text: string;
      partial?: unknown;
      display?: unknown;
    };
    expect(opts.text).toBe('all of it settled');
    expect(opts.partial).toBeUndefined();
    expect(opts.display).toBeUndefined();
    // A bodied note is final at once: no transcribing state.
    expect(awaitingWords({role: 'user', kind: 'voice', text: opts.text} as never)).toBe(false);
    await p;
  });

  test('finalized text whose audio clock LAGS the clip end stays a partial (the tail is still owed)', async () => {
    vi.mocked(engine.engineCan).mockReturnValue(true);
    const {api, staged, compose} = setup();
    // committed covers all emitted text, but the decoder has only consumed
    // 1.2s of a 3s clip: the rest of the audio has words nobody has seen.
    api.cap.partialByCapture.set(1, {text: 'the start', committed: 9, committedS: 1.2});
    const p = onAttach(staged, compose);
    const opts = vi.mocked(engine.sendVoiceClip).mock.calls[0][2] as {
      text: string;
      partial?: {text: string; upToS: number};
    };
    expect(opts.text).toBe('');
    // upToS is the decoder's actual position, never the clip duration: the
    // engine's tail decode can only ADD words, never lose them.
    expect(opts.partial).toEqual({text: 'the start', upToS: 1.2});
    await p;
  });

  test('#3: a caption note waits for the decoder, then ships the full transcript beside the caption', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(engine.engineCan).mockReturnValue(true);
      const {api, staged, compose, over} = setup({partial: 'spoken', caption: 'and a caption'});
      const p = onAttach(staged, compose);
      await Promise.resolve();
      // A caption must ride the wire, so the engine will not server-fill this
      // note; the send waits for the on-device decoder rather than shipping the
      // caption with only the fragment the card holds so far.
      expect(engine.sendVoiceClip).not.toHaveBeenCalled();
      // The decoder settles: the card's words grow to the full transcript and
      // the held clip is released.
      over.partial = 'spoken bit in full';
      api.cap.heldClips.delete(1);
      await vi.advanceTimersByTimeAsync(400);
      await p;
      const opts = vi.mocked(engine.sendVoiceClip).mock.calls[0][2] as {text: string};
      // Non-empty (the engine leaves a bodied note alone), the full transcript,
      // and the caption kept -- never transcript-only, never caption-only.
      expect(opts.text).toContain('and a caption');
      expect(opts.text).toContain('spoken bit in full');
    } finally {
      vi.useRealTimers();
    }
  });

  test('#4: canWords + caption + unsettled decoder never ships caption-only; it waits for the transcript', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(engine.engineCan).mockReturnValue(true);
      // Unsettled: the card holds no words yet, only the typed caption. A bodied
      // note is left alone by the engine, so the device is the only transcript
      // source and the recording's words would be lost if it shipped now.
      const {api, staged, compose, over} = setup({partial: '', caption: 'meeting at five'});
      const p = onAttach(staged, compose);
      await Promise.resolve();
      // It has NOT shipped caption-only in the same turn: the send is parked on
      // the decoder.
      expect(engine.sendVoiceClip).not.toHaveBeenCalled();
      // The on-device decoder finishes: the full transcript lands on the card
      // and the held clip is released.
      over.partial = 'call me back tomorrow morning';
      api.cap.heldClips.delete(1);
      await vi.advanceTimersByTimeAsync(400);
      await p;
      expect(engine.sendVoiceClip).toHaveBeenCalledTimes(1);
      const opts = vi.mocked(engine.sendVoiceClip).mock.calls[0][2] as {text: string};
      // The recording's spoken words ride the wire beside the caption -- never
      // dropped, never caption-only.
      expect(opts.text).toContain('call me back tomorrow morning');
      expect(opts.text).toContain('meeting at five');
      expect(opts.text).not.toBe('meeting at five');
    } finally {
      vi.useRealTimers();
    }
  });

  test('G5: without server words the note waits for the decoder, then ships the full transcript', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(engine.engineCan).mockReturnValue(false);
      const {api, staged, compose, over} = setup({partial: 'best i heard'});
      const p = onAttach(staged, compose);
      await Promise.resolve();
      // No server fill on a !canWords engine, so the device is the only source:
      // the send waits rather than shipping a mid-decode partial.
      expect(engine.sendVoiceClip).not.toHaveBeenCalled();
      over.partial = 'best i heard and the rest of it';
      api.cap.heldClips.delete(1);
      await vi.advanceTimersByTimeAsync(400);
      await p;
      expect(engine.sendVoiceClip).toHaveBeenCalledTimes(1);
      const opts = vi.mocked(engine.sendVoiceClip).mock.calls[0][2] as {text: string};
      // The full device transcript is in the wire, not the partial it held at Enter.
      expect(opts.text).toBe('best i heard and the rest of it');
    } finally {
      vi.useRealTimers();
    }
  });

  test('G3: the lone note keeps its clip-upload retry semantics (sendVoiceClip, not sendAttachments)', async () => {
    vi.mocked(engine.engineCan).mockReturnValue(true);
    const {staged, compose} = setup();
    await onAttach(staged, compose);
    // sendVoiceClip is the path with pending -> accepted -> failed-with-retry
    // and bytes kept for resend (proved end to end in cycVoiceUpload.test.ts).
    expect(engine.sendVoiceClip).toHaveBeenCalledTimes(1);
    expect(engine.sendAttachments).not.toHaveBeenCalled();
  });
});
describe('composer wiring', () => {
  test('onSend dispatches immediately and drops the owner draft once the send is on disk', async () => {
    let settle: (ok: boolean) => void = () => {};
    vi.mocked(engine.sendCommitted).mockImplementationOnce(
      () => new Promise<boolean>((r) => (settle = r))
    );
    fake.drafts.s1 = 'typed words';
    const {api} = mk();
    const sent = (
      composerOpts.onSend as (t: string, r?: unknown) => Promise<boolean | {kept: Promise<boolean>}>
    )('typed words', undefined);
    // What the box held on disk goes in the send's own write.
    expect(engine.sendText).toHaveBeenCalledWith('s1', 'typed words', {
      kind: 'text',
      durationS: undefined,
      replyTo: undefined,
      alongside: ALONGSIDE
    });
    const settled = await sent;
    expect(settled).toMatchObject({kept: expect.any(Promise)});
    expect(api.dropDraft).not.toHaveBeenCalled();
    settle(true);
    await expect((settled as {kept: Promise<boolean>}).kept).resolves.toBe(true);
    expect(api.dropDraft).toHaveBeenCalledWith('s1', {text: 'typed words', version: 0});
    expect(fake.drafts).not.toHaveProperty('s1');
    // The rows reached disk: the optimistic bubble stays, nothing is withdrawn.
    expect(engine.withdrawSend).not.toHaveBeenCalled();
  });
  test('a late commit for A does not drop B saved after A dispatched', async () => {
    let settle: (ok: boolean) => void = () => {};
    fake.drafts.s1 = 'A';
    vi.mocked(engine.sendCommitted).mockImplementationOnce(
      () => new Promise<boolean>((r) => (settle = r))
    );
    const {api} = mk();

    const sent = await onSend('A');
    fake.drafts.s1 = 'B';
    fake.draftVersions.s1 = 1;
    settle(true);

    await expect((sent as {kept: Promise<boolean>}).kept).resolves.toBe(true);
    expect(api.dropDraft).toHaveBeenCalledWith('s1', {text: 'A', version: 0});
    expect(fake.drafts.s1).toBe('B');
  });
  // R6: a send whose row never reached disk is in memory and still drains.
  // The press settles at once with the send's own wait ({kept}), so the box
  // takes the next press meanwhile. The box clears once the engine takes it,
  // as it would for a row on disk; only a send that is neither on disk nor
  // taken keeps the box, with the notice, and the engine taking it later
  // (a reconnect, the retry tap) clears both.
  type Kept = {kept: Promise<boolean>};
  const onSend = (t: string) =>
    (composerOpts.onSend as (t: string, r?: unknown) => Promise<boolean | Kept>)(t, undefined);
  const deferred = () => {
    let resolve: (ok: boolean) => void = () => {};
    const promise = new Promise<boolean>((r) => (resolve = r));
    return {promise, resolve};
  };
  const KEPT = 'Could not save the message; it is kept in the box';
  test('a text send whose rows did not reach disk, taken by the engine: the box clears, no notice', async () => {
    vi.mocked(engine.sendCommitted).mockResolvedValueOnce(false);
    vi.mocked(engine.sendTaken).mockResolvedValueOnce(true);
    const {api} = mk();
    const sent = await onSend('typed words');
    expect(sent).toMatchObject({kept: expect.any(Promise)});
    await expect((sent as Kept).kept).resolves.toBe(true);
    expect(engine.sendText).toHaveBeenCalledTimes(1);
    expect(engine.sendTaken).toHaveBeenCalledWith('s1', 1);
    expect(api.dropDraft).toHaveBeenCalledWith('s1', {text: 'typed words', version: 0});
    expect(toast).not.toHaveBeenCalled();
    // The engine took it, so the bubble stays and settles normally: not withdrawn.
    expect(engine.withdrawSend).not.toHaveBeenCalled();
  });
  test("the press settles as soon as the write has failed; the wait for the engine is the kept send's own", async () => {
    vi.mocked(engine.sendCommitted).mockResolvedValueOnce(false);
    const taken = deferred();
    vi.mocked(engine.sendTaken).mockReturnValueOnce(taken.promise);
    mk();
    const sent = await onSend('typed words');
    // Settled while sendTaken is still pending: nothing gates the next press.
    expect(sent).toMatchObject({kept: expect.any(Promise)});
    let keptDone = false;
    void (sent as Kept).kept.then(() => (keptDone = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(keptDone).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    taken.resolve(true);
    await expect((sent as Kept).kept).resolves.toBe(true);
  });
  test('a text send neither on disk nor taken keeps the box and the draft, and says so once', async () => {
    vi.mocked(engine.sendCommitted).mockResolvedValueOnce(false);
    vi.mocked(engine.sendTaken).mockResolvedValueOnce(false);
    const late = deferred();
    vi.mocked(engine.sendSettles).mockReturnValueOnce(late.promise);
    const {api} = mk();
    const sent = await onSend('typed words');
    expect(sent).toMatchObject({kept: expect.any(Promise)});
    expect(engine.sendText).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(KEPT);
    expect(api.dropDraft).not.toHaveBeenCalled();
    // The box is the retry surface, so the optimistic thread bubble is
    // withdrawn (shown once, not twice), AFTER the settle wait read its cid.
    expect(engine.sendSettles).toHaveBeenCalledWith('s1', 1);
    expect(engine.withdrawSend).toHaveBeenCalledWith('s1', 1);
    const settleOrder = vi.mocked(engine.sendSettles).mock.invocationCallOrder[0];
    const withdrawOrder = vi.mocked(engine.withdrawSend).mock.invocationCallOrder[0];
    expect(settleOrder).toBeLessThan(withdrawOrder);
    // The engine takes it after all: the notice comes down, the draft goes.
    late.resolve(true);
    await expect((sent as Kept).kept).resolves.toBe(true);
    expect(notice.dismiss).toHaveBeenCalledTimes(1);
    expect(api.dropDraft).toHaveBeenCalledWith('s1', {text: 'typed words', version: 0});
  });
  test('a kept text send the engine refuses: the box, the draft and the notice stay; the retry tap landing clears them', async () => {
    vi.mocked(engine.sendCommitted).mockResolvedValueOnce(false);
    // The refusal: not taken at once, and the unbounded wait follows the row
    // through the retry tap (sendSettles does not settle on a refusal).
    vi.mocked(engine.sendTaken).mockResolvedValueOnce(false);
    const late = deferred();
    vi.mocked(engine.sendSettles).mockReturnValueOnce(late.promise);
    const {api} = mk();
    const sent = await onSend('typed words');
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    let keptDone = false;
    void (sent as Kept).kept.then(() => (keptDone = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(keptDone).toBe(false);
    expect(notice.dismiss).not.toHaveBeenCalled();
    expect(api.dropDraft).not.toHaveBeenCalled();
    // The retried cid is acked: the same kept send settles, nothing resent.
    late.resolve(true);
    await expect((sent as Kept).kept).resolves.toBe(true);
    expect(engine.sendText).toHaveBeenCalledTimes(1);
    expect(notice.dismiss).toHaveBeenCalledTimes(1);
    expect(api.dropDraft).toHaveBeenCalledWith('s1', {text: 'typed words', version: 0});
  });
  test('a kept text send the user discards: the draft stays, the wait ends untaken', async () => {
    vi.mocked(engine.sendCommitted).mockResolvedValueOnce(false);
    vi.mocked(engine.sendTaken).mockResolvedValueOnce(false);
    vi.mocked(engine.sendSettles).mockResolvedValueOnce(false);
    const {api} = mk();
    const sent = await onSend('typed words');
    await expect((sent as Kept).kept).resolves.toBe(false);
    expect(api.dropDraft).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
  });
  test("the notice is the chat's: leaving the chat takes it down, coming back raises it again, another chat gets none", async () => {
    vi.mocked(engine.sendCommitted).mockResolvedValueOnce(false);
    vi.mocked(engine.sendTaken).mockResolvedValueOnce(false);
    const late = deferred();
    vi.mocked(engine.sendSettles).mockReturnValueOnce(late.promise);
    const {api} = mk();
    const sent = await onSend('typed words');
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    // Away to chat s2: the notice comes down, s2 raises none.
    api.loadDraft('s2');
    expect(api.vaultBridge.loadDraft).toHaveBeenCalledWith('s2');
    expect(notice.dismiss).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    // Back to s1: the kept send is still owed, the notice is raised afresh.
    api.loadDraft('s1');
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith(KEPT);
    // The engine takes it: down for good, and s1 reopened raises nothing.
    late.resolve(true);
    await expect((sent as Kept).kept).resolves.toBe(true);
    expect(notice.dismiss).toHaveBeenCalledTimes(2);
    api.loadDraft('s2');
    api.loadDraft('s1');
    expect(toast).toHaveBeenCalledTimes(2);
  });
  test('a send kept while its chat is not showing raises the notice when the chat is opened', async () => {
    vi.mocked(engine.sendCommitted).mockResolvedValueOnce(false);
    const taken = deferred();
    vi.mocked(engine.sendTaken).mockReturnValueOnce(taken.promise);
    const late = deferred();
    vi.mocked(engine.sendSettles).mockReturnValueOnce(late.promise);
    const {api} = mk();
    const sent = await onSend('typed words');
    api.loadDraft('s2');
    taken.resolve(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(toast).not.toHaveBeenCalled();
    api.loadDraft('s1');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(KEPT);
    // Its late take drops s1's draft, whichever chat is showing.
    api.loadDraft('s2');
    late.resolve(true);
    await expect((sent as Kept).kept).resolves.toBe(true);
    expect(api.dropDraft).toHaveBeenCalledWith('s1', {text: 'typed words', version: 0});
  });
  test('an attachment send neither on disk nor taken keeps the box: onAttach settles kept, one toast', async () => {
    vi.mocked(engine.sendCommitted).mockResolvedValueOnce(false);
    vi.mocked(engine.sendTaken).mockResolvedValueOnce(false);
    const late = deferred();
    vi.mocked(engine.sendSettles).mockReturnValueOnce(late.promise);
    const {api} = mk();
    const staged = [
      {
        file: new File(['bb'], 'b.txt', {type: 'text/plain'}),
        upload: null as null,
        progress: 0,
        done: true,
        error: null as null
      }
    ];
    const compose = () => ({text: 'look', anchors: [{at: 4, textLen: 0}]});
    const sent = await (
      composerOpts.onAttach as (f: typeof staged, c: typeof compose, r?: unknown) => Promise<Kept>
    )(staged, compose, undefined);
    expect(sent).toMatchObject({kept: expect.any(Promise)});
    expect(engine.sendAttachments).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(KEPT);
    expect(api.dropDraft).not.toHaveBeenCalled();
    late.resolve(true);
    await expect(sent.kept).resolves.toBe(true);
    expect(notice.dismiss).toHaveBeenCalledTimes(1);
    expect(api.dropDraft).toHaveBeenCalledWith('s1', {text: 'look', version: 0});
  });
  test('an attachment send whose rows did not reach disk, taken by the engine: the box clears', async () => {
    vi.mocked(engine.sendCommitted).mockResolvedValueOnce(false);
    vi.mocked(engine.sendTaken).mockResolvedValueOnce(true);
    const {api} = mk();
    const staged = [
      {
        file: new File(['bb'], 'b.txt', {type: 'text/plain'}),
        upload: null as null,
        progress: 0,
        done: true,
        error: null as null
      }
    ];
    const compose = () => ({text: 'look', anchors: [{at: 4, textLen: 0}]});
    const sent = await (
      composerOpts.onAttach as (f: typeof staged, c: typeof compose, r?: unknown) => Promise<Kept>
    )(staged, compose, undefined);
    expect(sent).toMatchObject({kept: expect.any(Promise)});
    await expect(sent.kept).resolves.toBe(true);
    expect(api.dropDraft).toHaveBeenCalledWith('s1', {text: 'look', version: 0});
    expect(toast).not.toHaveBeenCalled();
  });
  test('onSend with nothing sent (a dead session) keeps the draft and resolves false', async () => {
    const {api} = mk();
    fake.dead = true;
    const sent = (composerOpts.onSend as (t: string, r?: unknown) => Promise<boolean>)(
      'typed words',
      undefined
    );
    await expect(sent).resolves.toBe(false);
    expect(engine.sendText).not.toHaveBeenCalled();
    expect(api.dropDraft).not.toHaveBeenCalled();
  });
  test('onSend keeps the draft and resolves false when dispatch refuses the send', async () => {
    vi.mocked(engine.sendText).mockReturnValueOnce('');
    const {api} = mk();
    const sent = (composerOpts.onSend as (t: string, r?: unknown) => Promise<boolean>)(
      'typed words',
      undefined
    );
    await expect(sent).resolves.toBe(false);
    expect(engine.sendText).toHaveBeenCalledTimes(1);
    expect(api.dropDraft).not.toHaveBeenCalled();
  });
  test('staging never uploads eagerly; the press queues every file as one attachment send', async () => {
    const {api} = mk();
    // No onStage hook: bytes move after the press, over the persisted queue.
    expect(composerOpts.onStage).toBeUndefined();
    expect(engine.uploadFile).not.toHaveBeenCalled();

    const a = new File(['aaaa'], 'a.png', {type: 'image/png'});
    const b = new File(['bb'], 'b.txt', {type: 'text/plain'});
    const staged = [
      {
        file: a,
        upload: null as null,
        progress: 0,
        done: true,
        error: null as null,
        width: 4,
        height: 3
      },
      {file: b, upload: null as null, progress: 0, done: true, error: null as null}
    ];
    const compose = (pending?: (st: (typeof staged)[number]) => string | undefined) => ({
      text: 'look ' + (pending?.(staged[0]) ?? ''),
      anchors: [
        {at: 5, textLen: 0},
        {at: 5, textLen: 0}
      ]
    });
    let settle: (ok: boolean) => void = () => {};
    vi.mocked(engine.sendCommitted).mockImplementationOnce(
      () => new Promise<boolean>((r) => (settle = r))
    );
    const sent = (
      composerOpts.onAttach as (f: typeof staged, c: typeof compose, r?: unknown) => Promise<Kept>
    )(staged, compose, undefined);
    const settled = await sent;
    // The draft goes only once the send's rows are on disk.
    expect(api.dropDraft).not.toHaveBeenCalled();
    settle(true);
    await expect(settled.kept).resolves.toBe(true);
    expect(api.dropDraft).toHaveBeenCalledWith('s1', {text: 'look ', version: 0});

    expect(engine.uploadFile).not.toHaveBeenCalled();
    expect(engine.sendText).not.toHaveBeenCalled();
    expect(engine.sendAttachments).toHaveBeenCalledTimes(1);
    const [sid, opts] = vi.mocked(engine.sendAttachments).mock.calls[0];
    expect(sid).toBe('s1');
    expect(opts.alongside).toBe(ALONGSIDE);
    expect(opts.text).toBe('look ');
    expect(opts.files).toHaveLength(2);
    expect(opts.files[0]).toMatchObject({
      file: a,
      name: 'a.png',
      mime: 'image/png',
      width: 4,
      height: 3,
      at: 5
    });
    expect(opts.files[1]).toMatchObject({file: b, name: 'b.txt', mime: 'text/plain', at: 5});
    // Every file has its own transfer key, minted at the press.
    expect(opts.files[0].key).not.toBe(opts.files[1].key);
    expect(opts.words).toEqual([]);
  });
  test('an attachment press without a live engine is refused and nothing is queued', async () => {
    mk();
    dataState.mode = 'test';
    const staged = [
      {
        file: new File(['x'], 'x.txt'),
        upload: null as null,
        progress: 0,
        done: true,
        error: null as null
      }
    ];
    await expect(
      (composerOpts.onAttach as (f: typeof staged, c: unknown) => Promise<void>)(staged, () => ({
        text: '',
        anchors: [{at: 0, textLen: 0}]
      }))
    ).rejects.toThrow('no live engine');
    expect(engine.sendAttachments).not.toHaveBeenCalled();
  });
});
