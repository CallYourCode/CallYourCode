import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The bug (iPhone, 2026-10-03): right after sending a long voice note, the
// owner tapped play many times and nothing happened. A take claimed the speaker
// from pipeline.fire() until its transcript verdict, and while that claim was
// held Speaker.enqueue only queued the tap: no loading, no sound. The kept
// verdict's stopAll then wiped the queued tap. The take's claim now ends with
// its recording (tail included), the same moment the mic is released, and the
// verdict leaves a clip the user started after that alone. These drive the real
// pipeline, the real speaker and the real composer wiring; only the browser,
// the player element and the decoder are faked.

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
vi.mock('../audio/clipVault', () => ({release: vi.fn(async () => {})}));
vi.mock('../sessionSelectors', () => ({
  active: () => ({id: 's1', alive: true, messages: [] as unknown[]}),
  isDead: () => false
}));

// The player element: play() resolves on whatever source it holds.
vi.mock('../audio/webAudioClip', () => {
  class FakeClip {
    src = '';
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    currentTime = 0;
    duration = NaN;
    playing = '';
    play(): Promise<void> {
      if (!this.src) return Promise.reject(new DOMException('no source', 'NotSupportedError'));
      this.playing = this.src;
      return Promise.resolve();
    }
    pause() {
      this.playing = '';
    }
    clear() {
      this.src = '';
    }
    unlock() {
      return Promise.resolve();
    }
    addEventListener() {}
  }
  return {
    WebAudioClip: FakeClip,
    unlockPlayback: () => Promise.resolve(),
    setCallPlayback: () => {},
    playbackContextState: () => 'none'
  };
});

// A clip's bytes land only when the test says so, so "loading" is observable.
const fetches = new Map<string, (url: string) => void>();
vi.mock('../audio/audioCache', () => ({
  resolveAudioUrl: (msgId: string) => new Promise<string>((r) => fetches.set(msgId, r))
}));

import * as engine from '../engine/store';
import {pipeline} from '../audio/pipeline';
import {speaker} from '../audio/speaker';
import {mic} from '../speechGate';
import {createComposerWiring} from '../features/composer/wiring';
import {dataState, sessionState} from '../sessionState';

type FakeTrack = {readyState: 'live' | 'ended'; stop(): void};
let tracks: FakeTrack[] = [];

function fakeStream() {
  const track = {
    readyState: 'live' as 'live' | 'ended',
    muted: false,
    stop() {
      this.readyState = 'ended';
    },
    addEventListener() {},
    removeEventListener() {}
  };
  tracks.push(track);
  return {getTracks: () => [track], getAudioTracks: () => [track]};
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
  startedAt = 0;
  ondataavailable: ((e: {data: Blob}) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
    this.startedAt = Date.now();
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    const heard = Date.now() - this.startedAt;
    setTimeout(() => {
      this.ondataavailable?.({data: new Blob([new Uint8Array(heard)])});
      this.onstop?.();
    }, 0);
  }
}

let decodes: ((text: string) => void)[] = [];
let offs: (() => void)[] = [];

const press = () => (composerOpts.onVoiceStart as () => void)();
const letGo = () => (composerOpts.onVoiceEnd as (how: string) => void)('release');
const liveTracks = () => tracks.filter((t) => t.readyState === 'live').length;
const player = () => (speaker as unknown as {audio: {src: string; playing: string}}).audio;

// audioPlayback.onMessagePlay: a tap replaces the queue with the tapped clip.
const tap = (msgId: string) => {
  speaker.stopAll();
  speaker.enqueue({
    msgId,
    url: `/a/${msgId}.mp3`,
    text: msgId,
    sessionId: 's1',
    manual: true,
    reason: 'tap'
  });
};
// Answer every pending decode with `text` until the take has its verdict (an
// empty answer makes the pipeline try the clip once more).
const verdict = async (text: string) => {
  for (let i = 0; i < 3 && decodes.length; i++) {
    for (const d of decodes.splice(0)) d(text);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(pipeline.capturesInFlight).toHaveLength(0);
};
const land = async (msgId: string) => {
  fetches.get(msgId)?.(`blob:${msgId}`);
  fetches.delete(msgId);
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  tracks = [];
  decodes = [];
  fetches.clear();
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
  offs = [];
  createComposerWiring({
    onTeardown: (d) => offs.push(d),
    clearUnreadAnchor: vi.fn(),
    scrollToBottom: vi.fn(),
    render: vi.fn(),
    jumpToReply: vi.fn()
  });
});

