import {beforeEach, describe, expect, test, vi} from 'vitest';

// The play-tap contract (2026-10-03, BZ Distributor): one press on play always
// yields a visible outcome (loading, playing, or an error), even while a
// capture holds the speaker awaiting its transcript; a kept utterance does not
// cancel a press made after it began; and nothing fails silently.

vi.mock('../shared/logging', () => ({cyclog: vi.fn(), newCid: () => 'c-test'}));
vi.mock('../engine/store/audioDocs', () => ({openSttStream: vi.fn()}));

// The player: a stand-in for WebAudioClip with the element backend's contract.
// play() with no source rejects the way the real one does.
vi.mock('../audio/webAudioClip', () => {
  class FakeClip {
    src = '';
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    currentTime = 0;
    duration = NaN;
    backend = 'element';
    playCalls = 0;
    nextPlay: (() => Promise<void>) | null = null;
    private listeners = new Map<string, Set<() => void>>();
    play(): Promise<void> {
      this.playCalls++;
      if (!this.src) return Promise.reject(new DOMException('no source', 'NotSupportedError'));
      const next = this.nextPlay;
      this.nextPlay = null;
      return next ? next() : Promise.resolve();
    }
    pause() {}
    clear() {
      this.src = '';
    }
    unlock() {
      return Promise.resolve();
    }
    addEventListener(ev: string, fn: () => void) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
      this.listeners.get(ev)!.add(fn);
    }
    fire(ev: string) {
      for (const fn of this.listeners.get(ev) ?? []) fn();
    }
  }
  return {
    WebAudioClip: FakeClip,
    unlockPlayback: () => Promise.resolve(),
    setCallPlayback: () => {}
  };
});

// The source: each resolve is held until the test lets it land, so "loading"
// is observable the way a slow tunnel makes it.
type Pending = {msgId: string; resolve: (u: string) => void; reject: (e: unknown) => void};
const pending: Pending[] = [];
vi.mock('../audio/audioCache', () => {
  const source = vi.fn(
    (msgId: string) =>
      new Promise<string>((resolve, reject) => pending.push({msgId, resolve, reject}))
  );
  // streamAudioUrl is the speaker's source; resolveAudioUrl is the same thing
  // for a speaker that predates it (main), so this file also runs there.
  return {streamAudioUrl: source, resolveAudioUrl: source};
});

import {cyclog} from '../shared/logging';
import {streamAudioUrl} from '../audio/audioCache';

type FakeClip = {
  src: string;
  playCalls: number;
  nextPlay: (() => Promise<void>) | null;
  fire(ev: string): void;
};
type SpeakerT = typeof import('../audio/speaker').speaker;

let speaker: SpeakerT;
let clip: FakeClip;
let states: string[];
let errors: string[];

const flush = () => new Promise((r) => setTimeout(r, 0));
const logged = (event: string) =>
  (cyclog as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => c[0] === event)
    .map((c) => c[1] as Record<string, unknown>);
const land = async (msgId: string) => {
  const p = pending.find((x) => x.msgId === msgId);
  if (!p) throw new Error('no fetch in flight for ' + msgId);
  pending.splice(pending.indexOf(p), 1);
  p.resolve(`blob:${msgId}`);
  await flush();
};
const tap = (msgId: string, sessionId = 's1') =>
  speaker.enqueue({msgId, url: `/audio/${msgId}.mp3`, text: msgId, sessionId, manual: true, reason: 'tap'});
const auto = (msgId: string, sessionId = 's1') =>
  speaker.enqueue({
    msgId,
    url: `/audio/${msgId}.mp3`,
    text: msgId,
    sessionId,
    reason: 'autoplay-arrival'
  });

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  pending.length = 0;
  ({speaker} = await import('../audio/speaker'));
  clip = (speaker as unknown as {audio: FakeClip}).audio;
  states = [];
  errors = [];
  speaker.onState((s) => states.push(s.state));
  speaker.onError((it) => errors.push(it.msgId));
});

