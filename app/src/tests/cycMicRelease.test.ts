import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The bug (iPhone, 2026-10-04): the mic stayed on after a push-to-talk release
// until the take's transcription verdict arrived (4-7 s per take, 15 s when the
// app was backgrounded). The release path asked to dispose the mic, but the
// gate treated a released take that was only waiting on its transcript as a
// reason to keep the mic, so the dispose only happened on the verdict's idle
// edge. These drive the real pipeline, the real composer wiring and the real
// ensureMic over a fake getUserMedia/AudioContext/MediaRecorder, so the only
// thing faked is the browser and the decoder.

vi.hoisted(() => {
  window.matchMedia = ((q: string) => ({matches: false, media: q})) as never;
});
vi.mock('../engine/store', () => ({
  sendText: vi.fn(() => 1),
  sendVoiceClip: vi.fn(() => 7),
  transcribe: vi.fn(),
  isMuted: () => false,
  hasVoiceMedia: () => false,
  openMediaSttStream: vi.fn(),
  openSttStream: vi.fn(),
  engineCan: vi.fn(() => false),
  onAnswerResult: () => () => {},
  onCompactResult: () => () => {}
}));
type ComposerOpts = Record<string, (...a: never[]) => unknown>;
let composerOpts: ComposerOpts = {};
vi.mock('../features/composer/components/messageComposer', () => ({
  createComposer: (opts: ComposerOpts) => {
    composerOpts = opts;
    return {
      el: document.createElement('div'),
      onInput: vi.fn(),
      onBlocks: vi.fn(),
      addVoice: vi.fn(() => ({update: vi.fn(), attach: vi.fn()})),
      focus: vi.fn(),
      getDraft: () => '',
      getBlocks: (): unknown[] => []
    };
  },
  sendPlan: () => ({parts: [] as unknown[]})
}));
vi.mock('../components/askPanel', () => ({
  createAskPanel: () => ({el: document.createElement('div'), result: vi.fn(), update: vi.fn()})
}));
vi.mock('../components/widgets', () => ({toast: vi.fn(() => ({dismiss: vi.fn()}))}));
vi.mock('../features/composer/persistence/vaultBridge', () => ({
  createComposerVaultBridge: () => ({
    saveDraft: vi.fn(),
    loadDraft: vi.fn(),
    persistComposition: vi.fn(async () => {}),
    draftOwner: () => 's1',
    anyBlocksHeld: () => false
  })
}));
vi.mock('../audio/speaker', () => ({
  speaker: {
    stopAll: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setBusy: vi.fn(),
    isPlaying: () => false,
    unlock: vi.fn(async () => {}),
    state: {state: 'idle', text: ''}
  }
}));
vi.mock('../audio/clipVault', () => ({release: vi.fn(async () => {})}));
vi.mock('../sessionSelectors', () => ({
  active: () => ({id: 's1', alive: true, messages: [] as unknown[]}),
  isDead: () => false
}));

import * as engine from '../engine/store';
import {pipeline} from '../audio/pipeline';
import {ensureMic, mic} from '../speechGate';
import {createComposerWiring} from '../features/composer/wiring';
import {dataState, sessionState} from '../sessionState';

type FakeTrack = {readyState: 'live' | 'ended'; muted: boolean; stop(): void};
let streams: {tracks: FakeTrack[]}[] = [];

function fakeStream() {
  const track: FakeTrack = {
    readyState: 'live',
    muted: false,
    stop() {
      this.readyState = 'ended';
    }
  };
  const tracks = [track];
  streams.push({tracks});
  const asTrack = (t: FakeTrack) =>
    Object.assign(t, {addEventListener() {}, removeEventListener() {}});
  return {getTracks: () => tracks.map(asTrack), getAudioTracks: () => tracks.map(asTrack)};
}

class FakeAudioContext {
  state = 'running';
  sampleRate = 48000;
  async resume() {}
  close() {
    this.state = 'closed';
  }
  addEventListener() {}
  removeEventListener() {}
  createAnalyser() {
    return {fftSize: 1024, getFloatTimeDomainData: (b: Float32Array) => b.fill(0)};
  }
  createMediaStreamSource() {
    return {connect() {}, disconnect() {}};
  }
}

class FakeMediaRecorder {
  static isTypeSupported = () => false;
  state = 'inactive';
  ondataavailable: ((e: {data: Blob}) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    setTimeout(() => {
      this.ondataavailable?.({data: new Blob([new Uint8Array(4000)])});
      this.onstop?.();
    }, 0);
  }
}

// One pending decode per take: the verdict lands only when the test says so.
let decodes: ((text: string) => void)[] = [];
let api: ReturnType<typeof createComposerWiring>;
let offs: (() => void)[] = [];