afterEach(async () => {
  for (let i = 0; i < 3; i++) {
    for (const d of decodes.splice(0)) d('');
    await vi.advanceTimersByTimeAsync(2000);
  }
  for (const off of offs) off();
  pipeline.dispose();
  speaker.stopAll();
  speaker.setBusy(false);
  mic.ready = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Hold the button for `ms`, let go, and wait out the 600 ms tail: the take is
// recorded and the mic is off, with its transcript still pending.
async function sendTake(ms: number) {
  press();
  await vi.advanceTimersByTimeAsync(0);
  expect(pipeline.liveCaptureId).not.toBe(0);
  await vi.advanceTimersByTimeAsync(ms);
  letGo();
  await vi.advanceTimersByTimeAsync(700);
  expect(liveTracks()).toBe(0);
  expect(decodes).toHaveLength(1);
  expect(pipeline.capturesInFlight).toHaveLength(1);
}

describe('a tap on play while a sent take awaits its transcript', () => {
  test('plays at once and is still playing after the kept verdict', async () => {
    await sendTake(3000);

    tap('reply');
    expect(speaker.state).toMatchObject({state: 'loading', msgId: 'reply'});
    expect(fetches.has('reply')).toBe(true);
    await land('reply');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
    expect(player().playing).toBe('blob:reply');

    await verdict('a long voice note');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
    expect(player().playing).toBe('blob:reply');
  });

  test('the kept verdict does not wipe the tap', async () => {
    await sendTake(3000);
    tap('reply');
    await verdict('a long voice note');
    expect(speaker.pending()).toEqual(new Set(['reply']));
    await land('reply');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
  });

  test('a tap while the take records waits for the recording, its tail included, not the verdict', async () => {
    press();
    await vi.advanceTimersByTimeAsync(3000);
    tap('reply');
    expect(fetches.has('reply')).toBe(false);
    letGo();
    await vi.advanceTimersByTimeAsync(500);
    expect(liveTracks()).toBe(1);
    expect(fetches.has('reply')).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(liveTracks()).toBe(0);
    expect(speaker.state).toMatchObject({state: 'loading', msgId: 'reply'});
    await land('reply');

    await verdict('a long voice note');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
  });

  test('a dropped take does not resume the reply it paused over a tap that is loading', async () => {
    speaker.enqueue({msgId: 'before', url: '/a/before.mp3', text: 'before', sessionId: 's1'});
    await land('before');
    expect(speaker.state.state).toBe('speaking');
    await sendTake(2000);
    expect(speaker.state).toMatchObject({state: 'paused'});

    tap('reply');
    await verdict('');
    expect(speaker.state).toMatchObject({state: 'loading', msgId: 'reply'});
    expect(player().playing).toBe('');
    await land('reply');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
    expect(player().playing).toBe('blob:reply');
  });
});

describe('what a take paused is still settled by its verdict', () => {
  test('a kept take drops the reply it spoke over', async () => {
    speaker.enqueue({msgId: 'before', url: '/a/before.mp3', text: 'before', sessionId: 's1'});
    await land('before');
    await sendTake(2000);
    expect(speaker.state.state).toBe('paused');
    await verdict('stop, do this instead');
    expect(speaker.state.state).toBe('idle');
    expect(speaker.pending().size).toBe(0);
  });

  test('a dropped take resumes the reply it paused', async () => {
    speaker.enqueue({msgId: 'before', url: '/a/before.mp3', text: 'before', sessionId: 's1'});
    await land('before');
    await sendTake(2000);
    expect(speaker.state.state).toBe('paused');
    await verdict('');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'before'});
    expect(player().playing).toBe('blob:before');
  });
});