describe('a press on play while a capture holds the speaker', () => {
  test('starts loading at once and plays when the bytes land (the field case)', async () => {
    // pipeline.fire: the capture claims the speaker until its verdict (24 s of
    // batch STT in the field).
    speaker.setBusy(true, 'capture:11');
    tap('reply');
    expect(speaker.state).toMatchObject({state: 'loading', msgId: 'reply'});
    expect(streamAudioUrl).toHaveBeenCalledTimes(1);
    await land('reply');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
    expect(speaker.holds()).toEqual(['capture:11']);
  });

  test('automatic speech is still held until the capture releases', async () => {
    speaker.setBusy(true, 'capture:11');
    auto('arrival');
    expect(speaker.state.state).toBe('idle');
    expect(streamAudioUrl).not.toHaveBeenCalled();
    speaker.setBusy(false, 'capture:11');
    expect(speaker.state).toMatchObject({state: 'loading', msgId: 'arrival'});
    await land('arrival');
    expect(speaker.state.state).toBe('speaking');
  });

  test('a kept utterance that began before the press does not cancel it', async () => {
    const capStartedAt = performance.now();
    speaker.setBusy(true, 'capture:11');
    auto('held-arrival');
    await new Promise((r) => setTimeout(r, 2));
    // audioPlayback.onMessagePlay: a press replaces whatever was queued
    speaker.stopAll();
    tap('reply');
    await land('reply');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
    // pipeline.commitUtterance, then release()
    speaker.supersede(capStartedAt);
    speaker.setBusy(false, 'capture:11');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
  });

  test('a kept utterance still drops what it interrupted and what was held', async () => {
    auto('before');
    await land('before');
    speaker.pause();
    await new Promise((r) => setTimeout(r, 2));
    const capStartedAt = performance.now();
    speaker.setBusy(true, 'capture:12');
    auto('held-arrival');
    speaker.supersede(capStartedAt);
    speaker.setBusy(false, 'capture:12');
    expect(speaker.state.state).toBe('idle');
    expect(speaker.pending().size).toBe(0);
  });
});

describe('the pipeline commit (a kept utterance) and a press made after it began', () => {
  test('the pressed clip keeps playing through the commit and release', async () => {
    const {pipeline} = await import('../audio/pipeline');
    const p = pipeline as unknown as {
      inFlight: Map<number, unknown>;
      commitUtterance(cap: unknown, released: unknown, heard: unknown, blob: unknown): Promise<void>;
    };
    // The capture as pipeline.fire made it: claims the speaker until its verdict.
    const cap = {id: 11, cid: 'c-11', startedAt: performance.now(), wasPlaying: false};
    p.inFlight.set(11, cap);
    speaker.setBusy(true, 'capture:11');
    await new Promise((r) => setTimeout(r, 2));
    speaker.stopAll();
    tap('reply');
    await land('reply');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
    await p.commitUtterance(
      cap,
      {id: 11, forCapture: undefined, durationS: 99},
      {text: 'a long voice note', streamed: true, failed: false, decoded: true, blob: new Blob(['x'])},
      async (): Promise<Blob | null> => null
    );
    expect(speaker.holds()).toEqual([]);
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
  });
});

describe('nothing fails silently', () => {
  test('a fetch that fails is an error the user sees, and the spinner goes', async () => {
    tap('gone');
    expect(speaker.state.state).toBe('loading');
    pending[0].reject(new Error('audio 404'));
    await flush();
    expect(errors).toEqual(['gone']);
    expect(speaker.state.state).toBe('idle');
    expect(logged('clip.fail')[0]).toMatchObject({msg: 'gone', stage: 'fetch'});
  });

  test('a play() the player rejects is an error the user sees', async () => {
    clip.nextPlay = () => Promise.reject(new DOMException('aborted', 'AbortError'));
    tap('broken');
    await land('broken');
    expect(errors).toEqual(['broken']);
    expect(speaker.state.state).toBe('idle');
    expect(logged('clip.fail')[0]).toMatchObject({msg: 'broken', stage: 'play'});
  });

  test('a clip the autoplay policy blocks is logged, and the player button replays it', async () => {
    clip.nextPlay = () => Promise.reject(new DOMException('gesture', 'NotAllowedError'));
    tap('blocked');
    await land('blocked');
    expect(speaker.state.state).toBe('blocked');
    expect(logged('clip.blocked')[0]).toMatchObject({msg: 'blocked'});
    speaker.resume();
    expect(speaker.state).toMatchObject({state: 'loading', msgId: 'blocked'});
    await land('blocked');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'blocked'});
  });

  test('the player button while loading does not throw the load away', async () => {
    tap('slow');
    speaker.resume();
    expect(clip.playCalls).toBe(0);
    expect(speaker.state).toMatchObject({state: 'loading', msgId: 'slow'});
    await land('slow');
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'slow'});
  });

  test('a start is logged with the time from the press', async () => {
    tap('timed');
    await new Promise((r) => setTimeout(r, 20));
    await land('timed');
    const [started] = logged('clip.started');
    expect(started).toMatchObject({msg: 'timed', reason: 'tap', backend: 'element'});
    expect(started.ms as number).toBeGreaterThanOrEqual(15);
  });
});