const press = () => (composerOpts.onVoiceStart as () => void)();
const letGo = () => (composerOpts.onVoiceEnd as (how: string) => void)('release');
const liveTracks = () =>
  streams.flatMap((s) => s.tracks).filter((t) => t.readyState === 'live').length;

beforeEach(() => {
  vi.useFakeTimers();
  streams = [];
  decodes = [];
  composerOpts = {};
  dataState.mode = 'live';
  sessionState.activeId = 's1';
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {getUserMedia: vi.fn(async () => fakeStream())}
  });
  vi.mocked(engine.transcribe).mockImplementation(
    () => new Promise<string>((r) => decodes.push(r))
  );
  api = createComposerWiring({
    onTeardown: () => {},
    clearUnreadAnchor: vi.fn(),
    scrollToBottom: vi.fn(),
    render: vi.fn(),
    jumpToReply: vi.fn()
  });
  // The app's own idle edge (pipelineUiBindings via main.ts) also asks for a
  // release; keep it so the old verdict-time dispose is reproduced faithfully.
  offs = [
    pipeline.on('recording', (s) => {
      if (s === 'idle') api.releaseMicIfIdle();
    })
  ];
});

afterEach(async () => {
  // Settle every take so the singleton pipeline starts the next test empty.
  for (let i = 0; i < 3; i++) {
    for (const d of decodes.splice(0)) d('');
    await vi.advanceTimersByTimeAsync(2000);
  }
  for (const off of offs) off();
  pipeline.dispose();
  mic.ready = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function recordFor(ms: number) {
  press();
  await vi.advanceTimersByTimeAsync(0);
  expect(pipeline.liveCaptureId).not.toBe(0);
  expect(liveTracks()).toBe(1);
  await vi.advanceTimersByTimeAsync(ms);
}

describe('the mic is released when the take is, not when its transcript lands', () => {
  test('after a release the tracks stop at once while the decode is still pending', async () => {
    await recordFor(3000);
    letGo();
    await vi.advanceTimersByTimeAsync(0);
    expect(liveTracks()).toBe(0);
    expect(mic.ready).toBeNull();

    // The take carries on from what was captured: its clip is decoded and the
    // verdict still lands, with the mic already off.
    const utterances: string[] = [];
    offs.push(pipeline.on('utterance', (text) => utterances.push(text)));
    await vi.advanceTimersByTimeAsync(1000);
    expect(decodes).toHaveLength(1);
    expect(pipeline.capturesInFlight).toHaveLength(1);
    decodes[0]('hello there');
    await vi.advanceTimersByTimeAsync(0);
    expect(utterances).toEqual(['hello there']);
    expect(pipeline.capturesInFlight).toHaveLength(0);
  });

  test('backgrounding with no press down stops the tracks while a decode is pending', async () => {
    // A take ended by the pipeline itself (no composer release, so nothing has
    // asked for the mic back yet) leaves the mic open with its decode pending;
    // the page then goes to the background, which storeBindings answers with
    // releaseMicIfIdle().
    await ensureMic();
    pipeline.startPTT();
    await vi.advanceTimersByTimeAsync(3000);
    pipeline.endPTT();
    expect(pipeline.capturesInFlight).toHaveLength(1);
    expect(liveTracks()).toBe(1);
    api.releaseMicIfIdle();
    await vi.advanceTimersByTimeAsync(0);
    expect(liveTracks()).toBe(0);
    expect(pipeline.capturesInFlight).toHaveLength(1);
  });

  test('a new press after a release re-acquires the mic and records normally', async () => {
    await recordFor(2000);
    letGo();
    await vi.advanceTimersByTimeAsync(0);
    expect(liveTracks()).toBe(0);

    await recordFor(2000);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    const clips: number[] = [];
    offs.push(pipeline.on('clip', (b) => clips.push(b.size)));
    letGo();
    await vi.advanceTimersByTimeAsync(0);
    expect(liveTracks()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clips).toEqual([4000]);
  });

  test('a press before the previous verdict, then its release: the mic never waits on either verdict', async () => {
    // 09:49:04 on the owner's phone: take 10 released, take 11 pressed before
    // take 10's verdict, so no idle edge came and nothing disposed the mic.
    await recordFor(3000);
    letGo();
    await vi.advanceTimersByTimeAsync(0);
    expect(liveTracks()).toBe(0);

    await recordFor(2000);
    decodes[0]('take one');
    await vi.advanceTimersByTimeAsync(0);
    expect(liveTracks()).toBe(1);

    letGo();
    await vi.advanceTimersByTimeAsync(0);
    expect(liveTracks()).toBe(0);
    expect(pipeline.capturesInFlight).toHaveLength(1);
  });
});
