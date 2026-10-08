import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The owner's phone, 2026-10-08 09:19 and 09:53: a press-to-record take was
// running when iOS muted the mic track (`mic.reacquire ... muted:true`). The
// pipeline answered the mute with a fresh getUserMedia in the middle of the
// take, and when that answers, reacquireStream stops the recorder ring: the
// take's own recorder is killed with everything it heard, and the ring restarts
// on the take's slot, so the clip at release holds only the last rotation.
// These drive the real pipeline, the real composer wiring and the real
// ensureMic over a fake getUserMedia/AudioContext/MediaRecorder whose track
// fires 'mute' the way iOS does.

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
import {mic} from '../speechGate';
import {createComposerWiring} from '../features/composer/wiring';
import {dataState, sessionState} from '../sessionState';

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  endedAt = Infinity;
  stop() {
    this.readyState = 'ended';
    this.endedAt = Date.now();
  }
  // iOS mutes a capture track when the system takes the mic or the app goes
  // inactive; the track stays 'live'.
  osMute() {
    this.muted = true;
    this.dispatchEvent(new Event('mute'));
  }
}
let tracks: FakeTrack[] = [];

function fakeStream() {
  const track = new FakeTrack();
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

// One byte per millisecond the recorder ran on a track that had not ended, so
// a clip's size says how much of the take it holds. A killed recorder (its
// handler dropped first) delivers nothing.
class FakeMediaRecorder {
  static isTypeSupported = () => false;
  state = 'inactive';
  startedAt = 0;
  ondataavailable: ((e: {data: Blob}) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(private stream: {getTracks(): FakeTrack[]}) {}
  start() {
    this.state = 'recording';
    this.startedAt = Date.now();
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    const heard = Math.min(Date.now(), this.stream.getTracks()[0].endedAt) - this.startedAt;
    setTimeout(() => {
      this.ondataavailable?.({data: new Blob([new Uint8Array(heard)])});
      this.onstop?.();
    }, 0);
  }
}

let decodes: ((text: string) => void)[] = [];
let offs: (() => void)[] = [];
let lines: string[] = [];

const press = () => (composerOpts.onVoiceStart as () => void)();
const letGo = () => (composerOpts.onVoiceEnd as (how: string) => void)('release');

beforeEach(() => {
  vi.useFakeTimers();
  tracks = [];
  decodes = [];
  lines = [];
  composerOpts = {};
  dataState.mode = 'live';
  sessionState.activeId = 's1';
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {getUserMedia: vi.fn(async () => fakeStream())}
  });
  vi.spyOn(console, 'debug').mockImplementation((line: unknown) => {
    lines.push(String(line));
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
  mic.ready = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a mic track muted in the middle of a press-to-record take', () => {
  test('the take keeps everything it heard, the release ends it, and the path is logged', async () => {
    const clips: number[] = [];
    offs.push(pipeline.on('clip', (b) => clips.push(b.size)));
    press();
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.liveCaptureId).not.toBe(0);
    await vi.advanceTimersByTimeAsync(3000);

    tracks[0].osMute();
    await vi.advanceTimersByTimeAsync(2000);

    letGo();
    await vi.advanceTimersByTimeAsync(700);
    // 3000 ms before the mute, 2000 ms after it and the 600 ms tail: one take.
    expect(clips).toEqual([5600]);
    expect(pipeline.liveCaptureId).toBe(0);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes('app mic.muted-mid-take '))).toBe(true);
    expect(lines.some((l) => l.includes('app capture.released '))).toBe(true);
  });

  test('the next press after a muted take re-acquires the mic and records normally', async () => {
    press();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    tracks[0].osMute();
    await vi.advanceTimersByTimeAsync(500);
    letGo();
    await vi.advanceTimersByTimeAsync(700);

    const clips: number[] = [];
    offs.push(pipeline.on('clip', (b) => clips.push(b.size)));
    press();
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.liveCaptureId).not.toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    letGo();
    await vi.advanceTimersByTimeAsync(700);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(clips).toEqual([2600]);
  });
});
