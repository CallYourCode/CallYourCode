import {beforeEach, describe, expect, test, vi} from 'vitest';

// A refused press releases every claim it took. The composer claims the
// speaker ('press') before it asks the pipeline to start; when the pipeline
// refuses (the mic is not open, or it was dead and could not be recovered),
// the press is over: pttDown, the capture id, the recording state and the
// speaker claim all go back. Before, the refusal cleared pttDown but not the
// speaker claim, and the release that follows (endPTT) returns early when no
// press is down, so the claim stayed until the mic was disposed: every tap on
// play in between waited behind a recording that did not exist.

vi.mock('../shared/logging', async (orig) => ({
  ...(await orig<typeof import('../shared/logging')>()),
  cyclog: vi.fn(),
  newCid: () => 'c-test'
}));
vi.mock('../engine/store/audioDocs', () => ({openSttStream: vi.fn()}));
// The player and its source, so a reply can be playing when the press lands.
vi.mock('../audio/audioCache', () => ({
  streamAudioUrl: (id: string) => Promise.resolve(`blob:${id}`)
}));
vi.mock('../audio/webAudioClip', async (orig) => ({
  ...(await orig<typeof import('../audio/webAudioClip')>()),
  unlockPlayback: () => Promise.resolve(),
  WebAudioClip: class {
    src = '';
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    currentTime = 0;
    duration = NaN;
    backend = 'element';
    play = () => Promise.resolve();
    pause() {}
    clear() {
      this.src = '';
    }
    unlock = () => Promise.resolve();
    addEventListener() {}
  }
}));

type Claims = {busyClaims: Set<string>};
type P = Record<string, unknown> & {
  startPTT(): void;
  endPTT(): void;
  readonly pressCaptureId: number;
};

let pipeline: P;
let speaker: typeof import('../audio/speaker').speaker;
let states: string[];

const claims = () => [...(speaker as unknown as Claims).busyClaims];
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.resetModules();
  ({speaker} = await import('../audio/speaker'));
  pipeline = (await import('../audio/pipeline')).pipeline as unknown as P;
  states = [];
  (pipeline as unknown as {on(e: string, f: (s: string) => void): void}).on('recording', (s) =>
    states.push(s)
  );
});

// wiring.onVoiceStart pauses the reply and claims the speaker, then starts the press.
function press(): void {
  speaker.pause();
  speaker.setBusy(true, 'press');
  pipeline.startPTT();
}

describe('a refused press releases every claim it took', () => {
  test('dead track that cannot be re-acquired: refused while still held, then released', async () => {
    pipeline.stream = {getAudioTracks: () => [{readyState: 'ended', muted: false}]};
    pipeline.actx = {state: 'running', currentTime: 0};
    // The re-acquire the press earns fails (no permission).
    (pipeline as unknown as {reacquireStream: () => Promise<void>}).reacquireStream = () =>
      Promise.reject(new Error('NotAllowedError'));
    press();
    expect(claims()).toEqual(['press']);
    await settle();
    await settle();
    // Refused while the finger is still down: nothing is recording.
    expect(pipeline.pttDown).toBe(false);
    expect(pipeline.pressCaptureId).toBe(0);
    expect(claims()).toEqual([]);
    expect(states.at(-1)).toBe('idle');
    // The release that follows changes nothing and leaves nothing behind.
    pipeline.endPTT();
    expect(claims()).toEqual([]);
  });

  test('the mic is not open: refused at once', () => {
    pipeline.stream = null;
    pipeline.actx = null;
    press();
    expect(pipeline.pttDown).toBe(false);
    expect(claims()).toEqual([]);
  });

  test('a second press while one is down leaves the first press its claim', () => {
    pipeline.stream = {getAudioTracks: () => [{readyState: 'live', muted: false}]};
    pipeline.actx = {state: 'running', currentTime: 0};
    pipeline.pttDown = true;
    press();
    expect(pipeline.pttDown).toBe(true);
    expect(claims()).toEqual(['press']);
  });

  test('released before the refusal lands: the release frees it, the refusal adds nothing', async () => {
    pipeline.stream = {getAudioTracks: () => [{readyState: 'ended', muted: false}]};
    pipeline.actx = {state: 'running', currentTime: 0};
    let fail!: (e: Error) => void;
    (pipeline as unknown as {reacquireStream: () => Promise<void>}).reacquireStream = () =>
      new Promise((_, rej) => (fail = rej));
    press();
    await settle();
    pipeline.endPTT();
    expect(claims()).toEqual([]);
    fail(new Error('NotAllowedError'));
    await settle();
    await settle();
    expect(claims()).toEqual([]);
    expect(pipeline.pttDown).toBe(false);
  });

  // The reply the press paused comes back with the claim: the press that
  // paused it is over and nothing was recorded over it.
  test.each([
    [
      'the mic is not open',
      () => {
        pipeline.stream = null;
        pipeline.actx = null;
      }
    ],
    [
      'dead track that cannot be re-acquired',
      () => {
        pipeline.stream = {getAudioTracks: () => [{readyState: 'ended', muted: false}]};
        pipeline.actx = {state: 'running', currentTime: 0};
        (pipeline as unknown as {reacquireStream: () => Promise<void>}).reacquireStream = () =>
          Promise.reject(new Error('NotAllowedError'));
      }
    ]
  ])('%s: the reply it paused plays again', async (_, refuse) => {
    speaker.enqueue({
      msgId: 'reply',
      url: '/audio/reply.mp3',
      text: 'reply',
      sessionId: 's1',
      manual: true
    });
    await settle();
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
    refuse();
    press();
    await settle();
    await settle();
    expect(pipeline.pttDown).toBe(false);
    expect(claims()).toEqual([]);
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
  });
});
